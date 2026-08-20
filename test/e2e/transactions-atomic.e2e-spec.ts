import {
  createTestPrismaClient,
  PrismaClient,
  prismaModule,
} from './prisma-client';
import { AuditContext } from '../../src/services/audit-context';
import { createAuditedClient } from '../../src/prisma/audit-extension';
import { applyAuditTableSchema } from '../../src/sql';

describe('atomic-required transaction E2E', () => {
  let basePrisma: PrismaClient;
  let audited: any;

  beforeAll(async () => {
    basePrisma = createTestPrismaClient();
    await resetAuditStorage(basePrisma);
    audited = createAuditedClient(basePrisma, {
      consistency: 'atomic-required',
      trackedModels: ['User'],
      logger: silentLogger,
      prismaModule,
    });
  });

  beforeEach(async () => {
    await clearData(basePrisma);
  });

  afterAll(async () => {
    await clearData(basePrisma);
    await basePrisma.$disconnect();
  });

  it('rejects a tracked write outside withAuditTransaction before mutation', async () => {
    await expect(
      audited.user.create({
        data: {
          name: 'Outside Helper',
          email: 'outside-helper@test.com',
          password: 'pw',
        },
      }),
    ).rejects.toThrow('must run inside withAuditTransaction()');

    expect(await userCount(basePrisma, 'outside-helper@test.com')).toBe(0);
  });

  it('commits the business row and exact automatic audit row together', async () => {
    await AuditContext.run(
      { actor: { id: 'atomic-user', type: 'user' }, noAudit: false },
      () =>
        audited.withAuditTransaction(
          (tx: any) =>
            tx.user.create({
              data: {
                name: 'Atomic Commit',
                email: 'atomic-commit@test.com',
                password: 'pw',
              },
            }),
          { isolationLevel: 'Serializable', timeout: 10_000, maxWait: 5_000 },
        ),
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs WHERE action = 'User.created'
    `;
    expect(await userCount(basePrisma, 'atomic-commit@test.com')).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe('atomic-user');
    expect(logs[0].changes.name).toEqual({ after: 'Atomic Commit' });
  });

  it('records transaction-local create then update diffs from the same tx', async () => {
    await audited.withAuditTransaction(async (tx: any) => {
      const user = await tx.user.create({
        data: {
          name: 'Before',
          email: 'atomic-update@test.com',
          password: 'pw',
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { name: 'After' },
      });
    });

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs ORDER BY created_at, id
    `;
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.action).sort()).toEqual([
      'User.created',
      'User.updated',
    ]);
    expect(
      logs.find((log) => log.action === 'User.updated').changes.name,
    ).toEqual({ before: 'Before', after: 'After' });
  });

  it('commits delete and its before-only audit diff together', async () => {
    const user = await basePrisma.user.create({
      data: {
        name: 'Atomic Delete',
        email: 'atomic-delete@test.com',
        password: 'pw',
      },
    });

    await audited.withAuditTransaction((tx: any) =>
      tx.user.delete({ where: { id: user.id } }),
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs WHERE action = 'User.deleted'
    `;
    expect(await userCount(basePrisma, 'atomic-delete@test.com')).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].changes.name).toEqual({ before: 'Atomic Delete' });
  });

  it('rolls back the business row and automatic audit row together', async () => {
    await expect(
      audited.withAuditTransaction(async (tx: any) => {
        await tx.user.create({
          data: {
            name: 'Atomic Rollback',
            email: 'atomic-rollback@test.com',
            password: 'pw',
          },
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs WHERE action = 'User.created'
    `;
    expect(await userCount(basePrisma, 'atomic-rollback@test.com')).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it('rolls back the business mutation when the audit insert fails', async () => {
    const brokenAudit = createAuditedClient(basePrisma, {
      consistency: 'atomic-required',
      trackedModels: ['User'],
      tableName: 'missing_audit_logs',
      logger: silentLogger,
      prismaModule,
    });

    await expect(
      brokenAudit.withAuditTransaction((tx: any) =>
        tx.user.create({
          data: {
            name: 'Audit Failure',
            email: 'audit-failure@test.com',
            password: 'pw',
          },
        }),
      ),
    ).rejects.toThrow();

    expect(await userCount(basePrisma, 'audit-failure@test.com')).toBe(0);
  });
});

const silentLogger = {
  warn: jest.fn(),
  error: jest.fn(),
};

async function userCount(prisma: PrismaClient, email: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM users WHERE email = ${email}
  `;
  return Number(rows[0].count);
}

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
  await prisma.$executeRaw`DELETE FROM audit_logs`;
  await prisma.$executeRaw`DELETE FROM users`;
  await applyAuditTableSchema(prisma, { enforcement: 'trigger' });
}

async function clearData(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS audit_logs_no_delete_trg ON audit_logs`,
  );
  await prisma.$executeRaw`DELETE FROM audit_logs`;
  await prisma.$executeRaw`DELETE FROM users`;
  await applyAuditTableSchema(prisma, { enforcement: 'trigger' });
}
