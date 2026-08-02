# @nestarc/audit-log

[![npm version](https://img.shields.io/npm/v/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![npm downloads](https://img.shields.io/npm/dm/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![CI](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-nestarc.dev-blue.svg)](https://nestarc.dev/packages/audit-log/)

Audit logging module for NestJS with automatic Prisma change tracking and append-only PostgreSQL storage.

## Requirements

- NestJS 10 or 11
- Prisma 7 (primary), with Prisma 5/6 legacy peer compatibility
- PostgreSQL
- Node.js 20.19+, 22.12+, or 24.x

## Features

- **Automatic CUD tracking** via Prisma `$extends` — create, update, delete, upsert, and batch operations
- **Transaction contract is explicit** — business writes keep the caller `$transaction`, but automatic audit inserts do not join the caller transaction (orphan rows on rollback — see Transaction Model)
- **Before/after diffs** with deep comparison for JSON fields
- **Sensitive field masking** — configurable `[REDACTED]` replacement
- **Manual logging API** — `AuditService.log()` for business events (with optional transaction support)
- **Query API v2** — `AuditService.query()` with keyset cursors, wildcard filters, and optional totals
- **Decorators** — `@NoAudit()` / `@AuditAction()` on handlers or controllers
- **Custom primary keys** — configurable per-model PK field (defaults to `id`)
- **Multi-tenant** — optional `@nestarc/tenancy` integration with explicit tenant scoping
- **Append-only** — trigger enforcement blocks UPDATE/DELETE on audit records by default

## Quick Start

### 1. Install

```bash
npm install @nestarc/audit-log @prisma/client @prisma/adapter-pg pg
npm install --save-dev prisma dotenv
```

### 2. Configure Prisma 7

Prisma 7 uses the `prisma-client` generator with an explicit output path and reads the
CLI datasource URL from `prisma.config.ts`:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

```typescript
// prisma.config.ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
```

### 3. Create the audit_logs table

```typescript
import { applyAuditTableSchema } from '@nestarc/audit-log';

// In a migration or setup script, after creating the Prisma client:
await applyAuditTableSchema(prisma);
```

Or use `getAuditTableSQL()` to get the raw SQL string for your migration tool.

### 4. Complete NestJS Integration

The library requires two Prisma clients with distinct roles:

- **Base client** — used by `AuditService` for writing/querying audit logs
- **Extended client** — used by your application code for business writes (CUD tracking fires here)

```typescript
// prisma.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuditExtension } from '@nestarc/audit-log';

export const prismaModule = { Prisma };

const auditExtensionOptions = {
  trackedModels: ['User', 'Invoice', 'Document'],
  sensitiveFields: ['password', 'ssn'],
  prismaModule,
  // primaryKey: { Order: 'orderNumber' }, // for non-id PKs
};

@Injectable()
export class PrismaService implements OnModuleInit {
  /** Base client — for audit storage (log/query) */
  readonly base = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    }),
  });

  /** Extended client — use this for all application queries */
  readonly client = this.base.$extends(
    createAuditExtension(auditExtensionOptions),
  );

  async onModuleInit() {
    await this.base.$connect();
  }
}
```

```typescript
// prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';
import { PrismaModule } from './prisma.module';
import { PrismaService, prismaModule } from './prisma.service';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        prisma: prisma.base,
        prismaModule,
        actorExtractor: (req) => ({
          id: req.user?.id ?? null,
          type: req.user ? 'user' : 'system',
          ip: req.ip,
        }),
        // tenantRequired: true, // fail-closed for manual log/query APIs
      }),
    }),
  ],
})
export class AppModule {}
```

```typescript
// user.service.ts — use prisma.client (extended) for all business writes
@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async createUser(data: CreateUserDto) {
    // Automatic audit tracking fires because we use the extended client
    return this.prisma.client.user.create({ data });
  }
}
```

## API

### AuditLogModule.forRoot(options) / forRootAsync(options)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prisma` | `PrismaClient` | *required* | Base Prisma client for audit storage |
| `actorExtractor` | `(req) => AuditActor \| Promise<AuditActor>` | *required* | Extracts actor from HTTP request |
| `tenantRequired` | `boolean` | `false` | When `true`, module-side `log()` and ambient `query()`/`getById()` require tenant context unless `tenantId` or `allTenants` is explicit |
| `excludeRoutes` | `RouteInfo[]` | `[]` | Routes excluded from `AuditActorMiddleware` |
| `registerGlobalInterceptor` | `boolean` | `true` | Set `false` to bind `AuditInterceptor` manually |
| `correlationIdHeader` | `string` | `x-request-id` | Header copied into `metadata.correlationId` |
| `correlationIdGetter` | `(req) => string \| undefined` | — | Custom correlation ID source |
| `tableName` | `string` | `audit_logs` | Audit table name used by module-side log/query/prune APIs |
| `tenantResolver` | `() => string \| null` | — | Custom tenant lookup before the optional `@nestarc/tenancy` fallback |
| `sensitiveFields` | `string[]` | `[]` | Metadata redaction keys for manual logs |
| `sensitiveFieldsByModel` | `Record<string, string[]>` | `{}` | Model-specific metadata redaction keys |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |

### AuditService

```typescript
// Manual logging
await auditService.log({
  action: 'invoice.approved',
  targetId: 'inv-123',
  targetType: 'Invoice',
  metadata: { amount: 5000, currency: 'USD' },
});

// Manual logging inside a transaction
await prisma.base.$transaction(async (tx) => {
  await tx.invoice.update({ where: { id }, data: { status: 'approved' } });
  await auditService.log({ action: 'invoice.approved', targetId: id }, tx);
  // Both roll back together if anything fails
});

// Querying
const result = await auditService.query({
  actorId: 'user-123',
  action: 'invoice.*',     // wildcard support
  targetType: 'Invoice',
  source: 'auto',
  result: 'success',
  from: new Date('2026-01-01'),
  to: new Date('2026-04-01'),
  limit: 50,
  includeTotal: false,
});
// -> { entries: AuditEntry[], nextCursor: string | null, hasMore: boolean }

if (result.nextCursor) {
  await auditService.query({
    actorId: 'user-123',
    action: 'invoice.*',
    targetType: 'Invoice',
    source: 'auto',
    result: 'success',
    from: new Date('2026-01-01'),
    to: new Date('2026-04-01'),
    cursor: result.nextCursor,
    limit: 50,
    includeTotal: false,
  });
}
```

### Decorators

Apply to individual handlers or entire controllers:

```typescript
@NoAudit()      // Skip audit tracking for this route or controller
@AuditAction('user.role.changed')  // Override auto-generated action name
```

### createAuditExtension(options)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `trackedModels` | `string[]` | all models when omitted | Allowlist of Prisma model names to track. `trackedModels: []` means no models are audited |
| `ignoredModels` | `string[]` | `[]` | Denylist used only when `trackedModels` is not set |
| `sensitiveFields` | `string[]` | `[]` | Fields to mask as `[REDACTED]` in diffs |
| `sensitiveFieldsByModel` | `Record<string, string[]>` | `{}` | Per-model fields unioned with `sensitiveFields` |
| `primaryKey` | `Record<string, string>` | `{ *: 'id' }` | Map of model name to primary key field name |
| `tableName` | `string` | `audit_logs` | Audit table used by automatic inserts |
| `tenantRequired` | `boolean` | `false` | Skip automatic audit rows when tenant context is missing and report `audit entry skipped` through `onAuditError` or `logger.warn`; the business mutation still returns |
| `tenantResolver` | `() => string \| null` | — | Custom tenant lookup |
| `onAuditError` | `(error, ctx) => void` | — | Structured audit failure callback |
| `logFailures` | `boolean` | `false` | Record best-effort failure audit rows for business write errors |
| `ignoreTimestampOnlyUpdates` | `boolean` | `false` | Suppress `@updatedAt`-only update entries |
| `prismaModule` | generated Prisma module | legacy `@prisma/client` fallback | Required with the Prisma 7 `prisma-client` generator; pass `{ Prisma }` from the generated output |
| `experimentalTxAudit` | `boolean` | `false` | Experimental opt-in, no semver guarantee. Routes audit reads/inserts through an interactive transaction client when Prisma internals expose one; logs `tx-aware audit unavailable` and falls back otherwise |

When neither `trackedModels` nor `ignoredModels` is configured, `createAuditExtension()` audits all Prisma models and emits a one-time `No trackedModels/ignoredModels configured` warning. Set `trackedModels` as an allowlist or `ignoredModels` as a denylist to narrow scope.

### Schema Utilities

| Function | Description |
|----------|-------------|
| `getAuditTableSQL(options?)` | Returns raw SQL string for creating audit tables, trigger enforcement, optional partitions, and indexes |
| `getAuditTableStatements()` | Returns SQL split into individual executable statements |
| `applyAuditTableSchema(prisma)` | Executes the schema SQL statement by statement via Prisma |
| `ensurePartitions(prisma, options?)` | Creates missing monthly partitions for partitioned audit tables |

### Retention & Partitioning

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

### Query API v2

`AuditService.query()` returns deterministic newest-first pages ordered by `(created_at, id)`. Prefer cursor pagination for feeds:

```typescript
const page = await auditService.query({
  tenantId: 'tenant-1',
  action: 'invoice.*',
  actorType: 'user',
  source: 'auto',
  result: 'success',
  limit: 50,
  includeTotal: false,
});

if (page.hasMore) {
  await auditService.query({
    tenantId: 'tenant-1',
    action: 'invoice.*',
    actorType: 'user',
    source: 'auto',
    result: 'success',
    cursor: page.nextCursor!,
    limit: 50,
    includeTotal: false,
  });
}
```

`includeTotal: false` skips the `COUNT(*)` query and omits `total` from the result. Cursors do not encode filters; keep the same filter set on each page unless you intentionally want a new filtered scan below the cursor boundary. `getById(id, { tenantId })` returns one audit row within the same tenant scoping rules; use `allTenants: true` only for deliberately authorized cross-tenant admin reads.

### Nested writes

Nested relation writes are not fully audited in v0.3.0. When a tracked model mutation contains a nested write such as `posts.create`, the extension records the top-level model mutation and emits one logger warning per model/relation. Full nested-write auditing is planned for a later release.

### Transaction Model

| Path | Business write | Audit insert |
|------|----------------|--------------|
| Automatic tracking (extension) | Uses Prisma's `query(args)`, so the business write remains in the caller `$transaction` | Best-effort via the base client; automatic audit inserts do not join the caller transaction |
| Manual logging with `AuditService.log(input, tx)` | Caller-controlled | Participates in the provided transaction |
| Manual logging with `AuditService.log(input)` | Caller-controlled | Independent write via the base client |

The key contract is explicit: automatic audit inserts do not join the caller transaction. If the caller transaction rolls back, the business row rolls back but the automatic audit row can remain as an orphan row. For updates inside an open transaction, automatic before/after diffs are based on committed state visible to the base client, so the diff can be empty or stale.

The same best-effort rule applies to array transactions (`$transaction([...])`). When a later operation rolls back the batch, Prisma 7 may have already allowed an earlier operation's extension callback to write an orphan success audit row. Do not rely on automatic auditing for atomic batch audit semantics.

When transaction consistency matters, use `AuditService.log(input, tx)` for the audit row you need to roll back with the business work. `experimentalTxAudit` is an opt-in experimental path that attempts transaction-aware routing through Prisma internals. It is off by default, has no semver guarantee, falls back with a `tx-aware audit unavailable` warning when unsupported, and can make audit statement failures abort the surrounding PostgreSQL transaction.

## Multi-Tenancy

Tenant resolution uses this order: explicit `tenantResolver`, optional `@nestarc/tenancy`, then `null`. A throwing `tenantResolver` is treated differently by path so automatic auditing never breaks the business mutation.

| Path | Missing tenant behavior |
|------|-------------------------|
| Automatic tracking, `tenantRequired: false` | Writes an audit row with `tenant_id = null` |
| Automatic tracking, `tenantRequired: true` | Skips the audit row, reports `audit entry skipped` with phase `tenant-resolution`, and the business mutation still returns |
| `AuditService.log()` with `tenantRequired: true` | Throws unless tenant context is available |
| `query()` / `getById()` with explicit `tenantId` | Scopes to that tenant |
| `query()` / `getById()` with `allTenants: true` | Omits tenant filtering for authorized cross-tenant reads |
| `query()` / `getById()` with `tenantRequired: true` and no tenant | Throws unless `tenantId` or `allTenants` is explicit |

`tenantId` and `allTenants` are mutually exclusive; the thrown error includes `tenantId and allTenants are mutually exclusive`. Without `tenantRequired`, an ambient query with no tenant context is allowed but logs a one-time warning because it is unscoped.

## Performance

Measured with PostgreSQL 16, Prisma 7.9.1, 300 iterations on Apple Silicon:

| Scenario | Avg | P50 | P95 | P99 |
|----------|-----|-----|-----|-----|
| create — no audit (baseline) | 0.70ms | 0.62ms | 0.98ms | 1.57ms |
| **create — with audit** | **1.80ms** | **1.73ms** | **2.48ms** | **3.43ms** |
| **update — with audit + diff** | **2.11ms** | **2.05ms** | **2.82ms** | **3.28ms** |
| **delete — with audit** | **1.52ms** | **1.49ms** | **1.98ms** | **2.57ms** |

Create overhead: **+1.10ms** per write. Update is slowest due to before/after diff calculation.

> Reproduce: `docker compose -f test/e2e/docker-compose.yml up -d && npx ts-node benchmarks/audit-overhead.ts`

## Development

### Prerequisites

- Node.js 20.19+, 22.12+, or 24.x
- Docker (for E2E tests)

### Setup

```bash
npm install
npm run build
```

### Run tests

```bash
# Unit tests
npm test

# E2E tests (starts Docker PostgreSQL automatically)
npm run test:e2e:full

# Cleanup
npm run test:e2e:teardown
```

## License

MIT
