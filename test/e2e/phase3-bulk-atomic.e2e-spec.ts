import {
  createTestPrismaClient,
  PrismaClient,
  prismaModule,
} from './prisma-client';
import { AuditContext } from '../../src/services/audit-context';
import { createAuditedClient } from '../../src/prisma/audit-extension';
import { applyAuditTableSchema } from '../../src/sql';

describe('phase 3 array transaction and bulk atomic contracts E2E', () => {
  let basePrisma: PrismaClient;
  let audited: any;

  beforeAll(async () => {
    basePrisma = createTestPrismaClient();
    await resetAuditStorage(basePrisma);
    audited = atomicClient(basePrisma);
  });

  beforeEach(async () => {
    await clearData(basePrisma);
  });

  afterAll(async () => {
    await clearData(basePrisma);
    await basePrisma.$disconnect();
  });

  it('rejects array transactions deterministically before business or audit writes', async () => {
    await expect(
      audited.$transaction([
        audited.user.create({
          data: { name: 'Array One', email: 'array@test.com', password: 'pw' },
        }),
        audited.user.create({
          data: { name: 'Array Two', email: 'array@test.com', password: 'pw' },
        }),
      ]),
    ).rejects.toThrow('does not support array $transaction([...])');

    expect(await counts(basePrisma)).toEqual({ users: 0, logs: 0 });
  });

  it.each(['createMany', 'updateMany'] as const)(
    'rejects count-only %s before mutation in atomic mode',
    async (operation) => {
      if (operation === 'updateMany') {
        await seedUsers(basePrisma, 2, 'reject-update');
      }

      await expect(
        audited.withAuditTransaction((tx: any) =>
          operation === 'createMany'
            ? tx.user.createMany({
                data: [
                  { name: 'A', email: 'reject-a@test.com', password: 'pw' },
                  { name: 'B', email: 'reject-b@test.com', password: 'pw' },
                ],
              })
            : tx.user.updateMany({
                where: { email: { contains: 'reject-update' } },
                data: { name: 'Changed' },
              }),
        ),
      ).rejects.toThrow('only provides count-level audit evidence');

      const state = await counts(basePrisma);
      expect(state.logs).toBe(0);
      expect(state.users).toBe(operation === 'createMany' ? 0 : 2);
    },
  );

  it('commits deleteMany with one exact record audit per deleted row', async () => {
    await seedUsers(basePrisma, 2, 'delete-success');

    await AuditContext.run(
      { actor: { id: 'bulk-admin', type: 'user' }, noAudit: false },
      () =>
        audited.withAuditTransaction((tx: any) =>
          tx.user.deleteMany({
            where: { email: { contains: 'delete-success' } },
          }),
        ),
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT action, target_id, changes, metadata
      FROM audit_logs ORDER BY target_id ASC
    `;
    expect(await counts(basePrisma)).toEqual({ users: 0, logs: 2 });
    expect(logs.every((log) => log.action === 'User.deleted')).toBe(true);
    expect(logs.every((log) => log.target_id)).toBe(true);
    expect(logs.map((log) => log.changes.name.before).sort()).toEqual([
      'Bulk 0',
      'Bulk 1',
    ]);
    expect(logs.every((log) => log.metadata.auditKind === 'record')).toBe(true);
    expect(logs.every((log) => log.metadata.batchSize === 2)).toBe(true);
  });

  it('rolls back deleteMany and all record audits when later work fails', async () => {
    await seedUsers(basePrisma, 2, 'delete-late-failure');

    await expect(
      audited.withAuditTransaction(async (tx: any) => {
        await tx.user.deleteMany({
          where: { email: { contains: 'delete-late-failure' } },
        });
        throw new Error('forced later failure');
      }),
    ).rejects.toThrow('forced later failure');

    expect(await counts(basePrisma)).toEqual({ users: 2, logs: 0 });
  });

  it('rejects deleteMany overflow before the business mutation', async () => {
    await seedUsers(basePrisma, 2, 'overflow');
    const capped = atomicClient(basePrisma, { maxBatchRecords: 1 });

    await expect(
      capped.withAuditTransaction((tx: any) =>
        tx.user.deleteMany({ where: { email: { contains: 'overflow' } } }),
      ),
    ).rejects.toThrow('more than maxBatchRecords');

    expect(await counts(basePrisma)).toEqual({ users: 2, logs: 0 });
  });

  it('rolls back deleteMany when a record audit insert fails', async () => {
    await seedUsers(basePrisma, 2, 'audit-failure');
    await basePrisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION reject_bulk_audit_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'User.deleted' THEN
          RAISE EXCEPTION 'phase3 audit insert rejected';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await basePrisma.$executeRawUnsafe(`
      CREATE TRIGGER reject_bulk_audit_insert_trg
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_bulk_audit_insert()
    `);

    try {
      await expect(
        audited.withAuditTransaction((tx: any) =>
          tx.user.deleteMany({
            where: { email: { contains: 'audit-failure' } },
          }),
        ),
      ).rejects.toThrow('phase3 audit insert rejected');
    } finally {
      await basePrisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS reject_bulk_audit_insert_trg ON audit_logs`,
      );
      await basePrisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS reject_bulk_audit_insert()`,
      );
    }

    expect(await counts(basePrisma)).toEqual({ users: 2, logs: 0 });
  });
});

const silentLogger = { warn: jest.fn(), error: jest.fn() };

function atomicClient(
  prisma: PrismaClient,
  options: { maxBatchRecords?: number } = {},
): any {
  return createAuditedClient(prisma, {
    consistency: 'atomic-required',
    trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users' } },
    logger: silentLogger,
    prismaModule,
    ...options,
  });
}

async function seedUsers(
  prisma: PrismaClient,
  count: number,
  emailPrefix: string,
): Promise<void> {
  for (let index = 0; index < count; index++) {
    await prisma.user.create({
      data: {
        name: `Bulk ${index}`,
        email: `${emailPrefix}-${index}@test.com`,
        password: 'pw',
      },
    });
  }
}

async function counts(
  prisma: PrismaClient,
): Promise<{ users: number; logs: number }> {
  const [users, logs] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM users`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM audit_logs`,
  ]);
  return { users: Number(users[0].count), logs: Number(logs[0].count) };
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
