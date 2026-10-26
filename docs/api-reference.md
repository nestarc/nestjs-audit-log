# Audit log API reference

Documents release target `0.8.0`. Start with the [README](../README.md);
see [CHANGELOG](../CHANGELOG.md) for version changes. `actorRequired` and `defineAuditConfig()`
were added in 0.7.0 and are not part of the 0.6.0 API.

The [0.8.0 feature guide](product-quality.md) covers managed manual transactions, validation,
SQL Server reads, and diagnostics. See the [release notes](releases/0.8.0.md) for version boundaries.

**SQL Server support in 0.8.0:** `AuditDatabaseProvider` is `'postgresql' | 'sqlserver'`.
Omitted `provider` selects PostgreSQL. Explicit `provider: 'sqlserver'` enables manual logging,
managed manual transactions, `query()`/`getById()`, flat-table DDL, storage inspection and optional
read indexes. Automatic tracking, scan/export, retention and partitions remain unsupported.
See the [SQL Server guide](sql-server.md) for configuration and transaction usage.

## Entry points

Import runtime APIs and types from `@nestarc/audit-log`. The package ships its declaration files;
use them for the complete current signatures.

| Entry point | Purpose |
|---|---|
| `AuditLogModule.forRoot(options)` | Register synchronous NestJS options and export `AuditService` |
| `AuditLogModule.forRootAsync({ imports?, inject?, useFactory })` | Register a factory that returns options or a promise of options |
| `defineAuditConfig(input)` | Added in 0.7.0: build consistent module, optional extension, schema and partition options |
| `createAuditedClient(basePrisma, options)` | Extend a base client and preserve the typed transaction callback/result |
| `basePrisma.$extends(createAuditExtension(options))` | Compose the audit extension explicitly with other Prisma extensions |
| `client.withAuditTransaction(callback, options?)` | Run supported automatic writes and audit work on the same interactive transaction |
| `client.getAuditCapabilities()` | Inspect `{ consistency, atomicLifecycle }` for extension integrations |
| `audit.withManualTransaction(client, callback, options?)` | Added in 0.8.0: bind manual events to an owned transaction and reject commit after a caught audit failure |
| `audit.getCapabilities()` | Added in 0.8.0: inspect provider API capabilities without database I/O |
| `inspectSqlServerAuditStorage(client, options?)` | Added in 0.8.0: inspect visible SQL Server storage metadata with a diagnostic identity |
| `getSqlServerAuditReadIndexStatements(options?)`, `applySqlServerAuditReadIndexes(client, options?)` | Added in 0.8.0: plan or apply optional additive SQL Server read indexes |

Module and extension configuration are independent: nothing merges them at runtime. For example,
setting `actorRequired`, `tenantRequired`, or `sensitiveFields` on the module does not configure automatic tracking.
Use `defineAuditConfig()` as shown in the [Quick Start](../README.md#quick-start) to build matching
options for both registration sites and storage utilities. Direct option objects remain supported.

<a id="common-configuration-factory-070-unreleased"></a>

## Common configuration factory

`defineAuditConfig()` is a synchronous options builder. It performs no DB I/O, creates no Prisma
client, registers no Nest module, and does not call extractors, resolvers or logging hooks.
Existing independent registration APIs remain supported.

| Input section | Accepted settings |
|---|---|
| `shared` (optional) | `tableName`, `prismaModule`, `tenantRequired`, `tenantResolver`, `actorRequired`, `sensitiveFields`, `sensitiveFieldsByModel`, `logger`, `onAuditError`, `provider` |
| `module` (required) | Required `actorExtractor`; optional `actorExtractionStage`, `excludeRoutes`, `registerGlobalInterceptor`, `correlationIdHeader`, `correlationIdGetter`, `strictManualValidation`, `maxMetadataBytes`, `onAuditOperation` |
| `extension` (optional) | Required explicit `consistency`; optional `trackedModels`, `ignoredModels`, `primaryKey`, `databaseMapping`, `maxBatchRecords`, `batchOverflow`, `logFailures`, `ignoreTimestampOnlyUpdates` |
| `schema` (optional) | `partitioned`, `enforcement`, `ginIndex` |

Shared fields belong only in `shared`. The factory rejects misplaced or unknown fields with their
configuration path, including JavaScript/`any` overrides whose value is `undefined`. Supply `prisma`
when registering the module, outside the factory. The factory reuses table-name and extension-policy
validation; consuming APIs retain their other validation and defaults. Omitting `extension` produces
`extensionOptions: undefined`; providing it produces an `AuditExtensionOptions` without an undefined
union. An input whose extension is optional at runtime returns a union that must be narrowed.

```typescript
// Available in @nestarc/audit-log 0.7.0.
import { AuditLogModule, createAuditedClient, defineAuditConfig } from '@nestarc/audit-log';
import { Prisma } from './generated/prisma/client';

const config = defineAuditConfig({
  shared: {
    prismaModule: { Prisma },
    tableName: 'audit_events',
    tenantRequired: true,
    tenantResolver, // Host-owned tenant context.
    actorRequired: true,
    sensitiveFields: ['password', 'ssn'],
  },
  module: {
    actorExtractor, // Host-owned authenticated identity extraction.
    actorExtractionStage: 'interceptor', // After authentication Guards.
  },
  extension: {
    consistency: 'atomic-required',
    trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users' } },
  },
  schema: { partitioned: false },
});

const audited = createAuditedClient(base, config.extensionOptions);
const auditModule = AuditLogModule.forRoot({ ...config.moduleOptions, prisma: base });
// Alternative Nest registration, when a base client is injected:
const asyncAuditModule = AuditLogModule.forRootAsync({
  imports: [PrismaModule],
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => ({ ...config.moduleOptions, prisma: prisma.base }),
});
```

The host supplies `base`, `actorExtractor`, `tenantResolver`, and its Nest Prisma provider.
Automatic tracked writes still require `audited.withAuditTransaction(...)`; see the
[transaction contract](transactions.md). Actor extraction timing does not implement authentication.

For manual events only, omit the extension:

```typescript
const manualConfig = defineAuditConfig({
  shared: { prismaModule: { Prisma }, actorRequired: true, sensitiveFields: ['password'] },
  module: { actorExtractor, actorExtractionStage: 'interceptor' },
});
AuditLogModule.forRoot({ ...manualConfig.moduleOptions, prisma: base });
// manualConfig.extensionOptions is undefined. Use AuditService.log(input, tx)
// inside the existing transaction and propagate failures for rollback.
```

Use `applyAuditTableSchema(setupClient, config.schemaOptions)` in a separate setup/migration step.
For a partitioned table, use
`ensurePartitions(maintenanceClient, { ...config.partitionOptions, ahead: 1 })` in maintenance.
`tableName` and `provider` flow from shared settings to these utilities; tenant and actor policies remain
write/query settings. Calling the factory never applies schema or schedules maintenance.

Arrays and plain configuration objects are copied independently for the input and each output,
including nested masking lists, mappings and routes. Functions, logger instances (including object
literals), and the generated `Prisma` namespace retain identity; the `prismaModule` wrapper is copied.
Nothing is frozen or JSON-serialized. This gives consistency at creation time: later edits or spread
overrides are the caller's responsibility and are not synchronized between registrations.

## Module options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prisma` | `PrismaClient` | *required* | Base Prisma client for audit storage |
| `provider` | `'postgresql' \| 'sqlserver'` | `'postgresql'` | Database dialect; SQL Server supports manual logging, managed manual transactions and history queries |
| `actorExtractor` | `(req) => AuditActor \| Promise<AuditActor>` | *required* | Extracts actor from HTTP request |
| `actorExtractionStage` | `'middleware' \| 'interceptor'` | `'middleware'` | Added in 0.6.0: choose `interceptor` for identity populated by authentication Guards; [actor timing](context-and-tenancy.md#http-actor-extraction) |
| `actorRequired` | `boolean` | `false` | Added in 0.7.0: `log()` requires a non-blank string actor ID, including system actors; reads are unaffected |
| `tenantRequired` | `boolean` | `false` | When `true`, `log()` requires tenant context; `query()`/`getById()` require it unless explicit `tenantId` or `allTenants` is supplied |
| `excludeRoutes` | `RouteInfo[]` | `[]` | Routes excluded from `AuditActorMiddleware` |
| `registerGlobalInterceptor` | `boolean` | `true` | Set `false` to bind `AuditInterceptor` manually |
| `correlationIdHeader` | `string` | `x-request-id` | Header copied into `metadata.correlationId` |
| `correlationIdGetter` | `(req) => string \| undefined` | — | Custom correlation ID source |
| `tableName` | `string` | `audit_logs` | Audit table name used by module-side APIs; SQL Server unqualified names resolve to `dbo` |
| `tenantResolver` | `() => string \| null` | — | Replaces the optional `@nestarc/tenancy` lookup; returning `null` does not fall back |
| `sensitiveFields` | `string[]` | `[]` | Metadata keys redacted recursively in objects and arrays for manual logs |
| `sensitiveFieldsByModel` | `Record<string, string[]>` | `{}` | Model-specific metadata redaction keys |
| `strictManualValidation` | `boolean` | `false` | Added in 0.8.0: validate manual identity, event fields and JSON-compatible metadata before insertion |
| `maxMetadataBytes` | `number` | — | Added in 0.8.0: positive safe-integer limit for final redacted metadata JSON in UTF-8 bytes |
| `onAuditOperation` | `(event: AuditOperationEvent) => unknown` | — | Added in 0.8.0: observe manual log and managed transaction outcomes without event contents |
| `onAuditError` | `(error: unknown, ctx: AuditErrorContext) => unknown` | — | Reports extraction and rejected manual validation, context, tenant resolution, serialization and INSERT failures; observer failures do not replace the original error |
| `logger` | `AuditLogger` | `console` | Minimal `warn(message)` / `error(message)` logger |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |

## Prisma extension options

Extension options also accept `provider`, defaulting to `'postgresql'`.
`'sqlserver'` is rejected at extension creation, including when supplied through `defineAuditConfig()`.

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
| `actorRequired` | `boolean` | `false` | Added in 0.7.0: missing/blank actor ID rejects atomic writes before the business query; best-effort reports the policy error and skips audit rows |
| `tenantRequired` | `boolean` | `false` | Missing tenant fails closed in `atomic-required`; `best-effort` reports `audit entry skipped` and returns the business mutation |
| `tenantResolver` | `() => string \| null` | — | Custom tenant lookup |
| `onAuditError` | `(error, ctx) => unknown` | — | Structured audit failure callback; synchronous throws and rejected promises are isolated |
| `logger` | `AuditLogger` | `console` | Minimal `warn(message)` / `error(message)` logger |
| `logFailures` | `boolean` | `false` | Record best-effort failure audit rows for business write errors |
| `ignoreTimestampOnlyUpdates` | `boolean` | `false` | Suppress `@updatedAt`-only update entries |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |

When neither `trackedModels` nor `ignoredModels` is configured, `createAuditExtension()` audits all Prisma models and emits a one-time `No trackedModels/ignoredModels configured` warning. Set `trackedModels` as an allowlist or `ignoredModels` as a denylist to narrow scope.

## AuditService.withManualTransaction(client, callback, options?)

Added in 0.8.0 for PostgreSQL and SQL Server. Pass the application's base Prisma client and an
async callback receiving `{ tx, log }`. The callback's return type and the generated transaction
client types are preserved. The bound `log(input)` always uses that transaction; even a caught
audit failure prevents commit. Already-started log calls settle before completion, and the writer
rejects after callback completion or transaction abort. Nested managed helpers are rejected.

Options are `maxWait`, `timeout` and `isolationLevel`, subject to the provider's support. Business
writes must use the supplied `tx`; the helper cannot detect a missing `log` or enlist writes through
a captured base client. See the [managed transaction guide](product-quality.md#own-the-manual-transaction)
for examples, lifetime and error semantics.

## AuditService.getCapabilities()

Added in 0.8.0. Returns a frozen object describing the configured provider's manual logging,
managed transactions, query, automatic tracking, scan, export, retention, schema inspection and
read-index APIs. It performs no database I/O and does not validate a live schema or permissions.
See the [capability table](product-quality.md#discover-provider-capabilities). This differs from
the audited client's `getAuditCapabilities()`, which describes automatic consistency/lifecycle support.

## AuditService.log(input, tx?)

Returns `Promise<void>`. The required input field is `action`; optional fields are `targetType`,
`targetId`, `metadata`, and `result` (`'success'` by default, or `'failure'`). `source` is always
`'manual'`. The actor and context metadata come from `AuditContext`; tenant lookup uses the module
configuration. With the default `actorRequired: false`, missing actor context uses
`actorId: null` and `actorType: 'system'`. With `actorRequired: true`, all actor types (`user`,
`system`, `api_key`) need a string ID whose trimmed length is at least one; the stored ID is not
trimmed. Invalid actors reject before the audit INSERT, with or without `tx`, including inside
`@NoAudit()`. The policy reports `phase: 'context'`, `operation: 'log'`, and the target model when
available. A throwing reporting hook cannot replace the policy error.

To commit a manual event with its business mutation, pass the transaction explicitly:

```typescript
await prismaService.base.$transaction(async (tx) => {
  const user = await tx.user.update({
    where: { id: userId },
    data: { name: 'Updated name' },
  });
  await auditService.log({
    action: 'user.name.changed',
    targetType: 'User',
    targetId: user.id,
    metadata: { reason: 'Support request' },
  }, tx);
});
```

Let errors from `log()` propagate out of the transaction callback, as above. If the caller catches
a JavaScript actor-policy error, a normal Prisma transaction can still commit its other business
changes without a manual event. Manual `log()` does not mark the automatic helper as failed, even
when passed that helper's `tx`; it does not track or force rollback of arbitrary transactions.

This example uses the base client for the business mutation, so it produces the manual event only.
To record automatic diffs as well, perform the mutation inside the audited client's
`withAuditTransaction()` and pass its `tx` to `log()`.

Manual `log()` writes explicitly requested events even in a `@NoAudit()` handler. `@AuditAction()`
does not replace `input.action`. Manual metadata fields are redacted using the module's
`sensitiveFields` and the `sensitiveFieldsByModel` entry for `input.targetType`.

The 0.8.0 `strictManualValidation` and `maxMetadataBytes` options are opt-in. Invalid strict inputs
or oversized final metadata throw `AuditInputError` with `code` and `field`; see the
[validation contract](product-quality.md#validate-manual-events-without-changing-existing-defaults).

## AuditService.query(options)

Returns `Promise<AuditQueryResult>`, newest first by `(created_at, id)`. Supported on PostgreSQL
and, from 0.8.0, SQL Server. SQL Server text comparisons use exact binary semantics and cursors
preserve `DATETIME2(7)` precision; see [SQL Server history](product-quality.md#read-sql-server-history).

| Option | Default | Meaning |
|---|---|---|
| `actorId`, `actorType` | — | Exact actor filters |
| `targetType`, `targetId` | — | Exact target filters |
| `action` | — | Case-sensitive action; `*` is a wildcard, while SQL `%` and `_` are escaped |
| `source` | — | `'auto'` or `'manual'` |
| `result` | — | `'success'` or `'failure'` |
| `from`, `to` | — | Inclusive date bounds on `created_at` |
| `limit` | `50` | Positive integer page size |
| `offset` | `0` | Non-negative offset; cannot be combined with `cursor` |
| `cursor` | — | Opaque position returned as `nextCursor`; keep the same filters between pages |
| `includeTotal` | `true` | Include a matching-row count; `false` avoids the count query (`COUNT_BIG` on SQL Server) |
| `tenantId`, `allTenants` | Ambient tenant | Mutually exclusive explicit scope; see [tenant rules](context-and-tenancy.md#tenant-resolution-and-scope) |

Result fields are `entries: AuditEntry[]`, `nextCursor: string | null`, `hasMore: boolean`, and
optional `total: number`. The last page has `nextCursor: null`. The count covers the matching filter
set, not just the cursor's remaining rows. Under concurrent writes, the count and page queries are
separate statements and need not describe one database snapshot.
SQL Server counts above JavaScript's safe integer range reject rather than losing precision.

An `AuditEntry` contains `id`, nullable `tenantId`, nullable `actorId`, `actorType`, nullable `actorIp`,
`action`, nullable `targetType`/`targetId`, `source`, nullable `changes`/`metadata`, `result`, and
`createdAt: Date`. `changes` maps field names to `{ before?, after? }` values.

`getById(id, { tenantId?, allTenants? }?)` returns `Promise<AuditEntry | null>` with the same tenant
rules. Invalid UUIDs return `null`.

## Additional APIs

- [Actor context, metadata, and decorators](context-and-tenancy.md)
- [Transaction options, bulk behavior, and soft-delete integration](transactions.md)
- [Schema utilities and `prune()`](storage-and-retention.md)
- [`scan()`, `exportCsv()`, stream runners, sinks, and stores](export-and-streams.md)
