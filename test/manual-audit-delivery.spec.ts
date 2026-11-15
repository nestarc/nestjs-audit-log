import { AuditContext } from '../src/services/audit-context';
import { AuditService } from '../src/services/audit.service';
import type { AuditDeliveryRecord } from '../src/delivery/audit-delivery';
import type { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import type { ManualAuditLogInput } from '../src/interfaces/audit-entry.interface';

interface SqlStatement {
  strings: readonly string[];
  values: unknown[];
}

interface TestTransaction {
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
  statements: SqlStatement[];
  deliveries: AuditDeliveryRecord[];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture(overrides: Partial<AuditLogModuleOptions> = {}) {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(1), $queryRaw: jest.fn() };
  const transactions: TestTransaction[] = [];
  const commits: TestTransaction[] = [];
  const rollbacks: unknown[] = [];
  const enqueue = jest.fn(async (tx: any, record: AuditDeliveryRecord) => {
    (tx as TestTransaction).deliveries.push(record);
  });
  const delivery = { enqueue };
  const onAuditError = jest.fn();
  const options: AuditLogModuleOptions = {
    prisma,
    actorExtractor: () => ({ id: null, type: 'system' }),
    prismaModule: { Prisma: {
      defineExtension: jest.fn(), raw: (value: string) => ({ raw: value }),
      sql: (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => ({ strings, values }),
      join: jest.fn(), empty: {},
    } },
    delivery,
    onAuditError,
    logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
  const service = new AuditService(options);
  const client = {
    async $transaction<T>(callback: (tx: TestTransaction) => Promise<T>): Promise<T> {
      const tx: TestTransaction = {
        $executeRaw: jest.fn(), $queryRaw: jest.fn(), statements: [], deliveries: [],
      };
      tx.$executeRaw.mockImplementation(async (statement: SqlStatement) => {
        tx.statements.push(statement);
        return 1;
      });
      transactions.push(tx);
      try {
        const result = await callback(tx);
        commits.push(tx);
        return result;
      } catch (error) {
        rollbacks.push(error);
        throw error;
      }
    },
  };
  return { prisma, transactions, commits, rollbacks, enqueue, delivery, options, service, client, onAuditError };
}

describe('managed manual audit delivery', () => {
  it.each([undefined, 'audit.audit_events'])('inserts matching immutable delivery identity on the same tx (%s)', async tableName => {
    const f = fixture({ tableName, tenantResolver: () => 'tenant-a' });
    const result = await AuditContext.run({
      actor: { id: 'actor-a', type: 'user', ip: '192.0.2.1' }, noAudit: false,
      metadata: { correlationId: 'request-a', contextSecret: 'context-secret' },
    }, () => f.service.withManualTransaction(f.client, async ({ tx, log }) => {
      await log({
        action: 'invoice.approved', targetType: 'Invoice', targetId: 'invoice-a',
        result: 'failure', metadata: { password: 'secret', changes: { amount: 4 } },
      });
      expect(f.enqueue).toHaveBeenCalledWith(tx, expect.any(Object));
      return 42;
    }));
    expect(result).toBe(42);
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    const tx = f.commits[0];
    expect(tx.statements).toHaveLength(1);
    expect(tx.deliveries).toHaveLength(1);
    const record = tx.deliveries[0];
    expect(record).toEqual({
      schemaVersion: 1, auditId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      tenantId: 'tenant-a', actorId: 'actor-a', actorType: 'user',
      action: 'invoice.approved', targetType: 'Invoice', targetId: 'invoice-a',
      source: 'manual', result: 'failure', correlationId: 'request-a',
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(tx.statements[0].values).toContain(record.auditId);
    expect(tx.statements[0].strings.join('')).toMatch(/\(id, tenant_id,/);
    expect(tx.statements[0].strings.join('')).toContain('::uuid');
    if (tableName) expect(tx.statements[0].values[0]).toEqual({ raw: tableName });
    else expect(tx.statements[0].strings.join('')).toContain('INSERT INTO audit_logs');
    expect(JSON.stringify(record)).not.toMatch(/secret|password|changes|192\.0\.2\.1/);
  });

  it('does not permit standalone, external or ambient-scope log calls with delivery', async () => {
    const f = fixture();
    const other = fixture();
    const external = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
    await expect(f.service.log({ action: 'standalone' })).rejects.toThrow('withManualTransaction');
    await expect(f.service.log({ action: 'external' }, external)).rejects.toThrow('withManualTransaction');
    await f.service.withManualTransaction(f.client, async ({ tx, log }) => {
      await expect(f.service.log({ action: 'same-tx' }, tx)).rejects.toThrow('withManualTransaction');
      await expect(f.service.log({ action: 'wrong-tx' }, external)).rejects.toThrow('withManualTransaction');
      await expect(other.service.log({ action: 'other-service' }, tx)).rejects.toThrow('withManualTransaction');
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      await log({ action: 'managed' });
    });
    expect(external.$executeRaw).not.toHaveBeenCalled();
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(other.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(other.enqueue).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('enqueue rejected'), null, undefined])('poisons the managed transaction on a caught enqueue rejection: %s', async original => {
    const f = fixture();
    f.enqueue.mockImplementation(() => { throw original; });
    await expect(f.service.withManualTransaction(f.client, async ({ log }) => {
      try { await log({ action: 'event' }); } catch (error) { expect(error).toBe(original); }
      return 'must-not-commit';
    })).rejects.toBe(original);
    expect(f.commits).toHaveLength(0);
    expect(f.rollbacks).toEqual([original]);
    expect(f.transactions[0].statements).toHaveLength(1);
    expect(f.onAuditError).toHaveBeenCalledWith(original, expect.objectContaining({
      phase: 'delivery', code: 'AUDIT_DELIVERY_FAILED', operation: 'log',
    }));
  });

  it('does not enqueue after an audit INSERT fails and preserves its error', async () => {
    const f = fixture();
    const original = new Error('insert rejected');
    await expect(f.service.withManualTransaction(f.client, async ({ tx, log }) => {
      tx.$executeRaw.mockRejectedValue(original);
      try { await log({ action: 'event' }); } catch { /* The scope still must roll back. */ }
    })).rejects.toBe(original);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.commits).toHaveLength(0);
    expect(f.onAuditError).toHaveBeenCalledWith(original, expect.objectContaining({ phase: 'insert' }));
  });

  it('rolls back staged audit and delivery after a business callback fails', async () => {
    const f = fixture();
    const original = new Error('business rejected');
    await expect(f.service.withManualTransaction(f.client, async ({ log }) => {
      await log({ action: 'event' });
      throw original;
    })).rejects.toBe(original);
    expect(f.transactions[0].statements).toHaveLength(1);
    expect(f.transactions[0].deliveries).toHaveLength(1);
    expect(f.commits).toHaveLength(0);
  });

  it('awaits an unawaited writer until its enqueue settles before committing', async () => {
    const f = fixture();
    const started = deferred();
    const release = deferred();
    f.enqueue.mockImplementation(async (tx: any, record: AuditDeliveryRecord) => {
      started.resolve();
      await release.promise;
      (tx as TestTransaction).deliveries.push(record);
    });
    const completion = f.service.withManualTransaction(f.client, async ({ log }) => {
      void log({ action: 'unawaited' });
      return 7;
    });
    await started.promise;
    expect(f.commits).toHaveLength(0);
    release.resolve();
    await expect(completion).resolves.toBe(7);
    expect(f.commits[0].deliveries).toHaveLength(1);
  });

  it('observes an unawaited enqueue rejection and rejects the transaction', async () => {
    const f = fixture();
    const original = new Error('unawaited enqueue rejected');
    f.enqueue.mockRejectedValue(original);
    await expect(f.service.withManualTransaction(f.client, async ({ log }) => {
      void log({ action: 'unawaited' });
    })).rejects.toBe(original);
    expect(f.commits).toHaveLength(0);
    expect(f.rollbacks).toEqual([original]);
  });

  it('revokes an escaped writer so it cannot insert or enqueue after the scope closes', async () => {
    const f = fixture();
    let escaped!: (input: ManualAuditLogInput) => Promise<void>;
    await f.service.withManualTransaction(f.client, async ({ log }) => { escaped = log; });
    await expect(escaped({ action: 'late' })).rejects.toThrow('scope has ended');
    expect(f.transactions[0].$executeRaw).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('snapshots input, actor, tenant and correlation before awaiting the audit INSERT', async () => {
    let tenantId = 'tenant-a';
    const f = fixture({ tenantResolver: () => tenantId });
    const actor = { id: 'actor-a', type: 'user' as const };
    const event: ManualAuditLogInput = { action: 'original', targetId: 'target-a', result: 'success' };
    await AuditContext.run({ actor, noAudit: false, metadata: { correlationId: 'correlation-a' } }, () =>
      f.service.withManualTransaction(f.client, async ({ log }) => {
        const writing = log(event);
        tenantId = 'tenant-b';
        actor.id = 'actor-b';
        event.action = 'mutated';
        event.targetId = 'target-b';
        event.result = 'failure';
        AuditContext.setMetadata({ correlationId: 'correlation-b' });
        await writing;
      }),
    );
    expect(f.commits[0].deliveries[0]).toEqual(expect.objectContaining({
      tenantId: 'tenant-a', actorId: 'actor-a', action: 'original', targetId: 'target-a',
      result: 'success', correlationId: 'correlation-a',
    }));
    const values = f.commits[0].statements[0].values;
    expect(values).toContain('tenant-a');
    expect(values).toContain('actor-a');
    expect(values).toContain('original');
    expect(values).not.toContain('tenant-b');
    expect(values).not.toContain('mutated');
  });

  it('does not forward a correlation value excluded by the existing metadata redaction policy', async () => {
    const f = fixture({ sensitiveFields: ['correlationId'] });
    await f.service.withManualTransaction(f.client, async ({ log }) => {
      await log({ action: 'event', metadata: { correlationId: 'private-correlation' } });
    });
    expect(JSON.stringify(f.commits[0].deliveries[0])).not.toContain('private-correlation');
  });

  it('keeps the configured adapter when the caller mutates the options after construction', async () => {
    const f = fixture();
    const replacement = jest.fn().mockResolvedValue(undefined);
    f.delivery.enqueue = replacement;
    f.options.delivery = undefined;
    await expect(f.service.log({ action: 'still-managed-only' })).rejects.toThrow('withManualTransaction');
    await f.service.withManualTransaction(f.client, async ({ log }) => { await log({ action: 'event' }); });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(['postgresql', 'sqlserver'] as const)('preserves existing %s standalone and external log behavior without delivery', async provider => {
    const f = fixture({ provider, delivery: undefined });
    const external = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await f.service.log({ action: '' });
    await f.service.log({ action: 'external' }, external);
    expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(external.$executeRaw).toHaveBeenCalledTimes(1);
    const query = f.prisma.$executeRaw.mock.calls[0][0] as SqlStatement;
    expect(query.strings.join('')).not.toMatch(/\(id, tenant_id,/);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('preserves public log dispatch for managed transactions without delivery', async () => {
    const f = fixture({ delivery: undefined });
    const publicLog = jest.spyOn(f.service, 'log');
    await f.service.withManualTransaction(f.client, async ({ tx, log }) => {
      const event = { action: 'legacy-managed' };
      await log(event);
      expect(publicLog).toHaveBeenCalledWith(event, tx);
    });
    expect(f.commits).toHaveLength(1);
  });

  it('rejects SQL Server delivery before opening a transaction or writing SQL', () => {
    expect(() => fixture({ provider: 'sqlserver' })).toThrow('delivery requires provider "postgresql"');
  });
});
