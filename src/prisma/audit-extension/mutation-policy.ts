import { AuditContext } from '../../services/audit-context';
import { shouldTrackModel } from '../diff';
import type { Changes } from '../diff';
import type { AuditExtensionOptions } from './audit-types';
import type { PrismaModuleLike } from '../prisma-namespace';
import { reportAuditError } from './audit-errors';

const ATOMIC_CONTEXT_ERROR =
  '[@nestarc/audit-log] atomic-required tracked write must run inside withAuditTransaction()';
const NESTED_WRITE_ATOMIC_ERROR =
  '[@nestarc/audit-log] atomic-required does not support nested writes to tracked related models; run explicit related-model mutations inside withAuditTransaction()';
const DEFAULT_MAX_BATCH_RECORDS = 1000;

export function shouldSkip(
  model: string,
  trackedModels?: string[],
  ignoredModels?: string[],
): boolean {
  return (
    AuditContext.isNoAudit() ||
    !shouldTrackModel(model, trackedModels, ignoredModels)
  );
}

export function resolveAuditClient(
  client: any,
  options: AuditExtensionOptions,
  transactionClient: any,
): any {
  if (options.consistency === 'atomic-required') {
    if (!transactionClient) {
      throw new Error(ATOMIC_CONTEXT_ERROR);
    }
    return transactionClient;
  }

  return client;
}

export function batchSummaryMetadata(
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

export function deleteManyRecordMetadata(
  count: number,
): Record<string, unknown> {
  return {
    auditKind: 'record',
    operation: 'deleteMany',
    batchSize: count,
  };
}

export function assertAtomicBulkSummaryUnsupported(
  options: AuditExtensionOptions,
  operation: 'createMany' | 'updateMany',
): void {
  if (options.consistency !== 'atomic-required') return;
  const singular = operation === 'createMany' ? 'create()' : 'update()';
  throw new Error(
    `[@nestarc/audit-log] atomic-required does not support ${operation} because it only provides count-level audit evidence; use sequential ${singular} calls inside withAuditTransaction()`,
  );
}

export function batchLimit(options: AuditExtensionOptions): number {
  return options.maxBatchRecords ?? DEFAULT_MAX_BATCH_RECORDS;
}

export function batchOverflowError(
  model: string,
  count: number,
  limit: number,
): Error {
  return new Error(
    `[@nestarc/audit-log] ${model}.deleteMany matched more than maxBatchRecords (${limit}; observed at least ${count}); narrow the filter or increase maxBatchRecords`,
  );
}

export function auditFlags(flags: {
  preReadFailed?: boolean;
  postReadFailed?: boolean;
}): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (flags.preReadFailed) metadata.preReadFailed = true;
  if (flags.postReadFailed) metadata.postReadFailed = true;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function isEmptyChanges(changes: Changes): boolean {
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

export function enforceNestedWriteContract(
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

export function validatePositiveInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new TypeError(`[@nestarc/audit-log] ${name} must be a positive integer`);
  }
}

export function warnForTrackingConfiguration(
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
