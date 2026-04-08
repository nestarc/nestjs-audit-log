# @nestarc/audit-log

[![npm version](https://img.shields.io/npm/v/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![npm downloads](https://img.shields.io/npm/dm/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![CI](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-nestarc.dev-blue.svg)](https://nestarc.dev/packages/audit-log/)

Audit logging module for NestJS with automatic Prisma change tracking and append-only PostgreSQL storage.

## Requirements

- NestJS 10 or 11
- Prisma 5 or 6
- PostgreSQL

## Features

- **Automatic CUD tracking** via Prisma `$extends` — create, update, delete, upsert, and batch operations
- **Caller transaction aware** — automatic tracking participates in caller's `$transaction`; audit insert is best-effort
- **Before/after diffs** with deep comparison for JSON fields
- **Sensitive field masking** — configurable `[REDACTED]` replacement
- **Manual logging API** — `AuditService.log()` for business events (with optional transaction support)
- **Query API** — `AuditService.query()` with wildcard filters, pagination
- **Decorators** — `@NoAudit()` / `@AuditAction()` on handlers or controllers
- **Custom primary keys** — configurable per-model PK field (defaults to `id`)
- **Multi-tenant** — optional `@nestarc/tenancy` integration with fail-closed mode
- **Append-only** — ships PostgreSQL rules to prevent UPDATE/DELETE on audit records

## Quick Start

### 1. Install

```bash
npm install @nestarc/audit-log
```

### 2. Create the audit_logs table

```typescript
import { applyAuditTableSchema } from '@nestarc/audit-log';

// In a migration or setup script:
await applyAuditTableSchema(prisma);
```

Or use `getAuditTableSQL()` to get the raw SQL string for your migration tool.

### 3. Complete NestJS Integration

The library requires two Prisma clients with distinct roles:

- **Base client** — used by `AuditService` for writing/querying audit logs
- **Extended client** — used by your application code for business writes (CUD tracking fires here)

```typescript
// prisma.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createAuditExtension } from '@nestarc/audit-log';

const auditExtensionOptions = {
  trackedModels: ['User', 'Invoice', 'Document'],
  sensitiveFields: ['password', 'ssn'],
  // primaryKey: { Order: 'orderNumber' }, // for non-id PKs
};

@Injectable()
export class PrismaService implements OnModuleInit {
  /** Base client — for audit storage (log/query) */
  readonly base = new PrismaClient();

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
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        prisma: prisma.base,
        actorExtractor: (req) => ({
          id: req.user?.id ?? null,
          type: req.user ? 'user' : 'system',
          ip: req.ip,
        }),
        // tenantRequired: true, // fail-closed for multi-tenant deployments
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
| `actorExtractor` | `(req) => AuditActor` | *required* | Extracts actor from HTTP request |
| `tenantRequired` | `boolean` | `false` | When `true`, throws if tenant context is unavailable |

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
  from: new Date('2026-01-01'),
  to: new Date('2026-04-01'),
  limit: 50,
  offset: 0,
});
// -> { entries: AuditEntry[], total: number }
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
| `trackedModels` | `string[]` | — | Whitelist of Prisma model names to track |
| `ignoredModels` | `string[]` | — | Blacklist (used when `trackedModels` is not set) |
| `sensitiveFields` | `string[]` | `[]` | Fields to mask as `[REDACTED]` in diffs |
| `primaryKey` | `Record<string, string>` | `{ *: 'id' }` | Map of model name to primary key field name |

### Schema Utilities

| Function | Description |
|----------|-------------|
| `getAuditTableSQL()` | Returns raw SQL string for creating audit_logs table + rules + indexes |
| `getAuditTableStatements()` | Returns SQL split into individual executable statements |
| `applyAuditTableSchema(prisma)` | Executes the schema SQL statement by statement via Prisma |

### Transaction Model

| Path | Caller tx participation | Audit insert |
|------|------------------------|--------------|
| Automatic tracking (extension) | Yes — `query(args)` joins caller's `$transaction` | Best-effort — runs after business write, warns on failure |
| Manual logging (`log(input, tx)`) | Yes — when `tx` provided | Participates in provided transaction |
| Manual logging (`log(input)`) | No | Independent write via base client |

The automatic extension uses Prisma's `query(args)` callback, which preserves the caller's transaction context. The audit insert runs separately via the base client and does not block or fail the business operation. If audit insert fails, a warning is logged.

## Multi-Tenancy

If `@nestarc/tenancy` is installed, `tenant_id` is automatically included in all audit records and query filters.

| Scenario | Behavior |
|----------|----------|
| Not installed | `tenant_id` is `null`, library works normally |
| Installed, context available | `tenant_id` auto-injected |
| Installed, context fails | Warning logged, `tenant_id` falls back to `null` |
| `tenantRequired: true` + context fails | `log()` and `query()` throw an error |

## Performance

Measured with PostgreSQL 16, Prisma 6, 300 iterations on Apple Silicon:

| Scenario | Avg | P50 | P95 | P99 |
|----------|-----|-----|-----|-----|
| create — no audit (baseline) | 0.40ms | 0.40ms | 0.52ms | 0.57ms |
| **create — with audit** | **1.44ms** | **1.37ms** | **1.84ms** | **3.11ms** |
| **update — with audit + diff** | **2.06ms** | **2.01ms** | **2.54ms** | **2.85ms** |
| **delete — with audit** | **1.71ms** | **1.57ms** | **2.09ms** | **3.91ms** |

Create overhead: **+1.04ms** per write. Update is slowest due to before/after diff calculation.

> Reproduce: `docker compose -f test/e2e/docker-compose.yml up -d && npx ts-node benchmarks/audit-overhead.ts`

## Development

### Prerequisites

- Node.js 18+
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
