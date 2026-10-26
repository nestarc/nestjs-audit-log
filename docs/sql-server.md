# SQL Server manual audit logging and history

Documents the SQL Server APIs for release target `@nestarc/audit-log@0.8.0`. Use an explicitly built
tarball before registry publication; see the [installation guide](maintaining.md#candidate-documentation-example).
Then configure the SQL Server client and module below.
The verified target is SQL Server 2025 with Prisma CLI, client, and
`@prisma/adapter-mssql` pinned to `7.10.0`. See the [0.8.0 release notes](releases/0.8.0.md)
for verification results and the [CHANGELOG](../CHANGELOG.md) for version changes.

For a complete runnable application, start with the [SQL Server Quick Start](../examples/sql-server-quick-start/README.md).
It targets 0.8.0, generates Prisma, applies storage, and verifies commit, rollback,
actor/tenant attribution, masking, and authorized history through application-owned SQL.
Use the fragments below when integrating into an existing application.

The [0.8.0 feature guide](product-quality.md) documents managed manual transactions, history reads,
storage inspection, and optional read indexes. These additions are absent from 0.7.1.

```sh
# After 0.8.0 is available in the registry:
npm install --save-exact @nestarc/audit-log@0.8.0
```

SQL Server supports manual `AuditService.log()` calls, managed manual transactions, tenant-scoped
history reads and storage utilities. Passing the business transaction's `tx` to `log()` writes
the event on that transaction. Omitting `provider`
continues to select PostgreSQL; the package does not infer the database from a Prisma client.

## Configure the existing client and Nest module

Use the application's SQL Server Prisma client and its generated `Prisma` namespace. The audit
module creates no client or connection pool. With Prisma 7, the application's datasource uses
`provider = "sqlserver"`, the CLI URL lives in `prisma.config.ts`, and the runtime client uses
`PrismaMssql` from `@prisma/adapter-mssql`. Supply the runtime adapter's schema explicitly when using
an object configuration, for example `new PrismaMssql(connectionOptions, { schema: 'dbo' })`.

The following fragments assume the application already provides `PrismaService.base`,
`PrismaModule`, and a generated client at `./generated/prisma/client`.

```typescript
// audit.config.ts
import { defineAuditConfig } from '@nestarc/audit-log';
import { Prisma } from './generated/prisma/client';

export const auditConfig = defineAuditConfig({
  shared: {
    provider: 'sqlserver',
    tableName: 'dbo.audit_logs',
    prismaModule: { Prisma },
    actorRequired: true,
    sensitiveFields: ['password', 'token'],
  },
  module: {
    actorExtractionStage: 'interceptor',
    actorExtractor: (req) => ({
      id: req.user?.id ?? null,
      type: 'user',
      ip: req.ip,
    }),
  },
});
```

Omit `extension`: automatic tracking is not supported for SQL Server. `shared.provider` and
`shared.tableName` flow to both `moduleOptions` and `schemaOptions`, keeping runtime writes and DDL
aligned. Existing actor, tenant, context metadata, reason, and metadata redaction options apply to
manual events. Add `tenantRequired` and a host-owned `tenantResolver` when tenant attribution is required.

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';
import { auditConfig } from './audit.config';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    AuditLogModule.forRootAsync({
      imports: [PrismaModule],
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        ...auditConfig.moduleOptions,
        prisma: prisma.base,
      }),
    }),
  ],
})
export class AppModule {}
```

If the base client is already available at registration, use
`AuditLogModule.forRoot({ ...auditConfig.moduleOptions, prisma: base })` instead. The direct APIs
also accept `provider: 'sqlserver'`; pass matching provider and table options to the DDL installer.

## Install the audit table

Apply DDL in a migration or deployment setup step with an appropriately privileged client. Keep
runtime logging independent of schema installation.

```typescript
import { applyAuditTableSchema } from '@nestarc/audit-log';
import { auditConfig } from './audit.config';

await applyAuditTableSchema(setupPrisma, auditConfig.schemaOptions);
```

An omitted or unqualified `tableName` resolves to `dbo.audit_logs` or `dbo.<table>`. To use another
schema, supply `tableName: 'history.audit_logs'` and create `history` through your migration first.
The audit table is explicitly qualified even when the Prisma adapter's default schema differs.
Identifiers accept ASCII letters, digits, and underscores, starting with a letter or underscore;
the table part is limited to 44 characters and the schema part to 128. Cross-database names are unsupported.

`getAuditTableStatements({ provider: 'sqlserver', ... })` returns separate executable batches.
`applyAuditTableSchema()` executes them sequentially so each `CREATE OR ALTER TRIGGER` starts its
own batch. `getAuditTableSQL()` emits `GO` batches with `:ON ERROR EXIT` for sqlcmd or SSMS in
SQLCMD mode. Keep that directive so a failed compatibility check stops subsequent batches
([sqlcmd execution control](https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-commands?view=sql-server-ver17#execution-control-commands)).
Do not send that script to Prisma or run it in ordinary SSMS mode: these are client-side commands.

Reapplying the installer checks existing columns, defaults, constraints, and indexes, preserves
rows, and reinstalls/enables the mutation triggers. An incompatible existing layout is rejected;
the installer does not convert PostgreSQL tables or migrate arbitrary SQL Server schemas. The
installer does not wrap all batches in a transaction, so a later failure can leave earlier DDL
applied. Resolve the reported incompatibility and rerun the migration before enabling application writes.

The generated flat table uses:

- `UNIQUEIDENTIFIER` IDs with `NEWID()` and a nonclustered primary key.
- UTC `DATETIME2(7)` timestamps with `SYSUTCDATETIME()` and a clustered index on `(created_at, id)`.
- `NVARCHAR(MAX)` text columns, preserving the existing API's unbounded strings.
- Nullable `NVARCHAR(MAX)` `changes` and `metadata` with `ISJSON` checks accepting JSON objects or
  arrays. Manual logging serializes metadata and leaves `changes` null.

No tenant, actor, action, or target index is generated over `NVARCHAR(MAX)`. Design any additional
search columns and indexes for your workload in a separate migration.

## Separate installation and runtime identities

Use a deployment identity for DDL and a separate application identity for manual logging. The
MSSQL workflow includes a least-privilege smoke suite with separate SQL logins and database users:

| Identity | Scope in the smoke suite |
|---|---|
| Bootstrap administrator | Create the disposable database, users and dedicated schema; grant permissions; verify rows and remove test resources |
| Installer | Database `CONNECT` and `CREATE TABLE`, plus `ALTER` on the dedicated audit schema; no `sysadmin`, `db_owner` or `db_ddladmin` membership |
| Runtime | Database `CONNECT`, business-table `INSERT` and `SELECT`, and audit-table `INSERT`; no audit-table read, mutation or DDL permissions |

The audit schema is owned by `dbo`, not either restricted identity. The installer runs
`applyAuditTableSchema()` and reapplies it using its own authenticated connection. SQL Server
requires database `CREATE TABLE` and schema `ALTER` for table creation; DML trigger creation uses
the target table's `ALTER` permission. See Microsoft's [CREATE TABLE permissions](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql?view=sql-server-ver17#permissions)
and [CREATE TRIGGER permissions](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-trigger-transact-sql?view=sql-server-ver17#permissions).

For existing users and a dedicated schema created by your deployment administrator, the grant
shape is:

```sql
GRANT CONNECT TO [audit_installer];
GRANT CREATE TABLE TO [audit_installer];
GRANT ALTER ON SCHEMA::[audit_history] TO [audit_installer];
-- Run applyAuditTableSchema with tableName: 'audit_history.audit_logs' as audit_installer.

GRANT CONNECT TO [app_runtime];
GRANT INSERT ON OBJECT::[audit_history].[audit_logs] TO [app_runtime];
-- Grant the application's required business-table permissions separately.
```

The smoke suite grants business-table `SELECT` for Prisma's returned business row, without
granting audit-table `SELECT`. It verifies effective permissions and actual login identities,
then tests commit, caller rollback, audit INSERT failure and a successful follow-up write.
Administrator connections perform the audit-row assertions. Runtime attempts to read, update,
delete, truncate, alter or drop the audit table, disable its triggers or install a new audit table
must fail while the existing table, rows and triggers remain intact.

This verifies the stated permission profile on the documented SQL Server/Prisma environment.
Applications with additional models or operations need their corresponding business permissions;
the suite is not a verification of every production identity or authentication method. Each run
uses random credentials and cleans up only its own logins, users, schema and disposable database.

## Commit the event with the business write

Use the base client's interactive transaction and await the audit call before returning. The
following fragment assumes `prisma` and `audit` are the injected application and audit services,
and the application has an `Invoice` model with a string ID.

```typescript
await prisma.base.$transaction(async (tx) => {
  const invoice = await tx.invoice.update({
    where: { id: invoiceId },
    data: { status: 'approved' },
  });
  await audit.log({
    action: 'invoice.approved',
    targetType: 'Invoice',
    targetId: invoice.id,
    metadata: { reason: 'Finance approval' },
  }, tx);
});
```

Pass a `tx` from the same SQL Server database as the audit table. The event uses that client
directly; the service does not open a nested transaction, retry on another connection, or fall
back to the base client. Both writes commit together when the callback succeeds. Propagating a
business, policy, or audit INSERT error out of the callback rolls back the transaction.

Do not catch and suppress audit failures inside the callback if the business change requires an
audit record. A caught JavaScript policy error does not force rollback. `log(input)` without `tx`
uses the configured base client and cannot make a separate business write atomic. Worker code can
supply an actor through `AuditContext.runAs()` as described in [context and tenancy](context-and-tenancy.md).

For a new transaction owned by the audit helper, use
`audit.withManualTransaction(prisma.base, async ({ tx, log }) => { ... })`. Its bound `log(input)`
cannot omit `tx`, and a caught audit failure still prevents commit. See the
[managed manual transaction contract](product-quality.md#own-the-manual-transaction).

## Append-only enforcement and supported scope

Statement-level UPDATE and DELETE triggers reject mutations affecting existing audit rows with
SQL Server error `51001`. Zero-row statements are allowed. Triggers are not a privilege boundary:
an owner or administrator can disable them, and `TRUNCATE TABLE` does not invoke these triggers.
Separate installation privileges from the runtime identity. Give the runtime identity the audit
table's `INSERT` permission and any separately justified read permission, without ownership,
`ALTER`, or broad administrative roles. Restrict and verify permissions through your own deployment process.

| API or option | SQL Server behavior |
|---|---|
| `AuditService.log(input, tx?)` | Supported manual parameterized INSERT |
| `AuditService.withManualTransaction(client, callback, options?)` | Supported managed manual transaction with a bound writer |
| `query`, `getById` | Supported tenant-scoped history reads with full-precision cursors and exact text filters |
| `getCapabilities` | Reports provider API support without database I/O |
| `getAuditTableStatements`, `getAuditTableSQL`, `applyAuditTableSchema` | Supported flat-table DDL with trigger enforcement |
| `inspectSqlServerAuditStorage` | Read-only catalog inspection; visible metadata does not prove enforcement |
| `getSqlServerAuditReadIndexStatements`, `applySqlServerAuditReadIndexes` | Optional additive read indexes, applied using an installer identity |
| `createAuditExtension`, `createAuditedClient`, factory `extension` | Rejected during configuration |
| `prune`, `ensurePartitions` | Rejected before database access |
| `scan`, `exportCsv` | Fail on iteration/stream consumption before database access or output |
| `partitioned: true`, `ginIndex: true`, `enforcement: 'rule'` | Rejected before DDL execution |

The PostgreSQL stream store, scan/export and retention APIs remain PostgreSQL-specific.
A successfully created SQL Server audit table does not enable those APIs.

## Read tenant-scoped history

Use `audit.query({ tenantId, targetType, targetId, limit: 50, includeTotal: false })` or
`audit.getById(id, { tenantId })` after authorizing that tenant in the host application. Queries
use parameterized exact binary text comparisons; cursor tokens preserve SQL Server timestamp
precision. See [history pagination](product-quality.md#read-sql-server-history) and the
[API reference](api-reference.md#auditservicequeryoptions) for filters and result contracts.
Use [storage inspection](product-quality.md#inspect-storage-before-a-deployment) before an
intentional [read-index migration](product-quality.md#add-read-indexes-explicitly).

## Read the first event with application-owned SQL

Application-owned SQL remains an alternative, including for consumers on 0.7.1. The
[runnable history example](../examples/sql-server-quick-start/src/history.ts) checks the principal's
permission and tenant membership before executing a bounded, parameterized query with tenant and
target predicates. Its smoke verifies that another tenant cannot see the event. The fixed demo
principal is test data; supply your authenticated identity and authorization in an application.

Keep audit INSERT privileges separate from reader SELECT privileges when the deployment requires
that split. A raw SQL filter does not authorize a caller, and the example's latest-50 query is not
a general pagination or export implementation.
