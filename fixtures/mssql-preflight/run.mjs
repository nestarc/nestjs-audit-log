import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const database = `audit_preflight_${randomUUID().replaceAll('-', '')}`;
const probe = process.env.MSSQL_PROBE || 'probe.mjs';
const probeReportPath = path.resolve(
  fixtureRoot,
  process.env.MSSQL_REPORT_PATH || 'results/report.json',
);
const runnerReportPath = path.join(path.dirname(probeReportPath), 'runner-report.json');
const report = {
  schemaVersion: 1,
  kind: 'sqlserver-prisma-preflight-runner',
  startedAt: new Date().toISOString(),
  status: 'running',
  client: { platform: process.platform, architecture: process.arch, node: process.version },
  database,
  probe,
  steps: [],
  cleanup: { status: 'not-created' },
};

let bootstrap;
let createdDatabase = false;
let secrets = [];

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function safeError(error) {
  const safeToken = value => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value)
    ? value : undefined;
  return {
    name: safeToken(error?.name) || 'Error',
    code: safeToken(error?.code),
    number: Number.isInteger(error?.number) ? error.number : undefined,
  };
}

function readConfiguration() {
  const password = process.env.MSSQL_PASSWORD;
  if (!password) throw failure('MSSQL_PASSWORD_REQUIRED');
  const user = process.env.MSSQL_USER || 'sa';
  const server = process.env.MSSQL_HOST || '127.0.0.1';
  const port = Number(process.env.MSSQL_PORT || 1433);
  // The Prisma 7.10 connection-string parser does not support nested braces.
  if ([password, user].some(value => /[{}\x00-\x1f\x7f]/.test(value))) {
    throw failure('MSSQL_CREDENTIAL_BRACES_OR_CONTROL_CHARACTERS_UNSUPPORTED');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(server)) throw failure('MSSQL_HOST_INVALID');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('MSSQL_PORT_INVALID');
  return {
    server,
    port,
    user,
    password,
    database: 'master',
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    pool: { min: 0, max: 1, idleTimeoutMillis: 1_000 },
    options: { encrypt: true, trustServerCertificate: true },
  };
}

function redactOutput(output) {
  let text = output || '';
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  return text;
}

async function step(name, operation) {
  const started = performance.now();
  const item = { name, status: 'running' };
  report.steps.push(item);
  try {
    const result = await operation();
    item.status = 'passed';
    return result;
  } catch (error) {
    item.status = 'failed';
    item.error = safeError(error);
    throw error;
  } finally {
    item.durationMs = Math.round(performance.now() - started);
  }
}

function runChild(args, environment, timeout) {
  const result = spawnSync(process.execPath, args, {
    cwd: fixtureRoot,
    env: environment,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGTERM',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(redactOutput(result.stdout));
  if (result.stderr) process.stderr.write(redactOutput(result.stderr));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw failure(result.signal ? `CHILD_${result.signal}` : `CHILD_EXIT_${result.status}`);
  }
}

async function connectWhenReady(configuration) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const candidate = new sql.ConnectionPool({
      ...configuration,
      connectionTimeout: Math.min(15_000, remaining),
      requestTimeout: configuration.requestTimeout,
    });
    candidate.on('error', () => {});
    let timer;
    try {
      await Promise.race([
        candidate.connect().then(() => candidate.request().query('SELECT 1 AS ready')),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('MSSQL_READINESS_TIMEOUT')), remaining);
        }),
      ]);
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.close().catch(() => {});
    } finally {
      clearTimeout(timer);
    }
    const pause = Math.min(1_000, deadline - Date.now());
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
  }
  throw lastError || failure('MSSQL_READINESS_TIMEOUT');
}

async function verifyPackages() {
  const versions = {};
  report.packages = versions;
  for (const name of ['prisma', '@prisma/client', '@prisma/adapter-mssql', 'mssql']) {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'node_modules', name, 'package.json'), 'utf8'));
    versions[name] = manifest.version;
    if (name !== 'mssql' && manifest.version !== '7.10.0') {
      throw failure('PRISMA_VERSION_MISMATCH');
    }
  }
}

try {
  await mkdir(path.dirname(probeReportPath), { recursive: true });
  // A setup failure must never leave a previous run's successful probe as evidence.
  await rm(probeReportPath, { force: true });
  if (!['probe.mjs', 'library-probe.mjs', 'manual-benchmark.mjs'].includes(probe)) throw failure('MSSQL_PROBE_INVALID');
  const configuration = readConfiguration();
  const databaseUrl = `sqlserver://${configuration.server}:${configuration.port};database=${database};schema=dbo;user={${configuration.user}};password={${configuration.password}};encrypt=true;trustServerCertificate=true`;
  secrets = [configuration.password, encodeURIComponent(configuration.password), databaseUrl];
  const environment = {
    ...process.env,
    MSSQL_HOST: configuration.server,
    MSSQL_PORT: String(configuration.port),
    MSSQL_USER: configuration.user,
    MSSQL_DATABASE: database,
    MSSQL_REPORT_PATH: probeReportPath,
    DATABASE_URL: databaseUrl,
  };
  const prismaCli = path.join(fixtureRoot, 'node_modules/prisma/build/index.js');
  await step('verify-exact-prisma-packages', verifyPackages);
  await step('generate-client', () => runChild(
    [prismaCli, 'generate', '--config', 'prisma.config.ts'], environment, 60_000,
  ));
  bootstrap = await step('server-readiness', () => connectWhenReady(configuration));
  await step('verify-sqlserver-2025', async () => {
    const result = await bootstrap.request().query(`
      SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS productVersion,
             CONVERT(nvarchar(128), SERVERPROPERTY('ProductMajorVersion')) AS majorVersion,
             CONVERT(nvarchar(128), SERVERPROPERTY('Edition')) AS edition;
    `);
    report.server = result.recordset[0];
    if (report.server.majorVersion !== '17') throw failure('SQLSERVER_MAJOR_VERSION_MUST_BE_17');
  });
  await step('create-dedicated-database', async () => {
    assert.match(database, /^audit_preflight_[a-f0-9]{32}$/);
    await bootstrap.request().query(`CREATE DATABASE [${database}]`);
    createdDatabase = true;
    report.cleanup.status = 'pending';
  });
  await step('push-business-schema', () => runChild(
    [prismaCli, 'db', 'push', '--config', 'prisma.config.ts'], environment, 120_000,
  ));
  await step('run-real-database-probes', () => runChild(
    ['--import', 'tsx', probe], environment, probe === 'manual-benchmark.mjs' ? 600_000 : 180_000,
  ));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error);
  console.error(`[mssql-preflight] runner failed: ${JSON.stringify(report.error)}`);
} finally {
  if (createdDatabase && bootstrap) {
    try {
      assert.match(database, /^audit_preflight_[a-f0-9]{32}$/);
      // This identifier is generated above, never supplied by the caller.
      await bootstrap.request().query(`ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
      await bootstrap.request().query(`DROP DATABASE [${database}]`);
      report.cleanup.status = 'passed';
    } catch (error) {
      report.status = 'failed';
      report.cleanup = { status: 'failed', error: safeError(error) };
    }
  }
  if (bootstrap) {
    try {
      await bootstrap.close();
    } catch (error) {
      report.status = 'failed';
      report.bootstrapCloseError = safeError(error);
    }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(runnerReportPath), { recursive: true });
  await writeFile(runnerReportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[mssql-preflight] runner ${report.status}; report: ${path.relative(fixtureRoot, runnerReportPath)}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
