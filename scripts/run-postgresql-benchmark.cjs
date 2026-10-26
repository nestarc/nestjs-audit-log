'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readBudget } = require('./compare-performance.cjs');

const root = path.resolve(__dirname, '..');
const baselineVersion = process.env.BENCH_BASELINE_VERSION || '0.7.1';
const reportDirectory = path.join(root, 'benchmarks/results');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(command, args, cwd, env, capture = false, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`${path.basename(command)} ${args[0]} failed (${result.signal ?? result.status})`);
  }
  return result.stdout;
}

function npm(args, cwd, capture = false) {
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], cwd, process.env, capture)
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, process.env, capture);
}

function main() {
  assert.match(baselineVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
    'BENCH_BASELINE_VERSION must be an exact published version, not a tag or range');
  // Fail malformed budgets before database setup or fetching dependencies.
  if (process.env.BENCH_BUDGET_PATH) {
    const budget = readBudget(process.env.BENCH_BUDGET_PATH);
    assert.equal(budget.baselineVersion, baselineVersion, 'Budget calibration must match BENCH_BASELINE_VERSION');
  }
  // Reject external targets before fetching or installing benchmark dependencies.
  const url = new URL(process.env.DATABASE_URL || 'postgresql://test:test@localhost:5433/audit_test');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) && ['5432', '5433'].includes(url.port) &&
    url.pathname === '/audit_test' && url.username === 'test' && url.password === 'test' &&
    !url.search && !url.hash, 'Use only the dedicated localhost test:test audit_test database');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-performance-'));
  fs.mkdirSync(reportDirectory, { recursive: true });
  const evidence = { status: 'preparing', baselineVersion, candidateVersion: manifest.version, packages: {} };
  const save = () => fs.writeFileSync(path.join(reportDirectory, 'package-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  try {
    const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], root, true));
    assert.equal(pack.name, '@nestarc/audit-log');
    assert.equal(pack.version, manifest.version);
    const baselineDist = JSON.parse(npm(['view', `@nestarc/audit-log@${baselineVersion}`, 'dist', '--json',
      '--registry=https://registry.npmjs.org'], temp, true));
    const shared = Object.fromEntries(['@nestjs/common', '@nestjs/core', '@prisma/client', 'reflect-metadata', 'rxjs']
      .map(name => [name, JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version]));
    evidence.dependencies = shared;
    const installed = {};
    for (const variant of ['baseline', 'candidate']) {
      const consumer = path.join(temp, variant);
      fs.mkdirSync(consumer);
      const version = variant === 'baseline' ? baselineVersion : pack.version;
      const artifact = variant === 'baseline' ? version : `file:${path.join(temp, pack.filename)}`;
      fs.writeFileSync(path.join(consumer, 'package.json'), `${JSON.stringify({
        name: `audit-log-benchmark-${variant}`, private: true, version: '1.0.0',
        dependencies: { ...shared, '@nestarc/audit-log': artifact },
      }, null, 2)}\n`);
      const flags = ['--strict-peer-deps', '--no-force', '--no-legacy-peer-deps', '--ignore-scripts',
        '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'];
      npm(['install', '--package-lock-only', ...flags], consumer);
      npm(['ci', ...flags], consumer);
      const directory = path.join(consumer, 'node_modules/@nestarc/audit-log');
      assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(consumer) + path.sep), 'Install the artifact, never a source link');
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version, version);
      const lock = JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'));
      const locked = lock.packages['node_modules/@nestarc/audit-log'];
      assert.ok(!locked.link && /^sha512-/.test(locked.integrity));
      assert.equal(locked.integrity, variant === 'baseline' ? baselineDist.integrity : pack.integrity);
      if (variant === 'baseline') assert.equal(locked.resolved, baselineDist.tarball);
      else assert.match(locked.resolved, /^file:.*\.tgz$/);
      installed[variant] = directory;
      evidence.packages[variant] = { version, resolved: locked.resolved, integrity: locked.integrity };
      save();
    }
    evidence.status = 'verified';
    save();
    run(process.execPath, ['-r', 'ts-node/register/transpile-only', 'benchmarks/manual-audit-regression.cjs'], root, {
      ...process.env, DATABASE_URL: url.href,
      BENCH_BASELINE_VERSION: baselineVersion,
      BENCH_BASELINE_PACKAGE_PATH: installed.baseline,
      BENCH_CANDIDATE_PACKAGE_PATH: installed.candidate,
    }, false, 600_000);
    const report = process.env.BENCH_REPORT_PATH || path.join(reportDirectory, 'postgresql-manual-regression.json');
    const compareArgs = [path.join(root, 'scripts/compare-performance.cjs'), report,
      '--output', path.join(reportDirectory, 'postgresql-performance-summary.json')];
    if (process.env.BENCH_BUDGET_PATH) compareArgs.push('--budget', process.env.BENCH_BUDGET_PATH);
    run(process.execPath, compareArgs, root, process.env);
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = { name: error.name, message: error.message.slice(0, 240) };
    save();
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
