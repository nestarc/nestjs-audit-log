// Module
export { AuditLogModule } from './audit-log.module';

// Service
export { AuditService } from './services/audit.service';
export { AUDIT_CSV_COLUMNS_V1 } from './services/audit-csv';
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
  AuditBatchOverflow,
  AuditConsistency,
  AuditDatabaseMapping,
  AuditExtensionOptions,
  AuditLifecycleInput,
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
  AuditCsvColumnVersion,
  AuditCsvOptions,
  AuditExportScope,
  AuditGetByIdOptions,
  AuditQueryOptions,
  AuditQueryResult,
  AuditScanOptions,
  AuditScanPage,
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

// Durable log streams
export {
  AuditStreamDeliveryError,
  AuditStreamRunner,
} from './stream/audit-stream';
export type {
  AuditStreamBatchContext,
  AuditStreamCheckpointStore,
  AuditStreamDeadLetter,
  AuditStreamDeadLetterStore,
  AuditStreamErrorContext,
  AuditStreamMetric,
  AuditStreamRunnerOptions,
  AuditStreamRunResult,
  AuditStreamSink,
  AuditStreamState,
} from './stream/audit-stream';
export { HttpAuditStreamSink } from './stream/http-sink';
export type {
  AuditHttpStreamFormat,
  HttpAuditStreamSinkOptions,
} from './stream/http-sink';
export {
  DatadogAuditStreamSink,
  ObjectStorageAuditStreamSink,
  SplunkAuditStreamSink,
} from './stream/provider-sinks';
export type {
  AuditObjectStorageClient,
  AuditObjectStoragePutInput,
  DatadogAuditStreamSinkOptions,
  ObjectStorageAuditStreamSinkOptions,
  SplunkAuditStreamSinkOptions,
} from './stream/provider-sinks';
export {
  applyAuditStreamStoreSchema,
  getAuditStreamStoreStatements,
  PostgresAuditStreamStore,
} from './stream/postgres-store';
export type {
  AuditStreamStoreSQLOptions,
  PostgresAuditStreamStoreOptions,
} from './stream/postgres-store';

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
