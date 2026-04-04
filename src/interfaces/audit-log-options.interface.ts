import { ModuleMetadata } from '@nestjs/common';
import { ActorExtractor } from './actor.interface';

export interface AuditLogModuleOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /** When true, query() throws if tenant context is unavailable. Default: false */
  tenantRequired?: boolean;
}

export interface AuditLogModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => AuditLogModuleOptions | Promise<AuditLogModuleOptions>;
  inject?: any[];
}
