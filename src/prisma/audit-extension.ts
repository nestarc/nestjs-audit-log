import { AuditContext } from '../services/audit-context';
import {
  shouldTrackModel,
  computeCreateChanges,
  computeUpdateChanges,
  computeDeleteChanges,
  getSensitiveFieldsFor,
  redactObject,
  Changes,
} from './diff';
import { resolveTenantId } from '../utils/tenant';
import {
  AuditErrorContext,
  AuditSharedOptions,
} from '../interfaces/audit-shared-options.interface';
import {
  PrismaModuleLike,
  resolvePrismaNamespace,
} from './prisma-namespace';
import { validateAuditTableName } from '../sql/table-name';

export interface AuditExtensionOptions extends AuditSharedOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  sensitiveFieldsByModel?: Record<string, string[]>;
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
  logFailures?: boolean;
  ignoreTimestampOnlyUpdates?: boolean;
  prismaModule?: PrismaModuleLike;
}

export function modelDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

export function getPkField(
  model: string,
  options: AuditExtensionOptions,
): string {
  return options.primaryKey?.[model] ?? 'id';
}

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

export function buildAuditInsertParams(
  input: AuditInsertInput,
): AuditInsertParams;
export function buildAuditInsertParams(
  input: AuditInsertInput,
  options: AuditExtensionOptions,
): AuditInsertParams | null;
export function buildAuditInsertParams(
  input: AuditInsertInput,
  options: AuditExtensionOptions = {},
): AuditInsertParams | null {
  const actor = AuditContext.getActor();
  const actionOverride = AuditContext.getActionOverride();
  const action = actionOverride ?? input.action;
  let tenantId: string | null = null;

  try {
    tenantId = resolveTenantId({
      tenantResolver: options.tenantResolver,
    });
  } catch (error) {
    reportAuditError(options, error, {
      phase: 'tenant-resolution',
      model: input.targetType,
      operation: input.operation,
      action,
      targetId: input.targetId,
      tenantId: null,
    });
    if (options.tenantRequired) {
      return null;
    }
  }

  if (tenantId === null && options.tenantRequired) {
    reportAuditError(
      options,
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

  const metadata = input.metadata
    ? redactObject(
        input.metadata,
        getSensitiveFieldsFor(input.targetType, options),
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

function shouldSkip(
  model: string,
  trackedModels?: string[],
  ignoredModels?: string[],
): boolean {
  return (
    AuditContext.isNoAudit() ||
    !shouldTrackModel(model, trackedModels, ignoredModels)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportAuditError(
  options: AuditExtensionOptions,
  error: unknown,
  ctx: AuditErrorContext,
): void {
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
    logger.warn(
      `[@nestarc/audit-log] audit ${ctx.phase} failed for ${
        ctx.model ?? 'unknown'
      }.${ctx.operation ?? 'unknown'}: ${errorMessage(error)}`,
    );
  } catch {
    // Reporting must never affect the caller's mutation.
  }
}

function auditFlags(flags: {
  preReadFailed?: boolean;
  postReadFailed?: boolean;
}): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (flags.preReadFailed) metadata.preReadFailed = true;
  if (flags.postReadFailed) metadata.postReadFailed = true;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function updatedAtFieldsFor(
  model: string,
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): readonly string[] {
  if (!options.ignoreTimestampOnlyUpdates) {
    return [];
  }

  const fields = Prisma.dmmf?.datamodel?.models
    ?.find((candidate) => candidate.name === model)
    ?.fields?.filter((field) => field.isUpdatedAt)
    .map((field) => field.name);

  return fields && fields.length > 0 ? fields : ['updatedAt'];
}

function isEmptyChanges(changes: Changes): boolean {
  return Object.keys(changes).length === 0;
}

const nestedWriteWarnings = new Set<string>();
const nestedWriteOperatorKeys = new Set([
  'create',
  'createMany',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'set',
]);

export function _resetNestedWriteWarnings(): void {
  nestedWriteWarnings.clear();
}

function relationFieldNamesFor(
  model: string,
  Prisma: PrismaModuleLike['Prisma'],
): Set<string> | undefined {
  const fields = Prisma.dmmf?.datamodel?.models
    ?.find((candidate) => candidate.name === model)
    ?.fields;
  if (!fields) return undefined;
  return new Set(
    fields
      .filter((field) => field.kind === 'object')
      .map((field) => field.name),
  );
}

function hasNestedWriteOperator(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value as Record<string, unknown>).some((key) =>
    nestedWriteOperatorKeys.has(key),
  );
}

function warnForNestedWritesInData(
  model: string,
  operation: string,
  data: unknown,
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return;
  }

  try {
    const relationFields = relationFieldNamesFor(model, Prisma);
    for (const [field, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      if (relationFields && !relationFields.has(field)) {
        continue;
      }
      if (!hasNestedWriteOperator(value)) {
        continue;
      }

      const key = `${model}.${field}`;
      if (nestedWriteWarnings.has(key)) {
        continue;
      }
      nestedWriteWarnings.add(key);
      (options.logger ?? console).warn(
        `[@nestarc/audit-log] nested write on ${key} is not audited — ` +
          `only the top-level ${model} mutation is recorded. ` +
          '(full nested-write auditing is planned for 0.3.0)',
      );
    }
  } catch (error) {
    reportAuditError(options, error, {
      phase: 'context',
      model,
      operation,
    });
  }
}

function warnForNestedWrites(
  model: string,
  operation: string,
  args: any,
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): void {
  if (operation === 'upsert') {
    warnForNestedWritesInData(model, operation, args?.create, options, Prisma);
    warnForNestedWritesInData(model, operation, args?.update, options, Prisma);
    return;
  }

  warnForNestedWritesInData(model, operation, args?.data, options, Prisma);
}

function tryInjectPk(
  args: any,
  pkField: string,
  options: AuditExtensionOptions,
  ctx: Omit<AuditErrorContext, 'phase'>,
): boolean {
  try {
    if (
      args?.select &&
      typeof args.select === 'object' &&
      args.select[pkField] !== true
    ) {
      args.select = { ...args.select, [pkField]: true };
      return true;
    }

    if (
      args?.omit &&
      typeof args.omit === 'object' &&
      args.omit[pkField] === true
    ) {
      args.omit = { ...args.omit, [pkField]: false };
      return true;
    }
  } catch (error) {
    reportAuditError(options, error, { ...ctx, phase: 'context' });
  }

  return false;
}

function stripInjectedPk(result: any, pkField: string): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return;
  }
  delete result[pkField];
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

function failureMetadata(operation: string, error: unknown): Record<string, unknown> {
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

async function tryLogFailure(
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
  if (!options.logFailures || shouldSkipFailureAudit(input.error)) {
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

async function tryAuditLog(
  client: any,
  params: AuditInsertParams | null,
  options: AuditExtensionOptions,
  ctx: Omit<AuditErrorContext, 'phase'>,
  tableRef?: unknown,
): Promise<void> {
  if (!params) {
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
  }
}

function warnForTrackingConfiguration(
  options: AuditExtensionOptions,
  modelNames?: readonly string[],
): void {
  const logger = options.logger ?? console;

  if (options.trackedModels === undefined && options.ignoredModels === undefined) {
    logger.warn(
      '[@nestarc/audit-log] No trackedModels/ignoredModels configured — auditing ALL models. ' +
        'Set trackedModels (allowlist) or ignoredModels (denylist) to narrow scope. ' +
        '(v0.2.0 changed the default from tracking nothing.)',
    );
  }

  if (options.trackedModels !== undefined && options.ignoredModels !== undefined) {
    logger.warn(
      '[@nestarc/audit-log] Both trackedModels and ignoredModels are set — trackedModels ' +
        '(allowlist) wins; ignoredModels is ignored.',
    );
  }

  if (options.trackedModels !== undefined && options.trackedModels.length === 0) {
    logger.warn(
      '[@nestarc/audit-log] trackedModels is an empty array — NO models will be audited. ' +
        'Remove the option entirely to audit all models.',
    );
  }

  if (!modelNames) return;
  const known = new Set(modelNames);
  const warnUnknown = (optionName: string, names?: readonly string[]) => {
    const unknown = names?.filter((name) => !known.has(name)) ?? [];
    if (unknown.length === 0) return;
    logger.warn(
      `[@nestarc/audit-log] Unknown model name(s) in ${optionName}: ` +
        unknown.map((name) => `'${name}'`).join(', ') +
        ' — not found in the Prisma datamodel. These entries have no effect.',
    );
  };
  warnUnknown('trackedModels', options.trackedModels);
  warnUnknown('ignoredModels', options.ignoredModels);
}

export function createAuditExtension(options: AuditExtensionOptions): any {
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

  return Prisma.defineExtension((client: any) => {
    return client.$extends({
      query: {
        $allModels: {
          async create({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            warnForNestedWrites(model, 'create', args, options, Prisma);
            const pkInjected = tryInjectPk(args, pkField, options, {
              model,
              operation: 'create',
            });
            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(client, options, {
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
                  canonical = await (client as any)[delegateName].findFirst({
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
              await tryAuditLog(client, params, options, {
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

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const delegate = (client as any)[delegateName];
            warnForNestedWrites(model, 'update', args, options, Prisma);
            const pkInjected = tryInjectPk(args, pkField, options, {
              model,
              operation: 'update',
            });
            let before: any = null;
            let preReadFailed = false;
            try {
              before = await delegate.findFirst({
                where: args.where,
              });
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
              await tryLogFailure(client, options, {
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
              await tryAuditLog(client, params, options, {
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

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            let before: any = null;
            let preReadFailed = false;
            try {
              before = await (client as any)[
                delegateName
              ].findFirst({ where: args.where });
            } catch (error) {
              preReadFailed = true;
              reportAuditError(options, error, {
                phase: 'pre-read',
                model,
                operation: 'delete',
              });
            }

            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(client, options, {
                model,
                operation: 'delete',
                args,
                before,
                pkField,
                error,
              }, auditTableRef);
              throw error;
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
              await tryAuditLog(client, params, options, {
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

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const delegate = (client as any)[delegateName];
            warnForNestedWrites(model, 'upsert', args, options, Prisma);
            const pkInjected = tryInjectPk(args, pkField, options, {
              model,
              operation: 'upsert',
            });
            let before: any = null;
            let preReadFailed = false;
            try {
              before = await delegate.findFirst({
                where: args.where,
              });
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
              await tryLogFailure(client, options, {
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
              await tryAuditLog(client, params, options, {
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

            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(client, options, {
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
                metadata: { count: (result as any).count },
                operation: 'createMany',
              }, options);
              await tryAuditLog(client, params, options, {
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

            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(client, options, {
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
                metadata: { count: (result as any).count },
                operation: 'updateMany',
              }, options);
              await tryAuditLog(client, params, options, {
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

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            let records: any[] = [];
            let preReadFailed = false;
            try {
              records = await (client as any)[
                delegateName
              ].findMany({ where: args.where });
            } catch (error) {
              preReadFailed = true;
              reportAuditError(options, error, {
                phase: 'pre-read',
                model,
                operation: 'deleteMany',
              });
            }

            let result: any;
            try {
              result = await query(args);
            } catch (error) {
              await tryLogFailure(client, options, {
                model,
                operation: 'deleteMany',
                args,
                pkField,
                error,
              }, auditTableRef);
              throw error;
            }

            if (preReadFailed) {
              try {
                const params = buildAuditInsertParams({
                  action: `${model}.deletedMany`,
                  targetType: model,
                  targetId: null,
                  changes: {},
                  metadata: {
                    count: (result as any).count,
                    preReadFailed: true,
                  },
                  operation: 'deleteMany',
                }, options);
                await tryAuditLog(client, params, options, {
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
                    operation: 'deleteMany',
                  }, options);
                  await tryAuditLog(client, params, options, {
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
