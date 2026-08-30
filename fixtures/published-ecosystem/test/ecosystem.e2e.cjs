'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaPg } = require('@prisma/adapter-pg');
const { getDMMF } = require('@prisma/internals');
const { Test } = require('@nestjs/testing');
const {
  applyAuditTableSchema,
  createAuditExtension,
} = require('@nestarc/audit-log');
const {
  createPrismaSoftDeleteExtension,
  SoftDeleteModule,
  SoftDeleteService,
} = require('@nestarc/soft-delete');
const {
  createPrismaTenancyExtension,
  TenancyContext,
  TenancyService,
} = require('@nestarc/tenancy');
const { Prisma, PrismaClient } = require('../generated/prisma/client.ts');

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';
const TENANT_ID = 'tenant-published-gate';
const PRISMA_TOKEN = Symbol('PUBLISHED_ECOSYSTEM_PRISMA');
const trackedModels = ['User', 'Post'];
const databaseMapping = {
  User: { tableName: 'users' },
  Post: { tableName: 'posts' },
};
const cascade = { User: ['Post'] };
const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');

const CREATE_TABLES = [
  `CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    deleted_at TIMESTAMPTZ
  )`,
  `CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    author_id UUID NOT NULL REFERENCES users(id),
    deleted_at TIMESTAMPTZ
  )`,
];

async function main() {
  const base = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });
  let moduleRef;

  try {
    await base.$connect();
    await recreateSchema(base);

    const dmmf = await getDMMF({
      datamodel: fs.readFileSync(schemaPath, 'utf8'),
    });
    const tenancyContext = new TenancyContext();
    const tenancyService = new TenancyService(tenancyContext);
    const softDeleteOptions = {
      softDeleteModels: trackedModels,
      deletedAtField: 'deletedAt',
      cascade,
      dmmf,
      auditLifecycle: 'atomic-required',
      auditMaxBatchRecords: 10,
    };
    const client = base
      .$extends(
        createPrismaTenancyExtension(tenancyService, {
          interactiveTransactionSupport: true,
          failClosed: true,
        }),
      )
      .$extends(
        createAuditExtension({
          consistency: 'atomic-required',
          trackedModels,
          tenantRequired: true,
          maxBatchRecords: 10,
          databaseMapping,
          prismaModule: { Prisma },
        }),
      )
      .$extends(createPrismaSoftDeleteExtension(softDeleteOptions));

    class FixturePrismaModule {}
    const fixturePrismaModule = {
      module: FixturePrismaModule,
      global: true,
      providers: [{ provide: PRISMA_TOKEN, useValue: client }],
      exports: [PRISMA_TOKEN],
    };
    moduleRef = await Test.createTestingModule({
      imports: [
        fixturePrismaModule,
        SoftDeleteModule.forRootAsync({
          imports: [fixturePrismaModule],
          prismaServiceToken: PRISMA_TOKEN,
          useFactory: () => ({
            ...softDeleteOptions,
            prismaServiceToken: PRISMA_TOKEN,
          }),
        }),
      ],
    }).compile();
    const softDeleteService = moduleRef.get(SoftDeleteService);
    const withTenantAuditTransaction = (callback) =>
      tenancyContext.run(TENANT_ID, () =>
        client.withAuditTransaction(callback),
      );

    await runCase(base, 'transaction commit and rollback are atomic', async () => {
      const user = await base.user.create({
        data: { email: 'atomic@test.dev', name: 'Before commit' },
      });

      await withTenantAuditTransaction((tx) =>
        tx.user.update({
          where: { id: user.id },
          data: { name: 'Committed' },
        }),
      );

      assert.equal(
        (await base.user.findUniqueOrThrow({ where: { id: user.id } })).name,
        'Committed',
      );
      const [committedAudit] = await auditRows(base);
      assert.equal(committedAudit.action, 'User.updated');
      assert.equal(committedAudit.tenant_id, TENANT_ID);
      assert.equal(committedAudit.target_id, user.id);
      assert.deepEqual(committedAudit.changes.name, {
        before: 'Before commit',
        after: 'Committed',
      });

      await assert.rejects(
        withTenantAuditTransaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { name: 'Rolled back' },
          });
          throw new Error('fixture rollback marker');
        }),
        /fixture rollback marker/,
      );

      assert.equal(
        (await base.user.findUniqueOrThrow({ where: { id: user.id } })).name,
        'Committed',
      );
      assert.equal((await auditRows(base)).length, 1);
    });

    await runCase(base, 'soft-delete and cascade restore keep record evidence', async () => {
      const user = await base.user.create({
        data: {
          email: 'cascade@test.dev',
          name: 'Cascade',
          posts: { create: { title: 'Cascade post' } },
        },
        include: { posts: true },
      });
      const post = user.posts[0];

      await withTenantAuditTransaction((tx) =>
        tx.user.delete({ where: { id: user.id } }),
      );

      const deletedUser = await base.user.findUniqueOrThrow({ where: { id: user.id } });
      const deletedPost = await base.post.findUniqueOrThrow({ where: { id: post.id } });
      assert.ok(deletedUser.deletedAt instanceof Date);
      assert.ok(deletedPost.deletedAt instanceof Date);
      const userDeletedAt = deletedUser.deletedAt.toISOString();
      const postDeletedAt = deletedPost.deletedAt.toISOString();
      const deleteRows = await auditRows(base);
      assert.deepEqual(
        deleteRows.map((row) => row.action).sort(),
        ['Post.softDeleted', 'User.softDeleted'],
      );
      assertLifecycleRow(findRow(deleteRows, 'User.softDeleted'), {
        targetId: user.id,
        operation: 'delete',
        before: null,
        after: userDeletedAt,
      });
      assertLifecycleRow(findRow(deleteRows, 'Post.softDeleted'), {
        targetId: post.id,
        operation: 'cascadeDelete',
        before: null,
        after: postDeletedAt,
      });

      await assert.rejects(
        withTenantAuditTransaction(async () => {
          await softDeleteService.restore('User', { id: user.id });
          throw new Error('restore rollback marker');
        }),
        /restore rollback marker/,
      );
      assert.equal(
        (
          await base.user.findUniqueOrThrow({ where: { id: user.id } })
        ).deletedAt.toISOString(),
        userDeletedAt,
      );
      assert.equal(
        (
          await base.post.findUniqueOrThrow({ where: { id: post.id } })
        ).deletedAt.toISOString(),
        postDeletedAt,
      );
      assert.deepEqual(
        (await auditRows(base)).map((row) => row.action).sort(),
        ['Post.softDeleted', 'User.softDeleted'],
      );

      await withTenantAuditTransaction(() =>
        softDeleteService.restore('User', { id: user.id }),
      );

      assert.equal(
        (await base.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt,
        null,
      );
      assert.equal(
        (await base.post.findUniqueOrThrow({ where: { id: post.id } })).deletedAt,
        null,
      );
      const lifecycleRows = await auditRows(base);
      assert.deepEqual(
        lifecycleRows.map((row) => row.action).sort(),
        [
          'Post.restored',
          'Post.softDeleted',
          'User.restored',
          'User.softDeleted',
        ],
      );
      assertLifecycleRow(findRow(lifecycleRows, 'User.restored'), {
        targetId: user.id,
        operation: 'restore',
        before: userDeletedAt,
        after: null,
      });
      assertLifecycleRow(findRow(lifecycleRows, 'Post.restored'), {
        targetId: post.id,
        operation: 'cascadeRestore',
        before: postDeletedAt,
        after: null,
      });
    });

    await runCase(base, 'cascade rollback removes business and audit changes', async () => {
      const user = await base.user.create({
        data: {
          email: 'cascade-rollback@test.dev',
          name: 'Cascade rollback',
          posts: { create: { title: 'Rollback post' } },
        },
        include: { posts: true },
      });
      const post = user.posts[0];

      await assert.rejects(
        withTenantAuditTransaction(async (tx) => {
          await tx.user.delete({ where: { id: user.id } });
          throw new Error('cascade rollback marker');
        }),
        /cascade rollback marker/,
      );

      assert.equal(
        (await base.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt,
        null,
      );
      assert.equal(
        (await base.post.findUniqueOrThrow({ where: { id: post.id } })).deletedAt,
        null,
      );
      assert.equal((await auditRows(base)).length, 0);
    });

    await runCase(base, 'purge records preimage evidence before physical deletion', async () => {
      const deletedAt = new Date('2026-01-01T00:00:00.000Z');
      const user = await base.user.create({
        data: {
          email: 'purge@test.dev',
          name: 'Purge',
          deletedAt,
        },
      });

      await assert.rejects(
        withTenantAuditTransaction(async () => {
          const rollbackResult = await softDeleteService.purge('User', {
            olderThan: new Date('2026-02-01T00:00:00.000Z'),
            where: { id: user.id },
          });
          assert.equal(rollbackResult.count, 1);
          throw new Error('purge rollback marker');
        }),
        /purge rollback marker/,
      );
      assert.equal(
        (
          await base.user.findUniqueOrThrow({ where: { id: user.id } })
        ).deletedAt.toISOString(),
        deletedAt.toISOString(),
      );
      assert.equal((await auditRows(base)).length, 0);

      const result = await withTenantAuditTransaction(() =>
        softDeleteService.purge('User', {
          olderThan: new Date('2026-02-01T00:00:00.000Z'),
          where: { id: user.id },
        }),
      );

      assert.equal(result.count, 1);
      assert.equal(await base.user.findUnique({ where: { id: user.id } }), null);
      const purgeRows = await auditRows(base);
      assert.deepEqual(purgeRows.map((row) => row.action), ['User.purged']);
      const purgeRow = findRow(purgeRows, 'User.purged');
      assert.equal(purgeRow.tenant_id, TENANT_ID);
      assert.equal(purgeRow.target_id, user.id);
      assert.equal(purgeRow.metadata.auditKind, 'record');
      assert.equal(purgeRow.metadata.lifecycle, 'soft-delete');
      assert.equal(purgeRow.metadata.lifecycleOperation, 'purge');
      assert.deepEqual(purgeRow.changes.deletedAt, {
        before: deletedAt.toISOString(),
      });
    });

    console.log('Ecosystem E2E: 4 scenarios passed');
  } finally {
    await moduleRef?.close();
    await dropSchema(base).catch((error) => {
      console.error('Fixture schema cleanup failed:', error);
    });
    await base.$disconnect().catch((error) => {
      console.error('Fixture database disconnect failed:', error);
    });
  }
}

async function runCase(base, name, callback) {
  await base.$executeRawUnsafe('TRUNCATE TABLE audit_logs, posts, users CASCADE');
  await callback();
  console.log(`ok - ${name}`);
}

async function recreateSchema(base) {
  await dropSchema(base);
  for (const statement of CREATE_TABLES) {
    await base.$executeRawUnsafe(statement);
  }
  await applyAuditTableSchema(base);
}

async function dropSchema(base) {
  await base.$executeRawUnsafe('DROP TABLE IF EXISTS audit_logs CASCADE');
  await base.$executeRawUnsafe('DROP TABLE IF EXISTS posts CASCADE');
  await base.$executeRawUnsafe('DROP TABLE IF EXISTS users CASCADE');
}

async function auditRows(base) {
  return base.$queryRawUnsafe(
    `SELECT action, tenant_id, target_id, changes, metadata
     FROM audit_logs
     ORDER BY created_at, id`,
  );
}

function findRow(rows, action) {
  const matches = rows.filter((row) => row.action === action);
  assert.equal(matches.length, 1, `expected one ${action} row`);
  return matches[0];
}

function assertLifecycleRow(row, expected) {
  assert.equal(row.tenant_id, TENANT_ID);
  assert.equal(row.target_id, expected.targetId);
  assert.equal(row.metadata.auditKind, 'record');
  assert.equal(row.metadata.lifecycle, 'soft-delete');
  assert.equal(row.metadata.lifecycleOperation, expected.operation);
  assert.deepEqual(row.changes.deletedAt, {
    before: expected.before,
    after: expected.after,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
