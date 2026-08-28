import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext } from '../src/services/audit-context';
import {
  createCreateHandler,
  createCreateManyHandler,
  createDeleteHandler,
  createDeleteManyHandler,
  createOperationHandlers,
  createUpdateHandler,
  createUpdateManyHandler,
  createUpsertHandler,
} from '../src/prisma/audit-extension/operation-handlers';
import type {
  LifecycleSuppressionScope,
  OperationHandlerDependencies,
  OperationHandlers,
} from '../src/prisma/audit-extension/operation-handlers';
import type { AuditExtensionOptions } from '../src/prisma/audit-extension';

const actor = { id: 'handler-user', type: 'user' as const };

const operationCases: Array<{
  operation: keyof OperationHandlers;
  args: any;
}> = [
  { operation: 'create', args: { data: { name: 'Created' } } },
  {
    operation: 'update',
    args: { where: { id: 'u1' }, data: { name: 'Updated' } },
  },
  { operation: 'delete', args: { where: { id: 'u1' } } },
  {
    operation: 'upsert',
    args: {
      where: { id: 'u1' },
      create: { name: 'Created' },
      update: { name: 'Updated' },
    },
  },
  { operation: 'createMany', args: { data: [{ name: 'Created' }] } },
  {
    operation: 'updateMany',
    args: { where: {}, data: { name: 'Updated' } },
  },
  { operation: 'deleteMany', args: { where: {} } },
];

const failureCases: Array<{
  operation: keyof OperationHandlers;
  action: string;
  args: any;
}> = [
  {
    operation: 'delete',
    action: 'User.deleted',
    args: { where: { id: 'u1' } },
  },
  {
    operation: 'upsert',
    action: 'User.upserted',
    args: {
      where: { id: 'u1' },
      create: { name: 'Created' },
      update: { name: 'Updated' },
    },
  },
  {
    operation: 'createMany',
    action: 'User.createdMany',
    args: { data: [{ name: 'Created' }] },
  },
  {
    operation: 'updateMany',
    action: 'User.updatedMany',
    args: { where: {}, data: { name: 'Updated' } },
  },
  {
    operation: 'deleteMany',
    action: 'User.deletedMany',
    args: { where: {} },
  },
];

function buildMockClient() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

function createFixture(input: {
  consistency?: AuditExtensionOptions['consistency'];
  logFailures?: boolean;
  transactionClient?: any;
} = {}) {
  const client = buildMockClient();
  const options: AuditExtensionOptions = {
    consistency: input.consistency ?? 'best-effort',
    trackedModels: ['User'],
    logFailures: input.logFailures,
    logger: { warn: jest.fn(), error: jest.fn() },
  };
  const lifecycleSuppressionScope =
    new AsyncLocalStorage<LifecycleSuppressionScope>();
  const dependencies: OperationHandlerDependencies = {
    client,
    options,
    Prisma: { defineExtension: jest.fn() },
    trackedModels: options.trackedModels,
    ignoredModels: options.ignoredModels,
    sensitiveFieldsFor: () => [],
    getTransactionClient: () => input.transactionClient,
    lifecycleSuppressionScope,
  };

  return {
    client,
    handlers: createOperationHandlers(dependencies),
    dependencies,
  };
}

describe('audit operation handler factories', () => {
  it('composes the exact seven independently exported handlers', async () => {
    const factories = [
      createCreateHandler,
      createUpdateHandler,
      createDeleteHandler,
      createUpsertHandler,
      createCreateManyHandler,
      createUpdateManyHandler,
      createDeleteManyHandler,
    ];
    const { client, handlers } = createFixture();
    const created = { id: 'u1', name: 'Created' };
    client.user.findFirst.mockResolvedValue(created);
    const query = jest.fn().mockResolvedValue(created);

    expect(Object.keys(handlers)).toEqual([
      'create',
      'update',
      'delete',
      'upsert',
      'createMany',
      'updateMany',
      'deleteMany',
    ]);
    for (const factory of factories) {
      expect(typeof factory).toBe('function');
    }

    const result = await AuditContext.run(
      { actor, noAudit: false },
      () =>
        handlers.create({
          model: 'User',
          args: { data: { name: 'Created' } },
          query,
        }),
    );

    expect(result).toBe(created);
    expect(query).toHaveBeenCalledTimes(1);
    expect(client.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it.each(operationCases)(
    'keeps noAudit ahead of atomic routing for $operation',
    async ({ operation, args }) => {
      const { client, handlers } = createFixture({
        consistency: 'atomic-required',
      });
      const expected = { operation };
      const query = jest.fn().mockResolvedValue(expected);

      const result = await AuditContext.run(
        { actor, noAudit: true },
        () => handlers[operation]({ model: 'User', args, query }),
      );

      expect(result).toBe(expected);
      expect(query).toHaveBeenCalledWith(args);
      expect(client.user.findFirst).not.toHaveBeenCalled();
      expect(client.user.findMany).not.toHaveBeenCalled();
      expect(client.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it.each(failureCases)(
    'records and rethrows a best-effort $operation failure',
    async ({ operation, action, args }) => {
      const { client, handlers } = createFixture({ logFailures: true });
      client.user.findFirst.mockResolvedValue(null);
      client.user.findMany.mockResolvedValue([]);
      const businessError: any = new Error(`${operation} failed`);
      businessError.code = 'P2000';
      const query = jest.fn().mockRejectedValue(businessError);

      await expect(
        AuditContext.run(
          { actor, noAudit: false },
          () => handlers[operation]({ model: 'User', args, query }),
        ),
      ).rejects.toBe(businessError);

      expect(client.$executeRaw).toHaveBeenCalledTimes(1);
      const values = client.$executeRaw.mock.calls[0].slice(1);
      expect(values[4]).toBe(action);
      expect(JSON.parse(values[9])).toEqual({
        operation,
        error: {
          name: 'Error',
          code: 'P2000',
          message: `${operation} failed`,
        },
      });
      expect(values[10]).toBe('failure');
    },
  );

  it('fails closed when atomic deleteMany count differs from preimages', async () => {
    const transactionClient = buildMockClient();
    const record = { id: 'u1', name: 'Captured' };
    transactionClient.user.findMany.mockResolvedValue([record]);
    transactionClient.user.findFirst.mockResolvedValue(record);
    const { handlers } = createFixture({
      consistency: 'atomic-required',
      transactionClient,
    });
    const query = jest.fn().mockResolvedValue({ count: 0 });

    await expect(
      handlers.deleteMany({ model: 'User', args: { where: {} }, query }),
    ).rejects.toThrow(
      'affected 0 records but captured 1 preimages',
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(transactionClient.$executeRaw).not.toHaveBeenCalled();
  });
});
