import { ModuleMetadata } from '@nestjs/common';
import { ActorExtractor } from './actor.interface';
import { AuditSharedOptions } from './audit-shared-options.interface';
import { PrismaModuleLike } from '../prisma/prisma-namespace';

export interface AuditLogModuleOptions extends AuditSharedOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  prismaModule?: PrismaModuleLike;
  sensitiveFields?: string[];
  sensitiveFieldsByModel?: Record<string, string[]>;
}

export interface AuditLogModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => AuditLogModuleOptions | Promise<AuditLogModuleOptions>;
  inject?: any[];
}
