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
  };
};

describe('ecosystem candidate runner', () => {
  it('keeps published and both packed candidate modes explicit', () => {
    expect(parseArguments(['--published'])).toEqual({
      mode: 'published',
      tenancyTarball: null,
    });
    expect(parseArguments(['--audit-log-candidate'])).toEqual({
      mode: 'audit-log-candidate',
      tenancyTarball: null,
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
    });
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
});
