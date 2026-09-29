# Run the audit-log Quick Start

This standalone example pins **published `@nestarc/audit-log@0.6.0`** (npm verified 2026-09-29).
No repository build is required. The current checkout also includes **0.7.0 Unreleased** APIs under
a 0.6.0 manifest; the default `src` build uses only published APIs. The separately compiled
`candidate` directory tests unreleased contracts. See the
[changelog](../../CHANGELOG.md), [adoption guide](../../docs/adoption-guide.md) and
[candidate instructions](../../docs/maintaining.md#candidate-documentation-example).

## Install the published version

Requirements: Node.js 22.13+ in the 22.x line or Node.js 24.x, npm, and a disposable PostgreSQL database.
Copy this entire directory into your own workspace, including `prisma/migrations` and `.env.example`.
You can download the repository source and copy just this directory; you do not need root dependencies
or a library build. From the copied directory:

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
restricted runtime connection as described in the [storage guide](../../docs/storage-and-retention.md).
Smoke commands leave demonstration rows; use only a disposable database/schema. Repeated runs use
unique user emails. Keep the generated lockfile for repeat installs with `npm ci`.

If extracting the older example bundled in the **0.6.0 registry tarball**, it still has a local file
dependency and only the original creation smoke. Run
`npm pkg set 'dependencies.@nestarc/audit-log=0.6.0'` before installing that example. For the new role and
manual-only flows, use this directory from the current repository. Both use the same published API.

## Expected first records

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
npm run test:docs:consumer -- --registry
```

The first command packs the current candidate and extracts this example from that tarball, installs
with strict peers outside the repository, and runs setup plus both smokes. The second uses the same
example against its pinned registry dependency. Each prints artifact origin/integrity and removes
only its own unique temporary schema/directory, including on failure. The full 0.7.0 policy matrix
and external site deployment remain separate release work; passing this example does not establish
complete audit coverage in your application.


### Candidate adoption scenarios (0.7.0 Unreleased)

The candidate consumer gate also runs `smoke:candidate`, which compiles with
`tsconfig.candidate.json` and executes [adoption-smoke.ts](candidate/adoption-smoke.ts).
It requires the gate's unique local `audit_test` schema and a candidate package with
`defineAuditConfig`/`actorRequired`; it is excluded from the default registry-compatible build.
Use `npm run test:docs:consumer` from the repository root to get installation, schema isolation and
teardown. `--registry` runs only the 0.6.0 baseline and explicitly reports this candidate suite skipped.

The [scenario-to-assertion map](../../docs/adoption-guide.md#candidate-adoption-assertions-070-unreleased)
explains the eight named results: concurrent HTTP/worker identities, masking/tenant policies,
business and audit failures, caught N01/N02 errors, manual catch boundaries, tracking exclusions,
and custom table storage. Success prints `mode: "candidate-adoption"`, eight `scenarios`, and
`result: "passed"`. The Guard uses fixed test identities; replace it with host authentication and
authorization when adapting the assertions.
