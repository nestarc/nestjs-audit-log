import type { AuditDatabaseProvider } from '../sql/provider';

/** Minimal logger compatible with console and NestJS LoggerService. */
export interface AuditLogger {
  warn(message: string): void;
  error(message: string): void;
}

export type AuditErrorPhase =
  | 'pre-read'
  | 'insert'
  | 'post-read'
  | 'tenant-resolution'
  | 'context'
  | 'validation'
  | 'serialization';

/** Stable diagnostic classifications; the original thrown error is preserved. */
export type AuditErrorCode =
  | 'AUDIT_CONTEXT_INVALID'
  | 'AUDIT_TENANT_INVALID'
  | 'AUDIT_INPUT_INVALID'
  | 'AUDIT_SERIALIZATION_FAILED'
  | 'AUDIT_METADATA_TOO_LARGE'
  | 'AUDIT_INSERT_FAILED'
  | 'AUDIT_TRANSACTION_FAILED';

export interface AuditErrorContext {
  phase: AuditErrorPhase;
  code?: AuditErrorCode;
  provider?: AuditDatabaseProvider;
  durationMs?: number;
  model?: string;
  operation?: string;
  action?: string;
  targetId?: string | null;
  tenantId?: string | null;
}

/** No event payload, identifiers or raw errors are included in operation telemetry. */
export interface AuditOperationEvent {
  readonly provider: AuditDatabaseProvider;
  readonly operation: 'log' | 'transaction';
  readonly status: 'success' | 'failure';
  readonly durationMs: number;
  /** A successful external log is an INSERT completion, not a commit notification. */
  readonly transaction: 'external' | 'standalone' | 'managed';
  readonly phase?: AuditErrorPhase;
  readonly code?: AuditErrorCode;
}

/**
 * Options shared by the Nest module and Prisma extension.
 * Runtime merging is intentionally not performed; pass the same object to both
 * call sites or use defineAuditConfig() when both paths should share behavior.
 */
export interface AuditSharedOptions {
  /** Defaults to PostgreSQL. SQL Server currently supports manual logging only. */
  provider?: AuditDatabaseProvider;
  tableName?: string;
  /** Require a non-blank string actor ID for audit writes. Defaults to false. */
  actorRequired?: boolean;
  tenantRequired?: boolean;
  tenantResolver?: () => string | null;
  /** Return values are ignored; returned thenable rejections are safely observed. */
  onAuditError?: (error: unknown, ctx: AuditErrorContext) => unknown;
  logger?: AuditLogger;
}
