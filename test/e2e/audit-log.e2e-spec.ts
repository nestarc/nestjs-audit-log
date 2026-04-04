import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get, Patch, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuditLogModule } from '../../src/audit-log.module';
import { AuditService } from '../../src/services/audit.service';
import { createAuditExtension } from '../../src/prisma/audit-extension';
import { AuditContext } from '../../src/services/audit-context';
import { NoAudit } from '../../src/decorators/no-audit.decorator';
import { AuditAction } from '../../src/decorators/audit-action.decorator';
import { applyAuditTableSchema } from '../../src/sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

describe('AuditLog E2E', () => {
  let app: INestApplication;
  let basePrisma: PrismaClient;
  let prisma: any;
  let auditService: AuditService;

  const extensionOptions = {
    trackedModels: ['User'],
    sensitiveFields: ['password'],
  };

  beforeAll(async () => {
    basePrisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });

    // Provision audit_logs table + append-only rules + indexes
    // Self-contained: works even if prisma db push was not run
    await applyAuditTableSchema(basePrisma);

    prisma = basePrisma.$extends(createAuditExtension(extensionOptions));

    @Controller('test')
    class TestController {
      @Get('health')
      @NoAudit()
      health() {
        return { status: 'ok' };
      }

      @Patch('role')
      @AuditAction('user.role.changed')
      changeRole() {
        return { role: 'admin' };
      }
    }

    @Module({
      imports: [
        AuditLogModule.forRoot({
          prisma: basePrisma,
          actorExtractor: (req: any) => ({
            id: req.headers?.['x-user-id'] ?? null,
            type: 'user' as const,
            ip: req.ip,
          }),
          ...extensionOptions,
        }),
      ],
      controllers: [TestController],
    })
    class TestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    auditService = moduleFixture.get(AuditService);
  });

  beforeEach(async () => {
    // Temporarily drop append-only rules for test cleanup
    await basePrisma.$executeRawUnsafe(
      `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
    );
    await basePrisma.$executeRaw`DELETE FROM audit_logs`;
    await basePrisma.$executeRaw`DELETE FROM users`;
    // Re-create rule
    await basePrisma.$executeRawUnsafe(
      `CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING`,
    );
  });

  afterAll(async () => {
    await basePrisma.$executeRawUnsafe(
      `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
    );
    await basePrisma.$executeRawUnsafe(
      `DROP RULE IF EXISTS audit_logs_no_update ON audit_logs`,
    );
    await basePrisma.$executeRaw`DELETE FROM audit_logs`;
    await basePrisma.$executeRaw`DELETE FROM users`;
    await basePrisma.$disconnect();
    await app.close();
  });

  describe('Automatic CUD tracking', () => {
    it('tracks user creation with after-only changes', async () => {
      await AuditContext.run(
        {
          actor: { id: 'admin-1', type: 'user', ip: '10.0.0.1' },
          noAudit: false,
        },
        async () => {
          await prisma.user.create({
            data: {
              name: 'Alice',
              email: 'alice@test.com',
              password: 'secret',
            },
          });
        },
      );

      const logs = await basePrisma.$queryRaw<any[]>`
        SELECT * FROM audit_logs WHERE action = 'User.created'
      `;

      expect(logs).toHaveLength(1);
      expect(logs[0].actor_id).toBe('admin-1');
      expect(logs[0].target_type).toBe('User');
      expect(logs[0].source).toBe('auto');

      const changes = logs[0].changes;
      expect(changes.name.after).toBe('Alice');
      expect(changes.email.after).toBe('alice@test.com');
      expect(changes.password.after).toBe('[REDACTED]');
    });

    it('tracks user update with before/after diff', async () => {
      // Create user (will generate audit log)
      const user = await AuditContext.run(
        { actor: { id: 'admin-1', type: 'user' }, noAudit: false },
        () =>
          prisma.user.create({
            data: { name: 'Bob', email: 'bob@test.com', password: 'pw' },
          }),
      );

      // Clear the create audit log
      await basePrisma.$executeRawUnsafe(
        `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
      );
      await basePrisma.$executeRaw`DELETE FROM audit_logs`;
      await basePrisma.$executeRawUnsafe(
        `CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING`,
      );

      await AuditContext.run(
        { actor: { id: 'admin-1', type: 'user' }, noAudit: false },
        async () => {
          await prisma.user.update({
            where: { id: user.id },
            data: { email: 'bob-new@test.com' },
          });
        },
      );

      const logs = await basePrisma.$queryRaw<any[]>`
        SELECT * FROM audit_logs WHERE action = 'User.updated'
      `;

      expect(logs).toHaveLength(1);
      expect(logs[0].changes.email.before).toBe('bob@test.com');
      expect(logs[0].changes.email.after).toBe('bob-new@test.com');
    });

    it('tracks user deletion with before-only changes', async () => {
      const user = await AuditContext.run(
        { actor: { id: 'admin-1', type: 'user' }, noAudit: false },
        () =>
          prisma.user.create({
            data: {
              name: 'Charlie',
              email: 'charlie@test.com',
              password: 'pw',
            },
          }),
      );

      await basePrisma.$executeRawUnsafe(
        `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
      );
      await basePrisma.$executeRaw`DELETE FROM audit_logs`;
      await basePrisma.$executeRawUnsafe(
        `CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING`,
      );

      await AuditContext.run(
        { actor: { id: 'admin-1', type: 'user' }, noAudit: false },
        async () => {
          await prisma.user.delete({ where: { id: user.id } });
        },
      );

      const logs = await basePrisma.$queryRaw<any[]>`
        SELECT * FROM audit_logs WHERE action = 'User.deleted'
      `;

      expect(logs).toHaveLength(1);
      expect(logs[0].changes.name.before).toBe('Charlie');
      expect(logs[0].changes.password.before).toBe('[REDACTED]');
    });
  });

  describe('noAudit context', () => {
    it('skips tracking when noAudit is true', async () => {
      await AuditContext.run(
        { actor: { id: 'admin-1', type: 'user' }, noAudit: true },
        async () => {
          await prisma.user.create({
            data: {
              name: 'Ghost',
              email: 'ghost@test.com',
              password: 'pw',
            },
          });
        },
      );

      const logs = await basePrisma.$queryRaw<any[]>`
        SELECT * FROM audit_logs
      `;
      expect(logs).toHaveLength(0);
    });
  });

  describe('Manual logging', () => {
    it('inserts a manual audit log entry', async () => {
      await AuditContext.run(
        {
          actor: { id: 'user-1', type: 'user', ip: '10.0.0.1' },
          noAudit: false,
        },
        () =>
          auditService.log({
            action: 'invoice.approved',
            targetId: 'inv-123',
            targetType: 'Invoice',
            metadata: { amount: 5000, currency: 'USD' },
          }),
      );

      const logs = await basePrisma.$queryRaw<any[]>`
        SELECT * FROM audit_logs WHERE action = 'invoice.approved'
      `;

      expect(logs).toHaveLength(1);
      expect(logs[0].source).toBe('manual');
      expect(logs[0].actor_id).toBe('user-1');
      expect(logs[0].metadata).toEqual({ amount: 5000, currency: 'USD' });
    });
  });

  describe('Query API', () => {
    it('queries audit logs with wildcard action filter', async () => {
      await AuditContext.run(
        { actor: { id: 'user-1', type: 'user' }, noAudit: false },
        async () => {
          await auditService.log({ action: 'user.login' });
          await auditService.log({ action: 'user.logout' });
          await auditService.log({
            action: 'invoice.created',
            targetType: 'Invoice',
          });
        },
      );

      const result = await auditService.query({ action: 'user.*' });

      expect(result.total).toBe(2);
      expect(result.entries).toHaveLength(2);
      expect(
        result.entries.every((e: any) => e.action.startsWith('user.')),
      ).toBe(true);
    });

    it('paginates results', async () => {
      await AuditContext.run(
        { actor: { id: 'user-1', type: 'user' }, noAudit: false },
        async () => {
          for (let i = 0; i < 5; i++) {
            await auditService.log({ action: `action.${i}` });
          }
        },
      );

      const page1 = await auditService.query({ limit: 2, offset: 0 });
      const page2 = await auditService.query({ limit: 2, offset: 2 });

      expect(page1.total).toBe(5);
      expect(page1.entries).toHaveLength(2);
      expect(page2.entries).toHaveLength(2);
    });
  });

  describe('deleteMany tracking', () => {
    it('logs individual records for deleteMany', async () => {
      await AuditContext.run(
        { actor: { id: 'admin', type: 'user' }, noAudit: false },
        async () => {
          await prisma.user.createMany({
            data: [
              { name: 'A', email: 'a@test.com', password: 'pw' },
              { name: 'B', email: 'b@test.com', password: 'pw' },
            ],
          });
        },
      );

      await basePrisma.$executeRawUnsafe(
        `DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs`,
      );
      await basePrisma.$executeRaw`DELETE FROM audit_logs`;
      await basePrisma.$executeRawUnsafe(
        `CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING`,
      );

      await AuditContext.run(
        { actor: { id: 'admin', type: 'user' }, noAudit: false },
        async () => {
          await prisma.user.deleteMany({
            where: { email: { contains: '@test.com' } },
          });
        },
      );

      const logs = await basePrisma.$queryRaw<any[]>`
        SELECT * FROM audit_logs WHERE action = 'User.deleted'
      `;

      expect(logs).toHaveLength(2);
    });
  });
});
