import { ModuleMetadata } from '@nestjs/common';
import { ActorExtractor } from './actor.interface';

export interface AuditLogModuleOptions {
  prisma: any;
  trackedModels?: string[];
  ignoredModels?: string[];
  actorExtractor: ActorExtractor;
  sensitiveFields?: string[];
}

export interface AuditLogModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => AuditLogModuleOptions | Promise<AuditLogModuleOptions>;
  inject?: any[];
}
