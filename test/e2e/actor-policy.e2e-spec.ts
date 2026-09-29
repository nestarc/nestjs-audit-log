import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext, AuditService, createAuditedClient } from '../../src';
import type { AuditActor } from '../../src';
import { applyAuditTableSchema } from '../../src/sql';
import { createTestPrismaClient, prismaModule } from './prisma-client';

describe('actorRequired E2E', () => {
  const base = createTestPrismaClient();
  const onAuditError = jest.fn();
  const tenant = new AsyncLocalStorage<string>();
  const shared = {
    actorRequired: true, prismaModule, onAuditError,
    logger: { warn: jest.fn(), error: jest.fn() },
    sensitiveFields: ['password'],
    tenantResolver: () => tenant.getStore() ?? null,
  };
  const options = {
    ...shared, consistency: 'atomic-required' as const,
    trackedModels: ['User'], databaseMapping: { User: { tableName: 'users' } },
  };
  const audited: any = createAuditedClient(base, options);
  const service = new AuditService({ ...shared, prisma: base, actorExtractor: () => ({ id: null, type: 'system' }) });
  const data = { name: 'Before', email: 'actor@test.com', password: 'secret' };
  const actor: AuditActor = { id: 'user-1', type: 'user' };

  async function clearData() {
    await base.$executeRawUnsafe('DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs');
    await base.$executeRawUnsafe('DROP TRIGGER IF EXISTS audit_logs_no_delete_trg ON audit_logs');
    await base.$executeRaw`DELETE FROM audit_logs`;
    await base.user.deleteMany();
    await applyAuditTableSchema(base, { enforcement: 'trigger' });
  }

  beforeEach(async () => { await clearData(); onAuditError.mockClear(); });
  afterAll(async () => { await clearData(); await base.$disconnect(); });

  it.each([null, { id: null, type: 'system' }, { id: '', type: 'user' }, { id: ' \t ', type: 'api_key' }] as Array<AuditActor | null>)(
    'rejects invalid actor %j before business mutation, inside and outside helper', async invalidActor => {
      await AuditContext.run({ actor: invalidActor, noAudit: false }, async () => {
        await expect(audited.user.create({ data })).rejects.toThrow('actorRequired');
        await expect(audited.withAuditTransaction((tx: any) => tx.user.create({ data }))).rejects.toThrow('actorRequired');
      });
      expect(await base.user.count()).toBe(0);
      expect(await base.auditLog.count()).toBe(0);
    },
  );

  it.each(['create', 'deleteMany', 'lifecycle'] as const)('caught %s policy error rolls back earlier business and audit rows', async operation => {
    let caught: unknown;
    const completion = AuditContext.runAs(actor, () => audited.withAuditTransaction(async (tx: any) => {
      await tx.user.create({ data });
      expect(await tx.auditLog.count()).toBe(1);
      await AuditContext.run({ actor: null, noAudit: false }, async () => {
        try {
          if (operation === 'create') await tx.user.create({ data: { ...data, email: 'second@test.com' } });
          else if (operation === 'deleteMany') await tx.user.deleteMany();
          else await audited.withAuditLifecycle({ action: 'User.archived' }, (lifecycleTx: any) =>
            lifecycleTx.user.update({ where: { email: data.email }, data: { name: 'Archived' } }),
          );
        } catch (error) { caught = error; }
      });
      expect(caught).toBeInstanceOf(Error);
      expect(await tx.user.count()).toBe(1);
      expect((await tx.user.findUnique({ where: { email: data.email } })).name).toBe('Before');
      expect(await tx.auditLog.count()).toBe(1);
    }));
    await expect(completion).rejects.toThrow('actorRequired');
    await expect(completion).rejects.toBe(caught);
    expect(await base.user.count()).toBe(0);
    expect(await base.auditLog.count()).toBe(0);
  });

  it('best-effort reports missing actors, skips audit rows, and preserves DB result and errors', async () => {
    const client: any = createAuditedClient(base, { ...options, consistency: 'best-effort', logFailures: true });
    const result = await client.user.create({ data });
    expect(await base.user.findUnique({ where: { id: result.id } })).toEqual(result);
    await expect(client.user.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    expect(await base.auditLog.count()).toBe(0);
    expect(onAuditError).toHaveBeenCalledTimes(2);
    expect(onAuditError).toHaveBeenCalledWith(expect.any(Error), { phase: 'context', model: 'User', operation: 'create' });
  });

  it.each(['propagate', 'catch'] as const)('manual external transaction: %s determines rollback or commit', async mode => {
    const completion = base.$transaction(async tx => {
      await tx.user.create({ data });
      if (mode === 'catch') {
        await expect(service.log({ action: 'User.created' }, tx)).rejects.toThrow('actorRequired');
      } else {
        await service.log({ action: 'User.created' }, tx);
      }
    });
    if (mode === 'catch') await completion;
    else await expect(completion).rejects.toThrow('actorRequired');
    expect(await base.user.count()).toBe(mode === 'catch' ? 1 : 0);
    expect(await base.auditLog.count()).toBe(0);
  });

  it('does not attach manual policy failures to the automatic helper registry', async () => {
    await AuditContext.runAs(actor, () => audited.withAuditTransaction(async (tx: any) => {
      await tx.user.create({ data });
      await AuditContext.run({ actor: null, noAudit: false }, async () => {
        await expect(service.log({ action: 'manual' }, tx)).rejects.toThrow('actorRequired');
      });
    }));
    expect(await base.user.count()).toBe(1);
    expect(await base.auditLog.count()).toBe(1);
  });

  it('keeps actors, tenants and masking correct across concurrent automatic/manual workers', async () => {
    const strictOptions = { ...options, tenantRequired: true };
    const client: any = createAuditedClient(base, strictOptions);
    const manual = new AuditService({ ...shared, tenantRequired: true, prisma: base, actorExtractor: () => actor });
    await Promise.all((['user', 'system', 'api_key'] as const).map(type =>
      tenant.run(`tenant-${type}`, () => AuditContext.runAs({ id: ` ${type}-actor `, type }, () =>
        client.withAuditTransaction(async (tx: any) => {
          const user = await tx.user.create({ data: { ...data, email: `${type}@test.com` } });
          await manual.log({ action: 'manual', targetType: 'User', targetId: user.id, metadata: { password: 'secret', type } }, tx);
        }),
      )),
    ));
    for (const type of ['user', 'system', 'api_key']) {
      const result = await manual.query({ tenantId: `tenant-${type}` });
      expect(result.entries).toHaveLength(2);
      for (const row of result.entries) {
        expect(row.actorId).toBe(` ${type}-actor `);
        expect(row.actorType).toBe(type);
        expect(row.tenantId).toBe(`tenant-${type}`);
        expect(JSON.stringify(row)).not.toContain('secret');
      }
      expect(result.entries.find(row => row.source === 'auto')!.changes).toMatchObject({ password: { after: '[REDACTED]' } });
      expect(result.entries.find(row => row.source === 'manual')!.metadata).toMatchObject({ password: '[REDACTED]' });
    }
    // runAs supplies only actor context; tenantRequired remains independent.
    await expect(AuditContext.runAs(actor, () => manual.log({ action: 'without-tenant' }))).rejects.toThrow('tenant context required');
  });

  it('records valid lifecycle and deleteMany writes with required actors', async () => {
    await AuditContext.runAs(actor, () => audited.withAuditTransaction(async (tx: any) => {
      const user = await tx.user.create({ data });
      await audited.withAuditLifecycle({ action: 'User.archived' }, (lifecycleTx: any) =>
        lifecycleTx.user.update({ where: { id: user.id }, data: { name: 'Archived' } }),
      );
      await tx.user.deleteMany();
    }));
    const logs = await base.auditLog.findMany();
    expect(logs).toHaveLength(3);
    expect(logs.map((row: any) => row.action)).toEqual(expect.arrayContaining(['User.created', 'User.archived', 'User.deleted']));
    expect(logs.every((row: any) => row.actorId === actor.id)).toBe(true);
  });

  it.each(['excluded', 'noAudit'] as const)('preserves %s automatic writes while explicit manual log still rejects', async mode => {
    const client: any = createAuditedClient(base, { ...options, ...(mode === 'excluded' ? { trackedModels: [] } : {}) });
    await AuditContext.run({ actor: null, noAudit: mode === 'noAudit' }, async () => {
      await client.user.create({ data });
      await expect(service.log({ action: 'manual' })).rejects.toThrow('actorRequired');
    });
    expect(await base.user.count()).toBe(1);
    expect(await base.auditLog.count()).toBe(0);
  });
});
