import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AuditContext, AuditService } from '../../src';
import type { AuditOperationEvent } from '../../src/interfaces/audit-shared-options.interface';
import type { AuditLogModuleOptions } from '../../src/interfaces/audit-log-options.interface';
import { applyAuditTableSchema } from '../../src/sql';
import { createTestPrismaClient, prismaModule } from './prisma-client';

describe('managed manual audit product behavior E2E', () => {
  const base = createTestPrismaClient();
  const transactionHost: {
    $transaction<T>(callback: (tx: typeof base) => Promise<T>, options?: Record<string, unknown>): Promise<T>;
  } = base;
  const tableName = `manual_quality_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const tenant = new AsyncLocalStorage<string>();
  const ownedIds = new Set<string>();
  const actor = { id: 'manual-quality-actor', type: 'user' as const };
  const logger = { warn: jest.fn(), error: jest.fn() };

  function service(overrides: Partial<AuditLogModuleOptions> = {}): AuditService {
    return new AuditService({
      prisma: base, prismaModule, tableName, actorExtractor: () => actor,
      actorRequired: true, tenantRequired: true,
      tenantResolver: () => tenant.getStore() ?? null, logger,
      ...overrides,
    });
  }

  function business() {
    const id = randomUUID();
    ownedIds.add(id);
    return { id, name: 'Manual quality', email: `${id}@manual-quality.test`, password: 'secret' };
  }

  async function rowCounts(id: string) {
    const [row] = await base.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "${tableName}" WHERE target_id = $1`, id,
    );
    return { business: await base.user.count({ where: { id } }), audit: Number(row.count) };
  }

  function context<T>(operation: () => T, tenantId = 'manual-quality-tenant'): T {
    return tenant.run(tenantId, () => AuditContext.runAs(actor, operation));
  }

  beforeAll(async () => { await applyAuditTableSchema(base, { tableName, enforcement: 'trigger' }); });
  afterAll(async () => {
    await base.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
    await base.user.deleteMany({ where: { id: { in: [...ownedIds] } } });
    await base.$disconnect();
  });

  it('commits business and audit together despite failing telemetry and snapshots input at log invocation', async () => {
    const data = business();
    const events: AuditOperationEvent[] = [];
    const audit = service({
      strictManualValidation: true,
      onAuditOperation: (event): unknown => {
        events.push(event);
        return Promise.reject(new Error('telemetry unavailable'));
      },
    });
    const result = await context(() => audit.withManualTransaction(transactionHost, async ({ tx, log }) => {
      await tx.user.create({ data });
      const input = { action: 'User.created', targetType: 'User', targetId: data.id, metadata: { value: 'original' } };
      const pending = log(input);
      input.action = 'mutated';
      input.metadata.value = 'mutated';
      await pending;
      expect(events.some(event => event.operation === 'transaction')).toBe(false);
      return data.id;
    }));
    expect(result).toBe(data.id);
    expect(await rowCounts(data.id)).toEqual({ business: 1, audit: 1 });
    const resultPage = await audit.query({ targetId: data.id, tenantId: 'manual-quality-tenant' });
    expect(resultPage.entries[0]).toMatchObject({ action: 'User.created', metadata: { value: 'original' } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'log', status: 'success', transaction: 'external' }),
      expect.objectContaining({ operation: 'transaction', status: 'success', transaction: 'managed' }),
    ]));
    expect(events.every(event => Number.isFinite(event.durationMs) && event.durationMs >= 0 && Object.isFrozen(event))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(data.id);
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it.each(['actor', 'serialization', 'strict-input', 'metadata-budget'] as const)(
    'rolls back prior business and audit writes after a caught %s failure', async scenario => {
      const data = business();
      const onAuditError = jest.fn();
      const audit = service({
        onAuditError,
        strictManualValidation: scenario === 'strict-input',
        ...(scenario === 'metadata-budget' ? { maxMetadataBytes: 32 } : {}),
      });
      let caught: unknown;
      const completion = context(() => audit.withManualTransaction(transactionHost, async ({ tx, log }) => {
        await tx.user.create({ data });
        await log({ action: 'User.created', targetType: 'User', targetId: data.id });
        try {
          if (scenario === 'actor') {
            await AuditContext.run({ actor: null, noAudit: false }, () => log({ action: 'invalid', targetId: data.id }));
          } else if (scenario === 'serialization') {
            await log({ action: 'invalid', targetId: data.id, metadata: { bigint: 1n } });
          } else if (scenario === 'strict-input') {
            await log({ action: ' ', targetId: data.id });
          } else {
            await log({ action: 'oversized', targetId: data.id, metadata: { text: '한글'.repeat(20) } });
          }
        } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(Error);
        expect(await tx.user.count({ where: { id: data.id } })).toBe(1);
      }));
      const rejected = await completion.then(() => undefined, (error: unknown) => error);
      expect(rejected).toBe(caught);
      expect(caught).toBeInstanceOf(Error);
      expect(await rowCounts(data.id)).toEqual({ business: 0, audit: 0 });
      expect(onAuditError).toHaveBeenCalledTimes(1);
      expect(onAuditError).toHaveBeenCalledWith(caught, expect.objectContaining({ operation: 'log', provider: 'postgresql' }));
    },
  );

  it('keeps a caught SQL audit error fatal and recovers for the next transaction', async () => {
    const data = business();
    const audit = service();
    const constraint = `ck_${tableName}`;
    await base.$executeRawUnsafe(`ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraint}" CHECK (action <> 'blocked')`);
    let caught: unknown;
    try {
      const completion = context(() => audit.withManualTransaction(transactionHost, async ({ tx, log }) => {
        await tx.user.create({ data });
        try { await log({ action: 'blocked', targetId: data.id }); } catch (error) { caught = error; }
      }));
      const rejected = await completion.then(() => undefined, (error: unknown) => error);
      expect(rejected).toBe(caught);
      expect(caught).toBeDefined();
      expect(await rowCounts(data.id)).toEqual({ business: 0, audit: 0 });
    } finally {
      await base.$executeRawUnsafe(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraint}"`);
    }
    const recovered = business();
    await context(() => audit.withManualTransaction(transactionHost, async ({ tx, log }) => {
      await tx.user.create({ data: recovered });
      await log({ action: 'recovered', targetId: recovered.id });
    }));
    expect(await rowCounts(recovered.id)).toEqual({ business: 1, audit: 1 });
  });

  it('isolates concurrent helpers and revokes a writer after its transaction ends', async () => {
    const audit = service();
    const rows = [business(), business()];
    let retained: ((input: { action: string; targetId: string }) => Promise<void>) | undefined;
    await Promise.all(rows.map((data, index) => context(() => audit.withManualTransaction(transactionHost, async ({ tx, log }) => {
      await tx.user.create({ data });
      await log({ action: 'concurrent', targetId: data.id });
      if (index === 0) retained = log;
    }), `manual-tenant-${index}`)));
    for (let index = 0; index < rows.length; index++) {
      const page = await audit.query({ tenantId: `manual-tenant-${index}`, targetId: rows[index].id });
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0].tenantId).toBe(`manual-tenant-${index}`);
    }
    await expect(retained!({ action: 'expired', targetId: rows[0].id })).rejects.toThrow('scope has ended');
    expect(await rowCounts(rows[0].id)).toEqual({ business: 1, audit: 1 });
  });
});
