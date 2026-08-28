import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext } from '../services/audit-context';
import { getSensitiveFieldsFor } from './diff';
import { resolvePrismaNamespace } from './prisma-namespace';
import { validateAuditTableName } from '../sql/table-name';
import {
  _resetNoContextWarning,
  buildAuditInsertParams,
} from './audit-extension/audit-insert';
import type {
  AuditInsertInput,
  AuditInsertParams,
} from './audit-extension/audit-insert';
import {
  getPkField,
  modelDelegateName,
} from './audit-extension/audit-database';
import {
  _resetNestedWriteWarnings,
  validatePositiveInteger,
  warnForTrackingConfiguration,
} from './audit-extension/mutation-policy';
import { createOperationHandlers } from './audit-extension/operation-handlers';
import type { LifecycleSuppressionScope } from './audit-extension/operation-handlers';
import type {
  AuditBatchOverflow,
  AuditCapabilities,
  AuditCapabilityMethods,
  AuditConsistency,
  AuditDatabaseMapping,
  AuditExtensionOptions,
  AuditLifecycleInput,
  AuditTransactionMethods,
  AuditTransactionOptions,
} from './audit-extension/audit-types';

export {
  _resetNestedWriteWarnings,
  _resetNoContextWarning,
  buildAuditInsertParams,
  getPkField,
  modelDelegateName,
};
export type { AuditInsertInput, AuditInsertParams };
export type {
  AuditBatchOverflow,
  AuditCapabilities,
  AuditCapabilityMethods,
  AuditConsistency,
  AuditDatabaseMapping,
  AuditExtensionOptions,
  AuditLifecycleInput,
  AuditTransactionMethods,
  AuditTransactionOptions,
};

interface InteractiveTransactionHost {
  $extends(extension: any): any;
  $transaction: (...args: any[]) => any;
}

type TransactionClientOf<TClient> = TClient extends {
  $transaction<TResult>(
    callback: (tx: infer TTransactionClient) => Promise<TResult>,
    options?: any,
  ): Promise<TResult>;
}
  ? TTransactionClient
  : never;

const EXPERIMENTAL_TX_AUDIT_REMOVED_ERROR =
  '[@nestarc/audit-log] experimentalTxAudit was removed in v0.5.0; use consistency: "atomic-required" with withAuditTransaction(), or remove experimentalTxAudit and keep explicit consistency: "best-effort"';
const NESTED_TRANSACTION_ERROR =
  '[@nestarc/audit-log] nested withAuditTransaction() calls are not supported';
const AUDIT_LIFECYCLE_CONTEXT_ERROR =
  '[@nestarc/audit-log] withAuditLifecycle() must run inside withAuditTransaction()';
const AUDIT_LIFECYCLE_CONSISTENCY_ERROR =
  '[@nestarc/audit-log] withAuditLifecycle() requires consistency: "atomic-required"';

export function createAuditExtension(options: AuditExtensionOptions): any {
  if (Object.prototype.hasOwnProperty.call(options, 'experimentalTxAudit')) {
    throw new Error(EXPERIMENTAL_TX_AUDIT_REMOVED_ERROR);
  }
  if (
    options.consistency !== 'atomic-required' &&
    options.consistency !== 'best-effort'
  ) {
    throw new Error(
      '[@nestarc/audit-log] consistency must be explicitly set to "atomic-required" or "best-effort"',
    );
  }
  if (
    options.maxBatchRecords !== undefined &&
    (!Number.isInteger(options.maxBatchRecords) || options.maxBatchRecords < 1)
  ) {
    throw new Error(
      '[@nestarc/audit-log] maxBatchRecords must be a positive integer',
    );
  }
  if (
    options.batchOverflow !== undefined &&
    options.batchOverflow !== 'reject' &&
    options.batchOverflow !== 'summary'
  ) {
    throw new Error(
      '[@nestarc/audit-log] batchOverflow must be "reject" or "summary"',
    );
  }
  if (
    options.consistency === 'atomic-required' &&
    options.batchOverflow === 'summary'
  ) {
    throw new Error(
      '[@nestarc/audit-log] batchOverflow: "summary" is only available in best-effort mode',
    );
  }
  const sensitiveFieldsFor = (model: string) =>
    getSensitiveFieldsFor(model, options);
  const { trackedModels, ignoredModels } = options;
  const tableName = validateAuditTableName(options.tableName);

  const Prisma = resolvePrismaNamespace(options);
  const auditTableRef =
    tableName === 'audit_logs' ? undefined : Prisma.raw!(tableName);
  warnForTrackingConfiguration(
    options,
    Prisma.dmmf?.datamodel?.models?.map((model) => model.name),
  );

  const transactionContext = new AsyncLocalStorage<any>();
  const lifecycleSuppressionScope =
    new AsyncLocalStorage<LifecycleSuppressionScope>();
  const auditCapabilities: AuditCapabilities = Object.freeze({
    consistency: options.consistency,
    atomicLifecycle: options.consistency === 'atomic-required',
  });

  return Prisma.defineExtension((client: any) => {
    return client.$extends({
      name: '@nestarc/audit-log',
      client: {
        getAuditCapabilities(): AuditCapabilities {
          return auditCapabilities;
        },
        async withAuditTransaction<TResult>(
          this: any,
          callback: (tx: any) => Promise<TResult>,
          transactionOptions?: AuditTransactionOptions,
        ): Promise<TResult> {
          if (transactionContext.getStore()) {
            throw new Error(NESTED_TRANSACTION_ERROR);
          }
          validatePositiveInteger(transactionOptions?.timeout, 'timeout');
          validatePositiveInteger(transactionOptions?.maxWait, 'maxWait');
          return this.$transaction(
            (tx: any) =>
              transactionContext.run(tx, async () => await callback(tx)),
            transactionOptions,
          );
        },
        async withAuditLifecycle<TResult>(
          input: AuditLifecycleInput,
          callback: (tx: any) => Promise<TResult>,
        ): Promise<TResult> {
          if (!auditCapabilities.atomicLifecycle) {
            throw new Error(AUDIT_LIFECYCLE_CONSISTENCY_ERROR);
          }
          const tx = transactionContext.getStore();
          if (!tx) {
            throw new Error(AUDIT_LIFECYCLE_CONTEXT_ERROR);
          }
          if (!input || typeof input.action !== 'string' || input.action.length === 0) {
            throw new Error(
              '[@nestarc/audit-log] withAuditLifecycle() requires a non-empty action',
            );
          }
          const suppressionScope = lifecycleSuppressionScope.getStore();
          const matchingSuppressionScope =
            input.suppressOuterOperation &&
            suppressionScope?.model === input.suppressOuterOperation.model &&
            suppressionScope.operation === input.suppressOuterOperation.operation
              ? suppressionScope
              : undefined;
          const suppressionToken = matchingSuppressionScope
            ? Symbol('audit-lifecycle-suppression')
            : undefined;
          if (matchingSuppressionScope && suppressionToken) {
            matchingSuppressionScope.successfulTokens.add(suppressionToken);
          }

          const parent = AuditContext.getStore();
          let callbackSucceeded = false;
          try {
            const result = await AuditContext.run(
              {
                actor: parent?.actor ?? null,
                noAudit: parent?.noAudit ?? false,
                actionOverride: input.action,
                metadata: {
                  ...(parent?.metadata ?? {}),
                  ...(input.metadata ?? {}),
                },
                ...(parent?.reason !== undefined ? { reason: parent.reason } : {}),
              },
              async () => await callback(tx),
            );
            callbackSucceeded = true;
            return result;
          } finally {
            if (
              matchingSuppressionScope &&
              suppressionToken &&
              !callbackSucceeded
            ) {
              matchingSuppressionScope.successfulTokens.delete(suppressionToken);
            }
          }
        },
      },
      query: {
        $allModels: createOperationHandlers({
          client,
          options,
          Prisma,
          auditTableRef,
          trackedModels,
          ignoredModels,
          sensitiveFieldsFor,
          getTransactionClient: () => transactionContext.getStore(),
          lifecycleSuppressionScope,
        }),
      },
    });
  });
}

/**
 * Creates an audited Prisma client while preserving the base client and
 * interactive transaction callback types.
 */
export function createAuditedClient<TClient extends InteractiveTransactionHost>(
  client: TClient,
  options: AuditExtensionOptions,
): TClient &
  AuditTransactionMethods<TransactionClientOf<TClient>> &
  AuditCapabilityMethods {
  return client.$extends(createAuditExtension(options)) as TClient &
    AuditTransactionMethods<TransactionClientOf<TClient>> &
    AuditCapabilityMethods;
}
