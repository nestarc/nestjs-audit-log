import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(process.env.MSSQL_REPORT_PATH ?? path.join(fixtureRoot, 'results/example/report.json'));
const registry = 'https://registry.npmjs.org';
const mode = process.env.MSSQL_EXAMPLE_MODE ?? 'candidate';
const report = {
  scope: 'Packed SQL Server Quick Start against a candidate or the exact registry artifact after publication',
  mode,
  startedAt: new Date().toISOString(), status: 'running',
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  steps: [], cleanup: { status: 'not-started', databaseDrop: 'owned by run.mjs' },
};
let workspace;
let consumer;
let targetVersion;
let candidateArtifact;

function safeError(error) {
  const token = value => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : undefined;
  return { name: token(error?.name) ?? 'Error', code: token(error?.code) };
}

function redact(output) {
  let text = output ?? '';
  for (const value of [process.env.DATABASE_URL, process.env.MSSQL_PASSWORD,
    process.env.MSSQL_PASSWORD && encodeURIComponent(process.env.MSSQL_PASSWORD),
    process.env.MSSQL_PASSWORD && JSON.stringify(process.env.MSSQL_PASSWORD).slice(1, -1)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(value, '[REDACTED]');
  }
  return text;
}

async function save() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function step(name, operation) {
  const result = { name, status: 'running' };
  report.steps.push(result);
  await save();
  const started = performance.now();
  try {
    result.evidence = await operation();
    result.status = 'passed';
    console.log(`PASS example ${name}`);
  } catch (error) {
    result.status = 'failed';
    result.error = safeError(error);
    throw error;
  } finally {
    result.durationMs = Math.round(performance.now() - started);
    await save();
  }
}

function npm(args, { database = false, quiet = false, cwd = consumer } = {}) {
  const environment = { ...process.env };
  if (!database) {
    delete environment.DATABASE_URL;
    delete environment.MSSQL_PASSWORD;
  }
  const command = process.env.npm_execpath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd, env: environment, encoding: 'utf8', timeout: 180_000,
    killSignal: 'SIGTERM', maxBuffer: 8 * 1024 * 1024,
  });
  if (!quiet || result.status !== 0 || result.error) {
    if (result.stdout) process.stdout.write(redact(result.stdout));
    if (result.stderr) process.stderr.write(redact(result.stderr));
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error('EXAMPLE_SUBPROCESS_FAILED'), { code: result.signal ? `CHILD_${result.signal}` : `CHILD_EXIT_${result.status}` });
  }
  return result.stdout;
}

try {
  await step('copy-example-from-packed-candidate', async () => {
    assert.ok(mode === 'candidate' || mode === 'registry', 'MSSQL_EXAMPLE_MODE must be candidate or registry');
    assert.match(process.env.MSSQL_DATABASE ?? '', /^audit_preflight_[a-f0-9]{32}$/, 'Use the runner-owned disposable database');
    assert.ok(process.env.DATABASE_URL && process.env.MSSQL_PASSWORD, 'The runner supplies the disposable connection');
    const requested = process.env.MSSQL_EXAMPLE_DIRECTORY;
    assert.ok(requested, 'The runner owns the temporary consumer directory');
    const resolved = await realpath(requested);
    assert.equal(path.dirname(resolved), await realpath(os.tmpdir()), 'The consumer workspace is a direct child of the system temporary directory');
    assert.match(path.basename(resolved), /^audit-mssql-example-[A-Za-z0-9]+$/, 'Only the runner-reserved example workspace is used');
    workspace = resolved;
    consumer = path.join(workspace, 'consumer');
    const installed = await realpath(path.join(fixtureRoot, 'node_modules/@nestarc/audit-log'));
    const dependencies = await realpath(path.join(fixtureRoot, 'node_modules'));
    assert.ok(installed.startsWith(`${dependencies}${path.sep}`), 'The candidate is an installed package, not a symlinked source checkout');
    const candidate = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(candidate.name, '@nestarc/audit-log');
    const example = path.join(installed, 'examples/sql-server-quick-start');
    await cp(example, consumer, { recursive: true, filter: source => {
      const segments = path.relative(example, source).split(path.sep);
      return !segments.some(segment => ['node_modules', 'dist', 'generated', '.env', 'package-lock.json'].includes(segment));
    } });
    const manifestPath = path.join(consumer, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    targetVersion = manifest.dependencies['@nestarc/audit-log'];
    assert.match(targetVersion, /^\d+\.\d+\.\d+$/, 'The packaged example pins an exact release target');
    assert.equal(targetVersion, candidate.version, 'The example targets the packed release version');
    for (const name of ['@prisma/client', '@prisma/adapter-mssql']) assert.equal(manifest.dependencies[name], '7.10.0');
    assert.equal(manifest.devDependencies.prisma, '7.10.0');
    const migrationLock = await readFile(path.join(consumer, 'prisma/migrations/migration_lock.toml'), 'utf8');
    assert.match(migrationLock, /^provider\s*=\s*"mssql"\s*$/m, 'The package includes the SQL Server migration engine provider lock');
    if (mode === 'candidate') {
      // Repack the already installed distributable, not a source checkout. Replace the dependency
      // before lock resolution so pre-publication gates never request audit-log@target from npm.
      const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', workspace], { cwd: installed, quiet: true }));
      assert.equal(pack.name, '@nestarc/audit-log');
      assert.equal(pack.version, targetVersion);
      assert.equal(path.basename(pack.filename), pack.filename);
      assert.match(pack.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
      candidateArtifact = { path: path.join(workspace, pack.filename), integrity: pack.integrity };
      manifest.dependencies['@nestarc/audit-log'] = `file:${candidateArtifact.path}`;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return { source: 'installed-packed-candidate', candidateVersion: candidate.version, targetVersion, dependencyMode: mode };
  });

  await step(`install-strict-${mode}-dependencies`, async () => {
    const flags = ['--include=dev', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${registry}`];
    npm(['install', '--package-lock-only', ...flags], { quiet: true });
    npm(['ci', ...flags], { quiet: true });
    const installed = await realpath(path.join(consumer, 'node_modules/@nestarc/audit-log'));
    assert.ok(installed.startsWith(`${await realpath(consumer)}${path.sep}`), 'The example dependency is installed inside its isolated consumer');
    const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, targetVersion);
    const lock = JSON.parse(await readFile(path.join(consumer, 'package-lock.json'), 'utf8'));
    const artifact = lock.packages['node_modules/@nestarc/audit-log'];
    if (mode === 'registry') {
      const dist = JSON.parse(npm(['view', `@nestarc/audit-log@${targetVersion}`, 'dist', '--json', `--registry=${registry}`], { quiet: true }));
      assert.ok(dist.tarball.startsWith(`${registry}/@nestarc/audit-log/`), 'Resolve audit-log from the public npm registry');
      assert.match(dist.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
      assert.equal(artifact.resolved, dist.tarball);
      assert.equal(artifact.integrity, dist.integrity, 'npm ci verified the same integrity published by the registry');
    } else {
      assert.ok(candidateArtifact);
      assert.ok(artifact.resolved.startsWith('file:'), 'Candidate audit-log must come from the local tarball');
      assert.equal(artifact.integrity, candidateArtifact.integrity, 'npm ci verified the repacked installed candidate');
    }
    return { version: manifest.version, mode, resolved: artifact.resolved, integrity: artifact.integrity, strictPeers: true, installScripts: false };
  });

  await step('migrate-generate-build-and-install-audit-storage', async () => {
    npm(['run', 'db:setup'], { database: true });
    return { command: 'npm run db:setup', passed: true };
  });

  await step(`run-${mode}-example-smoke`, async () => {
    const output = npm(['run', 'smoke'], { database: true });
    const match = output.match(/\{\s*"mode":\s*"sqlserver-manual"[\s\S]*?\}/);
    assert.ok(match, 'The example emits its asserted smoke outcomes');
    const result = JSON.parse(match[0]);
    const checks = ['commit', 'rollback', 'actorPolicy', 'tenantPolicy', 'redaction', 'unicode', 'authorizedHistory'];
    for (const check of checks) assert.equal(result[check], 'passed', `Example ${check} must pass`);
    return Object.fromEntries(checks.map(check => [check, result[check]]));
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error);
  console.error(`Example probe failed: ${JSON.stringify(report.error)}`);
} finally {
  try {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    report.cleanup.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.cleanup = { status: 'failed', error: safeError(error), databaseDrop: 'owned by run.mjs' };
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(`SQL Server example (${mode}) ${report.status}; temporary consumer cleanup ${report.cleanup.status}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
