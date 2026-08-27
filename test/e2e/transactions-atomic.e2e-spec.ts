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
      sensitiveFields: ['password'],
      databaseMapping: { User: { tableName: 'users' } },
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
    let visibleBusinessRowsBeforeCommit = -1;
    let visibleAuditRowsBeforeCommit = -1;

    await AuditContext.run(
      { actor: { id: 'atomic-user', type: 'user' }, noAudit: false },
      () =>
        audited.withAuditTransaction(
          async (tx: any) => {
            await tx.user.create({
              data: {
                name: 'Atomic Commit',
                email: 'atomic-commit@test.com',
                password: 'pw',
              },
            });
            visibleBusinessRowsBeforeCommit = await userCount(
              basePrisma,
              'atomic-commit@test.com',
            );
            visibleAuditRowsBeforeCommit = await auditCount(
              basePrisma,
              'User.created',
            );
          },
          { isolationLevel: 'Serializable', timeout: 10_000, maxWait: 5_000 },
        ),
    );

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs WHERE action = 'User.created'
    `;
    expect(visibleBusinessRowsBeforeCommit).toBe(0);
    expect(visibleAuditRowsBeforeCommit).toBe(0);
    expect(await userCount(basePrisma, 'atomic-commit@test.com')).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe('atomic-user');
    expect(logs[0].changes.name).toEqual({ after: 'Atomic Commit' });
    expect(logs[0].changes.email).toEqual({
      after: 'atomic-commit@test.com',
    });
    expect(logs[0].changes.password).toEqual({ after: '[REDACTED]' });
  });

  it('commits an update with its exact immediate before and after values', async () => {
    const user = await seedUser(basePrisma, {
      name: 'Committed Before',
      email: 'atomic-committed-update@test.com',
    });

    const updated = await audited.withAuditTransaction((tx: any) =>
      tx.user.update({
        where: { id: user.id },
        data: { name: 'Committed After' },
      }),
    );

    const logs = await auditLogs(basePrisma, 'User.updated');
    expect(logs).toHaveLength(1);
    expect(logs[0].target_id).toBe(user.id);
    expect(logs[0].changes).toEqual({
      name: { before: 'Committed Before', after: 'Committed After' },
      updatedAt: {
        before: user.updatedAt.toISOString(),
        after: updated.updatedAt.toISOString(),
      },
    });
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

  it('records each step of multiple updates in one transaction', async () => {
    const user = await seedUser(basePrisma, {
      name: 'Step Zero',
      email: 'atomic-multiple-updates@test.com',
    });

    await audited.withAuditTransaction(async (tx: any) => {
      await tx.user.update({
        where: { id: user.id },
        data: { name: 'Step One' },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { name: 'Step Two' },
      });
    });

    const logs = await auditLogs(basePrisma, 'User.updated');
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.changes.name)).toEqual(
      expect.arrayContaining([
        { before: 'Step Zero', after: 'Step One' },
        { before: 'Step One', after: 'Step Two' },
      ]),
    );
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

  it('commits a generic delete after a rewritten lifecycle callback fails', async () => {
    const lifecycleTarget = await seedUser(basePrisma, {
      name: 'Failed Lifecycle Target',
      email: 'failed-lifecycle-target@test.com',
    });
    const deleteTarget = await seedUser(basePrisma, {
      name: 'Delete After Lifecycle Failure',
      email: 'delete-after-lifecycle-failure@test.com',
    });
    const lifecycleError = new Error('lifecycle failed before mutation');
    const lifecycleClient = createLifecycleDeleteRewrite(
      audited,
      lifecycleTarget.id,
      async () => {
        throw lifecycleError;
      },
    );

    await lifecycleClient.withAuditTransaction(async (tx: any) => {
      await expect(
        tx.user.delete({ where: { id: lifecycleTarget.id } }),
      ).rejects.toThrow(lifecycleError.message);
      await tx.user.delete({ where: { id: deleteTarget.id } });
    });

    expect(await userCount(basePrisma, lifecycleTarget.email)).toBe(1);
    expect(await userCount(basePrisma, deleteTarget.email)).toBe(0);
    const logs = await auditLogs(basePrisma, 'User.deleted');
    expect(logs).toHaveLength(1);
    expect(logs[0].target_id).toBe(deleteTarget.id);
  });

  it('commits generic deleteMany evidence after a rewritten lifecycle callback fails', async () => {
    const lifecycleTarget = await seedUser(basePrisma, {
      name: 'Failed Bulk Lifecycle Target',
      email: 'failed-bulk-lifecycle-target@test.com',
    });
    const deleteTargets = await Promise.all([
      seedUser(basePrisma, {
        name: 'Bulk Delete One',
        email: 'bulk-delete-one-after-lifecycle-failure@test.com',
      }),
      seedUser(basePrisma, {
        name: 'Bulk Delete Two',
        email: 'bulk-delete-two-after-lifecycle-failure@test.com',
      }),
    ]);
    const lifecycleError = new Error('bulk lifecycle failed before mutation');
    const lifecycleClient = createLifecycleDeleteManyRewrite(
      audited,
      [lifecycleTarget.id],
      async () => {
        throw lifecycleError;
      },
    );

    await lifecycleClient.withAuditTransaction(async (tx: any) => {
      await expect(
        tx.user.deleteMany({
          where: { id: { in: [lifecycleTarget.id] } },
        }),
      ).rejects.toThrow(lifecycleError.message);
      await tx.user.deleteMany({
        where: { id: { in: deleteTargets.map((target) => target.id) } },
      });
    });

    expect(await userCount(basePrisma, lifecycleTarget.email)).toBe(1);
    expect(await userCount(basePrisma, deleteTargets[0].email)).toBe(0);
    expect(await userCount(basePrisma, deleteTargets[1].email)).toBe(0);
    const logs = await auditLogs(basePrisma, 'User.deleted');
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.target_id).sort()).toEqual(
      deleteTargets.map((target) => target.id).sort(),
    );
  });

  it('commits lifecycle rows and suppresses the rewritten outer deleteMany audit', async () => {
    const users = await Promise.all([
      seedUser(basePrisma, {
        name: 'Bulk Lifecycle One Before',
        email: 'bulk-lifecycle-one@test.com',
      }),
      seedUser(basePrisma, {
        name: 'Bulk Lifecycle Two Before',
        email: 'bulk-lifecycle-two@test.com',
      }),
    ]);
    const lifecycleClient = createLifecycleDeleteManyRewrite(
      audited,
      users.map((user) => user.id),
      async (tx) => {
        for (const [index, user] of users.entries()) {
          await tx.user.update({
            where: { id: user.id },
            data: { name: `Bulk Lifecycle ${index + 1} After` },
          });
        }
        return { count: users.length };
      },
    );

    await lifecycleClient.withAuditTransaction((tx: any) =>
      tx.user.deleteMany({
        where: { id: { in: users.map((user) => user.id) } },
      }),
    );

    expect(await userName(basePrisma, users[0].email)).toBe(
      'Bulk Lifecycle 1 After',
    );
    expect(await userName(basePrisma, users[1].email)).toBe(
      'Bulk Lifecycle 2 After',
    );
    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs ORDER BY created_at, id
    `;
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.action)).toEqual([
      'User.softDeleted',
      'User.softDeleted',
    ]);
    expect(logs.map((log) => log.target_id).sort()).toEqual(
      users.map((user) => user.id).sort(),
    );
  });

  it('commits one lifecycle audit and suppresses the rewritten outer delete audit', async () => {
    const user = await seedUser(basePrisma, {
      name: 'Lifecycle Before',
      email: 'lifecycle-success@test.com',
    });
    const lifecycleClient = createLifecycleDeleteRewrite(
      audited,
      user.id,
      (tx) =>
        tx.user.update({
          where: { id: user.id },
          data: { name: 'Lifecycle After' },
        }),
    );

    await lifecycleClient.withAuditTransaction((tx: any) =>
      tx.user.delete({ where: { id: user.id } }),
    );

    expect(await userName(basePrisma, user.email)).toBe('Lifecycle After');
    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT * FROM audit_logs ORDER BY created_at, id
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('User.softDeleted');
    expect(logs[0].target_id).toBe(user.id);
  });

  it('rolls back a successful lifecycle rewrite and its audit together', async () => {
    const user = await seedUser(basePrisma, {
      name: 'Lifecycle Rollback Before',
      email: 'lifecycle-rollback@test.com',
    });
    const lifecycleClient = createLifecycleDeleteRewrite(
      audited,
      user.id,
      (tx) =>
        tx.user.update({
          where: { id: user.id },
          data: { name: 'Lifecycle Rollback After' },
        }),
    );

    await expect(
      lifecycleClient.withAuditTransaction(async (tx: any) => {
        await tx.user.delete({ where: { id: user.id } });
        throw new Error('force lifecycle rollback');
      }),
    ).rejects.toThrow('force lifecycle rollback');

    expect(await userName(basePrisma, user.email)).toBe(
      'Lifecycle Rollback Before',
    );
    expect(await totalAuditCount(basePrisma)).toBe(0);
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

  it('rolls back create, update, delete, and all automatic audit rows together', async () => {
    const updateTarget = await seedUser(basePrisma, {
      name: 'Rollback Update Before',
      email: 'atomic-rollback-update@test.com',
    });
    const deleteTarget = await seedUser(basePrisma, {
      name: 'Rollback Delete',
      email: 'atomic-rollback-delete@test.com',
    });

    await expect(
      audited.withAuditTransaction(async (tx: any) => {
        await tx.user.create({
          data: {
            name: 'Rollback Create',
            email: 'atomic-rollback-create@test.com',
            password: 'pw',
          },
        });
        await tx.user.update({
          where: { id: updateTarget.id },
          data: { name: 'Rollback Update After' },
        });
        await tx.user.delete({ where: { id: deleteTarget.id } });
        throw new Error('force all rollback');
      }),
    ).rejects.toThrow('force all rollback');

    expect(await userCount(basePrisma, 'atomic-rollback-create@test.com')).toBe(
      0,
    );
    expect(
      await userName(basePrisma, 'atomic-rollback-update@test.com'),
    ).toBe('Rollback Update Before');
    expect(await userCount(basePrisma, 'atomic-rollback-delete@test.com')).toBe(
      1,
    );
    expect(await totalAuditCount(basePrisma)).toBe(0);
  });

  it('rolls back the business mutation when the audit insert fails', async () => {
    const brokenAudit = createAuditedClient(basePrisma, {
      consistency: 'atomic-required',
      trackedModels: ['User'],
      tableName: 'missing_audit_logs',
      databaseMapping: { User: { tableName: 'users' } },
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

  it('rolls back before the business mutation when an atomic pre-read fails', async () => {
    const user = await seedUser(basePrisma, {
      name: 'Pre-read Before',
      email: 'atomic-pre-read-failure@test.com',
    });
    const brokenAudit = createFaultInjectedAuditedClient(
      basePrisma,
      'forced pre-read failure',
    );

    await expect(
      brokenAudit.withAuditTransaction((tx: any) =>
        tx.user.update({
          where: { id: user.id },
          data: { name: 'Pre-read After' },
        }),
      ),
    ).rejects.toThrow('forced pre-read failure');

    expect(await userName(basePrisma, user.email)).toBe('Pre-read Before');
    expect(await totalAuditCount(basePrisma)).toBe(0);
  });

  it('rolls back the business mutation when an atomic post-read fails', async () => {
    const brokenAudit = createFaultInjectedAuditedClient(
      basePrisma,
      'forced post-read failure',
    );

    await expect(
      brokenAudit.withAuditTransaction((tx: any) =>
        tx.user.create({
          data: {
            name: 'Post-read Failure',
            email: 'atomic-post-read-failure@test.com',
            password: 'pw',
          },
        }),
      ),
    ).rejects.toThrow('forced post-read failure');

    expect(
      await userCount(basePrisma, 'atomic-post-read-failure@test.com'),
    ).toBe(0);
    expect(await totalAuditCount(basePrisma)).toBe(0);
  });

  it('serializes same-row writers and records each exact immediate preimage', async () => {
    const user = await seedUser(basePrisma, {
      name: 'Concurrent Initial',
      email: 'atomic-concurrent@test.com',
    });
    let firstUpdateFinished!: () => void;
    const firstUpdated = new Promise<void>((resolve) => {
      firstUpdateFinished = resolve;
    });
    let releaseFirstWriter!: () => void;
    const holdFirstWriter = new Promise<void>((resolve) => {
      releaseFirstWriter = resolve;
    });

    const firstWriter = audited.withAuditTransaction(
      async (tx: any) => {
        await tx.user.update({
          where: { id: user.id },
          data: { name: 'Concurrent Writer One' },
        });
        firstUpdateFinished();
        await holdFirstWriter;
      },
      { timeout: 10_000 },
    );
    await firstUpdated;

    const secondWriter = audited.withAuditTransaction(
      (tx: any) =>
        tx.user.update({
          where: { id: user.id },
          data: { name: 'Concurrent Writer Two' },
        }),
      { timeout: 10_000 },
    );

    try {
      await waitForBlockedRowLock(basePrisma);
    } finally {
      releaseFirstWriter();
    }
    await Promise.all([firstWriter, secondWriter]);

    expect(await userName(basePrisma, user.email)).toBe(
      'Concurrent Writer Two',
    );
    const logs = await auditLogs(basePrisma, 'User.updated');
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.changes.name)).toEqual([
      { before: 'Concurrent Initial', after: 'Concurrent Writer One' },
      { before: 'Concurrent Writer One', after: 'Concurrent Writer Two' },
    ]);
  }, 15_000);
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

async function auditCount(
  prisma: PrismaClient,
  action: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM audit_logs WHERE action = ${action}
  `;
  return Number(rows[0].count);
}

async function totalAuditCount(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM audit_logs
  `;
  return Number(rows[0].count);
}

async function auditLogs(prisma: PrismaClient, action: string): Promise<any[]> {
  return prisma.$queryRaw<any[]>`
    SELECT * FROM audit_logs WHERE action = ${action} ORDER BY created_at, id
  `;
}

async function seedUser(
  prisma: PrismaClient,
  input: { name: string; email: string },
): Promise<any> {
  return prisma.user.create({
    data: { ...input, password: 'pw' },
  });
}

async function userName(
  prisma: PrismaClient,
  email: string,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM users WHERE email = ${email}
  `;
  return rows[0]?.name ?? null;
}

function createFaultInjectedAuditedClient(
  prisma: PrismaClient,
  message: string,
): any {
  const faultInjected = prisma.$extends({
    name: '@nestarc/audit-log-e2e-read-fault',
    query: {
      user: {
        findFirst() {
          throw new Error(message);
        },
      },
    },
  });
  return createAuditedClient(faultInjected, {
    consistency: 'atomic-required',
    trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users' } },
    logger: silentLogger,
    prismaModule,
  });
}

function createLifecycleDeleteRewrite(
  client: any,
  targetId: string,
  callback: (tx: any) => Promise<any>,
): any {
  const lifecycleClient: any = client.$extends({
    name: '@nestarc/audit-log-e2e-delete-lifecycle-rewrite',
    query: {
      user: {
        delete({ args, query }: any) {
          if (args.where?.id !== targetId) {
            return query(args);
          }
          return lifecycleClient.withAuditLifecycle(
            {
              action: 'User.softDeleted',
              metadata: {
                auditKind: 'record',
                lifecycle: 'soft-delete',
                lifecycleOperation: 'delete',
              },
              suppressOuterOperation: { model: 'User', operation: 'delete' },
            },
            callback,
          );
        },
      },
    },
  });
  return lifecycleClient;
}

function createLifecycleDeleteManyRewrite(
  client: any,
  targetIds: string[],
  callback: (tx: any) => Promise<any>,
): any {
  const lifecycleClient: any = client.$extends({
    name: '@nestarc/audit-log-e2e-delete-many-lifecycle-rewrite',
    query: {
      user: {
        deleteMany({ args, query }: any) {
          const ids = args.where?.id?.in;
          if (
            !Array.isArray(ids) ||
            ids.length !== targetIds.length ||
            !targetIds.every((targetId) => ids.includes(targetId))
          ) {
            return query(args);
          }
          return lifecycleClient.withAuditLifecycle(
            {
              action: 'User.softDeleted',
              metadata: {
                auditKind: 'record',
                lifecycle: 'soft-delete',
                lifecycleOperation: 'deleteMany',
              },
              suppressOuterOperation: {
                model: 'User',
                operation: 'deleteMany',
              },
            },
            callback,
          );
        },
      },
    },
  });
  return lifecycleClient;
}

async function waitForBlockedRowLock(prisma: PrismaClient): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FOR UPDATE%'
    `;
    if (Number(rows[0].count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the concurrent writer row lock');
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
