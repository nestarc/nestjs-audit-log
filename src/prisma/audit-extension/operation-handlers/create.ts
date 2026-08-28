import { computeCreateChanges } from '../../diff';
import { reportAuditError } from '../audit-errors';
import {
  buildAuditInsertParams,
  tryAuditLog,
  tryLogFailure,
} from '../audit-insert';
import {
  getPkField,
  modelDelegateName,
  stripInjectedPk,
  tryInjectPk,
} from '../audit-database';
import {
  auditFlags,
  enforceNestedWriteContract,
  resolveAuditClient,
  shouldSkip,
} from '../mutation-policy';
import type {
  OperationHandler,
  OperationHandlerDependencies,
} from './types';

export function createCreateHandler(
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

  return async function create({ model, args, query }: any) {
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
  };
}
