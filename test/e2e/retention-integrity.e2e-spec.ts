import { AuditService } from '../../src/services/audit.service';
import { applyAuditTableSchema } from '../../src/sql';
import {
  createTestPrismaClient,
  PrismaClient,
  prismaModule,
} from './prisma-client';

const FLAT_TABLE = 'audit_logs_retention_flat';
const PARTITIONED_TABLE = 'audit_logs_retention_part';
const JAN_PARTITION = `${PARTITIONED_TABLE}_y2026m01`;
const FEB_PARTITION = `${PARTITIONED_TABLE}_y2026m02`;

describe('retention integrity E2E', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrismaClient();
  });

  afterEach(async () => {
    await dropAuditObjects(FLAT_TABLE);
    await dropAuditObjects(PARTITIONED_TABLE);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${JAN_PARTITION} CASCADE`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${FEB_PARTITION} CASCADE`);
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS ${FLAT_TABLE}_reject_prune() CASCADE`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function serviceFor(tableName: string): AuditService {
    return new AuditService({
      prisma,
      actorExtractor: () => ({ id: null, type: 'system' }),
      tableName,
      prismaModule,
    });
  }

  async function dropAuditObjects(tableName: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS ${tableName}_block_mutation() CASCADE`,
    );
  }

  async function seed(tableName: string, action: string, createdAt: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${tableName} (actor_type, action, source, result, created_at)
       VALUES ('system', $1, 'manual', 'success', $2::timestamptz)`,
      action,
      createdAt,
    );
  }

  async function createPartitionedFixture(): Promise<void> {
    await applyAuditTableSchema(prisma, {
      tableName: PARTITIONED_TABLE,
      partitioned: true,
    });
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${JAN_PARTITION} PARTITION OF ${PARTITIONED_TABLE}
       FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00')`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${FEB_PARTITION} PARTITION OF ${PARTITIONED_TABLE}
       FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00')`,
    );
    await seed(PARTITIONED_TABLE, 'january', '2026-01-15T00:00:00.000Z');
    await seed(PARTITIONED_TABLE, 'february', '2026-02-15T00:00:00.000Z');
  }

  it('rolls back a failed flat prune and restores append-only enforcement', async () => {
    await applyAuditTableSchema(prisma, { tableName: FLAT_TABLE });
    await seed(FLAT_TABLE, 'old', '2026-01-01T00:00:00.000Z');
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${FLAT_TABLE}_reject_prune() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced prune failure'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${FLAT_TABLE}_reject_prune_trg
       BEFORE DELETE ON ${FLAT_TABLE}
       FOR EACH ROW EXECUTE FUNCTION ${FLAT_TABLE}_reject_prune()`,
    );

    await expect(
      serviceFor(FLAT_TABLE).prune({
        olderThan: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow('forced prune failure');

    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM ${FLAT_TABLE}`,
    );
    expect(Number(rows[0].count)).toBe(1);

    await prisma.$executeRawUnsafe(
      `DROP TRIGGER ${FLAT_TABLE}_reject_prune_trg ON ${FLAT_TABLE}`,
    );
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM ${FLAT_TABLE}`),
    ).rejects.toThrow('blocked on append-only table');
  });

  it('reenables the delete trigger after a successful flat prune', async () => {
    await applyAuditTableSchema(prisma, { tableName: FLAT_TABLE });
    await seed(FLAT_TABLE, 'old', '2026-01-01T00:00:00.000Z');
    await seed(FLAT_TABLE, 'retained', '2026-03-01T00:00:00.000Z');

    const result = await serviceFor(FLAT_TABLE).prune({
      olderThan: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.deletedRows).toBe(1);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM ${FLAT_TABLE}`),
    ).rejects.toThrow('blocked on append-only table');
  });

  it('dry-runs without mutation and preserves the boundary partition', async () => {
    await createPartitionedFixture();

    const result = await serviceFor(PARTITIONED_TABLE).prune({
      olderThan: new Date('2026-02-15T00:00:00.000Z'),
      dryRun: true,
    });

    expect(result.prunedPartitions).toEqual([JAN_PARTITION]);
    const rows = await prisma.$queryRawUnsafe<Array<{ action: string }>>(
      `SELECT action FROM ${PARTITIONED_TABLE} ORDER BY action`,
    );
    expect(rows).toEqual([{ action: 'february' }, { action: 'january' }]);
  });

  it('detaches only fully expired partitions and leaves them as standalone tables', async () => {
    await createPartitionedFixture();

    const result = await serviceFor(PARTITIONED_TABLE).prune({
      olderThan: new Date('2026-02-15T00:00:00.000Z'),
      mode: 'detach',
    });

    expect(result.prunedPartitions).toEqual([JAN_PARTITION]);
    const relations = await prisma.$queryRawUnsafe<
      Array<{ relation: string; isPartition: boolean }>
    >(
      `SELECT relname AS relation, relispartition AS "isPartition"
       FROM pg_class
       WHERE relname IN ('${JAN_PARTITION}', '${FEB_PARTITION}')
       ORDER BY relname`,
    );
    expect(relations).toEqual([
      { relation: JAN_PARTITION, isPartition: false },
      { relation: FEB_PARTITION, isPartition: true },
    ]);
    const parentRows = await prisma.$queryRawUnsafe<Array<{ action: string }>>(
      `SELECT action FROM ${PARTITIONED_TABLE}`,
    );
    expect(parentRows).toEqual([{ action: 'february' }]);
    const detachedRows = await prisma.$queryRawUnsafe<Array<{ action: string }>>(
      `SELECT action FROM ${JAN_PARTITION}`,
    );
    expect(detachedRows).toEqual([{ action: 'january' }]);
  });
});
