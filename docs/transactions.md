# Automatic tracking and transaction contracts

Documents version `0.7.1`, including the returning-operation guard described below.
Start with the [README](../README.md); see [CHANGELOG](../CHANGELOG.md) for version changes.
The guard was added in 0.7.0 and is not part of the 0.6.0 release.

Automatic tracking in this guide is PostgreSQL-specific. For SQL Server manual events on the
business transaction, use the [SQL Server guide](sql-server.md#commit-the-event-with-the-business-write).

## Scope of automatic tracking

Automatic records cover supported operations invoked through the audited Prisma client. Writes
through the base client, raw SQL, unsupported Prisma operations, database-side cascades/triggers,
and intentionally skipped `@NoAudit()` paths are outside that coverage. An atomic record guarantees
that its supported business mutation and audit work share a transaction; it does not discover every
change made elsewhere in the database.

The snippets below assume the base client, generated `{ Prisma }` namespace (`prismaModule`), and
application model inputs are already available from the [Quick Start](../README.md#quick-start).
Use `createAuditedClient(basePrisma, options)` for the typed helper API, or
`basePrisma.$extends(createAuditExtension(options))` when composing extensions.

## Nested writes

Nested relation mutations are not synthesized into child audit rows. In `atomic-required`, a nested
`create`, `connect`, `connectOrCreate`, `disconnect`, `update`, `upsert`, `delete`, `set`, or
corresponding `*Many` operation targeting a tracked related model is rejected before the business
query. Express it as explicit related-model writes inside `withAuditTransaction()` so each record
receives its own audit row.

The extension checks nested mutation data recursively, including when the top-level or an
intermediate model is excluded from tracking. An excluded relation may contain a deeper mutation
that reaches a tracked model. A relation whose target and nested mutation targets are all excluded
does not trigger the guard when public Prisma DMMF relation metadata is available. If that metadata
is unavailable, the atomic path fails conservatively. These recursive exclusion checks are corrected
in 0.6.0; see [CHANGELOG](../CHANGELOG.md).

`best-effort` preserves the business mutation and warns about unsupported nested tracking.
It supplies no child-record evidence for those changes. `@NoAudit()` remains an intentional bypass.

## Transaction model

| Path | Business write | Audit insert |
|------|----------------|--------------|
| `atomic-required` + `withAuditTransaction()` | Same official Prisma interactive `tx` | Same `tx`; audit read/insert failure rolls back the business mutation |
| Supported tracked operation in `atomic-required` outside the helper | Rejected before execution | Not attempted |
| Explicit `best-effort` | Uses Prisma's `query(args)`, so the business write remains in the caller `$transaction` | Independent base-client insert; does not join the caller transaction |
| Manual logging with `AuditService.log(input, tx)` | Caller-controlled | Participates in the provided transaction |
| Manual logging with `AuditService.log(input)` | Caller-controlled | Independent write via the base client |

Use the transaction-first API to commit supported automatic records with their business writes:

```typescript
import { createAuditedClient } from '@nestarc/audit-log';

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
fail-closed. A supported tracked mutation outside the helper throws before its business query runs.
The helper also rejects completion after an audit failure even if the callback
catches that failure; catching it cannot commit earlier business writes without their audit work.
This is corrected in 0.6.0. Recoverable business exceptions remain caller-controlled.
HTTP actor-extractor failures are a separate context setup path: they are reported and continue
with a null actor, as described in [actor extraction](context-and-tenancy.md#http-actor-extraction).
With `actorRequired: true` (added in 0.7.0), reaching a tracked automatic write with an invalid
actor rejects before its business query and marks an active atomic helper as failed. Catching
that policy error cannot commit earlier writes. Explicit manual `log()` rejects before INSERT,
but does not mark the helper or an external transaction as failed: callers must propagate its
error to roll back. See [manual logging](api-reference.md#auditserviceloginput-tx).
`withAuditLifecycle()` is available only when the extension uses `atomic-required`; best-effort
clients reject before the lifecycle callback runs. Integrations can verify this contract through
`getAuditCapabilities()`, which reports the configured consistency and atomic lifecycle support.
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

Array transactions remain outside the atomic contract. In `atomic-required`, tracked operations
created outside `withAuditTransaction()` fail at the generic public helper guard before the business
query. Use sequential mutations inside `withAuditTransaction()` instead.
`AuditService.log(input, tx)` remains the stable manual event path.

## Migrating from `experimentalTxAudit` in v0.5.0

`experimentalTxAudit` was removed in v0.5.0; v0.4.1 is the last release that accepts the option.
For authoritative automatic records, switch to `consistency: 'atomic-required'` and execute tracked
mutations through `withAuditTransaction()`. If non-atomic automatic records are intentional, remove
the legacy key and keep `consistency: 'best-effort'` explicit. During the v0.5.x migration window,
JavaScript or `any` options that retain their own `experimentalTxAudit` key, including `false`, fail
fast instead of silently downgrading. See the
[removal ADR](https://github.com/nestarc/nestjs-audit-log/blob/main/docs/2026-08-28-experimental-tx-audit-removal-adr.md)
for before-and-after examples and the manual transaction alternative.

## Bulk mutation contract

| Operation | `atomic-required` | `best-effort` |
|-----------|-------------------|---------------|
| `createMany` | Rejected before mutation because Prisma only returns count-level evidence | One `Model.createdMany` summary row |
| `updateMany` | Rejected before mutation because exact record before/after diffs are unavailable | One `Model.updatedMany` summary row |
| `deleteMany` | Locks and refreshes at most `maxBatchRecords` preimages, then writes one `Model.deleted` row per deleted record in the same transaction | Writes record rows up to the cap; overflow rejects unless `batchOverflow: 'summary'` is explicitly selected |
| `createManyAndReturn` / `updateManyAndReturn` (guard added in 0.7.0) | Tracked models rejected before mutation, inside or outside the helper; catching the error still rejects helper completion | Business query and result/error preserved; no automatic audit row; warning once per model/operation per extension instance |

The returning-operation guard respects excluded models and `@NoAudit()`. Best-effort warnings use
the configured logger (or console), contain the model, operation, and single-record alternative,
and never include request data. Logger failures do not affect the business query. On Prisma peers
without these APIs, extension creation and existing operations continue to work. This is a guard
for these two known APIs, not detection of every future Prisma API or writes through other clients.

Summary rows are deliberately not shaped like record evidence: `targetId` is `null`, `changes` is
empty, and metadata contains `auditKind: 'summary'`, the exact `operation`, `recordCount`, and
`recordsAudited: false`. Per-record `deleteMany` rows keep the singular `Model.deleted` action and
include `auditKind: 'record'`, `operation: 'deleteMany'`, and `batchSize` metadata.

The default overflow policy is fail-closed. Best-effort callers that explicitly choose summary
overflow receive one `Model.deletedMany` row with `overflow: true` and `maxBatchRecords`; it is a
batch activity marker, not evidence of which rows were deleted. In atomic mode, a cap overflow,
preimage/affected-count mismatch, or any audit insert failure rolls back the entire `deleteMany`.

<a id="migrating-from-06-to-07-unreleased"></a>

## Migrating from 0.6 to 0.7

`actorRequired` is opt-in and defaults to `false`. Before enabling it on module and extension
options, provide non-blank IDs for HTTP users, system workers, and API keys. Guard-based identity
requires `actorExtractionStage: 'interceptor'`; workers can use `AuditContext.runAs()` and must
establish tenant context separately. In best-effort, invalid actors preserve business writes but
omit audit rows. Reads remain unaffected. See the [actor policy](context-and-tenancy.md#requiring-an-identifiable-actor).


In 0.6.0, `createManyAndReturn` and `updateManyAndReturn` could execute without an automatic audit
record in either consistency mode. Version 0.7.0 rejects both for tracked models in
`atomic-required`, before the business query. If a callback catches this policy error,
`withAuditTransaction()` still rejects and rolls back all earlier business writes and audit rows.
This behavior change shipped in 0.7.0; it is not part of the 0.6.x release line.

Replace these calls with sequential `create()` or `update()` calls inside `withAuditTransaction()`.
For example, replace `tx.user.createManyAndReturn({ data: users })` with:

```typescript
const created = await prisma.withAuditTransaction(async (tx) => {
  const records = [];
  for (const data of users) {
    records.push(await tx.user.create({ data }));
  }
  return records;
});
```

For updates, use explicit record IDs and single-record `update()` calls. Alternatively, keep a base
client transaction and call `AuditService.log(input, tx)` for a manual business event, propagating
errors out of the callback. That event contains the evidence you supply; it does not generate
automatic record before/after values. Best-effort retains the original business behavior with a
new warning and no automatic record for these APIs; it is not an equivalent atomic migration path.
Existing `createMany`, `updateMany`, nested-write, and soft-delete lifecycle contracts are unchanged.
No schema migration is required for this guard.

## Atomic soft-delete lifecycle integration

`@nestarc/soft-delete` can route rewritten lifecycle mutations through the same official transaction.
Apply extensions in the fixed order tenancy → audit-log → soft-delete. The integration fragment
below assumes those packages' extension factories, `tenancyService`, and the public DMMF supplied
as `prismaDmmf` are initialized according to their documentation. Install the [tested package tuple](../README.md#tested-ecosystem-versions)
when reproducing the release fixture:

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

The [consumer-owned fixture](https://github.com/nestarc/nestjs-audit-log/blob/main/fixtures/published-ecosystem/test/ecosystem.e2e.cjs) contains the full
integration setup and assertions. See [maintaining](maintaining.md#published-ecosystem-release-gate)
for the published tuple and packed-candidate verification process.
