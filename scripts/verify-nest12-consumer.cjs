'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_PACKAGE_NAME = '@nestarc/audit-log';
const repositoryRoot = path.resolve(__dirname, '..');
const temporaryPrefix = 'audit-log-nest12-consumer-';
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), temporaryPrefix));
const packageDirectory = path.join(temporaryRoot, 'package');
const consumerDirectory = path.join(temporaryRoot, 'consumer');

try {
  if (temporaryRoot.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error('NestJS 12 consumer fixture must run outside the repository tree');
  }

  fs.mkdirSync(packageDirectory);
  fs.mkdirSync(consumerDirectory);
  fs.writeFileSync(
    path.join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'audit-log-nest12-consumer', private: true }, null, 2)}\n`,
  );

  const packResult = spawnNpm(
    ['pack', '--json', '--pack-destination', packageDirectory],
    { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
  );
  if (packResult.stderr) {
    process.stderr.write(packResult.stderr);
  }
  assertCommandSucceeded(packResult, 'npm pack');

  const [pack] = JSON.parse(packResult.stdout);
  if (pack?.name !== EXPECTED_PACKAGE_NAME || !pack.filename || !pack.integrity) {
    throw new Error('npm pack --json did not return the expected audit-log package identity');
  }

  const versions = Object.fromEntries(
    [
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/platform-express',
      '@prisma/client',
      'reflect-metadata',
      'rxjs',
    ].map((packageName) => [packageName, installedVersion(packageName)]),
  );
  if (!versions['@nestjs/core'].startsWith('12.')) {
    throw new Error(`Expected NestJS 12, received ${versions['@nestjs/core']}`);
  }

  const tarballPath = path.join(packageDirectory, pack.filename);
  runNpm(
    [
      'install',
      '--strict-peer-deps',
      '--ignore-scripts',
      tarballPath,
      ...Object.entries(versions).map(([name, version]) => `${name}@${version}`),
    ],
    consumerDirectory,
  );

  const smokeResult = spawnSync(
    process.execPath,
    [
      '-e',
      "const auditLog = require('@nestarc/audit-log'); const nestCore = require('@nestjs/core'); if (typeof auditLog.AuditLogModule !== 'function' || !nestCore.NestFactory) process.exit(1);",
    ],
    { cwd: consumerDirectory, encoding: 'utf8', env: process.env },
  );
  assertCommandSucceeded(smokeResult, 'packed CommonJS consumer smoke');

  console.log(
    JSON.stringify({
      package: pack.name,
      version: pack.version,
      integrity: pack.integrity,
      nest: versions['@nestjs/core'],
      prisma: versions['@prisma/client'],
      runtime: process.version,
      result: 'passed',
    }),
  );
} finally {
  if (temporaryRoot.startsWith(path.join(os.tmpdir(), temporaryPrefix))) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function installedVersion(packageName) {
  let directory = path.dirname(require.resolve(packageName, {
    paths: [repositoryRoot],
  }));

  while (true) {
    const packagePath = path.join(directory, 'package.json');
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (packageJson.name === packageName && packageJson.version) {
        return packageJson.version;
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate package metadata for ${packageName}`);
    }
    directory = parent;
  }
}

function runNpm(args, cwd) {
  const result = spawnNpm(args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  assertCommandSucceeded(result, `npm ${args.join(' ')}`);
}

function spawnNpm(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return spawnSync(process.execPath, [npmExecPath, ...args], options);
  }
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function assertCommandSucceeded(result, command) {
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${command} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
