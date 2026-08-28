import {
  DynamicModule,
  Inject,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AUDIT_LOG_OPTIONS } from './audit-log.constants';
import {
  AuditLogModuleOptions,
  AuditLogModuleAsyncOptions,
} from './interfaces/audit-log-options.interface';
import { AuditService } from './services/audit.service';
import { AuditActorMiddleware } from './middleware/audit-actor.middleware';
import { AuditInterceptor } from './interceptors/audit.interceptor';

@Module({})
export class AuditLogModule implements NestModule {
  constructor(
    @Inject(AUDIT_LOG_OPTIONS)
    private readonly options: AuditLogModuleOptions,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    const proxy = consumer.apply(AuditActorMiddleware);
    const excluded = this.options.excludeRoutes ?? [];
    const target = excluded.length > 0 ? proxy.exclude(...excluded) : proxy;
    target.forRoutes(resolveMiddlewareWildcard());
  }

  static forRoot(options: AuditLogModuleOptions): DynamicModule {
    const providers = [
      { provide: AUDIT_LOG_OPTIONS, useValue: options },
      AuditActorMiddleware,
      AuditService,
      AuditInterceptor,
      ...(options.registerGlobalInterceptor !== false
        ? [{ provide: APP_INTERCEPTOR, useExisting: AuditInterceptor }]
        : []),
    ];

    return {
      module: AuditLogModule,
      global: true,
      providers,
      exports: [AuditService, AuditInterceptor],
    };
  }

  static forRootAsync(options: AuditLogModuleAsyncOptions): DynamicModule {
    return {
      module: AuditLogModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: AUDIT_LOG_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        AuditActorMiddleware,
        AuditService,
        AuditInterceptor,
        {
          provide: APP_INTERCEPTOR,
          useFactory: (
            moduleOptions: AuditLogModuleOptions,
            interceptor: AuditInterceptor,
          ) =>
            moduleOptions.registerGlobalInterceptor === false
              ? passThroughInterceptor
              : interceptor,
          inject: [AUDIT_LOG_OPTIONS, AuditInterceptor],
        },
      ],
      exports: [AuditService, AuditInterceptor],
    };
  }
}

const passThroughInterceptor = {
  intercept: (_context: unknown, next: { handle: () => unknown }) =>
    next.handle(),
};

export function resolveMiddlewareWildcard(nestCoreVersion?: string): string {
  const version =
    arguments.length === 0 ? resolveNestCoreVersion() : nestCoreVersion;
  const major =
    typeof version === 'string' ? Number(version.split('.')[0]) : Number.NaN;

  return Number.isFinite(major) && major >= 11 ? '{*splat}' : '*';
}

function resolveNestCoreVersion(): string | undefined {
  try {
    const requireFromHere = createRequire(__filename);
    const packagePath = join(
      dirname(requireFromHere.resolve('@nestjs/core')),
      'package.json',
    );
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      version?: unknown;
    };

    return typeof packageJson.version === 'string'
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}
