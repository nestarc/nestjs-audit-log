'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.resolve(__dirname, '..');
const manifest = readJson(path.join(fixtureRoot, 'package.json'));
const lockfile = readJson(path.join(fixtureRoot, 'package-lock.json'));
const candidateVersion = process.env.AUDIT_LOG_CANDIDATE_VERSION;
const candidateIntegrity = process.env.AUDIT_LOG_CANDIDATE_INTEGRITY;
const packageNames = [
  '@nestarc/tenancy',
  '@nestarc/audit-log',
  '@nestarc/soft-delete',
];

if (process.env.npm_lifecycle_event === 'verify:candidate') {
  assert.match(
    candidateVersion ?? '',
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    'AUDIT_LOG_CANDIDATE_VERSION must identify the packed audit-log candidate',
  );
  assert.match(
    candidateIntegrity ?? '',
    /^sha512-/,
    'AUDIT_LOG_CANDIDATE_INTEGRITY must identify the packed audit-log candidate',
  );
} else {
  assert.equal(
    candidateVersion,
    undefined,
    'AUDIT_LOG_CANDIDATE_VERSION is only valid for verify:candidate',
  );
  assert.equal(
    candidateIntegrity,
    undefined,
    'AUDIT_LOG_CANDIDATE_INTEGRITY is only valid for verify:candidate',
  );
}

for (const packageName of packageNames) {
  const requested = manifest.dependencies[packageName];
  const lockEntry = lockfile.packages[`node_modules/${packageName}`];
  const installedPath = path.join(
    fixtureRoot,
    'node_modules',
    ...packageName.split('/'),
  );
  const installedManifestPath = path.join(installedPath, 'package.json');
  const installed = readJson(installedManifestPath);
  const realInstalledPath = fs.realpathSync(installedPath);
  const expectedInstalledVersion =
    packageName === '@nestarc/audit-log' && candidateVersion
      ? candidateVersion
      : requested;
  const isCandidate =
    packageName === '@nestarc/audit-log' && candidateVersion !== undefined;

  assert.ok(lockEntry, `${packageName} must be present in package-lock.json`);
  if (isCandidate) {
    assert.match(
      requested,
      /^file:/,
      '@nestarc/audit-log candidate must use an explicit packed tarball',
    );
    assert.equal(lockEntry.version, candidateVersion);
    assert.match(lockEntry.resolved ?? '', /^file:/);
    assert.equal(lockEntry.integrity, candidateIntegrity);
  } else {
    assert.match(requested, /^\d+\.\d+\.\d+$/, `${packageName} must use an exact version`);
    assert.equal(lockEntry.version, requested, `${packageName} lock version must match package.json`);
    assert.match(
      lockEntry.resolved ?? '',
      /^https:\/\/registry\.npmjs\.org\//,
      `${packageName} must resolve from the public npm registry`,
    );
    assert.match(
      lockEntry.integrity ?? '',
      /^sha512-/,
      `${packageName} must have a SHA-512 lockfile integrity`,
    );
  }
  assert.equal(
    fs.lstatSync(installedPath).isSymbolicLink(),
    false,
    `${packageName} must not be a workspace or sibling symlink`,
  );
  assert.ok(
    realInstalledPath.startsWith(`${path.join(fixtureRoot, 'node_modules')}${path.sep}`),
    `${packageName} must resolve inside the clean fixture`,
  );
  assert.equal(
    installed.version,
    expectedInstalledVersion,
    `${packageName} installed version must match the selected tuple`,
  );
  assert.equal(
    installed.name,
    packageName,
    `${packageName} installed manifest must keep the expected package name`,
  );

  console.log(
    JSON.stringify({
      package: packageName,
      requested,
      installed: installed.version,
      source:
        isCandidate
          ? 'packed-candidate'
          : 'published-lock',
      resolved: lockEntry.resolved,
      integrity: lockEntry.integrity,
    }),
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
