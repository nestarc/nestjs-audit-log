import {
  computeCreateChanges,
  computeUpdateChanges,
} from '../../diff';
import { reportAuditError } from '../audit-errors';
import {
  buildAuditInsertParams,
  tryAuditLog,
  tryLogFailure,
} from '../audit-insert';
import {
  getPkField,
  modelDelegateName,
  readBeforeMutation,
  stripInjectedPk,
  tryInjectPk,
  updatedAtFieldsFor,
} from '../audit-database';
import {
  auditFlags,
  enforceNestedWriteContract,
  isEmptyChanges,
  resolveAuditClient,
  shouldSkip,
} from '../mutation-policy';
import type {
  OperationHandler,
  OperationHandlerDependencies,
} from './types';

export function createUpsertHandler(
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
  } = dependencies;

  return async function upsert({ model, args, query }: any) {
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
  };
}
