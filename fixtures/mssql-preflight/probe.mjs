import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runId = randomUUID().replaceAll('-', '');
const tableName = `mssql_audit_${runId}`;
const reportPath = resolve(process.env.MSSQL_REPORT_PATH ?? join(fixtureDirectory, 'results/report.json'));
const businessIds = new Set();
const report = {
  scope: 'SQL Server 2025 / Prisma 7.10.0 raw adapter preflight; not AuditService support verification',
  runId,
  startedAt: new Date().toISOString(),
  environment: { node: process.version, clientPlatform: process.platform, clientArchitecture: process.arch },
  probes: [],
  cleanup: { status: 'not-started' },
};
let prisma;
let Prisma;
let table;
let tableCreated = false;

// Do not serialize Prisma error messages, query arguments, connection strings, or arbitrary meta.
function safeError(error) {
  const result = { name: String(error?.name ?? 'Error').slice(0, 80) };
  if (/^[A-Za-z0-9_-]{1,60}$/.test(String(error?.code ?? ''))) result.code = String(error.code);
  if (error instanceof assert.AssertionError) result.assertion = String(error.message).split('\n')[0].slice(0, 180);
  const codes = new Set();
  const seen = new Set();
  function inspect(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 6) return;
    seen.add(value);
    for (const key of ['code', 'number', 'originalCode', 'kind']) {
      const candidate = value[key];
      if (candidate !== undefined && /^[A-Za-z0-9_-]{1,60}$/.test(String(candidate))) codes.add(String(candidate));
    }
    for (const key of ['cause', 'meta', 'driverAdapterError', 'originalError', 'info']) inspect(value[key], depth + 1);
  }
  inspect(error);
  if (codes.size) result.codes = [...codes];
  return result;
}

async function saveReport() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function probe(name, fn, fatal = false) {
  const started = performance.now();
  const result = { name, status: 'running' };
  report.probes.push(result);
  try {
    await saveReport();
    const evidence = await fn(result);
    Object.assign(result, { status: 'passed', evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    Object.assign(result, { status: 'failed', error: safeError(error) });
    console.log(`FAIL ${name} ${JSON.stringify(safeError(error))}`);
    if (fatal) throw error;
  } finally {
    result.milliseconds = Math.round(performance.now() - started);
    await saveReport();
  }
}

async function packageInfo(name, resolver = require) {
  let entry;
  try {
    entry = resolver.resolve(`${name}/package.json`);
  } catch {
    entry = resolver.resolve(name);
  }
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const path = join(directory, 'package.json');
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      if (pkg.name === name) return { version: pkg.version, resolver: createRequire(path) };
    } catch { /* Walk upward from an exported entry point. */ }
    directory = dirname(directory);
  }
  throw new Error(`Could not locate package metadata for ${name}`);
}

function businessId(label) {
  const id = `${runId}_${label}`;
  assert.ok(id.length <= 80, 'Probe business identifier fits the fixture schema');
  businessIds.add(id);
  return id;
}

async function insertAudit(client, id, metadata = null) {
  await client.$executeRaw(Prisma.sql`
    INSERT INTO ${table} ([business_id], [action], [metadata])
    VALUES (${id}, ${'Probe.changed'}, ${metadata})
  `);
}

async function counts(id) {
  const business = await prisma.probeBusiness.count({ where: { id } });
  const rows = await prisma.$queryRaw(Prisma.sql`SELECT COUNT(*) AS [count] FROM ${table} WHERE [business_id] = ${id}`);
  return { business, audit: Number(rows[0].count) };
}

async function expectRows(id, expected) {
  const actual = await counts(id);
  assert.deepEqual(actual, expected, 'Committed business and audit row counts match');
  return actual;
}

async function expectFailure(operation, message) {
  let failure;
  try { await operation(); } catch (error) { failure = error; }
  assert.ok(failure, message);
  return failure;
}

// Read text only to classify the deliberate server failure; never return it in a report.
function errorContains(error, expected) {
  const seen = new Set();
  function inspect(value, depth = 0) {
    if (typeof value === 'string') return value.includes(expected);
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) return false;
    seen.add(value);
    return Object.getOwnPropertyNames(value).some(key => inspect(value[key], depth + 1));
  }
  return inspect(error);
}

function expectCheckError(error) {
  // Adapter 7.10 maps SQL 547 to ForeignKeyConstraintViolation even for CHECKs.
  // The unique constraint name distinguishes this from unrelated rejection causes.
  assert.ok(errorContains(error, `ck_${tableName}`), 'Failure identifies the intended audit CHECK constraint');
}

function expectTriggerError(error) {
  assert.ok(safeError(error).codes?.includes('51001') || errorContains(error, 'Preflight append-only audit table'), 'Failure identifies the append-only trigger');
}

async function committedPair(label, metadata = null) {
  const id = businessId(label);
  const sessions = await prisma.$transaction(async tx => {
    const before = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
    await tx.probeBusiness.create({ data: { id, marker: 'committed' } });
    await insertAudit(tx, id, metadata);
    const after = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
    assert.equal(before[0].session_id, after[0].session_id, 'Business and audit work retain the same SQL session');
    return { before: before[0].session_id, after: after[0].session_id };
  });
  return { id, rows: await expectRows(id, { business: 1, audit: 1 }), sessions };
}

function jsonWithLength(length) {
  const prefix = '{"text":"한글😀';
  const suffix = '","nested":{"value":null}}';
  const value = `${prefix}${'가'.repeat(length - prefix.length - suffix.length)}${suffix}`;
  assert.equal(value.length, length, 'Metadata has the intended UTF-16 length');
  return value;
}

async function main() {
  await probe('exact-versions-and-server', async () => {
    for (const variable of ['MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_DATABASE']) {
      assert.ok(process.env[variable], `${variable} must be supplied for the dedicated test database`);
    }
    const port = Number(process.env.MSSQL_PORT ?? '1433');
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'MSSQL_PORT is valid');
    const [cli, client, adapterPackage] = await Promise.all([
      packageInfo('prisma'), packageInfo('@prisma/client'), packageInfo('@prisma/adapter-mssql'),
    ]);
    const mssqlPackage = await packageInfo('mssql', adapterPackage.resolver);
    const tediousPackage = await packageInfo('tedious', mssqlPackage.resolver);
    const versions = {
      prisma: cli.version,
      client: client.version,
      adapter: adapterPackage.version,
      mssql: mssqlPackage.version,
      tedious: tediousPackage.version,
    };
    for (const key of ['prisma', 'client', 'adapter']) assert.equal(versions[key], '7.10.0', `${key} is pinned to 7.10.0`);
    const generated = await import('./generated/client/client.ts');
    Prisma = generated.Prisma;
    assert.equal(Prisma.prismaVersion.client, '7.10.0', 'Generated Prisma client is 7.10.0');
    const { PrismaMssql } = await import('@prisma/adapter-mssql');
    prisma = new generated.PrismaClient({
      adapter: new PrismaMssql({
        server: process.env.MSSQL_HOST ?? 'localhost',
        port,
        user: process.env.MSSQL_USER,
        password: process.env.MSSQL_PASSWORD,
        database: process.env.MSSQL_DATABASE,
        options: { encrypt: true, trustServerCertificate: true },
        connectionTimeout: 15_000,
        requestTimeout: 5_000,
        pool: { min: 0, max: 2, idleTimeoutMillis: 5_000 },
      }, { schema: 'dbo' }),
      transactionOptions: { maxWait: 10_000, timeout: 10_000 },
    });
    await prisma.$connect();
    const [server] = await prisma.$queryRaw`
      SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS NVARCHAR(10)) AS [major],
             CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(100)) AS [version],
             CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) AS [edition],
             CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS NVARCHAR(100)) AS [collation],
             DB_NAME() AS [database_name], @@VERSION AS [description], @@OPTIONS AS [session_options]
    `;
    assert.equal(server.major, '17', 'Database server is SQL Server 2025 (major 17)');
    assert.equal(server.database_name, process.env.MSSQL_DATABASE, 'Runtime adapter connected to the dedicated database');
    report.environment = {
      ...report.environment,
      versions,
      server,
      poolMaximum: 2,
      schema: 'dbo',
      imageReference: process.env.MSSQL_IMAGE_REFERENCE ?? null,
      imageDigest: process.env.MSSQL_IMAGE_DIGEST ?? null,
      declaredServerPlatform: process.env.MSSQL_SERVER_PLATFORM ?? null,
    };
    return { versions, server };
  }, true);

  await probe('table-and-trigger-ddl-through-prisma', async () => {
    assert.match(tableName, /^[a-z][a-z0-9_]+$/, 'Generated SQL identifier is allowlisted');
    table = Prisma.raw(`[dbo].[${tableName}]`);
    await prisma.$executeRawUnsafe(`CREATE TABLE [dbo].[${tableName}] (
      [id] UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
      [business_id] NVARCHAR(80) NOT NULL,
      [action] NVARCHAR(100) NOT NULL,
      [metadata] NVARCHAR(MAX) NULL,
      [created_at] DATETIME2(7) NOT NULL DEFAULT SYSUTCDATETIME(),
      CONSTRAINT [ck_${tableName}] CHECK ([metadata] IS NULL OR ISJSON([metadata], OBJECT) = 1)
    )`);
    tableCreated = true;
    // Each CREATE TRIGGER is its own batch, with no preceding SET, IF, or GO.
    for (const operation of ['UPDATE', 'DELETE']) {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER [dbo].[${tableName}_${operation.toLowerCase()}]
        ON [dbo].[${tableName}] AFTER ${operation} AS
        BEGIN
          SET NOCOUNT ON;
          IF EXISTS (SELECT 1 FROM deleted)
            THROW 51001, 'Preflight append-only audit table', 1;
        END`);
    }
    const triggers = await prisma.$queryRaw`
      SELECT [name], [is_disabled] FROM sys.triggers WHERE [parent_id] = OBJECT_ID(${`dbo.${tableName}`})
    `;
    assert.equal(triggers.length, 2, 'Both append-only triggers are installed');
    assert.ok(triggers.every(trigger => !trigger.is_disabled), 'Append-only triggers are enabled');
    return { table: `dbo.${tableName}`, triggers, execution: 'Prisma.$executeRawUnsafe, one DDL batch per call' };
  }, true);

  await probe('business-and-audit-commit-together', async () => committedPair('commit', JSON.stringify({ actor: '검증😀' })));

  await probe('business-error-rolls-back-both-writes', async () => {
    const id = businessId('business_rollback');
    const expectedError = new Error('Deliberate business failure');
    const failure = await expectFailure(() => prisma.$transaction(async tx => {
      await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
      await insertAudit(tx, id, JSON.stringify({ reason: 'rollback' }));
      throw expectedError;
    }), 'Business exception rejects the transaction');
    assert.equal(failure, expectedError, 'Original business error propagates');
    return { error: safeError(failure), rows: await expectRows(id, { business: 0, audit: 0 }) };
  });

  await probe('audit-check-error-rolls-back-business', async () => {
    const id = businessId('audit_rollback');
    let insertedBusiness = false;
    const failure = await expectFailure(() => prisma.$transaction(async tx => {
      await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
      insertedBusiness = true;
      await insertAudit(tx, id, 'not-json');
    }), 'Audit CHECK violation rejects the transaction');
    assert.ok(insertedBusiness, 'The business write completed before the audit failure');
    expectCheckError(failure);
    return { error: safeError(failure), rows: await expectRows(id, { business: 0, audit: 0 }) };
  });

  await probe('unicode-and-long-parameter-binding', async result => {
    const results = [];
    result.evidence = { payloads: results, currentUtf16Units: null };
    for (const length of [3999, 4000, 4001, 8001, 65536]) {
      result.evidence.currentUtf16Units = length;
      const id = businessId(`unicode_${length}`);
      const metadata = jsonWithLength(length);
      await prisma.$transaction(async tx => {
        await tx.probeBusiness.create({ data: { id, marker: '한글😀' } });
        await insertAudit(tx, id, metadata);
      });
      const [row] = await prisma.$queryRaw(Prisma.sql`
        SELECT [metadata], DATALENGTH([metadata]) AS [bytes] FROM ${table} WHERE [business_id] = ${id}
      `);
      assert.equal(row.metadata, metadata, 'Unicode metadata round-trips without truncation or replacement');
      assert.equal(Number(row.bytes), metadata.length * 2, 'NVARCHAR byte length preserves all UTF-16 units');
      assert.deepEqual(JSON.parse(row.metadata), JSON.parse(metadata), 'Stored JSON retains its structure');
      results.push({ utf16Units: length, bytes: Number(row.bytes), rows: await expectRows(id, { business: 1, audit: 1 }) });
    }
    const nullId = businessId('null_metadata');
    await insertAudit(prisma, nullId, null);
    const [nullRow] = await prisma.$queryRaw(Prisma.sql`SELECT [metadata] FROM ${table} WHERE [business_id] = ${nullId}`);
    assert.equal(nullRow.metadata, null, 'SQL NULL metadata round-trips as null');
    return { payloads: results, nullMetadata: true };
  });

  await probe('append-only-triggers-reject-multiple-rows', async () => {
    const ids = [businessId('trigger_a'), businessId('trigger_b')];
    for (const id of ids) await insertAudit(prisma, id, JSON.stringify({ immutable: true }));
    const updateFailure = await expectFailure(() => prisma.$executeRaw(Prisma.sql`
      UPDATE ${table} SET [action] = ${'tampered'} WHERE [business_id] IN (${Prisma.join(ids)})
    `), 'Trigger rejects a multi-row UPDATE');
    const deleteFailure = await expectFailure(() => prisma.$executeRaw(Prisma.sql`
      DELETE FROM ${table} WHERE [business_id] IN (${Prisma.join(ids)})
    `), 'Trigger rejects a multi-row DELETE');
    expectTriggerError(updateFailure);
    expectTriggerError(deleteFailure);
    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT [business_id], [action], [metadata] FROM ${table} WHERE [business_id] IN (${Prisma.join(ids)})
    `);
    assert.equal(rows.length, 2, 'Both original audit rows remain after trigger errors');
    assert.ok(rows.every(row => row.action === 'Probe.changed' && JSON.parse(row.metadata).immutable === true), 'No row was modified');
    // Intentional policy: no-op statements succeed, matching a per-row rejection policy.
    await prisma.$executeRaw(Prisma.sql`UPDATE ${table} SET [action] = ${'unused'} WHERE 1 = 0`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM ${table} WHERE 1 = 0`);
    return { rowsUnchanged: rows.length, updateError: safeError(updateFailure), deleteError: safeError(deleteFailure), zeroRowStatementsAllowed: true };
  });

  await probe('trigger-error-rolls-back-transaction-and-pool-recovers', async () => {
    const id = businessId('trigger_rollback');
    let bothWritesCompleted = false;
    const failure = await expectFailure(() => prisma.$transaction(async tx => {
      await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
      await insertAudit(tx, id, '{}');
      bothWritesCompleted = true;
      await tx.$executeRaw(Prisma.sql`UPDATE ${table} SET [action] = ${'tampered'} WHERE [business_id] = ${id}`);
    }), 'Trigger failure rejects the surrounding transaction');
    assert.ok(bothWritesCompleted, 'Business and audit writes completed before the trigger error');
    expectTriggerError(failure);
    const rows = await expectRows(id, { business: 0, audit: 0 });
    return { error: safeError(failure), rows, recovery: await committedPair('after_trigger') };
  });

  await probe('repeated-failures-do-not-exhaust-small-pool', async result => {
    const rounds = [];
    result.evidence = { rounds, poolMaximum: 2, intendedFailures: 6 };
    for (let index = 0; index < 6; index++) {
      const id = businessId(`failure_${index}`);
      let reachedAudit = false;
      const failure = await expectFailure(() => prisma.$transaction(async tx => {
        await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
        reachedAudit = true;
        await insertAudit(tx, id, 'invalid-json');
      }), 'Repeated audit failure rejects');
      assert.ok(reachedAudit, 'Each repeated failure reaches the intended audit constraint');
      expectCheckError(failure);
      rounds.push({ error: safeError(failure), rollback: await expectRows(id, { business: 0, audit: 0 }), recovery: await committedPair(`recovery_${index}`) });
    }
    return { rounds, poolMaximum: 2, failureCount: 6 };
  });

  await probe('transaction-timeout-rolls-back-and-connection-recovers', async () => {
    const id = businessId('timeout');
    let bothWritesCompleted = false;
    const failure = await expectFailure(() => prisma.$transaction(async tx => {
      await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
      await insertAudit(tx, id, '{}');
      bothWritesCompleted = true;
      await delay(2500);
      await tx.$queryRaw`SELECT 1 AS [still_open]`;
    }, { maxWait: 10_000, timeout: 2_000 }), 'Expired transaction rejects');
    assert.ok(bothWritesCompleted, 'Both writes completed before the intentional timeout delay');
    assert.equal(failure.code, 'P2028', 'Prisma reports the expired transaction rather than an unrelated SQL error');
    return { error: safeError(failure), rows: await expectRows(id, { business: 0, audit: 0 }), recovery: await committedPair('after_timeout') };
  });
}

try {
  await main();
} catch (error) {
  // Fatal setup steps already have a named failure in the report.
  if (!report.probes.some(result => result.status === 'failed')) report.fatalError = safeError(error);
} finally {
  if (prisma) {
    try {
      if (tableCreated) await prisma.$executeRawUnsafe(`DROP TABLE [dbo].[${tableName}]`);
      if (businessIds.size) await prisma.probeBusiness.deleteMany({ where: { id: { in: [...businessIds] } } });
      report.cleanup = { status: 'passed', scope: 'Only the unique audit table and this run’s business IDs' };
    } catch (error) {
      report.cleanup = { status: 'failed', error: safeError(error) };
    }
    try { await prisma.$disconnect(); } catch (error) { report.disconnectError = safeError(error); }
  } else {
    report.cleanup = { status: 'not-needed' };
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.probes.some(result => result.status === 'failed') || report.fatalError || report.cleanup.status === 'failed' || report.disconnectError ? 'failed' : 'passed';
  await saveReport();
  console.log(`Preflight ${report.status}; report: ${reportPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
