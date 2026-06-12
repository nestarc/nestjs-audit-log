import { PrismaClient } from '@prisma/client';
import { AuditContext } from '../../src/services/audit-context';
import { createAuditExtension } from '../../src/prisma/audit-extension';
import { AuditService } from '../../src/services/audit.service';
import { applyAuditTableSchema } from '../../src/sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

describe('transaction consistency E2E', () => {
  let basePrisma: PrismaClient;
  let prisma: any;
  let auditService: AuditService;

  beforeAll(async () => {
    basePrisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });
    await resetAuditStorage(basePrisma);
    prisma = basePrisma.$extends(
      createAuditExtension({
        trackedModels: ['User'],
        logger: silentLogger,
      }),
    );
    auditService = new AuditService({
      prisma: basePrisma,
      actorExtractor: () => ({ id: null, type: 'system' }),
      logger: silentLogger,
    });
  });

  beforeEach(async () => {
    await clearData(basePrisma);
  });

  afterAll(async () => {
    await clearData(basePrisma);
    await basePrisma.$disconnect();
  });

  it('keeps an automatic audit orphan row when caller interactive transaction rolls back', async () => {
    let rolledBackUserId: string | null = null;

    await expect(
      AuditContext.run(
        { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
        async () =>
          await prisma.$transaction(async (tx: any) => {
            const user = await tx.user.create({
              data: {
                name: 'Rollback User',
                email: 'rollback@test.com',
                password: 'pw',
              },
            });
            rolledBackUserId = user.id;
            throw new Error('force rollback');
          }),
      ),
    ).rejects.toThrow('force rollback');

    const users = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM users WHERE email = 'rollback@test.com'
    `;
    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs WHERE action = 'User.created'
    `;

    expect(Number(users[0].count)).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].target_id).toBe(rolledBackUserId);
  });

  it('makes automatic audit rows visible before the caller transaction commits', async () => {
    let visibleInsideTransaction = 0;

    await expect(
      AuditContext.run(
        { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
        async () =>
          await prisma.$transaction(async (tx: any) => {
            await tx.user.create({
              data: {
                name: 'Visible Audit',
                email: 'visible@test.com',
                password: 'pw',
              },
            });
            const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
              SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'User.created'
            `;
            visibleInsideTransaction = Number(rows[0].count);
            throw new Error('force rollback');
          }),
      ),
    ).rejects.toThrow('force rollback');

    expect(visibleInsideTransaction).toBe(1);
  });

  it('keeps orphan rows for create, update, and delete in a rolled-back interactive transaction', async () => {
    await expect(
      AuditContext.run(
        { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
        async () =>
          await prisma.$transaction(async (tx: any) => {
            const user = await tx.user.create({
              data: {
                name: 'Multi Rollback',
                email: 'multi-rollback@test.com',
                password: 'pw',
              },
            });
            await tx.user.update({
              where: { id: user.id },
              data: { name: 'Multi Rollback Updated' },
            });
            await tx.user.delete({ where: { id: user.id } });
            throw new Error('force rollback');
          }),
      ),
    ).rejects.toThrow('force rollback');

    const users = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM users WHERE email = 'multi-rollback@test.com'
    `;
    const logs = await basePrisma.$queryRaw<Array<{ action: string; count: bigint }>>`
      SELECT action, COUNT(*) AS count
      FROM audit_logs
      WHERE action IN ('User.created', 'User.updated', 'User.deleted')
      GROUP BY action
    `;

    expect(Number(users[0].count)).toBe(0);
    expect(
      Object.fromEntries(
        logs.map((row) => [row.action, Number(row.count)]),
      ),
    ).toEqual({
      'User.created': 1,
      'User.updated': 1,
      'User.deleted': 1,
    });
  });

  it('records an empty update diff for a committed row updated inside an interactive transaction', async () => {
    const user = await AuditContext.run(
      { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
      async () =>
        await prisma.user.create({
          data: {
            name: 'Before',
            email: 'before@test.com',
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

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs WHERE action = 'User.updated'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0].changes).toEqual({});
  });

  it('records an empty update diff when a row is created and updated in the same interactive transaction', async () => {
    let userId: string | null = null;

    await AuditContext.run(
      { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
      async () =>
        await prisma.$transaction(async (tx: any) => {
          const user = await tx.user.create({
            data: {
              name: 'Same Tx Before',
              email: 'same-tx@test.com',
              password: 'pw',
            },
          });
          userId = user.id;
          await tx.user.update({
            where: { id: user.id },
            data: { name: 'Same Tx After' },
          });
        }),
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT target_id, changes FROM audit_logs WHERE action = 'User.updated'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0].target_id).toBe(userId);
    expect(logs[0].changes).toEqual({});
  });

  it('rolls back manual AuditService.log(input, tx) entries with the caller transaction', async () => {
    await expect(
      AuditContext.run(
        { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
        async () =>
          await basePrisma.$transaction(async (tx) => {
            await auditService.log(
              {
                action: 'manual.rollback',
                targetType: 'Invoice',
                targetId: 'inv-rollback',
              },
              tx,
            );
            throw new Error('force rollback');
          }),
      ),
    ).rejects.toThrow('force rollback');

    const logs = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'manual.rollback'
    `;
    expect(Number(logs[0].count)).toBe(0);
  });

  it('does not leave a success audit row when an array transaction rolls back', async () => {
    await expect(
      AuditContext.run(
        { actor: { id: 'tx-user', type: 'user' }, noAudit: false },
        async () =>
          await prisma.$transaction([
            prisma.user.create({
              data: {
                name: 'Batch Rollback',
                email: 'batch-rollback@test.com',
                password: 'pw',
              },
            }),
            prisma.user.create({
              data: {
                name: 'Batch Rollback Duplicate',
                email: 'batch-rollback@test.com',
                password: 'pw',
              },
            }),
          ]),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    const users = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM users WHERE email = 'batch-rollback@test.com'
    `;
    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs WHERE action = 'User.created'
    `;

    expect(Number(users[0].count)).toBe(0);
    expect(logs).toHaveLength(0);
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
