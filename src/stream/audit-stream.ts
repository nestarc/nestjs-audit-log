import { AuditEntry, AuditScanOptions } from '../interfaces/audit-entry.interface';
import { AuditService } from '../services/audit.service';

export interface AuditStreamState {
  checkpoint: string | null;
  highWatermark: string | null;
}

export interface AuditStreamCheckpointStore {
  load(streamId: string): Promise<AuditStreamState | null>;
  save(streamId: string, state: AuditStreamState): Promise<void>;
}

export interface AuditStreamBatchContext {
  streamId: string;
  batchId: string;
  checkpoint: string;
  highWatermark: string;
  attempt: number;
}

export interface AuditStreamSink {
  deliver(
    entries: readonly AuditEntry[],
    context: AuditStreamBatchContext,
  ): Promise<void>;
}

export interface AuditStreamDeadLetter {
  streamId: string;
  batchId: string;
  checkpoint: string;
  highWatermark: string;
  entries: readonly AuditEntry[];
  error: AuditStreamDeliveryError;
}

export interface AuditStreamDeadLetterStore {
  write(deadLetter: AuditStreamDeadLetter): Promise<void>;
}

export type AuditStreamMetric =
  | { name: 'batch_delivered'; streamId: string; entries: number; attempt: number }
  | { name: 'batch_retried'; streamId: string; entries: number; attempt: number; delayMs: number }
  | { name: 'batch_dead_lettered'; streamId: string; entries: number }
  | { name: 'run_failed'; streamId: string };

export interface AuditStreamErrorContext {
  phase: 'delivery';
  streamId: string;
  batchId: string;
  attempt: number;
  terminal: boolean;
}

export interface AuditStreamRunnerOptions {
  streamId: string;
  scan: Omit<AuditScanOptions, 'after' | 'until' | 'signal'>;
  sink: AuditStreamSink;
  checkpointStore: AuditStreamCheckpointStore;
  deadLetterStore?: AuditStreamDeadLetterStore;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  redact?: (entry: Readonly<AuditEntry>) => AuditEntry;
  onMetric?: (metric: AuditStreamMetric) => void;
  onError?: (error: unknown, context: AuditStreamErrorContext) => void;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface AuditStreamRunResult {
  status: 'idle' | 'delivered';
  deliveredEntries: number;
  deadLetteredEntries: number;
  batches: number;
  checkpoint: string | null;
}

export class AuditStreamDeliveryError extends Error {
  readonly terminal: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      terminal: boolean;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'AuditStreamDeliveryError';
    this.terminal = options.terminal;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class AuditStreamRunner {
  constructor(
    private readonly auditService: Pick<AuditService, 'scan'>,
    private readonly options: AuditStreamRunnerOptions,
  ) {
    this.validateOptions();
  }

  async runOnce(input: { signal?: AbortSignal } = {}): Promise<AuditStreamRunResult> {
    this.throwIfAborted(input.signal);
    let state = (await this.options.checkpointStore.load(this.options.streamId)) ?? {
      checkpoint: null,
      highWatermark: null,
    };

    if (state.checkpoint && state.checkpoint === state.highWatermark) {
      state = { checkpoint: state.checkpoint, highWatermark: null };
      await this.options.checkpointStore.save(this.options.streamId, state);
    }

    const scanOptions: AuditScanOptions = {
      ...this.options.scan,
      ...(state.checkpoint ? { after: state.checkpoint } : {}),
      ...(state.highWatermark ? { until: state.highWatermark } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    } as AuditScanOptions;
    let deliveredEntries = 0;
    let deadLetteredEntries = 0;
    let batches = 0;

    for await (const page of this.auditService.scan(scanOptions)) {
      this.throwIfAborted(input.signal);
      if (page.entries.length === 0 || !page.checkpoint) continue;
      if (state.highWatermark === null) {
        // Persist the bounded run before its first delivery. This does not
        // advance the ACK checkpoint, but it keeps retry batch boundaries
        // stable if the process stops after the sink ACK and before save().
        state = {
          checkpoint: state.checkpoint,
          highWatermark: page.highWatermark,
        };
        await this.options.checkpointStore.save(this.options.streamId, state);
      }
      const entries = page.entries.map((entry) => this.redactEntry(entry));
      const batchId = this.batchId(entries);
      const contextBase = {
        streamId: this.options.streamId,
        batchId,
        checkpoint: page.checkpoint,
        highWatermark: page.highWatermark,
      };
      const outcome = await this.deliver(entries, contextBase, input.signal);

      if (outcome === 'dead-lettered') {
        deadLetteredEntries += entries.length;
      } else {
        deliveredEntries += entries.length;
      }
      batches += 1;
      state = {
        checkpoint: page.checkpoint,
        highWatermark:
          page.checkpoint === page.highWatermark ? null : page.highWatermark,
      };
      // This write deliberately follows the sink/DLQ ACK. If it fails, the
      // batch is delivered again and the entry IDs remain the idempotency key.
      await this.options.checkpointStore.save(this.options.streamId, state);
    }

    return {
      status: batches === 0 ? 'idle' : 'delivered',
      deliveredEntries,
      deadLetteredEntries,
      batches,
      checkpoint: state.checkpoint,
    };
  }

  private async deliver(
    entries: readonly AuditEntry[],
    context: Omit<AuditStreamBatchContext, 'attempt'>,
    signal?: AbortSignal,
  ): Promise<'delivered' | 'dead-lettered'> {
    const maxRetries = this.options.maxRetries ?? 3;
    for (let attempt = 1; ; attempt += 1) {
      this.throwIfAborted(signal);
      try {
        await this.options.sink.deliver(entries, { ...context, attempt });
        this.emitMetric({
          name: 'batch_delivered',
          streamId: context.streamId,
          entries: entries.length,
          attempt,
        });
        return 'delivered';
      } catch (caught) {
        const error = this.normalizeDeliveryError(caught);
        this.emitError(error, {
          phase: 'delivery',
          streamId: context.streamId,
          batchId: context.batchId,
          attempt,
          terminal: error.terminal,
        });
        if (error.terminal) {
          if (!this.options.deadLetterStore) {
            this.emitMetric({ name: 'run_failed', streamId: context.streamId });
            throw error;
          }
          await this.options.deadLetterStore.write({
            ...context,
            entries,
            error,
          });
          this.emitMetric({
            name: 'batch_dead_lettered',
            streamId: context.streamId,
            entries: entries.length,
          });
          return 'dead-lettered';
        }
        if (attempt > maxRetries) {
          this.emitMetric({ name: 'run_failed', streamId: context.streamId });
          throw error;
        }
        const delayMs = Math.min(
          this.options.maxBackoffMs ?? 30_000,
          error.retryAfterMs ?? this.backoffDelay(attempt),
        );
        this.emitMetric({
          name: 'batch_retried',
          streamId: context.streamId,
          entries: entries.length,
          attempt,
          delayMs,
        });
        await (this.options.sleep ?? sleepWithSignal)(delayMs, signal);
      }
    }
  }

  private redactEntry(entry: AuditEntry): AuditEntry {
    const cloned = cloneEntry(entry);
    const redacted = this.options.redact ? this.options.redact(cloned) : cloned;
    if (!redacted || redacted.id !== entry.id) {
      throw new Error(
        '[@nestarc/audit-log] stream redaction must preserve the audit entry ID.',
      );
    }
    return redacted;
  }

  private batchId(entries: readonly AuditEntry[]): string {
    return `${entries[0].id}:${entries[entries.length - 1].id}`;
  }

  private normalizeDeliveryError(error: unknown): AuditStreamDeliveryError {
    if (error instanceof AuditStreamDeliveryError) return error;
    return new AuditStreamDeliveryError(
      `[@nestarc/audit-log] audit stream delivery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { terminal: false, cause: error },
    );
  }

  private backoffDelay(attempt: number): number {
    const initial = this.options.initialBackoffMs ?? 250;
    const maximum = this.options.maxBackoffMs ?? 30_000;
    return Math.min(maximum, initial * 2 ** (attempt - 1));
  }

  private emitMetric(metric: AuditStreamMetric): void {
    try {
      const result: unknown = this.options.onMetric?.(metric);
      ignoreRejectedHook(result);
    } catch {
      // Synchronous hook failures must not change delivery/checkpoint semantics.
    }
  }

  private emitError(
    error: AuditStreamDeliveryError,
    context: AuditStreamErrorContext,
  ): void {
    try {
      const result: unknown = this.options.onError?.(cloneDeliveryError(error), context);
      ignoreRejectedHook(result);
    } catch {
      // Synchronous hook failures must never interrupt retries or DLQ.
    }
  }

  private validateOptions(): void {
    if (!this.options.streamId || typeof this.options.streamId !== 'string') {
      throw new TypeError('[@nestarc/audit-log] streamId must be a non-empty string.');
    }
    for (const [name, value, minimum] of [
      ['maxRetries', this.options.maxRetries, 0],
      ['initialBackoffMs', this.options.initialBackoffMs, 1],
      ['maxBackoffMs', this.options.maxBackoffMs, 1],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
        throw new TypeError(
          `[@nestarc/audit-log] ${name} must be an integer greater than or equal to ${minimum}.`,
        );
      }
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('[@nestarc/audit-log] audit stream run aborted.');
    error.name = 'AbortError';
    (error as Error & { cause?: unknown }).cause = signal.reason;
    throw error;
  }
}

function cloneEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    createdAt: new Date(entry.createdAt),
    changes: entry.changes ? structuredClone(entry.changes) : null,
    metadata: entry.metadata ? structuredClone(entry.metadata) : null,
  };
}

function cloneDeliveryError(error: AuditStreamDeliveryError): AuditStreamDeliveryError {
  return Object.create(
    Object.getPrototypeOf(error) as object,
    Object.getOwnPropertyDescriptors(error),
  ) as AuditStreamDeliveryError;
}

function ignoreRejectedHook(result: unknown): void {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(result).catch(() => undefined);
  }
}

async function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const error = new Error('[@nestarc/audit-log] audit stream run aborted.');
    error.name = 'AbortError';
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const error = new Error('[@nestarc/audit-log] audit stream run aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
