import { AuditService } from '../src/services/audit.service';
import { AuditContext } from '../src/services/audit-context';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';

describe('AuditService', () => {
  let service: AuditService;
  let mockPrisma: any;
  let mockLogger: { warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    mockPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(),
    };
    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
    };

    const options: AuditLogModuleOptions = {
      prisma: mockPrisma,
      actorExtractor: () => ({ id: null, type: 'system' }),
      logger: mockLogger,
    };

    service = new AuditService(options);
  });

  describe('log()', () => {
    it('throws a helpful error for invalid tableName', () => {
      expect(
        () =>
          new AuditService({
            prisma: mockPrisma,
            actorExtractor: () => ({ id: null, type: 'system' }),
            tableName: 'audit-logs',
          }),
      ).toThrow('Invalid audit tableName');
    });

    it('inserts a manual audit log entry via $executeRaw', async () => {
      await AuditContext.run(
        { actor: { id: 'user-1', type: 'user', ip: '10.0.0.1' }, noAudit: false },
        () =>
          service.log({
            action: 'invoice.approved',
            targetId: 'inv-123',
            targetType: 'Invoice',
            metadata: { amount: 5000 },
          }),
      );

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('calls $executeRaw when no actor in context', async () => {
      await service.log({ action: 'system.startup' });
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('uses provided tx client instead of base prisma', async () => {
      const mockTx = { $executeRaw: jest.fn().mockResolvedValue(1) };
      await service.log({ action: 'invoice.approved' }, mockTx);
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('uses the provided prismaModule namespace to build manual insert SQL', async () => {
      const sql = jest.fn((
        strings: TemplateStringsArray | readonly string[],
        ...values: any[]
      ) => ({
        strings,
        values,
      }));
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        prismaModule: {
          Prisma: {
            defineExtension: jest.fn(),
            sql,
            join: jest.fn(),
            empty: { empty: true },
          },
        },
      });

      await customService.log({ action: 'system.startup' });

      expect(sql).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$executeRaw).toHaveBeenCalledWith(
        expect.objectContaining({
          strings: expect.any(Array),
          values: expect.any(Array),
        }),
      );
    });

    it('uses the configured tableName for manual insert SQL', async () => {
      const raw = jest.fn((value: string) => ({ raw: value }));
      const sql = jest.fn((
        strings: TemplateStringsArray | readonly string[],
        ...values: any[]
      ) => ({
        strings,
        values,
      }));
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tableName: 'audit.audit_logs',
        prismaModule: {
          Prisma: {
            defineExtension: jest.fn(),
            raw,
            sql,
            join: jest.fn(),
            empty: { empty: true },
          },
        },
      });

      await customService.log({ action: 'system.startup' });

      expect(raw).toHaveBeenCalledWith('audit.audit_logs');
      expect(sql.mock.results[0].value.values[0]).toEqual({
        raw: 'audit.audit_logs',
      });
    });

    it('uses module tenantResolver for manual logs', async () => {
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
        tenantResolver: () => 'tenant-1',
      });

      await customService.log({ action: 'system.startup' });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('redacts manual metadata using global and model-specific sensitive fields', async () => {
      const sql = jest.fn((
        strings: TemplateStringsArray | readonly string[],
        ...values: any[]
      ) => ({
        strings,
        values,
      }));
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        sensitiveFields: ['email'],
        sensitiveFieldsByModel: { User: ['ssn'] },
        prismaModule: {
          Prisma: {
            defineExtension: jest.fn(),
            sql,
            join: jest.fn(),
            empty: { empty: true },
          },
        },
      });

      await customService.log({
        action: 'user.updated',
        targetType: 'User',
        metadata: {
          email: 'alice@test.com',
          ssn: '123-45-6789',
          nested: { email: 'nested@test.com' },
        },
      });

      const metadataJson = sql.mock.results[0].value.values[8];
      expect(JSON.parse(metadataJson)).toEqual({
        email: '[REDACTED]',
        ssn: '[REDACTED]',
        nested: { email: 'nested@test.com' },
      });
    });
  });

  describe('query()', () => {
    it('returns entries and total count', async () => {
      const mockEntries = [
        { id: '1', action: 'user.created', createdAt: new Date() },
      ];
      mockPrisma.$queryRaw
        .mockResolvedValueOnce(mockEntries)
        .mockResolvedValueOnce([{ count: 1n }]);

      const result = await service.query({ actorId: 'user-1' });

      expect(result.entries).toEqual(mockEntries);
      expect(result.total).toBe(1);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('applies default limit and offset when none provided', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      const result = await service.query({});

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('handles wildcard action filter', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({ action: 'user.*' });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('handles exact action filter (no wildcard)', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({ action: 'user.created' });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('handles targetType and targetId filters', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({ targetType: 'Invoice', targetId: 'inv-1' });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('handles from/to date range filters', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({
        from: new Date('2026-01-01'),
        to: new Date('2026-12-31'),
      });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('uses the provided prismaModule namespace to build query SQL', async () => {
      const customPrisma = {
        defineExtension: jest.fn(),
        sql: jest.fn((
          strings: TemplateStringsArray | readonly string[],
          ...values: any[]
        ) => ({ strings, values })),
        join: jest.fn((values: readonly any[], separator?: string) => ({
          values,
          separator,
        })),
        empty: { empty: true },
      };
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        prismaModule: { Prisma: customPrisma },
        logger: mockLogger,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await customService.query({ actorId: 'user-1' });

      expect(customPrisma.sql).toHaveBeenCalled();
      expect(customPrisma.join).toHaveBeenCalledWith(expect.any(Array), ' AND ');
      expect(mockPrisma.$queryRaw).toHaveBeenCalledWith(
        expect.objectContaining({
          strings: expect.any(Array),
          values: expect.any(Array),
        }),
      );
    });

    it('uses the configured tableName for query SQL', async () => {
      const customPrisma = {
        defineExtension: jest.fn(),
        raw: jest.fn((value: string) => ({ raw: value })),
        sql: jest.fn((
          strings: TemplateStringsArray | readonly string[],
          ...values: any[]
        ) => ({ strings, values })),
        join: jest.fn((values: readonly any[], separator?: string) => ({
          values,
          separator,
        })),
        empty: { empty: true },
      };
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tableName: 'audit.audit_logs',
        prismaModule: { Prisma: customPrisma },
        logger: mockLogger,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await customService.query({ allTenants: true });

      expect(customPrisma.raw).toHaveBeenCalledWith('audit.audit_logs');
      expect(customPrisma.sql.mock.results[0].value.values).toContainEqual({
        raw: 'audit.audit_logs',
      });
      expect(customPrisma.sql.mock.results[1].value.values).toContainEqual({
        raw: 'audit.audit_logs',
      });
    });

    it('throws when tenantId and allTenants are both provided', async () => {
      await expect(
        service.query({ tenantId: 'tenant-1', allTenants: true }),
      ).rejects.toThrow('tenantId and allTenants are mutually exclusive');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('allows explicit tenantId when tenantRequired is true and ambient tenant is missing', async () => {
      const strictService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await expect(
        strictService.query({ tenantId: 'tenant-1' }),
      ).resolves.toEqual({ entries: [], total: 0 });
    });

    it('allows explicit allTenants when tenantRequired is true and ambient tenant is missing', async () => {
      const strictService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await expect(
        strictService.query({ allTenants: true }),
      ).resolves.toEqual({ entries: [], total: 0 });
    });

    it('warns only once per service instance for unscoped queries', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({});
      await service.query({});

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('query() executed without tenant scope'),
      );
    });
  });

  describe('tenantRequired', () => {
    let strictService: AuditService;

    beforeEach(() => {
      strictService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
      });
    });

    it('throws on log() when tenantRequired is true and no tenant', async () => {
      await expect(
        strictService.log({ action: 'test.action' }),
      ).rejects.toThrow('tenant context required');
    });

    it('throws on query() when tenantRequired is true and no tenant', async () => {
      await expect(
        strictService.query({}),
      ).rejects.toThrow('tenant context required');
    });
  });
});
