import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditContext, mergeContextMetadata } from '../services/audit-context';
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

const NO_CONTEXT_WARNING_MESSAGE =
  '[@nestarc/audit-log] audited write executed without an audit context store — actorId will be null. Wrap background work in AuditContext.runAs(actor, fn). (warned once per process)';

let noContextWarningReported = false;
let txAuditUnavailableWarned = false;

export type AuditConsistency = 'atomic-required' | 'best-effort';
export type AuditBatchOverflow = 'reject' | 'summary';

export interface AuditCapabilities {
  readonly consistency: AuditConsistency;
  readonly atomicLifecycle: boolean;
}

export interface AuditCapabilityMethods {
  getAuditCapabilities(): AuditCapabilities;
}

export interface AuditTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?:
    | 'ReadUncommitted'
    | 'ReadCommitted'
    | 'RepeatableRead'
    | 'Serializable';
}

export interface AuditTransactionMethods<TTransactionClient> {
  withAuditTransaction<TResult>(
    callback: (tx: TTransactionClient) => Promise<TResult>,
    options?: AuditTransactionOptions,
  ): Promise<TResult>;
  withAuditLifecycle<TResult>(
    input: AuditLifecycleInput,
    callback: (tx: TTransactionClient) => Promise<TResult>,
  ): Promise<TResult>;
}

export interface AuditLifecycleInput {
  /** Deterministic lifecycle action, for example `User.softDeleted`. */
  action: string;
  /** Metadata merged into the ambient audit context for this mutation. */
  metadata?: Record<string, unknown>;
  /** Internal extension-composition signal for a rewritten outer operation. */
  suppressOuterOperation?: { model: string; operation: 'delete' | 'deleteMany' };
}

export interface AuditDatabaseMapping {
  /** PostgreSQL table name used by the Prisma model. */
  tableName: string;
  /** PostgreSQL schema name. Defaults to the connection's current schema. */
  schema?: string;
  /** Database column for the configured logical primary key field. */
  primaryKeyColumn?: string;
}

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

export function _resetNoContextWarning(): void {
  noContextWarningReported = false;
}

export function _resetTxAuditWarning(): void {
  txAuditUnavailableWarned = false;
}

export interface AuditExtensionOptions extends AuditSharedOptions {
  /**
   * `atomic-required` rejects tracked writes outside withAuditTransaction().
   * `best-effort` preserves the legacy non-atomic behavior.
   */
  consistency: AuditConsistency;
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  sensitiveFieldsByModel?: Record<string, string[]>;
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
  /**
   * Database identifiers used for atomic row locks. Required for models that
   * use Prisma mapping attributes when the generated Prisma namespace does
   * not expose public DMMF mapping metadata.
   */
  databaseMapping?: Record<string, AuditDatabaseMapping>;
  /**
   * Maximum records that deleteMany may audit individually. Defaults to 1000.
   */
  maxBatchRecords?: number;
  /**
   * Behavior when deleteMany matches more than maxBatchRecords. Defaults to
   * reject. Summary overflow is available only in best-effort mode.
   */
  batchOverflow?: AuditBatchOverflow;
  logFailures?: boolean;
  ignoreTimestampOnlyUpdates?: boolean;
  prismaModule?: PrismaModuleLike;
  /**
   * EXPERIMENTAL — no semver guarantee. Reserved for transaction-aware audit
   * routing when Prisma exposes a compatible internal transaction capability.
   * Default behavior remains best-effort outside the caller transaction.
   * @deprecated Use consistency: 'atomic-required' with withAuditTransaction().
   */
  experimentalTxAudit?: boolean;
}

const ATOMIC_CONTEXT_ERROR =
  '[@nestarc/audit-log] atomic-required tracked write must run inside withAuditTransaction()';
const ATOMIC_ARRAY_TRANSACTION_ERROR =
  '[@nestarc/audit-log] atomic-required does not support array $transaction([...]); use sequential mutations inside withAuditTransaction()';
const NESTED_TRANSACTION_ERROR =
  '[@nestarc/audit-log] nested withAuditTransaction() calls are not supported';
const NESTED_WRITE_ATOMIC_ERROR =
  '[@nestarc/audit-log] atomic-required does not support nested writes to tracked related models; run explicit related-model mutations inside withAuditTransaction()';
const AUDIT_LIFECYCLE_CONTEXT_ERROR =
  '[@nestarc/audit-log] withAuditLifecycle() must run inside withAuditTransaction()';
const AUDIT_LIFECYCLE_CONSISTENCY_ERROR =
  '[@nestarc/audit-log] withAuditLifecycle() requires consistency: "atomic-required"';
const DEFAULT_MAX_BATCH_RECORDS = 1000;

export function modelDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

export function getPkField(
  model: string,
  options: Pick<AuditExtensionOptions, 'primaryKey'>,
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

type AuditInsertBuildOptions = Omit<AuditExtensionOptions, 'consistency'> & {
  consistency?: AuditConsistency;
};

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
    }
    if (options.consistency === 'atomic-required') {
      throw error;
    }
    return;
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
  if (options.consistency === 'atomic-required') {
    throw error;
  }
}

function warnTxAuditUnavailable(
  options: AuditExtensionOptions,
  error?: unknown,
): void {
  if (txAuditUnavailableWarned) {
    return;
  }
  txAuditUnavailableWarned = true;

  const suffix = error ? `: ${errorMessage(error)}` : '';
  try {
    (options.logger ?? console).warn(
      `[@nestarc/audit-log] tx-aware audit unavailable on this Prisma version, falling back to best-effort${suffix}`,
    );
  } catch {
    // Reporting must never affect the caller's mutation.
  }
}

function resolveAuditClient(
  client: any,
  options: AuditExtensionOptions,
  transactionClient: any,
  internalParams?: { transaction?: { kind?: string } },
): any {
  if (options.consistency === 'atomic-required') {
    if (!transactionClient) {
      if (internalParams?.transaction?.kind === 'batch') {
        throw new Error(ATOMIC_ARRAY_TRANSACTION_ERROR);
      }
      throw new Error(ATOMIC_CONTEXT_ERROR);
    }
    return transactionClient;
  }

  if (!options.experimentalTxAudit) {
    return client;
  }

  const transaction = internalParams?.transaction;
  if (!transaction || transaction.kind !== 'itx') {
    return client;
  }

  if (typeof client?._createItxClient !== 'function') {
    warnTxAuditUnavailable(options);
    return client;
  }

  try {
    return client._createItxClient(transaction);
  } catch (error) {
    warnTxAuditUnavailable(options, error);
    return client;
  }
}

function batchSummaryMetadata(
  operation: string,
  count: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    auditKind: 'summary',
    operation,
    recordCount: count,
    recordsAudited: false,
    ...extra,
  };
}

function deleteManyRecordMetadata(count: number): Record<string, unknown> {
  return {
    auditKind: 'record',
    operation: 'deleteMany',
    batchSize: count,
  };
}

function assertAtomicBulkSummaryUnsupported(
  options: AuditExtensionOptions,
  operation: 'createMany' | 'updateMany',
): void {
  if (options.consistency !== 'atomic-required') return;
  const singular = operation === 'createMany' ? 'create()' : 'update()';
  throw new Error(
    `[@nestarc/audit-log] atomic-required does not support ${operation} because it only provides count-level audit evidence; use sequential ${singular} calls inside withAuditTransaction()`,
  );
}

function batchLimit(options: AuditExtensionOptions): number {
  return options.maxBatchRecords ?? DEFAULT_MAX_BATCH_RECORDS;
}

function batchOverflowError(
  model: string,
  count: number,
  limit: number,
): Error {
  return new Error(
    `[@nestarc/audit-log] ${model}.deleteMany matched more than maxBatchRecords (${limit}; observed at least ${count}); narrow the filter or increase maxBatchRecords`,
  );
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

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function storageIdentifiersFor(
  model: string,
  pkField: string,
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): { table: string; column: string } {
  const explicitMapping = options.databaseMapping?.[model];
  const modelMetadata = Prisma.dmmf?.datamodel?.models?.find(
    (candidate) => candidate.name === model,
  );
  const fieldMetadata = modelMetadata?.fields?.find(
    (field) => field.name === pkField,
  );
  const tableName = explicitMapping?.tableName ?? modelMetadata?.dbName ?? model;
  const schemaName = explicitMapping?.schema ?? modelMetadata?.schema;
  const schemaPrefix = schemaName
    ? `${quotePostgresIdentifier(schemaName)}.`
    : '';

  return {
    table: `${schemaPrefix}${quotePostgresIdentifier(tableName)}`,
    column: quotePostgresIdentifier(
      explicitMapping?.primaryKeyColumn ?? fieldMetadata?.dbName ?? pkField,
    ),
  };
}

async function readBeforeMutation(
  client: any,
  delegate: any,
  model: string,
  pkField: string,
  where: unknown,
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): Promise<any> {
  const candidate = await delegate.findFirst({ where });
  if (options.consistency !== 'atomic-required' || !candidate) {
    return candidate;
  }

  const pkValue = candidate[pkField];
  if (pkValue == null) {
    throw new Error(
      `[@nestarc/audit-log] cannot lock ${model} before mutation because primary key field "${pkField}" is unavailable`,
    );
  }
  if (typeof client.$queryRawUnsafe !== 'function') {
    throw new Error(
      '[@nestarc/audit-log] atomic row locking requires Prisma $queryRawUnsafe support',
    );
  }

  const identifiers = storageIdentifiersFor(model, pkField, options, Prisma);
  await client.$queryRawUnsafe(
    `SELECT ${identifiers.column} FROM ${identifiers.table} WHERE ${identifiers.column} = $1 FOR UPDATE`,
    pkValue,
  );

  return delegate.findFirst({ where: { [pkField]: pkValue } });
}

async function lockAndRefreshBatch(
  client: any,
  delegate: any,
  model: string,
  pkField: string,
  records: any[],
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): Promise<any[]> {
  if (options.consistency !== 'atomic-required' || records.length === 0) {
    return records;
  }
  if (typeof client.$queryRawUnsafe !== 'function') {
    throw new Error(
      '[@nestarc/audit-log] atomic row locking requires Prisma $queryRawUnsafe support',
    );
  }

  const identifiers = storageIdentifiersFor(model, pkField, options, Prisma);
  const refreshed: any[] = [];
  for (const record of records) {
    const pkValue = record?.[pkField];
    if (pkValue == null) {
      throw new Error(
        `[@nestarc/audit-log] cannot lock ${model}.deleteMany record because primary key field "${pkField}" is unavailable`,
      );
    }
    await client.$queryRawUnsafe(
      `SELECT ${identifiers.column} FROM ${identifiers.table} WHERE ${identifiers.column} = $1 FOR UPDATE`,
      pkValue,
    );
    const current = await delegate.findFirst({ where: { [pkField]: pkValue } });
    if (current) refreshed.push(current);
  }
  return refreshed;
}

function isEmptyChanges(changes: Changes): boolean {
  return Object.keys(changes).length === 0;
}

const nestedWriteWarnings = new Set<string>();
const nestedWriteOperatorKeys = new Set([
  'create',
  'createMany',
  'connect',
  'connectOrCreate',
  'disconnect',
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

function relationFieldsFor(
  model: string,
  Prisma: PrismaModuleLike['Prisma'],
): Map<string, string> | undefined {
  const fields = Prisma.dmmf?.datamodel?.models
    ?.find((candidate) => candidate.name === model)
    ?.fields;
  if (!fields) return undefined;
  return new Map(
    fields
      .filter((field) => field.kind === 'object')
      .flatMap((field) => field.type ? [[field.name, field.type] as const] : []),
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

function nestedWriteRelationsInData(
  model: string,
  data: unknown,
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }

  const relationFields = relationFieldsFor(model, Prisma);
  const relations: string[] = [];
  for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
    const relatedModel = relationFields?.get(field);
    if (relationFields && !relatedModel) {
      continue;
    }
    if (!hasNestedWriteOperator(value)) {
      continue;
    }
    if (
      relatedModel &&
      !shouldTrackModel(
        relatedModel,
        options.trackedModels,
        options.ignoredModels,
      )
    ) {
      continue;
    }
    relations.push(`${model}.${field}`);
  }
  return relations;
}

function enforceNestedWriteContract(
  model: string,
  operation: string,
  args: any,
  options: AuditExtensionOptions,
  Prisma: PrismaModuleLike['Prisma'],
): void {
  try {
    const relations = operation === 'upsert'
      ? [
          ...nestedWriteRelationsInData(model, args?.create, options, Prisma),
          ...nestedWriteRelationsInData(model, args?.update, options, Prisma),
        ]
      : nestedWriteRelationsInData(model, args?.data, options, Prisma);
    const uniqueRelations = Array.from(new Set(relations));
    if (uniqueRelations.length === 0) return;

    if (options.consistency === 'atomic-required') {
      throw new Error(
        `${NESTED_WRITE_ATOMIC_ERROR}: ${uniqueRelations.join(', ')}`,
      );
    }

    for (const key of uniqueRelations) {
      if (nestedWriteWarnings.has(key)) continue;
      nestedWriteWarnings.add(key);
      (options.logger ?? console).warn(
        `[@nestarc/audit-log] nested write on ${key} is not audited — ` +
          `only the top-level ${model} mutation is recorded. ` +
          'Use explicit related-model mutations inside withAuditTransaction() for authoritative records.',
      );
    }
  } catch (error) {
    if (options.consistency === 'atomic-required') throw error;
    reportAuditError(options, error, { phase: 'context', model, operation });
  }
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new TypeError(`[@nestarc/audit-log] ${name} must be a positive integer`);
  }
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

async function tryAuditLog(
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
  if (
    options.consistency !== 'atomic-required' &&
    options.consistency !== 'best-effort'
  ) {
    throw new Error(
      '[@nestarc/audit-log] consistency must be explicitly set to "atomic-required" or "best-effort"',
    );
  }
  if (options.consistency === 'atomic-required' && options.experimentalTxAudit) {
    throw new Error(
      '[@nestarc/audit-log] experimentalTxAudit cannot be combined with atomic-required; use withAuditTransaction()',
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
          async create({ model, args, query, __internalParams }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
              __internalParams,
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

          async update({ model, args, query, __internalParams }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
              __internalParams,
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

          async delete({ model, args, query, __internalParams }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
              __internalParams,
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

          async upsert({ model, args, query, __internalParams }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
              __internalParams,
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

          async createMany({ model, args, query, __internalParams }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            assertAtomicBulkSummaryUnsupported(options, 'createMany');

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
              __internalParams,
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

          async updateMany({ model, args, query, __internalParams }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            assertAtomicBulkSummaryUnsupported(options, 'updateMany');

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
              __internalParams,
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

          async deleteMany({ model, args, query, __internalParams }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const auditClient = resolveAuditClient(
              client,
              options,
              transactionContext.getStore(),
              __internalParams,
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
