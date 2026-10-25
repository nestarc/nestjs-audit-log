# SQL Server manual audit logging

**0.7.1 candidate, unreleased.** Published `@nestarc/audit-log@0.7.0` supports PostgreSQL. Install a
[locally packed candidate](maintaining.md#candidate-documentation-example) to use the SQL Server
APIs described here. The verified target is SQL Server 2025 with Prisma CLI, client, and
`@prisma/adapter-mssql` pinned to `7.10.0`. See the [candidate release notes](releases/0.7.1.md)
for verification results and the [CHANGELOG](../CHANGELOG.md) for version changes.

SQL Server support covers manual `AuditService.log()` calls and audit table installation. Passing
the business transaction's `tx` to `log()` writes the event on that transaction. Omitting `provider`
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
| `getAuditTableStatements`, `getAuditTableSQL`, `applyAuditTableSchema` | Supported flat-table DDL with trigger enforcement |
| `createAuditExtension`, `createAuditedClient`, factory `extension` | Rejected during configuration |
| `query`, `getById`, `prune`, `ensurePartitions` | Rejected before database access |
| `scan`, `exportCsv` | Fail on iteration/stream consumption before database access or output |
| `partitioned: true`, `ginIndex: true`, `enforcement: 'rule'` | Rejected before DDL execution |

The PostgreSQL stream store and PostgreSQL query, export, and retention guides remain
PostgreSQL-specific. A successfully created SQL Server audit table does not enable those APIs.
