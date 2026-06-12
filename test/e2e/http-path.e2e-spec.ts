import {
  Controller,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AddressInfo } from 'net';
import { AuditLogModule } from '../../src/audit-log.module';
import { createAuditExtension } from '../../src/prisma/audit-extension';
import { NoAudit } from '../../src/decorators/no-audit.decorator';
import { AuditAction } from '../../src/decorators/audit-action.decorator';
import { AuditReason } from '../../src/decorators/audit-reason.decorator';
import { applyAuditTableSchema } from '../../src/sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

describe('HTTP path E2E', () => {
  let app: INestApplication;
  let basePrisma: PrismaClient;
  let prisma: any;
  let baseUrl: string;

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

    @Controller('http-audit')
    class HttpAuditController {
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

    @Module({
      imports: [
        AuditLogModule.forRoot({
          prisma: basePrisma,
          actorExtractor: async (req: any) => ({
            id: req.headers?.['x-user-id'] ?? null,
            type: 'user' as const,
            ip: req.ip,
          }),
          logger: silentLogger,
        }),
      ],
      controllers: [HttpAuditController],
    })
    class TestModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await clearData(basePrisma);
  });

  afterAll(async () => {
    await clearData(basePrisma);
    await basePrisma.$disconnect();
    await app.close();
  });

  it('records actor and correlationId from a real HTTP request', async () => {
    const response = await fetch(`${baseUrl}/http-audit/users`, {
      method: 'POST',
      headers: {
        'x-user-id': 'http-actor',
        'x-request-id': 'req-http-1',
      },
    });

    expect(response.status).toBe(201);
    const logs = await basePrisma.$queryRaw<any[]>`
      SELECT actor_id, metadata FROM audit_logs WHERE action = 'User.created'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe('http-actor');
    expect(logs[0].metadata).toEqual({ correlationId: 'req-http-1' });
  });

  it('honors @NoAudit on a real HTTP handler', async () => {
    const response = await fetch(`${baseUrl}/http-audit/no-audit`, {
      method: 'POST',
      headers: { 'x-user-id': 'http-actor' },
    });

    expect(response.status).toBe(201);
    const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM audit_logs
    `;
    expect(Number(rows[0].count)).toBe(0);
  });

  it('applies @AuditAction and @AuditReason through the global interceptor', async () => {
    const response = await fetch(`${baseUrl}/http-audit/action`, {
      method: 'POST',
      headers: { 'x-user-id': 'http-actor' },
    });

    expect(response.status).toBe(201);
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
