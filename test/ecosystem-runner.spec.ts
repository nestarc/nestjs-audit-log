import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const {
  candidatePackageForMode,
  createStrictEnvironment,
  parseArguments,
} = require('../scripts/run-ecosystem-e2e.cjs') as {
  candidatePackageForMode(mode: string): string | null;
  createStrictEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  parseArguments(argv: string[]): {
    mode: string;
    tenancyTarball: string | null;
    softDeleteVersion: string | null;
  };
};

describe('ecosystem candidate runner', () => {
  it('keeps published and both packed candidate modes explicit', () => {
    expect(parseArguments(['--published'])).toEqual({
      mode: 'published',
      tenancyTarball: null,
      softDeleteVersion: null,
    });
    expect(parseArguments(['--audit-log-candidate', '--soft-delete-version', '0.8.2'])).toEqual({
      mode: 'audit-log-candidate',
      tenancyTarball: null,
      softDeleteVersion: '0.8.2',
    });
    expect(
      parseArguments([
        '--tenancy-candidate',
        '--tenancy-tarball',
        './candidate.tgz',
      ]),
    ).toEqual({
      mode: 'tenancy-candidate',
      tenancyTarball: expect.stringMatching(/candidate\.tgz$/),
      softDeleteVersion: null,
    });
  });

  it.each([
    ['--audit-log-candidate'],
    ['--audit-log-candidate', '--soft-delete-version'],
    ['--audit-log-candidate', '--soft-delete-version', ''],
    ['--audit-log-candidate', '--tenancy-tarball', './candidate.tgz'],
    ['--audit-log-candidate', '--soft-delete-version', '0.8.2', '--force'],
  ])('requires an explicit companion with no extra options: %j', (...argv) => {
    expect(() => parseArguments(argv)).toThrow('requires --soft-delete-version');
  });

  it.each([
    'latest', '^0.8.0', '~0.8.0', '0.8', 'v0.8.0', '01.0.0', '1.00.0', '1.0.00',
    '0.8.0-beta.1', '0.8.0+build', 'file:./companion.tgz', 'https://example.com/a.tgz',
    '--force', ' 0.8.0', '0.8.0\n', '9007199254740992.0.0',
  ])('rejects noncanonical or nonstable companion specification %j', (version) => {
    expect(() => parseArguments(['--audit-log-candidate', '--soft-delete-version', version]))
      .toThrow('canonical exact stable version');
  });

  it.each([
    ['--published', '--soft-delete-version', '0.8.2'],
    ['--tenancy-candidate', '--soft-delete-version', '0.8.2'],
    ['--tenancy-candidate', '--tenancy-tarball', './candidate.tgz', '--soft-delete-version', '0.8.2'],
  ])('rejects companion overrides outside audit candidate mode: %j', (...argv) => {
    expect(() => parseArguments(argv)).toThrow();
  });

  it('rejects implicit or cross-mode tenancy overrides', () => {
    expect(() =>
      parseArguments([
        '--published',
        '--tenancy-tarball',
        './candidate.tgz',
      ]),
    ).toThrow('--published does not accept');
    expect(() => parseArguments(['--tenancy-candidate'])).toThrow(
      'requires --tenancy-tarball',
    );
    expect(() => parseArguments(['--candidate'])).toThrow('Usage:');
  });

  it('changes only the package selected by the candidate mode', () => {
    expect(candidatePackageForMode('published')).toBeNull();
    expect(candidatePackageForMode('audit-log-candidate')).toBe(
      '@nestarc/audit-log',
    );
    expect(candidatePackageForMode('tenancy-candidate')).toBe(
      '@nestarc/tenancy',
    );
  });

  it('forces strict peer settings over ambient npm bypasses', () => {
    const env = createStrictEnvironment({
      npm_config_force: 'true',
      NPM_CONFIG_LEGACY_PEER_DEPS: 'true',
      npm_config_strict_peer_deps: 'false',
    });
    expect(env.npm_config_force).toBe('false');
    expect(env.npm_config_legacy_peer_deps).toBe('false');
    expect(env.npm_config_strict_peer_deps).toBe('true');
  });

  it('installs the selected companion in the real runner path and preserves the published fixture', () => {
    const root = resolve(__dirname, '..');
    const fixture = join(root, 'fixtures/published-ecosystem');
    const originalManifest = readFileSync(join(fixture, 'package.json'), 'utf8');
    const originalLock = readFileSync(join(fixture, 'package-lock.json'), 'utf8');
    const published = JSON.parse(originalManifest) as { dependencies: Record<string, string> };
    const temporary = mkdtempSync(join(tmpdir(), 'audit-ecosystem-runner-test-'));
    const trace = join(temporary, 'trace.jsonl');
    const npmStub = join(temporary, 'npm-stub.cjs');
    // Replace external npm work only; execute the runner's real CLI, copy, mutation and cleanup.
    writeFileSync(npmStub, `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      fs.appendFileSync(process.env.ECOSYSTEM_TEST_TRACE, JSON.stringify({
        args, cwd: process.cwd(), dependencies: manifest.dependencies,
        candidateVersion: process.env.AUDIT_LOG_CANDIDATE_VERSION,
        candidateIntegrity: process.env.AUDIT_LOG_CANDIDATE_INTEGRITY,
        strict: process.env.npm_config_strict_peer_deps,
        force: process.env.npm_config_force,
        legacy: process.env.npm_config_legacy_peer_deps,
      }) + '\\n');
      if (args[0] === 'pack') process.stdout.write(JSON.stringify([{
        name: '@nestarc/audit-log', filename: 'candidate.tgz', version: manifest.version,
        integrity: 'sha512-test-only-artifact', shasum: 'test-only-shasum',
      }]));
    `);
    try {
      execFileSync(process.execPath, [join(root, 'scripts/run-ecosystem-e2e.cjs'),
        '--audit-log-candidate', '--soft-delete-version', '0.9.2'], {
        cwd: root,
        env: {
          ...process.env, npm_execpath: npmStub, ECOSYSTEM_TEST_TRACE: trace,
          npm_config_force: 'true', npm_config_legacy_peer_deps: 'true',
        },
        timeout: 15_000,
        stdio: 'pipe',
      });
      const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{
        args: string[]; cwd: string; dependencies: Record<string, string>;
        candidateVersion?: string; candidateIntegrity?: string;
        strict: string; force: string; legacy: string;
      }>;
      expect(calls.map(call => call.args.slice(0, 2))).toEqual([
        ['pack', '--json'], ['install', '--package-lock-only'], ['ci', '--strict-peer-deps'],
        ['run', 'verify:audit-log-candidate'], ['run', 'test:e2e'],
      ]);
      for (const call of calls.slice(1)) {
        expect(call.dependencies['@nestarc/soft-delete']).toBe('0.9.2');
        expect(call.dependencies['@nestarc/tenancy']).toBe(published.dependencies['@nestarc/tenancy']);
        expect(call.dependencies['@nestarc/audit-log']).toMatch(/^file:.*candidate\.tgz$/);
        expect(call.candidateVersion).toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
        expect(call.candidateIntegrity).toBe('sha512-test-only-artifact');
        expect(call.strict).toBe('true');
        expect(call.force).toBe('false');
        expect(call.legacy).toBe('false');
        expect(existsSync(call.cwd)).toBe(false);
      }
      for (const call of calls.filter(call => ['install', 'ci'].includes(call.args[0]))) {
        expect(call.args).toEqual(expect.arrayContaining([
          '--strict-peer-deps', '--no-force', '--no-legacy-peer-deps',
          '--registry=https://registry.npmjs.org/', '--replace-registry-host=never',
        ]));
      }
      expect(readFileSync(join(fixture, 'package.json'), 'utf8')).toBe(originalManifest);
      expect(readFileSync(join(fixture, 'package-lock.json'), 'utf8')).toBe(originalLock);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
