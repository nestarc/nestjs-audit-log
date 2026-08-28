import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext } from '../services/audit-context';
import {
  computeCreateChanges,
  computeUpdateChanges,
  computeDeleteChanges,
  getSensitiveFieldsFor,
} from './diff';
import { resolvePrismaNamespace } from './prisma-namespace';
import { validateAuditTableName } from '../sql/table-name';
import { reportAuditError } from './audit-extension/audit-errors';
import {
  _resetNoContextWarning,
  buildAuditInsertParams,
  tryAuditLog,
  tryLogFailure,
} from './audit-extension/audit-insert';
import type {
  AuditInsertInput,
  AuditInsertParams,
} from './audit-extension/audit-insert';
import {
  getPkField,
  lockAndRefreshBatch,
  modelDelegateName,
  readBeforeMutation,
  stripInjectedPk,
  tryInjectPk,
  updatedAtFieldsFor,
} from './audit-extension/audit-database';
import {
  _resetNestedWriteWarnings,
  assertAtomicBulkSummaryUnsupported,
  auditFlags,
  batchLimit,
  batchOverflowError,
  batchSummaryMetadata,
  deleteManyRecordMetadata,
  enforceNestedWriteContract,
  isEmptyChanges,
  resolveAuditClient,
  shouldSkip,
  validatePositiveInteger,
  warnForTrackingConfiguration,
} from './audit-extension/mutation-policy';
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
  const lifecycleSuppressionScope = new AsyncLocalStorage<{
    model: string;
    operation: 'delete' | 'deleteMany';
    successfulTokens: Set<symbol>;
  }>();
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
        $allModels: {
          async create({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
            );
            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            enforceNestedWriteContract(model, 'create', args, options, Prisma);
            const pkInjected = tryInjectPk(args, pkField, options, {
              model,
              operation: 'create',
            });
            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(auditClient, options, {
                model,
                operation: 'create',
                args,
                pkField,
                error,
              }, auditTableRef);
              throw error;
            }

            try {
              const pkValue =
                (result as any)[pkField] ??
                (args as any).data?.[pkField] ??
                null;
              const targetId =
                pkValue != null ? String(pkValue) : null;

              let canonical: any = null;
              let postReadFailed = false;
              if (pkValue != null) {
                try {
                  canonical = await (auditClient as any)[delegateName].findFirst({
                    where: { [pkField]: pkValue },
                  });
                } catch (error) {
                  postReadFailed = true;
                  reportAuditError(options, error, {
                    phase: 'post-read',
                    model,
                    operation: 'create',
                  });
                }
              }

              const changes = computeCreateChanges(
                (canonical ?? result) as Record<string, unknown>,
                sensitiveFieldsFor(model),
              );
              const params = buildAuditInsertParams({
                action: `${model}.created`,
                targetType: model,
                targetId,
                changes,
                metadata: auditFlags({ postReadFailed }),
                operation: 'create',
              }, options);
              await tryAuditLog(auditClient, params, options, {
                model,
                operation: 'create',
              }, auditTableRef);
            } catch (error) {
              reportAuditError(options, error, {
                phase: 'context',
                model,
                operation: 'create',
              });
            }

            if (pkInjected) stripInjectedPk(result, pkField);
            return result;
          },

          async update({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
            );
            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const delegate = (auditClient as any)[delegateName];
            enforceNestedWriteContract(model, 'update', args, options, Prisma);
            const pkInjected = tryInjectPk(args, pkField, options, {
              model,
              operation: 'update',
            });
            let before: any = null;
            let preReadFailed = false;
            try {
              before = await readBeforeMutation(
                auditClient,
                delegate,
                model,
                pkField,
                args.where,
                options,
                Prisma,
              );
            } catch (error) {
              preReadFailed = true;
              reportAuditError(options, error, {
                phase: 'pre-read',
                model,
                operation: 'update',
              });
            }

            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(auditClient, options, {
                model,
                operation: 'update',
                args,
                before,
                pkField,
                error,
              }, auditTableRef);
              throw error;
            }

            try {
              const beforePk = (before as any)?.[pkField];
              let afterCanonical: any = null;
              let postReadFailed = false;
              if (beforePk != null) {
                try {
                  afterCanonical = await delegate.findFirst({
                    where: { [pkField]: beforePk },
                  });
                } catch (error) {
                  postReadFailed = true;
                  reportAuditError(options, error, {
                    phase: 'post-read',
                    model,
                    operation: 'update',
                  });
                }
              }

              const ignoredUpdateFields = updatedAtFieldsFor(
                model,
                options,
                Prisma,
              );
              const changes = before
                ? computeUpdateChanges(
                    before as Record<string, unknown>,
                    (afterCanonical ?? result) as Record<
                      string,
                      unknown
                    >,
                    sensitiveFieldsFor(model),
                    ignoredUpdateFields,
                  )
                : {};
              if (
                options.ignoreTimestampOnlyUpdates &&
                before &&
                !preReadFailed &&
                isEmptyChanges(changes)
              ) {
                if (pkInjected) stripInjectedPk(result, pkField);
                return result;
              }
              const params = buildAuditInsertParams({
                action: `${model}.updated`,
                targetType: model,
                targetId: (() => {
                  const pkValue = beforePk ?? (result as any)[pkField] ?? null;
                  return pkValue != null ? String(pkValue) : null;
                })(),
                changes,
                metadata: auditFlags({ preReadFailed, postReadFailed }),
                operation: 'update',
              }, options);
              await tryAuditLog(auditClient, params, options, {
                model,
                operation: 'update',
              }, auditTableRef);
            } catch (error) {
              reportAuditError(options, error, {
                phase: 'context',
                model,
                operation: 'update',
              });
            }

            if (pkInjected) stripInjectedPk(result, pkField);
            return result;
          },

          async delete({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
            );
            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            let before: any = null;
            let preReadFailed = false;
            try {
              before = await readBeforeMutation(
                auditClient,
                (auditClient as any)[delegateName],
                model,
                pkField,
                args.where,
                options,
                Prisma,
              );
            } catch (error) {
              preReadFailed = true;
              reportAuditError(options, error, {
                phase: 'pre-read',
                model,
                operation: 'delete',
              });
            }

            let result: any;
            const suppressionScope = {
              model,
              operation: 'delete' as const,
              successfulTokens: new Set<symbol>(),
            };
            try {
              result = await lifecycleSuppressionScope.run(
                suppressionScope,
                async () => await query(args),
              );
            } catch (error) {
              await tryLogFailure(auditClient, options, {
                model,
                operation: 'delete',
                args,
                before,
                pkField,
                error,
              }, auditTableRef);
              throw error;
            }

            if (suppressionScope.successfulTokens.size > 0) {
              return result;
            }

            try {
              const changes = before
                ? computeDeleteChanges(
                    before as Record<string, unknown>,
                    sensitiveFieldsFor(model),
                  )
                : {};
              const pkValue =
                (before as any)?.[pkField] ??
                (result as any)[pkField] ??
                null;
              const params = buildAuditInsertParams({
                action: `${model}.deleted`,
                targetType: model,
                targetId:
                  pkValue != null ? String(pkValue) : null,
                changes,
                metadata: preReadFailed
                  ? { preReadFailed: true }
                  : undefined,
                operation: 'delete',
              }, options);
              await tryAuditLog(auditClient, params, options, {
                model,
                operation: 'delete',
              }, auditTableRef);
            } catch (error) {
              reportAuditError(options, error, {
                phase: 'context',
                model,
                operation: 'delete',
              });
            }

            return result;
          },

          async upsert({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
            );
            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const delegate = (auditClient as any)[delegateName];
            enforceNestedWriteContract(model, 'upsert', args, options, Prisma);
            const pkInjected = tryInjectPk(args, pkField, options, {
              model,
              operation: 'upsert',
            });
            let before: any = null;
            let preReadFailed = false;
            try {
              before = await readBeforeMutation(
                auditClient,
                delegate,
                model,
                pkField,
                args.where,
                options,
                Prisma,
              );
            } catch (error) {
              preReadFailed = true;
              reportAuditError(options, error, {
                phase: 'pre-read',
                model,
                operation: 'upsert',
              });
            }

            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(auditClient, options, {
                model,
                operation: 'upsert',
                args,
                before,
                pkField,
                error,
              }, auditTableRef);
              throw error;
            }

            try {
              const isCreate = !before && !preReadFailed;
              const pkValue =
                (result as any)[pkField] ??
                (args as any).create?.[pkField] ??
                null;

              let canonical: any = null;
              let postReadFailed = false;
              if (pkValue != null) {
                try {
                  canonical = await delegate.findFirst({
                    where: { [pkField]: pkValue },
                  });
                } catch (error) {
                  postReadFailed = true;
                  reportAuditError(options, error, {
                    phase: 'post-read',
                    model,
                    operation: 'upsert',
                  });
                }
              }

              const ignoredUpdateFields = updatedAtFieldsFor(
                model,
                options,
                Prisma,
              );
              const changes = preReadFailed || isCreate
                ? computeCreateChanges(
                    (canonical ?? result) as Record<
                      string,
                      unknown
                    >,
                    sensitiveFieldsFor(model),
                  )
                : computeUpdateChanges(
                    before as Record<string, unknown>,
                    (canonical ?? result) as Record<
                      string,
                      unknown
                    >,
                    sensitiveFieldsFor(model),
                    ignoredUpdateFields,
                  );
              if (
                options.ignoreTimestampOnlyUpdates &&
                !preReadFailed &&
                !isCreate &&
                before &&
                isEmptyChanges(changes)
              ) {
                if (pkInjected) stripInjectedPk(result, pkField);
                return result;
              }
              const params = buildAuditInsertParams({
                action: preReadFailed
                  ? `${model}.upserted`
                  : isCreate
                    ? `${model}.created`
                    : `${model}.updated`,
                targetType: model,
                targetId:
                  pkValue != null ? String(pkValue) : null,
                changes,
                metadata: auditFlags({ preReadFailed, postReadFailed }),
                operation: 'upsert',
              }, options);
              await tryAuditLog(auditClient, params, options, {
                model,
                operation: 'upsert',
              }, auditTableRef);
            } catch (error) {
              reportAuditError(options, error, {
                phase: 'context',
                model,
                operation: 'upsert',
              });
            }

            if (pkInjected) stripInjectedPk(result, pkField);
            return result;
          },

          async createMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            assertAtomicBulkSummaryUnsupported(options, 'createMany');

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
            );
            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(auditClient, options, {
                model,
                operation: 'createMany',
                args,
                pkField: getPkField(model, options),
                error,
              }, auditTableRef);
              throw error;
            }

            try {
              const params = buildAuditInsertParams({
                action: `${model}.createdMany`,
                targetType: model,
                targetId: null,
                changes: {},
                metadata: batchSummaryMetadata(
                  'createMany',
                  (result as any).count,
                ),
                operation: 'createMany',
              }, options);
              await tryAuditLog(auditClient, params, options, {
                model,
                operation: 'createMany',
              }, auditTableRef);
            } catch (error) {
              reportAuditError(options, error, {
                phase: 'context',
                model,
                operation: 'createMany',
              });
            }

            return result;
          },

          async updateMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            assertAtomicBulkSummaryUnsupported(options, 'updateMany');

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
            );
            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(auditClient, options, {
                model,
                operation: 'updateMany',
                args,
                pkField: getPkField(model, options),
                error,
              }, auditTableRef);
              throw error;
            }

            try {
              const params = buildAuditInsertParams({
                action: `${model}.updatedMany`,
                targetType: model,
                targetId: null,
                changes: {},
                metadata: batchSummaryMetadata(
                  'updateMany',
                  (result as any).count,
                ),
                operation: 'updateMany',
              }, options);
              await tryAuditLog(auditClient, params, options, {
                model,
                operation: 'updateMany',
              }, auditTableRef);
            } catch (error) {
              reportAuditError(options, error, {
                phase: 'context',
                model,
                operation: 'updateMany',
              });
            }

            return result;
          },

          async deleteMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
            );
            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const maxBatchRecords = batchLimit(options);
            const overflowPolicy = options.batchOverflow ?? 'reject';
            let records: any[] = [];
            let preReadFailed = false;
            let overflowed = false;
            try {
              records = await (auditClient as any)[
                delegateName
              ].findMany({
                where: args.where,
                take: maxBatchRecords + 1,
              });
              if (records.length > maxBatchRecords) {
                if (
                  options.consistency === 'atomic-required' ||
                  overflowPolicy === 'reject'
                ) {
                  throw batchOverflowError(
                    model,
                    records.length,
                    maxBatchRecords,
                  );
                }
                overflowed = true;
                records = [];
              }
              records = await lockAndRefreshBatch(
                auditClient,
                (auditClient as any)[delegateName],
                model,
                pkField,
                records,
                options,
                Prisma,
              );
            } catch (error) {
              if (error instanceof Error && error.message.includes('maxBatchRecords')) {
                throw error;
              }
              preReadFailed = true;
              reportAuditError(options, error, {
                phase: 'pre-read',
                model,
                operation: 'deleteMany',
              });
            }

            let result: any;
            const suppressionScope = {
              model,
              operation: 'deleteMany' as const,
              successfulTokens: new Set<symbol>(),
            };
            try {
              result = await lifecycleSuppressionScope.run(
                suppressionScope,
                async () => await query(args),
              );
            } catch (error) {
              await tryLogFailure(auditClient, options, {
                model,
                operation: 'deleteMany',
                args,
                pkField,
                error,
              }, auditTableRef);
              throw error;
            }

            if (suppressionScope.successfulTokens.size > 0) {
              return result;
            }

            if (preReadFailed || overflowed) {
              try {
                const params = buildAuditInsertParams({
                  action: `${model}.deletedMany`,
                  targetType: model,
                  targetId: null,
                  changes: {},
                  metadata: batchSummaryMetadata(
                    'deleteMany',
                    (result as any).count,
                    preReadFailed
                      ? { preReadFailed: true }
                      : {
                          overflow: true,
                          maxBatchRecords,
                        },
                  ),
                  operation: 'deleteMany',
                }, options);
                await tryAuditLog(auditClient, params, options, {
                  model,
                  operation: 'deleteMany',
                }, auditTableRef);
              } catch (error) {
                reportAuditError(options, error, {
                  phase: 'context',
                  model,
                  operation: 'deleteMany',
                });
              }
            } else {
              if (
                options.consistency === 'atomic-required' &&
                (result as any).count !== records.length
              ) {
                throw new Error(
                  `[@nestarc/audit-log] ${model}.deleteMany affected ${(result as any).count} records but captured ${records.length} preimages; the transaction was rolled back to avoid incomplete audit evidence`,
                );
              }
              for (const record of records) {
                try {
                  const changes = computeDeleteChanges(
                    record as Record<string, unknown>,
                    sensitiveFieldsFor(model),
                  );
                  const recordPk =
                    (record as any)[pkField] ?? null;
                  const params = buildAuditInsertParams({
                    action: `${model}.deleted`,
                    targetType: model,
                    targetId:
                      recordPk != null
                        ? String(recordPk)
                        : null,
                    changes,
                    metadata: deleteManyRecordMetadata(records.length),
                    operation: 'deleteMany',
                  }, options);
                  await tryAuditLog(auditClient, params, options, {
                    model,
                    operation: 'deleteMany',
                  }, auditTableRef);
                } catch (error) {
                  reportAuditError(options, error, {
                    phase: 'context',
                    model,
                    operation: 'deleteMany',
                  });
                }
              }
            }

            return result;
          },
        },
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
