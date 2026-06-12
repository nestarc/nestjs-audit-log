# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-12

### BREAKING CHANGES

- **Tracking default changed**: `createAuditExtension({})` now audits all models when neither `trackedModels` nor `ignoredModels` is configured. Set `trackedModels` explicitly to keep a narrow allowlist.
- **Empty allowlist wins**: `trackedModels: []` now audits no models even when `ignoredModels` is also set.

### Added

- Shared configuration types: `AuditSharedOptions`, `AuditErrorContext`, `AuditErrorPhase`, and `AuditLogger`.
- `onAuditError` and `logger` options for observable automatic audit failures.
- `logFailures` for best-effort `result='failure'` audit rows when business writes throw.
- `ignoreTimestampOnlyUpdates` to suppress `@updatedAt`-only update audit entries.
- `tenantResolver`, explicit `query({ tenantId })`, and intentional cross-tenant `query({ allTenants: true })`.
- `sensitiveFieldsByModel` and metadata redaction for `AuditService.log()`.
- Async `ActorExtractor`, `excludeRoutes`, `registerGlobalInterceptor`, `correlationIdHeader`, and `correlationIdGetter`.
- `AuditContext.runAs()`, `setMetadata()`, `getMetadata()`, `setReason()`, and `getReason()`.
- `@AuditReason()` decorator and public `AuditInterceptor` / `AuditActorMiddleware` exports.
- `tableName`, dynamic `getAuditTableSQL(options)`, partitioned DDL, optional GIN indexes, and `ensurePartitions`.
- `AuditService.prune` for flat and partitioned retention maintenance.
- `AuditService.query(): keyset cursor pagination` with `nextCursor`, `hasMore`, `actorType`, `source`, `result`, and `includeTotal: false`.
- `AuditService.getById(id, options?)` with tenant scoping.
- `experimentalTxAudit` for opt-in transaction-aware audit routing when compatible Prisma internals are available, with safe fallback warning.
- Nested-write boundary warnings for tracked top-level mutations.
- Release gate E2E coverage for transactions, HTTP middleware/interceptor paths, batch/upsert operations, append-only enforcement, and the Nest/Prisma peer matrix.

### Changed

- append-only default enforcement changed from silent PostgreSQL RULEs to fail-loud trigger enforcement.
- `getAuditTableSQL()` no longer depends on a bundled static SQL file.
- Automatic audit inserts are explicitly documented as best-effort outside caller transactions unless `experimentalTxAudit` is active.
- `query()` ordering is deterministic: `ORDER BY created_at DESC, id DESC`.
- `query({ limit: 0 })` now throws `[@nestarc/audit-log] limit must be a positive integer.`.
- `AuditQueryResult.total` is optional at the type level and omitted when `includeTotal: false`.

### Fixed

- Audit pre-read failures no longer abort business mutations.
- `select` / `omit` projections that hide primary keys no longer produce null `targetId` rows for create/update/upsert.
- `update` no longer records the literal string `"null"` as a target id.
- Wildcard action filters escape literal `%` and `_`.
- Nest 11 middleware wildcard registration avoids the legacy route warning.

## [0.1.0] - 2026-04-05

### Added

- `AuditLogModule` with `forRoot()` and `forRootAsync()` registration
- `AuditService.log()` for manual audit event recording with optional transaction client (`tx`) parameter
- `AuditService.query()` with wildcard action filters, date ranges, and pagination
- `createAuditExtension()` Prisma extension for automatic CUD tracking (create, update, delete, upsert, createMany, updateMany, deleteMany)
- `@NoAudit()` and `@AuditAction()` decorators — work on both handler and controller class level
- `AuditContext` with `AsyncLocalStorage` for request-scoped actor propagation
- `AuditActorMiddleware` for extracting actor information from HTTP requests
- `AuditInterceptor` for bridging decorator metadata to audit context (reads both handler and class)
- Before/after diff computation with deep comparison (`isDeepEqual`) for JSON fields, arrays, and Dates
- Sensitive field masking (`[REDACTED]`) via `sensitiveFields` option
- Configurable per-model primary key via `primaryKey` option (defaults to `id`)
- Optional `@nestarc/tenancy` integration with `tenantRequired` fail-closed mode
- `getAuditTableSQL()`, `getAuditTableStatements()`, and `applyAuditTableSchema()` schema utilities
- Shipped `audit-log-schema.sql` with CREATE TABLE, append-only rules (SOC2), and performance indexes
- GitHub Actions CI (Node.js 18/20/22 matrix) and Release (tag-triggered npm publish) workflows

### Security

- Append-only enforcement via PostgreSQL rules (no UPDATE/DELETE on audit_logs)
- Parameterized raw SQL to prevent injection
- Tenant isolation when `@nestarc/tenancy` is installed; `tenantRequired` option for fail-closed behavior

### Design Decisions

- **Caller transaction participation**: automatic tracking uses `query(args)` to join caller's `$transaction`. Audit insert is best-effort and runs independently after the business write. This preserves caller rollback semantics while ensuring business operations are never blocked by audit failures.
- **Module options vs extension options**: `AuditLogModuleOptions` contains only module-level concerns (`prisma`, `actorExtractor`, `tenantRequired`). Tracking configuration (`trackedModels`, `sensitiveFields`, `primaryKey`) belongs exclusively in `createAuditExtension()`.
