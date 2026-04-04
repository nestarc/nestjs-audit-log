export interface FieldChange {
  before?: unknown;
  after?: unknown;
}

export type Changes = Record<string, FieldChange>;

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
    if (before[key] !== value) {
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
