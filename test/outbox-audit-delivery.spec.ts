import {
  AUDIT_OUTBOX_EVENT_TYPE,
  createOutboxAuditDelivery,
  type AuditDeliveryTransaction,
  type AuditOutboxEmitter,
  type AuditOutboxEmitOptions,
  type AuditOutboxEvent,
} from '../src';
import { createAuditDeliveryRecord } from '../src/delivery/audit-delivery';

function record(tenantId: string | null = 'tenant-a') {
  return createAuditDeliveryRecord({
    tenantId, actorId: 'operator-1', actorType: 'user', action: 'invoice.update',
    targetType: 'Invoice', targetId: 'invoice-1', source: 'manual', result: 'success',
    correlationId: 'request-1',
  });
}

function transaction(): AuditDeliveryTransaction {
  return { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
}

describe('createOutboxAuditDelivery', () => {
  it('uses the exact existing transaction with stable versioned identity and explicit tenant scope', async () => {
    const emit = jest.fn().mockResolvedValue(undefined);
    const delivery = createOutboxAuditDelivery({ emit });
    const tx = transaction();
    const audit = record();
    await delivery.enqueue(tx, audit);
    await delivery.enqueue(tx, audit);
    expect(emit).toHaveBeenCalledTimes(2);
    for (const [actualTx, event, options] of emit.mock.calls) {
      expect(actualTx).toBe(tx);
      expect(event.getEventType()).toBe('nestarc.audit.recorded.v1');
      expect(event.getEventType()).toBe(AUDIT_OUTBOX_EVENT_TYPE);
      expect(event.toPayload()).toEqual(audit);
      expect(options).toEqual({
        tenantId: 'tenant-a', idempotencyKey: audit.auditId,
        correlationId: 'request-1', causationId: audit.auditId,
      });
    }
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('passes explicit global scope so an emitter cannot substitute an ambient tenant', async () => {
    const emit = jest.fn().mockResolvedValue(undefined);
    const audit = { ...record(null), correlationId: null };
    await createOutboxAuditDelivery({ emit }).enqueue(transaction(), audit);
    expect(emit.mock.calls[0][2]).toEqual({
      tenantScope: 'global', idempotencyKey: audit.auditId,
      correlationId: audit.auditId, causationId: audit.auditId,
    });
    expect(emit.mock.calls[0][2]).not.toHaveProperty('tenantId');
  });

  it('snapshots before asynchronous emitter work and provides detached allowlisted payloads', async () => {
    let captured: AuditOutboxEvent | undefined;
    let resolve!: () => void;
    const waiting = new Promise<void>(done => { resolve = done; });
    const emit = jest.fn(async (_tx: AuditDeliveryTransaction, event: AuditOutboxEvent) => {
      captured = event;
      await waiting;
    });
    const audit = { ...record(), metadata: { password: 'secret' }, changes: { token: 'secret' } };
    const pending = createOutboxAuditDelivery({ emit }).enqueue(transaction(), audit);
    audit.action = 'changed';
    audit.tenantId = 'tenant-b';
    expect(captured!.toPayload()).not.toHaveProperty('metadata');
    expect(captured!.toPayload()).not.toHaveProperty('changes');
    const payload = captured!.toPayload();
    payload.action = 'transport-mutated';
    expect(captured!.toPayload()).toMatchObject({ action: 'invoice.update', tenantId: 'tenant-a' });
    resolve();
    await pending;
  });

  it('binds the original emitter method and preserves adapter rejection identity', async () => {
    const failure = new Error('outbox write failed');
    const emitter: AuditOutboxEmitter & { reason: Error } = {
      reason: failure,
      emit(_tx: AuditDeliveryTransaction, _event: AuditOutboxEvent, _options: AuditOutboxEmitOptions) {
        return Promise.reject(this.reason);
      },
    };
    const adapter = createOutboxAuditDelivery(emitter);
    emitter.emit = jest.fn().mockResolvedValue(undefined);
    await expect(adapter.enqueue(transaction(), record())).rejects.toBe(failure);
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(Object.isFrozen(adapter)).toBe(true);
  });

  it.each([undefined, null, [], {}, { emit: true }])('rejects malformed emitters: %j', emitter => {
    expect(() => createOutboxAuditDelivery(emitter as any)).toThrow('emit function');
  });
});
