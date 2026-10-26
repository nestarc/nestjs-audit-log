'use strict';

// Diagnostic, not a release gate. Run with node -r ts-node/register/transpile-only.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance, PerformanceObserver, monitorEventLoopDelay } = require('node:perf_hooks');
const { Client, Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const root = path.resolve(__dirname, '..');
const operationScope = new AsyncLocalStorage();

function safeError(error) {
  const token = value => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : undefined;
  return { name: token(error?.name) ?? 'Error', code: token(error?.code),
    ...(error instanceof assert.AssertionError ? { assertion: error.message.split('\n')[0].slice(0, 180) } : {}) };
}

function bounded(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} is within the diagnostic bound`);
  return value;
}

function connectionString() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/audit_test');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5433' &&
    url.username === 'test' && url.password === 'test' && url.pathname === '/audit_test' && !url.search && !url.hash,
  'Use only the dedicated localhost test:test audit_test database on port 5433');
  return url.href;
}

function installedPackage(variable) {
  const supplied = process.env[variable];
  assert.ok(supplied && path.isAbsolute(supplied), `${variable} must be absolute`);
  const directory = fs.realpathSync(supplied);
  assert.ok(directory.includes(`${path.sep}node_modules${path.sep}`), 'Use installed public packages');
  assert.ok(!fs.lstatSync(supplied).isSymbolicLink(), 'Do not use source/package symlinks');
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
  assert.ok(artifact && !artifact.link && /^sha512-[A-Za-z0-9+/=]+$/.test(artifact.integrity ?? ''), 'Verify installed artifact integrity');
  const library = require(directory);
  for (const key of ['AuditService', 'AuditContext', 'createAuditedClient', 'applyAuditTableSchema']) {
    assert.equal(typeof library[key], 'function', `Public API ${key} must exist`);
  }
  return { directory, library, artifact: { version: manifest.version, resolved: artifact.resolved, integrity: artifact.integrity } };
}

function category(sql) {
  if (typeof sql !== 'string') return 'unclassified';
  const start = sql.trimStart();
  if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(start)) return 'begin';
  if (/^COMMIT\b/i.test(start)) return 'commit';
  if (/^ROLLBACK\b/i.test(start)) return 'rollback';
  if (/^INSERT\b/i.test(start)) {
    if (/\baudit_logs\b/i.test(start)) return 'audit-insert';
    if (/\busers\b/i.test(start)) return 'business-insert';
    return 'other-insert';
  }
  if (/^SELECT\b/i.test(start)) return 'select';
  return 'other';
}

function instrumentQueries() {
  const original = Client.prototype.query;
  Client.prototype.query = function diagnosticQuery(...args) {
    const scope = operationScope.getStore();
    if (!scope) return Reflect.apply(original, this, args);
    const input = args[0];
    if (input && typeof input.submit === 'function') {
      scope.unsupportedQueryObjects += 1;
      return Reflect.apply(original, this, args);
    }
    const start = performance.now();
    const queryCategory = category(typeof input === 'string' ? input : input?.text);
    let complete = false;
    const finish = failed => {
      if (complete) return;
      complete = true;
      // Diagnostic recording must never replace a database result/error.
      try { scope.queries.push({ category: queryCategory, startedAtMs: start, durationMs: performance.now() - start, failed }); } catch {}
    };
    const wrap = callback => function observedCallback(...values) {
      finish(Boolean(values[0]));
      return Reflect.apply(callback, this, values);
    };
    if (typeof args[2] === 'function') args[2] = wrap(args[2]);
    else if (typeof args[1] === 'function') args[1] = wrap(args[1]);
    else if (input && typeof input.callback === 'function') args[0] = { ...input, callback: wrap(input.callback) };
    try {
      const result = Reflect.apply(original, this, args);
      if (result && typeof result.then === 'function') {
        // Preserve the actual returned Promise, including its rejection identity.
        void result.then(() => finish(false), () => finish(true));
      }
      return result;
    } catch (error) {
      finish(true);
      throw error;
    }
  };
  return () => { Client.prototype.query = original; };
}

function statistics(values, elapsedMs) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = value => sorted[Math.ceil(sorted.length * value) - 1];
  return { samples: sorted.length, meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    minMs: sorted[0], maxMs: sorted.at(-1), measuredElapsedMs: elapsedMs,
    operationsPerSecond: sorted.length * 1000 / elapsedMs };
}

function poolState(pool) {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

function delaySnapshot(histogram) {
  const samples = Number(histogram.count);
  return samples ? { samples, meanMs: histogram.mean / 1e6, maxMs: histogram.max / 1e6,
    p95Ms: histogram.percentile(95) / 1e6, p99Ms: histogram.percentile(99) / 1e6 } : { samples: 0 };
}

async function main() {
  const reportPath = process.env.DIAG_REPORT_PATH;
  assert.ok(reportPath && path.isAbsolute(reportPath), 'DIAG_REPORT_PATH must be absolute');
  assert.ok(!fs.existsSync(reportPath), 'Diagnostic reports must not overwrite existing evidence');
  const mode = process.env.DIAG_MODE ?? 'sequential';
  const prelude = process.env.DIAG_PRELUDE ?? 'none';
  assert.ok(['sequential', 'interleaved'].includes(mode));
  assert.ok(['none', '64k'].includes(prelude));
  const iterations = bounded('DIAG_ITERATIONS', 1000, 100, 2000);
  const repeats = bounded('DIAG_REPEATS', 6, 2, 8);
  const warmup = bounded('DIAG_WARMUP', 100, 0, 200);
  const poolMax = bounded('DIAG_POOL_MAX', 4, 1, 4);
  const idleTimeoutMillis = bounded('DIAG_IDLE_TIMEOUT_MS', 1000, 1000, 600000);
  assert.ok([1, 4].includes(poolMax));
  assert.ok([1000, 600000].includes(idleTimeoutMillis));
  assert.equal(iterations % 100, 0, 'Interleaved ABBA cycles use multiples of 100 operations per slot');
  const principalTransactions = (iterations + warmup) * repeats * (prelude === '64k' ? 4 : 2);
  assert.ok(principalTransactions <= 100000, 'Diagnostic principal transaction count remains bounded');
  const url = connectionString();
  const left = installedPackage('DIAG_LEFT_PACKAGE_PATH');
  const right = installedPackage('DIAG_RIGHT_PACKAGE_PATH');
  assert.notEqual(left.directory, right.directory, 'Slots must use distinct installed module directories');
  assert.notEqual(left.library.AuditContext, right.library.AuditContext, 'Slots must not share the same require-cache module');
  const slots = { left, right };
  const token = randomUUID().replaceAll('-', '');
  const schema = `audit_cause_${token}`;
  const report = { schemaVersion: 1, kind: 'automatic-create-cause-diagnostic', status: 'running',
    startedAt: new Date().toISOString(), diagnosticOnly: true, schema,
    metadata: { mode, prelude, iterations, repeats, warmup, poolMax, idleTimeoutMillis, principalTransactions,
      node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model,
      packages: { left: left.artifact, right: right.artifact },
      comparison: left.artifact.integrity === right.artifact.integrity ? 'A/A' : 'A/B',
      timeOriginMs: performance.timeOrigin,
      instrumentation: 'Both slots include query timing and ALS, GC observation, event-loop and pool event recording. Event-loop-delay histogram resolution is 10ms. Diagnostic numbers are not release-gate measurements. Driver durations include network and JS scheduling; pair server snapshots include prelude/warmup/correctness queries, while sequential automatic measured chunks also have their own untimed before/after snapshots.',
      reportSerialization: 'Telemetry remains buffered until final cleanup; no JSON serialization or report writes occur between measured pairs. Per-slot throughput divides samples by the sum of that slot\'s measured chunk durations, excluding interleaved time spent in the other slot.',
      counterScope: 'Database/bgwriter/WAL counters may include other sessions and lag current activity. pg_stat_statements rows are limited to the current database and expose safe categories only. No counters are reset. Snapshots are context, not exact per-operation attribution.',
      ordering: 'Sequential pairs alternate left-first/right-first. Interleaved pairs alternate starting slot and use 50-operation ABBA or BAAB cycles. Both retain accumulated audit rows.' },
    pairs: [], chunks: [], poolEvents: [], gcEvents: [], cleanup: { status: 'not-created' } };
  const save = () => { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); };
  let prisma;
  let bootstrap;
  let pool;
  let created = false;
  let restoreQueries;
  let observer;
  let histogram;
  let auditRows = 0;
  let phase = 'setup';
  const { PrismaClient, Prisma } = require(path.join(root, 'test/e2e/generated/prisma/client.ts'));

  async function databaseSnapshot() {
    const result = { atUtc: new Date().toISOString(), monotonicMs: performance.now() };
    const queries = {
      bgwriter: 'SELECT * FROM pg_stat_bgwriter',
      wal: 'SELECT * FROM pg_stat_wal',
      database: 'SELECT * FROM pg_stat_database WHERE datname = current_database()',
      statements: `SELECT userid::text, dbid::text, toplevel, queryid::text AS queryid, plans::text, total_plan_time,
        calls::text, total_exec_time, rows::text,
        shared_blks_hit::text, shared_blks_read::text, shared_blks_dirtied::text, shared_blks_written::text,
        blk_read_time, blk_write_time, wal_records::text, wal_fpi::text, wal_bytes::text,
        CASE WHEN query ~* '^\\s*(BEGIN|START TRANSACTION)' THEN 'begin'
          WHEN query ~* '^\\s*COMMIT' THEN 'commit'
          WHEN query ~* '^\\s*INSERT' AND query ~* 'audit_logs' THEN 'audit-insert'
          WHEN query ~* '^\\s*INSERT' AND query ~* 'users' THEN 'business-insert'
          WHEN query ~* '^\\s*SELECT' THEN 'select' ELSE 'other' END AS category
        FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    };
    for (const [name, sql] of Object.entries(queries)) {
      try { result[name] = { status: 'available', rows: (await bootstrap.query(sql)).rows }; }
      catch (error) { result[name] = { status: 'unavailable', error: safeError(error) }; }
    }
    return result;
  }

  function dataset(slot, repeat, kind) {
    const actorId = `${token}_${repeat}_${slot}_${kind}`;
    return { slot, repeat, kind, actorId, actor: { id: actorId, type: 'system' }, samples: [], elapsedMs: 0,
      records: Array.from({ length: warmup + iterations }, (_, index) => ({ id: randomUUID(), name: `cause-${index}`,
        email: `${actorId}-${index}@cause.test`, password: 'diagnostic-secret' })) };
  }

  function execute(item, record, data) {
    return item.library.AuditContext.runAs(data.actor, () => data.kind === 'prelude'
      ? prisma.$transaction(async tx => {
        await tx.user.create({ data: record });
        await item.service.log({ action: 'User.manual-diagnostic', targetType: 'User', targetId: record.id,
          metadata: reportPreludeMetadata }, tx);
      })
      : item.automatic.withAuditTransaction(async tx => { await tx.user.create({ data: record }); }));
  }

  async function chunk(data, startIndex, size, measured, concurrency) {
    const item = slots[data.slot];
    phase = `${data.repeat}/${data.kind}/${data.slot}/${measured ? 'measured' : 'warmup'}`;
    report.activePhase = phase;
    const captureDatabase = mode === 'sequential' && data.kind === 'automatic-create' && measured;
    const databaseBefore = captureDatabase ? await databaseSnapshot() : undefined;
    const startedAtUtc = new Date().toISOString();
    const memoryBefore = process.memoryUsage();
    const poolBefore = poolState(pool);
    const cpu = process.cpuUsage();
    const utilization = performance.eventLoopUtilization();
    histogram.reset();
    const start = performance.now();
    let next = startIndex;
    const stop = startIndex + size;
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, size) }, async () => {
      while (next < stop) {
        const index = next++;
        const scope = { slot: data.slot, repeat: data.repeat, kind: data.kind, index,
          queries: [], unsupportedQueryObjects: 0 };
        const began = performance.now();
        if (measured) await operationScope.run(scope, () => execute(item, data.records[index], data));
        else await execute(item, data.records[index], data);
        if (measured) {
          const ended = performance.now();
          const queryMs = scope.queries.reduce((sum, query) => sum + query.durationMs, 0);
          data.samples.push({ index: index - warmup, startedAtMs: began, endedAtMs: ended,
            latencyMs: ended - began, queryMs, nonQueryResidualMs: ended - began - queryMs,
            queries: scope.queries, unsupportedQueryObjects: scope.unsupportedQueryObjects });
        }
      }
    }));
    const end = performance.now();
    const elapsedMs = end - start;
    if (measured) data.elapsedMs += elapsedMs;
    const failure = settled.find(value => value.status === 'rejected');
    const output = { order: report.chunks.length + 1, phase, repeat: data.repeat, slot: data.slot, kind: data.kind,
      measured, startIndex, size, concurrency, startedAtUtc, endedAtUtc: new Date().toISOString(),
      startedAtMs: start, endedAtMs: end, elapsedMs, cpuMicroseconds: process.cpuUsage(cpu),
      eventLoopUtilization: performance.eventLoopUtilization(utilization), eventLoopDelay: delaySnapshot(histogram),
      memoryBefore, memoryAfter: process.memoryUsage(), poolBefore, poolAfter: poolState(pool),
      status: failure ? 'failed' : 'passed' };
    report.chunks.push(output);
    if (captureDatabase) {
      output.databaseBefore = databaseBefore;
      output.databaseAfter = await databaseSnapshot();
    }
    if (failure) throw failure.reason;
  }

  async function verify(data) {
    const ids = data.records.map(record => record.id);
    const expected = data.records.length;
    const businessRows = await prisma.user.count({ where: { id: { in: ids } } });
    assert.equal(businessRows, expected, 'Every business create commits');
    const [actual] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE action = $2 AND source = $3 AND target_type = 'User' AND tenant_id = 'diagnostic-tenant')::int AS matching,
      count(*) FILTER (WHERE actor_type = 'system')::int AS actor_matching,
      count(*) FILTER (WHERE changes::text LIKE '%diagnostic-secret%' OR metadata::text LIKE '%diagnostic-secret%')::int AS leaked
      FROM "${schema}".audit_logs WHERE actor_id = $1`, data.actorId,
    data.kind === 'prelude' ? 'User.manual-diagnostic' : 'User.created', data.kind === 'prelude' ? 'manual' : 'auto');
    assert.deepEqual(actual, { total: expected, matching: expected, actor_matching: expected, leaked: 0 });
    if (data.kind === 'prelude') {
      const [valid] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS matching FROM "${schema}".audit_logs
        WHERE actor_id = $1 AND metadata = $2::jsonb`, data.actorId,
      JSON.stringify({ ...reportPreludeMetadata, password: '[REDACTED]' }));
      assert.equal(valid.matching, expected);
    } else {
      const [valid] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS matching FROM "${schema}".audit_logs
        WHERE actor_id = $1 AND changes IS NOT NULL`, data.actorId);
      assert.equal(valid.matching, expected);
    }
    auditRows += expected;
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    assert.equal(data.samples.length, iterations);
    return { slot: data.slot, repeat: data.repeat, kind: data.kind,
      statistics: statistics(data.samples.map(sample => sample.latencyMs), data.elapsedMs),
      samples: data.samples, evidence: { checked: true, businessRows, auditRows: expected, cumulativeAuditRows: auditRows } };
  }

  const reportPreludeMetadata = { reason: 'diagnostic preconditioning', password: 'diagnostic-secret',
    payload: '한글😀'.repeat(Math.ceil(65536 / Buffer.byteLength('한글😀'))) };

  try {
    save();
    restoreQueries = instrumentQueries();
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) report.gcEvents.push({ startedAtMs: entry.startTime,
        durationMs: entry.duration, kind: entry.detail?.kind, flags: entry.detail?.flags });
    });
    observer.observe({ entryTypes: ['gc'] });
    histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    bootstrap = new Client({ connectionString: url, application_name: 'audit-cause-observer', connectionTimeoutMillis: 10000 });
    await bootstrap.connect();
    await bootstrap.query('SET stats_fetch_consistency = none');
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    report.cleanup.status = 'pending';
    await bootstrap.query(`CREATE TABLE "${schema}".users (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP(3) NOT NULL)`);
    pool = new Pool({ connectionString: url, application_name: 'audit-cause-workload', max: poolMax,
      idleTimeoutMillis, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
    const ids = new WeakMap();
    let nextId = 0;
    const clientId = client => { if (!client) return null; if (!ids.has(client)) ids.set(client, ++nextId); return ids.get(client); };
    const poolEvent = (event, client, error) => report.poolEvents.push({ event, atMs: performance.now(), phase,
      clientId: clientId(client), ...poolState(pool), ...(error ? { error: safeError(error) } : {}) });
    for (const event of ['connect', 'acquire', 'remove']) pool.on(event, client => poolEvent(event, client));
    pool.on('release', (error, client) => poolEvent('release', client, error));
    pool.on('error', (error, client) => poolEvent('error', client, error));
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }),
      transactionOptions: { maxWait: 30000, timeout: 30000 } });
    await prisma.$connect();
    report.metadata.server = (await bootstrap.query('SELECT version() AS version')).rows[0].version;
    report.metadata.prisma = Prisma.prismaVersion.client;
    report.metadata.databaseSettings = (await bootstrap.query(`SELECT name, setting FROM pg_settings
      WHERE name IN ('track_io_timing','track_wal_io_timing','pg_stat_statements.track_planning','shared_preload_libraries','checkpoint_timeout','max_wal_size','fsync','synchronous_commit')`)).rows;
    await right.library.applyAuditTableSchema(prisma, { tableName: `${schema}.audit_logs` });
    for (const item of Object.values(slots)) {
      const shared = { tableName: `${schema}.audit_logs`, prismaModule: { Prisma }, actorRequired: true,
        tenantRequired: true, tenantResolver: () => 'diagnostic-tenant', sensitiveFields: ['password'] };
      item.service = new item.library.AuditService({ ...shared, prisma, actorExtractor: () => null });
      item.automatic = item.library.createAuditedClient(prisma, { ...shared, consistency: 'atomic-required',
        trackedModels: ['User'], databaseMapping: { User: { tableName: 'users', schema } } });
    }
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const order = repeat % 2 ? ['left', 'right'] : ['right', 'left'];
      const pair = { repeat, startedAtUtc: new Date().toISOString(), startedAtMs: performance.now(), order,
        auditRowsBefore: auditRows, databaseBefore: await databaseSnapshot(), prelude: [], results: [] };
      report.pairs.push(pair);
      if (prelude === '64k') {
        for (const slot of order) {
          const data = dataset(slot, repeat, 'prelude');
          if (warmup) await chunk(data, 0, warmup, false, 4);
          await chunk(data, warmup, iterations, true, 4);
          pair.prelude.push(await verify(data));
        }
      }
      const data = Object.fromEntries(['left', 'right'].map(slot => [slot, dataset(slot, repeat, 'automatic-create')]));
      if (mode === 'sequential') {
        for (const slot of order) {
          if (warmup) await chunk(data[slot], 0, warmup, false, 1);
          await chunk(data[slot], warmup, iterations, true, 1);
          pair.results.push(await verify(data[slot]));
        }
      } else {
        for (const slot of order) if (warmup) await chunk(data[slot], 0, warmup, false, 1);
        const position = { left: warmup, right: warmup };
        for (let cycle = 0; cycle < iterations / 100; cycle++) {
          const [a, b] = cycle % 2 ? [...order].reverse() : order;
          for (const slot of [a, b, b, a]) {
            await chunk(data[slot], position[slot], 50, true, 1);
            position[slot] += 50;
          }
        }
        for (const slot of order) pair.results.push(await verify(data[slot]));
      }
      await new Promise(resolve => setImmediate(resolve));
      const leftStats = pair.results.find(result => result.slot === 'left').statistics;
      const rightStats = pair.results.find(result => result.slot === 'right').statistics;
      pair.ratios = { mean: rightStats.meanMs / leftStats.meanMs, p95: rightStats.p95Ms / leftStats.p95Ms,
        p99: rightStats.p99Ms / leftStats.p99Ms, throughput: rightStats.operationsPerSecond / leftStats.operationsPerSecond };
      pair.databaseAfter = await databaseSnapshot();
      pair.endedAtMs = performance.now();
      pair.endedAtUtc = new Date().toISOString();
      pair.auditRowsAfter = auditRows;
      console.log(`DIAGNOSTIC pair ${repeat}: mean ${pair.ratios.mean.toFixed(3)}x, P95 ${pair.ratios.p95.toFixed(3)}x; ${mode}/${prelude}`);
    }
    report.status = 'passed';
    delete report.activePhase;
  } catch (error) {
    report.status = 'failed';
    report.error = safeError(error);
  } finally {
    const failures = [];
    if (prisma) try { await prisma.$disconnect(); } catch (error) { failures.push(safeError(error)); }
    if (pool) try { await pool.end(); } catch (error) { failures.push(safeError(error)); }
    if (created && bootstrap) try {
      assert.match(schema, /^audit_cause_[a-f0-9]{32}$/);
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch (error) { failures.push(safeError(error)); }
    if (bootstrap) try { await bootstrap.end(); } catch (error) { failures.push(safeError(error)); }
    await new Promise(resolve => setImmediate(resolve));
    observer?.disconnect();
    histogram?.disable();
    restoreQueries?.();
    report.cleanup = { status: failures.length ? 'failed' : created ? 'passed' : 'not-created', failures };
    if (failures.length) report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    save();
  }
  console.log(`Automatic-create diagnostic ${report.status}; report: ${reportPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

module.exports = { category, statistics, instrumentQueries };
if (require.main === module) void main().catch(error => { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; });
