import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  AuditContext, AuditService, applyAuditTableSchema, createAuditedClient,
  defineAuditConfig, ensurePartitions,
} from '../../src';
import { createTestPrismaClient, prismaModule } from './prisma-client';

describe.each([false, true])('defineAuditConfig E2E (partitioned=%s)', partitioned => {
  const base = createTestPrismaClient();
  const schema = `config_n03_${randomUUID().replaceAll('-', '')}`;
  const tableName = `${schema}.events`;
  const tenant = new AsyncLocalStorage<string>();
  const actor = { id: 'config-worker', type: 'system' as const };
  const config = defineAuditConfig({
    shared: {
      prismaModule, tableName, actorRequired: true, tenantRequired: true,
      tenantResolver: () => tenant.getStore() ?? null,
      sensitiveFields: ['password'], sensitiveFieldsByModel: { User: ['privateNote'] },
      logger: { warn: jest.fn(), error: jest.fn() },
    },
    module: { actorExtractor: () => actor, actorExtractionStage: 'interceptor' },
    extension: {
      consistency: 'atomic-required', trackedModels: ['User'],
      databaseMapping: { User: { tableName: 'users' } },
    },
    schema: { partitioned, ginIndex: true },
  });
  const client = createAuditedClient(base, config.extensionOptions);
  const manual = new AuditService({ ...config.moduleOptions, prisma: base });
  const data = { name: 'Alice', email: `${schema}@test.com`, password: 'secret-password' };

  beforeAll(async () => {
    await base.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
    await applyAuditTableSchema(base, config.schemaOptions);
  });
  beforeEach(async () => {
    await base.$executeRawUnsafe(`TRUNCATE ${tableName}`);
    await base.user.deleteMany({ where: { email: data.email } });
  });
  afterAll(async () => {
    try {
      await base.user.deleteMany({ where: { email: data.email } });
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally { await base.$disconnect(); }
  });

  it('uses the same custom table, tenant, actor and masking for automatic/manual inserts and queries', async () => {
    const defaultBefore = await base.auditLog.count();
    await tenant.run('tenant-a', () => AuditContext.runAs(actor, () =>
      client.withAuditTransaction(async (tx: any) => {
        const user = await tx.user.create({ data });
        await manual.log({
          action: 'manual', targetType: 'User', targetId: user.id,
          metadata: { password: data.password, privateNote: 'secret-note' },
        }, tx);
      }),
    ));
    const rows = await tenant.run('tenant-a', () => manual.query({}));
    expect(rows.entries).toHaveLength(2);
    for (const row of rows.entries) {
      expect(row.actorId).toBe(actor.id);
      expect(row.actorType).toBe('system');
      expect(row.tenantId).toBe('tenant-a');
      expect(JSON.stringify(row)).not.toContain('secret-');
    }
    expect(rows.entries.find(row => row.source === 'auto')!.changes).toMatchObject({ password: { after: '[REDACTED]' } });
    expect(rows.entries.find(row => row.source === 'manual')!.metadata).toEqual({ password: '[REDACTED]', privateNote: '[REDACTED]' });
    expect((await manual.query({ tenantId: 'tenant-b' })).entries).toEqual([]);
    expect(await base.auditLog.count()).toBe(defaultBefore);
    const stored = await base.$queryRawUnsafe<Array<{ count: number }>>(`SELECT count(*)::int AS count FROM ${tableName}`);
    expect(stored[0].count).toBe(2);
  });

  it('applies the same required actor and tenant policy to both paths', async () => {
    await tenant.run('tenant-a', async () => {
      await expect(client.withAuditTransaction((tx: any) => tx.user.create({ data }))).rejects.toThrow('actorRequired');
      await expect(manual.log({ action: 'missing-actor' })).rejects.toThrow('actorRequired');
    });
    await AuditContext.runAs(actor, async () => {
      await expect(client.withAuditTransaction((tx: any) => tx.user.create({ data }))).rejects.toThrow('tenant context required');
      await expect(manual.log({ action: 'missing-tenant' })).rejects.toThrow('tenant context required');
    });
    expect((await manual.query({ tenantId: 'tenant-a' })).entries).toHaveLength(0);
    expect(await base.user.count({ where: { email: data.email } })).toBe(0);
  });

  it('routes partition maintenance to the configured table', async () => {
    if (partitioned) {
      const created = await ensurePartitions(base, { ...config.partitionOptions, ahead: 2 });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(new RegExp(`^${schema}\\.events_y\\d{4}m\\d{2}$`));
      expect(await ensurePartitions(base, { ...config.partitionOptions, ahead: 2 })).toEqual([]);
    } else {
      await expect(ensurePartitions(base, config.partitionOptions)).rejects.toThrow('must be a partitioned table');
    }
  });
});
