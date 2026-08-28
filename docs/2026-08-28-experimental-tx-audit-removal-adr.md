# ADR: Remove `experimentalTxAudit` in v0.5.0

- Status: Accepted
- Decision date: 2026-08-28
- Target release: `0.5.0`
- Last release accepting the option: `0.4.1`
- Implementation task: `ALOG-M10`

## Context

`experimentalTxAudit` was introduced in v0.2.0 as an opt-in compatibility probe with an explicit
"no semver guarantee". It reads Prisma's undocumented `__internalParams.transaction` value and calls
the private `_createItxClient()` method. If the private capability is absent, changes shape, or throws,
the extension warns at most once and falls back to the base client. That fallback can leave orphan
success rows after rollback and can produce empty or stale transaction-local diffs.

v0.4.0 deprecated the option and added the stable transaction-first path:

- `createAuditedClient()` and `withAuditTransaction()` bind the official Prisma interactive
  transaction client through `AsyncLocalStorage`;
- `consistency: 'atomic-required'` fails closed and never silently falls back to the base client;
- `AuditService.log(input, tx)` remains the stable manual transaction path; and
- explicit `consistency: 'best-effort'` preserves non-atomic legacy behavior without claiming
  transaction participation.

The `ALOG-M06` release gate proves the stable path with the published tenancy `0.15.0`, audit-log
`0.4.1`, and soft-delete `0.7.0` tuple, and with a packed audit-log candidate. It covers atomic
commit, rollback, and lifecycle integration without using `experimentalTxAudit`. This is evidence
that the replacement works; it is not evidence that no external consumer still uses the deprecated
option.

Keeping the compatibility probe would continue coupling every mutation handler to private Prisma
arguments and would make Prisma-major compatibility and handler extraction more expensive.

## Decision

### Removal release and semver policy

`experimentalTxAudit` will be removed as an accepted option in `0.5.0`. Version `0.4.1` is the last
release that accepts it.

Although the option was explicitly experimental, it is present in the exported
`AuditExtensionOptions` type and changes runtime routing. Removing it can break TypeScript builds and
can change JavaScript behavior, so it will not ship in a `0.4.x` patch. This project is pre-1.0 and
uses the next minor for intentional breaking changes; `0.5.0` is already reserved for the Node.js
support-range change.

The v0.4.0 and v0.4.1 line provides the deprecation window. No additional deprecation-only release is
required.

### Contracts that remain

Both public consistency modes remain:

| Need | Supported path after removal | Contract |
|---|---|---|
| Authoritative automatic audit rows | `consistency: 'atomic-required'` plus `withAuditTransaction()` | Business mutation, audit reads, and audit insert share the official Prisma transaction and fail closed |
| Intentionally non-atomic automatic tracking | explicit `consistency: 'best-effort'` | Audit work uses the base client and may leave orphan rows or stale diffs around caller transactions |
| Caller-defined manual event | `AuditService.log(input, tx)` | The manual audit insert participates in the supplied transaction |

The `best-effort` mode itself is not deprecated or removed. It will not inherit the private
transaction-routing behavior.

### Runtime migration guard

Removing only the TypeScript property would let JavaScript, `any`, or spread-based configuration pass
the old key and have it silently ignored as ordinary best-effort behavior. That is an unsafe
atomicity downgrade.

During the `0.5.x` line, `createAuditExtension()` and `createAuditedClient()` will therefore reject an
options object that has its own `experimentalTxAudit` property, including `false`, with an error that
points to this migration. This tombstone is not a supported option and performs no private routing.
It may be removed in a later breaking release after the `0.5.x` migration window.

### Private array-transaction diagnostic

`__internalParams` is also used to distinguish array `$transaction([...])` calls and produce an
array-specific error. `ALOG-M10` will remove that private dependency completely.

Array transactions in `atomic-required` will remain outside the supported contract and will still
fail before the first business query because no `withAuditTransaction()` context exists. The error
will converge on the public guard requiring `withAuditTransaction()` rather than claiming that the
library privately detected an array transaction. The zero-business-write and zero-audit-write
PostgreSQL regression remains required.

## Migration

### Authoritative automatic tracking

Do not merely delete the option or change `consistency`. Move tracked mutations to the official
helper.

Before:

```typescript
const prisma = basePrisma.$extends(
  createAuditExtension({
    consistency: 'best-effort',
    experimentalTxAudit: true,
    trackedModels: ['User', 'Invoice'],
    prismaModule,
  }),
);

await prisma.$transaction(async (tx) => {
  await tx.user.update({ where: { id }, data: { name: 'After' } });
});
```

After:

```typescript
const prisma = createAuditedClient(basePrisma, {
  consistency: 'atomic-required',
  trackedModels: ['User', 'Invoice'],
  prismaModule,
});

await prisma.withAuditTransaction(async (tx) => {
  await tx.user.update({ where: { id }, data: { name: 'After' } });
});
```

The atomic path intentionally rejects tracked writes outside the helper. It also keeps the existing
boundaries for array transactions, count-only `createMany`/`updateMany`, and tracked nested writes.
Mapped models may require `databaseMapping`; consult the active README before switching modes.

### Intentionally retain best-effort behavior

If non-atomic automatic records are acceptable, remove the deprecated key and keep the mode explicit:

```typescript
const prisma = basePrisma.$extends(
  createAuditExtension({
    consistency: 'best-effort',
    trackedModels: ['User'],
    prismaModule,
  }),
);
```

This is not a transaction-atomic replacement. A caller transaction can roll back while its automatic
audit row remains committed.

### Manual events in a caller-owned transaction

```typescript
await basePrisma.$transaction(async (tx) => {
  const user = await tx.user.update({
    where: { id },
    data: { name: 'After' },
  });

  await auditService.log(
    { action: 'User.renamed', targetType: 'User', targetId: user.id },
    tx,
  );
});
```

## `ALOG-M10` implementation inventory

### Production source

`src/prisma/audit-extension.ts` will:

- remove `AuditExtensionOptions.experimentalTxAudit` from the public type;
- remove `txAuditUnavailableWarned`, `_resetTxAuditWarning()`, and `warnTxAuditUnavailable()`;
- remove the private `_createItxClient()` branch and silent fallback from `resolveAuditClient()`;
- remove the atomic/experimental combination validation;
- remove `__internalParams` destructuring and forwarding from `create`, `update`, `delete`, `upsert`,
  `createMany`, `updateMany`, and `deleteMany`;
- remove `ATOMIC_ARRAY_TRANSACTION_ERROR` and its private batch-kind branch while preserving the
  generic pre-query atomic guard; and
- add only the fail-fast `0.5.x` migration tombstone described above.

The stable transaction `AsyncLocalStorage`, `withAuditTransaction()`, `atomic-required`, and
`best-effort` paths remain.

### Tests

- Delete the two experimental routing/fallback unit cases and their warning-reset setup from
  `test/audit-extension-queries.spec.ts`.
- Replace the private-parameter array diagnostic unit case with a generic outside-helper fail-closed
  assertion.
- Delete `test/e2e/transactions-experimental.e2e-spec.ts`; its three private-routing scenarios are
  superseded by the stable atomic suites.
- Keep the explicit best-effort transaction characterization in `test/e2e/transactions.e2e-spec.ts`.
- Keep the PostgreSQL array-transaction zero-write regression in
  `test/e2e/phase3-bulk-atomic.e2e-spec.ts`, but assert the public helper guidance.
- Replace the positive option type test in `test/public-api.spec.ts` with a negative compile contract,
  and add a runtime tombstone regression for JavaScript-shaped options.
- Update `test/docs.spec.ts` to check the active removal/migration contract instead of current option
  availability. Preserve the historical v0.2.0 release-note assertion.

### Documentation and release gates

- Remove the option row and deprecated-current-contract sentence from the active README, and add a
  v0.5.0 migration note linking to this ADR.
- Keep the v0.2.0 addition and v0.4.0 deprecation entries in `CHANGELOG.md` as immutable release
  history. Add the removal and migration path under `Unreleased`.
- Keep historical v0.2.0 specs, the v0.1.0 disposition, and the superseded 2026-08-20 plan unchanged;
  their mentions describe released behavior.
- Classify the final inventory search results: active source may contain only the intentional runtime
  tombstone; active source and tests must not contain `_createItxClient` or `__internalParams`;
  historical docs, this ADR, and historical changelog entries remain.
- Require lint, typecheck, coverage, build, full PostgreSQL E2E, the packed-candidate ecosystem gate,
  and the Prisma 5/6/7 peer matrix on the same removal change before `ALOG-M10` is complete.

## Consequences

- The only automatic transaction-atomic path uses public Prisma APIs and fails closed.
- JavaScript and untyped consumers receive an actionable migration error instead of a silent
  downgrade.
- `best-effort` users that never enabled the option keep their existing contract.
- The array-transaction error becomes less specific, but its fail-before-mutation safety property is
  preserved without private coupling.
- The active mutation handlers no longer depend on undocumented transaction callback arguments,
  reducing Prisma-major compatibility and later refactoring cost.
