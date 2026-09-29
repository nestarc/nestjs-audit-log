import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Req,
  INestApplication,
  Injectable,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  createTestPrismaClient,
  PrismaClient,
  prismaModule,
} from './prisma-client';
import request from 'supertest';
import { AuditService } from '../../src/services/audit.service';
import { AuditLogModule } from '../../src/audit-log.module';
import { createAuditExtension } from '../../src/prisma/audit-extension';
import { NoAudit } from '../../src/decorators/no-audit.decorator';
import { AuditAction } from '../../src/decorators/audit-action.decorator';
import { AuditReason } from '../../src/decorators/audit-reason.decorator';
import { applyAuditTableSchema } from '../../src/sql';

describe('HTTP path E2E', () => {
  let app: INestApplication;
  let basePrisma: PrismaClient;
  let prisma: any;
  let httpServer: any;

  beforeAll(async () => {
    basePrisma = createTestPrismaClient();
    await resetAuditStorage(basePrisma);
    prisma = basePrisma.$extends(
      createAuditExtension({
        consistency: 'best-effort',
        actorRequired: true,
        trackedModels: ['User'],
        logger: silentLogger,
        prismaModule,
      }),
    );

    const atomic: any = basePrisma.$extends(createAuditExtension({
      consistency: 'atomic-required', actorRequired: true,
      trackedModels: ['User'], logger: silentLogger, prismaModule,
    }));

    @Injectable()
    class AuthenticationGuard implements CanActivate {
      async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        await Promise.resolve();
        req.user = { id: req.headers['x-user-id'] };
        return true;
      }
    }

    @Controller('http-audit')
    @UseGuards(AuthenticationGuard)
    class HttpAuditController {
      constructor(private readonly audit: AuditService) {}

      @Get('read')
      read() { return { ok: true }; }

      @Post('required')
      async required(@Req() req: any) {
        await atomic.withAuditTransaction(async (tx: any) => {
          const user = await tx.user.create({ data: {
            name: 'Required', email: `${req.headers['x-user-id'] ?? 'missing'}@test.com`, password: 'pw',
          } });
          await this.audit.log({ action: 'User.manual', targetType: 'User', targetId: user.id }, tx);
        });
        return { ok: true };
      }

      @Post('no-audit-manual')
      @NoAudit()
      async manual() {
        await this.audit.log({ action: 'manual' });
        return { ok: true };
      }

      @Post('users')
      async createUser() {
        await prisma.user.create({
          data: {
            name: 'HTTP User',
            email: 'http-user@test.com',
            password: 'pw',
          },
        });
        return { ok: true };
      }

      @Post('no-audit')
      @NoAudit()
      async noAudit() {
        await prisma.user.create({
          data: {
            name: 'No Audit',
            email: 'no-audit@test.com',
            password: 'pw',
          },
        });
        return { ok: true };
      }

      @Post('action')
      @AuditAction('user.http.custom')
      @AuditReason('handler reason')
      async actionOverride() {
        await prisma.user.create({
          data: {
            name: 'Action User',
            email: 'action-user@test.com',
            password: 'pw',
          },
        });
        return { ok: true };
      }
    }

    @Controller('http-audit-class-no-audit')
    @NoAudit()
    class ClassNoAuditController {
      @Post('users')
      async createUser() {
        await prisma.user.create({
          data: {
            name: 'Class No Audit',
            email: 'class-no-audit@test.com',
            password: 'pw',
          },
        });
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuditLogModule.forRoot({
          prisma: basePrisma,
          actorExtractionStage: 'interceptor',
          actorRequired: true,
          actorExtractor: async (req: any) => {
            if (req.headers['x-extractor-failure']) throw new Error('extractor failed');
            return {
              id: req.user?.id ?? null,
              type: 'user' as const,
              ip: req.ip,
            };
          },
          logger: silentLogger,
          prismaModule,
        }),
      ],
      controllers: [HttpAuditController, ClassNoAuditController],
    })
    class TestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer();
  });

  beforeEach(async () => {
    await clearData(basePrisma);
  });

  afterAll(async () => {
    await clearData(basePrisma);
    await basePrisma.$disconnect();
    await app.close();
  });

  it('records the authenticated actor after guards and correlationId from a real HTTP request', async () => {
    await request(httpServer)
      .post('/http-audit/users')
      .set('x-user-id', 'http-actor')
      .set('x-request-id', 'req-http-1')
      .expect(201);

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT actor_id, metadata FROM audit_logs WHERE action = 'User.created'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe('http-actor');
    expect(logs[0].metadata).toEqual({ correlationId: 'req-http-1' });
  });

  it('keeps concurrent Guard actors isolated in automatic and manual records', async () => {
    await Promise.all(['http-one', 'http-two'].map(id =>
      request(httpServer).post('/http-audit/required').set('x-user-id', id).expect(201),
    ));
    const logs = await basePrisma.auditLog.findMany();
    expect(logs).toHaveLength(4);
    for (const id of ['http-one', 'http-two']) {
      const user = await basePrisma.user.findUnique({ where: { email: `${id}@test.com` } });
      const rows = logs.filter((row: any) => row.targetId === user.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((row: any) => row.actorId === id && row.actorType === 'user')).toBe(true);
    }
  });

  it('rejects missing Guard actors at atomic writes and explicit NoAudit manual logs', async () => {
    await request(httpServer).post('/http-audit/required').expect(500);
    await request(httpServer).post('/http-audit/no-audit-manual').expect(500);
    expect(await basePrisma.user.count()).toBe(0);
    expect(await basePrisma.auditLog.count()).toBe(0);
  });

  it('extractor failure leaves reads usable and is enforced when a tracked write is reached', async () => {
    await request(httpServer).get('/http-audit/read').set('x-extractor-failure', 'true').expect(200);
    await request(httpServer).post('/http-audit/required').set('x-extractor-failure', 'true').expect(500);
    expect(await basePrisma.user.count()).toBe(0);
    expect(await basePrisma.auditLog.count()).toBe(0);
  });

  it('best-effort HTTP writes preserve business behavior without an actor', async () => {
    await request(httpServer).post('/http-audit/users').expect(201);
    expect(await basePrisma.user.count()).toBe(1);
    expect(await basePrisma.auditLog.count()).toBe(0);
  });

  it('honors @NoAudit on a real HTTP handler', async () => {
    await request(httpServer)
      .post('/http-audit/no-audit')
      .set('x-user-id', 'http-actor')
      .expect(201);

    const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM audit_logs
    `;
    expect(Number(rows[0].count)).toBe(0);
  });

  it('honors @NoAudit on a real HTTP controller class', async () => {
    await request(httpServer)
      .post('/http-audit-class-no-audit/users')
      .set('x-user-id', 'http-actor')
      .expect(201);

    const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM audit_logs
    `;
    expect(Number(rows[0].count)).toBe(0);
  });

  it('applies @AuditAction and @AuditReason through the global interceptor', async () => {
    await request(httpServer)
      .post('/http-audit/action')
      .set('x-user-id', 'http-actor')
      .expect(201);

    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT action, metadata FROM audit_logs
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('user.http.custom');
    expect(logs[0].metadata).toEqual({ reason: 'handler reason' });
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
