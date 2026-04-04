# @nestarc/audit-log

Audit logging module for NestJS with automatic Prisma change tracking and append-only PostgreSQL storage.

## Features

- **Automatic CUD tracking** via Prisma `$extends` — create, update, delete, upsert, and batch operations
- **Transactional** — business write and audit insert in the same database transaction
- **Before/after diffs** with deep comparison for JSON fields
- **Sensitive field masking** — configurable `[REDACTED]` replacement
- **Manual logging API** — `AuditService.log()` for business events
- **Query API** — `AuditService.query()` with wildcard filters, pagination
- **Decorators** — `@NoAudit()` to skip, `@AuditAction()` to override action name
- **Multi-tenant** — optional `@nestarc/tenancy` integration with graceful degradation
- **Append-only** — ships PostgreSQL rules to prevent UPDATE/DELETE on audit records

## Quick Start

### 1. Install

```bash
npm install @nestarc/audit-log
```

### 2. Create the audit_logs table

Run the shipped SQL migration in your PostgreSQL database:

```typescript
import { getAuditTableSQL } from '@nestarc/audit-log';

// In a migration or setup script:
await prisma.$executeRawUnsafe(getAuditTableSQL());
```

Or copy `node_modules/@nestarc/audit-log/dist/sql/audit-log-schema.sql` into your migration tool.

### 3. Apply the Prisma extension

```typescript
import { PrismaClient } from '@prisma/client';
import { createAuditExtension } from '@nestarc/audit-log';

const basePrisma = new PrismaClient();
const prisma = basePrisma.$extends(
  createAuditExtension({
    trackedModels: ['User', 'Invoice', 'Document'],
    sensitiveFields: ['password', 'ssn'],
  }),
);
```

### 4. Register the module

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';

@Module({
  imports: [
    AuditLogModule.forRoot({
      prisma: basePrisma, // PrismaClient instance for log/query
      trackedModels: ['User', 'Invoice', 'Document'],
      actorExtractor: (req) => ({
        id: req.user?.id ?? null,
        type: req.user ? 'user' : 'system',
        ip: req.ip,
      }),
      sensitiveFields: ['password', 'ssn'],
    }),
  ],
})
export class AppModule {}
```

`forRootAsync` is also supported for async configuration (e.g., ConfigService injection).

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
// → { entries: AuditEntry[], total: number }
```

### Decorators

```typescript
@NoAudit()      // Skip audit tracking for this route
@AuditAction('user.role.changed')  // Override the auto-generated action name
```

### createAuditExtension(options)

| Option | Type | Description |
|--------|------|-------------|
| `trackedModels` | `string[]` | Whitelist of Prisma model names to track |
| `ignoredModels` | `string[]` | Blacklist (used when `trackedModels` is not set) |
| `sensitiveFields` | `string[]` | Fields to mask as `[REDACTED]` in diffs |

### getAuditTableSQL()

Returns the full SQL for creating the `audit_logs` table with append-only rules and performance indexes.

## Multi-Tenancy

If `@nestarc/tenancy` is installed, `tenant_id` is automatically included in all audit records and query filters. No configuration needed.

If not installed, `tenant_id` is `null` and the library works normally.

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
