import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext } from '../src/services/audit-context';
import { AuditService } from '../src/services/audit.service';
import { snapshotAuditActor } from '../src/utils/actor';
import { buildAuditInsertParams } from '../src/prisma/audit-extension/audit-insert';
import { createOperationHandlers } from '../src/prisma/audit-extension/operation-handlers';
import type { OperationHandlerDependencies } from '../src/prisma/audit-extension/operation-handlers';
import type { AuditActor } from '../src/interfaces/actor.interface';

const operations = ['create', 'update', 'delete', 'upsert', 'createMany', 'updateMany', 'deleteMany'] as const;
const logger = { warn: jest.fn(), error: jest.fn() };
const input = { action: 'User.created', targetType: 'User', targetId: 'u1', changes: {} };
const invalidActors = [null, ...[null, '', ' \t\n', undefined, 42].map(id => ({ id, type: 'system' }) as AuditActor)];

function fixture(consistency: 'atomic-required' | 'best-effort' = 'best-effort') {
  const client = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'u1', name: 'Before' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]),
    },
  };
  const dependencies: OperationHandlerDependencies = {
    client,
    options: { consistency, actorRequired: true, logger, onAuditError: jest.fn(), markAtomicFailure: jest.fn() },
    Prisma: { defineExtension: jest.fn() },
    trackedModels: ['User'],
    sensitiveFieldsFor: () => [],
    getTransactionClient: () => client,
    lifecycleSuppressionScope: new AsyncLocalStorage(),
    unsupportedOperationWarnings: new Set(),
  };
  return { client, dependencies, handlers: createOperationHandlers(dependencies) };
}

function manualFixture() {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(1), $queryRaw: jest.fn().mockResolvedValue([]) };
  const options = {
    prisma, actorRequired: true, logger, onAuditError: jest.fn(),
    actorExtractor: () => ({ id: null, type: 'system' as const }),
    prismaModule: { Prisma: {
      defineExtension: jest.fn(),
      sql: (strings: TemplateStringsArray | readonly string[], ...values: any[]) => ({ strings, values }),
      join: jest.fn(), empty: {},
    } },
  };
  return { prisma, options, service: new AuditService(options) };
}

describe('actorRequired policy', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['user', 'system', 'api_key'] as const)('accepts %s IDs without trimming and copies identity', type => {
    const actor = { id: ' actor-1 ', type, ip: '127.0.0.1' };
    const snapshot = snapshotAuditActor(actor, true);
    actor.id = 'changed';
    expect(snapshot).toEqual({ id: ' actor-1 ', type, ip: '127.0.0.1' });
  });

  it.each(invalidActors)('rejects invalid actor %j in direct insert construction', actor => {
    const onAuditError = jest.fn();
    AuditContext.run({ actor, noAudit: false }, () => {
      expect(buildAuditInsertParams(input, { actorRequired: true, onAuditError })).toBeNull();
      expect(onAuditError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ phase: 'context' }));
      expect(() => buildAuditInsertParams(input, { actorRequired: true, consistency: 'atomic-required', onAuditError })).toThrow('actorRequired');
    });
  });

  it.each(operations)('%s rejects before any DB I/O and marks atomic failure', async operation => {
    const { client, dependencies, handlers } = fixture('atomic-required');
    const query = jest.fn();
    await expect(handlers[operation]({ model: 'User', args: {}, query })).rejects.toThrow('actorRequired');
    expect(query).not.toHaveBeenCalled();
    expect(client.user.findFirst).not.toHaveBeenCalled();
    expect(client.user.findMany).not.toHaveBeenCalled();
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(dependencies.options.markAtomicFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(dependencies.options.onAuditError).toHaveBeenCalledWith(expect.any(Error), { phase: 'context', model: 'User', operation });
  });

  it.each(operations)('%s preserves best-effort result and original business error, even if reporters fail', async operation => {
    const { client, dependencies, handlers } = fixture();
    dependencies.options.logFailures = true;
    dependencies.options.onAuditError = () => { throw new Error('hook'); };
    dependencies.options.logger = { warn: () => { throw new Error('warn'); }, error: () => { throw new Error('logger'); } };
    const args = { data: { name: 'secret' } };
    const result = { count: 1 };
    const query = jest.fn().mockResolvedValue(result);
    expect(await handlers[operation]({ model: 'User', args, query })).toBe(result);
    expect(query).toHaveBeenCalledWith(args);
    const businessError = new Error('business');
    query.mockRejectedValue(businessError);
    await expect(handlers[operation]({ model: 'User', args, query })).rejects.toBe(businessError);
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(client.user.findFirst).not.toHaveBeenCalled();
    expect(client.user.findMany).not.toHaveBeenCalled();
  });

  it.each(operations)('%s uses the actor captured before the query for every row', async operation => {
    const { client, handlers } = fixture();
    const actor: AuditActor = { id: 'original', type: 'api_key', ip: '127.0.0.1' };
    await AuditContext.runAs(actor, () => handlers[operation]({
      model: 'User', args: { where: { id: 'u1' }, data: {}, create: {}, update: {} },
      query: async () => {
        actor.id = 'mutated';
        actor.type = 'system';
        actor.ip = 'changed';
        AuditContext.getStore()!.actor = null;
        return { id: 'u1', name: 'After', count: 2 };
      },
    }));
    expect(client.$executeRaw).toHaveBeenCalledTimes(operation === 'deleteMany' ? 2 : 1);
    for (const call of client.$executeRaw.mock.calls) {
      expect(call.slice(2, 5)).toEqual(['original', 'api_key', '127.0.0.1']);
    }
  });

  it('uses the original actor for failure rows too', async () => {
    const { client, dependencies, handlers } = fixture();
    dependencies.options.logFailures = true;
    const actor: AuditActor = { id: 'original', type: 'user' };
    const error = new Error('business failure');
    await expect(AuditContext.runAs(actor, () => handlers.create({
      model: 'User', args: {}, query: async () => { actor.id = ''; throw error; },
    }))).rejects.toBe(error);
    expect(client.$executeRaw.mock.calls[0].slice(2, 4)).toEqual(['original', 'user']);
  });

  it.each(operations)('%s honors tracking exclusions before requiring an actor', async operation => {
    const { client, dependencies, handlers } = fixture('atomic-required');
    const query = jest.fn().mockResolvedValue('result');
    expect(await handlers[operation]({ model: 'Excluded', args: {}, query })).toBe('result');
    expect(await AuditContext.run({ actor: null, noAudit: true }, () => handlers[operation]({ model: 'User', args: {}, query }))).toBe('result');
    expect(dependencies.options.onAuditError).not.toHaveBeenCalled();
    expect(client.$executeRaw).not.toHaveBeenCalled();
  });

  it('keeps default false null/system compatibility', async () => {
    const { client, dependencies, handlers } = fixture();
    delete dependencies.options.actorRequired;
    await handlers.create({ model: 'User', args: {}, query: async () => ({ id: 'u1' }) });
    expect(client.$executeRaw.mock.calls[0].slice(2, 4)).toEqual([null, 'system']);
  });

  it.each(invalidActors)('manual log rejects invalid actor %j, including NoAudit and explicit tx', async actor => {
    const { prisma, options, service } = manualFixture();
    const tx = { $executeRaw: jest.fn() };
    for (const client of [undefined, tx]) {
      await expect(AuditContext.run({ actor, noAudit: true }, () => service.log(input, client))).rejects.toThrow('actorRequired');
    }
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(options.onAuditError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ phase: 'context', model: 'User', operation: 'log' }));
  });

  it.each(['user', 'system', 'api_key'] as const)('manual log accepts %s and snapshots before tenant resolution', async type => {
    const { prisma, options } = manualFixture();
    const actor: AuditActor = { id: ' actor ', type };
    const service = new AuditService({ ...options, tenantResolver: () => { actor.id = ''; return 'tenant'; } });
    await AuditContext.runAs(actor, () => service.log(input));
    expect(prisma.$executeRaw.mock.calls[0][0].values.slice(0, 3)).toEqual(['tenant', ' actor ', type]);
  });

  it('manual policy rejection survives throwing reporters', async () => {
    const { prisma, options } = manualFixture();
    const service = new AuditService({ ...options,
      onAuditError: () => { throw new Error('hook'); },
      logger: { warn: jest.fn(), error: () => { throw new Error('logger'); } },
    });
    await expect(service.log(input)).rejects.toThrow('actorRequired');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('read, scan and CSV remain usable without an actor', async () => {
    const { service, options } = manualFixture();
    await service.query({ includeTotal: false });
    await service.getById('11111111-1111-4111-8111-111111111111');
    for await (const page of service.scan({ allTenants: true })) expect(page.entries).toEqual([]);
    const chunks = [];
    for await (const chunk of service.exportCsv({ allTenants: true })) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    expect(options.onAuditError).not.toHaveBeenCalled();
  });
});
