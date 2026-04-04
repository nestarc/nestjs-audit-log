// Module
export { AuditLogModule } from './audit-log.module';

// Service
export { AuditService } from './services/audit.service';

// Context
export { AuditContext } from './services/audit-context';
export type { AuditContextStore } from './services/audit-context';

// Prisma Extension
export { createAuditExtension } from './prisma/audit-extension';
export type { AuditExtensionOptions } from './prisma/audit-extension';

// Decorators
export { NoAudit, NO_AUDIT_KEY } from './decorators/no-audit.decorator';
export { AuditAction, AUDIT_ACTION_KEY } from './decorators/audit-action.decorator';

// Interfaces
export type { AuditActor, ActorExtractor } from './interfaces/actor.interface';
export type {
  AuditEntry,
  AuditQueryOptions,
  AuditQueryResult,
  ManualAuditLogInput,
} from './interfaces/audit-entry.interface';
export type {
  AuditLogModuleOptions,
  AuditLogModuleAsyncOptions,
} from './interfaces/audit-log-options.interface';

// Constants
export { AUDIT_LOG_OPTIONS } from './audit-log.constants';
