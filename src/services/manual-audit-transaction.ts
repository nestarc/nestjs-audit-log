import { AsyncLocalStorage } from 'node:async_hooks';
import type { ManualAuditLogInput } from '../interfaces/audit-entry.interface';

/** A Prisma client exposing the public interactive transaction API. */
export interface ManualAuditTransactionHost {
  $transaction: (...args: any[]) => any;
}

/** Infer the generated client's transaction models without importing a Prisma client. */
export type ManualAuditTransactionClient<TClient> = TClient extends {
  $transaction<TResult>(
    callback: (tx: infer TTransactionClient) => Promise<TResult>,
    options?: any,
  ): Promise<TResult>;
} ? TTransactionClient : never;

export interface ManualAuditTransactionOptions {
  maxWait?: number;
  timeout?: number;
  /** The Prisma runtime, adapter and database must support this isolation level. */
  isolationLevel?:
    | 'ReadUncommitted'
    | 'ReadCommitted'
    | 'RepeatableRead'
    | 'Snapshot'
    | 'Serializable';
}

export interface ManualAuditTransactionScope<TTransactionClient> {
  readonly tx: TTransactionClient;
  /** Always writes on this scope's transaction; await it to observe errors locally. */
  readonly log: (input: ManualAuditLogInput) => Promise<void>;
}

interface TransactionScopeState {
  active: boolean;
  acceptingWrites: boolean;
}

// Shared across service instances so one helper cannot open another transaction
// from inside a helper's callback, even when the services use different clients.
const transactionScope = new AsyncLocalStorage<TransactionScopeState>();
const isolationLevels = new Set([
  'ReadUncommitted', 'ReadCommitted', 'RepeatableRead', 'Snapshot', 'Serializable',
]);

function validateOptions(
  options: ManualAuditTransactionOptions | undefined,
): ManualAuditTransactionOptions | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('[@nestarc/audit-log] manual transaction options must be an object');
  }
  const allowed = new Set(['maxWait', 'timeout', 'isolationLevel']);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`[@nestarc/audit-log] Unknown manual transaction option ${String(key)}`);
    }
  }
  const { maxWait, timeout, isolationLevel } = options;
  for (const [name, value] of [['maxWait', maxWait], ['timeout', timeout]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`[@nestarc/audit-log] ${name} must be a positive safe integer`);
    }
  }
  if (isolationLevel !== undefined && !isolationLevels.has(isolationLevel)) {
    throw new TypeError('[@nestarc/audit-log] Unsupported manual transaction isolationLevel');
  }
  return {
    ...(maxWait === undefined ? {} : { maxWait }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(isolationLevel === undefined ? {} : { isolationLevel }),
  };
}

/**
 * Own an official Prisma transaction and bind manual audit writes to it.
 * An audit failure prevents commit even when caught by the callback. Started
 * audit calls settle before completion; scheduling new calls after the callback
 * returns is not supported. Existing external transactions remain caller-owned.
 */
export async function runManualAuditTransaction<
  TClient extends ManualAuditTransactionHost,
  TResult,
>(
  client: TClient,
  logFn: (input: ManualAuditLogInput, tx: ManualAuditTransactionClient<TClient>) => Promise<void>,
  callback: (scope: ManualAuditTransactionScope<ManualAuditTransactionClient<TClient>>) => Promise<TResult>,
  options?: ManualAuditTransactionOptions,
): Promise<TResult> {
  if (transactionScope.getStore()?.active) {
    throw new Error('[@nestarc/audit-log] nested withManualTransaction() calls are not supported');
  }
  if (client === null || client === undefined || typeof client.$transaction !== 'function') {
    throw new TypeError('[@nestarc/audit-log] withManualTransaction() requires a Prisma transaction client host');
  }
  if (typeof logFn !== 'function' || typeof callback !== 'function') {
    throw new TypeError('[@nestarc/audit-log] withManualTransaction() requires a log function and callback');
  }
  const transactionOptions = validateOptions(options);
  let state: TransactionScopeState | undefined;
  try {
    return await client.$transaction((tx: ManualAuditTransactionClient<TClient>) => {
      const currentState: TransactionScopeState = { active: true, acceptingWrites: true };
      state = currentState;
      return transactionScope.run(currentState, async () => {
        const pending: Promise<void>[] = [];
        let auditFailed = false;
        let auditFailure: unknown;
        const log = (input: ManualAuditLogInput): Promise<void> => {
          if (!currentState.acceptingWrites) {
            return Promise.reject(new Error('[@nestarc/audit-log] manual audit transaction scope has ended'));
          }
          // Invoke immediately so the logging service snapshots actor, tenant
          // and event input at the call site, including for an unawaited call.
          // The Promise executor also turns a synchronous throw into rejection.
          const write = new Promise<void>(resolve => resolve(logFn(input, tx)));
          // Observe failures immediately, including calls the callback did not
          // await. Keep a separate boolean because JS may throw null/undefined.
          pending.push(write.then(() => undefined, (error: unknown) => {
            if (!auditFailed) {
              auditFailed = true;
              auditFailure = error;
            }
          }));
          return write;
        };
        let callbackFailed = false;
        let callbackFailure: unknown;
        let result: TResult | undefined;
        try {
          try {
            result = await callback(Object.freeze({ tx, log }));
          } catch (error) {
            callbackFailed = true;
            callbackFailure = error;
          } finally {
            currentState.acceptingWrites = false;
          }
          await Promise.all(pending);
          if (callbackFailed) throw callbackFailure;
          if (auditFailed) throw auditFailure;
          return result as TResult;
        } finally {
          currentState.acceptingWrites = false;
        }
      });
    }, transactionOptions);
  } finally {
    // Prisma can reject on timeout before the callback has finished. Revoke
    // its writer immediately rather than sending new writes to an expired tx.
    if (state) {
      state.active = false;
      state.acceptingWrites = false;
    }
  }
}
