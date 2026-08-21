import {
  AuditStreamCheckpointStore,
  AuditStreamDeliveryError,
  AuditStreamRunner,
  AuditStreamSink,
} from '../src';
import type { AuditEntry, AuditScanPage } from '../src';
import type { AuditStreamState } from '../src';

const ids = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
];

function entry(index: number): AuditEntry {
  return {
    id: ids[index],
    tenantId: 'tenant-1',
    actorId: null,
    actorType: 'system',
    actorIp: null,
    action: 'User.created',
    targetType: 'User',
    targetId: `u${index}`,
    source: 'auto',
    changes: null,
    metadata: { secret: 'value' },
    result: 'success',
    createdAt: new Date(`2026-08-21T00:00:0${index}.000Z`),
  };
}

function serviceFor(pages: AuditScanPage[], seenOptions: unknown[] = []) {
  return {
    scan(options: unknown): AsyncIterable<AuditScanPage> {
      seenOptions.push(options);
      return (async function* () {
        for (const page of pages) yield page;
      })();
    },
  };
}

function memoryStore(initial: AuditStreamState = { checkpoint: null, highWatermark: null }) {
  let state: AuditStreamState = initial;
  const store: AuditStreamCheckpointStore = {
    load: jest.fn(async () => state),
    save: jest.fn(async (_streamId, next) => {
      state = next;
    }),
  };
  return { store, getState: () => state };
}

describe('AuditStreamRunner', () => {
  it('delivers pages sequentially and saves checkpoint only after each ACK', async () => {
    const watermark = 'wm-2';
    const pages = [
      { entries: [entry(0)], checkpoint: 'cp-1', highWatermark: watermark },
      { entries: [entry(1)], checkpoint: watermark, highWatermark: watermark },
    ];
    const order: string[] = [];
    const state = memoryStore();
    (state.store.save as jest.Mock).mockImplementation(async (_id, next) => {
      order.push(`save:${next.checkpoint}`);
    });
    const sink: AuditStreamSink = {
      deliver: jest.fn(async (entries) => {
        order.push(`ack:${entries[0].id}`);
      }),
    };

    const result = await new AuditStreamRunner(serviceFor(pages) as any, {
      streamId: 'siem-primary',
      scan: { tenantId: 'tenant-1', batchSize: 1 },
      sink,
      checkpointStore: state.store,
    }).runOnce();

    expect(order).toEqual([
      'save:null', `ack:${ids[0]}`, 'save:cp-1', `ack:${ids[1]}`, `save:${watermark}`,
    ]);
    expect(result).toMatchObject({
      status: 'delivered', deliveredEntries: 2, deadLetteredEntries: 0, batches: 2,
    });
    expect((state.store.save as jest.Mock).mock.calls[0][1]).toEqual({
      checkpoint: null, highWatermark: watermark,
    });
    expect((state.store.save as jest.Mock).mock.calls[1][1]).toEqual({
      checkpoint: 'cp-1', highWatermark: watermark,
    });
    expect((state.store.save as jest.Mock).mock.calls[2][1]).toEqual({
      checkpoint: watermark, highWatermark: null,
    });
  });

  it('resumes the saved bounded run and keeps entry IDs as batch idempotency keys', async () => {
    const seen: any[] = [];
    const state = memoryStore({ checkpoint: 'cp-1', highWatermark: 'wm-3' });
    const sink: AuditStreamSink = { deliver: jest.fn(async () => undefined) };
    await new AuditStreamRunner(
      serviceFor([{ entries: [entry(1)], checkpoint: 'wm-3', highWatermark: 'wm-3' }], seen) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store,
      },
    ).runOnce();
    expect(seen[0]).toMatchObject({ after: 'cp-1', until: 'wm-3' });
    expect((sink.deliver as jest.Mock).mock.calls[0][1].batchId).toBe(`${ids[1]}:${ids[1]}`);
  });

  it('honors Retry-After before an exponential retry and emits hooks', async () => {
    const state = memoryStore();
    const sleeps: number[] = [];
    const metrics: unknown[] = [];
    const errors: unknown[] = [];
    const sink = {
      deliver: jest.fn()
        .mockRejectedValueOnce(new AuditStreamDeliveryError('busy', {
          terminal: false, status: 429, retryAfterMs: 1200,
        }))
        .mockResolvedValueOnce(undefined),
    };
    await new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { tenantId: 'tenant-1' }, sink,
        checkpointStore: state.store,
        sleep: async (delay) => { sleeps.push(delay); },
        onMetric: (metric) => metrics.push(metric),
        onError: (error) => errors.push(error),
      },
    ).runOnce();
    expect(sleeps).toEqual([1200]);
    expect(sink.deliver).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'batch_retried', delayMs: 1200 }),
      expect.objectContaining({ name: 'batch_delivered', attempt: 2 }),
    ]));
  });

  it('writes terminal 4xx to the DLQ before advancing the checkpoint', async () => {
    const order: string[] = [];
    const state = memoryStore();
    (state.store.save as jest.Mock).mockImplementation(async (_id, next) => {
      order.push(next.checkpoint ? 'save' : 'watermark');
    });
    const deadLetterStore = {
      write: jest.fn(async () => { order.push('dlq'); }),
    };
    const sink = {
      deliver: jest.fn(async () => {
        throw new AuditStreamDeliveryError('bad request', { terminal: true, status: 400 });
      }),
    };
    const result = await new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store, deadLetterStore,
      },
    ).runOnce();
    expect(order).toEqual(['watermark', 'dlq', 'save']);
    expect(result.deadLetteredEntries).toBe(1);
    expect(deadLetterStore.write).toHaveBeenCalledWith(expect.objectContaining({
      batchId: `${ids[0]}:${ids[0]}`, entries: [expect.objectContaining({ id: ids[0] })],
    }));
  });

  it('does not advance a terminal failure when no DLQ is configured', async () => {
    const state = memoryStore();
    const sink = {
      deliver: async () => { throw new AuditStreamDeliveryError('unauthorized', {
        terminal: true, status: 401,
      }); },
    };
    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      { streamId: 'stream-a', scan: { allTenants: true }, sink, checkpointStore: state.store },
    ).runOnce()).rejects.toMatchObject({ terminal: true, status: 401 });
    expect(state.store.save).toHaveBeenCalledTimes(1);
    expect((state.store.save as jest.Mock).mock.calls[0][1]).toEqual({
      checkpoint: null, highWatermark: 'wm',
    });
  });

  it('redacts a cloned payload and refuses to alter the idempotency ID', async () => {
    const original = entry(0);
    const state = memoryStore();
    const sink: AuditStreamSink = { deliver: jest.fn(async () => undefined) };
    await new AuditStreamRunner(
      serviceFor([{ entries: [original], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { tenantId: 'tenant-1' }, sink,
        checkpointStore: state.store,
        redact: (value) => ({ ...value, metadata: { secret: '[REDACTED]' } }),
      },
    ).runOnce();
    expect((sink.deliver as jest.Mock).mock.calls[0][0][0].metadata).toEqual({ secret: '[REDACTED]' });
    expect(original.metadata).toEqual({ secret: 'value' });

    const invalid = new AuditStreamRunner(
      serviceFor([{ entries: [original], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-b', scan: { tenantId: 'tenant-1' }, sink,
        checkpointStore: memoryStore().store,
        redact: (value) => ({ ...value, id: ids[1] }),
      },
    );
    await expect(invalid.runOnce()).rejects.toThrow('must preserve the audit entry ID');
  });
});
