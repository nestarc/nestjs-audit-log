import { ModuleMetadata } from '@nestjs/common';
import { RouteInfo } from '@nestjs/common/interfaces';
import { ActorExtractor } from './actor.interface';
import { AuditSharedOptions } from './audit-shared-options.interface';
import { PrismaModuleLike } from '../prisma/prisma-namespace';

export interface AuditLogModuleOptions extends AuditSharedOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /**
   * When to invoke actorExtractor (once per request). Defaults to middleware.
   * Choose interceptor when an authentication guard populates req.user.
   * Interceptor extraction requires AuditInterceptor and runs after guards;
   * writes inside guards therefore do not yet have an extracted actor.
   */
  actorExtractionStage?: 'middleware' | 'interceptor';
  prismaModule?: PrismaModuleLike;
  sensitiveFields?: string[];
  sensitiveFieldsByModel?: Record<string, string[]>;
  excludeRoutes?: RouteInfo[];
  registerGlobalInterceptor?: boolean;
  correlationIdHeader?: string;
  correlationIdGetter?: (req: any) => string | undefined;
}

export interface AuditLogModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => AuditLogModuleOptions | Promise<AuditLogModuleOptions>;
  inject?: any[];
}
