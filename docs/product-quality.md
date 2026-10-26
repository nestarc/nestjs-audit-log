# Product quality APIs in 0.8.0

These APIs are introduced in release target `@nestarc/audit-log@0.8.0`; they are absent from 0.7.1.
This guide does not establish registry publication. Until the release is available, use the
[candidate installation procedure](maintaining.md#candidate-documentation-example) and record
the source commit and tarball integrity. See the [0.8.0 release notes](releases/0.8.0.md) and
[CHANGELOG](../CHANGELOG.md) for the release scope.

The packed documentation consumer runs the separate
[product-quality smoke](../examples/quick-start/product-quality/consumer-smoke.ts), including
generated Prisma typing checks, against the installed 0.8.0 artifact.

The additions make manual transactions harder to misuse, validate event quality before insertion,
and let SQL Server applications investigate their records. Caller-owned transactions can continue
using `log(input, tx?)`; see the [SQL Server example](../examples/sql-server-quick-start/README.md).

## Own the manual transaction

Use the injected `AuditService` and your application's **base** Prisma client:

```typescript
const invoice = await audit.withManualTransaction(base, async ({ tx, log }) => {
  const created = await tx.invoice.create({ data: invoiceData });
  await log({
    action: 'invoice.created', targetType: 'Invoice', targetId: created.id,
    metadata: { reason: 'Customer order' },
  });
  return created;
}, { maxWait: 5_000, timeout: 10_000 });
```

The helper creates an official Prisma interactive transaction and binds `log` to that transaction.
The callback retains the generated model argument and result types. A logging failure marks the
transaction as failed even when the callback catches it; the helper rejects and rolls back earlier
business and audit writes. A callback error also rolls back and remains the thrown error.

Await each `log` for correct sequencing and local error handling. Before committing, the helper
waits for log calls already started by the callback. It revokes the writer when the callback ends
or the transaction aborts. A timer or detached task that starts a new call after callback completion
is rejected; do not pass the writer to background work. Nested managed manual transactions are
rejected, including calls through another service/client while the first helper is active.

Every business write must use the supplied `tx`. The helper cannot enlist writes through a captured
base client or prove that the application remembered to call `log`. It owns a new transaction;
to add an event to a caller-owned transaction, keep `audit.log(input, tx)` and propagate its errors.
The helper supports PostgreSQL and SQL Server; it does not enable SQL Server automatic tracking.

`maxWait` and `timeout` must be positive safe integers in milliseconds. Optional `isolationLevel`
accepts `ReadUncommitted`, `ReadCommitted`, `RepeatableRead`, `Snapshot`, or `Serializable`; choose
a level supported by the installed Prisma version, adapter, and database configuration. In the
pinned Prisma 7.10.0 SQL Server tuple, requesting `Snapshot` is rejected before the callback runs.
The helper does not retry or fall back to a different isolation level.

## Validate manual events without changing existing defaults

Opt into the stricter contract through the factory's **module** section:

```typescript
const config = defineAuditConfig({
  shared: {
    provider: 'sqlserver',
    tableName: 'dbo.audit_logs',
    prismaModule: { Prisma },
    actorRequired: true,
    tenantRequired: true,
    tenantResolver,
    sensitiveFields: ['password', 'token'],
  },
  module: {
    actorExtractor,
    actorExtractionStage: 'interceptor',
    strictManualValidation: true,
    maxMetadataBytes: 64 * 1024,
  },
});
```

`strictManualValidation` defaults to `false`. When enabled, the action and supplied target identifiers
must be non-blank strings, `result` must be `success` or `failure`, and metadata must be a plain
object with JSON-compatible contents. Actor/tenant values, when present or required, must also be
non-blank strings. Values are validated without trimming the stored identity.

Validation rejects circular references, non-finite numbers, `BigInt`, functions, `undefined` values,
sparse arrays, accessors, custom object instances inside metadata, and other values JSON would
silently lose. Ordinary valid `Date` values retain JSON's ISO serialization. Shared object references
are allowed; nesting deeper than 64 is rejected. Event DTO instances are allowed, but their metadata
must satisfy the JSON contract. Raw event metadata and context metadata are checked before merging,
and the merged value is checked again; a merge cannot silently remove an invalid input value.

`maxMetadataBytes` is independent of strict validation and must be a positive safe integer. It
measures the **final redacted JSON in UTF-8 bytes**, including merged context metadata. It rejects an
oversized value before INSERT rather than truncating evidence. The 64 KiB value above is an example
application budget, not a package default or performance guarantee.

Input and size failures throw `AuditInputError` with `code` (`AUDIT_INPUT_INVALID` or
`AUDIT_METADATA_TOO_LARGE`) and `field`. Messages identify the field without including its value.
Inside `withManualTransaction`, these failures also prevent commit if caught by the callback.

## Observe failures and transaction outcomes

An explicitly configured `onAuditError(error, context)` receives rejected manual validation,
context, tenant-resolution, serialization, and INSERT failures. The context includes `provider`,
`phase`, `code`, and `durationMs`. The original error is still thrown. Hook failures do not replace
the error or change transaction control flow.

Use `onAuditOperation` for counters and latency measurements without event contents:

```typescript
module: {
  actorExtractor,
  onAuditOperation: event => {
    metrics.recordAuditOperation({
      provider: event.provider,
      operation: event.operation,
      status: event.status,
      transaction: event.transaction,
      durationMs: event.durationMs,
      code: event.code,
    });
  },
}
```

The callback receives only provider, operation (`log` or `transaction`), status, duration, transaction
kind, and optional failure phase/code. It contains no actor/tenant/target identifiers, metadata,
SQL, or raw error. Synchronous throws and rejected observer promises do not change the operation.
`onAuditError` remains the detailed diagnostic hook and receives the original error; apply your
application's filtering before forwarding that information to logs or telemetry.

A successful `log` event reports **INSERT completion**, not transaction commit. A later business
error can still roll it back. Its transaction kind is `external` when a `tx` was supplied and
`standalone` otherwise. `withManualTransaction` emits a separate `transaction: 'managed'` outcome
after the host transaction resolves or rejects. That failure may come from business logic, the
database, or audit work; it is not automatically an audit INSERT failure.

## Discover provider capabilities

`audit.getCapabilities()` returns a frozen provider capability object without database I/O:

| Capability | PostgreSQL | SQL Server |
|---|---|---|
| `manualLogging`, `manualTransactions`, `query` | Yes | Yes |
| `automaticTracking` | Yes | No |
| `scan`, `exportCsv`, `retention` | Yes | No |
| `schemaInspection`, `readIndexes` | No | Yes |

These flags describe the library's APIs for the configured provider. They do not verify the live
schema, credentials, connection, or whether an automatic extension has been installed. The existing
audited client's `getAuditCapabilities()` continues to describe its consistency/lifecycle contract.

## Read SQL Server history

Version 0.8.0 supports the existing `audit.query()` and `audit.getById()` API on SQL Server:

```typescript
// Authenticate the caller and authorize this tenant before selecting the scope.
const page = await audit.query({
  tenantId: authorizedTenantId,
  targetType: 'Invoice',
  targetId: invoiceId,
  limit: 50,
  includeTotal: false,
});
const nextPage = page.nextCursor
  ? await audit.query({
      tenantId: authorizedTenantId, targetType: 'Invoice', targetId: invoiceId,
      limit: 50, includeTotal: false, cursor: page.nextCursor,
    })
  : null;
```

The existing actor, action/wildcard, target, source, result, time, and tenant filters apply.
Explicit `tenantId` and `allTenants` remain mutually exclusive, and tenant selection is not
authorization. SQL Server exact text filters use `Latin1_General_100_BIN2` comparisons plus equal
byte lengths: case, accents, and trailing spaces are significant regardless of the database's
default collation. Action wildcard matching also uses that binary collation. Stored identifiers
are neither trimmed nor truncated.

Results include parsed `metadata`/`changes` and UTC `createdAt` dates. Cursor tokens retain SQL
Server's `DATETIME2(7)` precision even though JavaScript `Date` exposes milliseconds. Treat tokens
as opaque, keep filters unchanged, and do not reuse a PostgreSQL cursor on SQL Server or vice versa.
Ordering uses the database's timestamp and `UNIQUEIDENTIFIER` order.

`includeTotal` defaults to `true`, which uses `COUNT_BIG`; `false` avoids the count. Counts larger
than JavaScript's safe integer range reject rather than losing precision. Offset and cursor cannot
be combined. These are request/response history pages, not a stable export snapshot: concurrent
writes may change subsequent results, and count/page queries do not share a promised snapshot.
SQL Server `scan`, export, retention, and automatic tracking remain unsupported.

## Inspect storage before a deployment

```typescript
const inspection = await inspectSqlServerAuditStorage(diagnosticClient, {
  tableName: config.schemaOptions.tableName,
});
```

This is a read-only catalog inspection. Use a diagnostic or installer identity with object
`VIEW DEFINITION` for complete metadata; the runtime logger can keep its narrower INSERT grant.
The result includes table name, status, `metadataComplete`, columns, indexes, triggers, constraints,
session compatibility, and structured `issues` with a code, optional object name, and explanation.

`status: 'missing'` is reported only when the effective database owner can prove absence. A limited
identity that cannot distinguish absence from hidden metadata receives `unavailable`; an existing
table with incomplete visibility may be `inspected` with `metadataComplete: false`. Treat these as
diagnostic outcomes, not as proof that the storage is healthy. `enforcementVerified` is always
`false`: enabled trigger metadata cannot prove that a trigger's body prevents mutations. Keep the
real commit/rollback and permission smoke in deployment validation.

`readIndexSessionCompatible` describes the inspected connection only. An inspection failure may
include an original `cause`; avoid forwarding raw causes or connection errors without filtering.

## Add read indexes explicitly

Run `applySqlServerAuditReadIndexes(installer, { tableName })` only as an intentional migration.
`getSqlServerAuditReadIndexStatements({ tableName })` returns the separate executable batches for
your migration tooling. First install the compatible audit table with `applyAuditTableSchema()`.

The additive migration keeps original `NVARCHAR(MAX)` values and adds four computed
`NVARCHAR(128)` prefix columns using `Latin1_General_100_BIN2`, plus tenant/time, tenant/target/time,
and tenant/actor/time indexes.
Queries retain full-value equality alongside prefix predicates, so two long identifiers with the
same prefix are not treated as equal. The indexes are optional; reads work without them. Index
selection and latency depend on the actual workload and database plan.

Indexed computed columns require compatible SQL Server session settings on **every writer**:
`ANSI_NULLS`, `ANSI_PADDING`, `ANSI_WARNINGS`, `ARITHABORT`, `CONCAT_NULL_YIELDS_NULL`, and
`QUOTED_IDENTIFIER` ON, with `NUMERIC_ROUNDABORT` OFF. At compatibility level 90 or later,
`ANSI_WARNINGS ON` also implies effective `ARITHABORT ON`. The installer configures its own
connections only; check the application's pooled connections before enabling these indexes.

Batches run sequentially without an encompassing transaction. Reapplication validates existing
computed columns and same-named indexes instead of silently replacing an incompatible object.
A later failure can leave earlier additions installed. Review the reported issue and finish the
migration before enabling application writes. Measure write overhead, query latency, and plan
behavior using the intended data distribution; the migration does not establish a latency SLA.
