'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AUDIT_LOG_PACKAGE = '@nestarc/audit-log';
const TENANCY_PACKAGE = '@nestarc/tenancy';
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
const MODES = new Set(['published', 'audit-log-candidate', 'tenancy-candidate']);
const STRICT_INSTALL_ARGS = [
  '--strict-peer-deps',
  '--no-force',
  '--no-legacy-peer-deps',
  `--registry=${PUBLIC_REGISTRY}`,
  '--replace-registry-host=never',
  '--no-audit',
  '--no-fund',
];

function parseArguments(argv) {
  const modeArgument = argv[0];
  const mode = modeArgument?.startsWith('--') ? modeArgument.slice(2) : '';
  if (!MODES.has(mode)) {
    throw new Error(
      'Usage: node scripts/run-ecosystem-e2e.cjs --published|--audit-log-candidate|--tenancy-candidate [--tenancy-tarball /absolute/path/to/candidate.tgz]',
    );
  }
  if (mode === 'tenancy-candidate') {
    if (argv.length !== 3 || argv[1] !== '--tenancy-tarball' || !argv[2]) {
      throw new Error(
        '--tenancy-candidate requires --tenancy-tarball with an explicit .tgz file',
      );
    }
    return { mode, tenancyTarball: path.resolve(argv[2]) };
  }
  if (argv.length !== 1) {
    throw new Error(`${modeArgument} does not accept candidate artifact options`);
  }
  return { mode, tenancyTarball: null };
}

function validateTenancyTarball(tarballPath) {
  if (path.extname(tarballPath) !== '.tgz') {
    throw new Error('--tenancy-tarball must point to a .tgz file');
  }
  let stat;
  try {
    stat = fs.statSync(tarballPath);
  } catch {
    throw new Error(`Tenancy tarball does not exist: ${tarballPath}`);
  }
  if (!stat.isFile()) throw new Error('The tenancy candidate must be a regular file');

  const realPath = fs.realpathSync(tarballPath);
  const manifestResult = spawnSync(
    'tar',
    ['-xOf', realPath, 'package/package.json'],
    { encoding: 'utf8' },
  );
  assertCommandSucceeded(manifestResult, 'read tenancy candidate manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestResult.stdout);
  } catch {
    throw new Error('Tenancy candidate package.json is invalid JSON');
  }
  if (manifest.name !== TENANCY_PACKAGE) {
    throw new Error(`Expected ${TENANCY_PACKAGE}, received ${String(manifest.name)}`);
  }
  if (!/^0\.16\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`Expected a 0.16.x tenancy candidate, received ${String(manifest.version)}`);
  }
  if (manifest.engines?.node !== '^22.13.0 || ^24.0.0') {
    throw new Error(`Unexpected tenancy Node contract: ${String(manifest.engines?.node)}`);
  }
  return {
    integrity: `sha512-${crypto.createHash('sha512').update(fs.readFileSync(realPath)).digest('base64')}`,
    path: realPath,
    version: manifest.version,
  };
}

function candidatePackageForMode(mode) {
  if (mode === 'audit-log-candidate') return AUDIT_LOG_PACKAGE;
  if (mode === 'tenancy-candidate') return TENANCY_PACKAGE;
  return null;
}

function createStrictEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase().replaceAll('-', '_');
    if (
      normalized === 'npm_config_force' ||
      normalized === 'npm_config_legacy_peer_deps' ||
      normalized === 'npm_config_registry' ||
      normalized === 'npm_config_replace_registry_host' ||
      normalized === 'npm_config_strict_peer_deps'
    ) delete env[key];
  }
  env.npm_config_force = 'false';
  env.npm_config_legacy_peer_deps = 'false';
  env.npm_config_registry = PUBLIC_REGISTRY;
  env.npm_config_replace_registry_host = 'never';
  env.npm_config_strict_peer_deps = 'true';
  return env;
}

function main(argv = process.argv.slice(2)) {
  const { mode, tenancyTarball } = parseArguments(argv);
  const repositoryRoot = path.resolve(__dirname, '..');
  const fixtureSource = path.join(repositoryRoot, 'fixtures', 'published-ecosystem');
  const temporaryPrefix = `audit-log-ecosystem-${mode}-`;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), temporaryPrefix));
  const fixtureCopy = path.join(temporaryRoot, 'fixture');
  const packageDirectory = path.join(temporaryRoot, 'package');
  const strictEnvironment = createStrictEnvironment({ ECOSYSTEM_MODE: mode });

  try {
    if (temporaryRoot.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error('Ecosystem fixture must run outside the repository tree');
    }
    fs.cpSync(fixtureSource, fixtureCopy, {
      recursive: true,
      filter: (sourcePath) => {
        const firstPart = path.relative(fixtureSource, sourcePath).split(path.sep)[0];
        return firstPart !== 'node_modules' && firstPart !== 'generated';
      },
    });

    let verificationEnvironment = strictEnvironment;
    if (mode === 'audit-log-candidate') {
      fs.mkdirSync(packageDirectory);
      const packResult = spawnNpm(
        ['pack', '--json', '--pack-destination', packageDirectory],
        { cwd: repositoryRoot, encoding: 'utf8', env: strictEnvironment },
      );
      if (packResult.stderr) process.stderr.write(packResult.stderr);
      assertCommandSucceeded(packResult, 'npm pack');
      const [pack] = JSON.parse(packResult.stdout);
      if (
        pack?.name !== AUDIT_LOG_PACKAGE || !pack.filename || !pack.version ||
        !pack.integrity || !pack.shasum
      ) throw new Error('npm pack --json did not return the expected audit-log package identity');
      const tarballPath = path.join(packageDirectory, pack.filename);
      logCandidate(pack.name, pack.version, pack.integrity, tarballPath);
      replaceFixtureDependency(fixtureCopy, AUDIT_LOG_PACKAGE, tarballPath);
      verificationEnvironment = createStrictEnvironment({
        AUDIT_LOG_CANDIDATE_INTEGRITY: pack.integrity,
        AUDIT_LOG_CANDIDATE_VERSION: pack.version,
        ECOSYSTEM_MODE: mode,
      });
    } else if (mode === 'tenancy-candidate') {
      const candidate = validateTenancyTarball(tenancyTarball);
      logCandidate(TENANCY_PACKAGE, candidate.version, candidate.integrity, candidate.path);
      replaceFixtureDependency(fixtureCopy, TENANCY_PACKAGE, candidate.path);
      verificationEnvironment = createStrictEnvironment({
        ECOSYSTEM_MODE: mode,
        TENANCY_CANDIDATE_INTEGRITY: candidate.integrity,
        TENANCY_CANDIDATE_VERSION: candidate.version,
      });
    }

    if (mode !== 'published') {
      runNpm(
        ['install', '--package-lock-only', '--ignore-scripts', ...STRICT_INSTALL_ARGS],
        fixtureCopy,
        verificationEnvironment,
      );
    }
    runNpm(['ci', ...STRICT_INSTALL_ARGS], fixtureCopy, verificationEnvironment);
    runNpm(['run', `verify:${mode}`], fixtureCopy, verificationEnvironment);
    runNpm(['run', 'test:e2e'], fixtureCopy, verificationEnvironment);
  } finally {
    if (temporaryRoot.startsWith(path.join(os.tmpdir(), temporaryPrefix))) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function replaceFixtureDependency(fixtureCopy, packageName, tarballPath) {
  const manifestPath = path.join(fixtureCopy, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!(packageName in manifest.dependencies)) {
    throw new Error(`Fixture dependency is missing: ${packageName}`);
  }
  manifest.dependencies[packageName] = `file:${tarballPath}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function logCandidate(packageName, version, integrity, tarballPath) {
  console.log(JSON.stringify({
    package: packageName,
    version,
    source: 'packed-candidate',
    integrity,
    filename: path.basename(tarballPath),
  }));
}

function runNpm(args, cwd, env = process.env) {
  const result = spawnNpm(args, { cwd, env, stdio: 'inherit' });
  assertCommandSucceeded(result, `npm ${args.join(' ')}`);
}

function spawnNpm(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) return spawnSync(process.execPath, [npmExecPath, ...args], options);
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function assertCommandSucceeded(result, command) {
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

if (require.main === module) main();

module.exports = {
  candidatePackageForMode,
  createStrictEnvironment,
  parseArguments,
  validateTenancyTarball,
};
