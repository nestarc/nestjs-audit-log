import {
  AuditStreamCheckpointStore,
  AuditStreamDeliveryError,
  AuditStreamRunner,
  AuditStreamSink,
} from '../src';
import type { AuditEntry, AuditScanPage, AuditStreamMetric, AuditStreamState } from '../src';

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

  it('does not let failing observability hooks interrupt a successful retry', async () => {
    const state = memoryStore();
    const sink = {
      deliver: jest.fn()
        .mockRejectedValueOnce(new AuditStreamDeliveryError('busy', { terminal: false }))
        .mockResolvedValueOnce(undefined),
    };
    const observedMetrics: string[] = [];
    const onMetric = jest.fn((metric: AuditStreamMetric) => {
      observedMetrics.push(metric.name);
      throw new Error('metric hook failed');
    });
    const onError = jest.fn(() => {
      throw new Error('error hook failed');
    });

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { tenantId: 'tenant-1' }, sink,
        checkpointStore: state.store, sleep: async () => undefined,
        onMetric, onError,
      },
    ).runOnce()).resolves.toMatchObject({
      status: 'delivered', deliveredEntries: 1, checkpoint: 'wm',
    });
    expect(sink.deliver).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(observedMetrics).toEqual(['batch_retried', 'batch_delivered']);
    expect(state.getState()).toEqual({ checkpoint: 'wm', highWatermark: null });
  });

  it('does not expose rejected observability hook promises as unhandled failures', async () => {
    const state = memoryStore();
    const sink = {
      deliver: jest.fn()
        .mockRejectedValueOnce(new AuditStreamDeliveryError('busy', { terminal: false }))
        .mockResolvedValueOnce(undefined),
    };
    const onMetric = jest.fn((async () => {
      throw new Error('async metric hook failed');
    }) as () => void);
    const onError = jest.fn((async () => {
      throw new Error('async error hook failed');
    }) as () => void);

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { tenantId: 'tenant-1' }, sink,
        checkpointStore: state.store, sleep: async () => undefined,
        onMetric, onError,
      },
    ).runOnce()).resolves.toMatchObject({
      status: 'delivered', deliveredEntries: 1, checkpoint: 'wm',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onMetric).toHaveBeenCalledTimes(2);
    expect(state.getState()).toEqual({ checkpoint: 'wm', highWatermark: null });
  });

  it('isolates retry and DLQ control flow from error hook mutation', async () => {
    const state = memoryStore();
    const transientError = new AuditStreamDeliveryError('busy', {
      terminal: false, status: 503, retryAfterMs: 1200,
    });
    const terminalError = new AuditStreamDeliveryError('bad request', {
      terminal: true, status: 400,
    });
    const sink = {
      deliver: jest.fn()
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(terminalError),
    };
    const sleeps: number[] = [];
    const deadLetterStore = { write: jest.fn(async () => undefined) };

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store, deadLetterStore,
        sleep: async (delay) => { sleeps.push(delay); },
        onError: (error) => {
          const observed = error as { terminal: boolean; retryAfterMs?: number };
          observed.terminal = !observed.terminal;
          observed.retryAfterMs = 1;
        },
      },
    ).runOnce()).resolves.toMatchObject({
      deliveredEntries: 0, deadLetteredEntries: 1, checkpoint: 'wm',
    });
    expect(sink.deliver).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1200]);
    expect(deadLetterStore.write).toHaveBeenCalledWith(expect.objectContaining({
      error: terminalError,
    }));
    expect(transientError).toMatchObject({ terminal: false, retryAfterMs: 1200 });
    expect(terminalError).toMatchObject({ terminal: true, retryAfterMs: undefined });
  });

  it('normalizes unknown failures and stops after the configured retry budget', async () => {
    const state = memoryStore();
    const transportError = new Error('transport unavailable');
    const sink = {
      deliver: jest.fn()
        .mockRejectedValueOnce('socket closed')
        .mockRejectedValueOnce(transportError),
    };
    const sleep = jest.fn(async () => undefined);
    const metrics: string[] = [];

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store, maxRetries: 1, sleep,
        onMetric: (metric) => metrics.push(metric.name),
      },
    ).runOnce()).rejects.toMatchObject({
      message: expect.stringContaining('transport unavailable'),
      terminal: false,
      cause: transportError,
    });
    expect(sink.deliver).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250, undefined);
    expect(metrics).toEqual(['batch_retried', 'run_failed']);
    expect(state.getState()).toEqual({ checkpoint: null, highWatermark: 'wm' });
  });

  it('aborts before loading state without touching delivery or checkpoints', async () => {
    const controller = new AbortController();
    const reason = new Error('stop before run');
    controller.abort(reason);
    const state = memoryStore();
    const sink: AuditStreamSink = { deliver: jest.fn(async () => undefined) };

    await expect(new AuditStreamRunner(serviceFor([]) as any, {
      streamId: 'stream-a', scan: { allTenants: true }, sink,
      checkpointStore: state.store,
    }).runOnce({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError', cause: reason,
    });
    expect(state.store.load).not.toHaveBeenCalled();
    expect(state.store.save).not.toHaveBeenCalled();
    expect(sink.deliver).not.toHaveBeenCalled();
  });

  it('aborts before entering backoff without advancing the ACK checkpoint', async () => {
    const controller = new AbortController();
    const state = memoryStore();
    const sink = {
      deliver: jest.fn(async () => {
        throw new AuditStreamDeliveryError('busy', { terminal: false });
      }),
    };

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store,
        onMetric: (metric) => {
          if (metric.name === 'batch_retried') controller.abort('before backoff');
        },
      },
    ).runOnce({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(state.store.save).toHaveBeenCalledTimes(1);
    expect(state.getState()).toEqual({ checkpoint: null, highWatermark: 'wm' });
  });

  it('aborts during the default backoff without retrying or advancing the checkpoint', async () => {
    const controller = new AbortController();
    const state = memoryStore();
    const sink = {
      deliver: jest.fn(async () => {
        throw new AuditStreamDeliveryError('busy', { terminal: false });
      }),
    };

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store, initialBackoffMs: 10_000,
        onMetric: (metric) => {
          if (metric.name === 'batch_retried') {
            queueMicrotask(() => controller.abort('during backoff'));
          }
        },
      },
    ).runOnce({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(state.store.save).toHaveBeenCalledTimes(1);
    expect(state.getState()).toEqual({ checkpoint: null, highWatermark: 'wm' });
  });

  it('removes the abort listener after a successful default backoff', async () => {
    const controller = new AbortController();
    const state = memoryStore();
    const sink = {
      deliver: jest.fn()
        .mockRejectedValueOnce(new AuditStreamDeliveryError('busy', { terminal: false }))
        .mockResolvedValueOnce(undefined),
    };
    const addListener = jest.spyOn(controller.signal, 'addEventListener');
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store, initialBackoffMs: 1,
      },
    ).runOnce({ signal: controller.signal })).resolves.toMatchObject({
      status: 'delivered', checkpoint: 'wm',
    });
    const abortListener = addListener.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(abortListener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith('abort', abortListener);
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

  it('surfaces a DLQ write failure without advancing the checkpoint', async () => {
    const state = memoryStore();
    const dlqError = new Error('DLQ unavailable');
    const deadLetterStore = { write: jest.fn(async () => { throw dlqError; }) };
    const sink = {
      deliver: jest.fn(async () => {
        throw new AuditStreamDeliveryError('bad request', { terminal: true, status: 400 });
      }),
    };

    await expect(new AuditStreamRunner(
      serviceFor([{ entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' }]) as any,
      {
        streamId: 'stream-a', scan: { allTenants: true }, sink,
        checkpointStore: state.store, deadLetterStore,
      },
    ).runOnce()).rejects.toBe(dlqError);
    expect(deadLetterStore.write).toHaveBeenCalledTimes(1);
    expect(state.store.save).toHaveBeenCalledTimes(1);
    expect(state.getState()).toEqual({ checkpoint: null, highWatermark: 'wm' });
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

  it('redelivers the same batch ID when checkpoint persistence fails after ACK', async () => {
    let persisted: AuditStreamState = { checkpoint: null, highWatermark: null };
    let rejectNextCheckpoint = true;
    const checkpointStore: AuditStreamCheckpointStore = {
      load: jest.fn(async () => persisted),
      save: jest.fn(async (_streamId, next) => {
        if (next.checkpoint !== null && rejectNextCheckpoint) {
          rejectNextCheckpoint = false;
          throw new Error('checkpoint unavailable');
        }
        persisted = next;
      }),
    };
    const seenOptions: unknown[] = [];
    const page = { entries: [entry(0)], checkpoint: 'wm', highWatermark: 'wm' };
    const contexts: unknown[] = [];
    const sink: AuditStreamSink = {
      deliver: jest.fn(async (_entries, context) => { contexts.push(context); }),
    };
    const runner = new AuditStreamRunner(serviceFor([page], seenOptions) as any, {
      streamId: 'stream-a', scan: { allTenants: true }, sink, checkpointStore,
    });

    await expect(runner.runOnce()).rejects.toThrow('checkpoint unavailable');
    await expect(runner.runOnce()).resolves.toMatchObject({
      deliveredEntries: 1, checkpoint: 'wm',
    });
    expect(contexts).toEqual([
      expect.objectContaining({ batchId: `${ids[0]}:${ids[0]}`, attempt: 1 }),
      expect.objectContaining({ batchId: `${ids[0]}:${ids[0]}`, attempt: 1 }),
    ]);
    expect(seenOptions[1]).toMatchObject({ until: 'wm' });
    expect(persisted).toEqual({ checkpoint: 'wm', highWatermark: null });
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
