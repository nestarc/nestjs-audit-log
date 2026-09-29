import { AuditContext, createAuditedClient } from '../../src';
import { applyAuditTableSchema } from '../../src/sql';
import { createTestPrismaClient, prismaModule } from './prisma-client';

describe('unsupported returning mutations E2E', () => {
  const base = createTestPrismaClient();
  const logger = { warn: jest.fn(), error: jest.fn() };
  const options = {
    consistency: 'atomic-required' as const,
    trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users' } },
    logger,
    prismaModule,
  };
  const audited: any = createAuditedClient(base, options);
  const userData = { name: 'Before', email: 'returning@test.com', password: 'pw' };

  beforeEach(async () => {
    // This suite runs only in the disposable E2E database.
    await base.$executeRawUnsafe('DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs');
    await base.$executeRawUnsafe('DROP TRIGGER IF EXISTS audit_logs_no_delete_trg ON audit_logs');
    await base.$executeRaw`DELETE FROM audit_logs`;
    await base.user.deleteMany();
    await applyAuditTableSchema(base, { enforcement: 'trigger' });
  });

  afterAll(async () => {
    await base.$executeRawUnsafe('DROP TRIGGER IF EXISTS audit_logs_no_delete_trg ON audit_logs');
    await base.$executeRaw`DELETE FROM audit_logs`;
    await base.user.deleteMany();
    await applyAuditTableSchema(base, { enforcement: 'trigger' });
    await base.$disconnect();
  });

  it('creates the extension and preserves existing operations on every Prisma peer lane', async () => {
    const result = await audited.withAuditTransaction((tx: any) => tx.user.create({ data: userData }));
    expect(result.email).toBe(userData.email);
    expect(await base.user.count()).toBe(1);
    expect(await base.auditLog.count()).toBe(1);
  });

  for (const operation of ['createManyAndReturn', 'updateManyAndReturn'] as const) {
    // Older peers do not expose both APIs. Keep their extension/ordinary-write test above active.
    const testOperation = typeof base.user[operation] === 'function' ? it : it.skip;
    const args = operation === 'createManyAndReturn'
      ? { data: [{ ...userData, email: 'returning-new@test.com' }] }
      : { where: { email: userData.email }, data: { name: 'After' } };

    testOperation(`${operation}: rejects outside the helper without changing the database`, async () => {
      await base.user.create({ data: userData });
      const before = await base.user.findMany();
      await expect(audited.user[operation](args)).rejects.toThrow(`User.${operation}`);
      expect(await base.user.findMany()).toEqual(before);
      expect(await base.auditLog.count()).toBe(0);
    });

    testOperation(`${operation}: catching the error rolls back prior business and audit rows`, async () => {
      let caught: unknown;
      const completion = audited.withAuditTransaction(async (tx: any) => {
        await tx.user.create({ data: userData });
        expect(await tx.auditLog.count()).toBe(1);
        try {
          await tx.user[operation](args);
        } catch (error) {
          caught = error;
        }
        // PostgreSQL is still usable: the rejected operation never reached the DB.
        expect(await tx.user.count()).toBe(1);
        expect((await tx.user.findUnique({ where: { email: userData.email } })).name).toBe('Before');
        expect(await tx.auditLog.count()).toBe(1);
        return 'caught';
      });
      await expect(completion).rejects.toThrow(`User.${operation}`);
      await expect(completion).rejects.toBe(caught);
      expect(await base.user.count()).toBe(0);
      expect(await base.auditLog.count()).toBe(0);
    });

    for (const mode of ['best-effort', 'excluded', 'noAudit'] as const) {
      testOperation(`${operation}: preserves ${mode} business results`, async () => {
        await base.user.create({ data: userData });
        const client: any = createAuditedClient(base, {
          ...options,
          ...(mode === 'best-effort' ? { consistency: 'best-effort' as const } : {}),
          ...(mode === 'excluded' ? { trackedModels: ['AuditGuardRoot'] } : {}),
        });
        logger.warn.mockClear();
        const result = await AuditContext.run({ actor: null, noAudit: mode === 'noAudit' }, () =>
          client.withAuditTransaction((tx: any) => tx.user[operation](args)),
        );
        expect(result).toHaveLength(1);
        expect(result[0].email).toBe(operation === 'createManyAndReturn' ? 'returning-new@test.com' : userData.email);
        expect(result[0].name).toBe(operation === 'createManyAndReturn' ? 'Before' : 'After');
        expect(await base.user.findUnique({ where: { id: result[0].id } })).toEqual(result[0]);
        expect(await base.auditLog.count()).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(mode === 'best-effort' ? 1 : 0);
      });
    }
  }
});
