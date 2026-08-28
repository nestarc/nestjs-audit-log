import { Module, RequestMethod } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AuditLogModule,
  resolveMiddlewareWildcard,
} from '../src/audit-log.module';
import { AuditService } from '../src/services/audit.service';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import { AuditActorMiddleware } from '../src/middleware/audit-actor.middleware';
import { AuditInterceptor } from '../src/interceptors/audit.interceptor';

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
    prismaModule: {
      Prisma: {
        defineExtension: jest.fn(),
      },
    },
  };

  describe('forRoot', () => {
    it('provides AuditService', async () => {
      const module = await Test.createTestingModule({
        imports: [AuditLogModule.forRoot(mockOptions)],
      }).compile();

      const service = module.get(AuditService);
      expect(service).toBeInstanceOf(AuditService);
    });

    it('registers AuditInterceptor globally by default and exports it for manual use', () => {
      const module = AuditLogModule.forRoot(mockOptions);

      expect(module.providers).toEqual(
        expect.arrayContaining([
          AuditInterceptor,
          { provide: APP_INTERCEPTOR, useExisting: AuditInterceptor },
        ]),
      );
      expect(module.exports).toEqual(
        expect.arrayContaining([AuditService, AuditInterceptor]),
      );
    });

    it('omits APP_INTERCEPTOR when registerGlobalInterceptor=false', () => {
      const module = AuditLogModule.forRoot({
        ...mockOptions,
        registerGlobalInterceptor: false,
      });

      expect(module.providers).toEqual(expect.arrayContaining([AuditInterceptor]));
      expect(module.providers).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provide: APP_INTERCEPTOR }),
        ]),
      );
      expect(module.exports).toEqual(
        expect.arrayContaining([AuditService, AuditInterceptor]),
      );
    });
  });

  describe('configure (middleware)', () => {
    it('applies AuditActorMiddleware on init', async () => {
      const module = await Test.createTestingModule({
        imports: [AuditLogModule.forRoot(mockOptions)],
      }).compile();

      const app = module.createNestApplication();
      // init() triggers configure() which applies middleware
      await app.init();

      const service = module.get(AuditService);
      expect(service).toBeInstanceOf(AuditService);
      await app.close();
    });

    it('applies configured route exclusions before registering the wildcard route', () => {
      const forRoutes = jest.fn();
      const exclude = jest.fn().mockReturnValue({ forRoutes });
      const apply = jest.fn().mockReturnValue({ exclude, forRoutes: jest.fn() });
      const module = new AuditLogModule({
        ...mockOptions,
        excludeRoutes: [{ path: 'health', method: RequestMethod.GET }],
      });

      module.configure({ apply } as any);

      expect(apply).toHaveBeenCalledWith(AuditActorMiddleware);
      expect(exclude).toHaveBeenCalledWith({
        path: 'health',
        method: RequestMethod.GET,
      });
      expect(forRoutes).toHaveBeenCalledWith(resolveMiddlewareWildcard());
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

    it('returns a pass-through APP_INTERCEPTOR when registerGlobalInterceptor=false', () => {
      const module = AuditLogModule.forRootAsync({
        useFactory: () => ({
          ...mockOptions,
          registerGlobalInterceptor: false,
        }),
      });
      const provider = (module.providers ?? []).find(
        (candidate: any) => candidate?.provide === APP_INTERCEPTOR,
      ) as any;
      const next = { handle: jest.fn(() => 'handled') };

      const interceptor = provider.useFactory(
        { registerGlobalInterceptor: false },
        {} as AuditInterceptor,
      );

      expect(interceptor.intercept({} as any, next as any)).toBe('handled');
      expect(next.handle).toHaveBeenCalledTimes(1);
    });

    it('returns the real AuditInterceptor when registerGlobalInterceptor is not false', () => {
      const module = AuditLogModule.forRootAsync({
        useFactory: () => mockOptions,
      });
      const provider = (module.providers ?? []).find(
        (candidate: any) => candidate?.provide === APP_INTERCEPTOR,
      ) as any;
      const interceptor = {} as AuditInterceptor;

      expect(provider.useFactory({}, interceptor)).toBe(interceptor);
    });
  });

  describe('resolveMiddlewareWildcard', () => {
    it('resolves the installed Nest version without a package.json subpath import', () => {
      const packagePath = join(
        dirname(require.resolve('@nestjs/core')),
        'package.json',
      );
      const { version } = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        version: string;
      };
      const expected = Number(version.split('.')[0]) >= 11 ? '{*splat}' : '*';

      expect(resolveMiddlewareWildcard()).toBe(expected);
    });

    it('uses the Nest 11 compatible wildcard for v11 and newer', () => {
      expect(resolveMiddlewareWildcard('11.0.0')).toBe('{*splat}');
      expect(resolveMiddlewareWildcard('12.1.0')).toBe('{*splat}');
    });

    it('uses the legacy wildcard for Nest 10 or unknown versions', () => {
      expect(resolveMiddlewareWildcard('10.4.0')).toBe('*');
      expect(resolveMiddlewareWildcard('not-a-version')).toBe('*');
      expect(resolveMiddlewareWildcard(undefined)).toBe('*');
    });
  });
});
