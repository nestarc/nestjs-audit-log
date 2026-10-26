import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runId = randomUUID().replaceAll('-', '');
const reportPath = resolve(process.env.MSSQL_REPORT_PATH ?? join(fixtureDirectory, 'results/library-report.json'));
const customSchema = `audit_${runId.slice(0, 16)}`;
const incompatibleTable = `bad_${runId.slice(0, 16)}`;
const tenantContext = new AsyncLocalStorage();
const defaultActor = { id: 'library-actor', type: 'user', ip: '127.0.0.1' };
const businessIds = new Set();
const ownedTables = new Set();
const modules = [];
const report = {
  scope: 'Installed @nestarc/audit-log manual AuditService and SQL Server DDL integration',
  runId,
  startedAt: new Date().toISOString(),
  environment: { node: process.version, clientPlatform: process.platform, clientArchitecture: process.arch },
  probes: [],
  cleanup: { status: 'not-started' },
};
let library;
let Test;
let prisma;
let prismaFactory;
let Prisma;
let config;
let service;
let txOnlyService;
let schemaCreated = false;
let forbiddenIo = 0;
const readTableName = `dbo.reads_${runId.slice(0, 16)}`;
const readTenant = `read_${runId}`;
let readService;
let expectedReadOrder;
const longReadCases = [];
const forbiddenClient = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string' || !property.startsWith('$')) return undefined;
    return () => { forbiddenIo += 1; throw new Error('Unexpected base-client database access'); };
  },
});

// Never serialize raw Prisma errors, parameters, connection strings, or payloads.
function safeError(error) {
  const result = { name: String(error?.name ?? 'Error').slice(0, 80) };
  const errorClass = error?.constructor?.name;
  if (typeof errorClass === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(errorClass)) result.errorClass = errorClass;
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
  if (String(error?.code ?? '') === 'P2028') {
    // Classify only fixed phrases; never copy transaction messages or SQL.
    result.transactionReason = errorContains(error, 'Invalid isolation level')
      ? 'invalid-isolation-level'
      : errorContains(error, 'expired') || errorContains(error, 'timeout')
        ? 'expired-or-timeout'
        : errorContains(error, 'already closed')
          ? 'already-closed'
          : errorContains(error, 'not found') ? 'not-found' : 'unclassified';
  }
  return result;
}

// Read error text only to identify deliberate failures; never include it in evidence.
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

async function saveReport() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function probe(name, operation, fatal = false) {
  const started = performance.now();
  const result = { name, status: 'running' };
  report.probes.push(result);
  try {
    await saveReport();
    result.evidence = await operation(result);
    result.status = 'passed';
    console.log(`PASS ${name}`);
  } catch (error) {
    Object.assign(result, { status: 'failed', error: safeError(error) });
    console.log(`FAIL ${name} ${JSON.stringify(result.error)}`);
    if (fatal) throw error;
  } finally {
    result.milliseconds = Math.round(performance.now() - started);
    await saveReport();
  }
}

async function packageInfo(name, resolver = require) {
  let entry;
  try { entry = resolver.resolve(`${name}/package.json`); } catch { entry = resolver.resolve(name); }
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const path = join(directory, 'package.json');
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      if (pkg.name === name) return { version: pkg.version, directory, resolver: createRequire(path) };
    } catch { /* Find the manifest above an exported entry point. */ }
    directory = dirname(directory);
  }
  throw new Error(`Package metadata not found: ${name}`);
}

function businessId(label) {
  const id = `${runId}_${label}`;
  assert.ok(id.length <= 80, 'Business ID fits the fixture schema');
  businessIds.add(id);
  return id;
}

function identifier(name) {
  assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, 'Fixture SQL identifier is allowlisted');
  return `[${name}]`;
}

function tableRef(tableName = 'dbo.audit_logs') {
  return Prisma.raw(tableName.split('.').map(identifier).join('.'));
}

function context(operation, { actor = defaultActor, tenant = 'tenant-default', metadata, reason } = {}) {
  return tenantContext.run(tenant, () => library.AuditContext.run({ actor, noAudit: false, metadata, reason }, operation));
}

function input(id, extra = {}) {
  return { action: 'Probe.changed', targetType: 'ProbeBusiness', targetId: id, ...extra };
}

async function expectFailure(operation, message) {
  let error;
  try { await operation(); } catch (failure) { error = failure; }
  assert.ok(error, message);
  return error;
}

async function auditRows(id, tableName = 'dbo.audit_logs') {
  return prisma.$queryRaw(Prisma.sql`SELECT * FROM ${tableRef(tableName)} WHERE [target_id] = ${id}`);
}

async function expectRows(id, expected, tableName = 'dbo.audit_logs') {
  const actual = {
    business: await prisma.probeBusiness.count({ where: { id } }),
    audit: (await auditRows(id, tableName)).length,
  };
  assert.deepEqual(actual, expected, 'Business and audit row counts match the transaction outcome');
  return actual;
}

async function committedPair(label, selectedService = txOnlyService, tableName = 'dbo.audit_logs', contextOptions) {
  const id = businessId(label);
  const sessions = await context(() => prisma.$transaction(async tx => {
    const [before] = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
    await tx.probeBusiness.create({ data: { id, marker: 'committed' } });
    await selectedService.log(input(id), tx);
    const [after] = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
    assert.equal(before.session_id, after.session_id, 'Business and audit work retain one SQL session');
    return { before: before.session_id, after: after.session_id };
  }), contextOptions);
  return { id, rows: await expectRows(id, { business: 1, audit: 1 }, tableName), sessions };
}

async function main() {
  await probe('packed-library-and-exact-server-tuple', async () => {
    for (const name of ['MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_DATABASE']) assert.ok(process.env[name], `${name} must be supplied`);
    assert.match(process.env.MSSQL_DATABASE, /^audit_preflight_[a-f0-9]{32}$/, 'Use only the runner-owned isolated database');
    const port = Number(process.env.MSSQL_PORT ?? '1433');
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'MSSQL_PORT is valid');
    const [cli, client, adapterPackage, packed, nest] = await Promise.all([
      packageInfo('prisma'), packageInfo('@prisma/client'), packageInfo('@prisma/adapter-mssql'),
      packageInfo('@nestarc/audit-log'), packageInfo('@nestjs/testing'),
    ]);
    const installedPath = await realpath(packed.directory);
    const dependencyRoot = await realpath(join(fixtureDirectory, 'node_modules'));
    const installedRelative = relative(dependencyRoot, installedPath);
    assert.ok(!installedRelative.startsWith('..') && !installedRelative.startsWith('/'), 'Library resolves to a packed fixture dependency, not the checkout');
    const mssql = await packageInfo('mssql', adapterPackage.resolver);
    const tedious = await packageInfo('tedious', mssql.resolver);
    const versions = { library: packed.version, prisma: cli.version, client: client.version, adapter: adapterPackage.version, mssql: mssql.version, tedious: tedious.version, nestTesting: nest.version };
    for (const name of ['prisma', 'client', 'adapter']) assert.equal(versions[name], '7.10.0', `${name} is pinned to 7.10.0`);
    await import('reflect-metadata');
    library = await import('@nestarc/audit-log');
    // tsx can create separate ESM/CJS Nest class identities. Match the installed
    // CommonJS library's Nest loading so Reflector remains the same DI token.
    ({ Test } = require('@nestjs/testing'));
    for (const name of ['AuditService', 'AuditLogModule', 'AuditContext', 'defineAuditConfig', 'getAuditTableStatements', 'getAuditTableSQL', 'applyAuditTableSchema', 'getSqlServerAuditReadIndexStatements', 'applySqlServerAuditReadIndexes', 'inspectSqlServerAuditStorage', 'AuditInputError', 'ensurePartitions', 'createAuditExtension']) {
      assert.equal(typeof library[name], 'function', `${name} is exported by the installed package`);
    }
    const generated = await import('./generated/client/client.ts');
    Prisma = generated.Prisma;
    assert.equal(Prisma.prismaVersion.client, '7.10.0', 'Generated client is Prisma 7.10.0');
    const { PrismaMssql } = await import('@prisma/adapter-mssql');
    prismaFactory = () => new generated.PrismaClient({
      adapter: new PrismaMssql({
        server: process.env.MSSQL_HOST ?? 'localhost', port,
        user: process.env.MSSQL_USER, password: process.env.MSSQL_PASSWORD, database: process.env.MSSQL_DATABASE,
        options: { encrypt: true, trustServerCertificate: true }, connectionTimeout: 15_000, requestTimeout: 5_000,
        pool: { min: 0, max: 2, idleTimeoutMillis: 5_000 },
      }, { schema: 'dbo' }),
      transactionOptions: { maxWait: 10_000, timeout: 10_000 },
    });
    prisma = prismaFactory();
    await prisma.$connect();
    const [server] = await prisma.$queryRaw`
      SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS NVARCHAR(10)) AS [major],
             CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(100)) AS [version],
             CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) AS [edition],
             CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS NVARCHAR(100)) AS [collation],
             DB_NAME() AS [database_name], @@VERSION AS [description], @@OPTIONS AS [session_options]
    `;
    assert.equal(server.major, '17', 'Server is SQL Server 2025');
    assert.equal(server.database_name, process.env.MSSQL_DATABASE, 'Connected to the dedicated fixture database');
    Object.assign(report.environment, { versions, server, installedLibrary: installedRelative, poolMaximum: 2, schema: 'dbo',
      imageReference: process.env.MSSQL_IMAGE_REFERENCE ?? null, imageDigest: process.env.MSSQL_IMAGE_DIGEST ?? null,
      declaredServerPlatform: process.env.MSSQL_SERVER_PLATFORM ?? null });
    return { versions, server, installedLibrary: installedRelative };
  }, true);

  await probe('shared-config-and-nest-for-root', async () => {
    config = library.defineAuditConfig({
      shared: {
        provider: 'sqlserver', prismaModule: { Prisma }, actorRequired: true, tenantRequired: true,
        tenantResolver: () => tenantContext.getStore() ?? null,
        sensitiveFields: ['password'], sensitiveFieldsByModel: { ProbeBusiness: ['secret'] },
        logger: { warn() {}, error() {} },
      },
      module: { actorExtractor: () => null, registerGlobalInterceptor: false },
    });
    assert.equal(config.moduleOptions.provider, 'sqlserver', 'Provider reaches the Nest module');
    assert.equal(config.schemaOptions.provider, 'sqlserver', 'Provider reaches DDL');
    assert.equal(config.partitionOptions.provider, 'sqlserver', 'Provider reaches partition guards');
    assert.equal(config.extensionOptions, undefined, 'Manual configuration does not create an automatic extension');
    const module = await Test.createTestingModule({ imports: [library.AuditLogModule.forRoot({ ...config.moduleOptions, prisma })] }).compile();
    modules.push(module);
    service = module.get(library.AuditService);
    assert.ok(service instanceof library.AuditService, 'Nest injects the public AuditService');
    txOnlyService = new library.AuditService({ ...config.moduleOptions, prisma: forbiddenClient });
    assert.equal(forbiddenIo, 0, 'Constructing services performs no database I/O');
    return { provider: config.moduleOptions.provider, serviceResolved: true };
  }, true);

  await probe('public-ddl-batches-and-repeat-install', async () => {
    const statements = library.getAuditTableStatements(config.schemaOptions);
    assert.ok(statements.length > 1, 'DDL exposes individual SQL Server batches');
    assert.ok(statements.every(statement => !/^\s*GO\s*$/mi.test(statement)), 'Prisma batches contain no GO separators');
    assert.equal(statements.filter(statement => /^CREATE OR ALTER TRIGGER /i.test(statement)).length, 2, 'Both triggers begin their own batch');
    assert.equal(library.getAuditTableSQL(config.schemaOptions), `:ON ERROR EXIT\n${statements.join('\nGO\n')}\nGO\n`, 'SQL script stops on failure and preserves SQL Server batch boundaries');
    ownedTables.add('dbo.audit_logs');
    await library.applyAuditTableSchema(prisma, config.schemaOptions);
    const id = businessId('ddl_preserved');
    await context(() => service.log(input(id)));
    const [before] = await auditRows(id);
    await prisma.$executeRawUnsafe('DISABLE TRIGGER [dbo].[audit_logs_no_update_trg] ON [dbo].[audit_logs]');
    await library.applyAuditTableSchema(prisma, config.schemaOptions);
    const [after] = await auditRows(id);
    assert.equal(after.id, before.id, 'Repeat installation preserves existing audit rows');
    assert.ok(after.created_at instanceof Date, 'UTC timestamp default is readable by Prisma');
    assert.match(after.id, /^[a-f0-9-]{36}$/i, 'ID default produces a UUID');
    const triggers = await prisma.$queryRaw`SELECT [is_disabled] FROM sys.triggers WHERE [parent_id] = OBJECT_ID(N'dbo.audit_logs')`;
    assert.equal(triggers.length, 2, 'Both append-only triggers exist');
    assert.ok(triggers.every(trigger => trigger.is_disabled === false || trigger.is_disabled === 0), 'Repeat installation enables both triggers');
    return { batches: statements.length, triggers: triggers.length, preservedId: after.id, rows: await expectRows(id, { business: 0, audit: 1 }) };
  }, true);

  await probe('incompatible-existing-table-is-rejected', async () => {
    ownedTables.add(`dbo.${incompatibleTable}`);
    await prisma.$executeRawUnsafe(`CREATE TABLE [dbo].${identifier(incompatibleTable)} ([id] INT NOT NULL); INSERT INTO [dbo].${identifier(incompatibleTable)} ([id]) VALUES (42)`);
    const failure = await expectFailure(() => library.applyAuditTableSchema(prisma, { provider: 'sqlserver', tableName: incompatibleTable }), 'Incompatible table rejects installation');
    assert.ok(errorContains(failure, 'Incompatible SQL Server audit table'), 'Error identifies incompatible audit layout');
    const rows = await prisma.$queryRaw(Prisma.sql`SELECT * FROM ${tableRef(`dbo.${incompatibleTable}`)}`);
    assert.deepEqual(rows, [{ id: 42 }], 'Rejected installation leaves existing data and columns intact');
    return { error: safeError(failure), existingRows: rows.length };
  });

  await probe('same-transaction-commit', async () => {
    const result = await committedPair('commit');
    assert.equal(forbiddenIo, 0, 'AuditService uses the supplied transaction without base-client fallback');
    return result;
  });

  await probe('business-failure-rolls-back-audit', async () => {
    const id = businessId('business_failure');
    const failure = await expectFailure(() => context(() => prisma.$transaction(async tx => {
      await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
      await txOnlyService.log(input(id), tx);
      await tx.probeBusiness.create({ data: { id, marker: 'duplicate-key' } });
    })), 'Business unique-key failure rejects the transaction');
    assert.equal(failure.code, 'P2002', 'Failure is the intended business unique-key violation');
    return { error: safeError(failure), rows: await expectRows(id, { business: 0, audit: 0 }), recovery: await committedPair('business_recovered') };
  });

  await probe('concurrent-commit-and-rollback-isolation', async () => {
    const ids = [businessId('concurrent_commit'), businessId('concurrent_rollback')];
    const rollback = new Error('Deliberate caller rollback');
    const sessions = [];
    let release;
    let arrivals = 0;
    const bothWritten = new Promise(resolveWritten => { release = resolveWritten; });
    const results = await Promise.allSettled(ids.map((id, index) => context(() => prisma.$transaction(async tx => {
      const [session] = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
      sessions[index] = session.session_id;
      await tx.probeBusiness.create({ data: { id, marker: 'concurrent' } });
      await txOnlyService.log(input(id), tx);
      if (++arrivals === 2) release();
      let timer;
      try {
        await Promise.race([bothWritten, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Concurrent transaction rendezvous timed out')), 5_000);
        })]);
      } finally { clearTimeout(timer); }
      if (index === 1) throw rollback;
    }), { actor: { id: `concurrent-actor-${index}`, type: 'user' }, tenant: `concurrent-tenant-${index}` })));
    assert.equal(results[0].status, 'fulfilled', 'Concurrent successful transaction commits');
    assert.equal(results[1].status, 'rejected', 'Concurrent failed transaction rolls back');
    assert.equal(results[1].reason, rollback, 'Caller rollback cause propagates unchanged');
    assert.notEqual(sessions[0], sessions[1], 'Both transactions hold separate SQL sessions concurrently');
    return { sessions, committed: await expectRows(ids[0], { business: 1, audit: 1 }), rolledBack: await expectRows(ids[1], { business: 0, audit: 0 }) };
  });

  await probe('audit-sql-failure-rolls-back-business-and-recovers-pool', async result => {
    const constraint = `ck_reject_${runId.slice(0, 16)}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE [dbo].[audit_logs] ADD CONSTRAINT ${identifier(constraint)} CHECK ([action] <> N'Probe.blocked')`);
    const attempts = [];
    result.evidence = { poolMaximum: 2, attempts };
    try {
      for (let index = 0; index < 6; index += 1) {
        const id = businessId(`audit_failure_${index}`);
        const failure = await expectFailure(() => context(() => prisma.$transaction(async tx => {
          await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
          await txOnlyService.log(input(id, { action: 'Probe.blocked' }), tx);
        })), 'Audit CHECK failure rejects the business transaction');
        assert.ok(errorContains(failure, constraint), 'Failure identifies the intended audit CHECK constraint');
        attempts.push({ error: safeError(failure), rows: await expectRows(id, { business: 0, audit: 0 }), recovery: await committedPair(`audit_recovered_${index}`) });
        await saveReport();
      }
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE [dbo].[audit_logs] DROP CONSTRAINT ${identifier(constraint)}`);
    }
    assert.equal(forbiddenIo, 0, 'Audit failures never use the base-client fallback');
    return { poolMaximum: 2, attempts };
  });

  await probe('required-context-and-serialization-failures-roll-back', async () => {
    const cases = [
      { label: 'actor_required', options: { actor: null }, marker: 'actorRequired' },
      { label: 'tenant_required', options: { tenant: null }, marker: 'tenant context required' },
      { label: 'metadata_serialization', extra: { metadata: { value: 1n } }, type: TypeError },
    ];
    const outcomes = [];
    for (const test of cases) {
      const id = businessId(test.label);
      const failure = await expectFailure(() => context(() => prisma.$transaction(async tx => {
        await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
        await txOnlyService.log(input(id, test.extra), tx);
      }), test.options), 'Manual validation failure escapes the caller transaction');
      if (test.marker) assert.ok(errorContains(failure, test.marker), 'Failure identifies the intended context policy');
      if (test.type) assert.ok(failure instanceof test.type, 'Invalid metadata fails JSON serialization');
      outcomes.push({ case: test.label, error: safeError(failure), rows: await expectRows(id, { business: 0, audit: 0 }) });
    }
    return outcomes;
  });

  await probe('metadata-redaction-reason-and-context-isolation', async () => {
    const id = businessId('metadata_context');
    await context(() => service.log(input(id, { metadata: {
      password: 'never-report-this', secret: 'never-report-this', shared: 'input', nested: { password: 'never-report-this' }, value: null,
    } })), { metadata: { correlationId: 'correlation-test', shared: 'context' }, reason: 'approved-test' });
    const [row] = await auditRows(id);
    assert.deepEqual(JSON.parse(row.metadata), {
      correlationId: 'correlation-test', shared: 'input', reason: 'approved-test', password: '[REDACTED]', secret: '[REDACTED]', nested: { password: '[REDACTED]' }, value: null,
    }, 'Context, reason, overrides and nested/global/model redaction are preserved');
    assert.equal(row.actor_id, defaultActor.id, 'Actor ID is retained');
    assert.equal(row.actor_type, defaultActor.type, 'Actor type is retained');
    assert.equal(row.actor_ip, defaultActor.ip, 'Actor IP is retained');
    assert.equal(row.tenant_id, 'tenant-default', 'Tenant is retained');
    assert.equal(row.source, 'manual', 'Source remains manual');
    assert.equal(row.result, 'success', 'Default result remains success');
    const concurrent = await Promise.all([0, 1].map(index => committedPair(`isolation_${index}`, service, 'dbo.audit_logs', {
      actor: { id: `actor-${index}`, type: 'api_key' }, tenant: `tenant-${index}`,
    })));
    for (let index = 0; index < concurrent.length; index += 1) {
      const [isolated] = await auditRows(concurrent[index].id);
      assert.equal(isolated.actor_id, `actor-${index}`, 'Concurrent actor contexts do not leak');
      assert.equal(isolated.tenant_id, `tenant-${index}`, 'Concurrent tenant contexts do not leak');
    }
    return { redactionVerified: true, concurrentTransactions: concurrent.length };
  });

  await probe('standalone-unicode-and-unbounded-text-roundtrip', async () => {
    const text = '한글😀'.repeat(16_384);
    const long = '긴문자😀'.repeat(1_200);
    const targetId = `${runId}_${long}`;
    const metadata = { text, nested: { value: null } };
    const expectedJson = JSON.stringify(metadata);
    assert.ok(expectedJson.length >= 65_536, 'Metadata exercises at least 65536 UTF-16 code units');
    await context(() => service.log({ action: long, targetId, targetType: long, metadata, result: 'failure' }), {
      actor: { id: long, type: 'system', ip: '::1' }, tenant: long,
    });
    const [row] = await auditRows(targetId);
    assert.equal(row.metadata, expectedJson, 'Long Unicode metadata roundtrips without truncation');
    for (const column of ['action', 'target_type', 'actor_id', 'tenant_id']) assert.equal(row[column], long, 'Text field exceeds fixed NVARCHAR limits without truncation');
    assert.equal(row.target_id, targetId, 'Long target ID roundtrips');
    assert.equal(row.result, 'failure', 'Explicit failure result is preserved');
    const [length] = await prisma.$queryRaw(Prisma.sql`SELECT DATALENGTH([metadata]) AS [bytes] FROM [dbo].[audit_logs] WHERE [id] = ${row.id}`);
    assert.equal(Number(length.bytes), expectedJson.length * 2, 'NVARCHAR stores the exact UTF-16 payload');
    const nullId = businessId('null_metadata');
    await context(() => service.log(input(nullId, { metadata: {} })));
    assert.equal((await auditRows(nullId))[0].metadata, null, 'Empty merged metadata remains SQL NULL');
    return { metadataUtf16CodeUnits: expectedJson.length, metadataBytes: Number(length.bytes), textFieldCodeUnits: long.length, standaloneRows: 2 };
  });

  await probe('custom-schema-quoted-name-and-nest-for-root-async', async () => {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA ${identifier(customSchema)}`);
    schemaCreated = true;
    const tableName = `${customSchema}.select`;
    const { actorExtractor, registerGlobalInterceptor, ...shared } = config.moduleOptions;
    const customConfig = library.defineAuditConfig({
      shared: { ...shared, tableName }, module: { actorExtractor, registerGlobalInterceptor },
    });
    assert.equal(customConfig.moduleOptions.tableName, tableName, 'Custom table reaches module configuration');
    ownedTables.add(tableName);
    await library.applyAuditTableSchema(prisma, customConfig.schemaOptions);
    let factoryCalls = 0;
    const module = await Test.createTestingModule({ imports: [library.AuditLogModule.forRootAsync({ useFactory: async () => {
      factoryCalls += 1;
      return { ...customConfig.moduleOptions, prisma, actorExtractor: () => null, registerGlobalInterceptor: false };
    } })] }).compile();
    modules.push(module);
    const result = await committedPair('custom_schema', module.get(library.AuditService), tableName);
    assert.equal(factoryCalls, 1, 'Nest asynchronous factory resolves once');
    assert.equal((await auditRows(result.id)).length, 0, 'Custom writes use their configured schema and quoted reserved table name');
    await library.applyAuditTableSchema(prisma, customConfig.schemaOptions);
    await expectRows(result.id, { business: 1, audit: 1 }, tableName);
    return { tableName, factoryCalls, ...result };
  });

  await probe('append-only-triggers-block-multi-row-mutations', async () => {
    const ids = [businessId('append_one'), businessId('append_two')];
    for (const id of ids) await context(() => service.log(input(id)));
    const failures = [];
    for (const statement of [
      Prisma.sql`UPDATE [dbo].[audit_logs] SET [action] = N'changed' WHERE [target_id] IN (${ids[0]}, ${ids[1]})`,
      Prisma.sql`DELETE FROM [dbo].[audit_logs] WHERE [target_id] IN (${ids[0]}, ${ids[1]})`,
    ]) {
      const failure = await expectFailure(() => prisma.$executeRaw(statement), 'Append-only trigger rejects matching mutation');
      assert.ok(safeError(failure).codes?.includes('51001') || errorContains(failure, 'blocked on append-only audit table'), 'Failure comes from the append-only trigger');
      failures.push(safeError(failure));
      for (const id of ids) {
        const rows = await auditRows(id);
        assert.equal(rows.length, 1, 'Rejected mutation preserves each audit row');
        assert.equal(rows[0].action, 'Probe.changed', 'Rejected update preserves original values');
      }
    }
    await prisma.$executeRaw`UPDATE [dbo].[audit_logs] SET [action] = N'no-match' WHERE 1 = 0`;
    await prisma.$executeRaw`DELETE FROM [dbo].[audit_logs] WHERE 1 = 0`;
    return { failures, preservedRows: ids.length, zeroRowMutationsAllowed: true };
  });

  await probe('interactive-timeout-rolls-back-and-recovers', async () => {
    const id = businessId('timeout');
    let auditWriteCompleted = false;
    const failure = await expectFailure(() => context(() => prisma.$transaction(async tx => {
      await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
      await txOnlyService.log(input(id), tx);
      auditWriteCompleted = true;
      await delay(2_500);
      await tx.$queryRaw`SELECT 1 AS [expired]`;
    }, { maxWait: 10_000, timeout: 1_000 })), 'Expired transaction rejects after AuditService writes');
    assert.ok(auditWriteCompleted, 'Timeout occurred after the real AuditService INSERT completed');
    assert.equal(failure.code, 'P2028', 'Failure identifies interactive transaction expiration');
    return { error: safeError(failure), auditWriteCompleted, rows: await expectRows(id, { business: 0, audit: 0 }), recovery: await committedPair('timeout_recovered') };
  });

  await probe('managed-helper-commit-snapshots-input-and-forwards-read-committed', async probeResult => {
    probeResult.evidence = { stage: 'prepare-managed-transaction' };
    const id = businessId('managed_commit');
    const events = [];
    const managed = new library.AuditService({ ...config.moduleOptions, prisma: forbiddenClient,
      onAuditOperation: event => { events.push(event); return Promise.reject(new Error('Deliberate diagnostic rejection')); } });
    const actor = { id: 'managed-original-actor', type: 'user' };
    let retained;
    probeResult.evidence.stage = 'start-managed-read-committed-transaction';
    const result = await context(() => managed.withManualTransaction(prisma, async ({ tx, log }) => {
      probeResult.evidence.stage = 'read-transaction-session';
      const [session] = await tx.$queryRaw`SELECT @@SPID AS [session_id], [transaction_isolation_level] AS [isolation_level] FROM sys.dm_exec_sessions WHERE [session_id] = @@SPID`;
      assert.equal(session.isolation_level, 2, 'Requested ReadCommitted isolation reaches the real SQL Server transaction');
      await tx.probeBusiness.create({ data: { id, marker: 'managed' } });
      const event = input(id, { action: 'Managed.original', metadata: { value: 'original' } });
      const pending = log(event);
      event.action = 'Managed.mutated';
      event.metadata.value = 'mutated';
      actor.id = 'managed-mutated-actor';
      probeResult.evidence.stage = 'await-audit-insert';
      await pending;
      retained = log;
      const [after] = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
      assert.equal(after.session_id, session.session_id, 'Managed business and audit work use the same session');
      assert.ok(!events.some(event => event.operation === 'transaction'), 'Transaction completion is observed after the host completes');
      return { session: session.session_id, isolation: session.isolation_level };
    }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 10_000 }), { actor, tenant: 'managed-original-tenant' });
    probeResult.evidence.stage = 'verify-committed-rows';
    const [row] = await auditRows(id);
    assert.equal(row.action, 'Managed.original', 'Action is captured when the bound writer is called');
    assert.equal(row.actor_id, 'managed-original-actor', 'Actor identity is captured when the bound writer is called');
    assert.deepEqual(JSON.parse(row.metadata), { value: 'original' }, 'Metadata is serialized before later input mutation');
    assert.equal(row.tenant_id, 'managed-original-tenant');
    const expired = await expectFailure(() => retained(input(id, { action: 'Expired.writer' })), 'Escaped writer cannot write after commit');
    assert.ok(errorContains(expired, 'scope has ended'));
    await delay(0);
    assert.ok(events.some(event => event.operation === 'transaction' && event.status === 'success' && event.transaction === 'managed'));
    assert.ok(events.every(event => Object.isFrozen(event) && Number.isFinite(event.durationMs) && event.durationMs >= 0));
    assert.ok(!JSON.stringify(events).includes(id), 'Operation telemetry contains no event identifiers');
    assert.equal(forbiddenIo, 0, 'The managed writer never falls back to the configured base client');
    return { ...result, requestedIsolation: 'ReadCommitted', rows: await expectRows(id, { business: 1, audit: 1 }), expiredWriterRejected: true, diagnosticRejectionIsolated: true };
  });

  await probe('pinned-prisma-snapshot-isolation-rejection-has-no-side-effects', async probeResult => {
    probeResult.evidence = { stage: 'enable-server-snapshot-isolation' };
    await prisma.$executeRawUnsafe(`ALTER DATABASE ${identifier(process.env.MSSQL_DATABASE)} SET ALLOW_SNAPSHOT_ISOLATION ON`);
    const [database] = await prisma.$queryRaw`SELECT [snapshot_isolation_state] AS [state] FROM sys.databases WHERE [name] = DB_NAME()`;
    assert.equal(database.state, 1, 'The disposable database enables Snapshot independently of Prisma host support');
    const id = businessId('unsupported_snapshot');
    let callbackCalls = 0;
    const events = [];
    const managed = new library.AuditService({ ...config.moduleOptions, prisma: forbiddenClient,
      onAuditOperation: event => { events.push(event); } });
    probeResult.evidence.stage = 'request-snapshot-from-pinned-prisma-host';
    const failure = await expectFailure(() => context(() => managed.withManualTransaction(prisma, async ({ tx, log }) => {
      callbackCalls += 1;
      await tx.probeBusiness.create({ data: { id, marker: 'must-not-run' } });
      await log(input(id));
    }, { isolationLevel: 'Snapshot', maxWait: 10_000, timeout: 10_000 })), 'Pinned Prisma 7.10 rejects Snapshot before invoking the callback');
    assert.equal(failure.code, 'P2028');
    const classified = safeError(failure);
    assert.equal(classified.transactionReason, 'invalid-isolation-level');
    assert.ok(errorContains(failure, 'SNAPSHOT'), 'The host rejection identifies the requested Snapshot isolation');
    assert.equal(callbackCalls, 0, 'An unsupported host option does not invoke business or audit work');
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, 'transaction');
    assert.equal(events[0].status, 'failure');
    assert.equal(forbiddenIo, 0);
    return { requestedIsolation: 'Snapshot', hostSupportsRequestedIsolation: false, prismaVersion: '7.10.0', serverSnapshotEnabled: true,
      callbackCalls, error: classified, rows: await expectRows(id, { business: 0, audit: 0 }), recovery: await committedPair('snapshot_rejection_recovery') };
  });

  await probe('managed-helper-caught-policy-serialization-and-sql-errors-roll-back', async () => {
    const constraint = `ck_managed_${runId.slice(0, 16)}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE [dbo].[audit_logs] ADD CONSTRAINT ${identifier(constraint)} CHECK ([action] <> N'Managed.blocked')`);
    const outcomes = [];
    try {
      for (const kind of ['actor', 'tenant', 'serialization', 'sql']) {
        const id = businessId(`managed_${kind}`);
        const observed = [];
        const managed = new library.AuditService({ ...config.moduleOptions, prisma: forbiddenClient,
          onAuditError: (error, details) => { observed.push({ error, details }); return Promise.reject(new Error('Deliberate diagnostic rejection')); } });
        let caught;
        const failure = await expectFailure(() => context(() => managed.withManualTransaction(prisma, async ({ tx, log }) => {
          await tx.probeBusiness.create({ data: { id, marker: 'must-rollback' } });
          await log(input(id));
          try {
            if (kind === 'actor') await library.AuditContext.run({ actor: null, noAudit: false }, () => log(input(id)));
            else if (kind === 'tenant') await tenantContext.run(null, () => log(input(id)));
            else if (kind === 'serialization') await log(input(id, { metadata: { bigint: 1n } }));
            else await log(input(id, { action: 'Managed.blocked' }));
          } catch (error) { caught = error; }
          assert.ok(caught, 'The application deliberately catches the audit failure');
        })), 'Caught audit failure still prevents managed commit');
        assert.equal(failure, caught, 'Managed completion rejects with the original audit error');
        if (kind === 'sql') assert.ok(errorContains(failure, constraint), 'SQL failure is the intended audit constraint');
        assert.equal(observed.length, 1, 'Each failed manual call reports exactly once');
        assert.equal(observed[0].error, failure, 'Error observer receives the original error');
        assert.equal(observed[0].details.provider, 'sqlserver');
        outcomes.push({ kind, error: safeError(failure), phase: observed[0].details.phase, rows: await expectRows(id, { business: 0, audit: 0 }) });
      }
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE [dbo].[audit_logs] DROP CONSTRAINT ${identifier(constraint)}`);
    }
    await delay(0);
    return { outcomes, recovery: await committedPair('managed_error_recovery') };
  });

  await probe('managed-helper-concurrent-context-and-rollback-isolation', async () => {
    const ids = [businessId('managed_concurrent_ok'), businessId('managed_concurrent_bad')];
    const sessions = [];
    let release;
    let arrivals = 0;
    const bothWritten = new Promise(resolve => { release = resolve; });
    const results = await Promise.allSettled(ids.map((id, index) => context(() => txOnlyService.withManualTransaction(prisma, async ({ tx, log }) => {
      const [session] = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
      sessions[index] = session.session_id;
      await tx.probeBusiness.create({ data: { id, marker: 'managed-concurrent' } });
      await log(input(id));
      if (++arrivals === 2) release();
      let timer;
      try {
        await Promise.race([bothWritten, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Managed rendezvous timed out')), 5_000);
        })]);
      } finally { clearTimeout(timer); }
      if (index === 1) {
        const caught = await expectFailure(() => library.AuditContext.run({ actor: null, noAudit: false }, () => log(input(id))), 'Second helper catches a policy error');
        assert.ok(errorContains(caught, 'actorRequired'));
      }
    }), { actor: { id: `managed-actor-${index}`, type: 'user' }, tenant: `managed-tenant-${index}` })));
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.notEqual(sessions[0], sessions[1], 'Managed helpers concurrently own different SQL sessions');
    const [row] = await auditRows(ids[0]);
    assert.equal(row.actor_id, 'managed-actor-0');
    assert.equal(row.tenant_id, 'managed-tenant-0');
    return { sessions, committed: await expectRows(ids[0], { business: 1, audit: 1 }), rolledBack: await expectRows(ids[1], { business: 0, audit: 0 }) };
  });

  await probe('strict-manual-input-size-budget-and-provider-capabilities', async () => {
    const strict = new library.AuditService({ ...config.moduleOptions, prisma: forbiddenClient, strictManualValidation: true, maxMetadataBytes: 64 });
    const capabilities = strict.getCapabilities();
    assert.ok(Object.isFrozen(capabilities));
    assert.equal(capabilities.provider, 'sqlserver');
    for (const name of ['manualLogging', 'manualTransactions', 'query', 'schemaInspection', 'readIndexes']) assert.equal(capabilities[name], true);
    for (const name of ['automaticTracking', 'scan', 'exportCsv', 'retention']) assert.equal(capabilities[name], false);
    const outcomes = [];
    const invalids = [
      { label: 'blank_action', value: { action: ' ' }, code: 'AUDIT_INPUT_INVALID' },
      { label: 'blank_target', value: { targetId: '' }, code: 'AUDIT_INPUT_INVALID' },
      { label: 'invalid_result', value: { result: 'unknown' }, code: 'AUDIT_INPUT_INVALID' },
      { label: 'nonfinite_metadata', value: { metadata: { number: NaN } }, code: 'AUDIT_INPUT_INVALID' },
      { label: 'metadata_budget', value: { metadata: { text: '한글'.repeat(20) } }, code: 'AUDIT_METADATA_TOO_LARGE' },
    ];
    for (const invalid of invalids) {
      const id = businessId(`strict_${invalid.label}`);
      let caught;
      const failure = await expectFailure(() => context(() => strict.withManualTransaction(prisma, async ({ tx, log }) => {
        await tx.probeBusiness.create({ data: { id, marker: 'strict-invalid' } });
        try { await log(input(id, invalid.value)); } catch (error) { caught = error; }
      })), 'Caught strict validation still rolls back business writes');
      assert.equal(failure, caught);
      assert.ok(failure instanceof library.AuditInputError);
      assert.equal(failure.code, invalid.code);
      outcomes.push({ case: invalid.label, code: failure.code, rows: await expectRows(id, { business: 0, audit: 0 }) });
    }
    const validId = businessId('strict_valid');
    await context(() => strict.withManualTransaction(prisma, async ({ tx, log }) => {
      await tx.probeBusiness.create({ data: { id: validId, marker: 'strict-valid' } });
      await log(input(validId, { metadata: { text: '한글', password: 'secret' } }));
    }));
    assert.deepEqual(JSON.parse((await auditRows(validId))[0].metadata), { text: '한글', password: '[REDACTED]' });
    return { capabilities, invalid: outcomes, valid: await expectRows(validId, { business: 1, audit: 1 }) };
  });

  await probe('sqlserver-history-tenant-isolation-precision-guid-order-and-wildcards', async () => {
    ownedTables.add(readTableName);
    await library.applyAuditTableSchema(prisma, { provider: 'sqlserver', tableName: readTableName });
    readService = new library.AuditService({ ...config.moduleOptions, prisma, tableName: readTableName });
    const literalAction = 'History.[ok]_%\\written';
    const seeded = [
      { id: '00000000-0000-0000-0000-000000000002', ts: '2026-10-26T12:34:56.1234567', action: literalAction },
      { id: 'ffffffff-0000-0000-0000-000000000001', ts: '2026-10-26T12:34:56.1234567', action: 'History.other' },
      { id: 'ffffffff-ffff-ffff-ffff-000000000000', ts: '2026-10-26T12:34:56.1234567', action: 'History.okAother' },
      { id: randomUUID(), ts: '2026-10-26T12:34:56.1234566', action: 'History.other' },
      { id: randomUUID(), ts: '2026-10-26T12:34:56.1234565', action: 'History.other' },
      { id: randomUUID(), ts: '2026-10-26T12:34:56.1234564', action: 'History.other' },
    ];
    for (let index = 0; index < seeded.length; index++) {
      const entry = seeded[index];
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO ${tableRef(readTableName)}
          ([id], [tenant_id], [actor_id], [actor_type], [action], [target_type], [target_id], [source], [changes], [metadata], [result], [created_at])
        VALUES (CAST(${entry.id} AS UNIQUEIDENTIFIER), ${readTenant}, ${'read-actor'}, ${'api_key'}, ${entry.action}, ${'ReadTarget'}, ${`${runId}_read_${index}`}, ${'manual'}, ${JSON.stringify({ value: { before: null, after: '한글😀' } })}, ${JSON.stringify({ label: '한글😀', index })}, ${'success'}, CAST(${entry.ts} AS DATETIME2(7)))
      `);
    }
    const native = await prisma.$queryRaw(Prisma.sql`
      SELECT CONVERT(VARCHAR(36), history.[id]) AS [id] FROM ${tableRef(readTableName)} AS history
      WHERE history.[tenant_id] = ${readTenant} ORDER BY history.[created_at] DESC, history.[id] DESC
    `);
    expectedReadOrder = native.map(row => row.id.toLowerCase());
    assert.deepEqual(expectedReadOrder.slice(0, 3), seeded.slice(0, 3).map(row => row.id), 'Fixture exercises SQL Server GUID order, including lexical disagreement');
    assert.notDeepEqual(expectedReadOrder.slice(0, 3), seeded.slice(0, 3).map(row => row.id).sort().reverse());
    const collected = [];
    let cursor;
    const cursors = [];
    for (let pageIndex = 0; pageIndex < seeded.length; pageIndex++) {
      const page = await readService.query({ tenantId: readTenant, limit: 1, ...(cursor ? { cursor, includeTotal: false } : {}) });
      assert.equal(page.entries.length, 1, 'Every precision-sensitive page contains exactly one row');
      if (pageIndex === 0) assert.equal(page.total, seeded.length);
      else assert.equal(page.total, undefined, 'includeTotal false omits a total');
      const entry = page.entries[0];
      assert.ok(entry.createdAt instanceof Date);
      assert.deepEqual(entry.changes, { value: { before: null, after: '한글😀' } });
      assert.equal(entry.metadata.label, '한글😀');
      assert.equal(entry.tenantId, readTenant);
      collected.push(entry);
      if (page.hasMore) {
        assert.ok(page.nextCursor);
        const decoded = Buffer.from(page.nextCursor, 'base64url').toString('utf8');
        assert.match(decoded, /^mssql1\|2026-10-26T12:34:56\.\d{7}Z\|/);
        cursors.push(decoded);
      } else assert.equal(page.nextCursor, null);
      cursor = page.nextCursor;
    }
    assert.deepEqual(collected.map(row => row.id), expectedReadOrder, 'All rows appear once across same-timestamp GUID ties and sub-millisecond boundaries');
    assert.equal(new Set(collected.map(row => row.createdAt.getTime())).size, 1, 'All timestamps share a JS millisecond, so Date-only cursors would fail');
    assert.ok(cursors.some(cursor => cursor.includes('.1234567Z')) && cursors.some(cursor => cursor.includes('.1234566Z')));
    const offsetPage = await readService.query({ tenantId: readTenant, offset: 2, limit: 2 });
    assert.deepEqual(offsetPage.entries.map(row => row.id), expectedReadOrder.slice(2, 4));
    const filtered = await readService.query({ tenantId: readTenant, actorId: 'read-actor', actorType: 'api_key', targetType: 'ReadTarget', source: 'manual', result: 'success', from: new Date('2026-10-26T12:34:56.123Z'), to: new Date('2026-10-26T12:34:56.124Z') });
    assert.equal(filtered.total, seeded.length);
    const wildcard = await readService.query({ tenantId: readTenant, action: 'History.[ok]_%\\*' });
    assert.deepEqual(wildcard.entries.map(row => row.action), [literalAction], 'Only star is wildcard; brackets, percent, underscore and backslash stay literal');
    const upperId = expectedReadOrder[0].toUpperCase();
    assert.equal((await readService.getById(upperId, { tenantId: readTenant })).id, expectedReadOrder[0]);
    assert.equal(await readService.getById(upperId, { tenantId: `${readTenant}_other` }), null);
    assert.equal(await readService.getById('invalid-uuid', { tenantId: readTenant }), null);
    await assert.rejects(readService.query({}), /tenant context required/);
    for (const tenant of [readTenant.toUpperCase(), `${readTenant} `]) {
      const targetId = `${runId}_tenant_variant_${longReadCases.length}`;
      await context(() => readService.log(input(targetId)), { tenant });
      const result = await readService.query({ tenantId: tenant });
      assert.equal(result.total, 1, 'Tenant case and trailing-space variants remain distinct');
      assert.equal(result.entries[0].tenantId, tenant);
      assert.equal(await readService.getById(expectedReadOrder[0], { tenantId: tenant }), null);
      longReadCases.push({ tenantId: tenant, targetId, expected: 1 });
    }
    const shared = '공통😀'.repeat(1_200);
    const longTenant = `${shared}_tenant`;
    for (const suffix of ['A', 'B']) {
      const actorId = `${shared}_actor_${suffix}`;
      const targetType = `${shared}_type_${suffix}`;
      const targetId = `${shared}_target_${suffix}`;
      await context(() => readService.log({ action: 'History.long', targetType, targetId, metadata: { suffix } }), { tenant: longTenant, actor: { id: actorId, type: 'user' } });
      longReadCases.push({ tenantId: longTenant, actorId, targetType, targetId, expected: 1 });
    }
    for (const suffix of ['æ', 'ae']) {
      const tenantId = `${'a'.repeat(127)}${suffix}`;
      const targetId = `${runId}_ligature_${suffix}`;
      await context(() => readService.log(input(targetId)), { tenant: tenantId });
      longReadCases.push({ tenantId, targetId, expected: 1 });
    }
    for (const { expected, ...query } of longReadCases) {
      const page = await readService.query(query);
      assert.equal(page.total, expected, 'Exact full values remain distinct despite shared or linguistic-equivalent prefixes');
      assert.equal(page.entries[0].targetId, query.targetId);
    }
    assert.equal((await readService.query({ tenantId: readTenant })).total, seeded.length, 'Other tenant data never enters the original history');
    return { pages: collected.length, fullPrecisionCursors: cursors.length, sqlServerGuidOrderVerified: true, wildcardLiteralVerified: true, exactLongValueQueries: longReadCases.length };
  });

  await probe('sqlserver-read-indexes-inspection-and-fresh-writer-compatibility', async () => {
    const options = { tableName: readTableName };
    const baseline = await library.inspectSqlServerAuditStorage(prisma, options);
    assert.equal(baseline.status, 'inspected');
    assert.equal(baseline.metadataComplete, true);
    assert.equal(baseline.enforcementVerified, false, 'Catalog inspection does not claim runtime trigger enforcement');
    assert.deepEqual(baseline.issues, [], 'Fresh compatible schema has no catalog issues');
    const before = await readService.query({ tenantId: readTenant });
    const statements = library.getSqlServerAuditReadIndexStatements(options);
    assert.ok(statements.length >= 4);
    await library.applySqlServerAuditReadIndexes(prisma, options);
    await library.applySqlServerAuditReadIndexes(prisma, options);
    const inspected = await library.inspectSqlServerAuditStorage(prisma, options);
    assert.equal(inspected.status, 'inspected');
    assert.deepEqual(inspected.issues, []);
    assert.equal(inspected.indexes.filter(index => index.name.includes('_read_')).length, 3);
    assert.equal(inspected.columns.filter(column => column.name.startsWith('__audit_') && column.computed).length, 4);
    assert.deepEqual((await readService.query({ tenantId: readTenant })).entries, before.entries, 'Index installation and reapplication preserve rows and ordering');
    for (const { expected, ...query } of longReadCases) {
      const page = await readService.query(query);
      assert.equal(page.total, expected, 'Index installation preserves full-value and tenant exact matching');
      assert.equal(page.entries[0].targetId, query.targetId);
    }
    const fresh = prismaFactory();
    const freshService = new library.AuditService({ ...config.moduleOptions, prisma: fresh, tableName: readTableName });
    const id = businessId('indexed_fresh_writer');
    try {
      await fresh.$connect();
      await context(() => freshService.withManualTransaction(fresh, async ({ tx, log }) => {
        await tx.probeBusiness.create({ data: { id, marker: 'after-indexes' } });
        await log(input(id));
      }));
      await context(() => freshService.log(input(`${id}_standalone`)));
      assert.equal((await freshService.query({ tenantId: 'tenant-default', targetId: id })).total, 1, 'A fresh pool can write and read indexed audit storage');
    } finally { await fresh.$disconnect(); }
    const table = readTableName.split('.')[1];
    await prisma.$executeRawUnsafe(`DISABLE TRIGGER [dbo].${identifier(`${table}_no_update_trg`)} ON ${readTableName.split('.').map(identifier).join('.')}`);
    const disabled = await library.inspectSqlServerAuditStorage(prisma, options);
    assert.ok(disabled.issues.some(issue => issue.code === 'TRIGGER_DISABLED'));
    await library.applyAuditTableSchema(prisma, { provider: 'sqlserver', ...options });
    const restored = await library.inspectSqlServerAuditStorage(prisma, options);
    assert.deepEqual(restored.issues, [], 'DDL reapplication restores trigger enforcement while preserving read indexes');
    return { batches: statements.length, readIndexes: 3, prefixColumns: 4, freshPoolWrite: await expectRows(id, { business: 1, audit: 1 }, readTableName), triggerDiagnosticVerified: true };
  });

  await probe('unsupported-features-reject-before-database-io', async () => {
    const unsupported = new library.AuditService({ ...config.moduleOptions, prisma: forbiddenClient });
    const operations = {
      scan: async () => { for await (const page of unsupported.scan({ tenantId: 'tenant-default' })) void page; },
      exportCsv: async () => { for await (const chunk of unsupported.exportCsv({ tenantId: 'tenant-default' })) void chunk; },
      prune: () => unsupported.prune({ olderThan: new Date() }),
      ensurePartitions: () => library.ensurePartitions(forbiddenClient, config.partitionOptions),
      createAuditExtension: () => library.createAuditExtension({ provider: 'sqlserver', consistency: 'best-effort', prismaModule: { Prisma } }),
    };
    const rejected = [];
    for (const [operation, execute] of Object.entries(operations)) {
      const failure = await expectFailure(execute, `${operation} rejects unsupported SQL Server usage`);
      assert.ok(errorContains(failure, 'sqlserver'), 'Unsupported error identifies the selected provider');
      rejected.push(operation);
    }
    for (const options of [{ partitioned: true }, { ginIndex: true }, { enforcement: 'rule' }]) {
      const failure = await expectFailure(() => library.applyAuditTableSchema(forbiddenClient, { provider: 'sqlserver', ...options }), 'Unsupported DDL option rejects before I/O');
      assert.ok(errorContains(failure, 'SQL Server'), 'DDL rejection identifies SQL Server');
    }
    assert.equal(forbiddenIo, 0, 'Unsupported APIs and explicit transaction writes never access the trap base client');
    return { rejected, unsupportedDdlOptions: 3, forbiddenDatabaseCalls: forbiddenIo };
  });
}

try {
  await main();
} catch (error) {
  report.fatalError = safeError(error);
} finally {
  report.cleanup.status = 'running';
  const failures = [];
  for (const module of modules.reverse()) {
    try { await module.close(); } catch (error) { failures.push(safeError(error)); }
  }
  if (prisma) {
    for (const tableName of [...ownedTables].reverse()) {
      try { await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${tableName.split('.').map(identifier).join('.')}`); } catch (error) { failures.push(safeError(error)); }
    }
    if (schemaCreated) {
      try { await prisma.$executeRawUnsafe(`DROP SCHEMA ${identifier(customSchema)}`); } catch (error) { failures.push(safeError(error)); }
    }
    try { await prisma.probeBusiness.deleteMany({ where: { id: { in: [...businessIds] } } }); } catch (error) { failures.push(safeError(error)); }
    try { await prisma.$disconnect(); } catch (error) { failures.push(safeError(error)); }
  }
  report.cleanup = { status: failures.length ? 'failed' : 'passed', failures, dedicatedDatabaseDrop: 'owned by run.mjs' };
  report.finishedAt = new Date().toISOString();
  report.status = report.fatalError || failures.length || report.probes.some(result => result.status !== 'passed') ? 'failed' : 'passed';
  await saveReport();
  console.log(`Library integration ${report.status}: ${report.probes.filter(result => result.status === 'passed').length}/${report.probes.length} probes passed`);
  if (report.status !== 'passed') process.exitCode = 1;
}
