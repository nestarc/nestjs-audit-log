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
let Prisma;
let config;
let service;
let txOnlyService;
let schemaCreated = false;
let forbiddenIo = 0;
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
    for (const name of ['AuditService', 'AuditLogModule', 'AuditContext', 'defineAuditConfig', 'getAuditTableStatements', 'getAuditTableSQL', 'applyAuditTableSchema', 'ensurePartitions', 'createAuditExtension']) {
      assert.equal(typeof library[name], 'function', `${name} is exported by the installed package`);
    }
    const generated = await import('./generated/client/client.ts');
    Prisma = generated.Prisma;
    assert.equal(Prisma.prismaVersion.client, '7.10.0', 'Generated client is Prisma 7.10.0');
    const { PrismaMssql } = await import('@prisma/adapter-mssql');
    prisma = new generated.PrismaClient({
      adapter: new PrismaMssql({
        server: process.env.MSSQL_HOST ?? 'localhost', port,
        user: process.env.MSSQL_USER, password: process.env.MSSQL_PASSWORD, database: process.env.MSSQL_DATABASE,
        options: { encrypt: true, trustServerCertificate: true }, connectionTimeout: 15_000, requestTimeout: 5_000,
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

  await probe('unsupported-features-reject-before-database-io', async () => {
    const unsupported = new library.AuditService({ ...config.moduleOptions, prisma: forbiddenClient });
    const operations = {
      query: () => unsupported.query({ tenantId: 'tenant-default' }),
      getById: () => unsupported.getById(randomUUID()),
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
