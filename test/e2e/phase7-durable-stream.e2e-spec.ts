import {
  applyAuditStreamStoreSchema,
  AuditStreamDeliveryError,
  AuditStreamRunner,
  PostgresAuditStreamStore,
} from '../../src';
import type { AuditEntry, AuditStreamCheckpointStore, AuditStreamSink } from '../../src';
import { AuditService } from '../../src/services/audit.service';
import { applyAuditTableSchema } from '../../src/sql';
import {
  createTestPrismaClient,
  Prisma,
  PrismaClient,
  prismaModule,
} from './prisma-client';

const AUDIT_TABLE = 'audit_logs_phase7_stream';
const CHECKPOINT_TABLE = 'audit_phase7_stream_checkpoints';
const DLQ_TABLE = 'audit_phase7_stream_dlq';

function uuid(n: number): string {
  return `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

describe('Phase 7 durable audit stream E2E', () => {
  let prisma: PrismaClient;
  let service: AuditService;
  let store: PostgresAuditStreamStore;

  beforeAll(() => {
    prisma = createTestPrismaClient();
    service = new AuditService({
      prisma,
      actorExtractor: () => ({ id: null, type: 'system' }),
      tableName: AUDIT_TABLE,
      prismaModule,
    });
    store = new PostgresAuditStreamStore({
      prisma,
      prismaModule,
      checkpointTable: CHECKPOINT_TABLE,
      deadLetterTable: DLQ_TABLE,
    });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${AUDIT_TABLE} CASCADE`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${CHECKPOINT_TABLE} CASCADE`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${DLQ_TABLE} CASCADE`);
    await applyAuditTableSchema(prisma, { tableName: AUDIT_TABLE });
    await applyAuditStreamStoreSchema(prisma, {
      checkpointTable: CHECKPOINT_TABLE,
      deadLetterTable: DLQ_TABLE,
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${AUDIT_TABLE} CASCADE`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${CHECKPOINT_TABLE} CASCADE`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${DLQ_TABLE} CASCADE`);
    await prisma.$disconnect();
  });

  async function seed(count = 3): Promise<void> {
    for (let index = 1; index <= count; index += 1) {
      await prisma.$executeRaw`
        INSERT INTO ${Prisma.raw(AUDIT_TABLE)}
          (id, tenant_id, actor_type, action, source, result, created_at)
        VALUES (
          ${uuid(index)}::uuid, 'tenant-1', 'system', ${`stream.${index}`},
          'manual', 'success', ${`2026-08-21T14:00:0${index}.00000${index}Z`}::timestamptz
        )
      `;
    }
    await prisma.$executeRaw`
      INSERT INTO ${Prisma.raw(AUDIT_TABLE)}
        (id, tenant_id, actor_type, action, source, result, created_at)
      VALUES (
        ${uuid(99)}::uuid, 'tenant-2', 'system', 'must.not.leak',
        'manual', 'success', '2026-08-21T14:00:09.000000Z'::timestamptz
      )
    `;
  }

  it('persists ACKed tenant-scoped progress and is idle on the next run', async () => {
    await seed();
    const delivered: string[] = [];
    const sink: AuditStreamSink = {
      deliver: async (entries) => { delivered.push(...entries.map((entry) => entry.id)); },
    };
    const runner = new AuditStreamRunner(service, {
      streamId: 'tenant-1-http',
      scan: { tenantId: 'tenant-1', batchSize: 2 },
      sink,
      checkpointStore: store,
    });
    await expect(runner.runOnce()).resolves.toMatchObject({
      status: 'delivered', deliveredEntries: 3, batches: 2,
    });
    expect(delivered).toEqual([uuid(1), uuid(2), uuid(3)]);
    await expect(store.load('tenant-1-http')).resolves.toMatchObject({
      checkpoint: expect.any(String), highWatermark: null,
    });
    await expect(runner.runOnce()).resolves.toMatchObject({ status: 'idle' });
    expect(delivered).toHaveLength(3);
  });

  it('redelivers the same entry IDs when checkpoint persistence fails after ACK', async () => {
    await seed(1);
    let failSave = true;
    const checkpointStore: AuditStreamCheckpointStore = {
      load: (streamId) => store.load(streamId),
      save: async (streamId, state) => {
        if (failSave && state.checkpoint !== null) {
          failSave = false;
          throw new Error('checkpoint unavailable');
        }
        await store.save(streamId, state);
      },
    };
    const batches: string[][] = [];
    const sink: AuditStreamSink = {
      deliver: async (entries: readonly AuditEntry[]) => {
        batches.push(entries.map((entry) => entry.id));
      },
    };
    const runner = new AuditStreamRunner(service, {
      streamId: 'at-least-once', scan: { tenantId: 'tenant-1' }, sink,
      checkpointStore,
    });
    await expect(runner.runOnce()).rejects.toThrow('checkpoint unavailable');
    await expect(runner.runOnce()).resolves.toMatchObject({ deliveredEntries: 1 });
    expect(batches).toEqual([[uuid(1)], [uuid(1)]]);
  });

  it('durably records terminal batches in the DLQ before advancing', async () => {
    await seed(1);
    const sink: AuditStreamSink = {
      deliver: async () => {
        throw new AuditStreamDeliveryError('invalid payload', {
          terminal: true, status: 422,
        });
      },
    };
    const runner = new AuditStreamRunner(service, {
      streamId: 'terminal-stream', scan: { tenantId: 'tenant-1' }, sink,
      checkpointStore: store, deadLetterStore: store,
    });
    await expect(runner.runOnce()).resolves.toMatchObject({
      deadLetteredEntries: 1, batches: 1,
    });
    const rows = await prisma.$queryRawUnsafe<Array<{
      streamId: string; entries: AuditEntry[]; status: string;
    }>>(
      `SELECT stream_id AS "streamId", entries, error->>'status' AS status FROM ${DLQ_TABLE}`,
    );
    expect(rows).toEqual([expect.objectContaining({
      streamId: 'terminal-stream', status: '422',
      entries: [expect.objectContaining({ id: uuid(1) })],
    })]);
    await expect(store.load('terminal-stream')).resolves.toMatchObject({
      checkpoint: expect.any(String), highWatermark: null,
    });
  });
});
