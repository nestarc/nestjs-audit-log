import { PrismaClient } from '@prisma/client';
import { AuditContext } from '../../src/services/audit-context';
import { createAuditExtension } from '../../src/prisma/audit-extension';
import { applyAuditTableSchema } from '../../src/sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

describe('experimental transaction-aware audit E2E', () => {
  let basePrisma: PrismaClient;
  let prisma: any;

  beforeAll(async () => {
    basePrisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });
    await resetAuditStorage(basePrisma);
    prisma = basePrisma.$extends(
      createAuditExtension({
        trackedModels: ['User'],
        experimentalTxAudit: true,
        logger: silentLogger,
      }),
    );
  });

  beforeEach(async () => {
    await clearData(basePrisma);
  });

  afterAll(async () => {
    await clearData(basePrisma);
    await basePrisma.$disconnect();
  });

  it('rolls back automatic audit rows with the caller interactive transaction', async () => {
    await expect(
      AuditContext.run(
        { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
        async () =>
          await prisma.$transaction(async (tx: any) => {
            await tx.user.create({
              data: {
                name: 'Rollback User',
                email: 'rollback-experimental@test.com',
                password: 'pw',
              },
            });
            throw new Error('force rollback');
          }),
      ),
    ).rejects.toThrow('force rollback');

    const logs = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'User.created'
    `;
    expect(Number(logs[0].count)).toBe(0);
  });

  it('records the in-transaction after state for update diffs', async () => {
    const user = await AuditContext.run(
      { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
      async () =>
        await prisma.user.create({
          data: {
            name: 'Before',
            email: 'experimental-before@test.com',
            password: 'pw',
          },
        }),
    );
    await clearAuditLogs(basePrisma);

    await AuditContext.run(
      { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
      async () =>
        await prisma.$transaction(async (tx: any) => {
          await tx.user.update({
            where: { id: user.id },
            data: { name: 'After' },
          });
        }),
    );

    const logs = await basePrisma.$queryRaw<Array<{ changes: any }>>`
      SELECT changes FROM audit_logs WHERE action = 'User.updated'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0].changes.name).toEqual({
      before: 'Before',
      after: 'After',
    });
  });

  it('reports tx-routed audit insert failures and leaves the caller transaction aborted', async () => {
    const onAuditError = jest.fn();
    const brokenAuditPrisma = basePrisma.$extends(
      createAuditExtension({
        trackedModels: ['User'],
        experimentalTxAudit: true,
        tableName: 'missing_audit_logs',
        onAuditError,
        logger: silentLogger,
      }),
    );
    let followUpStatementFailed = false;

    await expect(
      AuditContext.run(
        { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
        async () =>
          await brokenAuditPrisma.$transaction(async (tx: any) => {
            await tx.user.create({
              data: {
                name: 'Abort User',
                email: 'abort-experimental@test.com',
                password: 'pw',
              },
            });

            try {
              await tx.user.count();
            } catch (error) {
              followUpStatementFailed = true;
              throw error;
            }
          }),
      ),
    ).rejects.toThrow();

    expect(followUpStatementFailed).toBe(true);
    expect(onAuditError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        phase: 'insert',
        model: 'User',
        operation: 'create',
      }),
    );

    const users = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM users WHERE email = 'abort-experimental@test.com'
    `;
    expect(Number(users[0].count)).toBe(0);
  });
});

const silentLogger = {
  warn: jest.fn(),
  error: jest.fn(),
};

async function resetAuditStorage(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
  );
  await prisma.$executeRawUnsafe(
    `DROP RULE IF EXISTS audit_logs_no_update ON audit_logs`,
  );
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS audit_logs_no_delete_trg ON audit_logs`,
  );
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS audit_logs_no_update_trg ON audit_logs`,
  );
  await clearData(prisma);
  await applyAuditTableSchema(prisma, { enforcement: 'rule' });
}

async function clearData(prisma: PrismaClient): Promise<void> {
  await clearAuditLogs(prisma);
  await prisma.$executeRaw`DELETE FROM users`;
}

async function clearAuditLogs(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
  );
  await prisma.$executeRaw`DELETE FROM audit_logs`;
  await prisma.$executeRawUnsafe(
    `CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING`,
  );
}
