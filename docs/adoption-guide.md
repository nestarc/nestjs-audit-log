# Adopt audit logging one workflow at a time

The baseline recipes here use **published `@nestarc/audit-log@0.6.0`**, verified against npm on
2026-09-29. The current checkout also contains **0.7.0 Unreleased** changes with package version
0.7.0; the candidate has not been published. See [CHANGELOG](../CHANGELOG.md).
`actorRequired` and `defineAuditConfig()` are candidate-only APIs. Do not install `@0.7.0` yet.

Start with an existing NestJS + Prisma + PostgreSQL application. Choose one business event when
rewriting existing transactions is costly, or one model when you need automatic field diffs.
The [Quick Start](../README.md#quick-start) covers pinned installation, Prisma generation, and DDL.
The [runnable example](../examples/quick-start/README.md) includes both paths and their assertions.

## Start with a manual business event

Keep your existing base Prisma client and ordinary `$transaction()`. No automatic extension or
`withAuditTransaction()` is needed. Register `AuditLogModule` with the base client, generated
`{ Prisma }` namespace, a table name, masking and tenant options. Create that same audit table in a
migration/setup step. For HTTP, extract the actor after your authentication Guard:

```typescript
// Nest module imports; base, Prisma and tenantScope belong to your application.
AuditLogModule.forRoot({
  prisma: base,
  prismaModule: { Prisma },
  tableName: 'audit_logs',
  sensitiveFields: ['password'],
  tenantRequired: true,
  tenantResolver: () => tenantScope.getStore()?.tenantId ?? null,
  actorExtractionStage: 'interceptor',
  actorExtractor: req => ({ id: req.user?.id ?? null, type: 'user' }),
});
```

First authenticate and authorize the operator to change roles in the selected tenant. Include the
tenant predicate in business queries too: audit tenancy does not scope your business Prisma client.
For a `User` with `id`, `tenantId`, and `role`, change this existing transaction:

```typescript
await base.$transaction(tx => tx.user.update({
  where: { id: userId, tenantId }, data: { role: 'admin' },
}));
```

To this:

```typescript
await base.$transaction(async tx => {
  const before = await tx.user.findUniqueOrThrow({ where: { id: userId, tenantId } });
  const after = await tx.user.update({
    where: { id: userId, tenantId }, data: { role: 'admin' },
  });
  await audit.log({
    action: 'user.role.changed', targetType: 'User', targetId: userId,
    metadata: { role: { before: before.role, after: after.role } },
  }, tx);
  return after;
});
```

Await `log(input, tx)` and let failures escape the callback. A JavaScript audit error caught inside
an ordinary Prisma transaction can allow business changes to commit. Manual logging does not attach
the automatic helper's failure marker to arbitrary transactions. See the
[manual transaction contract](api-reference.md#auditserviceloginput-tx).

Manual records have `source: 'manual'`, action `user.role.changed`, and application-supplied
before/after in `metadata.role`. They do not generate automatic `changes` or a complete per-row diff.
Both reads and writes above execute in the same transaction, but concurrent business decisions may
still need your application's locking/isolation policy.

Run `npm run smoke:manual` in the example after `db:setup`. Its standalone Nest module creates only
a base Prisma client. It asserts the actor `demo-operator`, tenant `demo-tenant`, target ID,
`member → admin` metadata, password redaction, and business/event rollback after a thrown exception.
It also checks that no automatic rows were created.

## Add automatic tracking for one model

Keep the base client for storage and create an extended view of it for business writes. Pass the
same table, tenant, and masking options separately to the module and extension in 0.6.0:

```typescript
const audited = createAuditedClient(base, {
  ...sharedAuditOptions,
  consistency: 'atomic-required',
  trackedModels: ['User'],
  databaseMapping: { User: { tableName: 'users' } },
});
```

Replace `base.$transaction(async tx => { ... })` on the selected write path with
`audited.withAuditTransaction(async tx => { ... })`, using the callback's `tx` for every write:

```typescript
await audited.withAuditTransaction(tx => tx.user.update({
  where: { id: userId, tenantId }, data: { role: 'admin' },
}));
```

This records `User.updated`, `source: 'auto'`, and `changes.role` with `before: 'member'` and
`after: 'admin'`. Querying the audit table uses the module's base client. Keep automatic and manual
role-change examples as separate adoption choices; adding both to one operation deliberately emits
two records with different meanings.

Nested writes must be reviewed, not mechanically wrapped in the helper. For example, if both `User`
and `Post` are tracked in your application, replace:

```typescript
await base.user.create({ data: { ...userData, posts: { create: postData } } });
```

With explicit writes (adapt model names, required fields, tenant predicates and foreign keys):

```typescript
await audited.withAuditTransaction(async tx => {
  const user = await tx.user.create({ data: userData });
  await tx.post.create({ data: { ...postData, authorId: user.id } });
});
```

The runnable fixture has only `User`; `Post` here illustrates the rewrite for a related tracked
model. Add `Post` to `trackedModels` and its database mapping before using this fragment.
See the [nested-write contract](transactions.md#nested-writes) for untracked parents and relations.

For a bounded bulk role change, replace `base.user.updateMany({ where, data: { role: 'admin' } })`
with explicit single-record writes in one helper:

```typescript
await audited.withAuditTransaction(async tx => {
  const users = await tx.user.findMany({ where: { tenantId, role: 'member' }, select: { id: true } });
  for (const user of users) {
    await tx.user.update({ where: { id: user.id, tenantId }, data: { role: 'admin' } });
  }
});
```

Choose a bounded workload and transaction timeout appropriate for your application. Chunking changes
the all-or-nothing boundary to each chunk. Atomic `createMany`/`updateMany` are rejected; `deleteMany`
has a record cap. Avoid `createManyAndReturn`/`updateManyAndReturn` in 0.6.0 because they have no automatic
coverage; the 0.7.0 candidate rejects them in atomic mode. See the [bulk matrix](transactions.md#bulk-mutation-contract).
`best-effort` does not provide equivalent atomicity.

Before switching a model, check its write paths:

- Find API handlers, jobs, scripts and related-model writes that can change it.
- Confirm each audited write uses the audited helper's `tx`, not a captured base client.
- Review nested writes, bulk operations, soft-delete hooks, raw SQL and database cascades.
- Check actor timing, authorized tenant context, business tenant predicates and masking on both paths.
- Reproduce a successful change and a rollback, then query the expected tenant and target.

## Follow the role change through an authorized query

The runnable HTTP flow is `POST /users` → `POST /users/:id/role` with `{"role":"admin"}` →
`GET /users/:id/audit`. The controller checks the demo principal's `users:write` or `audit:read`
permission and tenant before writing or querying. A real application must authenticate the principal,
load trusted memberships and permissions, and reject unauthorized access before calling these APIs.

```typescript
// After application authorization of the operator and tenant:
const page = await audit.query({
  tenantId, targetType: 'User', targetId: userId, includeTotal: false,
});
```

The automatic role row must contain the authenticated actor ID, the authorized tenant and target,
and `changes.role: { before: 'member', after: 'admin' }`. The manual alternative puts this pair in
`metadata.role`. A `tenantId` filter selects scope; it is not permission to read that tenant.
Do not forward caller-supplied `allTenants: true` without separate cross-tenant authorization.

## Authentication and worker context

In 0.6.0, `actorExtractionStage: 'interceptor'` runs after successful Guards. The default is still
middleware. Writes inside Guards occur earlier and need earlier authenticated context. Extraction
failure alone is not authentication rejection. The example's fixed `DemoIdentityGuard` and fixed
tenant middleware are demonstrations, not login, membership lookup, or production access control.

Workers have neither HTTP middleware nor Guards. Establish both contexts explicitly using the same
application-owned tenant resolver passed to module and extension:

```typescript
const tenantScope = new AsyncLocalStorage<{ tenantId: string }>();
// sharedAuditOptions.tenantResolver = () => tenantScope.getStore()?.tenantId ?? null;
await tenantScope.run({ tenantId: authorizedJobTenant }, () =>
  AuditContext.runAs({ id: 'invoice-worker', type: 'system' }, () =>
    audit.log({ action: 'invoice.reconciled', targetType: 'Invoice', targetId: invoiceId }),
  ),
);
```

Import `AsyncLocalStorage` from `node:async_hooks` and `AuditContext` from `@nestarc/audit-log`.
`runAs()` supplies actor identity only; it does not create tenant context. Resolve the job's authorized
tenant from trusted job data. The HTTP smoke also verifies a separate `worker-demo` actor and tenant.

## Candidate configuration for 0.7.0 Unreleased

Only after installing the [candidate tarball](maintaining.md#candidate-documentation-example), you
can replace the independent option objects with the
[configuration factory](api-reference.md#common-configuration-factory-070-unreleased).
Use `shared.actorRequired: true` to require a non-blank actor ID for manual and automatic writes.
The factory does not authenticate, create clients, register Nest modules or apply DDL. Keep the
baseline runnable example on 0.6.0-compatible APIs until publication. See the
[0.6 → 0.7 migration](transactions.md#migrating-from-06-to-07-unreleased).

## Verify the first record and know the limits

From the standalone example directory, run:

```sh
npm run db:setup
npm run smoke:manual
npm run smoke
```

Use only a disposable test database/schema. Both smokes leave demonstration records there.
[Expected output and setup](../examples/quick-start/README.md) describe actor, tenant, redaction,
role before/after and rollback assertions. Maintainers run these same packaged examples through
`npm run test:docs:consumer` (candidate) and `npm run test:docs:consumer -- --registry` (pinned 0.6.0).
The [consumer gate](maintaining.md#run-tests) installs outside the repository with strict peers and
removes its temporary schema. This verifies the example, not every write path in your application.

### Candidate adoption assertions (0.7.0 Unreleased)

The candidate command additionally compiles and runs
[`candidate/adoption-smoke.ts`](../examples/quick-start/candidate/adoption-smoke.ts) using the packed
public API. It creates a custom `adoption_events` table through `defineAuditConfig().schemaOptions`
and uses the same factory's module/extension options. The normal `src` build remains compatible with
registry 0.6.0; `--registry` explicitly skips these unreleased assertions.

| Required scenario | Executable assertion / output scenario |
|---|---|
| Guard role change and tenant isolation | `http-guard-role-and-tenant-isolation`: concurrent Alice/Bob requests, exact target/actor/tenant and `member → admin`, cross-tenant history empty, unauthorized tenant rejected by demo host Guard |
| Worker actor, shared masking and tenant policy | `worker-context-and-shared-masking-tenant-policy`: concurrent workers retain distinct system actors/tenants; automatic changes and manual metadata redact password; `runAs` without tenant fails both paths |
| Business exception | `business-error-rollback`: business and audit rows both absent after rejection |
| Automatic audit INSERT failure | `caught-audit-insert-error-rollback`: temporary CHECK constraint rejects an UPDATE audit row; catching it still rolls back the earlier CREATE and audit row |
| N01/N02 caught policy errors | `caught-n01-n02-policy-errors-rollback`: both returning bulk APIs and blank actor reject; helper rejects after callback catches; no business/audit rows persist |
| Ordinary transaction manual errors | `manual-policy-propagation-and-catch-boundary`: actor error propagation rolls back business/prior manual row; catching the JavaScript policy error commits them, with no invalid-actor event |
| Tracking exclusions | `tracked-excluded-noaudit-manual-contract`: allowlist exclusion, denylist exclusion and real `@NoAudit()` route create business rows without automatic events; explicit manual calls still require actor and record once valid |
| Custom table | `custom-table-ddl-insert-query`: custom table row count matches both tenants' service query totals; successful HTTP/worker assertions verify manual and automatic contents |

The baseline `smoke:manual` also verifies a successful manual-only role change and business-exception
rollback without creating an automatic extension. The candidate prints `mode: "candidate-adoption"`,
all eight scenario names, and `result: "passed"` only after every assertion succeeds. The consumer
runner separately prints installed version, mode, resolved artifact and integrity. Candidate mode
now installs local 0.7.0; registry mode retains the verified 0.6.0 release.

To adapt these assertions, use your test authentication, tenant resolver and models. For example,
after an expected automatic helper rejection, check both sides rather than only the thrown error:

```typescript
await assert.rejects(audited.withAuditTransaction(async tx => {
  await tx.user.create({ data: pending });
  await assert.rejects(tx.user.createManyAndReturn({ data: [another] }), /createManyAndReturn/);
}));
assert.equal(await base.user.count({ where: { id: pending.id } }), 0);
assert.equal((await audit.query({ tenantId, targetId: pending.id })).entries.length, 0);
```

The full fixture validates its local `audit_test` URL and runner-generated schema before doing I/O.
Its temporary CHECK constraint does not disable append-only enforcement and is removed in `finally`;
the runner drops its entire unique schema and removes the temporary consumer on success or failure.
Do not copy fault injection into application startup. Passing this fixture verifies these scenarios,
not all writes in your application or database.

Keep these boundaries available during adoption:

| Boundary | Contract |
|---|---|
| Base client, raw SQL, DB cascades/triggers | Not automatically recorded by the audited view; see [tracking contracts](transactions.md) |
| Nested and bulk writes | Explicit rewrites and supported-operation limits; see [nested/bulk contracts](transactions.md#bulk-mutation-contract) |
| Manual errors caught inside a transaction | Ordinary transaction may commit; propagate failures for rollback |
| Tenant and actor | Scope and attribution are separate from authentication/authorization; see [context](context-and-tenancy.md) |
| Storage privileges | Append-only triggers need restricted runtime credentials; see [hardening](storage-and-retention.md#database-hardening) |
| Export streams | Timestamp scans can miss late commits behind a checkpoint; see [delivery limits](export-and-streams.md) |
