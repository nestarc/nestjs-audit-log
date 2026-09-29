# Actor context, decorators, and tenant scope

Applies to the current checkout (`0.6.0`). Start with the [README](../README.md);
see [CHANGELOG](../CHANGELOG.md) for version changes.

## HTTP actor extraction

`AuditActorMiddleware` creates the request's `AuditContext` and correlation metadata. The module's
`actorExtractionStage` controls when `actorExtractor(req)` runs:

| Stage | Timing | Use when |
|---|---|---|
| `'middleware'` (default) | Before NestJS Guards | Authentication middleware has already populated identity, or the extractor resolves it itself |
| `'interceptor'` | After successful Guards, before the route handler | A Guard, including Passport authentication, populates `req.user` |

The stage option is introduced in 0.6.0. Published v0.5.0 always extracts in middleware.
Do not assume a Guard-populated `req.user` is available at that earlier stage.

```typescript
AuditLogModule.forRoot({
  prisma: basePrisma,
  prismaModule,
  actorExtractionStage: 'interceptor',
  actorExtractor: async (req) => ({
    id: req.user?.id ?? null,
    type: req.user ? 'user' : 'system',
    ip: req.ip,
  }),
});
```

Here `basePrisma` and `prismaModule` are the base client and `{ Prisma }` from the
[Quick Start](../README.md#quick-start). Extractors can be synchronous or asynchronous. The
interceptor stage runs only for requests that reach the interceptor, so rejected Guards do not
trigger extraction. Writes made inside a Guard occur before interceptor-stage extraction and have
no extracted actor; authenticate in earlier middleware when those writes need attribution.

Extractor errors are reported through `onAuditError(error, { phase: 'context' })` or the logger,
and request handling continues with a null actor. The audit module does not authenticate users;
your application should reject requests that require an authenticated identity.

With `registerGlobalInterceptor: false`, bind `AuditInterceptor` yourself, for example:

```typescript
import { AuditInterceptor } from '@nestarc/audit-log';
import { Reflector } from '@nestjs/core';

app.useGlobalInterceptors(new AuditInterceptor(app.get(Reflector)));
```

Routes in `excludeRoutes` have no audit middleware context. Neither extractor stage supplies actor
context for those routes. Excluding the middleware does not itself disable automatic Prisma writes;
use `@NoAudit()` only where an audit context/interceptor is present, or explicitly choose your
tracking scope.

## Requiring an identifiable actor (0.7.0 Unreleased)

The current checkout implements `actorRequired?: boolean` for the upcoming 0.7.0 release.
It defaults to `false`. Set it on **both** module and extension options when both manual and
automatic writes require attribution; these independent registrations do not merge settings.

With `actorRequired: true`, `user`, `system`, and `api_key` actors all need a string ID with at
least one non-whitespace character. Null actors, null IDs, empty IDs, and whitespace-only IDs
are invalid. Valid IDs are stored unchanged, including surrounding whitespace.

| Path with an invalid actor | Behavior |
|---|---|
| Tracked automatic `atomic-required` write | Rejects before the business query; catching the error inside `withAuditTransaction()` still rolls back earlier business and audit rows |
| Tracked automatic `best-effort` write | Reports the policy error, executes the business query, and omits the automatic audit row, including failure rows |
| Explicit `AuditService.log(input, tx?)` | Rejects before the audit INSERT, even in `@NoAudit()`; transaction commit depends on the caller propagating the error |
| Excluded model or `@NoAudit()` automatic write | Retains the existing tracking exclusion |
| Query, scan, or CSV export | No actor-required write check; tenant scope and host authorization remain necessary |

Supported single-record, bulk, and lifecycle writes share this policy. Automatic operations copy
and validate the actor before the business query and use that copy for their records, including
all per-record `deleteMany` entries. Existing nested/bulk restrictions still apply. Policy errors
report `onAuditError(error, { phase: 'context', model, operation })` where available; throwing hooks
or loggers do not change the policy or replace a best-effort business error.

Actor extraction timing still defaults to middleware. Use `actorExtractionStage: 'interceptor'`
for Guard-populated identities, as shown above. Extractor failure continues with a null actor,
so a read request is not rejected solely because extraction failed. The actor policy is enforced
when a tracked write or manual log is reached. It is attribution validation, not authentication
or authorization. See the [manual transaction boundary](api-reference.md#auditserviceloginput-tx).

## Background jobs and manual context

Use `AuditContext.runAs()` for worker, cron, and command-line execution. Without an actor context,
with the default `actorRequired: false`, automatic and manual records use `actorId: null` and `actorType: 'system'`.

```typescript
import { AuditContext } from '@nestarc/audit-log';

await AuditContext.runAs({ id: 'invoice-worker', type: 'system' }, async () => {
  AuditContext.setMetadata({ jobId: 'job-42' });
  AuditContext.setReason('Scheduled reconciliation');
  await auditService.log({
    action: 'invoice.reconciled',
    targetType: 'Invoice',
    targetId: 'inv-123',
  });
});
```

`runAs()` supplies actor context, not tenant context. For tenant-scoped jobs, establish your tenancy
package's context or use an application-owned resolver. For example, share this configuration with
**both** the module and extension:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext } from '@nestarc/audit-log';

const tenantScope = new AsyncLocalStorage<{ tenantId: string }>();
const tenantOptions = {
  tenantRequired: true,
  tenantResolver: () => tenantScope.getStore()?.tenantId ?? null,
};
// Spread tenantOptions into AuditLogModule options and createAuditedClient options.

await tenantScope.run({ tenantId: 'tenant-1' }, () =>
  AuditContext.runAs({ id: 'invoice-worker', type: 'system' }, () =>
    auditService.log({ action: 'invoice.reconciled', targetId: 'inv-123' }),
  ),
);
```

`setMetadata()` and `setReason()` enrich the active context; without a context they do nothing.
Manual event `metadata` overrides the same keys from context, including `reason`.

## Decorators and correlation metadata

```typescript
import { AuditAction, AuditReason, NoAudit } from '@nestarc/audit-log';

// On a NestJS controller method (with its normal route decorator):
@AuditAction('user.role.changed')
@AuditReason('Administrator requested a role change')
async changeRole() { /* business logic */ }

// On a different handler or controller:
@NoAudit()
async healthCheck() { /* handler logic */ }
```

Decorators apply to handlers or controllers; handler metadata takes precedence.
`@AuditAction()` overrides automatic event names. `@AuditReason()` adds `metadata.reason` to
automatic and manual records. `@NoAudit()` skips automatic tracking intentionally; it does not
suppress explicitly requested `AuditService.log()` events. These examples are method fragments,
not standalone classes.

By default, the `x-request-id` header is copied to `metadata.correlationId`. Configure
`correlationIdHeader` or `correlationIdGetter(req)` for another source. Sensitive metadata keys are
redacted according to each path's configuration. Header values are correlation data, not proof of
identity.

## Tenant resolution and scope

If configured, `tenantResolver()` is the sole tenant lookup: its return value is used even when it
is `null`. Without that option, the package reads the optional `@nestarc/tenancy` context; when that
package is unavailable, it uses `null`.
`atomic-required` treats resolution failures as transaction failures; `best-effort` reports and isolates
them from the business mutation.

| Path | Missing tenant behavior |
|------|-------------------------|
| Automatic tracking, `tenantRequired: false` | Writes an audit row with `tenant_id = null` |
| Automatic tracking, `tenantRequired: true` | `atomic-required`: throws and rolls back; `best-effort`: skips the audit row, reports `audit entry skipped`, and returns the business mutation |
| `AuditService.log()` with `tenantRequired: true` | Throws unless tenant context is available |
| `query()` / `getById()` with explicit `tenantId` | Scopes to that tenant |
| `query()` / `getById()` with `allTenants: true` | Omits tenant filtering for authorized cross-tenant reads |
| `query()` / `getById()` with `tenantRequired: true` and no tenant | Throws unless `tenantId` or `allTenants` is explicit |
| `scan()` / `exportCsv()` | Never uses ambient scope; requires exactly one of explicit `tenantId` or `allTenants: true` |

`tenantId` and `allTenants` are mutually exclusive; the thrown error includes `tenantId and allTenants are mutually exclusive`. Without `tenantRequired`, an ambient query with no tenant context is allowed but logs a one-time warning because it is unscoped.
