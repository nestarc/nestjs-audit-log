# SQL Server: first trustworthy manual event

This standalone example targets **`@nestarc/audit-log@0.8.0`**, SQL Server 2025,
Prisma CLI/client/MSSQL adapter **7.10.0**, and NestJS 12.0.1. Registry installation is for after
publication; before publication, use the [candidate procedure](#verify-a-candidate-before-publication).
The example creates an invoice and its audit event in one transaction, verifies the stored event,
and proves rollback, actor/tenant policy, masking, Unicode, and authorized history access.
See [CHANGELOG](../../CHANGELOG.md) for release differences.

Use Node 22.23.4+ within 22.x or 24.22.1+ within 24.x. The library's recorded SQL Server environment
is Linux x64 SQL Server 2025 CU10; see [supported boundaries](../../docs/sql-server.md).

## Run from a copy of this directory

Provision an empty **disposable** SQL Server database and a setup account with table/trigger
installation privileges. The example does not create or drop databases. The commands create
`dbo.audit_demo_invoices`, `dbo.audit_demo_logs`, and Prisma's migration table. Use an isolated
database because the successful smoke intentionally leaves one invoice and its append-only event.

```sh
cp .env.example .env
# Set DATABASE_URL to your disposable database and credentials.
npm install --strict-peer-deps
npm run db:setup
npm run smoke
```

These registry commands do not require a library checkout build once 0.8.0 is published.

Keep the generated lockfile and use `npm ci` for repeat installs. `db:setup` applies the included
business migration, generates Prisma, builds the example, and installs the audit table with
`auditConfig.schemaOptions`. Reapplying setup preserves compatible audit rows. The URL's database
must already exist; credentials are read from `.env` and must not be committed.

For a local server, `.env.example` uses encryption with `trustServerCertificate=true`; use a
trusted certificate and certificate validation in a deployment. Both the CLI and runtime read the
same URL. This example fixes the application and audit schema to `dbo`; adapt the Prisma schema,
migration, audit configuration, and host read together when using another schema.

Expected output:

```json
{
  "mode": "sqlserver-manual",
  "action": "invoice.approved",
  "actor": "demo-operator",
  "commit": "passed",
  "rollback": "passed",
  "actorPolicy": "passed",
  "tenantPolicy": "passed",
  "redaction": "passed",
  "unicode": "passed",
  "authorizedHistory": "passed"
}
```

## Adapt the workflow

- [audit.config.ts](src/audit.config.ts) shares provider, storage and policy configuration with
  the module and installer through `defineAuditConfig()`.
- [smoke.ts](src/smoke.ts) shows `await audit.log(input, tx)` inside the business transaction.
  Propagate its error to roll back: this caller-owned transaction does not force rollback after a
  caught JavaScript policy error. In 0.8.0, `withManualTransaction()` also offers a bound logger
  that prevents commit after a caught audit failure; see the [managed manual contract](../../docs/product-quality.md#own-the-manual-transaction).
- [history.ts](src/history.ts) shows a bounded, parameterized **application-owned SQL query**.
  It deliberately demonstrates a host-controlled read: the application checks the read permission
  and authorized tenant before executing SQL and includes tenant predicates. This example returns
  the latest 50 matching rows. In 0.8.0, [SQL Server `AuditService.query()`](../../docs/product-quality.md#read-sql-server-history)
  is also available for filtered history and cursor pagination with the same host authorization responsibility.

The fixed `demo-operator` principal and tenant membership are test data, not authentication.
Replace them with trusted application identity and authorization. The smoke uses one connection
identity for convenience. Deployments should use separate setup, writer, and authorized reader
identities: a writer needs audit INSERT, while this history reader also needs SELECT. See the
[permission guide](../../docs/sql-server.md#separate-installation-and-runtime-identities).
Version 0.8.0 includes [optional read indexes and storage inspection](../../docs/product-quality.md#add-read-indexes-explicitly).
Enable indexes through an explicit migration after checking session settings and workload costs.

After reviewing the results, remove the disposable database through the tool that created it.
The example does not delete append-only audit records or drop caller-owned resources.

## Verify a candidate before publication

The default dependency pins the 0.8.0 release target. Before it is published, copy this directory
separately and install the prepared tarball **before** resolving the remaining dependencies:

```sh
# In the library checkout:
npm run build
npm pack --pack-destination /path/to/artifacts
# In a separate copy of this example:
npm install --strict-peer-deps --save-exact /path/to/artifacts/nestarc-audit-log-VERSION.tgz
npm run db:setup
npm run smoke
```

Record the candidate commit and tarball integrity separately. A local 0.8.0 manifest is not evidence
that the registry artifact exists or contains the same files. The same smoke runs against a packed
candidate and, after publication, the registry version. See the
[0.8.0 product-quality guide](../../docs/product-quality.md) for the additional public APIs.
