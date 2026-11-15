import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  AuditContext,
  AuditService,
  applyAuditTableSchema,
  createAuditedClient,
} from '../../src';
import type { AuditDeliveryAdapter, AuditDeliveryRecord } from '../../src';
import { createTestPrismaClient, Prisma, prismaModule } from './prisma-client';

jest.setTimeout(30_000);

type Mode = 'manual' | 'auto';
type Account = { id: string; tenantId: string; label: string; secret: string };
type WriteOptions = {
  action?: string;
  afterWrite?: (tx: any) => Promise<void>;
  catchWriteError?: (error: unknown) => void;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('atomic audit delivery PostgreSQL E2E', () => {
  const base = createTestPrismaClient();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `audit_delivery_${suffix}`;
  const tableName = `${schema}.audit_logs`;
  const eventTable = `${schema}.delivery_events`;
  const runtimeRole = `audit_delivery_runtime_${suffix}`;
  const policy = `delivery_tenant_${suffix}`;
  const tenant = new AsyncLocalStorage<string>();
  const ownedAccounts = new Set<string>();
  const logger = { warn: jest.fn(), error: jest.fn() };
  let setupComplete = false;
  let roleCreated = false;

  // This adapter is deliberately a local durable staging table. The separate
  // packed Outbox example verifies the first-party publisher/worker lifecycle.
  const durableDelivery: AuditDeliveryAdapter = {
    async enqueue(tx, record) {
      expect(Object.isFrozen(record)).toBe(true);
      await tx.$executeRaw`
        INSERT INTO ${Prisma.raw(eventTable)} (audit_id, tenant_id, action, payload)
        VALUES (${record.auditId}::uuid, ${record.tenantId}, ${record.action}, ${JSON.stringify(record)}::jsonb)
      `;
    },
  };

  function account(tenantId = `tenant-${randomUUID()}`): Account {
    const id = randomUUID();
    ownedAccounts.add(id);
    return { id, tenantId, label: 'Delivery account', secret: `private-${id}` };
  }

  async function bindRuntime(tx: any, tenantId: string): Promise<void> {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtimeRole}"`);
    await tx.$queryRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    const [identity] = await tx.$queryRaw`
      SELECT current_user AS name, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user
    `;
    expect(identity).toEqual({ name: runtimeRole, rolsuper: false, rolbypassrls: false });
  }

  async function asRuntime<T>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> {
    return base.$transaction(async tx => {
      await bindRuntime(tx, tenantId);
      return work(tx);
    }, { timeout: 15_000, maxWait: 5_000 });
  }

  function writer(mode: Mode, delivery: AuditDeliveryAdapter = durableDelivery) {
    const shared = {
      prismaModule, tableName, delivery, actorRequired: true, tenantRequired: true,
      tenantResolver: () => tenant.getStore() ?? null,
      sensitiveFields: ['secret'], logger,
    };
    const manual = new AuditService({
      ...shared, prisma: base, actorExtractor: () => ({ id: 'http-extractor', type: 'system' as const }),
      strictManualValidation: true,
    });
    const automatic = createAuditedClient(base, {
      ...shared, consistency: 'atomic-required', trackedModels: ['DeliveryAccount'],
      databaseMapping: { DeliveryAccount: { tableName: 'delivery_accounts', schema: 'public' } },
    });
    return (data: Account, options: WriteOptions = {}): Promise<void> => {
      const action = options.action ?? 'DeliveryAccount.created';
      return tenant.run(data.tenantId, () => AuditContext.run({
        actor: { id: `actor-${data.tenantId}`, type: 'user', ip: '192.0.2.9' },
        noAudit: false,
        actionOverride: action,
        metadata: { correlationId: `correlation-${data.id}`, secret: data.secret },
      }, async () => {
        const work = async (tx: any, log?: (input: {
          action: string; targetType: string; targetId: string;
        }) => Promise<void>) => {
          await bindRuntime(tx, data.tenantId);
          try {
            await tx.deliveryAccount.create({ data });
            if (log) await log({ action, targetType: 'DeliveryAccount', targetId: data.id });
          } catch (error) {
            if (!options.catchWriteError) throw error;
            options.catchWriteError(error);
          }
          await options.afterWrite?.(tx);
        };
        if (mode === 'manual') {
          await manual.withManualTransaction(base, ({ tx, log }) => work(tx, log), {
            timeout: 15_000, maxWait: 5_000,
          });
        } else {
          await automatic.withAuditTransaction((tx: any) => work(tx), {
            timeout: 15_000, maxWait: 5_000,
          });
        }
      }));
    };
  }

  async function rows(data: Account) {
    return asRuntime(data.tenantId, async tx => {
      const business = await tx.deliveryAccount.findMany({ where: { id: data.id } });
      const audit = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, actor_id, actor_type, action, source, result, metadata, changes
         FROM ${tableName} WHERE target_id = $1`, data.id,
      );
      const events = await tx.$queryRawUnsafe(
        `SELECT audit_id, tenant_id, payload FROM ${eventTable} WHERE payload->>'targetId' = $1`, data.id,
      );
      return { business, audit, events };
    });
  }

  async function expectRolledBack(data: Account): Promise<void> {
    expect(await rows(data)).toEqual({ business: [], audit: [], events: [] });
  }

  beforeAll(async () => {
    await base.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
    await applyAuditTableSchema(base, { tableName, enforcement: 'trigger' });
    await base.$executeRawUnsafe(`ALTER TABLE ${tableName}
      ADD CONSTRAINT reject_audit_action CHECK (action <> 'blocked.audit')`);
    await base.$executeRawUnsafe(`CREATE TABLE ${eventTable} (
      audit_id uuid PRIMARY KEY REFERENCES ${tableName}(id),
      tenant_id text NOT NULL,
      action text NOT NULL CHECK (action <> 'blocked.outbox'),
      payload jsonb NOT NULL
    )`);
    await base.$executeRawUnsafe(`CREATE ROLE "${runtimeRole}"
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    roleCreated = true;
    await base.$executeRawUnsafe(`GRANT "${runtimeRole}" TO CURRENT_USER`);
    await base.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public, ${schema} TO "${runtimeRole}"`);
    await base.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.delivery_accounts TO "${runtimeRole}"`);
    await base.$executeRawUnsafe(`GRANT SELECT, INSERT
      ON ${tableName}, ${eventTable} TO "${runtimeRole}"`);
    for (const table of ['public.delivery_accounts', tableName, eventTable]) {
      await base.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await base.$executeRawUnsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await base.$executeRawUnsafe(`CREATE POLICY "${policy}" ON ${table} TO "${runtimeRole}"
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), ''))
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), ''))`);
    }
    setupComplete = true;
  });

  afterAll(async () => {
    try {
      // Only this suite uses the new model. Remove its policy and its own rows;
      // never truncate a shared test table or reset another suite's schema.
      if (setupComplete || roleCreated) {
        await base.$executeRawUnsafe(`DROP POLICY IF EXISTS "${policy}" ON public.delivery_accounts`);
        await base.$executeRawUnsafe('ALTER TABLE public.delivery_accounts NO FORCE ROW LEVEL SECURITY');
        await base.$executeRawUnsafe('ALTER TABLE public.delivery_accounts DISABLE ROW LEVEL SECURITY');
        await base.deliveryAccount.deleteMany({ where: { id: { in: [...ownedAccounts] } } });
      }
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) {
        await base.$executeRawUnsafe(`REVOKE ALL ON public.delivery_accounts FROM "${runtimeRole}"`);
        await base.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM "${runtimeRole}"`);
        await base.$executeRawUnsafe(`REVOKE "${runtimeRole}" FROM CURRENT_USER`);
        await base.$executeRawUnsafe(`DROP ROLE "${runtimeRole}"`);
      }
    } finally { await base.$disconnect(); }
  });

  describe.each<Mode>(['manual', 'auto'])('%s delivery', mode => {
    it('commits business, audit and durable delivery with the same immutable audit identity', async () => {
      const data = account();
      await writer(mode)(data);
      const result = await rows(data);
      expect(result.business).toHaveLength(1);
      expect(result.audit).toHaveLength(1);
      expect(result.events).toHaveLength(1);
      const record = result.events[0].payload as AuditDeliveryRecord;
      expect(record).toEqual({
        schemaVersion: 1, auditId: result.audit[0].id, tenantId: data.tenantId,
        actorId: `actor-${data.tenantId}`, actorType: 'user', action: 'DeliveryAccount.created',
        targetType: 'DeliveryAccount', targetId: data.id, source: mode, result: 'success',
        correlationId: `correlation-${data.id}`,
      });
      expect(result.events[0].audit_id).toBe(result.audit[0].id);
      expect(JSON.stringify(record)).not.toContain(data.secret);
      expect(JSON.stringify(record)).not.toContain('192.0.2.9');
      expect(JSON.stringify(result.audit)).not.toContain(data.secret);
    });

    it.each(['business', 'audit-sql', 'outbox-sql', 'outbox-js', 'caught-outbox-sql', 'caught-outbox-js'] as const)(
      'rolls back all three writes after %s failure', async failure => {
        const data = account();
        const jsFailure = new Error('durable staging adapter failed');
        const delivery: AuditDeliveryAdapter = failure.endsWith('js') ? {
          async enqueue(tx, record) {
            await durableDelivery.enqueue(tx, record);
            throw jsFailure;
          },
        } : durableDelivery;
        const action = failure === 'audit-sql' ? 'blocked.audit'
          : failure.endsWith('outbox-sql') ? 'blocked.outbox' : undefined;
        let caught: unknown;
        const completion = writer(mode, delivery)(data, {
          action,
          ...(failure.startsWith('caught-') ? { catchWriteError: (error: unknown) => { caught = error; } } : {}),
          ...(failure === 'business' ? { afterWrite: async () => { throw new Error('business work failed'); } } : {}),
        });
        const rejected = await completion.then(() => undefined, (error: unknown) => error);
        expect(rejected).toBeInstanceOf(Error);
        if (failure.endsWith('js')) expect(rejected).toBe(jsFailure);
        if (failure.startsWith('caught-')) expect(rejected).toBe(caught);
        await expectRolledBack(data);
        // A failed transaction must not poison the next independent operation.
        const recovered = account();
        await writer(mode)(recovered);
        const recoveredRows = await rows(recovered);
        expect(recoveredRows.business).toHaveLength(1);
        expect(recoveredRows.audit).toHaveLength(1);
        expect(recoveredRows.events).toHaveLength(1);
      },
    );

    it('retains both durable events when transaction B commits before earlier transaction A', async () => {
      const tenantId = `reversed-${randomUUID()}`;
      const a = account(tenantId);
      const b = account(tenantId);
      const stagedA = deferred();
      const commitA = deferred();
      const write = writer(mode);
      const pendingA = write(a, {
        afterWrite: async () => { stagedA.resolve(); await commitA.promise; },
      });
      try {
        await Promise.race([stagedA.promise, pendingA.then(() => { throw new Error('A ended before staging'); })]);
        await write(b);
        expect((await rows(a)).events).toEqual([]);
        expect((await rows(b)).events).toHaveLength(1);
      } finally {
        commitA.resolve();
        await pendingA;
      }
      const resultA = await rows(a);
      const resultB = await rows(b);
      expect(resultA.events).toHaveLength(1);
      expect(resultB.events).toHaveLength(1);
      expect(resultA.events[0].audit_id).not.toBe(resultB.events[0].audit_id);
      const ordering = await asRuntime(tenantId, tx => tx.$queryRawUnsafe(
        `SELECT a.created_at < b.created_at AS "aStartedFirst"
         FROM ${tableName} a, ${tableName} b WHERE a.target_id = $1 AND b.target_id = $2`, a.id, b.id,
      ));
      expect(ordering).toEqual([{ aStartedFirst: true }]);
    });

    it('isolates concurrent tenant contexts and unfiltered reads through actual PostgreSQL RLS', async () => {
      const data = [account(), account()];
      const bothStaged = deferred();
      let staged = 0;
      const write = writer(mode);
      await Promise.all(data.map(value => write(value, {
        afterWrite: async tx => {
          if (++staged === 2) bothStaged.resolve();
          await bothStaged.promise;
          expect(tenant.getStore()).toBe(value.tenantId);
          expect(AuditContext.getActor()?.id).toBe(`actor-${value.tenantId}`);
          expect(await tx.deliveryAccount.findMany({ select: { id: true } })).toEqual([{ id: value.id }]);
          const audit = await tx.$queryRawUnsafe(`SELECT tenant_id, actor_id FROM ${tableName}`);
          expect(audit).toEqual([{ tenant_id: value.tenantId, actor_id: `actor-${value.tenantId}` }]);
          const events = await tx.$queryRawUnsafe(`SELECT payload FROM ${eventTable}`);
          expect(events).toEqual([{ payload: expect.objectContaining({
            tenantId: value.tenantId, actorId: `actor-${value.tenantId}`,
            correlationId: `correlation-${value.id}`, targetId: value.id,
          }) }]);
        },
      })));
      for (const own of data) {
        const other = data.find(value => value !== own)!;
        await asRuntime(own.tenantId, async tx => {
          expect(await tx.deliveryAccount.findUnique({ where: { id: other.id } })).toBeNull();
          expect(await tx.$queryRawUnsafe(`SELECT id FROM ${tableName} WHERE target_id = $1`, other.id)).toEqual([]);
          expect(await tx.$queryRawUnsafe(`SELECT audit_id FROM ${eventTable} WHERE payload->>'targetId' = $1`, other.id)).toEqual([]);
        });
      }
    });
  });

  it.each(['business', 'audit', 'delivery'] as const)('rejects a direct cross-tenant %s INSERT at the database boundary', async table => {
    const own = account();
    const other = account();
    await writer('manual')(other);
    const otherAuditId = (await rows(other)).audit[0].id;
    await expect(asRuntime(own.tenantId, async tx => {
      if (table === 'business') {
        await tx.deliveryAccount.create({ data: { ...own, tenantId: other.tenantId } });
      } else if (table === 'audit') {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${tableName} (tenant_id, action) VALUES ($1, 'unauthorized')`, other.tenantId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${eventTable} (audit_id, tenant_id, action, payload)
           VALUES ($1::uuid, $2, 'unauthorized', '{}'::jsonb)`, otherAuditId, other.tenantId,
        );
      }
    })).rejects.toThrow(/row.level security/i);
    await expectRolledBack(own);
    expect((await rows(other)).events).toHaveLength(1);
  });
});
