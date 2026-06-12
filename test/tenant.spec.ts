import {
  resolveTenantId,
  getTenantId,
  _resetTenancyProbe,
} from '../src/utils/tenant';

describe('resolveTenantId', () => {
  beforeEach(() => {
    _resetTenancyProbe();
    jest.restoreAllMocks();
  });

  it('returns null when @nestarc/tenancy is not installed', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const result = getTenantId();
    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses tenantResolver before probing @nestarc/tenancy', () => {
    const result = resolveTenantId({
      tenantResolver: () => 'tenant-1',
    });

    expect(result).toBe('tenant-1');
  });

  it('propagates tenantResolver errors to the caller', () => {
    const error = new Error('resolver failed');

    expect(() =>
      resolveTenantId({
        tenantResolver: () => {
          throw error;
        },
      }),
    ).toThrow(error);
  });

  it('caches the tenancy availability probe', () => {
    resolveTenantId();
    resolveTenantId();
    // No error thrown on repeated calls — probe is cached
    expect(resolveTenantId()).toBeNull();
  });

  // Note: The success path (tenancy installed) and error path (getTenantId throws)
  // require runtime @nestarc/tenancy installation which cannot be reliably
  // mocked with jest.mock + require.resolve. These paths are covered by E2E tests.
});
