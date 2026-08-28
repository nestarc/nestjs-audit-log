import { computeDeleteChanges } from '../../diff';
import { reportAuditError } from '../audit-errors';
import {
  buildAuditInsertParams,
  tryAuditLog,
  tryLogFailure,
} from '../audit-insert';
import {
  getPkField,
  lockAndRefreshBatch,
  modelDelegateName,
} from '../audit-database';
import {
  assertAtomicBulkSummaryUnsupported,
  batchLimit,
  batchOverflowError,
  batchSummaryMetadata,
  deleteManyRecordMetadata,
  resolveAuditClient,
  shouldSkip,
} from '../mutation-policy';
import type {
  OperationHandler,
  OperationHandlerDependencies,
} from './types';

export function createCreateManyHandler(
  dependencies: OperationHandlerDependencies,
): OperationHandler {
  const {
    client,
    options,
    auditTableRef,
    trackedModels,
    ignoredModels,
    getTransactionClient,
  } = dependencies;

  return async function createMany({ model, args, query }: any) {
    if (shouldSkip(model, trackedModels, ignoredModels)) {
      return query(args);
    }

    assertAtomicBulkSummaryUnsupported(options, 'createMany');

    const auditClient = resolveAuditClient(
      client,
      options,
      getTransactionClient(),
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
  };
}

export function createUpdateManyHandler(
  dependencies: OperationHandlerDependencies,
): OperationHandler {
  const {
    client,
    options,
    auditTableRef,
    trackedModels,
    ignoredModels,
    getTransactionClient,
  } = dependencies;

  return async function updateMany({ model, args, query }: any) {
    if (shouldSkip(model, trackedModels, ignoredModels)) {
      return query(args);
    }

    assertAtomicBulkSummaryUnsupported(options, 'updateMany');

    const auditClient = resolveAuditClient(
      client,
      options,
      getTransactionClient(),
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
  };
}

export function createDeleteManyHandler(
  dependencies: OperationHandlerDependencies,
): OperationHandler {
  const {
    client,
    options,
    Prisma,
    auditTableRef,
    trackedModels,
    ignoredModels,
    sensitiveFieldsFor,
    getTransactionClient,
    lifecycleSuppressionScope,
  } = dependencies;

  return async function deleteMany({ model, args, query }: any) {
    if (shouldSkip(model, trackedModels, ignoredModels)) {
      return query(args);
    }

    const auditClient = resolveAuditClient(
      client,
      options,
      getTransactionClient(),
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
  };
}
