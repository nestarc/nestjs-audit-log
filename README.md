# @nestarc/audit-log

[![CI](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml)

Audit logging module for NestJS with automatic Prisma change tracking and append-only PostgreSQL storage.

## Requirements

- NestJS 10 or 11
- Prisma 5 or 6
- PostgreSQL

## Features

- **Automatic CUD tracking** via Prisma `$extends` — create, update, delete, upsert, and batch operations
- **Transactional** — automatic tracking wraps business write + audit insert in one database transaction
- **Before/after diffs** with deep comparison for JSON fields
- **Sensitive field masking** — configurable `[REDACTED]` replacement
- **Manual logging API** — `AuditService.log()` for business events (with optional transaction support)
- **Query API** — `AuditService.query()` with wildcard filters, pagination
- **Decorators** — `@NoAudit()` to skip, `@AuditAction()` to override action name
- **Custom primary keys** — configurable per-model PK field (defaults to `id`)
- **Multi-tenant** — optional `@nestarc/tenancy` integration with graceful degradation
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
        prisma: prisma.base, // AuditService uses the base client
        trackedModels: ['User', 'Invoice', 'Document'],
        actorExtractor: (req) => ({
          id: req.user?.id ?? null,
          type: req.user ? 'user' : 'system',
          ip: req.ip,
        }),
        sensitiveFields: ['password', 'ssn'],
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

### AuditService

```typescript
// Manual logging
await auditService.log({
  action: 'invoice.approved',
  targetId: 'inv-123',
  targetType: 'Invoice',
  metadata: { amount: 5000, currency: 'USD' },
});

// Manual logging inside a transaction (audit participates in caller's tx)
await prisma.base.$transaction(async (tx) => {
  await tx.invoice.update({ where: { id }, data: { status: 'approved' } });
  await auditService.log({ action: 'invoice.approved', targetId: id }, tx);
  // If anything fails, both the update and audit log roll back
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

```typescript
@NoAudit()      // Skip audit tracking for this route
@AuditAction('user.role.changed')  // Override the auto-generated action name
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

### Transaction Guarantees

| Path | Transactional? | Details |
|------|---------------|---------|
| Automatic tracking (extension) | Always | Business write + audit insert share one `$transaction` |
| Manual logging (`log()`) | When `tx` provided | Pass Prisma transaction client as second argument |
| Manual logging (`log()`) | When `tx` omitted | Uses base client independently (not transactional with caller) |

## Multi-Tenancy

If `@nestarc/tenancy` is installed, `tenant_id` is automatically included in all audit records and query filters. No configuration needed.

If not installed, `tenant_id` is `null` and the library works normally.

If installed but context retrieval fails, a warning is logged and `tenant_id` falls back to `null`.

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
