# NestJS audit logging with Prisma — @nestarc/audit-log

[![npm version](https://img.shields.io/npm/v/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![npm downloads](https://img.shields.io/npm/dm/@nestarc/audit-log.svg)](https://www.npmjs.com/package/@nestarc/audit-log)
[![CI](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/nestjs-audit-log/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Record who changed what, and when, in a NestJS application. Commit manual business events with
application writes and query tenant-scoped history on PostgreSQL or SQL Server. PostgreSQL also
supports automatic before/after diffs, export, and delivery to external services.

The Quick Start and public-API examples target **`@nestarc/audit-log@0.8.0`** and pin that version.
Version 0.8.0 adds managed manual transactions, optional event validation, operation diagnostics,
and SQL Server history queries. See [CHANGELOG](CHANGELOG.md), the
[0.8.0 release notes](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/releases/0.8.0.md), and the [feature guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/product-quality.md).
Versioned source documentation describes the target package; registry publication is verified separately.
Maintainers can also verify a [locally packed candidate](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/maintaining.md#candidate-documentation-example);
verify its source and integrity separately from the registry artifact even when the version matches.

Use [SQL Server support](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/sql-server.md) with explicit `provider: 'sqlserver'` for
same-transaction events, history reads, and SQL Server storage utilities. The Quick Start and
automatic tracking examples below remain PostgreSQL-specific.

## Choose your starting point

| Your application | Start here | Verify the first result |
|---|---|---|
| PostgreSQL: keep existing transactions and add a business event | [Manual event adoption](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/adoption-guide.md#start-with-a-manual-business-event) | [Runnable manual smoke](examples/quick-start/README.md#expected-first-records): actor, tenant, masking, and rollback |
| PostgreSQL: record supported model changes automatically | [Quick Start](#quick-start) | [Runnable HTTP flow](examples/quick-start/README.md#try-the-http-flow): write, authorized history, and rollback |
| SQL Server: record a business event in the same transaction | [SQL Server Quick Start](examples/sql-server-quick-start/README.md) | Commit an event, verify rollback, and read authorized history through application-owned SQL |

Use one event or one tracked model first. The [adoption guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/adoption-guide.md) shows how to
expand after actor, tenant, redaction, and transaction behavior are verified.

For the managed transaction helper, event validation, diagnostics, and SQL Server query APIs,
see [new in 0.8.0](#new-in-080) and the [feature guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/product-quality.md).

**Choose `atomic-required` for automatic tracking:** supported tracked writes and their audit rows
commit or roll back together inside `withAuditTransaction()`. Supported tracked writes outside the helper
are rejected. Explicit `best-effort` is non-atomic: rollback can leave orphan success rows and
transaction-local diffs can be stale. Coverage is limited to supported operations through the
audited client; see [tracking boundaries](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/transactions.md).

## Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Read and write audit records](#read-and-write-audit-records)
- [Configuration and context](#configuration-and-context)
- [Tracking and storage boundaries](#tracking-and-storage-boundaries)
- [Guides and API reference](#guides-and-api-reference)
- [Tested ecosystem versions](#tested-ecosystem-versions)
- [New in 0.8.0](#new-in-080)
- [Performance and development](#performance-and-development)

## Requirements

- An existing NestJS application using NestJS 10, 11, or 12.0.1+
- PostgreSQL with Prisma 7 (primary), or Prisma 5/6 legacy peer compatibility
- Alternatively, SQL Server 2025 with Prisma CLI/client/MSSQL adapter 7.10.0 for manual logging;
  follow its [separate setup and support boundaries](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/sql-server.md)
- Node.js 22.23.4+ within the 22.x line, or 24.22.1+ within the 24.x line

These minimum versions include the Node.js fix for CVE-2026-111497 in its bundled Brotli decoder.
See the [October 2026 Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
Updating npm dependencies or the package's `engines` field does not replace the running Node
binary. Update the deployment runtime, rebuild images or deployment artifacts, and restart processes.

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

In your existing NestJS application, install version 0.8.0 and Prisma 7 runtime dependencies:

```bash
npm install --save-exact @nestarc/audit-log@0.8.0
npm install @prisma/client@7 @prisma/adapter-pg@7 pg dotenv
npm install --save-dev prisma@7
```

The [runnable example](examples/quick-start/README.md) pins its complete dependency tuple. Existing
Prisma 5/6 applications should keep their generation setup and compatible Prisma dependencies.
Contributors testing local changes use the separate
[build/pack instructions](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/maintaining.md#candidate-documentation-example).

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
pool solely for the extension. Build module, extension, and table options from one definition:

```typescript
// audit.config.ts
import { defineAuditConfig } from '@nestarc/audit-log';
import { Prisma } from './generated/prisma/client';

export const auditConfig = defineAuditConfig({
  shared: {
    provider: 'postgresql',
    tableName: 'audit_logs',
    prismaModule: { Prisma },
    actorRequired: true,
    sensitiveFields: ['password', 'ssn'],
  },
  module: {
    actorExtractionStage: 'interceptor',
    actorExtractor: req => ({
      id: req.user?.id ?? null,
      type: req.user ? 'user' : 'system',
      ip: req.ip,
    }),
  },
  extension: {
    consistency: 'atomic-required',
    trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users' } },
  },
});
```

`actorRequired: true` rejects writes without an identifiable actor. Your authentication Guard must
populate `req.user.id`; background jobs use `AuditContext.runAs()` with a system ID. For tenant-owned
data, also set `tenantRequired` and a trusted `tenantResolver` in `shared`; the
[runnable example](examples/quick-start/src/audit-options.ts) demonstrates both.

```typescript
// prisma.service.ts
import 'dotenv/config';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuditedClient } from '@nestarc/audit-log';
import { PrismaClient } from './generated/prisma/client';
import { auditConfig } from './audit.config';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  readonly client = createAuditedClient(this.base, auditConfig.extensionOptions);

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
import { auditConfig } from './audit.config';

await applyAuditTableSchema(prismaService.base, auditConfig.schemaOptions);
```

`getAuditTableSQL(auditConfig.schemaOptions)` provides the SQL for your migration tool. The runnable
example includes this setup; production deployments should apply it through their migration process.
See [storage setup](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/storage-and-retention.md) for partitions and database permissions.

### 3. Register the NestJS module

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';
import { auditConfig } from './audit.config';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        ...auditConfig.moduleOptions,
        prisma: prisma.base,
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
See [actor context](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/context-and-tenancy.md) for manual interceptor binding and background jobs.

[`defineAuditConfig()`](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/api-reference.md#common-configuration-factory) keeps table, actor,
tenant, masking, and error settings aligned across consumers. It does not open a connection or apply
DDL. Direct module and extension registration remains supported, but those options are independent:
setting a policy on the module alone does not configure the automatic extension.

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
[API reference](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/api-reference.md) for query options, result types, and manual transaction examples.

## Configuration and context

- `trackedModels` is an allowlist of Prisma model names; `[]` audits no models. When omitted,
  `ignoredModels` is a denylist. Omitting both tracks all models and emits a one-time warning.
- `@NoAudit()` suppresses automatic tracking; `@AuditAction()` overrides automatic action names.
  `@AuditReason()` adds a reason to context metadata. They apply to handlers or controllers.
- `AuditContext.runAs(actor, callback)` supplies an actor for worker/cron code. HTTP extraction does
  not run in background jobs. [Context examples](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/context-and-tenancy.md) cover actor, metadata,
  reason, and tenant setup.
- Tenant scope is explicit where needed: `query()`/`getById()` accept `tenantId` or deliberately
  authorized `allTenants: true`; `scan()`/`exportCsv()` require exactly one of them. A custom
  `tenantResolver` replaces the optional `@nestarc/tenancy` lookup, including when it returns `null`.

## Tracking and storage boundaries

| Capability | Contract |
|---|---|
| Automatic single-record tracking | `create`, `update`, `delete`, and `upsert` through the audited client; supported operations use the helper's transaction |
| Bulk writes | Atomic `deleteMany` records individual rows within `maxBatchRecords`; atomic `createMany`/`updateMany` are rejected; see the [bulk matrix](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/transactions.md#bulk-mutation-contract) |
| Returning bulk writes | Tracked `createManyAndReturn`/`updateManyAndReturn` are rejected in atomic mode; best-effort warns and produces no automatic audit row |
| Nested writes | Use explicit related-model writes inside the helper for tracked relations; see [nested writes](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/transactions.md#nested-writes) |
| Other writes | Base-client writes, raw SQL, unsupported operations, and database-side cascades/triggers are outside automatic record coverage |
| Append-only storage | Default row triggers block `UPDATE`/`DELETE`; runtime permissions and a separate owner are required to prevent privileged bypasses or `TRUNCATE` |
| Export and delivery | CSV and checkpointed streams scan rows by `(created_at, id)`; this is not a commit-ordered change feed, and late commits can be missed behind a checkpoint |

These boundaries matter when deciding whether the records meet your application's audit requirements.
See [transactions](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/transactions.md), [database hardening](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/storage-and-retention.md#database-hardening),
and [export guarantees](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/export-and-streams.md).

## Guides and API reference

| Task | Reference |
|---|---|
| Adopt one event or model, including a role-change workflow | [Adoption guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/adoption-guide.md) |
| Run a complete integration | [Quick Start application](examples/quick-start/README.md) |
| Configure the module, extension, queries, and manual logging | [API reference](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/api-reference.md) |
| Understand transactions, bulk operations, soft-delete, and the v0.5 migration | [Tracking contracts](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/transactions.md) |
| Set actors, reasons, correlation metadata, and tenant scope | [Context and tenancy](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/context-and-tenancy.md) |
| Create tables, manage partitions, prune, and configure privileges | [Storage and retention](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/storage-and-retention.md) |
| Use SQL Server manual events and table installation | [SQL Server guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/sql-server.md) |
| Export CSV or deliver logs to HTTP, object storage, Datadog, or Splunk | [Export and streams](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/export-and-streams.md) |
| Use the package from an AI-assisted workflow | [Agent guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/agent-guide.md) |
| Check release changes | [CHANGELOG](CHANGELOG.md) |
| Review 0.8.0 changes, validation, and support limits | [0.8.0 release notes](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/releases/0.8.0.md) |
| Use managed manual transactions, validation, diagnostics, and SQL Server history | [Feature guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/product-quality.md) |

AI agents can start with [the agent guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/agent-guide.md), [llms.txt](llms.txt), the runnable example,
and the public TypeScript exports
in `@nestarc/audit-log`. Guide links above point to the preserved `v0.8.0` documentation.
The local `docs/` directory is excluded from Git and future npm packages; historical plans in
the release snapshot preserve earlier designs and are marked as historical.

## Tested ecosystem versions

The optional PostgreSQL compatibility fixture verifies this last-known-good published tuple:

| Component | Exact verified version |
|---|---|
| `@nestarc/tenancy` | `0.15.0` |
| `@nestarc/audit-log` | `0.5.0` |
| `@nestarc/soft-delete` | `0.7.3` |
| Runtime lane | Node 24, NestJS 11.1.18, Prisma 7.9.1, PostgreSQL 16 |

This is a coordinated integration test tuple, not the full peer-support matrix or proof of 0.8.0
integration support. Standalone audit-log CI and publication do not depend on this optional
soft-delete integration; core validation, packed documentation consumers and MSSQL checks remain required.

The manually dispatched `Ecosystem compatibility` workflow checks either that published tuple or
the packed audit-log candidate with an explicitly selected exact published soft-delete version.
Strict peer checks and lifecycle assertions must pass before a tuple is described as supported.
Soft-delete 0.7.4 excludes audit-log 0.8.0 from its peer range, so that combination remains unsupported.
See [compatibility verification](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/maintaining.md#optional-ecosystem-compatibility) for commands,
artifact checks and the separate release procedure.

<a id="unreleased-improvements"></a>

## New in 0.8.0

Version 0.8.0 includes the following additions to the 0.7.1 API:

- **Managed manual transactions:** `AuditService.withManualTransaction()` supplies a typed
  transaction and bound writer. Caught audit failures still prevent commit, started writes settle
  before completion, and expired writers reject.
- **Event validation:** opt into `strictManualValidation` and `maxMetadataBytes` to validate
  inputs and enforce a final redacted JSON budget in UTF-8 bytes before INSERT.
- **Diagnostics and capabilities:** `onAuditOperation` reports outcomes and timing without event
  contents; diagnostic callbacks are isolated from writes. `getCapabilities()` describes the
  configured provider's supported APIs without database access.
- **SQL Server history and storage tools:** `query()` and `getById()` support tenant-scoped reads,
  full-precision cursors and exact text filtering. Optional read indexes and read-only storage
  inspection help prepare the schema for history queries.

See the [feature guide](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/product-quality.md) for configuration, examples and boundaries.
SQL Server automatic tracking, scan/export and retention remain unsupported.

## Performance and development

Performance depends on operation, consistency mode, transaction overhead, schema, and workload.
Use the [reproducible benchmark](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/benchmarks.md) to compare direct writes, plain transactions,
`atomic-required`, and explicit `best-effort`. No single latency number represents every mode.

The development candidate recorded in the **2026-10-26 local validation** passed seven individual
PostgreSQL scenarios against published 0.7.1. The limits stayed at mean latency ≤+10%, P95 ≤+15%,
and throughput ≥−10%. Automatic create used a predeclared 32-process comparison with identical
package calibration, balanced execution and confidence bounds; the other six scenarios passed
both original formal runs.

For automatic create, the one-sided 95% bounds on geometric mean process ratios were **+2.83% mean
latency**, **+4.93% P95 latency**, and **−2.75% throughput**. This is approval for the recorded local
candidate and scenarios, not a production SLO or SQL Server performance claim. The repository
validation record, [performance resolution](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/2026-10-26-performance-resolution.md), identifies the exact artifact,
environment, retained sequential results and historical failure.

For repository setup and lint, typecheck, unit, PostgreSQL E2E, and ecosystem tests, see
[development commands](https://github.com/nestarc/nestjs-audit-log/blob/v0.8.0/docs/maintaining.md#development).

## License

MIT — see [LICENSE](LICENSE).
