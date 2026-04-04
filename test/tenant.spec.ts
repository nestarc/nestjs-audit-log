import { getTenantId, _resetTenancyProbe } from '../src/utils/tenant';

describe('getTenantId', () => {
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

  it('caches the tenancy availability probe', () => {
    getTenantId();
    getTenantId();
    // No error thrown on repeated calls — probe is cached
    expect(getTenantId()).toBeNull();
  });
});
