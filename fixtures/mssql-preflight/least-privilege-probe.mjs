import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runId = randomUUID().replaceAll('-', '');
const databaseToken = /^audit_preflight_([a-f0-9]{32})$/.exec(process.env.MSSQL_DATABASE ?? '')?.[1];
const prefix = `audit_lp_${runId}`;
const schema = `${prefix}_schema`;
const tableName = `${schema}.audit_logs`;
const deniedTableName = `${schema}.denied_install`;
const reportPath = resolve(process.env.MSSQL_REPORT_PATH ?? join(directory, 'results/least-privilege/report.json'));
const principals = ['installer', 'runtime'].map(role => ({
  role, name: `audit_lp_${role}_${databaseToken ?? runId}`, sid: randomBytes(16).toString('hex'),
  password: `Aa1!${randomBytes(24).toString('hex')}`,
  loginAttempted: false, loginCreated: false, userCreated: false,
}));
const [installerPrincipal, runtimePrincipal] = principals;
// The runner buffers child output. GitHub processes these commands before subsequent output.
// Outside GitHub Actions, passwords are never written to stdout or the report.
if (process.env.GITHUB_ACTIONS === 'true') {
  for (const principal of principals) console.log(`::add-mask::${principal.password}`);
}
const report = {
  schemaVersion: 1, kind: 'sqlserver-packed-least-privilege-smoke', status: 'running', runId,
  startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  identities: principals.map(({ role, name }) => ({ role, login: name, user: name })),
  scope: {
    auditTable: tableName,
    installer: 'CONNECT and CREATE TABLE in the disposable database; ALTER on the dbo-owned audit schema; no elevated role membership',
    runtime: 'CONNECT; business table INSERT and SELECT for Prisma create/OUTPUT; audit table INSERT only; no elevated role membership',
    limits: 'Scoped deployment grants and one insert-only application identity, not a general least-privilege or hostile schema-owner security proof. The runner removes remaining generated logins after child failure; terminating the runner itself before cleanup can leave them on a local test server. The CI container is disposable.',
  },
  probes: [], cleanup: { status: 'not-started' },
};
let library;
let Prisma;
let PrismaClient;
let PrismaMssql;
let admin;
let installer;
let runtime;
let txService;
let standaloneService;
let connection;
let schemaCreated = false;
let forbiddenIo = 0;
const businessIds = new Set();
const actor = { id: `${prefix}_actor`, type: 'system', ip: '127.0.0.1' };
const tenantId = `${prefix}_tenant`;
const forbiddenClient = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string' || !property.startsWith('$')) return undefined;
    return () => { forbiddenIo += 1; throw new Error('Unexpected AuditService base-client access'); };
  },
});

function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
}

// Deliberately omit messages, SQL, parameters, credentials and arbitrary Prisma metadata.
function safeError(error) {
  const codes = new Set();
  const seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) return;
    seen.add(value);
    for (const key of ['code', 'number', 'originalCode', 'kind']) {
      const token = safeToken(String(value[key] ?? ''));
      if (token) codes.add(token);
    }
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else for (const key of ['cause', 'meta', 'driverAdapterError', 'originalError', 'info', 'errors', 'precedingErrors']) visit(value[key], depth + 1);
  }
  visit(error);
  return { name: safeToken(error?.name) ?? 'Error', errorClass: safeToken(error?.constructor?.name), codes: [...codes] };
}

function errorContains(error, expected) {
  const seen = new Set();
  function visit(value, depth = 0) {
    if (typeof value === 'string') return value.includes(expected);
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) return false;
    seen.add(value);
    return Object.getOwnPropertyNames(value).some(key => visit(value[key], depth + 1));
  }
  return visit(error);
}

function identifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Generated SQL identifier is allowlisted');
  return `[${value}]`;
}

function literal(value) {
  assert.match(value, /^[A-Za-z0-9_!]{1,128}$/, 'Generated SQL literal is allowlisted');
  return `N'${value.replaceAll("'", "''")}'`;
}

function tableRef(name = tableName) {
  return Prisma.raw(name.split('.').map(identifier).join('.'));
}

async function saveReport() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function probe(name, operation) {
  const result = { name, status: 'running' };
  report.probes.push(result);
  const started = performance.now();
  try {
    await saveReport();
    result.evidence = await operation(result);
    result.status = 'passed';
    console.log(`PASS ${name}`);
  } catch (error) {
    result.status = 'failed';
    result.error = safeError(error);
    throw error;
  } finally {
    result.durationMs = Math.round(performance.now() - started);
    await saveReport();
  }
}

async function packageInfo(name, resolver = require) {
  let entry;
  try { entry = resolver.resolve(`${name}/package.json`); } catch { entry = resolver.resolve(name); }
  let current = dirname(entry);
  while (current !== dirname(current)) {
    try {
      const path = join(current, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (manifest.name === name) return { version: manifest.version, directory: current, resolver: createRequire(path) };
    } catch { /* Find the manifest above an exported entry point. */ }
    current = dirname(current);
  }
  throw new Error('Required package manifest unavailable');
}

function newClient(user, password, poolMaximum = 1) {
  return new PrismaClient({
    adapter: new PrismaMssql({ ...connection, user, password,
      pool: { min: 0, max: poolMaximum, idleTimeoutMillis: 1_000 },
    }, { schema: 'dbo' }),
    transactionOptions: { maxWait: 10_000, timeout: 10_000 },
    log: [],
  });
}

async function identity(client, principal) {
  const [row] = await client.$queryRaw`
    SELECT ORIGINAL_LOGIN() AS [original_login], SUSER_SNAME() AS [login_name], USER_NAME() AS [user_name], DB_NAME() AS [database_name],
      IS_SRVROLEMEMBER(N'sysadmin') AS [sysadmin], IS_SRVROLEMEMBER(N'securityadmin') AS [securityadmin],
      IS_SRVROLEMEMBER(N'serveradmin') AS [serveradmin], IS_SRVROLEMEMBER(N'dbcreator') AS [dbcreator],
      IS_SRVROLEMEMBER(N'processadmin') AS [processadmin], IS_SRVROLEMEMBER(N'setupadmin') AS [setupadmin],
      IS_SRVROLEMEMBER(N'diskadmin') AS [diskadmin], IS_SRVROLEMEMBER(N'bulkadmin') AS [bulkadmin],
      IS_MEMBER(N'db_owner') AS [db_owner], IS_MEMBER(N'db_ddladmin') AS [db_ddladmin],
      IS_MEMBER(N'db_securityadmin') AS [db_securityadmin], IS_MEMBER(N'db_accessadmin') AS [db_accessadmin],
      IS_MEMBER(N'db_datareader') AS [db_datareader], IS_MEMBER(N'db_datawriter') AS [db_datawriter],
      IS_MEMBER(N'db_backupoperator') AS [db_backupoperator],
      HAS_PERMS_BY_NAME(NULL, NULL, N'CONTROL SERVER') AS [control_server],
      HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CONTROL') AS [control_database],
      HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'ALTER ANY SCHEMA') AS [alter_any_schema],
      HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CREATE TABLE') AS [create_table]
  `;
  assert.equal(row.original_login, principal.name, 'Connection authenticates as the intended SQL login');
  assert.equal(row.login_name, principal.name, 'Effective login has no impersonation');
  assert.equal(row.user_name, principal.name, 'Connection uses the mapped database user, not dbo');
  assert.equal(row.database_name, connection.database, 'Principal is connected to the runner-owned database');
  for (const [key, value] of Object.entries(row)) {
    if (['original_login', 'login_name', 'user_name', 'database_name', 'create_table'].includes(key)) continue;
    assert.equal(value, 0, 'No administrative roles or broad effective privileges, including no NULL permission result');
  }
  assert.equal(row.create_table, principal.role === 'installer' ? 1 : 0, 'CREATE TABLE is scoped to the installer');
  const [schemaPermissions] = await client.$queryRaw`
    SELECT HAS_PERMS_BY_NAME(${schema}, N'SCHEMA', N'ALTER') AS [alter_schema],
           HAS_PERMS_BY_NAME(${schema}, N'SCHEMA', N'CONTROL') AS [control_schema]
  `;
  assert.equal(schemaPermissions.alter_schema, principal.role === 'installer' ? 1 : 0, 'Only installer can alter the dedicated schema');
  assert.equal(schemaPermissions.control_schema, 0, 'Neither principal owns or controls the schema');
  return { ...row, ...schemaPermissions };
}

async function auditState() {
  const [object] = await admin.$queryRaw`SELECT OBJECT_ID(${tableName}, N'U') AS [object_id]`;
  assert.ok(Number.isInteger(object.object_id), 'Administrator confirms the audit table exists');
  const columns = await admin.$queryRaw`SELECT [name] FROM sys.columns WHERE [object_id] = ${object.object_id} ORDER BY [column_id]`;
  const triggers = await admin.$queryRaw`SELECT [name], [is_disabled] FROM sys.triggers WHERE [parent_id] = ${object.object_id} ORDER BY [name]`;
  assert.equal(triggers.length, 2, 'Both audit mutation triggers exist');
  assert.ok(triggers.every(trigger => !trigger.is_disabled), 'Both audit mutation triggers are enabled');
  const rows = await admin.$queryRaw(Prisma.sql`SELECT [id], [target_id], [action], [metadata] FROM ${tableRef()} ORDER BY [id]`);
  return { objectId: object.object_id, columns, triggers, rows };
}

async function expectRows(id, business, audit) {
  const businessRows = await admin.probeBusiness.count({ where: { id } });
  const auditRows = await admin.$queryRaw(Prisma.sql`SELECT [id], [target_id], [actor_id], [tenant_id], [source] FROM ${tableRef()} WHERE [target_id] = ${id}`);
  assert.equal(businessRows, business, 'Administrator verifies the business transaction outcome');
  assert.equal(auditRows.length, audit, 'Administrator verifies the audit transaction outcome');
  for (const row of auditRows) {
    assert.equal(row.target_id, id);
    assert.equal(row.actor_id, actor.id);
    assert.equal(row.tenant_id, tenantId);
    assert.equal(row.source, 'manual');
  }
  return { businessRows, auditRows: auditRows.length };
}

function event(id, action = 'Privilege.changed') {
  return { action, targetType: 'ProbeBusiness', targetId: id, metadata: { checked: true } };
}

function businessId(label) {
  const id = `${runId}_${label}`;
  assert.ok(id.length <= 80, 'Business identifier fits the fixture schema');
  businessIds.add(id);
  return id;
}

async function pair(label, { rollback, blocked = false } = {}) {
  const id = businessId(label);
  const sessions = [];
  const operation = library.AuditContext.runAs(actor, () => runtime.$transaction(async tx => {
    const [before] = await tx.$queryRaw`SELECT @@SPID AS [session_id], ORIGINAL_LOGIN() AS [login_name], USER_NAME() AS [user_name]`;
    assert.equal(before.login_name, runtimePrincipal.name, 'Transaction authenticates as runtime, not bootstrap');
    assert.equal(before.user_name, runtimePrincipal.name, 'Transaction runs as runtime, not dbo');
    sessions.push(before.session_id);
    await tx.probeBusiness.create({ data: { id, marker: 'least-privilege' }, select: { id: true } });
    await txService.log(event(id, blocked ? 'Privilege.blocked' : undefined), tx);
    const [after] = await tx.$queryRaw`SELECT @@SPID AS [session_id]`;
    sessions.push(after.session_id);
    assert.equal(after.session_id, before.session_id, 'Business and audit writes retain the runtime transaction session');
    if (rollback) throw rollback;
  }));
  let error;
  try { await operation; } catch (failure) { error = failure; }
  if (rollback) assert.equal(error, rollback, 'Explicit caller rollback propagates unchanged');
  else if (blocked) {
    assert.ok(error, 'Deliberate audit CHECK failure rejects the runtime transaction');
    const codes = safeError(error).codes;
    // Adapter 7.10 maps SQL Server 547 to ForeignKeyConstraintViolation, including CHECK errors.
    assert.ok(codes.includes('547') || (codes.includes('P2010') && codes.includes('EREQUEST') && codes.includes('ForeignKeyConstraintViolation')), 'Audit failure is a SQL Server constraint violation');
    assert.ok(errorContains(error, `${prefix}_reject_action`), 'Failure identifies the intended audit constraint');
  } else if (error) throw error;
  assert.equal(forbiddenIo, 0, 'AuditService never accesses its forbidden base client');
  return { sessions, outcome: rollback || blocked ? 'rolled-back' : 'committed', error: error ? safeError(error) : undefined,
    rows: await expectRows(id, rollback || blocked ? 0 : 1, rollback || blocked ? 0 : 1) };
}

async function permissionDenied(operation, allowedCodes) {
  let error;
  try { await operation(); } catch (failure) { error = failure; }
  assert.ok(error, 'Operation must be denied by SQL Server permissions');
  const safe = safeError(error);
  assert.ok(!safe.codes.includes('51001'), 'Trigger enforcement is not evidence of a permission denial');
  assert.ok(allowedCodes.some(code => safe.codes.includes(String(code))), 'Failure has an expected SQL Server permission-denial code');
  return safe;
}

async function main() {
  await probe('packed-library-and-exact-server-tuple', async () => {
    for (const name of ['MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_DATABASE']) assert.ok(process.env[name], 'Runner supplies database configuration');
    assert.match(process.env.MSSQL_DATABASE, /^audit_preflight_[a-f0-9]{32}$/, 'Use only a runner-created disposable database');
    const port = Number(process.env.MSSQL_PORT ?? 1433);
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Server port is valid');
    const [cli, client, adapter, packed] = await Promise.all(['prisma', '@prisma/client', '@prisma/adapter-mssql', '@nestarc/audit-log'].map(name => packageInfo(name)));
    for (const item of [cli, client, adapter]) assert.equal(item.version, '7.10.0', 'Prisma CLI/client/adapter are pinned to 7.10.0');
    const installedRelative = relative(await realpath(join(directory, 'node_modules')), await realpath(packed.directory));
    assert.ok(!installedRelative.startsWith('..') && !installedRelative.startsWith('/'), 'Use the installed package, not a linked source checkout');
    const mssql = await packageInfo('mssql', adapter.resolver);
    const tedious = await packageInfo('tedious', mssql.resolver);
    await import('reflect-metadata');
    library = await import('@nestarc/audit-log');
    ({ Prisma, PrismaClient } = await import('./generated/client/client.ts'));
    ({ PrismaMssql } = await import('@prisma/adapter-mssql'));
    assert.equal(Prisma.prismaVersion.client, '7.10.0');
    connection = { server: process.env.MSSQL_HOST ?? '127.0.0.1', port, database: process.env.MSSQL_DATABASE,
      connectionTimeout: 15_000, requestTimeout: 10_000, options: { encrypt: true, trustServerCertificate: true } };
    admin = newClient(process.env.MSSQL_USER, process.env.MSSQL_PASSWORD);
    await admin.$connect();
    const [server] = await admin.$queryRaw`
      SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS NVARCHAR(10)) AS [major],
        CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(100)) AS [version],
        CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) AS [edition], DB_NAME() AS [database_name]
    `;
    assert.equal(server.major, '17', 'Server is SQL Server 2025');
    assert.equal(server.database_name, connection.database, 'Bootstrap is connected to the runner-owned database');
    Object.assign(report.environment, { server, packages: { library: packed.version, prisma: cli.version, client: client.version, adapter: adapter.version, mssql: mssql.version, tedious: tedious.version },
      installedLibrary: installedRelative, imageReference: process.env.MSSQL_IMAGE_REFERENCE ?? null, imageDigest: process.env.MSSQL_IMAGE_DIGEST ?? null });
    return report.environment;
  });

  await probe('create-distinct-scoped-principals', async () => {
    const [existingSchema] = await admin.$queryRaw`SELECT SCHEMA_ID(${schema}) AS [schema_id]`;
    assert.equal(existingSchema.schema_id, null, 'Do not replace an existing schema');
    for (const principal of principals) {
      const [existing] = await admin.$queryRaw`SELECT SUSER_ID(${principal.name}) AS [login_id], DATABASE_PRINCIPAL_ID(${principal.name}) AS [user_id]`;
      assert.equal(existing.login_id, null, 'Do not replace an existing login');
      assert.equal(existing.user_id, null, 'Do not replace an existing user');
      assert.match(principal.sid, /^[a-f0-9]{32}$/);
      principal.loginAttempted = true;
      await admin.$executeRawUnsafe(`CREATE LOGIN ${identifier(principal.name)} WITH PASSWORD = ${literal(principal.password)}, SID = 0x${principal.sid}, CHECK_POLICY = ON, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = ${identifier(connection.database)}`);
      principal.loginCreated = true;
      await admin.$executeRawUnsafe(`CREATE USER ${identifier(principal.name)} FOR LOGIN ${identifier(principal.name)} WITH DEFAULT_SCHEMA = [dbo]`);
      principal.userCreated = true;
      await admin.$executeRawUnsafe(`GRANT CONNECT TO ${identifier(principal.name)}`);
    }
    await admin.$executeRawUnsafe(`CREATE SCHEMA ${identifier(schema)} AUTHORIZATION [dbo]`);
    schemaCreated = true;
    await admin.$executeRawUnsafe(`GRANT CREATE TABLE TO ${identifier(installerPrincipal.name)}`);
    await admin.$executeRawUnsafe(`GRANT ALTER ON SCHEMA::${identifier(schema)} TO ${identifier(installerPrincipal.name)}`);
    const [owner] = await admin.$queryRaw`SELECT USER_NAME([principal_id]) AS [owner] FROM sys.schemas WHERE [name] = ${schema}`;
    assert.equal(owner.owner, 'dbo', 'Installer and runtime do not own the schema');
    installer = newClient(installerPrincipal.name, installerPrincipal.password);
    runtime = newClient(runtimePrincipal.name, runtimePrincipal.password, 2);
    await installer.$connect();
    return { schemaOwner: owner.owner, database: connection.database, installer: installerPrincipal.name, runtime: runtimePrincipal.name };
  });

  await probe('scoped-installer-creates-audit-table', async () => {
    const privileges = await identity(installer, installerPrincipal);
    await library.applyAuditTableSchema(installer, { provider: 'sqlserver', tableName });
    const state = await auditState();
    await admin.$executeRawUnsafe(`GRANT INSERT, SELECT ON OBJECT::[dbo].[probe_business] TO ${identifier(runtimePrincipal.name)}`);
    await admin.$executeRawUnsafe(`GRANT INSERT ON OBJECT::${identifier(schema)}.[audit_logs] TO ${identifier(runtimePrincipal.name)}`);
    await runtime.$connect();
    const options = { provider: 'sqlserver', tableName, prismaModule: { Prisma }, actorExtractor: () => null,
      actorRequired: true, tenantRequired: true, tenantResolver: () => tenantId, logger: { warn() {}, error() {} } };
    txService = new library.AuditService({ ...options, prisma: forbiddenClient });
    standaloneService = new library.AuditService({ ...options, prisma: runtime });
    return { privileges, auditRows: state.rows.length, triggers: state.triggers };
  });

  await probe('runtime-has-only-declared-data-permissions', async () => {
    const privileges = await identity(runtime, runtimePrincipal);
    const [effective] = await runtime.$queryRaw`
      SELECT HAS_PERMS_BY_NAME(${tableName}, N'OBJECT', N'INSERT') AS [audit_insert],
        HAS_PERMS_BY_NAME(${tableName}, N'OBJECT', N'SELECT') AS [audit_select],
        HAS_PERMS_BY_NAME(${tableName}, N'OBJECT', N'UPDATE') AS [audit_update],
        HAS_PERMS_BY_NAME(${tableName}, N'OBJECT', N'DELETE') AS [audit_delete],
        HAS_PERMS_BY_NAME(${tableName}, N'OBJECT', N'ALTER') AS [audit_alter],
        HAS_PERMS_BY_NAME(${tableName}, N'OBJECT', N'CONTROL') AS [audit_control],
        HAS_PERMS_BY_NAME(N'dbo.probe_business', N'OBJECT', N'INSERT') AS [business_insert],
        HAS_PERMS_BY_NAME(N'dbo.probe_business', N'OBJECT', N'SELECT') AS [business_select],
        HAS_PERMS_BY_NAME(N'dbo.probe_business', N'OBJECT', N'UPDATE') AS [business_update],
        HAS_PERMS_BY_NAME(N'dbo.probe_business', N'OBJECT', N'DELETE') AS [business_delete],
        HAS_PERMS_BY_NAME(N'dbo.probe_business', N'OBJECT', N'ALTER') AS [business_alter]
    `;
    for (const [permission, value] of Object.entries(effective)) {
      assert.equal(value, ['audit_insert', 'business_insert', 'business_select'].includes(permission) ? 1 : 0, 'Effective data permissions exactly match the fixture grants, with no NULL values');
    }
    return { privileges, effective };
  });

  await probe('runtime-transaction-commit-and-installer-reapply', async () => {
    const committed = await pair('commit');
    const before = await auditState();
    await admin.$executeRawUnsafe(`DISABLE TRIGGER ${identifier(schema)}.[audit_logs_no_update_trg] ON ${identifier(schema)}.[audit_logs]`);
    await library.applyAuditTableSchema(installer, { provider: 'sqlserver', tableName });
    assert.deepEqual(await auditState(), before, 'Scoped installer preserves rows and reenables triggers when reapplied');
    return { ...committed, reapplyPreservedRows: before.rows.length, triggersReenabled: true };
  });

  await probe('runtime-explicit-rollback-is-atomic', () => pair('caller_rollback', { rollback: new Error('Deliberate caller rollback') }));

  await probe('runtime-audit-error-rolls-back-and-recovers', async () => {
    const constraint = `${prefix}_reject_action`;
    await admin.$executeRawUnsafe(`ALTER TABLE ${identifier(schema)}.[audit_logs] ADD CONSTRAINT ${identifier(constraint)} CHECK ([action] <> N'Privilege.blocked')`);
    try { return { failed: await pair('audit_error', { blocked: true }), recovery: await pair('audit_recovered') }; }
    finally { await admin.$executeRawUnsafe(`ALTER TABLE ${identifier(schema)}.[audit_logs] DROP CONSTRAINT ${identifier(constraint)}`); }
  });

  await probe('runtime-audit-read-mutation-and-ddl-permissions-are-denied', async result => {
    const before = await auditState();
    const quoted = `${identifier(schema)}.[audit_logs]`;
    const cases = [
      ['SELECT', () => runtime.$queryRawUnsafe(`SELECT [id] FROM ${quoted}`), [229]],
      ['UPDATE', () => runtime.$executeRawUnsafe(`UPDATE ${quoted} SET [action] = N'tampered'`), [229]],
      ['DELETE', () => runtime.$executeRawUnsafe(`DELETE FROM ${quoted}`), [229]],
      ['TRUNCATE', () => runtime.$executeRawUnsafe(`TRUNCATE TABLE ${quoted}`), [229, 1088, 4701, 15151]],
      ['ALTER', () => runtime.$executeRawUnsafe(`ALTER TABLE ${quoted} ADD [unauthorized_column] INT NULL`), [229, 1088, 4902, 15151]],
      ['DROP', () => runtime.$executeRawUnsafe(`DROP TABLE ${quoted}`), [229, 3701, 15151]],
      ['DISABLE_TRIGGER', () => runtime.$executeRawUnsafe(`DISABLE TRIGGER ${identifier(schema)}.[audit_logs_no_update_trg] ON ${quoted}`), [229, 1088, 4902, 15151]],
    ];
    const attempts = [];
    result.evidence = { attempts };
    for (const [operation, execute, codes] of cases) {
      const error = await permissionDenied(execute, codes);
      assert.deepEqual(await auditState(), before, 'Administrator confirms existing object, rows, columns and enabled triggers are unchanged after permission denial');
      attempts.push({ operation, error, administratorVerifiedStateUnchanged: true });
      await saveReport();
    }
    return { attempts, preservedRows: before.rows.length };
  });

  await probe('runtime-cannot-install-a-new-audit-table', async () => {
    const before = await auditState();
    const [existing] = await admin.$queryRaw`SELECT OBJECT_ID(${deniedTableName}) AS [object_id]`;
    assert.equal(existing.object_id, null, 'Denied installer target starts absent');
    const error = await permissionDenied(() => library.applyAuditTableSchema(runtime, { provider: 'sqlserver', tableName: deniedTableName }), [229, 262, 2760]);
    const [after] = await admin.$queryRaw`SELECT OBJECT_ID(${deniedTableName}) AS [object_id]`;
    assert.equal(after.object_id, null, 'Runtime created no table before the expected permission denial');
    assert.deepEqual(await auditState(), before, 'Existing audit data and triggers remain intact');
    return { error, targetRemainsAbsent: true };
  });

  await probe('runtime-inserts-recover-after-denials-including-standalone-log', async () => {
    const recovery = await pair('permission_recovered');
    const id = businessId('standalone');
    await library.AuditContext.runAs(actor, () => standaloneService.log(event(id)));
    const standalone = await expectRows(id, 0, 1);
    assert.equal(forbiddenIo, 0, 'Transaction audit service never used the base client');
    return { recovery, standalone, forbiddenBaseClientCalls: forbiddenIo };
  });
  report.status = 'passed';
}

try {
  await main();
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error);
  console.error(`Least-privilege smoke failed: ${JSON.stringify(report.error)}`);
} finally {
  report.cleanup.status = 'running';
  const failures = [];
  const removed = { users: [], logins: [], schema: false };
  async function cleanupStep(name, operation) {
    try { await operation(); } catch (error) { failures.push({ step: name, error: safeError(error) }); }
  }
  // Release every low-privilege connection before removing database users and server logins.
  for (const [name, client] of [['runtime', runtime], ['installer', installer]]) {
    if (client) await cleanupStep(`disconnect-${name}`, () => client.$disconnect());
  }
  if (admin) {
    if (schemaCreated) {
      for (const name of [deniedTableName, tableName]) await cleanupStep('drop-owned-table', () => admin.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name.split('.').map(identifier).join('.')}`));
      await cleanupStep('drop-owned-schema', async () => {
        await admin.$executeRawUnsafe(`DROP SCHEMA ${identifier(schema)}`);
        removed.schema = true;
      });
    }
    if (businessIds.size) await cleanupStep('delete-owned-business-rows', () => admin.probeBusiness.deleteMany({ where: { id: { in: [...businessIds] } } }));
    for (const principal of principals) {
      if (!principal.loginAttempted) continue;
      // A generated SID also identifies a CREATE LOGIN whose client acknowledgement was lost.
      await cleanupStep(`remove-${principal.role}-identity`, async () => {
        const [owned] = await admin.$queryRaw`
          SELECT CONVERT(VARCHAR(64), SUSER_SID(${principal.name}), 2) AS [login_sid],
            (SELECT CONVERT(VARCHAR(64), [sid], 2) FROM sys.database_principals WHERE [name] = ${principal.name}) AS [user_sid]
        `;
        if (owned.user_sid !== null) {
          assert.equal(owned.user_sid.toLowerCase(), principal.sid, 'Only the mapped user created by this fixture may be removed');
          await admin.$executeRawUnsafe(`DROP USER ${identifier(principal.name)}`);
          removed.users.push(principal.name);
        }
        if (owned.login_sid !== null) {
          assert.equal(owned.login_sid.toLowerCase(), principal.sid, 'Only the SQL login created by this fixture may be removed');
          await admin.$executeRawUnsafe(`DROP LOGIN ${identifier(principal.name)}`);
          removed.logins.push(principal.name);
        }
        const [remaining] = await admin.$queryRaw`SELECT SUSER_ID(${principal.name}) AS [login_id], DATABASE_PRINCIPAL_ID(${principal.name}) AS [user_id]`;
        assert.equal(remaining.login_id, null, 'Generated login was removed');
        assert.equal(remaining.user_id, null, 'Generated database user was removed');
      });
    }
    await cleanupStep('disconnect-bootstrap', () => admin.$disconnect());
  }
  if (failures.length) report.status = 'failed';
  report.cleanup = { status: failures.length ? 'failed' : 'passed', failures, removed, databaseDrop: 'owned by run.mjs' };
  report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(`Least-privilege smoke ${report.status}: ${report.probes.filter(result => result.status === 'passed').length}/${report.probes.length} probes passed; cleanup ${report.cleanup.status}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
