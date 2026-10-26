import { Buffer } from 'node:buffer';
import type { ManualAuditLogInput } from '../interfaces/audit-entry.interface';

export type AuditInputErrorCode = 'AUDIT_INPUT_INVALID' | 'AUDIT_METADATA_TOO_LARGE';

/** A strict manual-input failure. Messages identify fields, never their values. */
export class AuditInputError extends Error {
  readonly name = 'AuditInputError';

  constructor(
    readonly code: AuditInputErrorCode,
    readonly field: string,
    detail: string,
  ) {
    super(`[@nestarc/audit-log] ${field} ${detail}`);
  }
}

function invalid(field: string, detail: string): never {
  throw new AuditInputError('AUDIT_INPUT_INVALID', field, detail);
}

/** Validate opt-in settings without changing existing logging defaults. */
export function validateManualAuditOptions(options: {
  strictManualValidation?: boolean;
  maxMetadataBytes?: number;
}): void {
  if (options.strictManualValidation !== undefined &&
      typeof options.strictManualValidation !== 'boolean') {
    invalid('strictManualValidation', 'must be a boolean.');
  }
  if (options.maxMetadataBytes !== undefined &&
      (!Number.isSafeInteger(options.maxMetadataBytes) || options.maxMetadataBytes < 1)) {
    invalid('maxMetadataBytes', 'must be a positive safe integer of UTF-8 JSON bytes.');
  }
}

/** Validate identity without normalizing or trimming the value to be stored. */
export function validateManualIdentity(
  value: unknown,
  field: string,
  required = false,
): void {
  if (!required && (value === undefined || value === null)) return;
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(field, 'must be a non-blank string.');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate event shape; validate merged context metadata separately before redaction. */
export function validateManualAuditInput(input: unknown): asserts input is ManualAuditLogInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', 'must be an audit event object.');
  }
  const event = input as Record<string, unknown>;
  validateManualIdentity(event.action, 'action', true);
  for (const field of ['targetType', 'targetId'] as const) {
    if (event[field] !== undefined) validateManualIdentity(event[field], field, true);
  }
  if (event.result !== undefined && event.result !== 'success' && event.result !== 'failure') {
    invalid('result', 'must be "success" or "failure".');
  }
  if (event.metadata !== undefined && !isPlainRecord(event.metadata)) {
    invalid('metadata', 'must be a plain object.');
  }
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

const MAX_METADATA_DEPTH = 64;

/**
 * Validate JSON data before recursive redaction. Reject silent JSON coercion or
 * omission; valid Dates retain JSON's normal ISO serialization. Shared references
 * are permitted, but an object cannot refer to an ancestor in the current path.
 */
export function validateManualMetadata(value: unknown, path = 'metadata'): void {
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, field: string, depth: number): void => {
    if (depth > MAX_METADATA_DEPTH) {
      invalid(field, `exceeds the maximum metadata depth of ${MAX_METADATA_DEPTH}.`);
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalid(field, 'must be a finite JSON number.');
      return;
    }
    if (typeof current !== 'object') {
      invalid(field, 'must contain a JSON-compatible value.');
    }
    if (current instanceof Date) {
      if (Object.getPrototypeOf(current) !== Date.prototype ||
          !Number.isFinite(Date.prototype.getTime.call(current)) ||
          Reflect.ownKeys(current).length !== 0) {
        invalid(field, 'must be a valid Date without custom properties.');
      }
      return;
    }
    if (!Array.isArray(current) && !isPlainRecord(current)) {
      invalid(field, 'must be a plain object, array, or JSON primitive.');
    }
    if (ancestors.has(current)) invalid(field, 'contains a circular reference.');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        for (const key of Reflect.ownKeys(current)) {
          if (key === 'length') continue;
          if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) {
            invalid(field, 'must not contain array properties that JSON would omit.');
          }
        }
        for (let index = 0; index < current.length; index++) {
          const itemField = `${field}[${index}]`;
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor) invalid(itemField, 'must not be an array hole.');
          if (!('value' in descriptor)) invalid(itemField, 'must not be an accessor property.');
          visit(descriptor.value, itemField, depth + 1);
        }
        return;
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string') invalid(field, 'must not contain symbol keys that JSON would omit.');
        const itemField = childPath(field, key);
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!descriptor.enumerable) invalid(itemField, 'must not be a non-enumerable property.');
        if (!('value' in descriptor)) invalid(itemField, 'must not be an accessor property.');
        visit(descriptor.value, itemField, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, path, 0);
}

/** Apply the size budget to the final redacted JSON, without truncating evidence. */
export function enforceManualMetadataSize(json: string | null, maxMetadataBytes?: number): void {
  if (maxMetadataBytes !== undefined && json !== null &&
      Buffer.byteLength(json, 'utf8') > maxMetadataBytes) {
    throw new AuditInputError(
      'AUDIT_METADATA_TOO_LARGE',
      'metadata',
      `exceeds maxMetadataBytes (${maxMetadataBytes} UTF-8 JSON bytes).`,
    );
  }
}
