/**
 * Benchmark: Audit extension overhead measurement
 *
 * Compares:
 *   A) Direct Prisma CUD (no audit extension)
 *   B) Prisma CUD with audit extension (before/after diff + INSERT audit_logs)
 *
 * Usage:
 *   docker compose -f test/e2e/docker-compose.yml up -d
 *   DATABASE_URL=postgresql://test:test@localhost:5433/audit_test \
 *     npx ts-node benchmarks/audit-overhead.ts
 */

import { PrismaClient } from '@prisma/client';
import { createAuditExtension } from '../src/prisma/audit-extension';
import { AuditContext } from '../src/services/audit-context';
import { applyAuditTableSchema } from '../src/sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

const WARMUP = 30;
const ITERATIONS = 300;

// ---------------------------------------------------------------------------
// Stats helpers (shared pattern with @nestarc/tenancy)
// ---------------------------------------------------------------------------

interface BenchResult {
  label: string;
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function analyze(label: string, timings: number[]): BenchResult {
  const sorted = [...timings].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    label,
    iterations: sorted.length,
    avgMs: Math.round((total / sorted.length) * 100) / 100,
    p50Ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99Ms: Math.round(percentile(sorted, 99) * 100) / 100,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

function printResult(r: BenchResult) {
  console.log(`\n${r.label}`);
  console.log(`  Iterations: ${r.iterations}`);
  console.log(
    `  Avg: ${r.avgMs}ms | P50: ${r.p50Ms}ms | P95: ${r.p95Ms}ms | P99: ${r.p99Ms}ms`,
  );
  console.log(`  Min: ${r.minMs}ms | Max: ${r.maxMs}ms`);
}

// ---------------------------------------------------------------------------
// Cleanup helper — must drop append-only rules before deleting audit_logs
// ---------------------------------------------------------------------------

async function cleanAuditLogs(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(
    `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
  );
  await prisma.$executeRaw`DELETE FROM audit_logs`;
  await prisma.$executeRawUnsafe(
    `CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== @nestarc/audit-log Benchmark ===\n');

  const basePrisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
  });
  await basePrisma.$connect();

  // Setup: ensure users table + audit_logs table exist
  console.log('Setting up database...');
  await basePrisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS users (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await applyAuditTableSchema(basePrisma);

  // Create extended client
  const auditPrisma = basePrisma.$extends(
    createAuditExtension({
      trackedModels: ['User'],
      sensitiveFields: ['password'],
    }),
  ) as any;

  // ===================================================================
  // Benchmark A: Baseline — create without audit extension
  // ===================================================================
  console.log('Cleaning up...');
  await basePrisma.$executeRaw`DELETE FROM users`;
  await cleanAuditLogs(basePrisma);

  console.log(`\nWarming up A (${WARMUP} iterations)...`);
  for (let i = 0; i < WARMUP; i++) {
    await basePrisma.user.create({
      data: { name: `warmup-${i}`, email: `warmup-a-${i}@bench.test`, password: 'pw' },
    });
  }
  await basePrisma.$executeRaw`DELETE FROM users`;

  console.log(`Running A: create without audit (${ITERATIONS} iterations)...`);
  const timingsA: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await basePrisma.user.create({
      data: { name: `user-${i}`, email: `a-${i}@bench.test`, password: 'pw' },
    });
    timingsA.push(performance.now() - start);
  }

  // ===================================================================
  // Benchmark B: create WITH audit extension
  // ===================================================================
  await basePrisma.$executeRaw`DELETE FROM users`;
  await cleanAuditLogs(basePrisma);

  console.log(`Warming up B (${WARMUP} iterations)...`);
  for (let i = 0; i < WARMUP; i++) {
    await AuditContext.run(
      { actor: { id: 'bench', type: 'user' }, noAudit: false },
      () =>
        auditPrisma.user.create({
          data: { name: `warmup-${i}`, email: `warmup-b-${i}@bench.test`, password: 'pw' },
        }),
    );
  }
  await basePrisma.$executeRaw`DELETE FROM users`;
  await cleanAuditLogs(basePrisma);

  console.log(`Running B: create with audit (${ITERATIONS} iterations)...`);
  const timingsB: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    await AuditContext.run(
      { actor: { id: 'bench', type: 'user' }, noAudit: false },
      async () => {
        const start = performance.now();
        await auditPrisma.user.create({
          data: { name: `user-${i}`, email: `b-${i}@bench.test`, password: 'pw' },
        });
        timingsB.push(performance.now() - start);
      },
    );
  }

  // ===================================================================
  // Benchmark C: update WITH audit (before/after diff)
  // ===================================================================
  await basePrisma.$executeRaw`DELETE FROM users`;
  await cleanAuditLogs(basePrisma);

  // Seed users for update
  const userIds: string[] = [];
  for (let i = 0; i < ITERATIONS + WARMUP; i++) {
    const u = await basePrisma.user.create({
      data: { name: `user-${i}`, email: `c-${i}@bench.test`, password: 'pw' },
    });
    userIds.push(u.id);
  }

  console.log(`Warming up C (${WARMUP} iterations)...`);
  for (let i = 0; i < WARMUP; i++) {
    await AuditContext.run(
      { actor: { id: 'bench', type: 'user' }, noAudit: false },
      () =>
        auditPrisma.user.update({
          where: { id: userIds[i] },
          data: { name: `updated-warmup-${i}` },
        }),
    );
  }
  await cleanAuditLogs(basePrisma);

  console.log(`Running C: update with audit + diff (${ITERATIONS} iterations)...`);
  const timingsC: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    await AuditContext.run(
      { actor: { id: 'bench', type: 'user' }, noAudit: false },
      async () => {
        const start = performance.now();
        await auditPrisma.user.update({
          where: { id: userIds[WARMUP + i] },
          data: { name: `updated-${i}`, email: `c-updated-${i}@bench.test` },
        });
        timingsC.push(performance.now() - start);
      },
    );
  }

  // ===================================================================
  // Benchmark D: delete WITH audit
  // ===================================================================
  await cleanAuditLogs(basePrisma);

  console.log(`Running D: delete with audit (${ITERATIONS} iterations)...`);
  const timingsD: number[] = [];
  // Re-use existing users (they were updated, still present)
  for (let i = 0; i < ITERATIONS; i++) {
    await AuditContext.run(
      { actor: { id: 'bench', type: 'user' }, noAudit: false },
      async () => {
        const start = performance.now();
        await auditPrisma.user.delete({
          where: { id: userIds[WARMUP + i] },
        });
        timingsD.push(performance.now() - start);
      },
    );
  }

  // ===================================================================
  // Results
  // ===================================================================
  const resultA = analyze('A) create — no audit (baseline)', timingsA);
  const resultB = analyze('B) create — with audit', timingsB);
  const resultC = analyze('C) update — with audit + diff', timingsC);
  const resultD = analyze('D) delete — with audit', timingsD);

  const createOverhead = resultB.avgMs - resultA.avgMs;
  const createPct = ((createOverhead / resultA.avgMs) * 100).toFixed(1);

  console.log('\n' + '='.repeat(70));
  console.log('RESULTS');
  console.log('='.repeat(70));

  for (const r of [resultA, resultB, resultC, resultD]) {
    printResult(r);
  }

  console.log('\n' + '-'.repeat(70));
  console.log(
    `Create overhead (avg): +${createOverhead.toFixed(2)}ms (+${createPct}%)`,
  );
  console.log(
    `Create overhead (p95): +${(resultB.p95Ms - resultA.p95Ms).toFixed(2)}ms`,
  );
  console.log('-'.repeat(70));

  // Cleanup
  await basePrisma.$executeRaw`DELETE FROM users`;
  await cleanAuditLogs(basePrisma);
  await basePrisma.$disconnect();

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
