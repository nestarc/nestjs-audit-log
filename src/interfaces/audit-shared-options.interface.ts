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
  | 'context';

export interface AuditErrorContext {
  phase: AuditErrorPhase;
  model?: string;
  operation?: string;
  action?: string;
  targetId?: string | null;
  tenantId?: string | null;
}

/**
 * Options shared by the Nest module and Prisma extension.
 * Runtime merging is intentionally not performed; pass the same object to both
 * call sites when both paths should share behavior.
 */
export interface AuditSharedOptions {
  tableName?: string;
  tenantRequired?: boolean;
  tenantResolver?: () => string | null;
  onAuditError?: (error: unknown, ctx: AuditErrorContext) => void;
  logger?: AuditLogger;
}
