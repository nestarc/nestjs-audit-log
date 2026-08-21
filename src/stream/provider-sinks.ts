import { AuditEntry } from '../interfaces/audit-entry.interface';
import {
  AuditStreamBatchContext,
  AuditStreamDeliveryError,
  AuditStreamSink,
} from './audit-stream';
import { HttpAuditStreamSink, toWireEntry } from './http-sink';

export interface DatadogAuditStreamSinkOptions {
  url: string;
  apiKey: string;
  service?: string;
  source?: string;
  tags?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class DatadogAuditStreamSink implements AuditStreamSink {
  private readonly sink: HttpAuditStreamSink;

  constructor(options: DatadogAuditStreamSinkOptions) {
    if (!options.apiKey) {
      throw new TypeError('[@nestarc/audit-log] Datadog apiKey is required.');
    }
    this.sink = new HttpAuditStreamSink({
      url: options.url,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      headers: { 'DD-API-KEY': options.apiKey },
      serialize: (entries) => ({
        contentType: 'application/json',
        body: JSON.stringify(entries.map((entry) => ({
          ...toWireEntry(entry),
          message: `${entry.action} ${entry.targetType ?? 'unknown'}:${entry.targetId ?? 'unknown'}`,
          service: options.service ?? '@nestarc/audit-log',
          ddsource: options.source ?? 'nodejs',
          ...(options.tags ? { ddtags: options.tags } : {}),
        }))),
      }),
    });
  }

  deliver(entries: readonly AuditEntry[], context: AuditStreamBatchContext): Promise<void> {
    if (entries.length > 1000) {
      throw new AuditStreamDeliveryError(
        '[@nestarc/audit-log] Datadog accepts at most 1000 log entries per request.',
        { terminal: true },
      );
    }
    return this.sink.deliver(entries, context);
  }
}

export interface SplunkAuditStreamSinkOptions {
  url: string;
  token: string;
  index?: string;
  source?: string;
  sourcetype?: string;
  host?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class SplunkAuditStreamSink implements AuditStreamSink {
  private readonly sink: HttpAuditStreamSink;

  constructor(options: SplunkAuditStreamSinkOptions) {
    if (!options.token) {
      throw new TypeError('[@nestarc/audit-log] Splunk HEC token is required.');
    }
    this.sink = new HttpAuditStreamSink({
      url: options.url,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      headers: { authorization: `Splunk ${options.token}` },
      serialize: (entries) => ({
        contentType: 'application/json',
        body: entries.map((entry) => JSON.stringify({
          time: entry.createdAt.getTime() / 1000,
          ...(options.host ? { host: options.host } : {}),
          ...(options.index ? { index: options.index } : {}),
          source: options.source ?? '@nestarc/audit-log',
          sourcetype: options.sourcetype ?? '_json',
          event: toWireEntry(entry),
        })).join('\n'),
      }),
    });
  }

  deliver(entries: readonly AuditEntry[], context: AuditStreamBatchContext): Promise<void> {
    return this.sink.deliver(entries, context);
  }
}

export interface AuditObjectStoragePutInput {
  key: string;
  body: string;
  contentType: string;
  ifNoneMatch: '*';
  metadata: Record<string, string>;
}

export interface AuditObjectStorageClient {
  putObject(input: AuditObjectStoragePutInput): Promise<void>;
}

export interface ObjectStorageAuditStreamSinkOptions {
  client: AuditObjectStorageClient;
  prefix?: string;
  isAlreadyExists?: (error: unknown) => boolean;
}

export class ObjectStorageAuditStreamSink implements AuditStreamSink {
  constructor(private readonly options: ObjectStorageAuditStreamSinkOptions) {
    if (!options.client || typeof options.client.putObject !== 'function') {
      throw new TypeError('[@nestarc/audit-log] object storage client.putObject is required.');
    }
  }

  async deliver(entries: readonly AuditEntry[], context: AuditStreamBatchContext): Promise<void> {
    const prefix = this.options.prefix?.replace(/^\/+|\/+$/g, '') ?? 'audit-log';
    const key = `${prefix}/${encodeURIComponent(context.streamId)}/${encodeURIComponent(context.batchId)}.ndjson`;
    try {
      await this.options.client.putObject({
        key,
        body: entries.map((entry) => JSON.stringify(toWireEntry(entry))).join('\n') + '\n',
        contentType: 'application/x-ndjson',
        ifNoneMatch: '*',
        metadata: {
          streamId: context.streamId,
          batchId: context.batchId,
          checkpoint: context.checkpoint,
          highWatermark: context.highWatermark,
        },
      });
    } catch (error) {
      // A conditional-create conflict proves that this deterministic batch was
      // already ACKed before a checkpoint-store failure.
      if (this.options.isAlreadyExists?.(error)) return;
      throw error;
    }
  }
}
