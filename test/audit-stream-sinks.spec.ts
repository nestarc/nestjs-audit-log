import {
  AuditStreamDeliveryError,
  DatadogAuditStreamSink,
  HttpAuditStreamSink,
  ObjectStorageAuditStreamSink,
  SplunkAuditStreamSink,
} from '../src';
import type { AuditEntry, AuditStreamBatchContext } from '../src';

const entry: AuditEntry = {
  id: '00000000-0000-0000-0000-000000000001', tenantId: 'tenant-1',
  actorId: null, actorType: 'system', actorIp: null, action: 'User.created',
  targetType: 'User', targetId: 'u1', source: 'auto', changes: null,
  metadata: null, result: 'success', createdAt: new Date('2026-08-21T00:00:00Z'),
};
const context: AuditStreamBatchContext = {
  streamId: 'stream-a', batchId: `${entry.id}:${entry.id}`,
  checkpoint: 'cp', highWatermark: 'wm', attempt: 1,
};

describe('audit stream sinks', () => {
  it('sends generic JSON with an idempotency key', async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 202 }));
    await new HttpAuditStreamSink({ url: 'https://example.test/audit', fetch: fetchMock as any })
      .deliver([entry], context);
    const request = (fetchMock as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({
      'content-type': 'application/json', 'idempotency-key': context.batchId,
    });
    expect(JSON.parse(request.body as string)).toMatchObject({
      schemaVersion: 'v1', streamId: 'stream-a', batchId: context.batchId,
      entries: [{ id: entry.id, createdAt: '2026-08-21T00:00:00.000Z' }],
    });
  });

  it('classifies Retry-After 429 as retriable and ordinary 4xx as terminal', async () => {
    const retrying = new HttpAuditStreamSink({
      url: 'https://example.test',
      fetch: jest.fn(async () => new Response('slow', {
        status: 429, headers: { 'retry-after': '2' },
      })) as any,
    });
    await expect(retrying.deliver([entry], context)).rejects.toMatchObject({
      terminal: false, status: 429, retryAfterMs: 2000,
    });
    const terminal = new HttpAuditStreamSink({
      url: 'https://example.test',
      fetch: jest.fn(async () => new Response('invalid', { status: 422 })) as any,
    });
    await expect(terminal.deliver([entry], context)).rejects.toBeInstanceOf(
      AuditStreamDeliveryError,
    );
    await expect(terminal.deliver([entry], context)).rejects.toMatchObject({ terminal: true });
  });

  it('serializes NDJSON and provider mappings', async () => {
    const genericFetch = jest.fn(async () => new Response(null, { status: 200 }));
    await new HttpAuditStreamSink({
      url: 'https://example.test', format: 'ndjson', fetch: genericFetch as any,
    }).deliver([entry], context);
    expect(((genericFetch as jest.Mock).mock.calls[0][1] as RequestInit).body).toBe(
      `${JSON.stringify({ ...entry, createdAt: entry.createdAt.toISOString() })}\n`,
    );

    const datadogFetch = jest.fn(async () => new Response(null, { status: 200 }));
    await new DatadogAuditStreamSink({
      url: 'https://http-intake.logs.datadoghq.com/api/v2/logs',
      apiKey: 'secret', fetch: datadogFetch as any,
    }).deliver([entry], context);
    const ddRequest = (datadogFetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(ddRequest.headers).toMatchObject({ 'DD-API-KEY': 'secret' });
    expect(JSON.parse(ddRequest.body as string)[0]).toMatchObject({
      id: entry.id, service: '@nestarc/audit-log', ddsource: 'nodejs',
    });

    const splunkFetch = jest.fn(async () => new Response(null, { status: 200 }));
    await new SplunkAuditStreamSink({
      url: 'https://splunk.test/services/collector/event', token: 'token',
      fetch: splunkFetch as any,
    }).deliver([entry], context);
    const splunkRequest = (splunkFetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(splunkRequest.headers).toMatchObject({ authorization: 'Splunk token' });
    expect(JSON.parse(splunkRequest.body as string)).toMatchObject({
      time: entry.createdAt.getTime() / 1000, event: { id: entry.id },
    });
  });

  it('uses conditional deterministic object keys and treats existing batches as ACKed', async () => {
    const existing = new Error('exists');
    const client = { putObject: jest.fn(async () => { throw existing; }) };
    await expect(new ObjectStorageAuditStreamSink({
      client, prefix: 'exports', isAlreadyExists: (error) => error === existing,
    }).deliver([entry], context)).resolves.toBeUndefined();
    expect(client.putObject).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringContaining('exports/stream-a/'), ifNoneMatch: '*',
      metadata: expect.objectContaining({ batchId: context.batchId }),
    }));
  });
});
