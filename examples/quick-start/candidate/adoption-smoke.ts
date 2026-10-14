// Released 0.7.0 adoption contracts, compiled separately from the introductory app.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CanActivate, Controller, ExecutionContext, ForbiddenException, Get,
  Injectable, MiddlewareConsumer, Module, NestModule, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  applyAuditTableSchema, AuditContext, AuditLogModule, AuditService,
  createAuditedClient, defineAuditConfig, NoAudit,
} from '@nestarc/audit-log';
import type { AuditActor, AuditQueryResult } from '@nestarc/audit-log';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { connectionString, databaseSchema } from '../src/audit-options';

// This fault-injection fixture is restricted to the runner's disposable local schema.
const url = new URL(connectionString!);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/audit_test');
assert.match(databaseSchema, /^audit_docs_[a-f0-9]{32}$/);
const tenant = new AsyncLocalStorage<string>();
const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema: databaseSchema }) });
const config = defineAuditConfig({
  shared: {
    prismaModule: { Prisma }, tableName: `${databaseSchema}.adoption_events`,
    actorRequired: true, tenantRequired: true,
    tenantResolver: () => tenant.getStore() ?? null,
    sensitiveFields: ['password'], logger: { warn() {}, error() {} },
  },
  module: {
    actorExtractionStage: 'interceptor',
    actorExtractor: req => ({ id: req.user?.id ?? null, type: 'user' }),
  },
  extension: {
    consistency: 'atomic-required', trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users', schema: databaseSchema } },
  },
});
const client = createAuditedClient(base, config.extensionOptions);
const data = (tenantId = 'tenant-a') => ({
  id: randomUUID(), name: 'Adoption', email: `${randomUUID()}@example.com`, password: 'secret', tenantId,
});
const actor: AuditActor = { id: 'adoption-worker', type: 'system' };
function scope<T>(fn: () => T, tenantId = 'tenant-a', identity = actor): T {
  return tenant.run(tenantId, () => AuditContext.runAs(identity, fn));
}
interface DemoRequest { headers: Record<string, string>; user: { id: string; tenantId: string } }

// Test identities only. A real host must authenticate and authorize both reads and writes.
@Injectable()
class IdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<DemoRequest>();
    const identities: Record<string, string> = { alice: 'tenant-a', bob: 'tenant-b' };
    const id = req.headers['x-demo-identity'];
    if (!identities[id] || identities[id] !== tenant.getStore()) throw new ForbiddenException();
    req.user = { id, tenantId: identities[id] };
    return true;
  }
}
@Controller('adoption')
@UseGuards(IdentityGuard)
class AdoptionController {
  constructor(private readonly audit: AuditService) {}

  @Post(':id/role')
  async role(@Param('id') id: string, @Req() req: DemoRequest) {
    return client.withAuditTransaction(async tx => {
      const user = await tx.user.update({ where: { id, tenantId: req.user.tenantId }, data: { role: 'admin' } });
      await this.audit.log({ action: 'role.reviewed', targetType: 'User', targetId: id,
        metadata: { password: 'secret' } }, tx);
      return { id: user.id };
    });
  }

  @Get('history')
  history(@Req() req: DemoRequest) {
    return this.audit.query({ tenantId: req.user.tenantId });
  }

  @Post('untracked')
  @NoAudit()
  async untracked() {
    // NoAudit bypasses automatic actor/helper requirements, but not explicit manual policy.
    const store = AuditContext.getStore();
    assert.ok(store);
    store.actor = null;
    const user = await client.user.create({ data: data(tenant.getStore()) });
    await assert.rejects(this.audit.log({ action: 'excluded.manual', targetId: user.id }), /actorRequired/);
    store.actor = { id: 'explicit-reviewer', type: 'user' };
    await this.audit.log({ action: 'excluded.manual', targetType: 'User', targetId: user.id });
    return { id: user.id };
  }
}
@Module({
  imports: [AuditLogModule.forRoot({ ...config.moduleOptions, prisma: base })],
  controllers: [AdoptionController], providers: [IdentityGuard],
})
class AdoptionModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply((req: DemoRequest, _res: unknown, next: () => void) =>
      tenant.run(req.headers['x-demo-tenant'], next),
    ).forRoutes(AdoptionController);
  }
}

async function main() {
  const passed: string[] = [];
  const app = await NestFactory.create(AdoptionModule, { logger: false });
  try {
    await applyAuditTableSchema(base, config.schemaOptions);
    const audit = app.get(AuditService);
    const history = (id: string, tenantId = 'tenant-a') => audit.query({ tenantId, targetId: id });
    const absent = async (id: string) => {
      assert.equal(await base.user.count({ where: { id } }), 0);
      assert.equal((await history(id)).entries.length, 0);
    };
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const headers = (id: string, tenantId: string) => ({ 'x-demo-identity': id, 'x-demo-tenant': tenantId });
    // Concurrent HTTP requests prove that Guard identities survive into both audit paths.
    const users = await Promise.all(['tenant-a', 'tenant-b'].map(tenantId => base.user.create({ data: data(tenantId) })));
    await Promise.all(users.map(async (user, i) => {
      const identity = i === 0 ? 'alice' : 'bob';
      const response = await fetch(`${origin}/adoption/${user.id}/role`, {
        method: 'POST', headers: headers(identity, user.tenantId),
      });
      assert.equal(response.status, 201, await response.text());
      const read = await fetch(`${origin}/adoption/history`, { headers: headers(identity, user.tenantId) });
      assert.equal(read.status, 200);
      const page = await read.json() as AuditQueryResult;
      assert.equal(page.entries.length, 2);
      for (const entry of page.entries) {
        assert.equal(entry.tenantId, user.tenantId);
        assert.equal(entry.actorId, identity);
        assert.equal(entry.targetId, user.id);
        assert.equal(entry.targetType, 'User');
      }
      const automatic = page.entries.find(entry => entry.source === 'auto');
      const manual = page.entries.find(entry => entry.source === 'manual');
      assert.deepEqual(automatic?.changes?.role, { before: 'member', after: 'admin' });
      assert.equal(manual?.metadata?.password, '[REDACTED]');
    }));
    assert.equal((await fetch(`${origin}/adoption/history`, { headers: headers('alice', 'tenant-b') })).status, 403);
    assert.equal((await history(users[1].id)).entries.length, 0);
    passed.push('http-guard-role-and-tenant-isolation');

    await Promise.all(['tenant-a', 'tenant-b'].map((tenantId, i) => scope(async () => {
      const user = await client.withAuditTransaction(tx => tx.user.create({ data: data(tenantId) }));
      await audit.log({ action: 'worker.reviewed', targetType: 'User', targetId: user.id, metadata: { password: 'secret' } });
      const page = await history(user.id, tenantId);
      assert.equal(page.entries.length, 2);
      for (const entry of page.entries) {
        assert.equal(entry.actorId, `worker-${i}`);
        assert.equal(entry.actorType, 'system');
        assert.equal(entry.tenantId, tenantId);
      }
      assert.equal(page.entries.find(entry => entry.source === 'auto')?.changes?.password.after, '[REDACTED]');
      assert.equal(page.entries.find(entry => entry.source === 'manual')?.metadata?.password, '[REDACTED]');
    }, tenantId, { id: `worker-${i}`, type: 'system' })));
    // runAs alone must not fabricate a tenant for either path.
    const noTenant = data();
    await AuditContext.runAs(actor, async () => {
      await assert.rejects(client.withAuditTransaction(tx => tx.user.create({ data: noTenant })), /tenant/i);
      await assert.rejects(audit.log({ action: 'missing.tenant', targetId: noTenant.id }), /tenant/i);
    });
    await absent(noTenant.id);
    passed.push('worker-context-and-shared-masking-tenant-policy');

    await scope(async () => {
      const pending = data();
      await assert.rejects(client.withAuditTransaction(async tx => {
        await tx.user.create({ data: pending });
        throw new Error('business rollback probe');
      }), /business rollback probe/);
      await absent(pending.id);
    });
    passed.push('business-error-rollback');

    // A CHECK failure injects a real audit INSERT error without disabling append-only triggers.
    await base.$executeRawUnsafe(`ALTER TABLE "${databaseSchema}".adoption_events ADD CONSTRAINT adoption_probe CHECK (action <> 'User.updated') NOT VALID`);
    try {
      await scope(async () => {
        const pending = data();
        let callbackCompleted = false;
        await assert.rejects(client.withAuditTransaction(async tx => {
          await tx.user.create({ data: pending });
          await assert.rejects(tx.user.update({ where: { id: pending.id }, data: { role: 'admin' } }), /adoption_probe/);
          callbackCompleted = true;
        }));
        assert.equal(callbackCompleted, true, 'callback must return after catching the actual INSERT error');
        await absent(pending.id);
      });
    } finally {
      await base.$executeRawUnsafe(`ALTER TABLE "${databaseSchema}".adoption_events DROP CONSTRAINT adoption_probe`);
    }
    passed.push('caught-audit-insert-error-rollback');

    for (const operation of ['createManyAndReturn', 'updateManyAndReturn', 'actorRequired'] as const) {
      await scope(async () => {
        const pending = data();
        const rejected = data();
        let callbackCompleted = false;
        await assert.rejects(client.withAuditTransaction(async tx => {
          await tx.user.create({ data: pending });
          if (operation === 'actorRequired') {
            AuditContext.getStore()!.actor = { id: '  ', type: 'system' };
            await assert.rejects(tx.user.create({ data: rejected }), /actorRequired/);
          } else if (operation === 'createManyAndReturn') {
            await assert.rejects(tx.user.createManyAndReturn({ data: [rejected] }), /createManyAndReturn/);
          } else {
            await assert.rejects(tx.user.updateManyAndReturn({ where: { id: pending.id }, data: { role: 'admin' } }), /updateManyAndReturn/);
          }
          callbackCompleted = true;
        }));
        assert.equal(callbackCompleted, true, 'callback must return after catching the expected policy error');
        await absent(pending.id);
        await absent(rejected.id);
      });
    }
    passed.push('caught-n01-n02-policy-errors-rollback');

    for (const caught of [false, true]) {
      await scope(async () => {
        const pending = data();
        const transaction = base.$transaction(async tx => {
          await tx.user.create({ data: pending });
          // A prior manual INSERT must roll back only when the later error escapes.
          await audit.log({ action: 'manual.before-policy', targetId: pending.id }, tx);
          AuditContext.getStore()!.actor = null;
          const rejected = audit.log({ action: 'manual.invalid-actor', targetId: pending.id }, tx);
          if (caught) await assert.rejects(rejected, /actorRequired/);
          else await rejected;
        });
        if (caught) {
          await transaction;
          assert.equal(await base.user.count({ where: { id: pending.id } }), 1);
          const page = await history(pending.id);
          assert.deepEqual(page.entries.map(entry => entry.action), ['manual.before-policy']);
        } else {
          await assert.rejects(transaction, /actorRequired/);
          await absent(pending.id);
        }
      });
    }
    passed.push('manual-policy-propagation-and-catch-boundary');

    for (const selection of [{ trackedModels: [] }, { ignoredModels: ['User'] }]) {
      const excluded = createAuditedClient(base, { ...config.extensionOptions, trackedModels: undefined, ...selection });
      await tenant.run('tenant-a', () => AuditContext.run({ actor: null, noAudit: false }, async () => {
        const user = await excluded.user.create({ data: data() });
        assert.equal((await history(user.id)).entries.length, 0);
        await assert.rejects(audit.log({ action: 'excluded.manual', targetId: user.id }), /actorRequired/);
        await AuditContext.runAs(actor, () => audit.log({ action: 'excluded.manual', targetId: user.id }));
        assert.deepEqual((await history(user.id)).entries.map(entry => entry.source), ['manual']);
      }));
    }
    const response = await fetch(`${origin}/adoption/untracked`, { method: 'POST', headers: headers('alice', 'tenant-a') });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const noAuditRows = (await history((JSON.parse(text) as { id: string }).id)).entries;
    assert.equal(noAuditRows.length, 1);
    assert.equal(noAuditRows[0].source, 'manual');
    assert.equal(noAuditRows[0].actorId, 'explicit-reviewer');
    passed.push('tracked-excluded-noaudit-manual-contract');

    // The service results above must come from the custom DDL table, not the default storage.
    const [stored] = await base.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM "${databaseSchema}".adoption_events`);
    const a = await audit.query({ tenantId: 'tenant-a', includeTotal: true });
    const b = await audit.query({ tenantId: 'tenant-b', includeTotal: true });
    assert.equal(Number(stored.count), a.total! + b.total!);
    assert.ok(Number(stored.count) > 0);
    passed.push('custom-table-ddl-insert-query');
    console.log(JSON.stringify({ mode: 'candidate-adoption', scenarios: passed, result: 'passed' }));
  } finally {
    try { await app.close(); }
    finally { await base.$disconnect(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
