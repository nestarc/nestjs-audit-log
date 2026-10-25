'use strict';

// Run with: node -r ts-node/register/transpile-only benchmarks/manual-audit-regression.cjs
// Public installed packages share one generated Prisma client, one pool and one host.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Client } = require('pg');

const root = path.resolve(__dirname, '..');
const reportPath = path.resolve(process.env.BENCH_REPORT_PATH || path.join(__dirname, 'results/postgresql-manual-regression.json'));
const runId = randomUUID().replaceAll('-', '');
const schema = `audit_perf_${runId}`;
const report = {
  schemaVersion: 1,
  kind: 'postgresql-public-package-regression',
  startedAt: new Date().toISOString(),
  status: 'running',
  runId,
  metadata: {},
  results: [],
  comparisons: [],
  cleanup: { status: 'not-created' },
};
let prisma;
let bootstrap;
let createdSchema = false;
let cumulativeAuditRows = 0;

function save() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function safeError(error) {
  const result = { name: /^[\w-]{1,80}$/.test(error?.name) ? error.name : 'Error' };
  if (/^[\w-]{1,80}$/.test(error?.code)) result.code = error.code;
  if (error instanceof assert.AssertionError) result.assertion = error.message.split('\n')[0].slice(0, 180);
  return result;
}

function count(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} is within its bounded integer range`);
  return value;
}

function testUrl() {
  const url = new URL(process.env.DATABASE_URL || 'postgresql://test:test@localhost:5433/audit_test');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) && ['5432', '5433'].includes(url.port) &&
    url.pathname === '/audit_test' && url.username === 'test' && url.password === 'test' &&
    !url.search && !url.hash,
  'Use only the dedicated localhost test:test audit_test database on port 5432 or 5433');
  return url.href;
}

function loadPackage(variable, expectedVersion) {
  const supplied = process.env[variable];
  assert.ok(supplied && path.isAbsolute(supplied), `${variable} is an absolute installed package directory`);
  const directory = fs.realpathSync(supplied);
  assert.ok(directory.includes(`${path.sep}node_modules${path.sep}`), `${variable} is installed in node_modules`);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@nestarc/audit-log', 'The benchmark loads the public audit-log package');
  assert.equal(manifest.version, expectedVersion, `${variable} has the intended exact version`);
  // The generated runner supplies provenance; the package lock must independently
  // identify the installed registry/tarball artifact, never a source symlink.
  let consumer = directory;
  let lock;
  while (consumer !== path.dirname(consumer)) {
    const candidate = path.join(consumer, 'package-lock.json');
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const key = path.relative(consumer, directory).split(path.sep).join('/');
      if (parsed.packages?.[key]) { lock = parsed.packages[key]; break; }
    }
    consumer = path.dirname(consumer);
  }
  assert.ok(lock && !lock.link && /^sha512-/.test(lock.integrity || ''), 'Installed package has a non-linked SHA-512 artifact in its consumer lockfile');
  const library = require(directory);
  for (const name of ['AuditService', 'AuditContext', 'createAuditedClient', 'applyAuditTableSchema']) {
    assert.equal(typeof library[name], 'function', `${name} exists on the installed public entry point`);
  }
  return { library, version: manifest.version, artifact: { resolved: lock.resolved, integrity: lock.integrity } };
}

function revision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return 'unavailable'; }
}

function dependencyVersion(name) {
  let directory = path.dirname(require.resolve(name));
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.name === name) return manifest.version;
    }
    directory = path.dirname(directory);
  }
  throw new Error('Dependency manifest unavailable');
}

function statistics(timings, elapsedMs) {
  const sorted = [...timings].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  return {
    samples: sorted.length,
    latenciesMs: timings,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: percentile(50), p95Ms: percentile(95), p99Ms: percentile(99),
    minMs: sorted[0], maxMs: sorted[sorted.length - 1],
    batchElapsedMs: elapsedMs,
    operationsPerSecond: sorted.length * 1000 / elapsedMs,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function batch(records, concurrency, execute, measured) {
  const timings = [];
  let next = 0;
  const started = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, records.length) }, async () => {
    while (next < records.length) {
      const record = records[next++];
      const began = performance.now();
      await execute(record);
      if (measured) timings.push(performance.now() - began);
    }
  });
  // Drain every in-flight transaction before checking or cleaning owned data.
  const settled = await Promise.allSettled(workers);
  const elapsedMs = performance.now() - started;
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return measured ? statistics(timings, elapsedMs) : null;
}

async function scenario({ variant, item, workload, operation, payload, concurrency, repeat, warmup, iterations }) {
  const label = `${repeat}_${workload}_${operation}_${payload.name}_${concurrency}_${variant}`;
  report.activeScenario = label;
  save();
  const actorId = `${runId}_${label}`;
  const records = Array.from({ length: warmup + iterations }, (_, index) => ({
    id: randomUUID(), name: `bench-${index}`, email: `${actorId}-${index}@bench.test`, password: 'benchmark-secret',
  }));
  const ids = records.map(record => record.id);
  const audited = variant !== 'control';
  const manual = workload === 'manual';
  const expectedAction = manual ? 'User.manual-benchmark' : { create: 'User.created', update: 'User.updated', delete: 'User.deleted' }[operation];
  const expectedMetadata = { ...payload.value, password: '[REDACTED]' };
  const actor = { id: actorId, type: 'system' };
  let output;
  try {
    if (operation !== 'create') await prisma.user.createMany({ data: records });
    const mutate = async (tx, record) => {
      if (operation === 'create') await tx.user.create({ data: record });
      else if (operation === 'update') await tx.user.update({ where: { id: record.id }, data: { name: `updated-${record.name}`, email: `updated-${record.email}` } });
      else await tx.user.delete({ where: { id: record.id } });
      if (manual && audited) await item.service.log({ action: expectedAction, targetType: 'User', targetId: record.id, metadata: payload.value }, tx);
    };
    const execute = record => item.library.AuditContext.runAs(actor, () => (
      manual || !audited
        ? prisma.$transaction(tx => mutate(tx, record))
        : item.automatic.withAuditTransaction(tx => mutate(tx, record))
    ));
    await batch(records.slice(0, warmup), concurrency, execute, false);
    const timing = await batch(records.slice(warmup), concurrency, execute, true);
    const businessRows = await prisma.user.count({ where: { id: { in: ids } } });
    assert.equal(businessRows, operation === 'delete' ? 0 : records.length, 'Business writes have the expected final row count');
    if (operation === 'update') assert.equal(await prisma.user.count({ where: { id: { in: ids }, name: { startsWith: 'updated-' } } }), records.length, 'Every update changed its business row');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT action, source, count(*)::int AS count FROM "${schema}".audit_logs WHERE actor_id = $1 GROUP BY action, source`, actorId,
    );
    assert.deepEqual(rows, audited ? [{ action: expectedAction, source: manual ? 'manual' : 'auto', count: records.length }] : [], 'Audit action, source and count include warmups and every measured operation');
    if (audited) {
      if (manual) {
        const [validation] = await prisma.$queryRawUnsafe(
          `SELECT count(*)::int AS matching FROM "${schema}".audit_logs WHERE actor_id = $1 AND metadata = $2::jsonb AND target_type = 'User' AND tenant_id = 'benchmark-tenant'`,
          actorId, JSON.stringify(expectedMetadata),
        );
        assert.equal(validation.matching, records.length, 'Every manual audit preserves its metadata and redacts its password');
      } else {
        const [validation] = await prisma.$queryRawUnsafe(
          `SELECT count(*)::int AS matching FROM "${schema}".audit_logs WHERE actor_id = $1 AND target_type = 'User' AND tenant_id = 'benchmark-tenant' AND changes IS NOT NULL AND changes::text NOT LIKE '%benchmark-secret%'`, actorId,
        );
        assert.equal(validation.matching, records.length, 'Every automatic event includes changes without the sensitive password');
      }
      cumulativeAuditRows += records.length;
    }
    output = {
      repeat, order: report.results.length + 1, variant,
      version: audited ? item.version : null,
      workload, operation, payload: payload.name,
      payloadUtf16CodeUnits: payload.value.payload.length,
      payloadUtf8Bytes: Buffer.byteLength(payload.value.payload),
      metadataUtf16CodeUnits: JSON.stringify(payload.value).length,
      metadataUtf8Bytes: Buffer.byteLength(JSON.stringify(payload.value)),
      concurrency, warmup, iterations,
      ...timing,
      evidence: { businessRows, auditRows: audited ? records.length : 0, cumulativeAuditRows, checked: true },
    };
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  report.results.push(output);
  console.log(`PASS ${label}: ${output.meanMs.toFixed(3)} ms mean, ${output.p95Ms.toFixed(3)} ms p95, ${output.operationsPerSecond.toFixed(1)} ops/s`);
  save();
}

function comparisons() {
  const pairs = [];
  for (const candidate of report.results.filter(result => result.variant === 'candidate')) {
    const baseline = report.results.find(result => result.variant === 'baseline' &&
      ['repeat', 'workload', 'operation', 'payload', 'concurrency'].every(key => result[key] === candidate[key]));
    assert.ok(baseline, 'Every candidate scenario has its paired registry baseline');
    const control = report.results.find(result => result.variant === 'control' &&
      ['repeat', 'workload', 'operation', 'payload', 'concurrency'].every(key => result[key] === candidate[key]));
    pairs.push({
      repeat: candidate.repeat, workload: candidate.workload, operation: candidate.operation,
      payload: candidate.payload, concurrency: candidate.concurrency,
      meanDeltaMs: candidate.meanMs - baseline.meanMs,
      meanRatio: candidate.meanMs / baseline.meanMs,
      p95Ratio: candidate.p95Ms / baseline.p95Ms,
      throughputRatio: candidate.operationsPerSecond / baseline.operationsPerSecond,
      ...(control ? {
        baselineAuditIncrementMs: baseline.meanMs - control.meanMs,
        candidateAuditIncrementMs: candidate.meanMs - control.meanMs,
      } : {}),
    });
  }
  const keys = [...new Set(pairs.map(pair => [pair.workload, pair.operation, pair.payload, pair.concurrency].join('/')))];
  report.comparisons = keys.map(key => {
    const selected = pairs.filter(pair => [pair.workload, pair.operation, pair.payload, pair.concurrency].join('/') === key);
    return { scenario: key, repeats: selected.length, medianMeanRatio: median(selected.map(pair => pair.meanRatio)),
      medianP95Ratio: median(selected.map(pair => pair.p95Ratio)), medianThroughputRatio: median(selected.map(pair => pair.throughputRatio)), pairs: selected };
  });
}

async function main() {
  const connectionString = testUrl();
  const warmup = count('BENCH_WARMUP', 50, 0, 1000);
  const iterations = count('BENCH_ITERATIONS', 500, 100, 5000);
  const repeats = count('BENCH_REPEATS', 4, 2, 10);
  assert.ok((warmup + iterations) * repeats * 18 <= 100_000, 'The complete benchmark stays below 100000 operations');
  const baseline = loadPackage('BENCH_BASELINE_PACKAGE_PATH', '0.7.0');
  const candidateVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const candidate = loadPackage('BENCH_CANDIDATE_PACKAGE_PATH', candidateVersion);
  assert.match(baseline.artifact.resolved, /^https:\/\/registry\.npmjs\.org\/@nestarc\/audit-log\//, 'The baseline originates in the npm registry');
  assert.match(candidate.artifact.resolved, /^file:.*\.tgz$/, 'The candidate originates in a packed tarball');
  assert.notEqual(candidateVersion, baseline.version, 'The candidate version differs from the published 0.7.0 baseline');
  const { PrismaClient, Prisma } = require(path.join(root, 'test/e2e/generated/prisma/client.ts'));
  bootstrap = new Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await bootstrap.connect();
  assert.match(schema, /^audit_perf_[a-f0-9]{32}$/);
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  report.cleanup.status = 'pending';
  await bootstrap.query(`CREATE TABLE "${schema}".users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL
  )`);
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 4, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 1000, statement_timeout: 30_000 }, { schema }),
    transactionOptions: { maxWait: 30_000, timeout: 30_000 },
  });
  await prisma.$connect();
  const [{ version: server }] = await prisma.$queryRawUnsafe('SELECT version()');
  await candidate.library.applyAuditTableSchema(prisma, { tableName: `${schema}.audit_logs` });
  for (const item of [baseline, candidate]) {
    const shared = { tableName: `${schema}.audit_logs`, prismaModule: { Prisma }, actorRequired: true,
      tenantRequired: true, tenantResolver: () => 'benchmark-tenant', sensitiveFields: ['password'] };
    item.service = new item.library.AuditService({ ...shared, prisma, actorExtractor: () => null });
    item.automatic = item.library.createAuditedClient(prisma, { ...shared, consistency: 'atomic-required',
      trackedModels: ['User'], databaseMapping: { User: { tableName: 'users', schema } } });
  }
  const small = { name: 'small', value: { reason: 'benchmark', password: 'benchmark-secret', payload: '한글😀'.repeat(16) } };
  const large = { name: '64k', value: { reason: 'benchmark', password: 'benchmark-secret', payload: '한글😀'.repeat(Math.ceil(65_536 / Buffer.byteLength('한글😀'))) } };
  report.metadata = {
    revision: revision(), node: process.version,
    prisma: Prisma.prismaVersion.client,
    prismaAdapter: dependencyVersion('@prisma/adapter-pg'),
    server, cpu: os.cpus()[0]?.model ?? 'unavailable', logicalCpus: os.cpus().length,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    packages: { baseline: { version: baseline.version, ...baseline.artifact }, candidate: { version: candidate.version, ...candidate.artifact } },
    warmup, iterations, repeats, poolMaximum: 4, concurrency: [1, 4],
    timing: 'Per-operation latency includes actor context setup, Prisma pool acquisition, business mutation, optional audit and transaction commit; payload allocation, seed inserts, correctness queries and cleanup are excluded. Throughput uses measured batch wall time, not summed latency. Each block preserves measured latenciesMs in completion order, excluding warmups.',
    payloadDefinition: '64k means the manual metadata.payload string is at least 65536 UTF-8 bytes, not 65536 characters. Blocks record exact payload string and complete input metadata JSON sizes in both UTF-8 bytes and UTF-16 code units.',
    order: 'Manual control runs first; baseline/candidate order alternates every repeat. Automatic operation order is create/update/delete and library order alternates every repeat.',
    limits: 'One shared host/process/client; audit rows accumulate. Repeats, warm caches, database growth and runner scheduling can affect paired observations. No statistical significance or production throughput claim. P99 is sensitive at this sample count.',
  };
  save();
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const ordered = repeat % 2 ? [['baseline', baseline], ['candidate', candidate]] : [['candidate', candidate], ['baseline', baseline]];
    for (const payload of [small, large]) for (const concurrency of [1, 4]) {
      await scenario({ variant: 'control', item: baseline, workload: 'manual', operation: 'create', payload, concurrency, repeat, warmup, iterations });
      for (const [variant, item] of ordered) await scenario({ variant, item, workload: 'manual', operation: 'create', payload, concurrency, repeat, warmup, iterations });
    }
    for (const operation of ['create', 'update', 'delete']) for (const [variant, item] of ordered) {
      await scenario({ variant, item, workload: 'atomic-required', operation, payload: small, concurrency: 1, repeat, warmup, iterations });
    }
  }
  comparisons();
  report.status = 'passed';
  delete report.activeScenario;
}

main().catch(error => {
  report.status = 'failed';
  report.error = safeError(error);
}).finally(async () => {
  const cleanupErrors = [];
  if (prisma) try { await prisma.$disconnect(); } catch (error) { cleanupErrors.push(safeError(error)); }
  if (createdSchema && bootstrap) {
    try {
      assert.match(schema, /^audit_perf_[a-f0-9]{32}$/);
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch (error) { cleanupErrors.push(safeError(error)); }
  }
  if (bootstrap) try { await bootstrap.end(); } catch (error) { cleanupErrors.push(safeError(error)); }
  report.cleanup = { status: cleanupErrors.length ? 'failed' : createdSchema ? 'passed' : 'not-created', errors: cleanupErrors };
  if (cleanupErrors.length) report.status = 'failed';
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`PostgreSQL public-package benchmark ${report.status}; ${report.results.length} verified blocks; report: ${reportPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
});
