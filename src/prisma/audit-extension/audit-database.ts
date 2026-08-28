import type { AuditErrorContext } from '../../interfaces/audit-shared-options.interface';
import type { AuditExtensionOptions } from './audit-types';
import type { PrismaModuleLike } from '../prisma-namespace';
import { reportAuditError } from './audit-errors';

export function modelDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

export function getPkField(
  model: string,
  options: Pick<AuditExtensionOptions, 'primaryKey'>,
): string {
  return options.primaryKey?.[model] ?? 'id';
}

export function updatedAtFieldsFor(
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

export async function readBeforeMutation(
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

export async function lockAndRefreshBatch(
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

export function tryInjectPk(
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

export function stripInjectedPk(result: any, pkField: string): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return;
  }
  delete result[pkField];
}
