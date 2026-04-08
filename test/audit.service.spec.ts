import { AuditService } from '../src/services/audit.service';
import { AuditContext } from '../src/services/audit-context';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';

describe('AuditService', () => {
  let service: AuditService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(),
    };

    const options: AuditLogModuleOptions = {
      prisma: mockPrisma,
      actorExtractor: () => ({ id: null, type: 'system' }),
    };

    service = new AuditService(options);
  });

  describe('log()', () => {
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
