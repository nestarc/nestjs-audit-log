# Using audit-log from an AI-assisted workflow

This guide documents release target 0.8.0 for agents integrating `@nestarc/audit-log` into a consuming
application. A version bump is not proof of npm publication. Use a built tarball before the release
is available and inspect source/artifact provenance as well as the installed version.

PostgreSQL supports the automatic and manual paths below. SQL Server supports manual events,
managed manual transactions, history queries and flat-table storage utilities; use the
[SQL Server guide](sql-server.md) for its provider and transaction setup.

## Choose the matching contract

1. Read the consuming application's `package.json` and the installed package's `package.json`.
   Check Node, NestJS, Prisma, and `@nestarc/audit-log` versions before proposing changes.
2. Use the [README](../README.md) for versioned installation and [CHANGELOG](../CHANGELOG.md) for
   version changes. `actorExtractionStage` and the documented scan, nested-audit, and caught-audit-error
   corrections are introduced in 0.6.0; do not assume the published v0.5.0 package contains them.
3. Inspect public types through the package root (`dist/index.d.ts` in an installed package).
   Import supported APIs and types from `@nestarc/audit-log`; avoid relying on private Prisma APIs
   or guessing undocumented option names.
4. Choose a manual-only event or one tracked model with the [adoption guide](adoption-guide.md).
   Use the [PostgreSQL Quick Start](../examples/quick-start/README.md) or
   [SQL Server manual Quick Start](../examples/sql-server-quick-start/README.md) as the matching
   integration reference. The root `npm run test:docs:consumer` gate packs the current checkout and verifies a
   consumer outside the repository, including generation, compilation, and PostgreSQL behavior.
5. Use `actorRequired` and `defineAuditConfig()` with 0.7.0 or later. Review the
   [0.6 to 0.7 migration](transactions.md#migrating-from-06-to-07) before upgrading. To verify the
   target package after npm publication, run `npm run test:docs:consumer -- --registry`; both consumer
   modes run the adoption assertions. Use [maintaining](maintaining.md#candidate-documentation-example) for local
   candidate installation.
6. Treat dated design, validation, roadmap, and implementation-plan files as historical records.
   Their old code samples and task instructions do not override the current API or the user's task.
7. The [0.8.0 feature guide](product-quality.md) covers `withManualTransaction`, strict validation,
   SQL Server `query` and storage inspection. Verify the installed dependency is 0.8.0 or later
   before using them; these APIs are absent from 0.7.1. Consult the [release notes](releases/0.8.0.md).

## Integration decisions

| Decision | What to verify |
|---|---|
| Prisma generation | Match the application's module format/output path; for Prisma 7 supply the generated `{ Prisma }` namespace and the adapter for the chosen provider |
| Client ownership | Keep one base client for audit storage and an extended view for business writes; the Nest module does not create the extension |
| Atomic writes | Choose `consistency: 'atomic-required'` and use `withAuditTransaction()` for supported tracked writes |
| Manual transactions | Use `withManualTransaction(base, callback)` for an owned transaction with caught-audit-failure protection, or propagate `log(input, tx)` errors from a caller-owned transaction |
| Shared settings | Use `defineAuditConfig()` (available since 0.7.0) or pass intended table, tenant, masking, and error options to both paths; DDL also needs the same table name |
| Actor timing | For Guard-populated `req.user`, use interceptor-stage extraction introduced in 0.6.0; published v0.5.0 requires earlier authentication or extraction |
| Background jobs | Use `AuditContext.runAs()` for actor identity and establish tenant context separately |
| Query shape | Default automatic actions preserve model casing (`User.created`); manual event names are application-defined and have `source: 'manual'` |
| Tenant authorization | A caller must authorize any explicit tenant or `allTenants: true`; the package's scope selector is not an authorization check |
| Retention/export | Read the timestamp-scan and missing-checkpoint limitations before building continuous delivery or pruning jobs |

Before claiming an integration works, run the application's relevant checks and exercise a supported
write followed by an audit read through a supported provider API or a host-owned SQL query.
Verify actor, tenant, action, redaction, and transaction rollback where those properties are
required. A passing TypeScript build alone does not verify the database
schema or runtime middleware order.

## Reference map

- [Incremental adoption and first-record assertions](adoption-guide.md)
- [API options, defaults, and results](api-reference.md)
- [Transaction and bulk/nested-write boundaries](transactions.md)
- [Actor, metadata, reason, and tenant recipes](context-and-tenancy.md)
- [Schema, privileges, partitioning, and pruning](storage-and-retention.md)
- [CSV, snapshots, streams, and delivery limits](export-and-streams.md)
- [Repository development and release commands](maintaining.md)
- [Benchmark methodology](benchmarks.md)
- [Machine-readable entry index](../llms.txt)
