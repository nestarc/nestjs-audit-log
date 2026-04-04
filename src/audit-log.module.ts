import {
  DynamicModule,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
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
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuditActorMiddleware).forRoutes('*');
  }

  static forRoot(options: AuditLogModuleOptions): DynamicModule {
    return {
      module: AuditLogModule,
      global: true,
      providers: [
        { provide: AUDIT_LOG_OPTIONS, useValue: options },
        AuditActorMiddleware,
        AuditService,
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
      ],
      exports: [AuditService],
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
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
      ],
      exports: [AuditService],
    };
  }
}
