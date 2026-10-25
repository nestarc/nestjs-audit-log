import type { AuditLogModuleOptions } from './interfaces/audit-log-options.interface';
import type { AuditSharedOptions } from './interfaces/audit-shared-options.interface';
import type { AuditExtensionOptions } from './prisma/audit-extension/audit-types';
import { validateAuditExtensionOptions } from './prisma/audit-extension/validate-options';
import type { AuditTableSQLOptions, EnsurePartitionsOptions } from './sql';
import { getAuditTableStatements } from './sql';
import { getSqlServerTableName, validateAuditTableName } from './sql/table-name';
import { resolveAuditProvider } from './sql/provider';

/** Settings applied to both manual and automatic audit paths. */
export type AuditConfigSharedOptions = AuditSharedOptions & Pick<
  AuditLogModuleOptions,
  'prismaModule' | 'sensitiveFields' | 'sensitiveFieldsByModel'
>;

type Forbidden<K extends PropertyKey> = { [P in K]?: never };
type ModuleSettings = Omit<AuditLogModuleOptions, keyof AuditConfigSharedOptions | 'prisma'>;
type ExtensionSettings = Omit<AuditExtensionOptions, keyof AuditConfigSharedOptions>;
type SchemaSettings = Omit<AuditTableSQLOptions, 'tableName' | 'provider'>;

export type AuditConfigModuleOptions = ModuleSettings &
  Forbidden<keyof AuditConfigSharedOptions | 'prisma'>;
export type AuditConfigExtensionOptions = ExtensionSettings &
  Forbidden<keyof AuditConfigSharedOptions>;
export type AuditConfigSchemaOptions = SchemaSettings &
  Forbidden<keyof AuditConfigSharedOptions>;

export interface AuditConfigInput {
  shared?: AuditConfigSharedOptions;
  module: AuditConfigModuleOptions;
  extension?: AuditConfigExtensionOptions;
  schema?: AuditConfigSchemaOptions;
}

export interface AuditConfig<T extends AuditExtensionOptions | undefined = AuditExtensionOptions | undefined> {
  moduleOptions: Omit<AuditLogModuleOptions, 'prisma'>;
  extensionOptions: T;
  schemaOptions: AuditTableSQLOptions;
  partitionOptions: Pick<EnsurePartitionsOptions, 'tableName' | 'provider'>;
}

// Exhaustive key maps keep the runtime placement checks aligned with public types.
const sharedKeys: Record<keyof AuditConfigSharedOptions, true> = {
  provider: true, tableName: true, prismaModule: true, actorRequired: true, tenantRequired: true,
  tenantResolver: true, sensitiveFields: true, sensitiveFieldsByModel: true,
  logger: true, onAuditError: true,
};
const moduleKeys: Record<keyof ModuleSettings, true> = {
  actorExtractor: true, actorExtractionStage: true, excludeRoutes: true,
  registerGlobalInterceptor: true, correlationIdHeader: true, correlationIdGetter: true,
};
const extensionKeys: Record<keyof ExtensionSettings, true> = {
  consistency: true, trackedModels: true, ignoredModels: true, primaryKey: true,
  databaseMapping: true, maxBatchRecords: true, batchOverflow: true,
  logFailures: true, ignoreTimestampOnlyUpdates: true,
};
const schemaKeys: Record<keyof SchemaSettings, true> = {
  partitioned: true, enforcement: true, ginIndex: true,
};

function checkSection(value: unknown, path: string, keys: object): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[@nestarc/audit-log] ${path} must be an options object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.prototype.hasOwnProperty.call(keys, key)) {
      const hint = Object.prototype.hasOwnProperty.call(sharedKeys, key)
        ? `; configure shared.${String(key)} instead`
        : '';
      throw new Error(`[@nestarc/audit-log] Invalid option location ${path}.${String(key)}${hint}`);
    }
  }
}

/** Clone mutable configuration data, preserving opaque runtime dependencies. */
function cloneSettings<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneSettings(item)) as T;
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneSettings(item)])) as T;
    }
  }
  return value;
}

function cloneShared(shared: AuditConfigSharedOptions): AuditConfigSharedOptions {
  const { logger, prismaModule, ...settings } = shared;
  return {
    ...cloneSettings(settings),
    ...('logger' in shared ? { logger } : {}),
    // The wrapper is configuration; the generated namespace is opaque runtime state.
    ...('prismaModule' in shared ? { prismaModule: prismaModule && { Prisma: prismaModule.Prisma } } : {}),
  };
}

export function defineAuditConfig(input: AuditConfigInput & { extension: AuditConfigExtensionOptions }): AuditConfig<AuditExtensionOptions>;
export function defineAuditConfig(input: AuditConfigInput & { extension?: undefined }): AuditConfig<undefined>;
export function defineAuditConfig(input: AuditConfigInput): AuditConfig;
/**
 * Build independent module, extension, DDL and partition options synchronously.
 * Does not create clients, invoke callbacks, register Nest modules or perform I/O.
 * Existing defaults are left to the consuming APIs.
 */
export function defineAuditConfig(input: AuditConfigInput): AuditConfig {
  checkSection(input, 'config', { shared: true, module: true, extension: true, schema: true });
  checkSection(input.module, 'module', moduleKeys);
  if (input.shared !== undefined) checkSection(input.shared, 'shared', sharedKeys);
  if (input.extension !== undefined) checkSection(input.extension, 'extension', extensionKeys);
  if (input.schema !== undefined) checkSection(input.schema, 'schema', schemaKeys);
  const shared = input.shared ?? {};
  const provider = resolveAuditProvider(shared.provider);
  if (provider === 'sqlserver') getSqlServerTableName(shared.tableName);
  else validateAuditTableName(shared.tableName);
  if (input.extension !== undefined) {
    validateAuditExtensionOptions({ ...shared, ...input.extension });
  }
  const tableOptions = {
    ...('tableName' in shared ? { tableName: shared.tableName } : {}),
    ...('provider' in shared ? { provider: shared.provider } : {}),
  };
  const schemaOptions = { ...tableOptions, ...cloneSettings(input.schema ?? {}) };
  // Fail on unsupported SQL Server storage settings at configuration time, without I/O.
  if (provider === 'sqlserver') getAuditTableStatements(schemaOptions);
  return {
    moduleOptions: { ...cloneShared(shared), ...cloneSettings(input.module) },
    extensionOptions: input.extension === undefined
      ? undefined
      : { ...cloneShared(shared), ...cloneSettings(input.extension) },
    schemaOptions,
    partitionOptions: { ...tableOptions },
  };
}
