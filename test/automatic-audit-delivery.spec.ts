import { AuditContext } from '../src/services/audit-context';
import { createAuditExtension } from '../src/prisma/audit-extension';
import type { AuditExtensionOptions } from '../src/prisma/audit-extension';
import type { AuditDeliveryRecord } from '../src/delivery/audit-delivery';

const actor = { id: 'operator-1', type: 'user' as const, ip: '192.0.2.1' };
const created = { id: 'user-1', name: 'Created', password: 'private-value' };

function mockClient() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $extends: jest.fn((extension: any) => extension),
    user: {
      findFirst: jest.fn().mockResolvedValue(created),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function fixture(overrides: Partial<AuditExtensionOptions> = {}) {
  const enqueue = jest.fn<Promise<void>, [any, AuditDeliveryRecord]>()
    .mockResolvedValue(undefined);
  const options: AuditExtensionOptions = {
    consistency: 'atomic-required',
    trackedModels: ['User'],
    tenantResolver: () => 'tenant-a',
    tenantRequired: true,
    logger: { warn: jest.fn(), error: jest.fn() },
    delivery: { enqueue },
    prismaModule: {
      Prisma: {
        defineExtension: (factory: any) => factory,
        raw: (table: string) => ({ table }),
      },
    },
    ...overrides,
  };
  const factory = createAuditExtension(options);
  const base = mockClient();
  const tx = mockClient();
  const extension = factory(base);
  const handlers = extension.query.$allModels;
  const methods = extension.client;
  const committed = jest.fn();
  const host = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
      const result = await work(tx);
      committed();
      return result;
    },
  };
  const run = (work: (client: typeof tx) => Promise<unknown>) => AuditContext.run(
    {
      actor,
      noAudit: false,
      metadata: { correlationId: 'request-a', secret: 'private-metadata' },
    },
    () => methods.withAuditTransaction.call(host, work),
  );
  const create = (query = jest.fn().mockResolvedValue(created)) => handlers.create({
    model: 'User', args: { data: created }, query,
  });
  return { options, enqueue, base, tx, handlers, methods, host, committed, run, create };
}

function insertValues(client: ReturnType<typeof mockClient>, index = 0): unknown[] {
  return client.$executeRaw.mock.calls[index].slice(1);
}

describe('automatic transactional audit delivery', () => {
  it('rejects best-effort delivery and SQL Server before any adapter work', () => {
    const enqueue = jest.fn();
    expect(() => fixture({ consistency: 'best-effort', delivery: { enqueue } }))
      .toThrow('automatic audit delivery requires consistency: "atomic-required"');
    expect(() => fixture({ provider: 'sqlserver', delivery: { enqueue } }))
      .toThrow('not supported for provider "sqlserver"');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([null, {}, { enqueue: true }])('rejects malformed adapter %p', delivery => {
    expect(() => fixture({ delivery: delivery as any }))
      .toThrow('delivery must provide an enqueue function');
  });

  it('inserts an explicit UUID then awaits an immutable allowlisted record on the same transaction', async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.enqueue.mockImplementation(async (client, record) => {
      expect(client).toBe(f.tx);
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(insertValues(f.tx)[0]).toBe(record.auditId);
      expect(Object.isFrozen(record)).toBe(true);
      entered();
      await pending;
    });

    const completion = f.run(() => f.create());
    await started;
    expect(f.committed).not.toHaveBeenCalled();
    release();
    await expect(completion).resolves.toEqual(created);
    expect(f.committed).toHaveBeenCalledTimes(1);
    expect(f.base.$executeRaw).not.toHaveBeenCalled();
    const record = f.enqueue.mock.calls[0][1];
    expect(record).toEqual({
      schemaVersion: 1,
      auditId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      tenantId: 'tenant-a', actorId: actor.id, actorType: 'user',
      action: 'User.created', targetType: 'User', targetId: created.id,
      source: 'auto', result: 'success', correlationId: 'request-a',
    });
    expect(JSON.stringify(record)).not.toMatch(/private|192\.0\.2|password|changes|metadata/);
    expect(f.tx.$executeRaw.mock.calls[0][0].join('?')).toContain('?::uuid');
  });

  it('preserves the existing INSERT shape and database ID default when delivery is absent', async () => {
    const f = fixture({ delivery: undefined });
    await f.run(() => f.create());
    const sql = f.tx.$executeRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('(tenant_id, actor_id, actor_type, actor_ip, action,');
    expect(sql).not.toContain('(id, tenant_id');
    expect(insertValues(f.tx)).toHaveLength(11);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('uses the configured audit table and links delivery to its explicit audit ID', async () => {
    const f = fixture({ tableName: 'compliance_audit' });
    await f.run(() => f.create());
    expect(insertValues(f.tx)[0]).toEqual({ table: 'compliance_audit' });
    expect(insertValues(f.tx)[1]).toBe(f.enqueue.mock.calls[0][1].auditId);
    expect(f.enqueue.mock.calls[0][0]).toBe(f.tx);
  });

  it('does not enqueue after an audit INSERT failure', async () => {
    const error = new Error('audit storage failed');
    const f = fixture();
    f.tx.$executeRaw.mockRejectedValueOnce(error);
    await expect(f.run(() => f.create())).rejects.toBe(error);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.committed).not.toHaveBeenCalled();
  });

  it.each(['reject', 'throw'] as const)(
    'prevents transaction success when application catches an enqueue %s',
    async mode => {
      const error = new Error('durable staging failed');
      const onAuditError = jest.fn();
      const f = fixture({ onAuditError });
      if (mode === 'reject') f.enqueue.mockRejectedValueOnce(error);
      else f.enqueue.mockImplementationOnce(() => { throw error; });
      const completion = f.run(async () => {
        await expect(f.create()).rejects.toBe(error);
        return 'application caught the error';
      });
      await expect(completion).rejects.toBe(error);
      expect(f.committed).not.toHaveBeenCalled();
      expect(onAuditError).toHaveBeenCalledWith(error, expect.objectContaining({
        phase: 'delivery', code: 'AUDIT_DELIVERY_FAILED', tenantId: 'tenant-a',
        action: 'User.created', targetId: created.id,
      }));
    },
  );

  it('captures the adapter method at construction while preserving its receiver', async () => {
    const records: AuditDeliveryRecord[] = [];
    const adapter = {
      records,
      enqueue(_tx: unknown, record: AuditDeliveryRecord): Promise<void> {
        this.records.push(record);
        return Promise.resolve();
      },
    };
    const f = fixture({ delivery: adapter });
    adapter.enqueue = jest.fn().mockRejectedValue(new Error('replaced method'));
    await f.run(() => f.create());
    expect(records).toHaveLength(1);
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });

  it('keeps tenant, actor and correlation snapshots isolated across concurrent transactions', async () => {
    const f = fixture({ tenantResolver: () => AuditContext.getMetadata()?.tenant as string });
    const runTenant = (tenant: string) => AuditContext.run({
      actor: { id: `${tenant}-operator`, type: 'api_key' }, noAudit: false,
      metadata: { tenant, correlationId: `${tenant}-request` },
    }, () => f.methods.withAuditTransaction.call(f.host, () => f.create()));
    await Promise.all([runTenant('tenant-a'), runTenant('tenant-b')]);
    const records = f.enqueue.mock.calls.map(([, record]) => record);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: 'tenant-a', actorId: 'tenant-a-operator', correlationId: 'tenant-a-request' }),
      expect.objectContaining({ tenantId: 'tenant-b', actorId: 'tenant-b-operator', correlationId: 'tenant-b-request' }),
    ]));
    expect(new Set(records.map(record => record.auditId)).size).toBe(2);
  });

  it('emits one record per audited deleteMany row, with unique audit identities', async () => {
    const f = fixture();
    const rows = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }];
    f.tx.user.findMany.mockResolvedValue(rows);
    f.tx.user.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(rows.find(row => row.id === where.id)));
    await f.run(() => f.handlers.deleteMany({
      model: 'User', args: { where: {} }, query: jest.fn().mockResolvedValue({ count: 2 }),
    }));
    const records = f.enqueue.mock.calls.map(([, record]) => record);
    expect(records.map(record => record.targetId)).toEqual(['one', 'two']);
    expect(records.map(record => record.action)).toEqual(['User.deleted', 'User.deleted']);
    expect(new Set(records.map(record => record.auditId)).size).toBe(2);
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(2);
    records.forEach((record, index) => expect(insertValues(f.tx, index)[0]).toBe(record.auditId));
  });

  it.each(['createMany', 'updateMany'])('preserves atomic %s rejection before mutation and delivery', async operation => {
    const f = fixture();
    const query = jest.fn();
    await expect(f.run(() => f.handlers[operation]({
      model: 'User', args: { data: [] }, query,
    }))).rejects.toThrow('atomic-required');
    expect(query).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('does not duplicate delivery when a lifecycle rewrite suppresses the outer delete', async () => {
    const f = fixture();
    const before = { id: 'user-1', deletedAt: null };
    const after = { ...before, deletedAt: new Date('2026-11-15T00:00:00Z') };
    f.tx.user.findFirst
      .mockResolvedValueOnce(before).mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before).mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    await f.run(() => f.handlers.delete({
      model: 'User', args: { where: { id: before.id } },
      query: () => f.methods.withAuditLifecycle({
        action: 'User.softDeleted',
        metadata: { lifecycle: 'soft-delete' },
        suppressOuterOperation: { model: 'User', operation: 'delete' },
      }, () => f.handlers.update({
        model: 'User', args: { where: { id: before.id }, data: { deletedAt: after.deletedAt } },
        query: jest.fn().mockResolvedValue(after),
      })),
    }));
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0][1]).toMatchObject({ action: 'User.softDeleted', targetId: before.id });
  });

  it('never starts a tracked mutation outside the managed transaction', async () => {
    const f = fixture();
    const query = jest.fn();
    await expect(f.create(query)).rejects.toThrow('must run inside withAuditTransaction');
    expect(query).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
