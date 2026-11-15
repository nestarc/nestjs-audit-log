import {
  createAuditDeliveryRecord,
  type AuditDeliveryAdapter,
  type AuditDeliveryRecord,
  type AuditDeliveryTransaction,
} from './audit-delivery';

/** Stable event type for the version 1 audit delivery allowlist. */
export const AUDIT_OUTBOX_EVENT_TYPE = 'nestarc.audit.recorded.v1';

/** Structural OutboxEvent contract; no runtime Outbox dependency is required. */
export interface AuditOutboxEvent {
  getEventType(): string;
  toPayload(): Record<string, unknown>;
}

/** Explicit tenant scope and stable lineage passed to the Outbox emitter. */
export type AuditOutboxEmitOptions = {
  idempotencyKey: string;
  correlationId: string;
  causationId: string;
} & ({ tenantId: string; tenantScope?: never } | { tenantScope: 'global'; tenantId?: never });

/** Compatible with an application's @nestarc/outbox OutboxEmitter instance. */
export interface AuditOutboxEmitter {
  emit(
    tx: AuditDeliveryTransaction,
    event: AuditOutboxEvent,
    options: AuditOutboxEmitOptions,
  ): Promise<void>;
}

/**
 * Stage an audit event in the same PostgreSQL transaction through OutboxEmitter.
 * The emitter and Outbox schema are application-owned. Use a PostgreSQL managed
 * manual transaction or atomic-required Prisma tracking. Publishing remains
 * Outbox's at-least-once delivery; consumers deduplicate by payload.auditId.
 * No mapper or raw metadata is exposed by this initial event contract.
 */
export function createOutboxAuditDelivery(emitter: AuditOutboxEmitter): AuditDeliveryAdapter {
  if (emitter === null || typeof emitter !== 'object' || Array.isArray(emitter) ||
      typeof emitter.emit !== 'function') {
    throw new Error('[@nestarc/audit-log] Outbox emitter must provide an emit function.');
  }
  const emit = emitter.emit.bind(emitter);
  return Object.freeze({
    async enqueue(tx: AuditDeliveryTransaction, input: AuditDeliveryRecord): Promise<void> {
      const record = createAuditDeliveryRecord(input);
      const event: AuditOutboxEvent = Object.freeze({
        getEventType: () => AUDIT_OUTBOX_EVENT_TYPE,
        // Fresh primitive-only payloads prevent a transport from mutating the snapshot.
        toPayload: () => ({ ...record }),
      });
      const lineage = {
        idempotencyKey: record.auditId,
        correlationId: record.correlationId ?? record.auditId,
        causationId: record.auditId,
      };
      const options: AuditOutboxEmitOptions = record.tenantId === null
        ? { ...lineage, tenantScope: 'global' }
        : { ...lineage, tenantId: record.tenantId };
      await emit(tx, event, options);
    },
  });
}
