import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditLogModule } from '../src/audit-log.module';
import { AuditService } from '../src/services/audit.service';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';

describe('AuditLogModule', () => {
  const mockOptions: AuditLogModuleOptions = {
    prisma: {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
    },
    actorExtractor: (req: any) => ({
      id: req.user?.id ?? null,
      type: 'user' as const,
    }),
    trackedModels: ['User'],
  };

  describe('forRoot', () => {
    it('provides AuditService', async () => {
      const module = await Test.createTestingModule({
        imports: [AuditLogModule.forRoot(mockOptions)],
      }).compile();

      const service = module.get(AuditService);
      expect(service).toBeInstanceOf(AuditService);
    });
  });

  describe('forRootAsync', () => {
    it('provides AuditService via factory', async () => {
      const module = await Test.createTestingModule({
        imports: [
          AuditLogModule.forRootAsync({
            useFactory: () => mockOptions,
          }),
        ],
      }).compile();

      const service = module.get(AuditService);
      expect(service).toBeInstanceOf(AuditService);
    });

    it('supports inject for dependency injection', async () => {
      const PRISMA_TOKEN = 'PRISMA_SERVICE';

      @Module({
        providers: [{ provide: PRISMA_TOKEN, useValue: mockOptions.prisma }],
        exports: [PRISMA_TOKEN],
      })
      class PrismaModule {}

      const module = await Test.createTestingModule({
        imports: [
          AuditLogModule.forRootAsync({
            imports: [PrismaModule],
            useFactory: (prisma: any) => ({
              ...mockOptions,
              prisma,
            }),
            inject: [PRISMA_TOKEN],
          }),
        ],
      }).compile();

      const service = module.get(AuditService);
      expect(service).toBeInstanceOf(AuditService);
    });
  });
});
