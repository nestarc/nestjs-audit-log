import {
  createTestPrismaClient,
  Prisma,
  PrismaClient,
  prismaModule,
} from './prisma-client';
import { AuditService } from '../../src/services/audit.service';
import { applyAuditTableSchema } from '../../src/sql';
import { AuditScanPage } from '../../src/interfaces/audit-entry.interface';

const TABLE = 'audit_logs_phase6_export';

type SeedRow = {
  id: string;
  tenantId: string;
  action: string;
  createdAt: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

function uuid(n: number): string {
  return `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

describe('Phase 6 tenant-scoped streaming export E2E', () => {
  let prisma: PrismaClient;
  let service: AuditService;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    service = new AuditService({
      prisma,
      actorExtractor: () => ({ id: null, type: 'system' }),
      tableName: TABLE,
      prismaModule,
    });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await applyAuditTableSchema(prisma, { tableName: TABLE });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await prisma.$disconnect();
  });

  async function seed(rows: SeedRow[]): Promise<void> {
    for (const row of rows) {
      await prisma.$executeRaw`
        INSERT INTO ${Prisma.raw(TABLE)}
          (id, tenant_id, actor_id, actor_type, action, target_type, target_id,
           source, changes, metadata, result, created_at)
        VALUES (
          ${row.id}::uuid,
          ${row.tenantId},
          ${row.actorId ?? null},
          'user',
          ${row.action},
          ${row.targetType ?? null},
          ${row.targetId ?? null},
          'manual',
          ${row.changes === undefined ? null : JSON.stringify(row.changes)}::jsonb,
          ${row.metadata === undefined ? null : JSON.stringify(row.metadata)}::jsonb,
          'success',
          ${row.createdAt}::timestamptz
        )
      `;
    }
  }

  function tenantRows(): SeedRow[] {
    return Array.from({ length: 5 }, (_unused, index) => ({
      id: uuid(index + 1),
      tenantId: 'tenant-1',
      actorId: index % 2 === 0 ? 'actor-a' : 'actor-b',
      action: `export.${index + 1}`,
      targetType: 'User',
      targetId: `user-${index + 1}`,
      createdAt: `2026-08-21T12:00:0${index}.00000${index}Z`,
    }));
  }

  it('scans forward without tenant leaks and excludes rows beyond the fixed high-watermark', async () => {
    await seed([
      ...tenantRows(),
      {
        id: uuid(90),
        tenantId: 'tenant-2',
        action: 'other-tenant',
        createdAt: '2026-08-21T12:00:02.500000Z',
      },
    ]);

    const iterator = service.scan({ tenantId: 'tenant-1', batchSize: 2 })[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const firstPage = first.value as AuditScanPage;
    expect(firstPage.entries.map((entry) => entry.id)).toEqual([uuid(1), uuid(2)]);

    await seed([
      {
        id: uuid(99),
        tenantId: 'tenant-1',
        action: 'inserted.during.export',
        createdAt: '2026-08-21T13:00:00.000000Z',
      },
    ]);

    const pages: AuditScanPage[] = [firstPage];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      pages.push(next.value);
    }

    expect(pages.map((page) => page.entries.length)).toEqual([2, 2, 1]);
    expect(new Set(pages.map((page) => page.highWatermark)).size).toBe(1);
    expect(pages.flatMap((page) => page.entries.map((entry) => entry.id))).toEqual(
      tenantRows().map((row) => row.id),
    );
    expect(pages.flatMap((page) => page.entries).every((entry) => entry.tenantId === 'tenant-1'))
      .toBe(true);
  });

  it('resumes exclusively after a checkpoint and respects the original until watermark', async () => {
    await seed(tenantRows());
    const firstIterator = service.scan({ tenantId: 'tenant-1', batchSize: 2 })[
      Symbol.asyncIterator
    ]();
    const first = await firstIterator.next();
    expect(first.done).toBe(false);

    await seed([
      {
        id: uuid(99),
        tenantId: 'tenant-1',
        action: 'later',
        createdAt: '2026-08-21T13:00:00.000000Z',
      },
    ]);

    const resumedIds: string[] = [];
    for await (const page of service.scan({
      tenantId: 'tenant-1',
      batchSize: 2,
      after: first.value.checkpoint!,
      until: first.value.highWatermark,
    })) {
      resumedIds.push(...page.entries.map((entry) => entry.id));
    }
    expect(resumedIds).toEqual([uuid(3), uuid(4), uuid(5)]);
  });

  it('applies export filters while allowing intentional all-tenant scans', async () => {
    await seed([
      ...tenantRows(),
      {
        id: uuid(90),
        tenantId: 'tenant-2',
        actorId: 'actor-a',
        action: 'export.other',
        targetType: 'Invoice',
        targetId: 'invoice-1',
        createdAt: '2026-08-21T12:00:05.000000Z',
      },
    ]);

    const entries = [];
    for await (const page of service.scan({
      allTenants: true,
      actorId: 'actor-a',
      action: 'export.*',
      targetType: 'User',
      from: new Date('2026-08-21T12:00:01.000000Z'),
      to: new Date('2026-08-21T12:00:04.999999Z'),
    })) {
      entries.push(...page.entries);
    }
    expect(entries.map((entry) => entry.id)).toEqual([uuid(3), uuid(5)]);
  });

  it('streams CSV v1 with canonical JSON, RFC 4180 escaping, and formula defense', async () => {
    await seed([
      {
        id: uuid(1),
        tenantId: 'tenant-1',
        action: '=HYPERLINK("https://invalid.example")',
        targetType: 'User,Admin',
        targetId: 'user-1',
        changes: { z: { after: 'line\none' }, a: { before: 1 } },
        metadata: { z: 2, a: { y: 2, x: 1 } },
        createdAt: '2026-08-21T12:00:00.123456Z',
      },
      {
        id: uuid(2),
        tenantId: 'tenant-2',
        action: 'must.not.leak',
        createdAt: '2026-08-21T12:00:01.000000Z',
      },
    ]);

    const chunks: Buffer[] = [];
    for await (const chunk of service.exportCsv({
      tenantId: 'tenant-1',
      columns: 'v1',
      batchSize: 1,
    })) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const csv = Buffer.concat(chunks).toString('utf8');

    expect(csv).toContain('schemaVersion,id,tenantId');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"User,Admin"');
    expect(csv).toContain('"{""a"":{""before"":1},""z"":{""after"":""line\\none""}}"');
    expect(csv).toContain('"{""a"":{""x"":1,""y"":2},""z"":2}"');
    expect(csv).not.toContain('must.not.leak');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
