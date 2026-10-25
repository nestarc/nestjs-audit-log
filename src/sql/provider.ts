/** Database used by the audit storage. PostgreSQL remains the default. */
export type AuditDatabaseProvider = 'postgresql' | 'sqlserver';

export function resolveAuditProvider(provider?: AuditDatabaseProvider): AuditDatabaseProvider {
  if (provider === undefined) return 'postgresql';
  if (provider !== 'postgresql' && provider !== 'sqlserver') {
    throw new Error('[@nestarc/audit-log] provider must be "postgresql" or "sqlserver"');
  }
  return provider;
}

export function assertPostgresProvider(
  provider: AuditDatabaseProvider | undefined,
  operation: string,
): void {
  if (resolveAuditProvider(provider) === 'sqlserver') {
    throw new Error(
      `[@nestarc/audit-log] ${operation} is not supported for provider "sqlserver"; ` +
        'SQL Server currently supports manual audit logging and schema installation only.',
    );
  }
}
