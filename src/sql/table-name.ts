const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_TABLE_PART_LENGTH = 44;

export function validateAuditTableName(tableName = 'audit_logs'): string {
  const parts = tableName.split('.');
  const tablePart = parts[parts.length - 1];
  const valid =
    (parts.length === 1 || parts.length === 2) &&
    parts.every((part) => IDENTIFIER_PATTERN.test(part)) &&
    tablePart.length <= MAX_TABLE_PART_LENGTH;

  if (!valid) {
    throw new Error(
      `[@nestarc/audit-log] Invalid audit tableName '${tableName}'. ` +
        'Use identifier or schema.identifier form with letters, digits, and underscores; ' +
        `the table part must be ${MAX_TABLE_PART_LENGTH} characters or fewer.`,
    );
  }

  return tableName;
}

/** SQL Server uses dbo unless an explicit schema is part of tableName. */
export function getSqlServerTableName(tableName?: string): {
  schema: string;
  table: string;
  quoted: string;
  qualified: string;
} {
  const parts = validateAuditTableName(tableName).split('.');
  const schema = parts.length === 2 ? parts[0] : 'dbo';
  const table = parts[parts.length - 1];
  if (schema.length > 128) {
    throw new Error(
      '[@nestarc/audit-log] Invalid audit tableName: SQL Server schema names must be 128 characters or fewer.',
    );
  }
  return { schema, table, quoted: `[${schema}].[${table}]`, qualified: `${schema}.${table}` };
}
