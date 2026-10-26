# Audit export and durable delivery

Documents the PostgreSQL export and stream APIs for release target `0.8.0`. Start with the [README](../README.md);
see [CHANGELOG](../CHANGELOG.md) for version changes.

SQL Server supports manual logging, managed transactions, history queries and table installation;
its scan, export and stream APIs are not
supported. See the [SQL Server guide](sql-server.md) for that provider's current scope.

## Streaming export and CSV

Use `scan()` for forward, checkpointed export. It requires exactly one of `tenantId` or deliberately
authorized `allTenants: true`; it never uses ambient tenant context or runs `COUNT(*)`.

The following fragment assumes an initialized `auditService` and host-provided `loadExportState`,
`deliver`, and `saveExportState` functions. Persist both the checkpoint and high-watermark, and keep
the filter set with your export job's configuration.

```typescript
const saved = await loadExportState(); // { checkpoint, highWatermark } or null
const abortController = new AbortController();
let checkpoint: string | undefined = saved?.checkpoint ?? undefined;

for await (const page of auditService.scan({
  tenantId: 'tenant-1',
  action: 'Invoice.*',
  batchSize: 500,
  after: checkpoint,
  until: saved?.highWatermark ?? undefined,
  signal: abortController.signal,
})) {
  await deliver(page.entries);
  checkpoint = page.checkpoint ?? checkpoint;
  await saveExportState({ checkpoint, highWatermark: page.highWatermark });
}
```

Entries are ordered by `(created_at, id)` ascending. A checkpoint is exclusive (`after`) and the
high-watermark is inclusive (`until`). To resume the same tuple range, pass both saved values and
the same filters. Checkpoints contain positions, not filters. `batchSize` defaults to 500 and must
be between 1 and 10,000. An empty scan yields one empty page with a null checkpoint.

`after === until` is an already completed range: it yields one empty page
without a database query or replay. `after > until` is invalid. This completed-range behavior is a
0.6.0 correction to the published v0.5.0 validation.

`AuditScanOptions` supports `action`, `actorId`, `targetType`, `targetId`, `from`, `to`, `batchSize`,
`after`, `until`, and `signal`, in addition to explicit tenant scope. It does not expose every
`query()` filter, such as `source`, `result`, or `actorType`.

`exportCsv()` consumes the same scan primitive and returns a backpressure-aware Node.js `Readable`:

```typescript
import { pipeline } from 'node:stream/promises';

const csv = auditService.exportCsv({
  tenantId: 'tenant-1',
  columns: 'v1',
  includeBom: true, // useful for some spreadsheet clients
  batchSize: 500,
});

await pipeline(csv, httpResponse); // httpResponse is your authorized HTTP response stream
```

CSV `v1` columns are exported by `AUDIT_CSV_COLUMNS_V1` and begin with a `schemaVersion` field. Rows
use RFC 4180 quoting and CRLF delimiters; `changes` and `metadata` use recursively key-sorted
canonical JSON. Text cells beginning with an Excel formula marker (`=`, `+`, `-`, or `@`, including
leading whitespace) receive an apostrophe prefix. HTTP authorization, response headers, disconnect
handling, and export-job scheduling remain host-application responsibilities.

## Visibility and late commits

A `highWatermark` fixes the greatest visible `(created_at, id)` tuple; it does not create a database
snapshot. Separate scan pages can observe different committed data. Transactions can commit rows
behind an already processed checkpoint, which later runs will skip. ACK checkpointing and delivery
retries apply to rows observed by the scanner; continuous capture of every commit is not guaranteed.

For example, a transaction can insert an audit row, remain open, and commit after another transaction
has already produced and delivered a later timestamp. The earlier row's position is then behind the
saved checkpoint. Persisting `highWatermark` does not repair that gap or restore a database snapshot.

For continuous capture that includes late commits, use an external PostgreSQL CDC/logical-decoding
pipeline with a coordinated initial snapshot and WAL position. This package does not implement CDC.
Reconciliation can rescan retained rows and deduplicate by audit entry ID, provided retention leaves
those rows available. A finite polling delay or lookback window alone cannot cover transactions of
arbitrary duration.

## A consistent snapshot export

For a bounded export of rows visible in one database snapshot, bind a new `AuditService` to an
explicit `RepeatableRead` transaction and consume the iterator before its callback finishes:

```typescript
import { AuditService } from '@nestarc/audit-log';

await basePrisma.$transaction(async (tx) => {
  const snapshotAudit = new AuditService({
    ...auditOptions, // the same module options, including actorExtractor and prismaModule
    prisma: tx,
  });

  for await (const page of snapshotAudit.scan({ tenantId: 'tenant-1' })) {
    await deliver(page.entries);
  }
}, {
  isolationLevel: 'RepeatableRead',
  timeout: 60_000, // choose a timeout appropriate for your export size and destination
});
```

Here `basePrisma`, `auditOptions`, and `deliver` are application-owned dependencies. An existing
injected `auditService` does not automatically join this transaction. CSV pipelines must likewise
finish inside the callback. Slow delivery keeps the snapshot transaction open, so plan the job's
resource use and timeout.

The snapshot includes only rows visible to that transaction and excludes later commits. Saved
checkpoint/high-watermark values cannot recreate the same snapshot after a process restart. Restart
with a new snapshot or export from an externally preserved dataset if an identical dataset is required.

## Durable log streams

`AuditStreamRunner` performs one bounded scan and persists delivery progress. Invoke it from cron,
a BullMQ worker, or another scheduler; the package does not start background timers. The PostgreSQL
store saves the last ACKed checkpoint and an in-progress high-watermark, so restarts resume the same
tuple range, subject to the visibility limits above.

This setup fragment uses the base client and generated `prismaModule` from the Quick Start. Supply
your destination URL/token and schedule `runOnce()` in the host application.

```typescript
import {
  applyAuditStreamStoreSchema,
  AuditStreamRunner,
  HttpAuditStreamSink,
  PostgresAuditStreamStore,
} from '@nestarc/audit-log';

await applyAuditStreamStoreSchema(basePrisma); // apply through migrations in production
const streamStore = new PostgresAuditStreamStore({ prisma: basePrisma, prismaModule });
const abortController = new AbortController();

const runner = new AuditStreamRunner(auditService, {
  streamId: 'tenant-1-primary-siem',
  scan: {
    tenantId: 'tenant-1',
    action: 'Invoice.*',
    batchSize: 500,
  },
  sink: new HttpAuditStreamSink({
    url: process.env.SIEM_URL!,
    format: 'ndjson', // or 'json'
    headers: { authorization: `Bearer ${process.env.SIEM_TOKEN}` },
  }),
  checkpointStore: streamStore,
  deadLetterStore: streamStore,
  maxRetries: 5,
});

const result = await runner.runOnce({ signal: abortController.signal });
// result: status, deliveredEntries, deadLetteredEntries, batches, checkpoint
```

Delivery uses at-least-once retries for observed batches. A batch is ACKed only after a successful
sink call or an idempotent dead-letter queue (DLQ) write for a terminal batch; the checkpoint is saved
afterward. DLQ acceptance advances progress even though the primary destination did not accept the
batch. The host must operate DLQ inspection and recovery.

If checkpoint persistence fails, an entry can be sent again. HTTP requests publish a deterministic
`firstEntryId:lastEntryId` value as `Idempotency-Key`. Receivers should deduplicate by **audit entry
ID**. The batch ID is a retry hint, not proof of complete capture or immutable membership: newly
visible rows can change a repeated range's contents without changing its first and last IDs.

Pages are delivered sequentially for backpressure. Network failures, HTTP 408/425/429, and 5xx
responses retry with bounded exponential backoff; `Retry-After` is honored up to `maxBackoffMs`.
Other 4xx responses are terminal: with a DLQ store they are recorded before the checkpoint advances,
and without one the run fails without advancing. `onMetric` and `onError` are observational hooks;
their failures cannot change delivery state.

Configure only one active runner per `streamId`; the package does not acquire a distributed lease.
Use a new stream ID if filters, tenant scope, destination policy, or required history change. Keep
that configuration with the host job because stored checkpoints do not encode it.

## Other sinks and redaction

- `ObjectStorageAuditStreamSink` writes deterministic NDJSON objects with conditional create
  (`If-None-Match: *` semantics) through the `AuditObjectStorageClient.putObject()` interface.
  Adapt your S3/GCS client; provider SDKs are not bundled.
- `DatadogAuditStreamSink` maps batches to the Datadog HTTP Logs array contract.
- `SplunkAuditStreamSink` emits newline-delimited HEC event envelopes.

Datadog and Splunk accept explicit endpoints so region/deployment selection stays with the host.
Conditional object creation and DLQ batch keys also do not compensate for scan gaps or changing
range membership; plan reconciliation when full capture is required.

Use `redact(entry)` on the runner for destination-specific redaction. Each entry is cloned first,
and a redactor that changes the entry ID is rejected. Export scope remains explicit and never uses
ambient tenancy. Sink options and adapter interfaces are exported from `@nestarc/audit-log`.

## Retention and required streams

The host must enumerate every required stream and block pruning when any state or checkpoint is
missing. Never silently drop those streams from the check. This fragment assumes the `streamStore`
above, an owner-capable `maintenancePrisma`, and your policy's `cutoff` date:

```typescript
const requiredStreamIds = ['tenant-1-primary-siem'];
const requiredCheckpoints = await Promise.all(requiredStreamIds.map(async (streamId) => {
  const state = await streamStore.load(streamId);
  if (!state?.checkpoint) {
    throw new Error(`Prune blocked: required stream ${streamId} has no checkpoint`);
  }
  return state.checkpoint;
}));

const preview = await auditService.prune({
  olderThan: cutoff,
  client: maintenancePrisma,
  requiredCheckpoints,
  dryRun: true,
});
// Review preview, then run the same policy check and prune without dryRun.
```

`prune()` fails before database maintenance when the cutoff is newer than any supplied checkpoint.
This only checks timestamp progress; it does not prove all earlier commits were observed or delivered.
A required stream with no checkpoint blocks maintenance even if it has not observed any rows yet;
handle intentional exceptions explicitly in your host policy.

For archives that must move sooner, use an externally managed detach-first procedure and reconcile
or export the detached storage before dropping it. See [storage and retention](storage-and-retention.md).
