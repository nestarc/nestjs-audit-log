# Atomic audit delivery through Outbox

This example targets **`@nestarc/audit-log@0.9.0`** with exact **`@nestarc/outbox@0.4.1`**.
It uses the Outbox registry package, not an Outbox checkout. Registry installation is for after
publication; before publication, use the [candidate procedure](#verify-a-candidate-before-publication).
`createOutboxAuditDelivery()` is introduced in 0.9.0 and is absent from 0.8.0.
See [CHANGELOG](../../CHANGELOG.md) for release differences. A matching local version number does
not establish registry publication or artifact integrity.

The example creates one business row, one audit row, and one Outbox event in the same
PostgreSQL transaction. A real Outbox poller invokes a demonstration publisher after commit.
The publisher models a remote receiver that commits a durable receipt and a business effect,
then loses its first acknowledgement. Redelivery uses the same audit ID and does not repeat
the receiver's database effect. No external HTTP service is needed for this smoke.

## Run

Use Node.js 22.23.4+ within 22.x or 24.22.1+ within 24.x, and a local PostgreSQL database
whose user can create and drop schemas. Each run creates a random schema, uses it for all
producer and receiver tables, and removes that schema in `finally`. It does not clear existing
tables. A forcibly terminated process can leave its `audit_outbox_demo_*` schema behind.

After 0.9.0 is published, copy this directory to an isolated workspace and run:

```bash
npm install --strict-peer-deps
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/audit_demo
npm run smoke
```

The manifest pins audit-log 0.9.0, Outbox 0.4.1, and the companion dependency tuple. Keep the
lockfile produced in your copied consumer workspace when reproducing a run. `npm run smoke`
generates a Prisma 7 client, compiles the consumer, and runs it against PostgreSQL.

### Verify a candidate before publication

Build and pack the candidate from its reviewed source checkout, then install that tarball in a
separate copy of this example before resolving its registry dependency:

```bash
# In the audit-log source checkout:
npm run build
npm pack --ignore-scripts --pack-destination /tmp

# In a separate copy of examples/atomic-outbox:
export AUDIT_LOG_TARBALL=/tmp/nestarc-audit-log-0.9.0.tgz
npm install --save-exact --strict-peer-deps "$AUDIT_LOG_TARBALL"
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/audit_demo
npm run smoke
```

`--save-exact` replaces the copied manifest's audit-log registry pin with the explicit local
artifact. Record the candidate commit and integrity separately; this does not verify registry
publication. The root consumer gate performs the same replacement in an isolated temporary copy.

Expected final output:

```json
{
  "tenants": 2,
  "committedWrites": 2,
  "rollback": "passed",
  "producerLossAfterCommit": "passed",
  "deliveryAttempts": 4,
  "consumerEffects": 2,
  "deduplication": "passed"
}
```

The smoke checks an invisible uncommitted event, rollback of all three producer writes,
two separately attributed tenants, recovery after killing its own producer child after commit,
the fixed summary payload, retained event identity on redelivery, and one durable consumer
effect per tenant. It starts a new worker after the child has exited. The two-tenant check verifies event
attribution and scoped history reads; it is not an RLS or authentication demonstration.

## Maintainer verification

Run these commands from the audit-log repository root with its dependencies installed and a
supported Node.js executable. The maintainer gate requires a dedicated **local `audit_test`**
database; it rejects other database names and remote hosts. Both modes create and remove their
own temporary schema and consumer directory.

```bash
export DATABASE_URL=postgresql://test:test@localhost:5433/audit_test
# Build the checkout and verify its packed candidate:
npm run test:consumer:outbox
# After this version has been published, verify the registry artifact:
node scripts/verify-atomic-outbox-consumer.cjs --registry
```

The candidate mode replaces the copied example's audit-log pin with its packed tarball. The
registry mode verifies the published package's integrity, then installs the exact registry
version. Both use Outbox 0.4.1, run this smoke, and separately verify that audit-log's public API
loads when Outbox is not installed. CI and the release workflow configure the candidate gate;
the release workflow also configures the registry check after publication. Consult each run's
result rather than treating the presence of a workflow or release version as proof of success.

## Integration points

`src/smoke.ts` creates an emitter using the same base Prisma client as audit logging:

```typescript
const emitter = new OutboxEmitter({ prisma });
const config = defineAuditConfig({
  shared: {
    provider: 'postgresql',
    prismaModule: { Prisma },
    tenantRequired: true,
    tenantResolver: () => tenant.getStore() ?? null,
    delivery: createOutboxAuditDelivery(emitter),
  },
  module: {
    actorExtractor: () => ({ id: 'demo-operator', type: 'system' }),
  },
});
const audit = new AuditService({ ...config.moduleOptions, prisma });

await audit.withManualTransaction(prisma, async ({ tx, log }) => {
  await tx.businessWrite.create({ data: { id, tenantId, name } });
  await log({ action: 'business.created', targetType: 'BusinessWrite', targetId: id });
});
```

In a Nest application, supply `config.moduleOptions` and the base client to
`AuditLogModule.forRoot()`/`forRootAsync()` and inject `AuditService`. The example constructs
that service directly to keep the producer small; its worker uses `OutboxModule` and the
real `OutboxPoller`. Periodic polling remains enabled with a 60-second interval, as required
by Outbox 0.4.1; explicit `poll()` calls make the short smoke deterministic. Shutdown stops
the poller before closing its dependencies.

Create the business, audit, and Outbox tables through reviewed migrations before application
startup. This smoke uses the published Outbox SQL export and `applyAuditTableSchema()` only
inside its disposable schema. An emitter and poller must resolve `outbox_events` to the same
schema. The example sets PostgreSQL `search_path` on every pooled connection and configures
the generated Prisma client with that schema.

## Delivery contract

- Opt in with `delivery: createOutboxAuditDelivery(emitter)`. Without it, existing audit behavior
  remains unchanged and no Outbox runtime import is required by audit-log.
- Use `withManualTransaction()` for manual events. Standalone `log()` and caller-owned
  transaction calls are rejected before the audit INSERT when delivery is configured.
- Automatic tracking uses `createAuditedClient()` with `consistency: 'atomic-required'` and
  `withAuditTransaction()`. The same delivery option can be shared through `defineAuditConfig()`.
- Business data, audit storage, and Outbox must use the same PostgreSQL database and the exact
  managed transaction client. Enqueue failure aborts the producer transaction, including when
  application code catches the audit error. Keep network calls out of transaction callbacks
  and emitter hooks; perform external delivery in the worker publisher.
- Each event is `nestarc.audit.recorded.v1`. Its payload contains `schemaVersion: 1`, `auditId`,
  `tenantId`, `actorId`, `actorType`, `action`, `targetType`, `targetId`, `source`, `result`, and
  `correlationId`. Full audit changes, arbitrary metadata, and actor IP are excluded.
- `idempotencyKey` and `causationId` use `auditId`. The Outbox idempotency key is stable
  metadata; it does not suppress a second INSERT if application code emits twice. The Outbox correlation ID uses the audit
  correlation ID when present and otherwise falls back to `auditId`. Tenant attribution is
  explicit; a global audit event uses explicit global scope rather than ambient tenant fallback.
- Delivery is at least once. Persist a receipt keyed by tenant and `auditId` together with the
  receiver's database effects, and keep it for the complete replay window. For an external side
  effect, use the destination's idempotency mechanism. This example does not promise exactly
  once execution, commit-order delivery, or a historical backfill.
- SQL Server Outbox delivery and `best-effort` automatic tracking are outside this integration.
  Existing SQL Server/manual audit use without delivery remains available.
