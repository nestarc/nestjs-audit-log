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
  });
});
