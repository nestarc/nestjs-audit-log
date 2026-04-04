export interface FieldChange {
  before?: unknown;
  after?: unknown;
}

export type Changes = Record<string, FieldChange>;

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
  if (trackedModels && trackedModels.length > 0) {
    return trackedModels.includes(model);
  }
  if (ignoredModels && ignoredModels.length > 0) {
    return !ignoredModels.includes(model);
  }
  return false;
}

export function computeCreateChanges(
  after: Record<string, unknown>,
  sensitiveFields: string[],
): Changes {
  const changes: Changes = {};
  for (const [key, value] of Object.entries(after)) {
    changes[key] = {
      after: sensitiveFields.includes(key) ? '[REDACTED]' : value,
    };
  }
  return changes;
}

export function computeUpdateChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  sensitiveFields: string[],
): Changes {
  const changes: Changes = {};
  for (const [key, value] of Object.entries(after)) {
    if (!isDeepEqual(before[key], value)) {
      changes[key] = {
        before: sensitiveFields.includes(key) ? '[REDACTED]' : before[key],
        after: sensitiveFields.includes(key) ? '[REDACTED]' : value,
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
      before: sensitiveFields.includes(key) ? '[REDACTED]' : value,
    };
  }
  return changes;
}
