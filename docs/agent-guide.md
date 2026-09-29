# Using audit-log from an AI-assisted workflow

This guide is for agents integrating `@nestarc/audit-log` into a consuming application. It describes
published 0.6.0 for baseline adoption. The current checkout also contains 0.7.0 Unreleased work
under a 0.6.0 manifest; inspect artifact provenance as well as the installed version.

## Choose the matching contract

1. Read the consuming application's `package.json` and the installed package's `package.json`.
   Check Node, NestJS, Prisma, and `@nestarc/audit-log` versions before proposing changes.
2. Use the [README](../README.md) for pinned registry installation and [CHANGELOG](../CHANGELOG.md) for
   version changes. `actorExtractionStage` and the documented scan, nested-audit, and caught-audit-error
   corrections are introduced in 0.6.0; do not assume the published v0.5.0 package contains them.
3. Inspect public types through the package root (`dist/index.d.ts` in an installed package).
   Import supported APIs and types from `@nestarc/audit-log`; avoid relying on private Prisma APIs
   or guessing undocumented option names.
4. Choose a manual-only event or one tracked model with the [adoption guide](adoption-guide.md).
   Use the [runnable Quick Start](../examples/quick-start/README.md) as a complete integration
   reference. The root `npm run test:docs:consumer` gate packs the current checkout and verifies a
   consumer outside the repository, including generation, compilation, and PostgreSQL behavior.
5. Keep `actorRequired` and `defineAuditConfig()` confined to the labeled 0.7.0 candidate path.
   Use [maintaining](maintaining.md#candidate-documentation-example) for candidate installation.
6. Treat dated design, validation, roadmap, and implementation-plan files as historical records.
   Their old code samples and task instructions do not override the current API or the user's task.

## Integration decisions

| Decision | What to verify |
|---|---|
| Prisma generation | Match the application's module format/output path; for Prisma 7 supply the generated `{ Prisma }` namespace and PostgreSQL driver adapter |
| Client ownership | Keep one base client for audit storage and an extended view for business writes; the Nest module does not create the extension |
| Atomic writes | Choose `consistency: 'atomic-required'` and use `withAuditTransaction()` for supported tracked writes |
| Shared settings | Pass intended `tableName`, tenant options, masking, and error reporting to module and extension independently; DDL also needs the same table name |
| Actor timing | For Guard-populated `req.user`, use interceptor-stage extraction introduced in 0.6.0; published v0.5.0 requires earlier authentication or extraction |
| Background jobs | Use `AuditContext.runAs()` for actor identity and establish tenant context separately |
| Query shape | Default automatic actions preserve model casing (`User.created`); manual event names are application-defined and have `source: 'manual'` |
| Tenant authorization | A caller must authorize any explicit tenant or `allTenants: true`; the package's scope selector is not an authorization check |
| Retention/export | Read the timestamp-scan and missing-checkpoint limitations before building continuous delivery or pruning jobs |

Before claiming an integration works, run the application's relevant checks and exercise a supported
write followed by an audit query. Verify actor, tenant, action, redaction, and transaction rollback
where those properties are required. A passing TypeScript build alone does not verify the database
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
