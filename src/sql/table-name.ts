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
