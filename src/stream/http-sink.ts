import { AuditEntry } from '../interfaces/audit-entry.interface';
import {
  AuditStreamBatchContext,
  AuditStreamDeliveryError,
  AuditStreamSink,
} from './audit-stream';

export type AuditHttpStreamFormat = 'json' | 'ndjson';

export interface HttpAuditStreamSinkOptions {
  url: string;
  format?: AuditHttpStreamFormat;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  serialize?: (
    entries: readonly AuditEntry[],
    context: AuditStreamBatchContext,
  ) => { body: string; contentType: string };
}

export class HttpAuditStreamSink implements AuditStreamSink {
  constructor(private readonly options: HttpAuditStreamSinkOptions) {
    if (!options.url || typeof options.url !== 'string') {
      throw new TypeError('[@nestarc/audit-log] HTTP sink URL is required.');
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)
    ) {
      throw new TypeError('[@nestarc/audit-log] HTTP sink timeoutMs must be a positive integer.');
    }
  }

  async deliver(
    entries: readonly AuditEntry[],
    context: AuditStreamBatchContext,
  ): Promise<void> {
    const serialized = this.options.serialize
      ? this.options.serialize(entries, context)
      : serializeGeneric(entries, context, this.options.format ?? 'json');
    const controller = new AbortController();
    const timer = this.options.timeoutMs
      ? setTimeout(() => controller.abort(), this.options.timeoutMs)
      : undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url, {
        method: 'POST',
        headers: {
          ...this.options.headers,
          'content-type': serialized.contentType,
          'idempotency-key': context.batchId,
        },
        body: serialized.body,
        signal: controller.signal,
      });
      if (response.ok) return;
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const terminal = response.status >= 400 && response.status < 500 &&
        ![408, 425, 429].includes(response.status);
      const responseText = (await response.text()).slice(0, 1024);
      throw new AuditStreamDeliveryError(
        `[@nestarc/audit-log] HTTP sink returned ${response.status}${
          responseText ? `: ${responseText}` : ''
        }`,
        { terminal, status: response.status, retryAfterMs },
      );
    } catch (error) {
      if (error instanceof AuditStreamDeliveryError) throw error;
      throw new AuditStreamDeliveryError(
        `[@nestarc/audit-log] HTTP sink request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { terminal: false, cause: error },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function serializeGeneric(
  entries: readonly AuditEntry[],
  context: AuditStreamBatchContext,
  format: AuditHttpStreamFormat,
): { body: string; contentType: string } {
  const serializedEntries = entries.map(toWireEntry);
  if (format === 'ndjson') {
    return {
      body: serializedEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      contentType: 'application/x-ndjson',
    };
  }
  return {
    body: JSON.stringify({
      schemaVersion: 'v1',
      streamId: context.streamId,
      batchId: context.batchId,
      entries: serializedEntries,
    }),
    contentType: 'application/json',
  };
}

export function toWireEntry(entry: AuditEntry): Record<string, unknown> {
  return { ...entry, createdAt: entry.createdAt.toISOString() };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}
