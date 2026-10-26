import { ModuleMetadata } from '@nestjs/common';
import { RouteInfo } from '@nestjs/common/interfaces';
import { ActorExtractor } from './actor.interface';
import { AuditSharedOptions, AuditOperationEvent } from './audit-shared-options.interface';
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
  /** Opt-in validation of manual event fields, identities and lossless JSON inputs. */
  strictManualValidation?: boolean;
  /** Maximum UTF-8 bytes of serialized, redacted manual metadata; never truncates. */
  maxMetadataBytes?: number;
  /** Optional manual-operation timings; observer failures never affect the operation. */
  onAuditOperation?: (event: AuditOperationEvent) => unknown;
}

export interface AuditLogModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => AuditLogModuleOptions | Promise<AuditLogModuleOptions>;
  inject?: any[];
}
