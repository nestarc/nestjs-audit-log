/**
 * Sequential create/update/delete latency on the dedicated local test database.
 * See docs/benchmarks.md for setup, comparisons, and measurement limits.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { arch, cpus, platform, release } from 'node:os';
import { version as prismaVersion } from '@prisma/client/package.json';
import { version as packageVersion } from '../package.json';
import {
  createTestPrismaClient,
  DATABASE_URL,
  PrismaClient,
  prismaModule,
} from '../test/e2e/prisma-client';
import { createAuditedClient } from '../src/prisma/audit-extension';
import { AuditContext } from '../src/services/audit-context';
import { applyAuditTableSchema } from '../src/sql';

type Operation = 'create' | 'update' | 'delete';
type ModeId = 'direct' | 'transaction' | 'atomic-required' | 'best-effort';

interface Mode {
  id: ModeId;
  label: string;
  audited: boolean;
  run(work: (client: PrismaClient) => Promise<unknown>): Promise<unknown>;
}

interface BenchResult {
  mode: ModeId;
  operation: Operation;
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

function readCount(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > 100_000) {
    throw new Error(`${name} must be an integer from ${minimum} to 100000`);
  }
  return value;
}

function assertTestDatabase(): void {
  const url = new URL(DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5433' ||
    url.pathname !== '/audit_test' ||
    url.username !== 'test' ||
    url.password !== 'test' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'Benchmark requires the dedicated local test database: ' +
        'postgresql://test:test@localhost:5433/audit_test. ' +
        'Run npm run test:e2e:setup first; do not use an application database.',
    );
  }
}

function gitMetadata(): { revision: string; modifiedSources: boolean | null } {
  try {
    return {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      modifiedSources:
        execFileSync(
          'git',
          ['status', '--porcelain', '--', 'src', 'benchmarks', 'package.json', 'package-lock.json'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim().length > 0,
    };
  } catch {
    return { revision: 'unavailable', modifiedSources: null };
  }
}

function analyze(mode: ModeId, operation: Operation, timings: number[]): BenchResult {
  const sorted = [...timings].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    mode,
    operation,
    iterations: sorted.length,
    avgMs: sorted.reduce((sum, timing) => sum + timing, 0) / sorted.length,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

async function runScenario(
  prisma: PrismaClient,
  mode: Mode,
  operation: Operation,
  runId: string,
  warmup: number,
  iterations: number,
): Promise<BenchResult> {
  const actorId = `${runId}-${mode.id}-${operation}`;
  const records = Array.from({ length: warmup + iterations }, (_, index) => ({
    id: randomUUID(),
    name: `user-${index}`,
    email: `${actorId}-${index}@bench.test`,
    password: 'benchmark-password',
  }));
  const timings: number[] = [];

  try {
    if (operation !== 'create') {
      // Fixture creation is outside the measured operation and has no audit extension.
      await prisma.user.createMany({ data: records });
    }

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      await AuditContext.runAs({ id: actorId, type: 'user' }, async () => {
        const start = performance.now();
        await mode.run(async (client) => {
          if (operation === 'create') {
            return client.user.create({ data: record });
          }
          if (operation === 'update') {
            return client.user.update({
              where: { id: record.id },
              data: { name: `updated-${index}`, email: `updated-${record.email}` },
            });
          }
          return client.user.delete({ where: { id: record.id } });
        });
        if (index >= warmup) timings.push(performance.now() - start);
      });
    }

    // Fail a run that silently skipped auditing, instead of reporting misleading latency.
    const auditRows = await prisma.$queryRaw<Array<{ action: string; source: string; count: number }>>`
      SELECT action, source, count(*)::int AS count
      FROM audit_logs
      WHERE actor_id = ${actorId}
      GROUP BY action, source
    `;
    const expectedAction = { create: 'User.created', update: 'User.updated', delete: 'User.deleted' }[operation];
    const valid = mode.audited
      ? auditRows.length === 1 &&
        auditRows[0].action === expectedAction &&
        auditRows[0].source === 'auto' &&
        auditRows[0].count === records.length
      : auditRows.length === 0;
    if (!valid) {
      throw new Error(`Unexpected audit evidence for ${actorId}: ${JSON.stringify(auditRows)}`);
    }

    return analyze(mode.id, operation, timings);
  } finally {
    // Delete only this scenario's business fixtures. Append-only audit rows remain.
    await prisma.user.deleteMany({ where: { id: { in: records.map((record) => record.id) } } });
  }
}

async function main(): Promise<void> {
  assertTestDatabase();
  const warmup = readCount('BENCH_WARMUP', 30, 0);
  const iterations = readCount('BENCH_ITERATIONS', 300, 1);
  const runId = `bench-${randomUUID()}`;
  const prisma = createTestPrismaClient();

  try {
    await prisma.$connect();
    await applyAuditTableSchema(prisma);
    const postgres = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    const metadata = {
      runId,
      timestamp: new Date().toISOString(),
      package: `@nestarc/audit-log@${packageVersion}`,
      source: 'local TypeScript sources',
      ...gitMetadata(),
      node: process.version,
      prisma: prismaVersion,
      prismaClient: process.env.PRISMA_TEST_CLIENT === 'legacy' ? 'legacy' : 'prisma-client with PrismaPg adapter',
      postgres: postgres[0].version,
      host: 'local workstation',
      os: `${platform()} ${release()} ${arch()}`,
      cpu: cpus()[0]?.model ?? 'unavailable',
      logicalCpus: cpus().length,
      database: 'localhost:5433/audit_test (dedicated test database)',
      warmup,
      iterations,
      concurrency: 1,
      operationOrder: ['create', 'update', 'delete'],
      modeOrder: ['direct', 'transaction', 'atomic-required', 'best-effort'],
    };
    console.log('@nestarc/audit-log benchmark metadata');
    console.log(JSON.stringify(metadata, null, 2));

    const sharedOptions = {
      trackedModels: ['User'],
      sensitiveFields: ['password'],
      databaseMapping: { User: { tableName: 'users' } },
      prismaModule,
    };
    const atomic = createAuditedClient(prisma, { ...sharedOptions, consistency: 'atomic-required' });
    const bestEffort = createAuditedClient(prisma, { ...sharedOptions, consistency: 'best-effort' });
    const modes: Mode[] = [
      { id: 'direct', label: 'direct Prisma (no audit)', audited: false, run: (work) => work(prisma) },
      {
        id: 'transaction',
        label: 'Prisma interactive transaction (no audit)',
        audited: false,
        run: (work) => prisma.$transaction(work),
      },
      {
        id: 'atomic-required',
        label: 'atomic-required with withAuditTransaction()',
        audited: true,
        run: (work) => atomic.withAuditTransaction((tx) => work(tx as PrismaClient)),
      },
      { id: 'best-effort', label: 'best-effort direct write', audited: true, run: (work) => work(bestEffort) },
    ];
    const results: BenchResult[] = [];

    for (const operation of ['create', 'update', 'delete'] as const) {
      for (const mode of modes) {
        console.log(`Running ${operation}: ${mode.label} (${warmup} warmup + ${iterations} measured)`);
        results.push(await runScenario(prisma, mode, operation, runId, warmup, iterations));
      }
    }

    console.log('\nLatency in milliseconds (including transaction commit where used)');
    console.table(results.map((result) => ({
      operation: result.operation,
      mode: result.mode,
      iterations: result.iterations,
      avgMs: result.avgMs.toFixed(3),
      p50Ms: result.p50Ms.toFixed(3),
      p95Ms: result.p95Ms.toFixed(3),
      p99Ms: result.p99Ms.toFixed(3),
    })));
    console.log('\nMean latency deltas within this run:');
    for (const operation of ['create', 'update', 'delete'] as const) {
      const average = (mode: ModeId) => results.find((result) => result.operation === operation && result.mode === mode)!.avgMs;
      console.log(`${operation}: atomic-required minus transaction baseline = ${(average('atomic-required') - average('transaction')).toFixed(3)}ms; ` +
        `best-effort minus direct baseline = ${(average('best-effort') - average('direct')).toFixed(3)}ms`);
    }
    console.log('\nMachine-readable result (unrounded milliseconds):');
    console.log(JSON.stringify({ metadata, results }, null, 2));
    console.log(`\nVerified audit evidence. Audit rows for ${runId} remain for inspection; business fixtures were removed.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
