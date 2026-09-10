# Audit log API reference

Applies to the current checkout (`0.6.0`). Start with the [README](../README.md);
see [CHANGELOG](../CHANGELOG.md) for version changes.

## Entry points

Import runtime APIs and types from `@nestarc/audit-log`. The package ships its declaration files;
use them for the complete current signatures.

| Entry point | Purpose |
|---|---|
| `AuditLogModule.forRoot(options)` | Register synchronous NestJS options and export `AuditService` |
| `AuditLogModule.forRootAsync({ imports?, inject?, useFactory })` | Register a factory that returns options or a promise of options |
| `createAuditedClient(basePrisma, options)` | Extend a base client and preserve the typed transaction callback/result |
| `basePrisma.$extends(createAuditExtension(options))` | Compose the audit extension explicitly with other Prisma extensions |
| `client.withAuditTransaction(callback, options?)` | Run supported automatic writes and audit work on the same interactive transaction |
| `client.getAuditCapabilities()` | Inspect `{ consistency, atomicLifecycle }` for extension integrations |

Module and extension configuration are independent: nothing merges them at runtime. For example,
setting `tenantRequired` or `sensitiveFields` on the module does not configure automatic tracking.
Pass shared values to both registration sites as shown in the [Quick Start](../README.md#quick-start).
For custom table names, also pass the same value to schema and partition utilities.

## Module options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prisma` | `PrismaClient` | *required* | Base Prisma client for audit storage |
| `actorExtractor` | `(req) => AuditActor \| Promise<AuditActor>` | *required* | Extracts actor from HTTP request |
| `actorExtractionStage` | `'middleware' \| 'interceptor'` | `'middleware'` | Added in 0.6.0: choose `interceptor` for identity populated by authentication Guards; [actor timing](context-and-tenancy.md#http-actor-extraction) |
| `tenantRequired` | `boolean` | `false` | When `true`, `log()` requires tenant context; `query()`/`getById()` require it unless explicit `tenantId` or `allTenants` is supplied |
| `excludeRoutes` | `RouteInfo[]` | `[]` | Routes excluded from `AuditActorMiddleware` |
| `registerGlobalInterceptor` | `boolean` | `true` | Set `false` to bind `AuditInterceptor` manually |
| `correlationIdHeader` | `string` | `x-request-id` | Header copied into `metadata.correlationId` |
| `correlationIdGetter` | `(req) => string \| undefined` | — | Custom correlation ID source |
| `tableName` | `string` | `audit_logs` | Audit table name used by module-side log/query/prune APIs |
| `tenantResolver` | `() => string \| null` | — | Replaces the optional `@nestarc/tenancy` lookup; returning `null` does not fall back |
| `sensitiveFields` | `string[]` | `[]` | Metadata keys redacted recursively in objects and arrays for manual logs |
| `sensitiveFieldsByModel` | `Record<string, string[]>` | `{}` | Model-specific metadata redaction keys |
| `onAuditError` | `(error: unknown, ctx: AuditErrorContext) => void` | — | Reports actor-context extraction errors; not every service error uses this hook |
| `logger` | `AuditLogger` | `console` | Minimal `warn(message)` / `error(message)` logger |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |

## Prisma extension options

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
| `logger` | `AuditLogger` | `console` | Minimal `warn(message)` / `error(message)` logger |
| `logFailures` | `boolean` | `false` | Record best-effort failure audit rows for business write errors |
| `ignoreTimestampOnlyUpdates` | `boolean` | `false` | Suppress `@updatedAt`-only update entries |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |

When neither `trackedModels` nor `ignoredModels` is configured, `createAuditExtension()` audits all Prisma models and emits a one-time `No trackedModels/ignoredModels configured` warning. Set `trackedModels` as an allowlist or `ignoredModels` as a denylist to narrow scope.

## AuditService.log(input, tx?)

Returns `Promise<void>`. The required input field is `action`; optional fields are `targetType`,
`targetId`, `metadata`, and `result` (`'success'` by default, or `'failure'`). `source` is always
`'manual'`. The actor and context metadata come from `AuditContext`; tenant lookup uses the module
configuration. Without actor context, rows use `actorId: null` and `actorType: 'system'`.

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

This example uses the base client for the business mutation, so it produces the manual event only.
To record automatic diffs as well, perform the mutation inside the audited client's
`withAuditTransaction()` and pass its `tx` to `log()`.

Manual `log()` writes explicitly requested events even in a `@NoAudit()` handler. `@AuditAction()`
does not replace `input.action`. Manual metadata fields are redacted using the module's
`sensitiveFields` and the `sensitiveFieldsByModel` entry for `input.targetType`.

## AuditService.query(options)

Returns `Promise<AuditQueryResult>`, newest first by `(created_at, id)`.

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
| `includeTotal` | `true` | Include a matching-row count; `false` avoids `COUNT(*)` |
| `tenantId`, `allTenants` | Ambient tenant | Mutually exclusive explicit scope; see [tenant rules](context-and-tenancy.md#tenant-resolution-and-scope) |

Result fields are `entries: AuditEntry[]`, `nextCursor: string | null`, `hasMore: boolean`, and
optional `total: number`. The last page has `nextCursor: null`. The count covers the matching filter
set, not just the cursor's remaining rows. Under concurrent writes, the count and page queries are
separate statements and need not describe one database snapshot.

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
