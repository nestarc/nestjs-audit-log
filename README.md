# NestJS audit logging with Prisma and PostgreSQL — @nestarc/audit-log

[![npm version](https://img.shields.io/npm/v/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![npm downloads](https://img.shields.io/npm/dm/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![CI](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Record who changed a Prisma model, what changed, and when in a NestJS application. Store automatic
before/after diffs and manual business events in an append-only PostgreSQL audit trail, then query,
export, or deliver the records to an external service.

The Quick Start uses **published `@nestarc/audit-log@0.7.0`**, released on 2026-09-29.
This release includes `actorRequired`, `defineAuditConfig()`, and guards for unsupported returning
bulk operations. See [CHANGELOG](CHANGELOG.md) and the
[0.6 to 0.7 migration guide](docs/transactions.md#migrating-from-06-to-07).
Maintainers can also verify a [locally packed candidate](docs/maintaining.md#candidate-documentation-example);
verify its source and integrity separately from the registry artifact even when the version matches.

**Unreleased:** the current source also supports [SQL Server manual audit logging](docs/sql-server.md)
with explicit `provider: 'sqlserver'`, same-transaction events, and SQL Server DDL. This support is
not in published 0.7.0. The Quick Start and automatic tracking examples below remain PostgreSQL-specific.

Start with [a manual business event or one tracked model](docs/adoption-guide.md) in an existing app.
The guide follows a role change through actor/tenant attribution and an authorized history query.

**Choose `atomic-required` for automatic tracking:** supported tracked writes and their audit rows
commit or roll back together inside `withAuditTransaction()`. Supported tracked writes outside the helper
are rejected. Explicit `best-effort` is non-atomic: rollback can leave orphan success rows and
transaction-local diffs can be stale. Coverage is limited to supported operations through the
audited client; see [tracking boundaries](docs/transactions.md).

## Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Read and write audit records](#read-and-write-audit-records)
- [Configuration and context](#configuration-and-context)
- [Tracking and storage boundaries](#tracking-and-storage-boundaries)
- [Guides and API reference](#guides-and-api-reference)
- [Tested ecosystem versions](#tested-ecosystem-versions)
- [Performance and development](#performance-and-development)

## Requirements

- An existing NestJS application using NestJS 10, 11, or 12.0.1+
- Prisma 7 (primary), with Prisma 5/6 legacy peer compatibility
- PostgreSQL
- Node.js 22.13+ within the 22.x line, or Node.js 24.x

NestJS 12's core packages are ESM-only. This package remains CommonJS-compatible on the supported
Node.js versions through Node's `require(esm)` interoperability. NestJS 12.0.0 is excluded because
its published framework peer metadata was corrected in 12.0.1. The example below uses CommonJS
Prisma output; match `moduleFormat` to your application's module system.

## Quick Start

For a complete standalone application with schema, migrations, a demo Guard, and smoke assertions,
use [examples/quick-start](examples/quick-start/README.md). Copy that directory to your own workspace,
install its pinned dependencies, and run `npm run db:setup`, `npm run smoke:manual`, and `npm run smoke`.
It needs no library checkout build. The manual smoke uses only a base Prisma client and the Nest module.

The integration below assumes NestJS is already installed, `DATABASE_URL` points to your PostgreSQL
database, and your Prisma schema contains a `User` model with `id`, `name`, `email`, and `password`, mapped
to the `users` table.
The [runnable schema](examples/quick-start/prisma/schema.prisma) provides that model.

### 1. Install and generate Prisma

In your existing NestJS application, install the verified release and Prisma 7 runtime dependencies:

```bash
npm install --save-exact @nestarc/audit-log@0.7.0
npm install @prisma/client@7 @prisma/adapter-pg@7 pg dotenv
npm install --save-dev prisma@7
```

The [runnable example](examples/quick-start/README.md) pins its complete dependency tuple. Existing
Prisma 5/6 applications should keep their generation setup and compatible Prisma dependencies.
Contributors testing local changes use the separate
[build/pack instructions](docs/maintaining.md#candidate-documentation-example).

```dotenv
# .env — replace with your local database credentials
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/audit_demo
```

```prisma
// prisma/schema.prisma — keep your application's model definitions below these blocks
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
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

After adding or updating your application models:

```bash
npx prisma migrate dev --name init
npx prisma generate
```

Prisma 7 reads the CLI datasource URL from `prisma.config.ts`. Import the generated `Prisma`
namespace from the configured output and pass `{ Prisma }` to this package. Prisma 5/6 applications
using `prisma-client-js` can keep their existing generation/connection setup and import from
`@prisma/client`; the audit APIs are the same.

### 2. Provide the base and audited client views

The base Prisma client stores and queries audit rows. The extended view intercepts your application's
business writes. Both views share the underlying Prisma client; do not create another connection
pool solely for the extension.

```typescript
// prisma.service.ts
import 'dotenv/config';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuditedClient } from '@nestarc/audit-log';
import { Prisma, PrismaClient } from './generated/prisma/client';

export const prismaModule = { Prisma };
export const sharedAuditOptions = {
  tableName: 'audit_logs',
  sensitiveFields: ['password', 'ssn'],
  prismaModule,
};

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  readonly client = createAuditedClient(this.base, {
    ...sharedAuditOptions,
    consistency: 'atomic-required',
    trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users' } },
  });

  async onModuleInit() { await this.base.$connect(); }
  async onModuleDestroy() { await this.base.$disconnect(); }
}
```

```typescript
// prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

Create the audit table through a migration or setup script using the **base** client:

```typescript
import { applyAuditTableSchema } from '@nestarc/audit-log';

await applyAuditTableSchema(prismaService.base, { tableName: 'audit_logs' });
```

`getAuditTableSQL({ tableName: 'audit_logs' })` provides the SQL for your migration tool. The runnable
example includes this setup; production deployments should apply it through their migration process.
See [storage setup](docs/storage-and-retention.md) for partitions and database permissions.

### 3. Register the NestJS module

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';
import { PrismaModule } from './prisma.module';
import { PrismaService, sharedAuditOptions } from './prisma.service';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        ...sharedAuditOptions,
        prisma: prisma.base,
        actorExtractionStage: 'interceptor',
        actorExtractor: (req) => ({
          id: req.user?.id ?? null,
          type: req.user ? 'user' : 'system',
          ip: req.ip,
        }),
      }),
    }),
  ],
})
export class AppModule {}
```

`actorExtractionStage: 'interceptor'` reads the actor after authentication Guards populate `req.user`
and before the route handler runs. **This option is introduced in 0.6.0.** Published
v0.5.0 extracts in middleware: authenticate before that middleware or provide an extractor that can
resolve identity there. The default remains `'middleware'` for compatibility. Writes inside Guards
precede interceptor extraction; use earlier authentication middleware if those writes need an actor.
See [actor context](docs/context-and-tenancy.md) for manual interceptor binding and background jobs.

Module and extension options are **independent**. The shared object above configures both automatic
field masking and manual metadata masking. Pass matching `tableName`, tenant options, and error
reporting options to both paths when they should share behavior; schema utilities also need the same
table name. Module options do not configure the extension automatically.
In 0.7.0, [`defineAuditConfig()`](docs/api-reference.md#common-configuration-factory) can build these
option objects from one shared definition; the direct registration above remains supported.

## Read and write audit records

Use supported model writes inside `withAuditTransaction()`. For example, in an injectable service
with `PrismaService` and `AuditService` in its constructor:

```typescript
import { Injectable } from '@nestjs/common';
import { AuditService } from '@nestarc/audit-log';
import { PrismaService } from './prisma.service';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createUser(data: { name: string; email: string; password: string }) {
    const user = await this.prisma.client.withAuditTransaction((tx) =>
      tx.user.create({ data }),
    );
    const page = await this.audit.query({
      targetType: 'User',
      targetId: user.id,
      action: 'User.*',
      source: 'auto',
      includeTotal: false,
    });
    return { userId: user.id, audit: page.entries };
  }
}
```

Register `UserService` in its Nest module's `providers` when using this service fragment. The runnable
example demonstrates the same flow in its `UserController`. For an authenticated creation, the
audit entry includes fields such as:

```json
{
  "actorId": "demo-user",
  "actorType": "user",
  "action": "User.created",
  "targetType": "User",
  "source": "auto",
  "changes": {
    "name": { "after": "Alice" },
    "password": { "after": "[REDACTED]" }
  },
  "result": "success"
}
```

This shows selected fields; IDs, timestamps, and other model fields are also present. Action names
preserve Prisma model casing: `User.created`, `User.updated`, `User.deleted`. Wildcard matching is
case-sensitive, so `user.*` does not match `User.created`.

Manual events use the action name you supply and have `source: 'manual'`:

```typescript
await auditService.log({
  action: 'invoice.approved',
  targetType: 'Invoice',
  targetId: 'inv-123',
  metadata: { amount: 5000, currency: 'USD' },
});

const filters = { action: 'invoice.*', source: 'manual' as const };
const page = await auditService.query({ ...filters, limit: 50, includeTotal: false });
if (page.nextCursor) {
  await auditService.query({
    ...filters,
    cursor: page.nextCursor,
    limit: 50,
    includeTotal: false,
  });
}
```

`query()` returns `{ entries, nextCursor, hasMore }` and, by default, `total`. Setting
`includeTotal: false` skips `COUNT(*)` and omits `total`. Keep the same filters on every cursor page;
cursors contain a position, not filters. For atomic manual events, pass the same transaction client
to `AuditService.log(input, tx)` as your business write. See the
[API reference](docs/api-reference.md) for query options, result types, and manual transaction examples.

## Configuration and context

- `trackedModels` is an allowlist of Prisma model names; `[]` audits no models. When omitted,
  `ignoredModels` is a denylist. Omitting both tracks all models and emits a one-time warning.
- `@NoAudit()` suppresses automatic tracking; `@AuditAction()` overrides automatic action names.
  `@AuditReason()` adds a reason to context metadata. They apply to handlers or controllers.
- `AuditContext.runAs(actor, callback)` supplies an actor for worker/cron code. HTTP extraction does
  not run in background jobs. [Context examples](docs/context-and-tenancy.md) cover actor, metadata,
  reason, and tenant setup.
- Tenant scope is explicit where needed: `query()`/`getById()` accept `tenantId` or deliberately
  authorized `allTenants: true`; `scan()`/`exportCsv()` require exactly one of them. A custom
  `tenantResolver` replaces the optional `@nestarc/tenancy` lookup, including when it returns `null`.

## Tracking and storage boundaries

| Capability | Contract |
|---|---|
| Automatic single-record tracking | `create`, `update`, `delete`, and `upsert` through the audited client; supported operations use the helper's transaction |
| Bulk writes | Atomic `deleteMany` records individual rows within `maxBatchRecords`; atomic `createMany`/`updateMany` are rejected; see the [bulk matrix](docs/transactions.md#bulk-mutation-contract) |
| Returning bulk writes | In 0.7.0, tracked `createManyAndReturn`/`updateManyAndReturn` are rejected in atomic mode; best-effort warns and produces no automatic audit row |
| Nested writes | Use explicit related-model writes inside the helper for tracked relations; see [nested writes](docs/transactions.md#nested-writes) |
| Other writes | Base-client writes, raw SQL, unsupported operations, and database-side cascades/triggers are outside automatic record coverage |
| Append-only storage | Default row triggers block `UPDATE`/`DELETE`; runtime permissions and a separate owner are required to prevent privileged bypasses or `TRUNCATE` |
| Export and delivery | CSV and checkpointed streams scan rows by `(created_at, id)`; this is not a commit-ordered change feed, and late commits can be missed behind a checkpoint |

These boundaries matter when deciding whether the records meet your application's audit requirements.
See [transactions](docs/transactions.md), [database hardening](docs/storage-and-retention.md#database-hardening),
and [export guarantees](docs/export-and-streams.md).

## Guides and API reference

| Task | Reference |
|---|---|
| Adopt one event or model, including a role-change workflow | [Adoption guide](docs/adoption-guide.md) |
| Run a complete integration | [Quick Start application](examples/quick-start/README.md) |
| Configure the module, extension, queries, and manual logging | [API reference](docs/api-reference.md) |
| Understand transactions, bulk operations, soft-delete, and the v0.5 migration | [Tracking contracts](docs/transactions.md) |
| Set actors, reasons, correlation metadata, and tenant scope | [Context and tenancy](docs/context-and-tenancy.md) |
| Create tables, manage partitions, prune, and configure privileges | [Storage and retention](docs/storage-and-retention.md) |
| Use unreleased SQL Server manual events and table installation | [SQL Server guide](docs/sql-server.md) |
| Export CSV or deliver logs to HTTP, object storage, Datadog, or Splunk | [Export and streams](docs/export-and-streams.md) |
| Use the package from an AI-assisted workflow | [Agent guide](docs/agent-guide.md) |
| Check release changes | [CHANGELOG](CHANGELOG.md) |

AI agents can start with [the agent guide](docs/agent-guide.md), [llms.txt](llms.txt), the runnable example,
and the public TypeScript exports
in `@nestarc/audit-log`. Historical plans under `docs/` preserve earlier designs and are marked as
historical; use the guides above for current behavior.

## Tested ecosystem versions

The independent PostgreSQL release fixture verifies this last-known-good published tuple:

| Component | Exact gate version |
|---|---|
| `@nestarc/tenancy` | `0.15.0` |
| `@nestarc/audit-log` | `0.5.0` |
| `@nestarc/soft-delete` | `0.7.3` |
| Runtime lane | Node 24, NestJS 11.1.18, Prisma 7.9.1, PostgreSQL 16 |

This is a coordinated integration test tuple, not the full peer-support matrix. The candidate gate
also tests the current audit-log checkout as a packed package. See
[maintaining and releasing](docs/maintaining.md) for fixture integrity checks and release procedures.

## Performance and development

Performance depends on operation, consistency mode, transaction overhead, schema, and workload.
Use the [reproducible benchmark](docs/benchmarks.md) to compare direct writes, plain transactions,
`atomic-required`, and explicit `best-effort`. No single latency number represents every mode.

For repository setup and lint, typecheck, unit, PostgreSQL E2E, and ecosystem tests, see
[development commands](docs/maintaining.md#development).

## License

MIT — see [LICENSE](LICENSE).
