import { AuditContext } from '../src/services/audit-context';
import {
  createAuditExtension,
  _resetNestedWriteWarnings,
  _resetTxAuditWarning,
} from '../src/prisma/audit-extension';

/**
 * Mock @prisma/client — capture the factory passed to Prisma.defineExtension
 * so we can invoke query handlers directly without a real DB.
 */
let capturedFactory: (client: any) => any;

jest.mock('@prisma/client', () => ({
  Prisma: {
    defineExtension: jest.fn((factory: any) => {
      capturedFactory = factory;
      return factory;
    }),
    sql: jest.fn(
      (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
    ),
  },
}));

function buildMockClient(overrides: Record<string, any> = {}) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $extends: jest.fn((ext: any) => ext),
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    post: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    ...overrides,
  };
}

/**
 * Extracts query handlers from the extension by calling the factory
 * with a mock client and returning the $allModels handlers.
 */
function getHandlers(
  options: Omit<Parameters<typeof createAuditExtension>[0], 'consistency'> & {
    consistency?: 'atomic-required' | 'best-effort';
  } = { trackedModels: ['User'] },
) {
  createAuditExtension({ consistency: 'best-effort', ...options });
  const mockClient = buildMockClient();
  const extended = capturedFactory(mockClient);

  // extended is the result of client.$extends({ query: { $allModels: { ... } } })
  // We need to extract the handlers from the $extends call
  const extendCall = mockClient.$extends.mock.calls[0][0];
  const handlers = extendCall.query.$allModels;

  return { handlers, clientMethods: extendCall.client, mockClient };
}

describe('createAuditExtension — query handlers', () => {
  const defaultActor = { id: 'user-1', type: 'user' as const, ip: '10.0.0.1' };

  afterEach(() => {
    jest.clearAllMocks();
    _resetNestedWriteWarnings();
    _resetTxAuditWarning();
  });

  describe('factory configuration', () => {
    it('requires an explicit consistency mode', () => {
      expect(() => createAuditExtension({} as any)).toThrow(
        'consistency must be explicitly set',
      );
    });

    it('warns and audits all models when no tracking lists are configured', async () => {
      const logger = {
        warn: jest.fn(),
        error: jest.fn(),
      };
      const { handlers, mockClient } = getHandlers({ logger });
      const created = { id: 'p1', title: 'Post' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.post.findFirst.mockResolvedValue(created);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'Post',
            args: { data: { title: 'Post' } },
            query: mockQuery,
          }),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('auditing ALL models'),
      );
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('uses the provided prismaModule namespace to define the extension', () => {
      const defineExtension = jest.fn((factory: any) => factory);

      createAuditExtension({
        consistency: 'best-effort',
        trackedModels: ['User'],
        prismaModule: {
          Prisma: {
            defineExtension,
          },
        },
      });

      expect(defineExtension).toHaveBeenCalledTimes(1);
    });

    it('throws a helpful error when prismaModule is missing defineExtension', () => {
      expect(() =>
        createAuditExtension({
          consistency: 'best-effort',
          trackedModels: ['User'],
          prismaModule: {
            Prisma: {} as any,
          },
        }),
      ).toThrow('prismaModule.Prisma.defineExtension is not a function');
    });

    it('throws a helpful error for invalid tableName', () => {
      expect(() =>
        createAuditExtension({
          consistency: 'best-effort',
          trackedModels: ['User'],
          tableName: 'audit-logs',
        }),
      ).toThrow('Invalid audit tableName');
    });

    it('validates batch limits and atomic overflow policy', () => {
      expect(() =>
        createAuditExtension({
          consistency: 'best-effort',
          maxBatchRecords: 0,
        }),
      ).toThrow('maxBatchRecords must be a positive integer');

      expect(() =>
        createAuditExtension({
          consistency: 'atomic-required',
          batchOverflow: 'summary',
        }),
      ).toThrow('only available in best-effort mode');
    });

    it('reports array transactions as outside the atomic contract', async () => {
      const { handlers } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
      });
      const query = jest.fn();

      await expect(
        handlers.create({
          model: 'User',
          args: { data: { name: 'Array' } },
          query,
          __internalParams: { transaction: { kind: 'batch' } },
        }),
      ).rejects.toThrow('does not support array $transaction([...])');
      expect(query).not.toHaveBeenCalled();
    });

    it('routes audit reads and inserts through the interactive transaction client when experimentalTxAudit is available', async () => {
      const txClient = buildMockClient();
      txClient.user.findFirst.mockResolvedValue({ id: 'u1', name: 'Alice' });
      const mockClient: any = buildMockClient({
        _createItxClient: jest.fn(() => txClient),
      });
      createAuditExtension({
        consistency: 'best-effort',
        trackedModels: ['User'],
        experimentalTxAudit: true,
      });
      capturedFactory(mockClient);
      const handlers = mockClient.$extends.mock.calls[0][0].query.$allModels;
      const created = { id: 'u1', name: 'Alice' };

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: jest.fn().mockResolvedValue(created),
            __internalParams: {
              transaction: { kind: 'itx', id: 'tx-1', payload: {} },
            },
          }),
      );

      expect(mockClient._createItxClient).toHaveBeenCalledWith({
        kind: 'itx',
        id: 'tx-1',
        payload: {},
      });
      expect(txClient.user.findFirst).toHaveBeenCalledTimes(1);
      expect(txClient.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('warns once and falls back when experimentalTxAudit cannot create a transaction client', async () => {
      const logger = { warn: jest.fn(), error: jest.fn() };
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        experimentalTxAudit: true,
        logger,
      });
      const created = { id: 'u1', name: 'Alice' };
      mockClient.user.findFirst.mockResolvedValue(created);

      for (let i = 0; i < 2; i++) {
        await AuditContext.run(
          { actor: defaultActor, noAudit: false },
          () =>
            handlers.create({
              model: 'User',
              args: { data: { name: 'Alice' } },
              query: jest.fn().mockResolvedValue(created),
              __internalParams: {
                transaction: { kind: 'itx', id: `tx-${i}`, payload: {} },
              },
            }),
        );
      }

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tx-aware audit unavailable'),
      );
      expect(
        logger.warn.mock.calls.filter(([message]) =>
          String(message).includes('tx-aware audit unavailable'),
        ),
      ).toHaveLength(1);
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('uses the configured tableName for automatic audit inserts', async () => {
      let localFactory: (client: any) => any = () => undefined;
      const raw = jest.fn((value: string) => ({ raw: value }));
      const defineExtension = jest.fn((factory: any) => {
        localFactory = factory;
        return factory;
      });
      createAuditExtension({
        consistency: 'best-effort',
        trackedModels: ['User'],
        tableName: 'audit.audit_logs',
        prismaModule: {
          Prisma: {
            defineExtension,
            raw,
          },
        },
      });
      const mockClient = buildMockClient();
      localFactory(mockClient);
      const handlers = mockClient.$extends.mock.calls[0][0].query.$allModels;
      const created = { id: 'u1', name: 'Alice' };
      mockClient.user.findFirst.mockResolvedValue(created);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: jest.fn().mockResolvedValue(created),
          }),
      );

      expect(raw).toHaveBeenCalledWith('audit.audit_logs');
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[0]).toEqual({ raw: 'audit.audit_logs' });
    });
  });

  describe('atomic-required transaction routing', () => {
    it('rejects a tracked write before the business query outside the helper', async () => {
      const { handlers } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const query = jest.fn();

      await expect(
        handlers.create({
          model: 'User',
          args: { data: { name: 'Alice' } },
          query,
        }),
      ).rejects.toThrow('must run inside withAuditTransaction()');
      expect(query).not.toHaveBeenCalled();
    });

    it('binds the official transaction client and forwards transaction options', async () => {
      const { handlers, clientMethods, mockClient } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const txClient = buildMockClient();
      const created = { id: 'u1', name: 'Alice' };
      txClient.user.findFirst.mockResolvedValue(created);
      const transactionOptions = {
        timeout: 10_000,
        maxWait: 5_000,
        isolationLevel: 'Serializable' as const,
      };
      const transactionHost = {
        $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) =>
          callback(txClient),
        ),
      };

      const result = await clientMethods.withAuditTransaction.call(
        transactionHost,
        (tx: any) =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: jest.fn().mockResolvedValue(created),
          }).then(() => tx),
        transactionOptions,
      );

      expect(result).toBe(txClient);
      expect(transactionHost.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        transactionOptions,
      );
      expect(txClient.user.findFirst).toHaveBeenCalledTimes(1);
      expect(txClient.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('fails closed when the atomic audit insert fails', async () => {
      const { handlers, clientMethods } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const txClient = buildMockClient({
        $executeRaw: jest.fn().mockRejectedValue(new Error('insert failed')),
      });
      const created = { id: 'u1', name: 'Alice' };
      txClient.user.findFirst.mockResolvedValue(created);
      const transactionHost = {
        $transaction: (callback: (tx: any) => Promise<any>) => callback(txClient),
      };

      await expect(
        clientMethods.withAuditTransaction.call(transactionHost, () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: jest.fn().mockResolvedValue(created),
          }),
        ),
      ).rejects.toThrow('insert failed');
    });

    it('locks and refreshes the immediate preimage before an atomic update', async () => {
      const { handlers, clientMethods } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const txClient = buildMockClient();
      txClient.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', name: 'Initial' })
        .mockResolvedValueOnce({ id: 'u1', name: 'Writer One' })
        .mockResolvedValueOnce({ id: 'u1', name: 'Writer Two' });
      const transactionHost = {
        $transaction: (callback: (tx: any) => Promise<any>) => callback(txClient),
      };

      await clientMethods.withAuditTransaction.call(transactionHost, () =>
        handlers.update({
          model: 'User',
          args: { where: { id: 'u1' }, data: { name: 'Writer Two' } },
          query: jest.fn().mockResolvedValue({ id: 'u1', name: 'Writer Two' }),
        }),
      );

      expect(txClient.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE',
        'u1',
      );
      expect(txClient.user.findFirst).toHaveBeenNthCalledWith(2, {
        where: { id: 'u1' },
      });
      const insertValues = txClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(insertValues[8])).toEqual({
        name: { before: 'Writer One', after: 'Writer Two' },
      });
    });

    it('fails closed when an atomic pre-read fails', async () => {
      const { handlers, clientMethods } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const txClient = buildMockClient();
      txClient.user.findFirst.mockRejectedValue(new Error('pre-read failed'));
      const query = jest.fn();
      const transactionHost = {
        $transaction: (callback: (tx: any) => Promise<any>) => callback(txClient),
      };

      await expect(
        clientMethods.withAuditTransaction.call(transactionHost, () =>
          handlers.update({
            model: 'User',
            args: { where: { id: 'u1' }, data: { name: 'After' } },
            query,
          }),
        ),
      ).rejects.toThrow('pre-read failed');
      expect(query).not.toHaveBeenCalled();
      expect(txClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('fails closed when an atomic post-read fails', async () => {
      const { handlers, clientMethods } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const txClient = buildMockClient();
      txClient.user.findFirst.mockRejectedValue(new Error('post-read failed'));
      const query = jest.fn().mockResolvedValue({ id: 'u1', name: 'Alice' });
      const transactionHost = {
        $transaction: (callback: (tx: any) => Promise<any>) => callback(txClient),
      };

      await expect(
        clientMethods.withAuditTransaction.call(transactionHost, () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query,
          }),
        ),
      ).rejects.toThrow('post-read failed');
      expect(query).toHaveBeenCalledTimes(1);
      expect(txClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects nested withAuditTransaction calls', async () => {
      const { clientMethods } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
      });
      const txClient = buildMockClient();
      const transactionHost = {
        $transaction: (callback: (tx: any) => Promise<any>) => callback(txClient),
      };

      await expect(
        clientMethods.withAuditTransaction.call(transactionHost, () =>
          clientMethods.withAuditTransaction.call(
            transactionHost,
            async () => undefined,
          ),
        ),
      ).rejects.toThrow('nested withAuditTransaction() calls are not supported');
    });
  });

  // ─── shouldSkip ──────────────────────────────────────────────

  describe('shouldSkip (noAudit / untracked model)', () => {
    it('skips audit when noAudit is true', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const mockQuery = jest.fn().mockResolvedValue({ id: '1', name: 'Alice' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: true },
        () => handlers.create({ model: 'User', args: { data: { name: 'Alice' } }, query: mockQuery }),
      );

      expect(mockQuery).toHaveBeenCalled();
      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('skips audit for untracked models', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const mockQuery = jest.fn().mockResolvedValue({ id: '1', title: 'Post' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'Post', args: { data: { title: 'Post' } }, query: mockQuery }),
      );

      expect(mockQuery).toHaveBeenCalled();
      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('tracks model when using ignoredModels and model is not ignored', async () => {
      const { handlers, mockClient } = getHandlers({ ignoredModels: ['Session'] });
      const mockQuery = jest.fn().mockResolvedValue({ id: '1', name: 'Alice' });
      mockClient.user.findFirst.mockResolvedValue({ id: '1', name: 'Alice' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: { name: 'Alice' } }, query: mockQuery }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalled();
    });
  });

  describe('nested write boundary warnings', () => {
    it('warns once per model and relation when a tracked mutation contains a nested write', async () => {
      const logger = {
        warn: jest.fn(),
        error: jest.fn(),
      };
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        logger,
      });
      const mockQuery = jest.fn().mockResolvedValue({ id: 'u1', name: 'Alice' });
      mockClient.user.findFirst.mockResolvedValue({ id: 'u1', name: 'Alice' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice', posts: { create: { title: 'One' } } } },
            query: mockQuery,
          }),
      );
      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { posts: { create: { title: 'Two' } } } },
            query: mockQuery,
          }),
      );

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('nested write on User.posts is not audited'),
      );
    });

    it('does not warn for connect-only relation changes', async () => {
      const logger = {
        warn: jest.fn(),
        error: jest.fn(),
      };
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        logger,
      });
      mockClient.user.findFirst.mockResolvedValue({ id: 'u1', name: 'Alice' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.update({
            model: 'User',
            args: {
              where: { id: 'u1' },
              data: { posts: { connect: { id: 'p1' } } },
            },
            query: jest.fn().mockResolvedValue({ id: 'u1', name: 'Alice' }),
          }),
      );

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('nested write on User.posts'),
      );
    });
  });

  describe('tenant isolation', () => {
    it('skips automatic audit insert when tenantRequired is true and tenant is unavailable', async () => {
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        tenantRequired: true,
        tenantResolver: () => null,
        onAuditError,
      });
      const created = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: mockQuery,
          }),
      );

      expect(result).toEqual(created);
      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
      expect(onAuditError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('tenant context required'),
        }),
        expect.objectContaining({
          phase: 'tenant-resolution',
          model: 'User',
          operation: 'create',
          action: 'User.created',
          targetId: 'u1',
          tenantId: null,
        }),
      );
    });

    it('reports resolver errors once and records a NULL tenant when tenantRequired is false', async () => {
      const resolverError = new Error('resolver failed');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        tenantResolver: () => {
          throw resolverError;
        },
        onAuditError,
      });
      const created = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: mockQuery,
          }),
      );

      expect(onAuditError).toHaveBeenCalledTimes(1);
      expect(onAuditError).toHaveBeenCalledWith(
        resolverError,
        expect.objectContaining({
          phase: 'tenant-resolution',
          model: 'User',
          operation: 'create',
        }),
      );
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[0]).toBeNull();
    });
  });

  // ─── create ──────────────────────────────────────────────────

  describe('create()', () => {
    it('logs audit entry after successful create', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const created = { id: 'u1', name: 'Alice', email: 'alice@test.com' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: { name: 'Alice' } }, query: mockQuery }),
      );

      expect(result).toEqual(created);
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('redacts sensitive fields in create changes', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        sensitiveFields: ['password'],
      });
      const created = { id: 'u1', name: 'Alice', password: 'secret123' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: created }, query: mockQuery }),
      );

      // Verify $executeRaw was called (audit log was inserted)
      const rawCall = mockClient.$executeRaw.mock.calls[0];
      expect(rawCall).toBeDefined();
    });

    it('redacts model-specific sensitive fields in create changes', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        sensitiveFields: ['password'],
        sensitiveFieldsByModel: { User: ['ssn'] },
      });
      const created = {
        id: 'u1',
        name: 'Alice',
        password: 'secret123',
        ssn: '123-45-6789',
      };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: created }, query: mockQuery }),
      );

      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      const changes = JSON.parse(values[8]);
      expect(changes.password.after).toBe('[REDACTED]');
      expect(changes.ssn.after).toBe('[REDACTED]');
    });

    it('handles create when findFirst returns null (no canonical)', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const created = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(null);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: { name: 'Alice' } }, query: mockQuery }),
      );

      expect(result).toEqual(created);
      expect(mockClient.$executeRaw).toHaveBeenCalled();
    });

    it('records create using result fallback when post-read fails', async () => {
      const postReadError = new Error('canonical fetch failed');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      const created = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockRejectedValueOnce(postReadError);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: mockQuery,
          }),
      );

      expect(onAuditError).toHaveBeenCalledWith(
        postReadError,
        expect.objectContaining({
          phase: 'post-read',
          model: 'User',
          operation: 'create',
        }),
      );
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(values[8])).toEqual({
        id: { after: 'u1' },
        name: { after: 'Alice' },
      });
      expect(JSON.parse(values[9])).toEqual({ postReadFailed: true });
    });

    it('handles create when result has no PK value', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const created = { name: 'Alice' }; // no id field
      const mockQuery = jest.fn().mockResolvedValue(created);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: { name: 'Alice' } }, query: mockQuery }),
      );

      expect(result).toEqual(created);
    });

    it('injects a selected primary key for auditing and strips it from create result', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const created = { id: 'u1', name: 'Alice' };
      const returned = { ...created };
      const args = { data: { name: 'Alice' }, select: { name: true } };
      const mockQuery = jest.fn().mockResolvedValue(returned);
      mockClient.user.findFirst.mockResolvedValue(created);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args, query: mockQuery }),
      );

      expect(mockQuery).toHaveBeenCalledWith({
        data: { name: 'Alice' },
        select: { name: true, id: true },
      });
      expect(result).toEqual({ name: 'Alice' });
      expect(mockClient.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'u1' },
      });
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[6]).toBe('u1');
    });

    it('un-omits a primary key for auditing and strips it from create result', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const created = { id: 'u1', name: 'Alice' };
      const returned = { ...created };
      const args = { data: { name: 'Alice' }, omit: { id: true } };
      const mockQuery = jest.fn().mockResolvedValue(returned);
      mockClient.user.findFirst.mockResolvedValue(created);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args, query: mockQuery }),
      );

      expect(mockQuery).toHaveBeenCalledWith({
        data: { name: 'Alice' },
        omit: { id: false },
      });
      expect(result).toEqual({ name: 'Alice' });
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[6]).toBe('u1');
    });

    it('records a failure audit entry when create throws and logFailures is true', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        logFailures: true,
      });
      const businessError: any = new Error('unique violation');
      businessError.code = 'P2002';
      const mockQuery = jest.fn().mockRejectedValue(businessError);

      await expect(
        AuditContext.run(
          { actor: defaultActor, noAudit: false },
          () =>
            handlers.create({
              model: 'User',
              args: { data: { id: 'u1', name: 'Alice' } },
              query: mockQuery,
            }),
        ),
      ).rejects.toBe(businessError);

      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[4]).toBe('User.created');
      expect(values[6]).toBe('u1');
      expect(JSON.parse(values[8])).toEqual({});
      expect(JSON.parse(values[9])).toEqual({
        operation: 'create',
        error: {
          name: 'Error',
          code: 'P2002',
          message: 'unique violation',
        },
      });
      expect(values[10]).toBe('failure');
    });

    it('does not record a failure audit entry for Prisma validation errors', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        logFailures: true,
      });
      const businessError: any = new Error('invalid query');
      businessError.name = 'PrismaClientValidationError';
      const mockQuery = jest.fn().mockRejectedValue(businessError);

      await expect(
        AuditContext.run(
          { actor: defaultActor, noAudit: false },
          () =>
            handlers.create({
              model: 'User',
              args: { data: { name: 'Alice' } },
              query: mockQuery,
            }),
        ),
      ).rejects.toBe(businessError);

      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // ─── update ──────────────────────────────────────────────────

  describe('update()', () => {
    it('logs audit entry with before/after diff', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const before = { id: 'u1', name: 'Alice', email: 'alice@old.com' };
      const after = { id: 'u1', name: 'Alice', email: 'alice@new.com' };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)   // before state
        .mockResolvedValueOnce(after);   // canonical after
      const mockQuery = jest.fn().mockResolvedValue(after);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.update({
          model: 'User',
          args: { where: { id: 'u1' }, data: { email: 'alice@new.com' } },
          query: mockQuery,
        }),
      );

      expect(result).toEqual(after);
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('continues the update when pre-read fails and records a degraded audit entry', async () => {
      const preReadError = new Error('pre-read unavailable');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      mockClient.user.findFirst.mockRejectedValueOnce(preReadError);
      const after = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(after);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.update({
            model: 'User',
            args: { where: { id: 'u1' }, data: { name: 'Alice' } },
            query: mockQuery,
          }),
      );

      expect(result).toEqual(after);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(onAuditError).toHaveBeenCalledWith(
        preReadError,
        expect.objectContaining({
          phase: 'pre-read',
          model: 'User',
          operation: 'update',
        }),
      );
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(values[8])).toEqual({});
      expect(JSON.parse(values[9])).toEqual({ preReadFailed: true });
    });

    it('records update using result fallback when post-read fails', async () => {
      const postReadError = new Error('canonical fetch failed');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      const before = { id: 'u1', name: 'Old' };
      const after = { id: 'u1', name: 'New' };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)
        .mockRejectedValueOnce(postReadError);
      const mockQuery = jest.fn().mockResolvedValue(after);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.update({
            model: 'User',
            args: { where: { id: 'u1' }, data: { name: 'New' } },
            query: mockQuery,
          }),
      );

      expect(onAuditError).toHaveBeenCalledWith(
        postReadError,
        expect.objectContaining({
          phase: 'post-read',
          model: 'User',
          operation: 'update',
        }),
      );
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(values[8])).toEqual({
        name: { before: 'Old', after: 'New' },
      });
      expect(JSON.parse(values[9])).toEqual({ postReadFailed: true });
    });

    it('handles update when before record is not found', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      mockClient.user.findFirst.mockResolvedValue(null); // no before
      const after = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(after);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.update({
          model: 'User',
          args: { where: { id: 'u1' }, data: { name: 'Alice' } },
          query: mockQuery,
        }),
      );

      expect(result).toEqual(after);
      expect(mockClient.$executeRaw).toHaveBeenCalled();
    });

    it('injects a selected primary key for auditing and strips it from update result', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const before = { id: 'u1', name: 'Old' };
      const after = { id: 'u1', name: 'New' };
      const returned = { ...after };
      const args = {
        where: { id: 'u1' },
        data: { name: 'New' },
        select: { name: true },
      };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);
      const mockQuery = jest.fn().mockResolvedValue(returned);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.update({ model: 'User', args, query: mockQuery }),
      );

      expect(mockQuery).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { name: 'New' },
        select: { name: true, id: true },
      });
      expect(result).toEqual({ name: 'New' });
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[6]).toBe('u1');
    });

    it('records a failure audit entry with pre-read target id when update throws', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        logFailures: true,
      });
      const before = { id: 'u1', name: 'Old' };
      mockClient.user.findFirst.mockResolvedValueOnce(before);
      const businessError: any = new Error('foreign key violation');
      businessError.code = 'P2003';
      const mockQuery = jest.fn().mockRejectedValue(businessError);

      await expect(
        AuditContext.run(
          { actor: defaultActor, noAudit: false },
          () =>
            handlers.update({
              model: 'User',
              args: { where: { id: 'u1' }, data: { name: 'New' } },
              query: mockQuery,
            }),
        ),
      ).rejects.toBe(businessError);

      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[4]).toBe('User.updated');
      expect(values[6]).toBe('u1');
      expect(JSON.parse(values[8])).toEqual({});
      expect(JSON.parse(values[9])).toEqual({
        operation: 'update',
        error: {
          name: 'Error',
          code: 'P2003',
          message: 'foreign key violation',
        },
      });
      expect(values[10]).toBe('failure');
    });

    it('does not record a failure audit entry for P2025', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        logFailures: true,
      });
      mockClient.user.findFirst.mockResolvedValueOnce(null);
      const businessError: any = new Error('Record not found');
      businessError.code = 'P2025';
      const mockQuery = jest.fn().mockRejectedValue(businessError);

      await expect(
        AuditContext.run(
          { actor: defaultActor, noAudit: false },
          () =>
            handlers.update({
              model: 'User',
              args: { where: { id: 'u1' }, data: { name: 'New' } },
              query: mockQuery,
            }),
        ),
      ).rejects.toBe(businessError);

      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('suppresses updatedAt-only update entries when ignoreTimestampOnlyUpdates is true', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        ignoreTimestampOnlyUpdates: true,
      });
      const before = { id: 'u1', name: 'Alice', updatedAt: new Date('2026-01-01') };
      const after = { id: 'u1', name: 'Alice', updatedAt: new Date('2026-01-02') };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);
      const mockQuery = jest.fn().mockResolvedValue(after);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.update({
            model: 'User',
            args: { where: { id: 'u1' }, data: { updatedAt: after.updatedAt } },
            query: mockQuery,
          }),
      );

      expect(result).toEqual(after);
      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('removes updatedAt from non-empty update diffs when ignoreTimestampOnlyUpdates is true', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        ignoreTimestampOnlyUpdates: true,
      });
      const before = { id: 'u1', name: 'Old', updatedAt: new Date('2026-01-01') };
      const after = { id: 'u1', name: 'New', updatedAt: new Date('2026-01-02') };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);
      const mockQuery = jest.fn().mockResolvedValue(after);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.update({
            model: 'User',
            args: { where: { id: 'u1' }, data: { name: 'New' } },
            query: mockQuery,
          }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(values[8])).toEqual({
        name: { before: 'Old', after: 'New' },
      });
    });
  });

  // ─── delete ──────────────────────────────────────────────────

  describe('delete()', () => {
    it('logs audit entry with before-only changes', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const before = { id: 'u1', name: 'Alice', email: 'alice@test.com' };
      mockClient.user.findFirst.mockResolvedValue(before);
      const mockQuery = jest.fn().mockResolvedValue(before);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.delete({
          model: 'User',
          args: { where: { id: 'u1' } },
          query: mockQuery,
        }),
      );

      expect(result).toEqual(before);
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('handles delete when before record is not found', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      mockClient.user.findFirst.mockResolvedValue(null);
      const mockQuery = jest.fn().mockResolvedValue({ id: 'u1' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.delete({
          model: 'User',
          args: { where: { id: 'u1' } },
          query: mockQuery,
        }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalled();
    });

    it('continues delete when pre-read fails and uses the result primary key', async () => {
      const preReadError = new Error('pre-read unavailable');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      mockClient.user.findFirst.mockRejectedValueOnce(preReadError);
      const mockQuery = jest.fn().mockResolvedValue({ id: 'u1', name: 'Alice' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.delete({
            model: 'User',
            args: { where: { id: 'u1' } },
            query: mockQuery,
          }),
      );

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(onAuditError).toHaveBeenCalledWith(
        preReadError,
        expect.objectContaining({
          phase: 'pre-read',
          model: 'User',
          operation: 'delete',
        }),
      );
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[6]).toBe('u1');
      expect(JSON.parse(values[8])).toEqual({});
      expect(JSON.parse(values[9])).toEqual({ preReadFailed: true });
    });
  });

  // ─── upsert ──────────────────────────────────────────────────

  describe('upsert()', () => {
    it('logs as created when record did not exist before', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      mockClient.user.findFirst
        .mockResolvedValueOnce(null)  // before: not found → create path
        .mockResolvedValueOnce({ id: 'u1', name: 'Alice' }); // canonical
      const mockQuery = jest.fn().mockResolvedValue({ id: 'u1', name: 'Alice' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.upsert({
          model: 'User',
          args: {
            where: { id: 'u1' },
            create: { name: 'Alice' },
            update: { name: 'Alice Updated' },
          },
          query: mockQuery,
        }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('logs as updated when record existed before', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const before = { id: 'u1', name: 'Alice' };
      const after = { id: 'u1', name: 'Alice Updated' };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before) // before: found → update path
        .mockResolvedValueOnce(after); // canonical after
      const mockQuery = jest.fn().mockResolvedValue(after);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.upsert({
          model: 'User',
          args: {
            where: { id: 'u1' },
            create: { name: 'Alice' },
            update: { name: 'Alice Updated' },
          },
          query: mockQuery,
        }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('records an upserted snapshot when upsert pre-read fails', async () => {
      const preReadError = new Error('pre-read unavailable');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      mockClient.user.findFirst
        .mockRejectedValueOnce(preReadError)
        .mockResolvedValueOnce({ id: 'u1', name: 'Alice' });
      const mockQuery = jest.fn().mockResolvedValue({ id: 'u1', name: 'Alice' });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.upsert({
            model: 'User',
            args: {
              where: { id: 'u1' },
              create: { name: 'Alice' },
              update: { name: 'Alice Updated' },
            },
            query: mockQuery,
          }),
      );

      expect(onAuditError).toHaveBeenCalledWith(
        preReadError,
        expect.objectContaining({
          phase: 'pre-read',
          model: 'User',
          operation: 'upsert',
        }),
      );
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[4]).toBe('User.upserted');
      expect(JSON.parse(values[8])).toEqual({
        id: { after: 'u1' },
        name: { after: 'Alice' },
      });
      expect(JSON.parse(values[9])).toEqual({ preReadFailed: true });
    });

    it('records upsert using result fallback when post-read fails', async () => {
      const postReadError = new Error('canonical fetch failed');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      const before = { id: 'u1', name: 'Old' };
      const after = { id: 'u1', name: 'New' };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)
        .mockRejectedValueOnce(postReadError);
      const mockQuery = jest.fn().mockResolvedValue(after);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.upsert({
            model: 'User',
            args: {
              where: { id: 'u1' },
              create: { name: 'New' },
              update: { name: 'New' },
            },
            query: mockQuery,
          }),
      );

      expect(onAuditError).toHaveBeenCalledWith(
        postReadError,
        expect.objectContaining({
          phase: 'post-read',
          model: 'User',
          operation: 'upsert',
        }),
      );
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(values[8])).toEqual({
        name: { before: 'Old', after: 'New' },
      });
      expect(JSON.parse(values[9])).toEqual({ postReadFailed: true });
    });

    it('injects a selected primary key for auditing and strips it from upsert result', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const before = { id: 'u1', name: 'Old' };
      const after = { id: 'u1', name: 'New' };
      const returned = { ...after };
      const args = {
        where: { id: 'u1' },
        create: { name: 'New' },
        update: { name: 'New' },
        select: { name: true },
      };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);
      const mockQuery = jest.fn().mockResolvedValue(returned);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.upsert({ model: 'User', args, query: mockQuery }),
      );

      expect(mockQuery).toHaveBeenCalledWith({
        where: { id: 'u1' },
        create: { name: 'New' },
        update: { name: 'New' },
        select: { name: true, id: true },
      });
      expect(result).toEqual({ name: 'New' });
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[6]).toBe('u1');
    });

    it('suppresses updatedAt-only upsert update entries when ignoreTimestampOnlyUpdates is true', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        ignoreTimestampOnlyUpdates: true,
      });
      const before = { id: 'u1', name: 'Alice', updatedAt: new Date('2026-01-01') };
      const after = { id: 'u1', name: 'Alice', updatedAt: new Date('2026-01-02') };
      mockClient.user.findFirst
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);
      const mockQuery = jest.fn().mockResolvedValue(after);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.upsert({
            model: 'User',
            args: {
              where: { id: 'u1' },
              create: { name: 'Alice' },
              update: { updatedAt: after.updatedAt },
            },
            query: mockQuery,
          }),
      );

      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // ─── createMany ──────────────────────────────────────────────

  describe('createMany()', () => {
    it('logs batch create with count metadata', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const mockQuery = jest.fn().mockResolvedValue({ count: 5 });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.createMany({
          model: 'User',
          args: { data: Array(5).fill({ name: 'User' }) },
          query: mockQuery,
        }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(values[9])).toEqual({
        auditKind: 'summary',
        operation: 'createMany',
        recordCount: 5,
        recordsAudited: false,
      });
    });

    it('rejects count-only createMany in atomic-required before mutation', async () => {
      const { handlers } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
      });
      const query = jest.fn();

      await expect(
        handlers.createMany({
          model: 'User',
          args: { data: [{ name: 'User' }] },
          query,
        }),
      ).rejects.toThrow('only provides count-level audit evidence');
      expect(query).not.toHaveBeenCalled();
    });
  });

  // ─── updateMany ──────────────────────────────────────────────

  describe('updateMany()', () => {
    it('logs batch update with count metadata', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const mockQuery = jest.fn().mockResolvedValue({ count: 3 });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.updateMany({
          model: 'User',
          args: { where: { name: 'Old' }, data: { name: 'New' } },
          query: mockQuery,
        }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(JSON.parse(values[9])).toEqual({
        auditKind: 'summary',
        operation: 'updateMany',
        recordCount: 3,
        recordsAudited: false,
      });
    });

    it('rejects count-only updateMany in atomic-required before mutation', async () => {
      const { handlers } = getHandlers({
        consistency: 'atomic-required',
        trackedModels: ['User'],
      });
      const query = jest.fn();

      await expect(
        handlers.updateMany({
          model: 'User',
          args: { where: {}, data: { name: 'New' } },
          query,
        }),
      ).rejects.toThrow('only provides count-level audit evidence');
      expect(query).not.toHaveBeenCalled();
    });
  });

  // ─── deleteMany ──────────────────────────────────────────────

  describe('deleteMany()', () => {
    it('logs individual audit entries for each deleted record', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const records = [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
      ];
      mockClient.user.findMany.mockResolvedValue(records);
      const mockQuery = jest.fn().mockResolvedValue({ count: 2 });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.deleteMany({
          model: 'User',
          args: { where: { name: { contains: 'test' } } },
          query: mockQuery,
        }),
      );

      // One audit log per record
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(2);
      const metadata = mockClient.$executeRaw.mock.calls.map((call) =>
        JSON.parse(call.slice(1)[9]),
      );
      expect(metadata).toEqual([
        { auditKind: 'record', operation: 'deleteMany', batchSize: 2 },
        { auditKind: 'record', operation: 'deleteMany', batchSize: 2 },
      ]);
    });

    it('handles deleteMany with no matching records', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      mockClient.user.findMany.mockResolvedValue([]);
      const mockQuery = jest.fn().mockResolvedValue({ count: 0 });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.deleteMany({
          model: 'User',
          args: { where: {} },
          query: mockQuery,
        }),
      );

      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('records one deletedMany fallback entry when pre-read fails', async () => {
      const preReadError = new Error('pre-read unavailable');
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      mockClient.user.findMany.mockRejectedValueOnce(preReadError);
      const mockQuery = jest.fn().mockResolvedValue({ count: 2 });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.deleteMany({
            model: 'User',
            args: { where: { name: { contains: 'test' } } },
            query: mockQuery,
          }),
      );

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(onAuditError).toHaveBeenCalledWith(
        preReadError,
        expect.objectContaining({
          phase: 'pre-read',
          model: 'User',
          operation: 'deleteMany',
        }),
      );
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[4]).toBe('User.deletedMany');
      expect(JSON.parse(values[8])).toEqual({});
      expect(JSON.parse(values[9])).toEqual({
        auditKind: 'summary',
        operation: 'deleteMany',
        recordCount: 2,
        recordsAudited: false,
        preReadFailed: true,
      });
    });

    it('rejects deleteMany overflow before mutation by default', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        maxBatchRecords: 1,
      });
      mockClient.user.findMany.mockResolvedValue([
        { id: 'u1', name: 'One' },
        { id: 'u2', name: 'Two' },
      ]);
      const query = jest.fn();

      await expect(
        handlers.deleteMany({ model: 'User', args: { where: {} }, query }),
      ).rejects.toThrow('more than maxBatchRecords');
      expect(query).not.toHaveBeenCalled();
      expect(mockClient.$executeRaw).not.toHaveBeenCalled();
    });

    it('uses an explicit summary when best-effort overflow policy allows it', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        maxBatchRecords: 1,
        batchOverflow: 'summary',
      });
      mockClient.user.findMany.mockResolvedValue([
        { id: 'u1', name: 'One' },
        { id: 'u2', name: 'Two' },
      ]);
      const query = jest.fn().mockResolvedValue({ count: 3 });

      await handlers.deleteMany({ model: 'User', args: { where: {} }, query });

      expect(query).toHaveBeenCalledTimes(1);
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);
      const values = mockClient.$executeRaw.mock.calls[0].slice(1);
      expect(values[4]).toBe('User.deletedMany');
      expect(JSON.parse(values[9])).toEqual({
        auditKind: 'summary',
        operation: 'deleteMany',
        recordCount: 3,
        recordsAudited: false,
        overflow: true,
        maxBatchRecords: 1,
      });
    });

    it('continues auditing remaining deleteMany records when one record fails during assembly', async () => {
      const contextError = new Error('bad getter');
      const badRecord: Record<string, unknown> = { id: 'bad' };
      Object.defineProperty(badRecord, 'name', {
        enumerable: true,
        get() {
          throw contextError;
        },
      });
      const onAuditError = jest.fn();
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
      });
      mockClient.user.findMany.mockResolvedValue([
        { id: 'u1', name: 'One' },
        badRecord,
        { id: 'u3', name: 'Three' },
      ]);
      const mockQuery = jest.fn().mockResolvedValue({ count: 3 });

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.deleteMany({
            model: 'User',
            args: { where: { name: { contains: 'test' } } },
            query: mockQuery,
          }),
      );

      expect(onAuditError).toHaveBeenCalledWith(
        contextError,
        expect.objectContaining({
          phase: 'context',
          model: 'User',
          operation: 'deleteMany',
        }),
      );
      expect(mockClient.$executeRaw).toHaveBeenCalledTimes(2);
      const targetIds = mockClient.$executeRaw.mock.calls.map(
        (call) => call.slice(1)[6],
      );
      expect(targetIds).toEqual(['u1', 'u3']);
    });
  });

  // ─── tryAuditLog error handling ──────────────────────────────

  describe('error handling (tryAuditLog)', () => {
    it('reports insert failures through onAuditError without logger.warn', async () => {
      const insertError = new Error('DB connection lost');
      const onAuditError = jest.fn();
      const logger = {
        warn: jest.fn(),
        error: jest.fn(),
      };
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError,
        logger,
      });
      const created = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);
      mockClient.$executeRaw.mockRejectedValue(insertError);

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: mockQuery,
          }),
      );

      expect(result).toEqual(created);
      expect(onAuditError).toHaveBeenCalledWith(
        insertError,
        expect.objectContaining({
          phase: 'insert',
          model: 'User',
          operation: 'create',
          action: 'User.created',
          targetId: 'u1',
          tenantId: null,
        }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs an error when onAuditError throws', async () => {
      const logger = {
        warn: jest.fn(),
        error: jest.fn(),
      };
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        onAuditError: () => {
          throw new Error('observer failed');
        },
        logger,
      });
      const created = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);
      mockClient.$executeRaw.mockRejectedValue(new Error('DB connection lost'));

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () =>
          handlers.create({
            model: 'User',
            args: { data: { name: 'Alice' } },
            query: mockQuery,
          }),
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('onAuditError callback threw'),
      );
    });

    it('warns but does not throw when audit insert fails', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const created = { id: 'u1', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);
      mockClient.$executeRaw.mockRejectedValue(new Error('DB connection lost'));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: { name: 'Alice' } }, query: mockQuery }),
      );

      expect(result).toEqual(created);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('audit insert failed for User.create'),
      );
      warnSpy.mockRestore();
    });

    it('warns with post-read phase when canonical tracking read throws', async () => {
      const { handlers, mockClient } = getHandlers({ trackedModels: ['User'] });
      const before = { id: 'u1', name: 'Old' };
      const mockQuery = jest.fn().mockResolvedValue({ id: 'u1', name: 'New' });
      mockClient.user.findFirst
        .mockResolvedValueOnce(before) // before fetch succeeds
        .mockRejectedValueOnce(new Error('canonical fetch failed')); // after canonical fails

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.update({
          model: 'User',
          args: { where: { id: 'u1' }, data: { name: 'New' } },
          query: mockQuery,
        }),
      );

      // Original operation should still succeed
      expect(result).toEqual({ id: 'u1', name: 'New' });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('audit post-read failed for User.update'),
      );
      warnSpy.mockRestore();
    });
  });

  // ─── custom primaryKey ───────────────────────────────────────

  describe('custom primaryKey', () => {
    it('uses custom PK field for target_id', async () => {
      const { handlers, mockClient } = getHandlers({
        trackedModels: ['User'],
        primaryKey: { User: 'email' },
      });
      const created = { email: 'alice@test.com', name: 'Alice' };
      const mockQuery = jest.fn().mockResolvedValue(created);
      mockClient.user.findFirst.mockResolvedValue(created);

      await AuditContext.run(
        { actor: defaultActor, noAudit: false },
        () => handlers.create({ model: 'User', args: { data: created }, query: mockQuery }),
      );

      expect(mockClient.$executeRaw).toHaveBeenCalled();
      expect(mockClient.user.findFirst).toHaveBeenCalledWith({
        where: { email: 'alice@test.com' },
      });
    });
  });
});
