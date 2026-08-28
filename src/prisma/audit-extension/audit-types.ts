import type { AuditSharedOptions } from '../../interfaces/audit-shared-options.interface';
import type { PrismaModuleLike } from '../prisma-namespace';

export type AuditConsistency = 'atomic-required' | 'best-effort';
export type AuditBatchOverflow = 'reject' | 'summary';

export interface AuditCapabilities {
  readonly consistency: AuditConsistency;
  readonly atomicLifecycle: boolean;
}

export interface AuditCapabilityMethods {
  getAuditCapabilities(): AuditCapabilities;
}

export interface AuditTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?:
    | 'ReadUncommitted'
    | 'ReadCommitted'
    | 'RepeatableRead'
    | 'Serializable';
}

export interface AuditTransactionMethods<TTransactionClient> {
  withAuditTransaction<TResult>(
    callback: (tx: TTransactionClient) => Promise<TResult>,
    options?: AuditTransactionOptions,
  ): Promise<TResult>;
  withAuditLifecycle<TResult>(
    input: AuditLifecycleInput,
    callback: (tx: TTransactionClient) => Promise<TResult>,
  ): Promise<TResult>;
}

export interface AuditLifecycleInput {
  /** Deterministic lifecycle action, for example `User.softDeleted`. */
  action: string;
  /** Metadata merged into the ambient audit context for this mutation. */
  metadata?: Record<string, unknown>;
  /** Internal extension-composition signal for a rewritten outer operation. */
  suppressOuterOperation?: { model: string; operation: 'delete' | 'deleteMany' };
}

export interface AuditDatabaseMapping {
  /** PostgreSQL table name used by the Prisma model. */
  tableName: string;
  /** PostgreSQL schema name. Defaults to the connection's current schema. */
  schema?: string;
  /** Database column for the configured logical primary key field. */
  primaryKeyColumn?: string;
}

export interface AuditExtensionOptions extends AuditSharedOptions {
  /**
   * `atomic-required` rejects tracked writes outside withAuditTransaction().
   * `best-effort` preserves the legacy non-atomic behavior.
   */
  consistency: AuditConsistency;
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  sensitiveFieldsByModel?: Record<string, string[]>;
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
  /**
   * Database identifiers used for atomic row locks. Required for models that
   * use Prisma mapping attributes when the generated Prisma namespace does
   * not expose public DMMF mapping metadata.
   */
  databaseMapping?: Record<string, AuditDatabaseMapping>;
  /**
   * Maximum records that deleteMany may audit individually. Defaults to 1000.
   */
  maxBatchRecords?: number;
  /**
   * Behavior when deleteMany matches more than maxBatchRecords. Defaults to
   * reject. Summary overflow is available only in best-effort mode.
   */
  batchOverflow?: AuditBatchOverflow;
  logFailures?: boolean;
  ignoreTimestampOnlyUpdates?: boolean;
  prismaModule?: PrismaModuleLike;
}
