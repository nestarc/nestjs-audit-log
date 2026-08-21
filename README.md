# @nestarc/audit-log

[![npm version](https://img.shields.io/npm/v/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![npm downloads](https://img.shields.io/npm/dm/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![CI](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-nestarc.dev-blue.svg)](https://nestarc.dev/packages/audit-log/)

Audit logging module for NestJS with automatic Prisma change tracking and append-only PostgreSQL storage.

> **Preview — choose the automatic tracking consistency explicitly.** The new
> `atomic-required` mode commits and rolls back business mutations and automatic audit rows
> together through `withAuditTransaction()`. Legacy `best-effort` mode is not transaction-atomic:
> rollback can leave orphan success rows and transaction-local diffs can be stale.

## Requirements

- NestJS 10 or 11
- Prisma 7 (primary), with Prisma 5/6 legacy peer compatibility
- PostgreSQL
- Node.js 20.19+, 22.12+, or 24.x

## Features

- **Automatic CUD tracking** via Prisma `$extends` — create, update, delete, upsert, and batch operations
- **Transaction-first automatic tracking** — `atomic-required` binds business writes, audit reads, and audit inserts to one official Prisma interactive transaction
- **Before/after diffs** with deep comparison for JSON fields
- **Sensitive field masking** — configurable `[REDACTED]` replacement
- **Manual logging API** — `AuditService.log()` for business events (with optional transaction support)
- **Query API v2** — `AuditService.query()` with keyset cursors, wildcard filters, and optional totals
- **Decorators** — `@NoAudit()` / `@AuditAction()` on handlers or controllers
- **Custom primary keys** — configurable per-model PK field (defaults to `id`)
- **Multi-tenant** — optional `@nestarc/tenancy` integration with explicit tenant scoping
- **Append-only** — trigger enforcement blocks UPDATE/DELETE on audit records by default

## Quick Start

### 1. Install

```bash
npm install @nestarc/audit-log @prisma/client @prisma/adapter-pg pg
npm install --save-dev prisma dotenv
```

### 2. Configure Prisma 7

Prisma 7 uses the `prisma-client` generator with an explicit output path and reads the
CLI datasource URL from `prisma.config.ts`:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

```typescript
// prisma.config.ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
```

### 3. Create the audit_logs table

```typescript
import { applyAuditTableSchema } from '@nestarc/audit-log';

// In a migration or setup script, after creating the Prisma client:
await applyAuditTableSchema(prisma);
```

Or use `getAuditTableSQL()` to get the raw SQL string for your migration tool.

### 4. Complete NestJS Integration

The library requires two Prisma clients with distinct roles:

- **Base client** — used by `AuditService` for writing/querying audit logs
- **Extended client** — used by your application code for business writes (CUD tracking fires here)

```typescript
// prisma.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuditedClient } from '@nestarc/audit-log';

export const prismaModule = { Prisma };

const auditExtensionOptions = {
  consistency: 'atomic-required' as const,
  trackedModels: ['User', 'Invoice', 'Document'],
  sensitiveFields: ['password', 'ssn'],
  prismaModule,
  // primaryKey: { Order: 'orderNumber' }, // for non-id PKs
};

@Injectable()
export class PrismaService implements OnModuleInit {
  /** Base client — for audit storage (log/query) */
  readonly base = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    }),
  });

  /** Extended client — use this for all application queries */
  readonly client = createAuditedClient(this.base, auditExtensionOptions);

  async onModuleInit() {
    await this.base.$connect();
  }
}
```

```typescript
// prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';
import { PrismaModule } from './prisma.module';
import { PrismaService, prismaModule } from './prisma.service';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        prisma: prisma.base,
        prismaModule,
        actorExtractor: (req) => ({
          id: req.user?.id ?? null,
          type: req.user ? 'user' : 'system',
          ip: req.ip,
        }),
        // tenantRequired: true, // fail-closed for manual log/query APIs
      }),
    }),
  ],
})
export class AppModule {}
```

```typescript
// user.service.ts — use prisma.client (extended) for all business writes
@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

      async createUser(data: CreateUserDto) {
        return this.prisma.client.withAuditTransaction((tx) =>
          tx.user.create({ data }),
        );
      }
}
```

## API

### AuditLogModule.forRoot(options) / forRootAsync(options)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prisma` | `PrismaClient` | *required* | Base Prisma client for audit storage |
| `actorExtractor` | `(req) => AuditActor \| Promise<AuditActor>` | *required* | Extracts actor from HTTP request |
| `tenantRequired` | `boolean` | `false` | When `true`, module-side `log()` and ambient `query()`/`getById()` require tenant context unless `tenantId` or `allTenants` is explicit |
| `excludeRoutes` | `RouteInfo[]` | `[]` | Routes excluded from `AuditActorMiddleware` |
| `registerGlobalInterceptor` | `boolean` | `true` | Set `false` to bind `AuditInterceptor` manually |
| `correlationIdHeader` | `string` | `x-request-id` | Header copied into `metadata.correlationId` |
| `correlationIdGetter` | `(req) => string \| undefined` | — | Custom correlation ID source |
| `tableName` | `string` | `audit_logs` | Audit table name used by module-side log/query/prune APIs |
| `tenantResolver` | `() => string \| null` | — | Custom tenant lookup before the optional `@nestarc/tenancy` fallback |
| `sensitiveFields` | `string[]` | `[]` | Metadata keys redacted recursively in objects and arrays for manual logs |
| `sensitiveFieldsByModel` | `Record<string, string[]>` | `{}` | Model-specific metadata redaction keys |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |

### AuditService

```typescript
// Manual logging
await auditService.log({
  action: 'invoice.approved',
  targetId: 'inv-123',
  targetType: 'Invoice',
  metadata: { amount: 5000, currency: 'USD' },
});

// Manual logging inside a transaction
await prisma.base.$transaction(async (tx) => {
  await tx.invoice.update({ where: { id }, data: { status: 'approved' } });
  await auditService.log({ action: 'invoice.approved', targetId: id }, tx);
  // Both roll back together if anything fails
});

// Querying
const result = await auditService.query({
  actorId: 'user-123',
  action: 'invoice.*',     // wildcard support
  targetType: 'Invoice',
  source: 'auto',
  result: 'success',
  from: new Date('2026-01-01'),
  to: new Date('2026-04-01'),
  limit: 50,
  includeTotal: false,
});
// -> { entries: AuditEntry[], nextCursor: string | null, hasMore: boolean }

if (result.nextCursor) {
  await auditService.query({
    actorId: 'user-123',
    action: 'invoice.*',
    targetType: 'Invoice',
    source: 'auto',
    result: 'success',
    from: new Date('2026-01-01'),
    to: new Date('2026-04-01'),
    cursor: result.nextCursor,
    limit: 50,
    includeTotal: false,
  });
}
```

### Decorators

Apply to individual handlers or entire controllers:

```typescript
@NoAudit()      // Skip audit tracking for this route or controller
@AuditAction('user.role.changed')  // Override auto-generated action name
```

### createAuditExtension(options)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `consistency` | `'atomic-required' \| 'best-effort'` | required | `atomic-required` rejects tracked writes outside `withAuditTransaction()` and fails closed; `best-effort` preserves legacy non-atomic behavior |
| `trackedModels` | `string[]` | all models when omitted | Allowlist of Prisma model names to track. `trackedModels: []` means no models are audited |
| `ignoredModels` | `string[]` | `[]` | Denylist used only when `trackedModels` is not set |
| `sensitiveFields` | `string[]` | `[]` | Keys to mask recursively as `[REDACTED]` in scalar and nested JSON diffs |
| `sensitiveFieldsByModel` | `Record<string, string[]>` | `{}` | Per-model fields unioned with `sensitiveFields` |
| `primaryKey` | `Record<string, string>` | `{ *: 'id' }` | Map of model name to primary key field name |
| `databaseMapping` | `Record<string, { tableName: string; schema?: string; primaryKeyColumn?: string }>` | `{}` | PostgreSQL identifiers for atomic row locks; configure mapped models when public Prisma DMMF mapping metadata is unavailable |
| `maxBatchRecords` | `number` | `1000` | Maximum records audited individually by `deleteMany`; a positive integer |
| `batchOverflow` | `'reject' \| 'summary'` | `'reject'` | Behavior when `deleteMany` exceeds the cap; `'summary'` is explicit best-effort-only fallback |
| `tableName` | `string` | `audit_logs` | Audit table used by automatic inserts |
| `tenantRequired` | `boolean` | `false` | Missing tenant fails closed in `atomic-required`; `best-effort` reports `audit entry skipped` and returns the business mutation |
| `tenantResolver` | `() => string \| null` | — | Custom tenant lookup |
| `onAuditError` | `(error, ctx) => void` | — | Structured audit failure callback |
| `logFailures` | `boolean` | `false` | Record best-effort failure audit rows for business write errors |
| `ignoreTimestampOnlyUpdates` | `boolean` | `false` | Suppress `@updatedAt`-only update entries |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |
| `experimentalTxAudit` | `boolean` | `false` | Deprecated legacy compatibility path for `best-effort`; uses private Prisma internals and may silently fall back |

When neither `trackedModels` nor `ignoredModels` is configured, `createAuditExtension()` audits all Prisma models and emits a one-time `No trackedModels/ignoredModels configured` warning. Set `trackedModels` as an allowlist or `ignoredModels` as a denylist to narrow scope.

### Schema Utilities

| Function | Description |
|----------|-------------|
| `getAuditTableSQL(options?)` | Returns raw SQL string for creating audit tables, trigger enforcement, optional partitions, and indexes |
| `getAuditTableStatements()` | Returns SQL split into individual executable statements |
| `applyAuditTableSchema(prisma)` | Executes the schema SQL statement by statement via Prisma |
| `ensurePartitions(prisma, options?)` | Creates missing monthly partitions for partitioned audit tables |

### Retention & Partitioning

`getAuditTableSQL({ partitioned: true })` creates a monthly `PARTITION BY RANGE (created_at)` layout with trigger enforcement and initial UTC month partitions. Keep future partitions available from application bootstrap or a daily maintenance job:

```typescript
import { ensurePartitions } from '@nestarc/audit-log';

await ensurePartitions(maintenancePrisma, { ahead: 1 });
```

Retention is explicit. `AuditService.prune({ olderThan })` deletes old rows on flat tables and drops fully expired monthly partitions on partitioned tables. Use `dryRun: true` to inspect targets first, and pass `client` when retention runs through a privileged maintenance connection:

```typescript
await auditService.prune({
  olderThan: new Date(Date.now() - 90 * 24 * 3600 * 1000),
  client: maintenancePrisma,
});
```

Flat pruning temporarily disables the delete trigger, or drops and recreates the legacy delete RULE, inside one interactive transaction. Partitioned pruning never deletes partial months; it only drops or detaches partitions whose upper bound is at or before `olderThan`.

`olderThan` must be a valid `Date`. `timeoutMs` and `maxWaitMs`, when supplied for flat pruning,
must be positive integers. Flat pruning takes an `ACCESS EXCLUSIVE` lock while enforcement is
temporarily changed; prefer partitioning for large audit tables.

### Database hardening

The generated row triggers block `UPDATE` and `DELETE`, but PostgreSQL `TRUNCATE` does not run row
triggers. A table owner or superuser can also alter/disable triggers, drop the table, or otherwise
bypass append-only enforcement. Treat trigger enforcement as detection and accident prevention,
not as a privilege boundary.

Use separate runtime and maintenance identities. The application identity should not own the table
and should receive only `SELECT` and `INSERT`; keep the owner-capable maintenance connection outside
the application process and pass it explicitly to `prune({ client })`:

```sql
CREATE ROLE audit_owner NOLOGIN;
-- Create/login-role provisioning is environment-specific.

ALTER TABLE audit_logs OWNER TO audit_owner;
ALTER FUNCTION audit_logs_block_mutation() OWNER TO audit_owner;

REVOKE ALL ON TABLE audit_logs FROM PUBLIC;
REVOKE ALL ON TABLE audit_logs FROM app_runtime;
GRANT SELECT, INSERT ON TABLE audit_logs TO app_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM app_runtime;
```

Do not grant `audit_owner` membership, database superuser, or schema `CREATE` privileges to the
runtime role. Restrict who can obtain the maintenance credential, alert on `ALTER TABLE`,
`DROP TABLE`, `TRUNCATE`, and changes to audit triggers, and test the grants after migrations. An
optional `BEFORE TRUNCATE FOR EACH STATEMENT` trigger can make accidental owner-side truncation
fail loudly, but it is still owner-disableable; `REVOKE TRUNCATE` plus owner separation is the
authoritative control.

### Query API v2

`AuditService.query()` returns deterministic newest-first pages ordered by `(created_at, id)`. Prefer cursor pagination for feeds:

```typescript
const page = await auditService.query({
  tenantId: 'tenant-1',
  action: 'invoice.*',
  actorType: 'user',
  source: 'auto',
  result: 'success',
  limit: 50,
  includeTotal: false,
});

if (page.hasMore) {
  await auditService.query({
    tenantId: 'tenant-1',
    action: 'invoice.*',
    actorType: 'user',
    source: 'auto',
    result: 'success',
    cursor: page.nextCursor!,
    limit: 50,
    includeTotal: false,
  });
}
```

`includeTotal: false` skips the `COUNT(*)` query and omits `total` from the result. Cursors do not encode filters; keep the same filter set on each page unless you intentionally want a new filtered scan below the cursor boundary. `getById(id, { tenantId })` returns one audit row within the same tenant scoping rules; use `allTenants: true` only for deliberately authorized cross-tenant admin reads.

### Streaming export and CSV

Use `scan()` for forward, checkpointed export rather than adapting the newest-first `query()` API.
Export never uses ambient tenant context: pass exactly one of `tenantId` or the deliberately
cross-tenant `allTenants: true`. The scan runs no `COUNT(*)` query.

```typescript
let checkpoint: string | undefined;

for await (const page of auditService.scan({
  tenantId: 'tenant-1',
  action: 'invoice.*',
  from: new Date('2026-08-01T00:00:00.000Z'),
  batchSize: 500,
  after: checkpoint,
  signal: abortController.signal,
})) {
  await deliver(page.entries);
  checkpoint = page.checkpoint ?? checkpoint; // persist only after delivery is acknowledged
  await saveCheckpoint(checkpoint, page.highWatermark);
}
```

Entries are ordered by `(created_at, id)` ascending. At scan start, `highWatermark` is fixed to the
greatest matching row, so newer rows do not extend an in-progress export. To resume the exact same
bounded run, pass the saved `checkpoint` as `after` and the saved high-watermark as `until`. Keep the
same filters when resuming; checkpoints intentionally do not encode filters. `batchSize` defaults to
500 and must be between 1 and 10,000. An empty scan yields one empty page with a null checkpoint.

`exportCsv()` consumes the same scan primitive and returns a backpressure-aware Node.js `Readable`:

```typescript
const csv = auditService.exportCsv({
  tenantId: 'tenant-1',
  columns: 'v1',
  includeBom: true, // optional; useful for some spreadsheet clients
  batchSize: 500,
});

csv.pipe(httpResponse);
```

CSV `v1` columns are exported by `AUDIT_CSV_COLUMNS_V1` and begin with a `schemaVersion` field. Rows
use RFC 4180 quoting and CRLF delimiters; `changes` and `metadata` use recursively key-sorted
canonical JSON. Text cells beginning with an Excel formula marker (`=`, `+`, `-`, or `@`, including
leading whitespace) receive an apostrophe prefix. HTTP authorization, file response headers, and
export-job scheduling remain host-application responsibilities.

### Durable log streams

`AuditStreamRunner` tails only committed rows through `scan()` and performs one bounded run. Invoke
it from the host application's cron, BullMQ worker, or another scheduler; the package does not start
background timers. The PostgreSQL store persists both the last ACKed checkpoint and an in-progress
high-watermark, so a restart resumes the same bounded range.

```typescript
import {
  applyAuditStreamStoreSchema,
  AuditStreamRunner,
  HttpAuditStreamSink,
  PostgresAuditStreamStore,
} from '@nestarc/audit-log';

await applyAuditStreamStoreSchema(prisma); // run through migrations in production

const streamStore = new PostgresAuditStreamStore({ prisma, prismaModule });
const runner = new AuditStreamRunner(auditService, {
  streamId: 'tenant-1-primary-siem',
  scan: {
    tenantId: 'tenant-1', // or intentional allTenants: true
    action: 'invoice.*',
    batchSize: 500,
  },
  sink: new HttpAuditStreamSink({
    url: process.env.SIEM_URL!,
    format: 'ndjson', // or json
    headers: { authorization: `Bearer ${process.env.SIEM_TOKEN}` },
  }),
  checkpointStore: streamStore,
  deadLetterStore: streamStore,
  maxRetries: 5,
  onMetric: (metric) => metrics.record(metric),
  onError: (error, context) => logger.error({ error, context }),
});

await runner.runOnce({ signal: abortController.signal });
```

Delivery is at least once. A batch is ACKed only by a successful sink call (or an idempotent DLQ
write for a terminal batch), and its checkpoint is saved afterward. If checkpoint persistence
fails, the same audit entry IDs are sent again. Generic HTTP requests publish their deterministic
`firstEntryId:lastEntryId` batch ID as `Idempotency-Key`; receivers must deduplicate by batch or
entry ID. Pages are delivered sequentially for backpressure. Network failures, HTTP 408/425/429,
and 5xx responses retry with bounded exponential backoff; `Retry-After` is honored up to
`maxBackoffMs`. Other 4xx responses are terminal: with a DLQ store they are durably recorded before
the checkpoint advances, and without one the run fails without advancing. Metrics and error hooks
are observational and cannot change delivery state.

`ObjectStorageAuditStreamSink` writes deterministic NDJSON objects with conditional create
(`If-None-Match: *` semantics) through a provider-neutral client; adapt an AWS S3/GCS client to its
small `putObject()` interface. `DatadogAuditStreamSink` maps a batch to the Datadog HTTP Logs array
contract, while `SplunkAuditStreamSink` emits newline-delimited HEC event envelopes. Both accept an
explicit endpoint so region and deployment selection stays with the host. Configure only one
active runner for a given `streamId`; overlapping runs can redeliver but entry IDs remain stable.

Stream-specific redaction can be applied with `redact(entry)`. The runner clones each entry before
calling it and rejects a redactor that changes the entry ID. Export scope remains explicit and
never uses ambient tenancy.

Retention must not pass the slowest required stream. Load every required stream state and pass its
non-null checkpoint to `prune()`:

```typescript
await auditService.prune({
  olderThan: cutoff,
  requiredCheckpoints: requiredStates
    .map((state) => state.checkpoint)
    .filter((value): value is string => value !== null),
});
```

The prune call fails before database maintenance when the cutoff is newer than any supplied
checkpoint. A required stream with no checkpoint must block prune at the host policy layer. For
partition archives that must move sooner, use an externally managed detach-first procedure and
tail the detached storage before dropping it.

### Nested writes

Nested relation mutations are not synthesized into child audit rows. In `atomic-required`, a nested
`create`, `connect`, `disconnect`, `update`, `upsert`, `delete`, `set`, or corresponding `*Many`
operation targeting a tracked related model is rejected before the business query. Express it as
explicit related-model mutations inside `withAuditTransaction()` so each record receives an atomic
audit row. Relations whose target model is intentionally outside the tracking configuration do not
trigger this guard when Prisma exposes the relation metadata. If that metadata is unavailable, the
atomic path fails conservatively. `best-effort` preserves the top-level mutation and emits one
warning per model/relation, so it is not authoritative evidence for the nested changes.

### Transaction Model

| Path | Business write | Audit insert |
|------|----------------|--------------|
| `atomic-required` + `withAuditTransaction()` | Same official Prisma interactive `tx` | Same `tx`; audit read/insert failure rolls back the business mutation |
| `atomic-required` outside the helper | Rejected before execution | Not attempted |
| Explicit `best-effort` | Uses Prisma's `query(args)`, so the business write remains in the caller `$transaction` | Independent base-client insert; does not join the caller transaction |
| Manual logging with `AuditService.log(input, tx)` | Caller-controlled | Participates in the provided transaction |
| Manual logging with `AuditService.log(input)` | Caller-controlled | Independent write via the base client |

Use the transaction-first API for authoritative automatic records:

```typescript
const prisma = createAuditedClient(basePrisma, {
  consistency: 'atomic-required',
  trackedModels: ['User', 'Invoice'],
  prismaModule,
});

await prisma.withAuditTransaction(
  async (tx) => {
    await tx.user.update({ where: { id }, data: { name: 'After' } });
    await tx.invoice.create({ data: invoice });
  },
  { timeout: 10_000, maxWait: 5_000, isolationLevel: 'Serializable' },
);
```

The helper forwards `timeout`, `maxWait`, and `isolationLevel`, preserves the transaction callback
and result types, rejects nested helper calls, and uses no private Prisma API. `timeout` and
`maxWait`, when supplied, must be positive integers. In
`atomic-required`, pre-read, post-read, audit INSERT, and audit context construction errors are
fail-closed. A tracked mutation outside the helper throws before its business query runs.
Single-row update, delete, and upsert operations lock the target row and refresh the preimage before
the mutation, so concurrent audited writers record the immediate committed before value. For Prisma
clients that do not publicly expose DMMF mapping metadata, models using `@@map`, `@@schema`, or a
mapped primary-key column must declare `databaseMapping` (for example,
`{ User: { tableName: 'users' } }`). A missing or incorrect mapping fails closed before the business
mutation.

`best-effort` must be selected explicitly. If its caller transaction rolls back, the business row
rolls back but the automatic audit row can remain as an orphan row. Transaction-local update diffs
can be empty or stale because its reads use the base client.

The same best-effort rule applies to array transactions (`$transaction([...])`). When a later operation rolls back the batch, Prisma 7 may have already allowed an earlier operation's extension callback to write an orphan success audit row. Do not rely on automatic auditing for atomic batch audit semantics.

Array transactions remain outside the atomic contract. In `atomic-required`, a detected array
`$transaction([...])` fails before the business query with an error directing callers to sequential
operations inside `withAuditTransaction()`. `experimentalTxAudit` is deprecated and cannot be
combined with `atomic-required`. `AuditService.log(input, tx)` remains the stable manual event path.

### Bulk mutation contract

| Operation | `atomic-required` | `best-effort` |
|-----------|-------------------|---------------|
| `createMany` | Rejected before mutation because Prisma only returns count-level evidence | One `Model.createdMany` summary row |
| `updateMany` | Rejected before mutation because exact record before/after diffs are unavailable | One `Model.updatedMany` summary row |
| `deleteMany` | Locks and refreshes at most `maxBatchRecords` preimages, then writes one `Model.deleted` row per deleted record in the same transaction | Writes record rows up to the cap; overflow rejects unless `batchOverflow: 'summary'` is explicitly selected |
| `createManyAndReturn` / `updateManyAndReturn` | Not supported | Not supported or intercepted; do not use them for tracked models |

Summary rows are deliberately not shaped like record evidence: `targetId` is `null`, `changes` is
empty, and metadata contains `auditKind: 'summary'`, the exact `operation`, `recordCount`, and
`recordsAudited: false`. Per-record `deleteMany` rows keep the singular `Model.deleted` action and
include `auditKind: 'record'`, `operation: 'deleteMany'`, and `batchSize` metadata.

The default overflow policy is fail-closed. Best-effort callers that explicitly choose summary
overflow receive one `Model.deletedMany` row with `overflow: true` and `maxBatchRecords`; it is a
batch activity marker, not evidence of which rows were deleted. In atomic mode, a cap overflow,
preimage/affected-count mismatch, or any audit insert failure rolls back the entire `deleteMany`.

### Atomic soft-delete lifecycle integration

`@nestarc/soft-delete` can route rewritten lifecycle mutations through the same official transaction.
Apply extensions in the fixed order tenancy → audit-log → soft-delete:

```typescript
const prisma = basePrisma
  .$extends(createPrismaTenancyExtension(tenancyService))
  .$extends(createAuditExtension({
    consistency: 'atomic-required',
    trackedModels: ['User', 'Post', 'Comment'],
    databaseMapping: {
      User: { tableName: 'users' },
      Post: { tableName: 'posts' },
      Comment: { tableName: 'comments' },
    },
    prismaModule,
  }))
  .$extends(createPrismaSoftDeleteExtension({
    softDeleteModels: ['User', 'Post', 'Comment'],
    auditLifecycle: 'atomic-required',
    auditMaxBatchRecords: 1000,
    cascade: { User: ['Post'], Post: ['Comment'] },
    dmmf: prismaDmmf,
  }));

await prisma.withAuditTransaction((tx) =>
  tx.user.delete({ where: { id } }),
);
```

The bridge covers soft-delete, restore, force-delete/purge, cascade, and supported bulk lifecycle
mutations. Actions are `Model.softDeleted`, `Model.restored`, and `Model.purged`; cascade rows are
record-level and identify `cascadeDelete` or `cascadeRestore` in `metadata.lifecycleOperation`.
`deleteMany` and
`restoreMany` become record-level mutations and fail before mutation when `auditMaxBatchRecords` is
exceeded. Lifecycle events remain notifications, not authoritative audit integration. Purge does not
invent cascade semantics; configured database foreign-key behavior still applies.

## Multi-Tenancy

Tenant resolution uses this order: explicit `tenantResolver`, optional `@nestarc/tenancy`, then `null`.
`atomic-required` treats resolution failures as transaction failures; `best-effort` reports and isolates
them from the business mutation.

| Path | Missing tenant behavior |
|------|-------------------------|
| Automatic tracking, `tenantRequired: false` | Writes an audit row with `tenant_id = null` |
| Automatic tracking, `tenantRequired: true` | `atomic-required`: throws and rolls back; `best-effort`: skips the audit row, reports `audit entry skipped`, and returns the business mutation |
| `AuditService.log()` with `tenantRequired: true` | Throws unless tenant context is available |
| `query()` / `getById()` with explicit `tenantId` | Scopes to that tenant |
| `query()` / `getById()` with `allTenants: true` | Omits tenant filtering for authorized cross-tenant reads |
| `query()` / `getById()` with `tenantRequired: true` and no tenant | Throws unless `tenantId` or `allTenants` is explicit |
| `scan()` / `exportCsv()` | Never uses ambient scope; requires exactly one of explicit `tenantId` or `allTenants: true` |

`tenantId` and `allTenants` are mutually exclusive; the thrown error includes `tenantId and allTenants are mutually exclusive`. Without `tenantRequired`, an ambient query with no tenant context is allowed but logs a one-time warning because it is unscoped.

## Performance

Measured with PostgreSQL 16, Prisma 7.9.1, 300 iterations on Apple Silicon:

| Scenario | Avg | P50 | P95 | P99 |
|----------|-----|-----|-----|-----|
| create — no audit (baseline) | 0.70ms | 0.62ms | 0.98ms | 1.57ms |
| **create — with audit** | **1.80ms** | **1.73ms** | **2.48ms** | **3.43ms** |
| **update — with audit + diff** | **2.11ms** | **2.05ms** | **2.82ms** | **3.28ms** |
| **delete — with audit** | **1.52ms** | **1.49ms** | **1.98ms** | **2.57ms** |

Create overhead: **+1.10ms** per write. Update is slowest due to before/after diff calculation.

> Reproduce: `docker compose -f test/e2e/docker-compose.yml up -d && npx ts-node benchmarks/audit-overhead.ts`

## Development

### Prerequisites

- Node.js 20.19+, 22.12+, or 24.x
- Docker (for E2E tests)

### Setup

```bash
npm install
npm run build
```

### Run tests

```bash
# Unit tests
npm test

# E2E tests (starts Docker PostgreSQL automatically)
npm run test:e2e:full

# Cleanup
npm run test:e2e:teardown
```

## License

MIT
