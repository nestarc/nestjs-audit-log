import { AuditEntry } from '../interfaces/audit-entry.interface';

export const AUDIT_CSV_COLUMNS_V1 = [
  'schemaVersion',
  'id',
  'tenantId',
  'actorId',
  'actorType',
  'actorIp',
  'action',
  'targetType',
  'targetId',
  'source',
  'result',
  'changes',
  'metadata',
  'createdAt',
] as const;

const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Cannot serialize circular JSON.');
    seen.add(value);
    const result = value.map((item) =>
      item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? null
        : canonicalize(item, seen),
    );
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cannot serialize circular JSON.');
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol') {
        result[key] = canonicalize(item, seen);
      }
    }
    seen.delete(value);
    return result;
  }
  return null;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function escapeCsvCell(value: string): string {
  const safeValue = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeValue)
    ? `"${safeValue.replace(/"/g, '""')}"`
    : safeValue;
}

function nullable(value: string | null): string {
  return value ?? '';
}

export function serializeAuditCsvHeader(): string {
  return `${AUDIT_CSV_COLUMNS_V1.join(',')}\r\n`;
}

export function serializeAuditCsvEntry(entry: AuditEntry): string {
  const cells = [
    'v1',
    entry.id,
    nullable(entry.tenantId),
    nullable(entry.actorId),
    entry.actorType,
    nullable(entry.actorIp),
    entry.action,
    nullable(entry.targetType),
    nullable(entry.targetId),
    entry.source,
    entry.result,
    entry.changes === null ? '' : canonicalJson(entry.changes),
    entry.metadata === null ? '' : canonicalJson(entry.metadata),
    entry.createdAt.toISOString(),
  ];
  return `${cells.map(escapeCsvCell).join(',')}\r\n`;
}
