'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.resolve(__dirname, '..');
const manifest = readJson(path.join(fixtureRoot, 'package.json'));
const lockfile = readJson(path.join(fixtureRoot, 'package-lock.json'));
const lifecycleMode = process.env.npm_lifecycle_event?.replace(/^verify:/, '');
const mode = process.env.ECOSYSTEM_MODE ?? lifecycleMode;
const packageNames = [
  '@nestarc/tenancy',
  '@nestarc/audit-log',
  '@nestarc/soft-delete',
];
const candidateByMode = {
  'audit-log-candidate': {
    integrity: process.env.AUDIT_LOG_CANDIDATE_INTEGRITY,
    packageName: '@nestarc/audit-log',
    version: process.env.AUDIT_LOG_CANDIDATE_VERSION,
  },
  'tenancy-candidate': {
    integrity: process.env.TENANCY_CANDIDATE_INTEGRITY,
    packageName: '@nestarc/tenancy',
    version: process.env.TENANCY_CANDIDATE_VERSION,
  },
};

assert.match(
  mode ?? '',
  /^(published|audit-log-candidate|tenancy-candidate)$/,
  'ECOSYSTEM_MODE must select one explicit ecosystem mode',
);
const candidate = candidateByMode[mode];
if (candidate) {
  assert.match(
    candidate.version ?? '',
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    `${candidate.packageName} candidate version must identify the packed artifact`,
  );
  assert.match(
    candidate.integrity ?? '',
    /^sha512-/,
    `${candidate.packageName} candidate integrity must identify the packed artifact`,
  );
} else {
  for (const name of [
    'AUDIT_LOG_CANDIDATE_VERSION',
    'AUDIT_LOG_CANDIDATE_INTEGRITY',
    'TENANCY_CANDIDATE_VERSION',
    'TENANCY_CANDIDATE_INTEGRITY',
  ]) assert.equal(process.env[name], undefined, `${name} is invalid in published mode`);
}

for (const packageName of packageNames) {
  const requested = manifest.dependencies[packageName];
  const lockEntry = lockfile.packages[`node_modules/${packageName}`];
  const installedPath = path.join(fixtureRoot, 'node_modules', ...packageName.split('/'));
  const installed = readJson(path.join(installedPath, 'package.json'));
  const realInstalledPath = fs.realpathSync(installedPath);
  const isCandidate = candidate?.packageName === packageName;
  const expectedInstalledVersion = isCandidate ? candidate.version : requested;

  assert.ok(lockEntry, `${packageName} must be present in package-lock.json`);
  if (isCandidate) {
    assert.match(requested, /^file:/, `${packageName} candidate must use an explicit packed tarball`);
    assert.equal(lockEntry.version, candidate.version);
    assert.match(lockEntry.resolved ?? '', /^file:/);
    assert.equal(lockEntry.integrity, candidate.integrity);
  } else {
    assert.match(requested, /^\d+\.\d+\.\d+$/, `${packageName} must use an exact version`);
    assert.equal(lockEntry.version, requested, `${packageName} lock version must match package.json`);
    assert.match(
      lockEntry.resolved ?? '',
      /^https:\/\/registry\.npmjs\.org\//,
      `${packageName} must resolve from the public npm registry`,
    );
    assert.match(lockEntry.integrity ?? '', /^sha512-/);
  }
  assert.equal(fs.lstatSync(installedPath).isSymbolicLink(), false);
  assert.ok(
    realInstalledPath.startsWith(`${path.join(fixtureRoot, 'node_modules')}${path.sep}`),
    `${packageName} must resolve inside the clean fixture`,
  );
  assert.equal(installed.version, expectedInstalledVersion);
  assert.equal(installed.name, packageName);
  console.log(JSON.stringify({
    package: packageName,
    requested,
    installed: installed.version,
    source: isCandidate ? 'packed-candidate' : 'published-lock',
    resolved: lockEntry.resolved,
    integrity: lockEntry.integrity,
  }));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
