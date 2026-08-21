import {
  getAuditStreamStoreStatements,
  PostgresAuditStreamStore,
} from '../src';

describe('PostgresAuditStreamStore', () => {
  const Prisma = {
    defineExtension: (value: unknown) => value,
    raw: (value: string) => ({ raw: value }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  };

  it('loads, upserts, and idempotently inserts dead letters', async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => [{ checkpoint: 'cp', highWatermark: 'wm' }]),
      $executeRaw: jest.fn(async () => 1),
    };
    const store = new PostgresAuditStreamStore({
      prisma, prismaModule: { Prisma } as any,
    });
    await expect(store.load('stream-a')).resolves.toEqual({ checkpoint: 'cp', highWatermark: 'wm' });
    await store.save('stream-a', { checkpoint: 'cp2', highWatermark: null });
    await store.write({
      streamId: 'stream-a', batchId: 'batch', checkpoint: 'cp2', highWatermark: 'wm2',
      entries: [], error: Object.assign(new Error('bad'), {
        name: 'AuditStreamDeliveryError', terminal: true, status: 400,
      }) as any,
    });
    const sql = (prisma.$executeRaw as jest.Mock).mock.calls.map((call: any[]) =>
      Array.from(call[0].strings as readonly string[]).join(''),
    ).join('\n');
    expect(sql).toContain('ON CONFLICT (stream_id) DO UPDATE');
    expect(sql).toContain('ON CONFLICT (stream_id, batch_id) DO NOTHING');
  });

  it('generates durable checkpoint and DLQ DDL with validated names', () => {
    const statements = getAuditStreamStoreStatements({
      checkpointTable: 'audit.stream_checkpoints', deadLetterTable: 'audit.stream_dlq',
    });
    expect(statements.join('\n')).toContain('stream_id text PRIMARY KEY');
    expect(statements.join('\n')).toContain('UNIQUE (stream_id, batch_id)');
    expect(() => getAuditStreamStoreStatements({ checkpointTable: 'bad;drop' })).toThrow();
  });
});
