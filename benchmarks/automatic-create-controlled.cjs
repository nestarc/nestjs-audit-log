'use strict';

// Minimal controlled diagnostic. Run with node -r ts-node/register/transpile-only.
// External --cpu-prof is supported; profiling itself changes runtime cost.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Client, Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const root = path.resolve(__dirname, '..');

function safeError(error) {
  const token = value => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : undefined;
  return { name: token(error?.name) ?? 'Error', code: token(error?.code),
    ...(error instanceof assert.AssertionError ? { assertion: error.message.split('\n')[0].slice(0, 180) } : {}) };
}

function bounded(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} must remain within bounds`);
  return value;
}

function testConnectionString() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/audit_test');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5433' &&
    url.username === 'test' && url.password === 'test' && url.pathname === '/audit_test' && !url.search && !url.hash,
  'Use only the dedicated localhost test:test audit_test database on port 5433');
  return url.href;
}

// Resolve provenance before loading either module. require() ordering is an independent factor.
function installedPackage(variable) {
  const supplied = process.env[variable];
  assert.ok(supplied && path.isAbsolute(supplied), `${variable} must be absolute`);
  assert.ok(!fs.lstatSync(supplied).isSymbolicLink(), 'Use installed packages, not source symlinks');
  const directory = fs.realpathSync(supplied);
  assert.ok(directory.includes(`${path.sep}node_modules${path.sep}`));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  assert.equal(manifest.name, '@nestarc/audit-log');
  assert.equal(manifest.version, '0.7.1');
  let parent = directory;
  let artifact;
  while (parent !== path.dirname(parent)) {
    const file = path.join(parent, 'package-lock.json');
    if (fs.existsSync(file)) {
      const lock = JSON.parse(fs.readFileSync(file));
      artifact = lock.packages?.[path.relative(parent, directory).split(path.sep).join('/')];
      if (artifact) break;
    }
    parent = path.dirname(parent);
  }
  assert.ok(artifact && !artifact.link && /^sha512-[A-Za-z0-9+/=]+$/.test(artifact.integrity ?? ''),
    'Installed artifact must have a non-linked SHA-512 lockfile entry');
  assert.equal(artifact.version, manifest.version, 'Lockfile and installed package versions must agree');
  return { directory, artifact: { version: manifest.version, resolved: artifact.resolved, integrity: artifact.integrity } };
}

function clockSync(label) {
  const hrtimeBeforeNs = process.hrtime.bigint().toString();
  const performanceNowMs = performance.now();
  const hrtimeAfterNs = process.hrtime.bigint().toString();
  return { label, hrtimeBeforeNs, performanceNowMs, hrtimeAfterNs, utc: new Date().toISOString() };
}

// Named marker frames bound the V8 profile clock independently from hrtime.
// They run only when Node was explicitly launched with --cpu-prof.
function benchmarkCpuProfileStartMarker() {
  const until = performance.now() + 25;
  while (performance.now() < until) { /* Profile-clock calibration outside workload. */ }
}

function benchmarkCpuProfileEndMarker() {
  const until = performance.now() + 25;
  while (performance.now() < until) { /* Profile-clock calibration outside workload. */ }
}

function poolState(pool) {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

function statistics(samples, elapsedMs) {
  const sorted = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
  assert.ok(sorted.length);
  const at = quantile => sorted[Math.ceil(sorted.length * quantile) - 1];
  return { samples: sorted.length, meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), minMs: sorted[0], maxMs: sorted.at(-1),
    measuredElapsedMs: elapsedMs, operationsPerSecond: sorted.length * 1000 / elapsedMs };
}

function chunkSchedule(mode, first, iterations) {
  const second = first === 'left' ? 'right' : 'left';
  if (mode === 'sequential') return [first, second].flatMap(slot => Array.from({ length: iterations / 50 }, () => slot));
  const schedule = [];
  for (let cycle = 0; cycle < iterations / 100; cycle++) {
    const [a, b] = cycle % 2 ? [second, first] : [first, second];
    schedule.push(a, b, b, a);
  }
  return schedule;
}

async function main() {
  const reportPath = process.env.CONTROL_REPORT_PATH;
  assert.ok(reportPath && path.isAbsolute(reportPath), 'CONTROL_REPORT_PATH must be absolute');
  assert.ok(!fs.existsSync(reportPath), 'Reports must not overwrite previous evidence');
  const mode = process.env.CONTROL_MODE ?? 'sequential';
  const loadOrder = process.env.CONTROL_LOAD_ORDER ?? 'left-first';
  const startSlot = process.env.CONTROL_START_SLOT ?? 'left';
  assert.ok(['sequential', 'interleaved'].includes(mode));
  assert.ok(['left-first', 'right-first'].includes(loadOrder));
  assert.ok(['left', 'right'].includes(startSlot));
  const iterations = bounded('CONTROL_ITERATIONS', 1000, 100, 2000);
  const warmup = bounded('CONTROL_WARMUP', 100, 100, 2000);
  const repeats = bounded('CONTROL_REPEATS', 1, 1, 6);
  assert.equal(iterations % 100, 0, 'Iterations must be divisible by 100 for balanced ABBA cycles');
  const principalTransactions = (iterations + warmup) * repeats * 2;
  assert.ok(principalTransactions <= 100000, 'Principal transactions remain bounded');
  const connectionString = testConnectionString();
  const slotPaths = {
    left: installedPackage('CONTROL_LEFT_PACKAGE_PATH'),
    right: installedPackage('CONTROL_RIGHT_PACKAGE_PATH'),
  };
  assert.notEqual(slotPaths.left.directory, slotPaths.right.directory, 'Slots must use distinct installed module directories');
  const token = randomUUID().replaceAll('-', '');
  const schema = `audit_control_${token}`;
  const orderedLoads = loadOrder === 'left-first' ? ['left', 'right'] : ['right', 'left'];
  const cpuProfileEnabled = process.execArgv.some(argument => /^--cpu-prof(?:=|$)/.test(argument));
  const measuredSchedule = chunkSchedule(mode, startSlot, iterations);
  for (const slot of ['left', 'right']) assert.equal(measuredSchedule.filter(value => value === slot).length, iterations / 50);
  const report = {
    schemaVersion: 1, kind: 'automatic-create-controlled-diagnostic', diagnosticOnly: true,
    status: 'running', startedAt: new Date().toISOString(), schema,
    metadata: { mode, loadOrder, startSlot, orderedLoads, warmupOrder: ['left', 'right'],
      clientSetupOrder: ['left', 'right'], schemaInstallerSlot: 'left',
      iterations, warmup, repeats, principalTransactions, chunkSize: 50,
      poolMaximum: 4, idleTimeoutMillis: 1000,
      node: process.version, platform: process.platform, architecture: process.arch,
      pid: process.pid, cpu: os.cpus()[0]?.model, timeOriginMs: performance.timeOrigin,
      harness: { path: __filename, sha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') },
      packages: { left: { directory: slotPaths.left.directory, ...slotPaths.left.artifact },
        right: { directory: slotPaths.right.directory, ...slotPaths.right.artifact } },
      comparison: slotPaths.left.artifact.integrity === slotPaths.right.artifact.integrity ? 'A/A' : 'A/B',
      timing: 'Each operation records only index and performance.now start/end/latency. Every 50-operation chunk uses the same CPU/ELU/pool-count bookkeeping in both modes. Both slots warm before measurement. Mode changes only the measured slot permutation; no verification, SQL statistics, report serialization or row deletion occurs between measured chunks.',
      throughput: 'Per-slot throughput divides measured samples by the sum of that slot\'s active measured chunk durations; time executing the other slot is excluded.',
      controls: 'Package assignment, require ordering and first measured slot are separate inputs. Warmup and automatic-client setup use the fixed left/right order in both modes. Both slots retain all business rows through the measured phase. One fresh process/schema per replication is recommended; CONTROL_REPEATS>1 deliberately shares process/accumulated audit state.',
      cpuProfileEnabled,
      profiling: 'No profiler is started by the harness. External --cpu-prof enables two 25ms named markers outside setup/workload/cleanup to independently align the V8 profile clock. Bracketed hrtime/performance synchronization records provide a separate clock check. Analyze only measured chunk intervals. Profile sampling adds diagnostic overhead.',
      provenance: 'Package identity is read from manifests/lockfiles; the controller independently verifies installed artifact and source/build integrity.' },
    clockSync: [clockSync('run-start')], profileMarkers: [], pairs: [], chunks: [], cleanup: { status: 'not-created' },
  };
  const save = () => { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); };
  let bootstrap;
  let pool;
  let prisma;
  let created = false;
  let auditRows = 0;
  const slots = {};

  function profileMarker(marker) {
    if (!cpuProfileEnabled) return;
    const startedAtMs = performance.now();
    marker();
    const endedAtMs = performance.now();
    report.profileMarkers.push({ functionName: marker.name, startedAtMs, endedAtMs });
  }

  function dataset(slot, repeat) {
    // Equal-length A/B labels avoid changing record widths with the measured slot.
    const actorId = `${token}_${repeat}_${slot === 'left' ? 'A' : 'B'}`;
    return { slot, repeat, actorId, actor: { id: actorId, type: 'system' }, samples: [], elapsedMs: 0,
      records: Array.from({ length: warmup + iterations }, (_, index) => ({ id: randomUUID(), name: `control-${index}`,
        email: `${actorId}-${index}@control.test`, password: 'control-secret' })) };
  }

  function execute(item, data, record) {
    return item.library.AuditContext.runAs(data.actor, () =>
      item.automatic.withAuditTransaction(async tx => { await tx.user.create({ data: record }); }));
  }

  async function measuredChunk(data, startIndex, size, measured) {
    const item = slots[data.slot];
    const poolBefore = poolState(pool);
    const cpuBefore = process.cpuUsage();
    const utilizationBefore = performance.eventLoopUtilization();
    const startedAtMs = performance.now();
    let failure;
    let failed = false;
    try {
      for (let index = startIndex; index < startIndex + size; index++) {
        const began = performance.now();
        await execute(item, data, data.records[index]);
        const ended = performance.now();
        if (measured) data.samples.push({ index: index - warmup, startedAtMs: began, endedAtMs: ended, latencyMs: ended - began });
      }
    } catch (error) { failed = true; failure = error; }
    const endedAtMs = performance.now();
    const elapsedMs = endedAtMs - startedAtMs;
    if (measured) data.elapsedMs += elapsedMs;
    report.chunks.push({ order: report.chunks.length + 1, repeat: data.repeat, slot: data.slot, measured,
      startIndex, size, startedAtMs, endedAtMs, elapsedMs,
      cpuMicroseconds: process.cpuUsage(cpuBefore), eventLoopUtilization: performance.eventLoopUtilization(utilizationBefore),
      poolBefore, poolAfter: poolState(pool), status: failed ? 'failed' : 'passed' });
    if (failed) throw failure;
  }

  async function verify(data) {
    const ids = data.records.map(record => record.id);
    const expected = data.records.length;
    const businessRows = await prisma.user.count({ where: { id: { in: ids } } });
    assert.equal(businessRows, expected, 'Every business create commits');
    const [actual] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE action = 'User.created' AND source = 'auto' AND target_type = 'User'
        AND tenant_id = 'control-tenant' AND actor_type = 'system' AND changes IS NOT NULL)::int AS matching,
      count(DISTINCT target_id)::int AS unique_targets,
      count(*) FILTER (WHERE changes::text LIKE '%control-secret%')::int AS leaked
      FROM "${schema}".audit_logs WHERE actor_id = $1`, data.actorId);
    assert.deepEqual(actual, { total: expected, matching: expected, unique_targets: expected, leaked: 0 });
    assert.equal(data.samples.length, iterations);
    auditRows += expected;
    return { slot: data.slot, repeat: data.repeat, statistics: statistics(data.samples, data.elapsedMs), samples: data.samples,
      evidence: { checked: true, businessRows, auditRows: expected, cumulativeAuditRows: auditRows } };
  }

  try {
    save();
    profileMarker(benchmarkCpuProfileStartMarker);
    for (const slot of orderedLoads) {
      const supplied = slotPaths[slot];
      const library = require(supplied.directory);
      for (const name of ['AuditContext', 'createAuditedClient', 'getAuditTableStatements', 'applyAuditTableSchema']) assert.equal(typeof library[name], 'function');
      slots[slot] = { ...supplied, library };
    }
    assert.notEqual(slots.left.library.AuditContext, slots.right.library.AuditContext, 'Slots must not share one cached package module');
    const leftStatements = slots.left.library.getAuditTableStatements({ tableName: `${schema}.audit_logs` });
    const rightStatements = slots.right.library.getAuditTableStatements({ tableName: `${schema}.audit_logs` });
    assert.deepEqual(leftStatements, rightStatements, 'The two installed packages must generate identical audit storage DDL');
    report.metadata.auditDdl = { equal: true,
      sha256: createHash('sha256').update(JSON.stringify(leftStatements)).digest('hex') };
    const { PrismaClient, Prisma } = require(path.join(root, 'test/e2e/generated/prisma/client.ts'));
    bootstrap = new Client({ connectionString, application_name: 'audit-control-bootstrap', connectionTimeoutMillis: 10000 });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    report.cleanup.status = 'pending';
    await bootstrap.query(`CREATE TABLE "${schema}".users (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP(3) NOT NULL)`);
    pool = new Pool({ connectionString, application_name: 'audit-control-workload', max: 4, idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 10000, statement_timeout: 30000 });
    pool.on('error', () => {}); // Prisma also observes idle client errors; no per-event diagnostic allocation.
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 30000, timeout: 30000 } });
    await prisma.$connect();
    report.metadata.server = (await bootstrap.query('SELECT version() AS version')).rows[0].version;
    report.metadata.prisma = Prisma.prismaVersion.client;
    await slots.left.library.applyAuditTableSchema(prisma, { tableName: `${schema}.audit_logs` });
    for (const slot of ['left', 'right']) {
      slots[slot].automatic = slots[slot].library.createAuditedClient(prisma, {
        tableName: `${schema}.audit_logs`, prismaModule: { Prisma }, actorRequired: true, tenantRequired: true,
        tenantResolver: () => 'control-tenant', sensitiveFields: ['password'], consistency: 'atomic-required',
        trackedModels: ['User'], databaseMapping: { User: { tableName: 'users', schema } },
      });
    }
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const data = { left: dataset('left', repeat), right: dataset('right', repeat) };
      const pair = { repeat, auditRowsBefore: auditRows, warmupOrder: ['left', 'right'], measuredSchedule: [...measuredSchedule], results: [] };
      report.pairs.push(pair);
      report.clockSync.push(clockSync(`repeat-${repeat}-before-warmup`));
      for (const slot of ['left', 'right']) {
        for (let index = 0; index < warmup; index += 50) await measuredChunk(data[slot], index, Math.min(50, warmup - index), false);
      }
      report.clockSync.push(clockSync(`repeat-${repeat}-before-measurement`));
      const position = { left: warmup, right: warmup };
      for (const slot of measuredSchedule) {
        await measuredChunk(data[slot], position[slot], 50, true);
        position[slot] += 50;
      }
      report.clockSync.push(clockSync(`repeat-${repeat}-after-measurement`));
      // Verification, deletion and summary allocation wait until both measured slots finish.
      for (const slot of ['left', 'right']) pair.results.push(await verify(data[slot]));
      const leftStats = pair.results.find(result => result.slot === 'left').statistics;
      const rightStats = pair.results.find(result => result.slot === 'right').statistics;
      pair.ratios = { mean: rightStats.meanMs / leftStats.meanMs, p95: rightStats.p95Ms / leftStats.p95Ms,
        p99: rightStats.p99Ms / leftStats.p99Ms, throughput: rightStats.operationsPerSecond / leftStats.operationsPerSecond };
      pair.auditRowsAfter = auditRows;
      const ids = [...data.left.records, ...data.right.records].map(record => record.id);
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      console.log(`CONTROLLED pair ${repeat}: mean ${pair.ratios.mean.toFixed(3)}x, P95 ${pair.ratios.p95.toFixed(3)}x; ${mode}/${loadOrder}/${startSlot}`);
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = safeError(error);
  } finally {
    const failures = [];
    if (prisma) try { await prisma.$disconnect(); } catch (error) { failures.push(safeError(error)); }
    if (pool) try { await pool.end(); } catch (error) { failures.push(safeError(error)); }
    if (created && bootstrap) try {
      assert.match(schema, /^audit_control_[a-f0-9]{32}$/);
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch (error) { failures.push(safeError(error)); }
    if (bootstrap) try { await bootstrap.end(); } catch (error) { failures.push(safeError(error)); }
    profileMarker(benchmarkCpuProfileEndMarker);
    report.clockSync.push(clockSync('run-end'));
    report.cleanup = { status: failures.length ? 'failed' : created ? 'passed' : 'not-created', failures };
    if (failures.length) report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    save();
  }
  console.log(`Controlled automatic-create diagnostic ${report.status}; report: ${reportPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

module.exports = { chunkSchedule, statistics, clockSync };
if (require.main === module) void main().catch(error => { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; });
