import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runId = randomUUID().replaceAll('-', '');
const tableName = `bench_${runId.slice(0, 24)}`;
const reportPath = resolve(process.env.MSSQL_REPORT_PATH ?? join(fixtureDirectory, 'results/manual-benchmark.json'));
const actor = { id: 'configured-per-scenario', type: 'system', ip: '127.0.0.1' };
const tenantId = `bench_${runId}`;
const businessMarkers = new Set();
const report = {
  schemaVersion: 1,
  kind: 'sqlserver-packed-manual-audit-benchmark',
  status: 'running',
  runId,
  startedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    cpuModel: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
  },
  methodology: {
    operation: 'one ProbeBusiness.create in an interactive transaction, with or without awaited AuditService.log(input, tx)',
    latencyTimer: 'performance.now; includes transaction acquisition/begin/commit, log-call input construction and audit policy, redaction, JSON serialization and INSERT; excludes fixture record/metadata preparation, AuditContext setup, verification, DDL and cleanup',
    throughputTimer: 'closed-loop worker batch wall time; includes worker scheduling and actor-context setup, excludes warmup and verification',
    percentiles: 'nearest-rank; index ceil(percentile * sampleCount) - 1',
    order: 'repeat/payload/concurrency, with mode-pair order AB, BA, BA, AB in a repeating four-repeat block',
    isolation: 'one fresh runner-owned database per invocation, one pool, unique business markers and audit table',
    comparison: 'manual-audit minus transaction baseline for the same payload, concurrency and repeat; baseline has the same business write and transaction but does not serialize or store audit metadata',
    limits: [
      'Closed-loop throughput at fixed worker concurrency is not a maximum-capacity or production SLA measurement.',
      'Large metadata is 65536 UTF-16 code units including JSON syntax: 131072 bytes in NVARCHAR storage, not 64 KiB.',
      'Scenario order, growing audit table, shared hosted-runner resources, cache state, and database/log growth can affect results.',
      'Four-repeat ABBA mode ordering balances pair position but does not eliminate host noise or establish statistical significance.',
      'P99 at the default 500 samples depends on about five tail observations; preserve every repeat and raw sample.',
      'Only create transactions are measured; update/delete, network-distance, long transactions, schema changes and production read/index workloads are not represented.',
      'Successful status means correctness checks passed; there is no universal latency or throughput pass threshold.',
    ],
  },
  scenarios: [],
  comparisons: [],
  cleanup: { status: 'not-started' },
};
let library;
let prisma;
let Prisma;
let service;
let ownsAuditTable = false;

function token(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}

function safeError(error) {
  return { name: token(error?.name) ?? 'Error', errorClass: token(error?.constructor?.name), code: token(error?.code) };
}

function identifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/, 'SQL identifier is allowlisted');
  return `[${value}]`;
}

function count(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${name} is within benchmark bounds`);
  return value;
}

function gitMetadata() {
  try {
    const options = { cwd: fixtureDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return {
      headSha: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
      modifiedSources: execFileSync('git', ['status', '--porcelain', '--', '../../src', '../../package.json', '../../package-lock.json', '.'], options).trim().length > 0,
    };
  } catch { return { headSha: null, modifiedSources: null }; }
}

async function packageInfo(name, resolver = require) {
  let entry;
  try { entry = resolver.resolve(`${name}/package.json`); } catch { entry = resolver.resolve(name); }
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const manifestPath = join(directory, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name === name) return { version: manifest.version, directory, resolver: createRequire(manifestPath) };
    } catch { /* Follow an exported entry point to its owning package. */ }
    directory = dirname(directory);
  }
  throw new Error('Required package manifest unavailable');
}

async function installedFingerprint(directory) {
  async function files(relativeDirectory) {
    const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true });
    const paths = await Promise.all(entries.map(async entry => {
      const path = join(relativeDirectory, entry.name);
      assert.ok(entry.isDirectory() || entry.isFile(), 'Packed runtime contains no symbolic links');
      return entry.isDirectory() ? files(path) : [path];
    }));
    return paths.flat();
  }
  const digest = createHash('sha256');
  for (const path of ['package.json', ...(await files('dist'))].sort()) {
    digest.update(path).update('\0').update(await readFile(join(directory, path))).update('\0');
  }
  return digest.digest('hex');
}

async function saveReport() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function summarize(samples, wallMs) {
  assert.ok(samples.length > 0 && samples.every(value => Number.isFinite(value) && value >= 0), 'Every measured operation has a valid latency');
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {
    count: samples.length,
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    minMs: sorted[0], maxMs: sorted[sorted.length - 1],
    wallMs,
    operationsPerSecond: samples.length / (wallMs / 1_000),
    samplesMs: samples,
  };
}

function payload(utf16CodeUnits) {
  const empty = { message: '', password: '[REDACTED]' };
  const remaining = utf16CodeUnits - JSON.stringify(empty).length;
  assert.ok(remaining > 0);
  const pattern = '한😀글';
  const message = pattern.repeat(Math.floor(remaining / pattern.length)) + 'x'.repeat(remaining % pattern.length);
  const input = { message, password: 'benchmark-sensitive' };
  const expected = JSON.stringify({ message, password: '[REDACTED]' });
  assert.equal(expected.length, utf16CodeUnits, 'Payload has its declared UTF-16 size after redaction');
  return { input, expected, utf16CodeUnits, nvarcharBytes: expected.length * 2 };
}

async function databaseFiles() {
  const rows = await prisma.$queryRaw`SELECT [name], [type_desc], CONVERT(BIGINT, [size]) * 8192 AS [size_bytes], [growth], [is_percent_growth] FROM sys.database_files ORDER BY [file_id]`;
  return rows.map(row => ({ ...row, size_bytes: Number(row.size_bytes) }));
}

async function initialize(settings) {
  for (const name of ['MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_DATABASE']) assert.ok(process.env[name], 'Runner supplies SQL Server configuration');
  const database = process.env.MSSQL_DATABASE;
  assert.match(database, /^audit_preflight_[a-f0-9]{32}$/, 'Only the runner-created disposable database is accepted');
  const port = Number(process.env.MSSQL_PORT ?? 1433);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Server port is valid');
  const [cli, client, adapterPackage, packed] = await Promise.all([
    packageInfo('prisma'), packageInfo('@prisma/client'), packageInfo('@prisma/adapter-mssql'), packageInfo('@nestarc/audit-log'),
  ]);
  for (const found of [cli, client, adapterPackage]) assert.equal(found.version, '7.10.0', 'Prisma CLI/client/adapter must be 7.10.0');
  const dependencyRoot = await realpath(join(fixtureDirectory, 'node_modules'));
  const installed = await realpath(packed.directory);
  const installedRelative = relative(dependencyRoot, installed);
  assert.ok(!installedRelative.startsWith('..') && !installedRelative.startsWith('/'), 'Use the packed installed library, not a linked source checkout');
  const mssql = await packageInfo('mssql', adapterPackage.resolver);
  const tedious = await packageInfo('tedious', mssql.resolver);
  await import('reflect-metadata');
  library = await import('@nestarc/audit-log');
  const generated = await import('./generated/client/client.ts');
  Prisma = generated.Prisma;
  assert.equal(Prisma.prismaVersion.client, '7.10.0', 'Generated client matches the runtime');
  const { PrismaMssql } = await import('@prisma/adapter-mssql');
  report.connectionSettings = { poolMinimum: 0, poolMaximum: settings.poolMaximum, connectionTimeoutMs: 15_000, requestTimeoutMs: 60_000, transactionMaxWaitMs: 15_000, transactionTimeoutMs: 15_000 };
  prisma = new generated.PrismaClient({
    adapter: new PrismaMssql({
      server: process.env.MSSQL_HOST ?? '127.0.0.1', port,
      user: process.env.MSSQL_USER, password: process.env.MSSQL_PASSWORD, database,
      connectionTimeout: 15_000, requestTimeout: 60_000,
      options: { encrypt: true, trustServerCertificate: true },
      pool: { min: 0, max: settings.poolMaximum, idleTimeoutMillis: 30_000 },
    }, { schema: 'dbo' }),
    transactionOptions: { maxWait: 15_000, timeout: 15_000 },
  });
  await prisma.$connect();
  const [server] = await prisma.$queryRaw`
    SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS NVARCHAR(10)) AS [major],
           CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(100)) AS [version],
           CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) AS [edition],
           CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS NVARCHAR(100)) AS [collation],
           DB_NAME() AS [database_name], @@VERSION AS [description]
  `;
  assert.equal(server.major, '17', 'Benchmark target is SQL Server 2025');
  assert.equal(server.database_name, database, 'Connected database is owned by the runner');
  Object.assign(report.environment, {
    ...gitMetadata(),
    packages: { library: packed.version, prisma: cli.version, client: client.version, adapter: adapterPackage.version, mssql: mssql.version, tedious: tedious.version },
    installedLibrary: installedRelative,
    installedRuntimeSha256: await installedFingerprint(installed),
    server,
    imageReference: process.env.MSSQL_IMAGE_REFERENCE ?? null,
    imageDigest: process.env.MSSQL_IMAGE_DIGEST ?? null,
    declaredServerPlatform: process.env.MSSQL_SERVER_PLATFORM ?? null,
    githubRunId: token(process.env.GITHUB_RUN_ID) ?? null,
    githubRunAttempt: token(process.env.GITHUB_RUN_ATTEMPT) ?? null,
  });
  report.serverSettings = await prisma.$queryRaw`
    SELECT [name], CONVERT(INT, [value_in_use]) AS [value_in_use]
    FROM sys.configurations
    WHERE [name] IN ('max server memory (MB)', 'min server memory (MB)', 'max degree of parallelism', 'cost threshold for parallelism')
    ORDER BY [name]
  `;
  const before = await databaseFiles();
  assert.equal(before.length, 2, 'Fresh database contains one data file and one log file');
  assert.deepEqual(before.map(file => file.type_desc).sort(), ['LOG', 'ROWS']);
  // Pre-size only the database generated by run.mjs, outside all measured intervals.
  // This reduces repeated autogrowth when the large JSON cases accumulate > 0.5 GiB.
  for (const file of before) {
    assert.ok(file.size_bytes <= 1024 ** 3, 'Fresh runner database is within the initial file budget');
    await prisma.$executeRawUnsafe(`ALTER DATABASE ${identifier(database)} MODIFY FILE (NAME = ${identifier(file.name)}, SIZE = 1024MB, FILEGROWTH = 256MB)`);
  }
  const [storage] = await prisma.$queryRaw`SELECT [recovery_model_desc] FROM sys.databases WHERE [name] = DB_NAME()`;
  report.storage = { beforePresizing: before, beforeMeasurement: await databaseFiles(), recoveryModel: storage.recovery_model_desc, presizeMiBPerFile: 1024, growthMiBPerFile: 256 };
  const qualified = `dbo.${tableName}`;
  const [existing] = await prisma.$queryRaw`SELECT OBJECT_ID(${qualified}) AS [object_id]`;
  assert.equal(existing.object_id, null, 'Benchmark does not replace an existing table');
  ownsAuditTable = true;
  await library.applyAuditTableSchema(prisma, { provider: 'sqlserver', tableName: qualified });
  service = new library.AuditService({
    provider: 'sqlserver', tableName: qualified, prisma, prismaModule: { Prisma },
    actorExtractor: () => null, actorRequired: true, tenantRequired: true,
    tenantResolver: () => tenantId, sensitiveFields: ['password'],
    logger: { warn() {}, error() {} },
  });
}

async function measuredBatch(records, concurrency, mode, metadata, scenarioActor, result, phase) {
  const samples = new Array(records.length);
  let next = 0;
  let stopped = false;
  let completed = 0;
  const wallStart = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, records.length) }, async () => {
    while (!stopped && next < records.length) {
      const index = next++;
      const record = records[index];
      try {
        await library.AuditContext.runAs(scenarioActor, async () => {
          const started = performance.now();
          await prisma.$transaction(async tx => {
            await tx.probeBusiness.create({ data: record });
            if (mode === 'manual-audit') await service.log({
              action: 'ProbeBusiness.created', targetType: 'ProbeBusiness', targetId: record.id,
              metadata: metadata.input,
            }, tx);
          });
          samples[index] = performance.now() - started;
        });
        completed += 1;
      } catch (error) { stopped = true; throw error; }
    }
  });
  // Wait for every in-flight transaction before verification or cleanup, including on failure.
  const settled = await Promise.allSettled(workers);
  const wallMs = performance.now() - wallStart;
  result.progress = { phase, expected: records.length, completed };
  const failed = settled.find(worker => worker.status === 'rejected');
  if (failed) throw failed.reason;
  assert.equal(completed, records.length, 'Every scheduled operation commits');
  return summarize(samples, wallMs);
}

async function verifyScenario(records, metadata, scenarioActor, mode) {
  const business = await prisma.probeBusiness.findMany({ where: { marker: scenarioActor.id }, select: { id: true } });
  const expectedIds = records.map(record => record.id).sort();
  assert.deepEqual(business.map(row => row.id).sort(), expectedIds, 'Business rows match every warmup and measured operation');
  const audit = await prisma.$queryRaw(Prisma.sql`
    SELECT [target_id], [target_type], [action], [source], [result], [actor_type], [actor_ip], [tenant_id],
           DATALENGTH([metadata]) AS [metadata_bytes]
    FROM ${Prisma.raw(`[dbo].${identifier(tableName)}`)} WHERE [actor_id] = ${scenarioActor.id}
  `);
  if (mode === 'transaction') assert.equal(audit.length, 0, 'Baseline writes no audit events');
  else {
    assert.deepEqual(audit.map(row => row.target_id).sort(), expectedIds, 'Every business row has exactly one matching audit row');
    for (const row of audit) {
      assert.equal(row.action, 'ProbeBusiness.created');
      assert.equal(row.target_type, 'ProbeBusiness');
      assert.equal(row.source, 'manual');
      assert.equal(row.result, 'success');
      assert.equal(row.actor_type, scenarioActor.type);
      assert.equal(row.actor_ip, scenarioActor.ip);
      assert.equal(row.tenant_id, tenantId);
      assert.equal(Number(row.metadata_bytes), metadata.nvarcharBytes, 'Every metadata value has its full expected Unicode byte length');
    }
    for (const record of [records[0], records[records.length - 1]]) {
      const [row] = await prisma.$queryRaw(Prisma.sql`SELECT [metadata] FROM ${Prisma.raw(`[dbo].${identifier(tableName)}`)} WHERE [target_id] = ${record.id}`);
      assert.equal(row.metadata, metadata.expected, 'Representative JSON payloads round-trip exactly with redaction');
    }
  }
  return { businessRows: business.length, auditRows: audit.length, expectedRows: records.length, metadataBytesPerAudit: mode === 'manual-audit' ? metadata.nvarcharBytes : 0 };
}

async function runScenario(settings, repeat, metadata, concurrency, mode, sequence) {
  const marker = `${runId}_${sequence}`;
  businessMarkers.add(marker);
  const scenarioActor = { ...actor, id: marker };
  const makeRecords = (phase, length) => Array.from({ length }, (_, index) => ({ id: `${marker}_${phase}_${index}`, marker }));
  const warmupRecords = makeRecords('w', settings.warmup);
  const measuredRecords = makeRecords('m', settings.iterations);
  const allRecords = [...warmupRecords, ...measuredRecords];
  assert.ok(allRecords.every(record => record.id.length <= 80 && record.marker.length <= 200));
  const result = { sequence, repeat, mode, payloadUtf16CodeUnits: metadata.utf16CodeUnits, payloadNvarcharBytes: metadata.nvarcharBytes, concurrency, status: 'running' };
  report.scenarios.push(result);
  await saveReport();
  try {
    const warmupResult = await measuredBatch(warmupRecords, concurrency, mode, metadata, scenarioActor, result, 'warmup');
    result.warmup = { count: warmupResult.count, wallMs: warmupResult.wallMs };
    result.measurement = await measuredBatch(measuredRecords, concurrency, mode, metadata, scenarioActor, result, 'measurement');
    result.correctness = await verifyScenario(allRecords, metadata, scenarioActor, mode);
    result.status = 'passed';
    console.log(`PASS benchmark repeat=${repeat} mode=${mode} utf16=${metadata.utf16CodeUnits} concurrency=${concurrency} meanMs=${result.measurement.meanMs.toFixed(3)} p95Ms=${result.measurement.p95Ms.toFixed(3)} opsPerSecond=${result.measurement.operationsPerSecond.toFixed(1)}`);
  } catch (error) {
    result.status = 'failed';
    result.error = safeError(error);
    throw error;
  } finally {
    await saveReport();
  }
  // Business cleanup occurs outside all timing intervals. Append-only audit rows accumulate.
  await prisma.probeBusiness.deleteMany({ where: { marker } });
  businessMarkers.delete(marker);
  return result;
}

async function main() {
  const settings = {
    warmup: count('BENCH_WARMUP', 50, 1, 1_000),
    iterations: count('BENCH_ITERATIONS', 500, 1, 5_000),
    repeats: count('BENCH_REPEATS', 4, 1, 8),
    concurrency: [1, 4], poolMaximum: 4,
    payloadUtf16CodeUnits: [128, 65_536],
  };
  settings.totalTransactions = (settings.warmup + settings.iterations) * settings.repeats * settings.concurrency.length * settings.payloadUtf16CodeUnits.length * 2;
  assert.ok(settings.totalTransactions <= 40_000, 'Total configured workload does not exceed 40000 transactions');
  report.settings = settings;
  await saveReport();
  await initialize(settings);
  await saveReport();
  let sequence = 0;
  const payloads = settings.payloadUtf16CodeUnits.map(payload);
  for (let repeat = 1; repeat <= settings.repeats; repeat += 1) {
    for (const metadata of payloads) {
      for (const concurrency of settings.concurrency) {
        const modes = [0, 1, 1, 0][(repeat - 1) % 4] === 0 ? ['transaction', 'manual-audit'] : ['manual-audit', 'transaction'];
        const pair = {};
        for (const mode of modes) pair[mode] = await runScenario(settings, repeat, metadata, concurrency, mode, sequence++);
        const baseline = pair.transaction.measurement;
        const audited = pair['manual-audit'].measurement;
        report.comparisons.push({
          repeat, payloadUtf16CodeUnits: metadata.utf16CodeUnits, concurrency, order: modes,
          baselineSequence: pair.transaction.sequence, auditedSequence: pair['manual-audit'].sequence,
          meanDeltaMs: audited.meanMs - baseline.meanMs,
          meanRatio: audited.meanMs / baseline.meanMs,
          p95DeltaMs: audited.p95Ms - baseline.p95Ms,
          throughputRatio: audited.operationsPerSecond / baseline.operationsPerSecond,
        });
        await saveReport();
      }
    }
  }
  report.storage.afterMeasurement = await databaseFiles();
  report.storage.grewDuringMeasurement = report.storage.afterMeasurement.some(file => file.size_bytes !== report.storage.beforeMeasurement.find(initial => initial.name === file.name)?.size_bytes);
  report.status = 'passed';
}

try {
  await main();
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error);
  console.error(`MSSQL benchmark failed: ${JSON.stringify(report.error)}`);
} finally {
  report.cleanup.status = 'running';
  const failures = [];
  if (prisma) {
    if (report.storage && !report.storage.afterMeasurement) {
      try { report.storage.afterMeasurement = await databaseFiles(); } catch (error) { failures.push(safeError(error)); }
    }
    for (const marker of businessMarkers) {
      try { await prisma.probeBusiness.deleteMany({ where: { marker } }); } catch (error) { failures.push(safeError(error)); }
    }
    if (ownsAuditTable) {
      try { await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS [dbo].${identifier(tableName)}`); } catch (error) { failures.push(safeError(error)); }
    }
    try { await prisma.$disconnect(); } catch (error) { failures.push(safeError(error)); }
  }
  if (failures.length) report.status = 'failed';
  report.cleanup = { status: failures.length ? 'failed' : 'passed', failures, databaseDrop: 'owned by run.mjs' };
  report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(`MSSQL manual benchmark ${report.status}: ${report.scenarios.filter(scenario => scenario.status === 'passed').length}/${report.scenarios.length} scenarios passed`);
  if (report.status !== 'passed') process.exitCode = 1;
}
