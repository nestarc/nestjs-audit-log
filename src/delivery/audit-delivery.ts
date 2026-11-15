import { randomUUID } from 'node:crypto';
import type { AuditSharedOptions } from '../interfaces/audit-shared-options.interface';
import { resolveAuditProvider } from '../sql/provider';

/** The transaction already containing the business change and audit INSERT. */
export interface AuditDeliveryTransaction {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $executeRawUnsafe?(query: string, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $queryRawUnsafe?<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Versioned, immutable delivery allowlist. Metadata, changes, IP addresses and
 * other audit storage fields are deliberately absent. auditId is the stored
 * audit row ID and remains the delivery identity across Outbox retries.
 */
export interface AuditDeliveryRecord {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly actorType: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly source: 'manual' | 'auto';
  readonly result: 'success' | 'failure';
  readonly correlationId: string | null;
}

/**
 * Stage durable delivery using the supplied PostgreSQL transaction only.
 * Resolve after staging, not after external delivery; do not open a separate
 * transaction, commit the supplied transaction or perform network side effects.
 * Rejection rolls back the managed audit transaction. Custom adapters own their
 * storage atomicity and recovery contract.
 */
export interface AuditDeliveryAdapter {
  enqueue(tx: AuditDeliveryTransaction, record: AuditDeliveryRecord): Promise<void>;
}

export type AuditDeliveryRecordInput = Omit<AuditDeliveryRecord, 'schemaVersion' | 'auditId'> & {
  auditId?: string;
};

/** Snapshot an allowlisted record before asynchronous storage or adapter work. */
export function createAuditDeliveryRecord(input: AuditDeliveryRecordInput): AuditDeliveryRecord {
  const auditId = input.auditId ?? randomUUID();
  if (typeof auditId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(auditId)) {
    throw new Error('[@nestarc/audit-log] delivery auditId must be a UUID.');
  }
  for (const field of ['actorType', 'action'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim().length === 0) {
      throw new Error(`[@nestarc/audit-log] delivery ${field} must be a non-blank string.`);
    }
  }
  for (const field of ['tenantId', 'actorId', 'targetType', 'targetId', 'correlationId'] as const) {
    if (input[field] !== null && typeof input[field] !== 'string') {
      throw new Error(`[@nestarc/audit-log] delivery ${field} must be a string or null.`);
    }
  }
  if (input.source !== 'manual' && input.source !== 'auto') {
    throw new Error('[@nestarc/audit-log] delivery source must be manual or auto.');
  }
  if (input.result !== 'success' && input.result !== 'failure') {
    throw new Error('[@nestarc/audit-log] delivery result must be success or failure.');
  }
  return Object.freeze({
    schemaVersion: 1,
    auditId,
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorType: input.actorType,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    source: input.source,
    result: input.result,
    correlationId: input.correlationId,
  });
}

/** Validate opt-in delivery without invoking the adapter or changing defaults. */
export function validateAuditDeliveryOptions(
  options: Pick<AuditSharedOptions, 'provider' | 'delivery'>,
): void {
  if (options.delivery === undefined) return;
  if (options.delivery === null || typeof options.delivery !== 'object' ||
      Array.isArray(options.delivery) || typeof options.delivery.enqueue !== 'function') {
    throw new Error('[@nestarc/audit-log] delivery must provide an enqueue function.');
  }
  if (resolveAuditProvider(options.provider) !== 'postgresql') {
    throw new Error('[@nestarc/audit-log] delivery requires provider "postgresql".');
  }
}
