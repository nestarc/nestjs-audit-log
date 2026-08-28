import { AuditContext, mergeContextMetadata } from '../../services/audit-context';
import { resolveTenantId } from '../../utils/tenant';
import type { AuditErrorContext } from '../../interfaces/audit-shared-options.interface';
import { getSensitiveFieldsFor, redactObject } from '../diff';
import type { Changes } from '../diff';
import type {
  AuditConsistency,
  AuditExtensionOptions,
} from './audit-types';
import { errorMessage, reportAuditError } from './audit-errors';

const NO_CONTEXT_WARNING_MESSAGE =
  '[@nestarc/audit-log] audited write executed without an audit context store — actorId will be null. Wrap background work in AuditContext.runAs(actor, fn). (warned once per process)';

let noContextWarningReported = false;

export interface AuditInsertParams {
  tenantId: string | null;
  actorId: string | null;
  actorType: string;
  actorIp: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  source: 'auto';
  changes: Changes;
  metadata?: Record<string, unknown>;
  result: 'success' | 'failure';
}

export interface AuditInsertInput {
  action: string;
  targetType: string;
  targetId: string | null;
  changes: Changes;
  metadata?: Record<string, unknown>;
  operation?: string;
  result?: 'success' | 'failure';
}

type AuditInsertBuildOptions = Omit<AuditExtensionOptions, 'consistency'> & {
  consistency?: AuditConsistency;
};

export function _resetNoContextWarning(): void {
  noContextWarningReported = false;
}

export function buildAuditInsertParams(
  input: AuditInsertInput,
): AuditInsertParams;
export function buildAuditInsertParams(
  input: AuditInsertInput,
  options: AuditInsertBuildOptions,
): AuditInsertParams | null;
export function buildAuditInsertParams(
  input: AuditInsertInput,
  options: AuditInsertBuildOptions = {},
): AuditInsertParams | null {
  const runtimeOptions: AuditExtensionOptions = {
    consistency: 'best-effort',
    ...options,
  };
  const store = AuditContext.getStore();
  const actor = store?.actor ?? null;
  const actionOverride = store?.actionOverride;
  const action = actionOverride ?? input.action;
  warnForMissingContextStore(input, runtimeOptions, action, store);
  let tenantId: string | null = null;

  try {
    tenantId = resolveTenantId({
      tenantResolver: runtimeOptions.tenantResolver,
    });
  } catch (error) {
    reportAuditError(runtimeOptions, error, {
      phase: 'tenant-resolution',
      model: input.targetType,
      operation: input.operation,
      action,
      targetId: input.targetId,
      tenantId: null,
    });
    if (runtimeOptions.tenantRequired) {
      return null;
    }
  }

  if (tenantId === null && runtimeOptions.tenantRequired) {
    reportAuditError(
      runtimeOptions,
      new Error(
        '[@nestarc/audit-log] tenant context required but unavailable; audit entry skipped',
      ),
      {
        phase: 'tenant-resolution',
        model: input.targetType,
        operation: input.operation,
        action,
        targetId: input.targetId,
        tenantId: null,
      },
    );
    return null;
  }

  const mergedMetadata = mergeContextMetadata(input.metadata);
  const metadata = mergedMetadata
    ? redactObject(
        mergedMetadata,
        getSensitiveFieldsFor(input.targetType, runtimeOptions),
      )
    : undefined;

  return {
    tenantId,
    actorId: actor?.id ?? null,
    actorType: actor?.type ?? 'system',
    actorIp: actor?.ip ?? null,
    action,
    targetType: input.targetType,
    targetId: input.targetId,
    source: 'auto',
    changes: input.changes,
    metadata,
    result: input.result ?? 'success',
  };
}

function warnForMissingContextStore(
  input: AuditInsertInput,
  options: AuditExtensionOptions,
  action: string,
  store: ReturnType<typeof AuditContext.getStore>,
): void {
  if (store || noContextWarningReported) {
    return;
  }
  noContextWarningReported = true;

  const error = new Error(NO_CONTEXT_WARNING_MESSAGE);
  const ctx: AuditErrorContext = {
    phase: 'context',
    model: input.targetType,
    operation: input.operation,
    action,
    targetId: input.targetId,
  };
  const logger = options.logger ?? console;

  if (options.onAuditError) {
    try {
      options.onAuditError(error, ctx);
      return;
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
      return;
    }
  }

  try {
    logger.warn(NO_CONTEXT_WARNING_MESSAGE);
  } catch {
    // Reporting must never affect the caller's mutation.
  }
}

async function insertAuditLog(
  client: any,
  params: AuditInsertParams,
  tableRef?: unknown,
): Promise<void> {
  const changesJson = JSON.stringify(params.changes);
  const metadataJson = params.metadata
    ? JSON.stringify(params.metadata)
    : null;

  if (tableRef) {
    await client.$executeRaw`
    INSERT INTO ${tableRef}
      (tenant_id, actor_id, actor_type, actor_ip, action,
       target_type, target_id, source, changes, metadata, result)
    VALUES (
      ${params.tenantId},
      ${params.actorId},
      ${params.actorType},
      ${params.actorIp},
      ${params.action},
      ${params.targetType},
      ${params.targetId},
      ${params.source},
      ${changesJson}::jsonb,
      ${metadataJson}::jsonb,
      ${params.result}
    )
  `;
    return;
  }

  await client.$executeRaw`
    INSERT INTO audit_logs
      (tenant_id, actor_id, actor_type, actor_ip, action,
       target_type, target_id, source, changes, metadata, result)
    VALUES (
      ${params.tenantId},
      ${params.actorId},
      ${params.actorType},
      ${params.actorIp},
      ${params.action},
      ${params.targetType},
      ${params.targetId},
      ${params.source},
      ${changesJson}::jsonb,
      ${metadataJson}::jsonb,
      ${params.result}
    )
  `;
}

function shouldSkipFailureAudit(error: unknown): boolean {
  const maybePrismaError = error as { code?: string; name?: string };
  return (
    maybePrismaError?.code === 'P2025' ||
    maybePrismaError?.name === 'PrismaClientValidationError'
  );
}

function failureAction(model: string, operation: string): string {
  switch (operation) {
    case 'create':
      return `${model}.created`;
    case 'update':
      return `${model}.updated`;
    case 'delete':
      return `${model}.deleted`;
    case 'upsert':
      return `${model}.upserted`;
    case 'createMany':
      return `${model}.createdMany`;
    case 'updateMany':
      return `${model}.updatedMany`;
    case 'deleteMany':
      return `${model}.deletedMany`;
    default:
      return `${model}.${operation}`;
  }
}

function scalarTargetId(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return null;
}

function failureTargetId(input: {
  operation: string;
  args: any;
  before?: any;
  pkField: string;
}): string | null {
  if (input.operation.endsWith('Many')) return null;
  const beforePk = input.before?.[input.pkField];
  if (beforePk != null) return String(beforePk);
  if (input.operation === 'create') {
    return scalarTargetId(input.args?.data?.[input.pkField]);
  }
  return scalarTargetId(input.args?.where?.[input.pkField]);
}

function failureMetadata(
  operation: string,
  error: unknown,
): Record<string, unknown> {
  const maybeError = error as { name?: string; code?: string; message?: string };
  const errorInfo: Record<string, unknown> = {
    name: maybeError?.name ?? 'Error',
    message: errorMessage(error).slice(0, 500),
  };
  if (maybeError?.code !== undefined) {
    errorInfo.code = maybeError.code;
  }
  return { operation, error: errorInfo };
}

export async function tryLogFailure(
  client: any,
  options: AuditExtensionOptions,
  input: {
    model: string;
    operation: string;
    args: any;
    before?: any;
    pkField: string;
    error: unknown;
  },
  tableRef?: unknown,
): Promise<void> {
  if (
    options.consistency === 'atomic-required' ||
    !options.logFailures ||
    shouldSkipFailureAudit(input.error)
  ) {
    return;
  }

  const params = buildAuditInsertParams({
    action: failureAction(input.model, input.operation),
    targetType: input.model,
    targetId: failureTargetId(input),
    changes: {},
    metadata: failureMetadata(input.operation, input.error),
    operation: input.operation,
    result: 'failure',
  }, options);
  await tryAuditLog(client, params, options, {
    model: input.model,
    operation: input.operation,
  }, tableRef);
}

export async function tryAuditLog(
  client: any,
  params: AuditInsertParams | null,
  options: AuditExtensionOptions,
  ctx: Omit<AuditErrorContext, 'phase'>,
  tableRef?: unknown,
): Promise<void> {
  if (!params) {
    if (options.consistency === 'atomic-required') {
      throw new Error(
        '[@nestarc/audit-log] atomic audit entry could not be constructed',
      );
    }
    return;
  }

  try {
    await insertAuditLog(client, params, tableRef);
  } catch (error) {
    reportAuditError(options, error, {
      ...ctx,
      phase: 'insert',
      action: params.action,
      targetId: params.targetId,
      tenantId: params.tenantId,
    });
    if (options.consistency === 'atomic-required') {
      throw error;
    }
  }
}
