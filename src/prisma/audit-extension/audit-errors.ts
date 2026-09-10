import type { AuditErrorContext } from '../../interfaces/audit-shared-options.interface';
import type { AuditExtensionOptions } from './audit-types';

/** Internal options bound to one extension's interactive transaction scope. */
export interface AuditRuntimeOptions extends AuditExtensionOptions {
  markAtomicFailure?: (error: unknown) => void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportAuditError(
  options: AuditRuntimeOptions,
  error: unknown,
  ctx: AuditErrorContext,
): void {
  if (options.consistency === 'atomic-required') {
    options.markAtomicFailure?.(error);
  }
  const logger = options.logger ?? console;
  if (options.onAuditError) {
    try {
      options.onAuditError(error, ctx);
    } catch (callbackError) {
      try {
        logger.error(
          `[@nestarc/audit-log] onAuditError callback threw: ${errorMessage(
            callbackError,
          )}`,
        );
      } catch {
        // Reporting must never affect the caller's mutation.
      }
    }
    if (options.consistency === 'atomic-required') {
      throw error;
    }
    return;
  }

  try {
    logger.warn(
      `[@nestarc/audit-log] audit ${ctx.phase} failed for ${
        ctx.model ?? 'unknown'
      }.${ctx.operation ?? 'unknown'}: ${errorMessage(error)}`,
    );
  } catch {
    // Reporting must never affect the caller's mutation.
  }
  if (options.consistency === 'atomic-required') {
    throw error;
  }
}
