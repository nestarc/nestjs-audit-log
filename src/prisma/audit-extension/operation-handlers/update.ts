import { computeUpdateChanges } from '../../diff';
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

export function createUpdateHandler(
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

  return async function update({ model, args, query }: any) {
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
  };
}
