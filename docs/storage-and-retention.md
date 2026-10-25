# Audit storage, retention, and database permissions

The PostgreSQL instructions below document version `0.7.1`. Start with the [README](../README.md);
see [CHANGELOG](../CHANGELOG.md) for version changes.

**SQL Server DDL in 0.7.1:** schema utilities accept `provider: 'sqlserver'` for a flat audit
table with `NVARCHAR(MAX)` JSON text, UTC timestamps, and UPDATE/DELETE rejection triggers.
Unqualified table names use `dbo`; custom schemas must already exist. `getAuditTableStatements()`
and `applyAuditTableSchema()` keep trigger batches separate; `getAuditTableSQL()` emits `GO`
separators and `:ON ERROR EXIT` for sqlcmd or SSMS SQLCMD mode. SQL Server rejects partitioning, GIN indexes, rule enforcement, and
`prune()`/`ensurePartitions()` before database access. See the [SQL Server guide](sql-server.md)
for installation, existing-table checks, permissions, and manual transactions.

## Schema utilities

| Function | Description |
|----------|-------------|
| `getAuditTableSQL(options?)` | Returns raw SQL string for creating audit tables, trigger enforcement, optional partitions, and indexes |
| `getAuditTableStatements(options?)` | Returns SQL split into individual executable statements |
| `applyAuditTableSchema(prisma, options?)` | Executes the schema SQL statement by statement via Prisma |
| `ensurePartitions(prisma, options?)` | Creates missing monthly partitions for partitioned audit tables |

`AuditTableSQLOptions` accepts `tableName` (default `audit_logs`), `partitioned` (default `false`),
`enforcement` (`'trigger'` by default, or legacy `'rule'`), and `ginIndex` (default `false`).
`EnsurePartitionsOptions` accepts `tableName` and `ahead` (default `1`). Identifiers may be qualified
as `schema.table`; keep names consistent across module, extension, DDL, and maintenance calls.

Use the base client in a setup/migration script. The examples below assume `maintenancePrisma`
is a separately provisioned privileged client; `auditService` is configured for the target audit table.

## Retention and partitioning

`getAuditTableSQL({ partitioned: true })` creates a monthly `PARTITION BY RANGE (created_at)` layout with trigger enforcement and initial UTC month partitions. Keep future partitions available from application bootstrap or a daily maintenance job:

```typescript
import { ensurePartitions } from '@nestarc/audit-log';

await ensurePartitions(maintenancePrisma, { ahead: 1 });
```

Retention is explicit. `AuditService.prune({ olderThan })` deletes old rows on flat tables and drops fully expired monthly partitions on partitioned tables. Use `dryRun: true` to inspect targets first, and pass `client` when retention runs through a privileged maintenance connection:

```typescript
await auditService.prune({
  olderThan: new Date(Date.now() - 90 * 24 * 3600 * 1000),
  client: maintenancePrisma,
});
```

Flat pruning temporarily disables the delete trigger, or drops and recreates the legacy delete RULE, inside one interactive transaction. Partitioned pruning never deletes partial months; it only drops or detaches partitions whose upper bound is at or before `olderThan`.

`olderThan` must be a valid `Date`. `timeoutMs` and `maxWaitMs`, when supplied for flat pruning,
must be positive integers. Trigger-based flat pruning holds a `SHARE ROW EXCLUSIVE` lock while the
delete trigger is disabled and restored, blocking concurrent writes. Legacy RULE pruning drops and
recreates the rule and requires stronger locking. See PostgreSQL's
[`ALTER TABLE` lock documentation](https://www.postgresql.org/docs/16/sql-altertable.html).
Prefer partitioning for large audit tables.

## Database hardening

The generated row triggers block `UPDATE` and `DELETE`, but PostgreSQL `TRUNCATE` does not run row
triggers. A table owner or superuser can also alter/disable triggers, drop the table, or otherwise
bypass append-only enforcement. Treat trigger enforcement as detection and accident prevention,
not as a privilege boundary.

Use separate runtime and maintenance identities. The application identity should not own the table
and should receive only `SELECT` and `INSERT`; keep the owner-capable maintenance connection outside
the application process and pass it explicitly to `prune({ client })`:

```sql
CREATE ROLE audit_owner NOLOGIN;
-- Create/login-role provisioning is environment-specific.

ALTER TABLE audit_logs OWNER TO audit_owner;
ALTER FUNCTION audit_logs_block_mutation() OWNER TO audit_owner;

REVOKE ALL ON TABLE audit_logs FROM PUBLIC;
REVOKE ALL ON TABLE audit_logs FROM app_runtime;
GRANT SELECT, INSERT ON TABLE audit_logs TO app_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM app_runtime;
```

Do not grant `audit_owner` membership, database superuser, or schema `CREATE` privileges to the
runtime role. Restrict who can obtain the maintenance credential, alert on `ALTER TABLE`,
`DROP TABLE`, `TRUNCATE`, and changes to audit triggers, and test the grants after migrations. An
optional `BEFORE TRUNCATE FOR EACH STATEMENT` trigger can make accidental owner-side truncation
fail loudly, but it is still owner-disableable; `REVOKE TRUNCATE` plus owner separation is the
authoritative control.

## Prune options and result

`prune({ olderThan, dryRun?, client?, mode?, timeoutMs?, maxWaitMs?, requiredCheckpoints? })` returns
`{ layout, mode, prunedPartitions, deletedRows, dryRun }`. Flat tables use `mode: 'delete'` and return
a row count. Partitioned tables default to `mode: 'drop'`; use `'detach'` to remove partitions from
the parent while preserving their tables. Partition operations return `deletedRows: null` and run
one partition at a time, so a later failure can follow earlier successful maintenance.

When required export streams exist, validate every stream's saved state before pruning. A missing
state or null checkpoint must block maintenance; do not filter missing values out. See the
[complete checkpoint guard](export-and-streams.md#retention-and-required-streams). A timestamp
checkpoint alone does not prove late-committing rows were delivered.

## Migrating an existing flat table to partitions

Setting `partitioned: true` does not convert an existing flat table. `applyAuditTableSchema()` rejects
that combination before applying partitioned DDL. Plan a controlled migration for your own schema:

1. Choose a new table name, such as `audit_logs_v2`, and create it with partitioned schema options.
2. Inspect the original table's timestamp range and create all required historical monthly
   partitions before copying data. `ensurePartitions()` maintains current/future partitions; it
   does not backfill arbitrary historical months.
3. Copy records with their original IDs and timestamps using an explicit column list. Verify
   counts, tenant scope, constraints, indexes, and runtime/maintenance grants.
4. During a coordinated write pause, copy any remaining records and switch the module, extension,
   partition job, and retention job to the same new table name. Update export-job configuration
   and validate its checkpoint assumptions before resuming delivery.
5. Keep the old table available until the cutover and any export reconciliation are verified.
   Remove it only under your application's retention policy.

The package provides DDL and maintenance primitives; it does not execute this migration or keep two
tables synchronized. Rehearse the procedure against a copy of your database before a production cutover.
