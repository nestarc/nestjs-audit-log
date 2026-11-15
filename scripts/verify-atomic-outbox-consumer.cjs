'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const installFlags = ['--strict-peer-deps', '--no-force', '--no-legacy-peer-deps',
  '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  '--registry=https://registry.npmjs.org'];

async function publishedManifest(version) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(`https://registry.npmjs.org/@nestarc%2faudit-log/${version}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok) return response.json();
    assert.ok(response.status === 404 || response.status === 429 || response.status >= 500,
      `Unexpected npm registry status: ${response.status}`);
    if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error(`npm package @nestarc/audit-log@${version} did not become available`);
}

function run(command, args, cwd, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240000,
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

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--registry'),
    'Usage: node scripts/verify-atomic-outbox-consumer.cjs [--registry]');
  const registry = args[0] === '--registry';
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const published = registry ? await publishedManifest(version) : undefined;
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/audit_test');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/audit_test',
    'Use a dedicated local audit_test database.');
  process.env.DATABASE_URL = url.href;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-atomic-outbox-'));
  try {
    const [pack] = JSON.parse(npm(['pack', ...(registry ? [`@nestarc/audit-log@${version}`] : []),
      '--registry=https://registry.npmjs.org', '--json', '--pack-destination', temp], root, true));
    assert.equal(pack.name, '@nestarc/audit-log');
    assert.equal(pack.version, version);
    if (registry) assert.equal(pack.integrity, published.dist.integrity);
    for (const name of ['dist/delivery/outbox-audit-delivery.js', 'examples/atomic-outbox/package.json',
      'examples/atomic-outbox/README.md', 'examples/atomic-outbox/src/smoke.ts']) {
      assert.ok(pack.files.some(file => file.path === name), `Missing packed file: ${name}`);
    }
    const tarball = path.join(temp, pack.filename);
    run('tar', ['-xzf', tarball, '-C', temp], root, process.env);
    const consumer = path.join(temp, 'consumer');
    fs.cpSync(path.join(temp, 'package/examples/atomic-outbox'), consumer, { recursive: true });
    const manifestPath = path.join(consumer, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.dependencies['@nestarc/outbox'], '0.4.1');
    manifest.dependencies['@nestarc/audit-log'] = registry ? version : `file:${tarball}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    npm(['install', '--package-lock-only', ...installFlags], consumer);
    npm(['ci', ...installFlags], consumer);
    const lock = JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/@nestarc/audit-log'].integrity, pack.integrity);
    assert.equal(lock.packages['node_modules/@nestarc/outbox'].version, '0.4.1');
    assert.equal(lock.packages['node_modules/@nestarc/outbox'].integrity,
      'sha512-+hUsFdmvPSIkw2OwpWJlJ08uHYnx8Mha5MBb/fv1+PZN8+kNrOEOLuFvbq/bw6Z4OkLGwGCtyHWpo5LEjBSO4w==');
    assert.ok(fs.realpathSync(path.join(consumer, 'node_modules/@nestarc/audit-log'))
      .startsWith(fs.realpathSync(consumer) + path.sep), 'The consumer must use packed bytes, not a source link.');
    npm(['run', 'smoke'], consumer);

    // A separate install proves the public root has no required Outbox dependency.
    const standalone = path.join(temp, 'standalone');
    fs.mkdirSync(standalone);
    const dependencies = { ...manifest.dependencies };
    delete dependencies['@nestarc/outbox'];
    delete dependencies['@nestjs/schedule'];
    fs.writeFileSync(path.join(standalone, 'package.json'), JSON.stringify({ private: true, dependencies }));
    npm(['install', ...installFlags], standalone);
    fs.writeFileSync(path.join(standalone, 'check.cjs'), `
      const assert = require('node:assert/strict');
      assert.throws(() => require.resolve('@nestarc/outbox'), { code: 'MODULE_NOT_FOUND' });
      const api = require('@nestarc/audit-log');
      for (const key of ['AuditService', 'createAuditedClient', 'createOutboxAuditDelivery', 'AuditStreamRunner'])
        assert.equal(typeof api[key], 'function');
      console.log('Standalone public API loads without Outbox');
    `);
    run(process.execPath, ['check.cjs'], standalone, process.env);
    console.log(JSON.stringify({ result: 'atomic Outbox consumer passed', mode: registry ? 'registry' : 'candidate', node: process.version,
      auditLog: { version: pack.version, integrity: pack.integrity },
      outbox: { version: '0.4.1', integrity: lock.packages['node_modules/@nestarc/outbox'].integrity },
      standaloneWithoutOutbox: true }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
