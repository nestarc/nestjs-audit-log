import {
  createTestPrismaClient,
  Prisma,
  PrismaClient,
  prismaModule,
} from './prisma-client';
import { AuditService } from '../../src/services/audit.service';
import { applyAuditTableSchema } from '../../src/sql';
import { AuditContext } from '../../src/services/audit-context';
import { createAuditExtension } from '../../src/prisma/audit-extension';

const TABLE = 'audit_logs_query_v2';
const PARTITIONED_TABLE = 'audit_logs_query_v2_part';

type SeedRow = {
  id: string;
  tenantId?: string | null;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'api_key';
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  source?: 'auto' | 'manual';
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  result?: 'success' | 'failure';
  createdAt: string;
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function monthPartitionName(tableName: string, date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${tableName}_y${year}m${month}`;
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

describe('Query API v2 E2E', () => {
  let prisma: PrismaClient;

  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeAll(async () => {
    prisma = createTestPrismaClient();
  });

  beforeEach(async () => {
    logger.warn.mockClear();
    logger.error.mockClear();
    await resetAuditTable(TABLE);
    await prisma.$executeRaw`DELETE FROM users`;
  });

  afterEach(async () => {
    await dropAuditTable(TABLE);
    await dropAuditTable(PARTITIONED_TABLE);
    await prisma.$executeRaw`DELETE FROM users`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function serviceFor(tableName = TABLE, client: PrismaClient = prisma): AuditService {
    return new AuditService({
      prisma: client,
      actorExtractor: () => ({ id: null, type: 'system' }),
      tableName,
      logger,
      prismaModule,
    });
  }

  async function resetAuditTable(tableName: string, partitioned = false): Promise<void> {
    await dropAuditTable(tableName);
    await applyAuditTableSchema(prisma, { tableName, partitioned });
  }

  async function dropAuditTable(tableName: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
  }

  async function seedAuditRows(
    rows: SeedRow[],
    tableName = TABLE,
    client: PrismaClient = prisma,
  ): Promise<void> {
    for (const row of rows) {
      await client.$executeRaw`
        INSERT INTO ${Prisma.raw(tableName)}
          (id, tenant_id, actor_id, actor_type, action, target_type, target_id,
           source, changes, metadata, result, created_at)
        VALUES (
          ${row.id}::uuid,
          ${row.tenantId ?? null},
          ${row.actorId ?? null},
          ${row.actorType ?? 'user'},
          ${row.action},
          ${row.targetType ?? null},
          ${row.targetId ?? null},
          ${row.source ?? 'auto'},
          ${row.changes === undefined ? null : JSON.stringify(row.changes)}::jsonb,
          ${row.metadata === undefined ? null : JSON.stringify(row.metadata)}::jsonb,
          ${row.result ?? 'success'},
          ${row.createdAt}::timestamptz
        )
      `;
    }
  }

  function descendingRows(count: number, startId = 1): SeedRow[] {
    return Array.from({ length: count }, (_unused, index) => ({
      id: uuid(startId + index),
      tenantId: 'tenant-1',
      actorId: `actor-${index % 3}`,
      action: `cursor.${index}`,
      createdAt: `2026-06-12T12:${String(59 - Math.floor(index / 60)).padStart(
        2,
        '0',
      )}:${String(59 - (index % 60)).padStart(2, '0')}.000000Z`,
    }));
  }

  it('walks 150 seeded rows with cursor pagination without duplicates or gaps', async () => {
    await seedAuditRows(descendingRows(150));
    const service = serviceFor();

    const seen = new Set<string>();
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    let pageNumber = 0;

    do {
      const page = await service.query({
        tenantId: 'tenant-1',
        limit: 50,
        cursor,
        includeTotal: false,
      });

      pageNumber += 1;
      pageSizes.push(page.entries.length);
      expect('total' in page).toBe(false);
      for (const entry of page.entries) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }

      if (pageNumber < 3) {
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toEqual(expect.any(String));
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(pageNumber).toBe(3);
    expect(pageSizes).toEqual([50, 50, 50]);
    expect(seen.size).toBe(150);
  });

  it('uses id as a stable tie-breaker when all rows share the same timestamp', async () => {
    const rows = Array.from({ length: 10 }, (_unused, index) => ({
      id: uuid(index + 1),
      tenantId: 'tenant-1',
      action: `same-ts.${index + 1}`,
      createdAt: '2026-06-12T12:00:00.123456Z',
    }));
    await seedAuditRows(rows);
    const service = serviceFor();

    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await service.query({
        tenantId: 'tenant-1',
        limit: 4,
        cursor,
        includeTotal: false,
      });
      seen.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(rows.map((row) => row.id).sort().reverse());
    expect(new Set(seen).size).toBe(10);
  });

  it('keeps the next cursor page stable when a newer row is inserted after page one', async () => {
    await seedAuditRows(descendingRows(60));
    const service = serviceFor();

    const page1 = await service.query({
      tenantId: 'tenant-1',
      limit: 25,
      includeTotal: false,
    });
    expect(page1.nextCursor).toEqual(expect.any(String));

    await seedAuditRows([
      {
        id: uuid(999),
        tenantId: 'tenant-1',
        action: 'cursor.inserted-after-page-one',
        createdAt: '2026-06-12T13:00:00.000000Z',
      },
    ]);

    const page2 = await service.query({
      tenantId: 'tenant-1',
      limit: 25,
      cursor: page1.nextCursor!,
      includeTotal: false,
    });

    const page1Ids = new Set(page1.entries.map((entry) => entry.id));
    expect(page2.entries).toHaveLength(25);
    expect(page2.entries.some((entry) => page1Ids.has(entry.id))).toBe(false);
    expect(page2.entries.some((entry) => entry.id === uuid(999))).toBe(false);
  });

  it('does not execute COUNT when includeTotal is false', async () => {
    await seedAuditRows(descendingRows(3));
    const queries: string[] = [];
    const loggingPrisma = createTestPrismaClient({
      log: [{ level: 'query', emit: 'event' }],
    });
    (loggingPrisma as any).$on('query', (event: { query: string }) =>
      queries.push(event.query),
    );
    await loggingPrisma.$connect();

    try {
      queries.length = 0;
      const page = await serviceFor(TABLE, loggingPrisma).query({
        tenantId: 'tenant-1',
        includeTotal: false,
      });

      expect('total' in page).toBe(false);
      expect(page.entries).toHaveLength(3);
      expect(queries.some((query) => /count\s*\(\s*\*/i.test(query))).toBe(false);
    } finally {
      await loggingPrisma.$disconnect();
    }
  });

  it('escapes wildcard action filters in PostgreSQL LIKE queries', async () => {
    await seedAuditRows([
      {
        id: uuid(1),
        tenantId: 'tenant-1',
        action: 'discount_50.applied',
        createdAt: '2026-06-12T12:00:03.000000Z',
      },
      {
        id: uuid(2),
        tenantId: 'tenant-1',
        action: 'discountX50.applied',
        createdAt: '2026-06-12T12:00:02.000000Z',
      },
      {
        id: uuid(3),
        tenantId: 'tenant-1',
        action: 'discount_500.applied',
        createdAt: '2026-06-12T12:00:01.000000Z',
      },
      {
        id: uuid(4),
        tenantId: 'tenant-1',
        action: '100%.applied',
        createdAt: '2026-06-12T12:00:00.000000Z',
      },
      {
        id: uuid(5),
        tenantId: 'tenant-1',
        action: '1000.applied',
        createdAt: '2026-06-12T11:59:59.000000Z',
      },
      {
        id: uuid(6),
        tenantId: 'tenant-1',
        action: 'aXXb%c_d',
        createdAt: '2026-06-12T11:59:58.000000Z',
      },
      {
        id: uuid(7),
        tenantId: 'tenant-1',
        action: 'aXXbXcXd',
        createdAt: '2026-06-12T11:59:57.000000Z',
      },
    ]);
    const service = serviceFor();

    await expect(
      service.query({
        tenantId: 'tenant-1',
        action: 'discount_50.*',
        includeTotal: false,
      }),
    ).resolves.toMatchObject({
      entries: [{ action: 'discount_50.applied' }],
    });

    await expect(
      service.query({
        tenantId: 'tenant-1',
        action: '100%.applied',
        includeTotal: false,
      }),
    ).resolves.toMatchObject({
      entries: [{ action: '100%.applied' }],
    });

    await expect(
      service.query({
        tenantId: 'tenant-1',
        action: 'a*b%c_d',
        includeTotal: false,
      }),
    ).resolves.toMatchObject({
      entries: [{ action: 'aXXb%c_d' }],
    });
  });

  it('scopes getById to the requested tenant unless allTenants is explicit', async () => {
    await seedAuditRows([
      {
        id: uuid(1),
        tenantId: 'tenant-1',
        action: 'tenant.one',
        createdAt: '2026-06-12T12:00:00.000000Z',
      },
      {
        id: uuid(2),
        tenantId: 'tenant-2',
        action: 'tenant.two',
        createdAt: '2026-06-12T12:00:01.000000Z',
      },
    ]);
    const service = serviceFor();

    await expect(
      service.getById(uuid(1), { tenantId: 'tenant-1' }),
    ).resolves.toMatchObject({ id: uuid(1), tenantId: 'tenant-1' });
    await expect(
      service.getById(uuid(1), { tenantId: 'tenant-2' }),
    ).resolves.toBeNull();
    await expect(service.getById(uuid(1), { allTenants: true })).resolves.toMatchObject({
      id: uuid(1),
      tenantId: 'tenant-1',
    });
  });

  it('filters actorType, source, and result across manual and automatic audit rows', async () => {
    const service = serviceFor();
    const auditedPrisma = prisma.$extends(
      createAuditExtension({
        tableName: TABLE,
        trackedModels: ['User'],
        logger,
        prismaModule,
      }),
    );

    await AuditContext.run(
      { actor: { id: 'api-key-1', type: 'api_key' }, noAudit: false },
      async () => {
        await auditedPrisma.user.create({
          data: {
            name: 'Auto User',
            email: 'auto-query-v2@test.local',
            password: 'secret',
          },
        });
      },
    );

    await AuditContext.run(
      { actor: { id: 'user-1', type: 'user' }, noAudit: false },
      async () => {
        await service.log({
          action: 'manual.success',
          targetType: 'Manual',
          result: 'success',
        });
        await service.log({
          action: 'manual.failure',
          targetType: 'Manual',
          result: 'failure',
        });
      },
    );

    await expect(
      service.query({ actorType: 'api_key', allTenants: true, includeTotal: false }),
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ source: 'auto', actorType: 'api_key' })],
    });
    await expect(
      service.query({ source: 'manual', allTenants: true, includeTotal: false }),
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ action: 'manual.failure' }),
        expect.objectContaining({ action: 'manual.success' }),
      ],
    });
    await expect(
      service.query({ result: 'failure', allTenants: true, includeTotal: false }),
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ action: 'manual.failure' })],
    });
    await expect(
      service.query({ source: 'auto', allTenants: true, includeTotal: false }),
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ action: 'User.created' })],
    });
  });

  it('runs cursor pagination on a partitioned table and prunes partitions after the cursor', async () => {
    await resetAuditTable(PARTITIONED_TABLE, true);
    const now = new Date();
    const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12, 12));
    const nextMonth = addMonths(currentMonth, 1);
    const currentPartition = monthPartitionName(PARTITIONED_TABLE, currentMonth);
    const nextPartition = monthPartitionName(PARTITIONED_TABLE, nextMonth);
    const partitionRows = Array.from({ length: 150 }, (_unused, index) => ({
      id: uuid(2000 + index),
      tenantId: 'tenant-1',
      action: `partition.cursor.${index}`,
      createdAt: new Date(
        currentMonth.getTime() - index * 1000,
      ).toISOString().replace('.000Z', '.000000Z'),
    }));
    await seedAuditRows(
      [
        {
          id: uuid(1999),
          tenantId: 'tenant-1',
          action: 'partition.future',
          createdAt: new Date(Date.UTC(
            nextMonth.getUTCFullYear(),
            nextMonth.getUTCMonth(),
            12,
            12,
          )).toISOString().replace('.000Z', '.000000Z'),
        },
        ...partitionRows,
      ],
      PARTITIONED_TABLE,
    );
    const service = serviceFor(PARTITIONED_TABLE);

    const seen = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = await service.query({
        tenantId: 'tenant-1',
        action: 'partition.cursor.*',
        limit: 50,
        cursor,
        includeTotal: false,
      });
      for (const entry of page.entries) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen.size).toBe(150);

    const explainRows = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>`
      EXPLAIN (FORMAT JSON)
      SELECT id
      FROM ${Prisma.raw(PARTITIONED_TABLE)}
      WHERE tenant_id = 'tenant-1'
        AND created_at <= ${currentMonth.toISOString()}::timestamptz
      ORDER BY created_at DESC, id DESC
      LIMIT 51
    `;
    const plan = JSON.stringify(explainRows);
    expect(plan).toContain(currentPartition);
    expect(plan).not.toContain(nextPartition);
  });

  it('prunes schema-qualified partitioned audit tables', async () => {
    const schemaName = 'audit_schema_e2e';
    const tableName = `${schemaName}.audit_logs`;

    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await dropAuditTable(tableName);

    try {
      await applyAuditTableSchema(prisma, {
        tableName,
        partitioned: true,
      });

      const result = await serviceFor(tableName).prune({
        olderThan: new Date('2030-01-01T00:00:00.000Z'),
      });

      expect(result.layout).toBe('partitioned');
      expect(result.mode).toBe('drop');
      expect(result.prunedPartitions.every((partition) =>
        partition.startsWith(`${schemaName}.`),
      )).toBe(true);
      expect(result.prunedPartitions.length).toBeGreaterThan(0);
    } finally {
      await dropAuditTable(tableName);
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
  });
});
