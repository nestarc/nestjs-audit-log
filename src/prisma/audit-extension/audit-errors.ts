import type { AuditErrorContext } from '../../interfaces/audit-shared-options.interface';
import type { AuditExtensionOptions } from './audit-types';

/** Internal options bound to one extension's interactive transaction scope. */
export interface AuditRuntimeOptions extends AuditExtensionOptions {
  markAtomicFailure?: (error: unknown) => void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run diagnostics without letting synchronous or asynchronous failures affect writes. */
export function invokeAuditObserver<Args extends unknown[]>(
  callback: (...args: Args) => unknown,
  args: [...Args],
  onError?: (error: unknown) => unknown,
): void {
  const reportFailure = (error: unknown): void => {
    if (onError) invokeAuditObserver(onError, [error]);
  };
  try {
    const result = callback(...args);
    if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
      // A fresh native promise also safely assimilates thenables with throwing
      // getters, and does not rely on a returned promise's own catch method.
      void new Promise<unknown>(resolve => resolve(result)).catch(reportFailure);
    }
  } catch (error) {
    reportFailure(error);
  }
}

export function reportAuditError(
  options: AuditRuntimeOptions,
  error: unknown,
  ctx: AuditErrorContext,
): void {
  const atomic = options.consistency === 'atomic-required';
  if (atomic) {
    options.markAtomicFailure?.(error);
  }
  const logger = options.logger ?? console;
  const onAuditError = options.onAuditError;
  if (onAuditError) {
    invokeAuditObserver(
      (reportedError, context) => onAuditError.call(options, reportedError, context),
      [error, ctx],
      callbackError => logger.error(
        `[@nestarc/audit-log] onAuditError callback threw: ${errorMessage(callbackError)}`,
      ),
    );
    if (atomic) {
      throw error;
    }
    return;
  }

  invokeAuditObserver(
    () => logger.warn(
      `[@nestarc/audit-log] audit ${ctx.phase} failed for ${
        ctx.model ?? 'unknown'
      }.${ctx.operation ?? 'unknown'}: ${errorMessage(error)}`,
    ),
    [],
  );
  if (atomic) {
    throw error;
  }
}
