export function getTenantId(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TenancyContext } = require('@nestarc/tenancy');
    return new TenancyContext().getTenantId();
  } catch {
    return null;
  }
}
