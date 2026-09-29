import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext } from '../src/services/audit-context';
import type { AuditExtensionOptions } from '../src/prisma/audit-extension';
import { _resetNestedWriteWarnings } from '../src/prisma/audit-extension/mutation-policy';
import {
  createOperationHandlers,
  type LifecycleSuppressionScope,
  type OperationHandlerDependencies,
} from '../src/prisma/audit-extension/operation-handlers';

const directNestedWrites = [
  {
    label: 'create',
    operation: 'create' as const,
    args: { data: { leaves: { create: { name: 'Tracked child' } } } },
  },
  {
    label: 'update',
    operation: 'update' as const,
    args: {
      where: { id: 'root-1' },
      data: { leaves: { update: { where: { id: 'leaf-1' }, data: { name: 'Updated' } } } },
    },
  },
  {
    label: 'upsert create branch',
    operation: 'upsert' as const,
    args: {
      where: { id: 'root-1' },
      create: { leaves: { create: { name: 'Tracked child' } } },
      update: {},
    },
  },
  {
    label: 'upsert update branch',
    operation: 'upsert' as const,
    args: {
      where: { id: 'root-1' },
      create: {},
      update: { leaves: { connect: { id: 'leaf-1' } } },
    },
  },
];

const trackedDescendant = { leaves: { create: { name: 'Tracked descendant' } } };
const deepNestedWrites = [
  { label: 'create object', payload: { create: trackedDescendant } },
  { label: 'create array', payload: { create: [{ name: 'Untracked branch' }, trackedDescendant] } },
  {
    label: 'upsert create branch',
    payload: { upsert: { where: { id: 'branch-1' }, create: trackedDescendant, update: {} } },
  },
  {
    label: 'upsert update branch',
    payload: { upsert: { where: { id: 'branch-1' }, create: {}, update: trackedDescendant } },
  },
  {
    label: 'connectOrCreate create branch',
    payload: { connectOrCreate: { where: { id: 'branch-1' }, create: trackedDescendant } },
  },
  {
    label: 'update data wrapper',
    payload: { update: { where: { id: 'branch-1' }, data: trackedDescendant } },
  },
  { label: 'update direct data', payload: { update: trackedDescendant } },
];

function createFixture(
  consistency: AuditExtensionOptions['consistency'] = 'atomic-required',
) {
  const client = { $executeRaw: jest.fn() };
  const logger = { warn: jest.fn(), error: jest.fn() };
  const options: AuditExtensionOptions = {
    consistency,
    trackedModels: ['Leaf'],
    logger,
  };
  const dependencies: OperationHandlerDependencies = {
    client,
    options,
    unsupportedOperationWarnings: new Set(),
    Prisma: {
      defineExtension: jest.fn(),
      dmmf: {
        datamodel: {
          models: [
            {
              name: 'Root',
              fields: [
                { name: 'leaves', kind: 'object', type: 'Leaf' },
                { name: 'branch', kind: 'object', type: 'Branch' },
                { name: 'branches', kind: 'object', type: 'Branch' },
                { name: 'metadata', kind: 'scalar', type: 'Json' },
              ],
            },
            {
              name: 'Branch',
              fields: [
                { name: 'leaves', kind: 'object', type: 'Leaf' },
                { name: 'leaf', kind: 'object', type: 'Leaf' },
                { name: 'archives', kind: 'object', type: 'Archive' },
                { name: 'data', kind: 'scalar', type: 'Json' },
                { name: 'metadata', kind: 'scalar', type: 'Json' },
              ],
            },
            { name: 'Leaf', fields: [] },
            { name: 'Archive', fields: [] },
          ],
        },
      },
    },
    trackedModels: options.trackedModels,
    sensitiveFieldsFor: () => [],
    getTransactionClient: () => undefined,
    lifecycleSuppressionScope: new AsyncLocalStorage<LifecycleSuppressionScope>(),
  };

  return { client, logger, dependencies, handlers: createOperationHandlers(dependencies) };
}

describe('nested writes through untracked models', () => {
  beforeEach(() => {
    _resetNestedWriteWarnings();
  });

  it.each(directNestedWrites)(
    'rejects $label to a tracked child before running the untracked parent query',
    async ({ operation, args }) => {
      const { client, handlers } = createFixture();
      const query = jest.fn().mockResolvedValue({ id: 'root-1' });

      await expect(
        handlers[operation]({ model: 'Root', args, query }),
      ).rejects.toThrow('does not support nested writes');

      expect(query).not.toHaveBeenCalled();
      expect(client.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it.each(deepNestedWrites)(
    'finds tracked descendants through an untracked intermediary in nested $label',
    async ({ payload }) => {
      const { handlers } = createFixture();
      const query = jest.fn().mockResolvedValue({ id: 'root-1' });

      await expect(
        handlers.create({
          model: 'Root',
          args: { data: { branches: payload } },
          query,
        }),
      ).rejects.toThrow('does not support nested writes');

      expect(query).not.toHaveBeenCalled();
    },
  );

  it('checks sibling relations when a nested to-one update has a JSON field named data', async () => {
    const { handlers } = createFixture();
    const query = jest.fn().mockResolvedValue({ id: 'root-1' });

    await expect(
      handlers.update({
        model: 'Root',
        args: {
          where: { id: 'root-1' },
          data: {
            branch: {
              update: {
                data: { someJson: true },
                leaf: { create: { name: 'Tracked descendant' } },
              },
            },
          },
        },
        query,
      }),
    ).rejects.toThrow('does not support nested writes');

    expect(query).not.toHaveBeenCalled();
  });

  it('allows a nested chain that only writes untracked models', async () => {
    const { client, handlers, logger } = createFixture();
    const args = {
      data: { branches: { create: { archives: { create: { name: 'Untracked' } } } } },
    };
    const expected = { id: 'root-1' };
    const query = jest.fn().mockResolvedValue(expected);

    await expect(
      handlers.create({ model: 'Root', args, query }),
    ).resolves.toBe(expected);

    expect(query).toHaveBeenCalledWith(args);
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('allows nested writes without DMMF when an empty allowlist explicitly disables auditing', async () => {
    const { client, logger, dependencies } = createFixture();
    const handlers = createOperationHandlers({
      ...dependencies,
      options: { ...dependencies.options, trackedModels: [] },
      trackedModels: [],
      Prisma: { defineExtension: jest.fn() },
    });
    const args = { data: { leaves: { create: { name: 'Untracked child' } } } };
    const expected = { id: 'root-1' };
    const query = jest.fn().mockResolvedValue(expected);

    await expect(
      handlers.create({ model: 'Root', args, query }),
    ).resolves.toBe(expected);

    expect(query).toHaveBeenCalledWith(args);
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not treat JSON scalar keys as nested writes at either model depth', async () => {
    const { handlers, logger } = createFixture();
    const metadata = { create: { leaves: { update: { name: 'JSON value' } } } };
    const args = { data: { metadata, branches: { create: { metadata } } } };
    const expected = { id: 'root-1' };
    const query = jest.fn().mockResolvedValue(expected);

    await expect(
      handlers.create({ model: 'Root', args, query }),
    ).resolves.toBe(expected);

    expect(query).toHaveBeenCalledWith(args);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(directNestedWrites)(
    'preserves the intentional NoAudit bypass for $label',
    async ({ operation, args }) => {
      const { client, handlers, logger } = createFixture();
      const expected = { id: 'root-1' };
      const query = jest.fn().mockResolvedValue(expected);

      await expect(
        AuditContext.run(
          { actor: null, noAudit: true },
          () => handlers[operation]({ model: 'Root', args, query }),
        ),
      ).resolves.toBe(expected);

      expect(query).toHaveBeenCalledWith(args);
      expect(client.$executeRaw).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('warns once and allows repeated best-effort writes through an untracked parent', async () => {
    const { client, handlers, logger } = createFixture('best-effort');
    const args = { data: { leaves: { create: { name: 'Tracked child' } } } };
    const expected = { id: 'root-1' };
    const query = jest.fn().mockResolvedValue(expected);

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        handlers.create({ model: 'Root', args, query }),
      ).resolves.toBe(expected);
    }

    expect(query).toHaveBeenCalledTimes(2);
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('nested write on Root.leaves is not audited'),
    );
  });
});
