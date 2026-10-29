# Run the audit-log Quick Start

This standalone example documents and pins the **`@nestarc/audit-log@0.8.0` release target**.
The registry installation below is for after publication. Before publication, install the
[prepared candidate tarball](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/maintaining.md#candidate-documentation-example) instead.
The default `src` build contains the introductory app; the
separately compiled `candidate` directory tests additional released adoption contracts, including
`defineAuditConfig` and `actorRequired`. See the
[changelog](../../CHANGELOG.md), [adoption guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/adoption-guide.md) and
[candidate instructions](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/maintaining.md#candidate-documentation-example).

## Install version 0.8.0 after publication

Requirements: Node.js 22.23.4+ in the 22.x line or 24.22.1+ in the 24.x line, npm, and a disposable PostgreSQL database.
Use a patched Node executable as described in the [runtime requirements](../../README.md#requirements).
Updating this example's npm dependencies does not update the host runtime; rebuild deployment
artifacts or images and restart application processes after upgrading Node.
Copy this entire directory into your own workspace, including `prisma/migrations` and `.env.example`.
After publication, you can download the repository source and copy just this directory without
installing root dependencies or building the library. From the copied directory:

```sh
cp .env.example .env
# Edit DATABASE_URL for your disposable local database and a separate schema.
npm install --strict-peer-deps
npm run db:setup
npm run smoke:manual
npm run smoke
npm start
```

The default `.env.example` targets `audit_test` on port 5433 with schema `audit_quickstart`. If using
this repository's disposable database, start it from the repository root first:

```sh
docker compose -f test/e2e/docker-compose.yml up -d --wait --wait-timeout 60
```

`db:setup` applies the included users/role migrations, generates the Prisma 7 CommonJS client,
builds the app, and creates the audit table. Use a schema-owning setup connection, then provision a
restricted runtime connection as described in the [storage guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/storage-and-retention.md).
Smoke commands leave demonstration rows; use only a disposable database/schema. Repeated runs use
unique user emails. Keep the generated lockfile for repeat installs with `npm ci`.

The already published **0.7.0 registry tarball** contains an older copy of this example that still
pins 0.6.0. The 0.6.0 tarball has a local file dependency and only the original creation smoke.
Use this directory from the current repository for the 0.8.0 instructions and complete smoke flows.
Changing a dependency version in an older example does not add the new verification suites or
modify the example bundled in an already published tarball.

## Expected first records

The example's [audit-options.ts](src/audit-options.ts) uses `defineAuditConfig()` to share the table,
actor, tenant, and masking policy across the module, automatic extension, and DDL. It requires
identifiable actors and tenants. The HTTP smoke supplies them through its demo Guard/context;
manual and background code use `AuditContext.runAs()` inside the tenant scope.

`smoke:manual` bootstraps a Nest module with only a base client, changes a user's role inside ordinary
`$transaction()`, and passes the same `tx` to `AuditService.log()`. It verifies actor, tenant, target,
manual metadata masking, absence of automatic rows, and rollback of a second role change and event:

```json
{
  "mode": "manual-only",
  "action": "user.role.changed",
  "actorId": "demo-operator",
  "tenantId": "demo-tenant",
  "role": { "before": "member", "after": "admin" },
  "password": "[REDACTED]",
  "rollback": "passed"
}
```

`smoke` sends real HTTP requests for creation, review, role change, and authorized history lookup.
It verifies Guard actor extraction, tenant/target, automatic before/after and password redaction,
manual review, a separately established worker actor/tenant, and automatic transaction rollback:

```json
{
  "action": "User.created",
  "targetType": "User",
  "source": "auto",
  "actorId": "demo-user",
  "tenantId": "demo-tenant",
  "password": { "after": "[REDACTED]" },
  "role": { "before": "member", "after": "admin" },
  "manualAction": "user.reviewed",
  "backgroundActor": "worker-demo",
  "rollback": "passed"
}
```

The role pair belongs to the separate `User.updated` row. Manual role before/after is stored in
`metadata.role`; automatic role before/after is in `changes.role`. See
[manual-smoke.ts](src/manual-smoke.ts), [manual-role.ts](src/manual-role.ts), and [smoke.ts](src/smoke.ts)
for assertions you can adapt to your own test database.

## Try the HTTP flow

With `npm start` running:

```sh
curl -sS http://127.0.0.1:3000/users \
  -H 'content-type: application/json' \
  -H 'x-request-id: example-request' \
  -d '{"name":"Alice","email":"alice@example.com","password":"secret"}'
# Replace USER_ID with the returned id.
curl -sS http://127.0.0.1:3000/users/USER_ID/role \
  -H 'content-type: application/json' -d '{"role":"admin"}'
curl -sS http://127.0.0.1:3000/users/USER_ID/audit
```

`DemoIdentityGuard` supplies a fixed operator with `users:write` and `audit:read`; middleware establishes
`demo-tenant`. The manual smoke likewise uses a fixed `demo-operator`, not real authentication.
The controller checks permission and tenant before mutation/query and scopes business
writes by tenant. **This is not login or real membership authorization.** Replace the fixed principal,
permissions and tenant with your authenticated/authorized context. Never trust arbitrary tenant or
actor headers. `runAs()` supplies only an actor; the worker explicitly enters `tenantScope` separately.

After Ctrl-C, stop the disposable database from the repository root if you started it:

```sh
docker compose -f test/e2e/docker-compose.yml down
```

## Maintainer verification

With the local `audit_test` database running, execute from the repository root:

```sh
npm run test:docs:consumer
# After 0.8.0 is available from npm:
npm run test:docs:consumer -- --registry
```

The first command packs the current checkout and extracts this example from that candidate tarball,
then installs with strict peers outside the repository. The second uses the same updated example
against its pinned 0.8.0 registry dependency and verifies its origin/integrity against npm metadata.
Both run setup, manual and HTTP smokes, adoption assertions, and 0.8.0 product-quality checks.
Each prints artifact
origin/integrity and removes only its own unique temporary schema/directory, including on failure.
Here, `candidate` identifies the locally packed artifact mode; the version number alone does not
prove publication. Passing this example does not establish complete audit coverage in your application.


<a id="candidate-adoption-scenarios-070-unreleased"></a>

### Adoption scenarios (0.7.0)

Both consumer modes run `smoke:candidate`, which compiles with
`tsconfig.candidate.json` and executes [adoption-smoke.ts](candidate/adoption-smoke.ts).
It requires the gate's unique local `audit_test` schema and the 0.7.0
`defineAuditConfig`/`actorRequired` APIs. It is compiled separately from the introductory app.
Use `npm run test:docs:consumer` from the repository root to get installation, schema isolation and
teardown, or add `-- --registry` after publication to run the same assertions against npm version 0.8.0.

The [scenario-to-assertion map](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/adoption-guide.md#adoption-assertions-070)
explains the eight named results: concurrent HTTP/worker identities, masking/tenant policies,
business and audit failures, caught N01/N02 errors, manual catch boundaries, tracking exclusions,
and custom table storage. Success prints `mode: "candidate-adoption"`, eight `scenarios`, and
`result: "passed"`. The Guard uses fixed test identities; replace it with host authentication and
authorization when adapting the assertions.

### Product quality checks (0.8.0)

Run `npm run smoke:product-quality` using
[tsconfig.product-quality.json](tsconfig.product-quality.json) and
[consumer-smoke.ts](product-quality/consumer-smoke.ts). This separate suite verifies generated
Prisma transaction/result types, managed manual commit, rollback after caught validation errors,
operation observer isolation/privacy, and provider capabilities.

The root consumer runner executes it for both a packed candidate and the exact registry artifact
after publication. It is compiled separately from the introductory build and `smoke:candidate`.
See the [0.8.0 product-quality guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/product-quality.md) for the public API contracts.
