import { defineAuditConfig } from '../src/define-audit-config';
import {
  createAuditDeliveryRecord,
  validateAuditDeliveryOptions,
  type AuditDeliveryAdapter,
  type AuditDeliveryRecordInput,
} from '../src/delivery/audit-delivery';

function input(): AuditDeliveryRecordInput {
  return {
    tenantId: 'tenant-a', actorId: 'operator-1', actorType: 'user',
    action: 'invoice.update', targetType: 'Invoice', targetId: 'invoice-1',
    source: 'manual', result: 'success', correlationId: 'request-1',
  };
}

describe('atomic audit delivery contract', () => {
  it('assigns distinct UUIDs and snapshots only primitive allowlisted fields', () => {
    const source = {
      ...input(), metadata: { token: 'secret' }, changes: { password: 'secret' }, ip: '127.0.0.1',
    };
    const first = createAuditDeliveryRecord(source);
    const second = createAuditDeliveryRecord(source);
    expect(first.auditId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.auditId).not.toBe(first.auditId);
    expect(first).toEqual({ ...input(), schemaVersion: 1, auditId: first.auditId });
    source.action = 'changed';
    source.tenantId = 'tenant-b';
    expect(first.action).toBe('invoice.update');
    expect(first.tenantId).toBe('tenant-a');
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain('secret');
  });

  it('preserves a supplied stored audit ID and explicit nullable identities', () => {
    const auditId = '3f273b1d-3e4a-4203-8ec8-5a5d14f79c72';
    const record = createAuditDeliveryRecord({
      ...input(), auditId, tenantId: null, actorId: null, targetType: null,
      targetId: null, correlationId: null, source: 'auto', result: 'failure',
    });
    expect(record).toMatchObject({ auditId, tenantId: null, actorId: null, source: 'auto', result: 'failure' });
  });

  it.each([
    { auditId: 'invalid' }, { action: '' }, { actorType: ' ' },
    { tenantId: { token: 'secret' } }, { actorId: undefined },
    { correlationId: { token: 'secret' } }, { targetId: ['secret'] },
    { source: 'network' }, { result: 'pending' },
  ])('rejects non-contract runtime values without disclosing them: %j', invalid => {
    expect(() => createAuditDeliveryRecord({ ...input(), ...invalid } as any)).toThrow('delivery');
    try {
      createAuditDeliveryRecord({ ...input(), ...invalid } as any);
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('leaves absent delivery valid and rejects invalid adapter/provider combinations without calling enqueue', () => {
    const enqueue = jest.fn();
    expect(() => validateAuditDeliveryOptions({})).not.toThrow();
    expect(() => validateAuditDeliveryOptions({ provider: 'sqlserver' })).not.toThrow();
    expect(() => validateAuditDeliveryOptions({ delivery: { enqueue } })).not.toThrow();
    expect(() => validateAuditDeliveryOptions({ provider: 'sqlserver', delivery: { enqueue } }))
      .toThrow('requires provider "postgresql"');
    for (const delivery of [null, [], {}, true, { enqueue: true }]) {
      expect(() => validateAuditDeliveryOptions({ delivery } as any)).toThrow('enqueue');
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('preserves an opaque adapter identity in shared config without invoking or freezing the adapter', () => {
    const delivery: AuditDeliveryAdapter = { enqueue: jest.fn() };
    const config = defineAuditConfig({
      shared: { delivery }, module: { actorExtractor: () => ({ id: 'u', type: 'user' }) },
      extension: { consistency: 'atomic-required', trackedModels: ['Invoice'] },
    });
    expect(config.moduleOptions.delivery).toBe(delivery);
    expect(config.extensionOptions.delivery).toBe(delivery);
    expect(config.schemaOptions).not.toHaveProperty('delivery');
    expect(config.partitionOptions).not.toHaveProperty('delivery');
    expect(Object.isFrozen(delivery)).toBe(false);
    expect(delivery.enqueue).not.toHaveBeenCalled();
  });

  it('validates shared delivery even in manual-only config and rejects misplaced delivery', () => {
    const module = { actorExtractor: () => ({ id: 'u', type: 'user' as const }) };
    expect(() => defineAuditConfig({ module, shared: { delivery: {} as any } })).toThrow('enqueue');
    expect(() => defineAuditConfig({
      module, shared: { provider: 'sqlserver', delivery: { enqueue: jest.fn() } },
    })).toThrow('requires provider "postgresql"');
    for (const section of ['module', 'extension', 'schema']) {
      expect(() => defineAuditConfig({ module, [section]: { ...module, delivery: undefined } } as any))
        .toThrow(`Invalid option location ${section}.`);
    }
  });
});
