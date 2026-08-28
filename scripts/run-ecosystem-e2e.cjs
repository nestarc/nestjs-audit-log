'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_PACKAGE_NAME = '@nestarc/audit-log';
const mode = process.argv[2];
if (mode !== '--published' && mode !== '--candidate') {
  throw new Error('Usage: node scripts/run-ecosystem-e2e.cjs --published|--candidate');
}

const repositoryRoot = path.resolve(__dirname, '..');
const fixtureSource = path.join(
  repositoryRoot,
  'fixtures',
  'published-ecosystem',
);
const temporaryPrefix = `audit-log-ecosystem-${mode.slice(2)}-`;
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), temporaryPrefix),
);
const fixtureCopy = path.join(temporaryRoot, 'fixture');
const packageDirectory = path.join(temporaryRoot, 'package');

try {
  if (temporaryRoot.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error('Ecosystem fixture must run outside the repository tree');
  }

  fs.cpSync(fixtureSource, fixtureCopy, {
    recursive: true,
    filter: (sourcePath) => {
      const relativePath = path.relative(fixtureSource, sourcePath);
      const firstPart = relativePath.split(path.sep)[0];
      return firstPart !== 'node_modules' && firstPart !== 'generated';
    },
  });

  let verificationEnvironment = process.env;
  if (mode === '--candidate') {
    fs.mkdirSync(packageDirectory);
    const packResult = spawnNpm(
      ['pack', '--json', '--pack-destination', packageDirectory],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env,
      },
    );
    if (packResult.stderr) {
      process.stderr.write(packResult.stderr);
    }
    assertCommandSucceeded(packResult, 'npm pack');

    const [pack] = JSON.parse(packResult.stdout);
    if (
      pack?.name !== EXPECTED_PACKAGE_NAME ||
      !pack.filename ||
      !pack.version ||
      !pack.integrity ||
      !pack.shasum
    ) {
      throw new Error('npm pack --json did not return the expected audit-log package identity');
    }
    const tarballPath = path.join(packageDirectory, pack.filename);
    console.log(
      JSON.stringify({
        package: pack.name,
        version: pack.version,
        source: 'packed-candidate',
        integrity: pack.integrity,
        shasum: pack.shasum,
        filename: pack.filename,
      }),
    );

    const manifestPath = path.join(fixtureCopy, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies[EXPECTED_PACKAGE_NAME] = `file:${tarballPath}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    runNpm(
      ['install', '--package-lock-only', '--ignore-scripts'],
      fixtureCopy,
    );
    verificationEnvironment = {
      ...process.env,
      AUDIT_LOG_CANDIDATE_VERSION: pack.version,
      AUDIT_LOG_CANDIDATE_INTEGRITY: pack.integrity,
    };
  }

  runNpm(['ci'], fixtureCopy);
  runNpm(
    ['run', mode === '--candidate' ? 'verify:candidate' : 'verify:published'],
    fixtureCopy,
    verificationEnvironment,
  );
  runNpm(['run', 'test:e2e'], fixtureCopy, verificationEnvironment);
} finally {
  if (temporaryRoot.startsWith(path.join(os.tmpdir(), temporaryPrefix))) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function runNpm(args, cwd, env = process.env) {
  const result = spawnNpm(args, {
    cwd,
    env,
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
