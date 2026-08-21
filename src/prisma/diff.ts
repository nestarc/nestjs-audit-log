export interface FieldChange {
  before?: unknown;
  after?: unknown;
}

export type Changes = Record<string, FieldChange>;

export function getSensitiveFieldsFor(
  model: string | null,
  options: {
    sensitiveFields?: string[];
    sensitiveFieldsByModel?: Record<string, string[]>;
  },
): string[] {
  return Array.from(
    new Set([
      ...(options.sensitiveFields ?? []),
      ...(model ? options.sensitiveFieldsByModel?.[model] ?? [] : []),
    ]),
  );
}

export function redactObject(
  obj: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const sensitiveFields = new Set(fields);
  return redactNestedValue(obj, sensitiveFields) as Record<string, unknown>;
}

function redactNestedValue(
  value: unknown,
  sensitiveFields: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactNestedValue(item, sensitiveFields));
  }
  if (value === null || typeof value !== 'object' || !isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      sensitiveFields.has(key)
        ? '[REDACTED]'
        : redactNestedValue(child, sensitiveFields),
    ]),
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactFieldValue(
  key: string,
  value: unknown,
  sensitiveFields: string[],
): unknown {
  if (sensitiveFields.includes(key)) {
    return '[REDACTED]';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return redactNestedValue(value, new Set(sensitiveFields));
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

export function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined)
    return false;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (typeof a === 'object' && typeof b === 'object')
    return stableStringify(a) === stableStringify(b);
  return false;
}

export function shouldTrackModel(
  model: string,
  trackedModels?: string[],
  ignoredModels?: string[],
): boolean {
  if (trackedModels !== undefined) {
    return trackedModels.includes(model);
  }
  if (ignoredModels && ignoredModels.length > 0) {
    return !ignoredModels.includes(model);
  }
  return true;
}

export function computeCreateChanges(
  after: Record<string, unknown>,
  sensitiveFields: string[],
): Changes {
  const changes: Changes = {};
  for (const [key, value] of Object.entries(after)) {
    changes[key] = {
      after: redactFieldValue(key, value, sensitiveFields),
    };
  }
  return changes;
}

export function computeUpdateChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  sensitiveFields: string[],
  ignoreFields: readonly string[] = [],
): Changes {
  const changes: Changes = {};
  for (const [key, value] of Object.entries(after)) {
    if (ignoreFields.includes(key)) {
      continue;
    }
    if (!isDeepEqual(before[key], value)) {
      changes[key] = {
        before: redactFieldValue(key, before[key], sensitiveFields),
        after: redactFieldValue(key, value, sensitiveFields),
      };
    }
  }
  return changes;
}

export function computeDeleteChanges(
  before: Record<string, unknown>,
  sensitiveFields: string[],
): Changes {
  const changes: Changes = {};
  for (const [key, value] of Object.entries(before)) {
    changes[key] = {
      before: redactFieldValue(key, value, sensitiveFields),
    };
  }
  return changes;
}
