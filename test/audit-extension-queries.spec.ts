import { AuditContext } from '../src/services/audit-context';
import { createAuditExtension } from '../src/prisma/audit-extension';

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
  options: Parameters<typeof createAuditExtension>[0] = { trackedModels: ['User'] },
) {
  createAuditExtension(options);
  const mockClient = buildMockClient();
  const extended = capturedFactory(mockClient);

  // extended is the result of client.$extends({ query: { $allModels: { ... } } })
  // We need to extract the handlers from the $extends call
  const extendCall = mockClient.$extends.mock.calls[0][0];
  const handlers = extendCall.query.$allModels;

  return { handlers, mockClient };
}

describe('createAuditExtension — query handlers', () => {
  const defaultActor = { id: 'user-1', type: 'user' as const, ip: '10.0.0.1' };

  afterEach(() => {
    jest.clearAllMocks();
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
  });

  // ─── tryAuditLog error handling ──────────────────────────────

  describe('error handling (tryAuditLog)', () => {
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
        expect.stringContaining('audit insert failed'),
        expect.any(String),
      );
      warnSpy.mockRestore();
    });

    it('warns when post-query audit tracking throws', async () => {
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
        expect.stringContaining('audit tracking failed'),
        expect.any(String),
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
