let tenancyAvailable: boolean | null = null;

export function resolveTenantId(opts?: {
  tenantResolver?: () => string | null;
}): string | null {
  if (opts?.tenantResolver) {
    return opts.tenantResolver();
  }

  if (tenancyAvailable === null) {
    try {
      require.resolve('@nestarc/tenancy');
      tenancyAvailable = true;
    } catch {
      tenancyAvailable = false;
    }
  }

  if (!tenancyAvailable) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TenancyContext } = require('@nestarc/tenancy');
  return new TenancyContext().getTenantId();
}

export function getTenantId(): string | null {
  return resolveTenantId();
}

/** @internal Reset cached probe for testing */
export function _resetTenancyProbe(): void {
  tenancyAvailable = null;
}
