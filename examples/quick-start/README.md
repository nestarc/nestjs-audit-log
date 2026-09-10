# Run the audit-log Quick Start

This example uses the **current repository checkout**, including unreleased fixes and
`actorExtractionStage`. Published `@nestarc/audit-log@0.5.0` does not contain that option.
Do not replace the local dependency with npm `latest` until the relevant release is published.
See the root [changelog](../../CHANGELOG.md) and [usage guide](../../README.md).

Requirements: Node.js 22.13+ in the 22.x line or Node.js 24.x, npm, and PostgreSQL.
The commands below start the repository's disposable PostgreSQL 16 test database.

From the repository root:

```sh
npm ci
npm run build
docker compose -f test/e2e/docker-compose.yml up -d --wait --wait-timeout 60
cd examples/quick-start
cp .env.example .env
npm install --install-links
npm run db:setup
npm run smoke
npm start
```

`DATABASE_URL` in `.env` selects a separate `audit_quickstart` PostgreSQL schema.
`db:setup` applies the included users migration, generates the Prisma 7 CommonJS client,
builds the app, and creates the audit table with `applyAuditTableSchema()`.
Use a schema-owning setup connection for this step; provision a restricted application
connection afterward as described in the [storage guide](../../docs/storage-and-retention.md).
The local file dependency is installed as a copy; rerun `npm install --install-links`
after rebuilding a changed library.

The smoke command sends real HTTP requests, verifies automatic and manual logs, password
masking, actor extraction after a Guard, a worker actor, and rollback. Example output:

```json
{
  "action": "User.created",
  "targetType": "User",
  "source": "auto",
  "actorId": "demo-user",
  "tenantId": "demo-tenant",
  "password": { "after": "[REDACTED]" },
  "manualAction": "user.reviewed",
  "backgroundActor": "worker-demo",
  "rollback": "passed"
}
```

With `npm start` running, create a user:

```sh
curl -sS http://127.0.0.1:3000/users \
  -H 'content-type: application/json' \
  -H 'x-request-id: example-request' \
  -d '{"name":"Alice","email":"alice@example.com","password":"secret"}'
```

Copy the returned `id`, then request `GET /users/<id>/audit`. The automatic action is
`User.created`; a `POST /users/<id>/review` produces the manual action `user.reviewed`.
`DemoIdentityGuard` supplies a fixed identity and the tenant resolver returns `demo-tenant`.
Replace both with your authenticated identity and authorized tenant context in an application.
This example does not implement login or membership authorization.

Stop the app with Ctrl-C, return to the repository root, and stop the disposable database:

```sh
cd ../..
docker compose -f test/e2e/docker-compose.yml down
```

For maintainers, `npm run test:docs:consumer` packs the current library, installs it with
strict peers into an isolated directory, and runs this same example against a unique test
database schema. It requires `DATABASE_URL` pointing to the repository's local `audit_test`
database. The verifier removes only its own temporary schema and directory afterward.
