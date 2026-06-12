import { PrismaClient } from '@prisma/client';
import { AuditContext } from '../../src/services/audit-context';
import { createAuditExtension } from '../../src/prisma/audit-extension';
import { applyAuditTableSchema } from '../../src/sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

describe('batch and upsert E2E', () => {
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

  it('audits upsert create and update branches with the expected action and diff', async () => {
    await AuditContext.run(
      { actor: { id: 'batch-user', type: 'user' }, noAudit: false },
      async () => {
        await prisma.user.upsert({
          where: { email: 'upsert@test.com' },
          create: {
            name: 'Created',
            email: 'upsert@test.com',
            password: 'pw',
          },
          update: { name: 'Updated' },
        });
        await prisma.user.upsert({
          where: { email: 'upsert@test.com' },
          create: {
            name: 'Unused',
            email: 'upsert@test.com',
            password: 'pw',
          },
          update: { name: 'Updated' },
        });
      },
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT action, changes FROM audit_logs
      WHERE action IN ('User.created', 'User.updated')
      ORDER BY created_at ASC
    `;

    expect(logs).toHaveLength(2);
    expect(logs[0].action).toBe('User.created');
    expect(logs[0].changes.name.after).toBe('Created');
    expect(logs[1].action).toBe('User.updated');
    expect(logs[1].changes.name.before).toBe('Created');
    expect(logs[1].changes.name.after).toBe('Updated');
  });

  it('keeps target_id when upsert uses a select projection that omits id', async () => {
    const result = await AuditContext.run(
      { actor: { id: 'batch-user', type: 'user' }, noAudit: false },
      async () =>
        await prisma.user.upsert({
          where: { email: 'select-upsert@test.com' },
          create: {
            name: 'Select Upsert',
            email: 'select-upsert@test.com',
            password: 'pw',
          },
          update: { name: 'Select Updated' },
          select: { name: true },
        }),
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT target_id FROM audit_logs WHERE action = 'User.created'
    `;

    expect(result).toEqual({ name: 'Select Upsert' });
    expect(logs).toHaveLength(1);
    expect(logs[0].target_id).toEqual(expect.any(String));
  });

  it('audits createMany and updateMany as count-only batch rows', async () => {
    await AuditContext.run(
      { actor: { id: 'batch-user', type: 'user' }, noAudit: false },
      async () => {
        await prisma.user.createMany({
          data: [
            { name: 'Batch A', email: 'batch-a@test.com', password: 'pw' },
            { name: 'Batch B', email: 'batch-b@test.com', password: 'pw' },
          ],
        });
        await prisma.user.updateMany({
          where: { email: { contains: 'batch-' } },
          data: { password: 'changed' },
        });
      },
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT action, changes, metadata FROM audit_logs
      WHERE action IN ('User.createdMany', 'User.updatedMany')
      ORDER BY created_at ASC
    `;

    expect(logs).toEqual([
      { action: 'User.createdMany', changes: {}, metadata: { count: 2 } },
      { action: 'User.updatedMany', changes: {}, metadata: { count: 2 } },
    ]);
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
