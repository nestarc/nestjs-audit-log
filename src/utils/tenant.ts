let tenancyAvailable: boolean | null = null;

export function getTenantId(): string | null {
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TenancyContext } = require('@nestarc/tenancy');
    return new TenancyContext().getTenantId();
  } catch (error) {
    console.warn(
      '[@nestarc/audit-log] @nestarc/tenancy is installed but getTenantId() failed. ' +
        'Audit log will be written without tenant_id.',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** @internal Reset cached probe for testing */
export function _resetTenancyProbe(): void {
  tenancyAvailable = null;
}
