import type { AuditErrorContext } from '../../interfaces/audit-shared-options.interface';
import type { AuditExtensionOptions } from './audit-types';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportAuditError(
  options: AuditExtensionOptions,
  error: unknown,
  ctx: AuditErrorContext,
): void {
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
