import { computeDeleteChanges } from '../../diff';
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
} from '../audit-database';
import {
  resolveAuditClient,
  shouldSkip,
} from '../mutation-policy';
import type {
  OperationHandler,
  OperationHandlerDependencies,
} from './types';

export function createDeleteHandler(
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

  return async function deleteOperation({ model, args, query }: any) {
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
  };
}
