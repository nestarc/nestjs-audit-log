# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
