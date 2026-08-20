// Module
export { AuditLogModule } from './audit-log.module';

// Service
export { AuditService } from './services/audit.service';
export type {
  AuditPruneOptions,
  AuditPruneResult,
} from './services/audit.service';

// Context
export { AuditContext, mergeContextMetadata } from './services/audit-context';
export type { AuditContextStore } from './services/audit-context';

// Prisma Extension
export {
  createAuditExtension,
  createAuditedClient,
} from './prisma/audit-extension';
export type {
  AuditConsistency,
  AuditExtensionOptions,
  AuditTransactionMethods,
  AuditTransactionOptions,
} from './prisma/audit-extension';
export type { PrismaModuleLike } from './prisma/prisma-namespace';

// Decorators
export { NoAudit, NO_AUDIT_KEY } from './decorators/no-audit.decorator';
export { AuditAction, AUDIT_ACTION_KEY } from './decorators/audit-action.decorator';
export { AuditReason, AUDIT_REASON_KEY } from './decorators/audit-reason.decorator';
export { AuditActorMiddleware } from './middleware/audit-actor.middleware';
export { AuditInterceptor } from './interceptors/audit.interceptor';

// Interfaces
export type { AuditActor, ActorExtractor } from './interfaces/actor.interface';
export type {
  AuditEntry,
  AuditGetByIdOptions,
  AuditQueryOptions,
  AuditQueryResult,
  ManualAuditLogInput,
} from './interfaces/audit-entry.interface';
export type {
  AuditLogModuleOptions,
  AuditLogModuleAsyncOptions,
} from './interfaces/audit-log-options.interface';
export type {
  AuditSharedOptions,
  AuditErrorContext,
  AuditErrorPhase,
  AuditLogger,
} from './interfaces/audit-shared-options.interface';

// Constants
export { AUDIT_LOG_OPTIONS } from './audit-log.constants';

// SQL
export {
  getAuditTableSQL,
  getAuditTableStatements,
  applyAuditTableSchema,
  ensurePartitions,
} from './sql';
export type {
  AuditTableSQLOptions,
  EnsurePartitionsOptions,
} from './sql';
