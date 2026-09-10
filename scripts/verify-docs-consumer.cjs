'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const root = path.resolve(__dirname, '..');

function run(command, args, cwd, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    timeout: 180000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`${path.basename(command)} ${args[0]} failed (${result.signal ?? result.status})`);
  }
  return result.stdout;
}

function npm(args, cwd, env, capture = false) {
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], cwd, env, capture)
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, env, capture);
}

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/audit_test');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/audit_test',
    'Use the dedicated local audit_test database for the documentation consumer test.');
  const schema = `audit_docs_${randomUUID().replaceAll('-', '')}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-docs-consumer-'));
  const consumer = path.join(temp, 'consumer');
  const connection = new Client({ connectionString: url.href });
  let connected = false;
  try {
    await connection.connect();
    connected = true;
    await connection.query(`CREATE SCHEMA "${schema}"`);
    fs.cpSync(path.join(root, 'examples/quick-start'), consumer, {
      recursive: true,
      filter: source => !['node_modules', 'dist', 'generated', '.env', 'package-lock.json'].includes(path.basename(source)),
    });
    const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], root, process.env, true));
    assert.equal(pack.name, '@nestarc/audit-log');
    const guides = ['agent-guide', 'api-reference', 'transactions', 'context-and-tenancy',
      'storage-and-retention', 'export-and-streams', 'benchmarks', 'maintaining'];
    const exampleFiles = ['README.md', 'package.json', '.env.example', 'tsconfig.json', 'prisma.config.ts',
      'prisma/schema.prisma', 'prisma/migrations/20260910000000_users/migration.sql',
      'src/prisma.service.ts', 'src/prisma.module.ts', 'src/app.module.ts', 'src/user.controller.ts',
      'src/main.ts', 'src/setup.ts', 'src/smoke.ts'];
    for (const expected of ['README.md', 'llms.txt', 'dist/index.js', 'dist/index.d.ts',
      'docs/benchmarks/2026-09-10-local.json',
      ...guides.map(name => `docs/${name}.md`),
      ...exampleFiles.map(name => `examples/quick-start/${name}`)]) {
      assert.ok(pack.files.some(file => file.path === expected), `Missing published file: ${expected}`);
    }
    const manifestPath = path.join(consumer, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['@nestarc/audit-log'] = `file:${path.join(temp, pack.filename)}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    url.searchParams.set('schema', schema);
    const env = { ...process.env, DATABASE_URL: url.href };
    npm(['install', '--package-lock-only', '--include=dev', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], consumer, env);
    npm(['ci', '--include=dev', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], consumer, env);
    const installed = path.join(consumer, 'node_modules/@nestarc/audit-log');
    assert.ok(fs.realpathSync(installed).startsWith(fs.realpathSync(consumer) + path.sep), 'Use the packed package, not a source link.');
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version, pack.version);
    npm(['run', 'db:setup'], consumer, env);
    npm(['run', 'smoke'], consumer, env);
    console.log(JSON.stringify({ package: pack.name, version: pack.version, integrity: pack.integrity,
      node: process.version, result: 'documentation consumer passed' }));
  } finally {
    try {
      if (connected) {
        try { await connection.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await connection.end(); }
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
