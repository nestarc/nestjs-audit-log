import { getSqlServerTableName } from './table-name';

export interface SqlServerAuditStorageOptions {
  tableName?: string;
}

interface SqlServerSchemaClient {
  $executeRawUnsafe(query: string): Promise<unknown>;
}

interface SqlServerInspectionClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

const PREFIX_COLUMNS = ['tenant_id', 'target_type', 'target_id', 'actor_id'] as const;
const SESSION_OPTIONS = `SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;`;

function prefixColumn(column: string): string {
  return `__audit_${column}_prefix`;
}

function normalizedSqlDefinition(expression: string): string {
  return ["N' '", "N'['", "N']'", "N'('", "N')'", 'NCHAR(9)', 'NCHAR(13)', 'NCHAR(10)'].reduce(
    (sql, character) => `REPLACE(${sql}, ${character}, N'')`,
    `LOWER(${expression} COLLATE Latin1_General_100_BIN2)`,
  );
}

function readIndexes(table: string): Array<{ name: string; columns: Array<{ name: string; descending: boolean }> }> {
  const key = (name: string, descending = false) => ({ name, descending });
  const tail = [key('created_at', true), key('id', true)];
  return [
    { name: `idx_${table}_read_tenant`, columns: [key(prefixColumn('tenant_id')), ...tail] },
    { name: `idx_${table}_read_target`, columns: [key(prefixColumn('tenant_id')), key(prefixColumn('target_type')), key(prefixColumn('target_id')), ...tail] },
    { name: `idx_${table}_read_actor`, columns: [key(prefixColumn('tenant_id')), key(prefixColumn('actor_id')), ...tail] },
  ];
}

/**
 * Opt-in additive indexes for tenant-scoped SQL Server history queries.
 * Original NVARCHAR(MAX) values are unchanged. Queries must retain full-value
 * exact BIN2 equality and DATALENGTH predicates alongside matching BIN2 prefix
 * predicates. Prefixes alone do not establish identity equality.
 * Indexed computed columns require compatible SET options on every writer;
 * these installer batches configure only their own connections.
 */
export function getSqlServerAuditReadIndexStatements(options: SqlServerAuditStorageOptions = {}): string[] {
  const { table, quoted, qualified } = getSqlServerTableName(options.tableName);
  const missing = `[@nestarc/audit-log] SQL Server audit table ${qualified} is missing or not visible to this installer.`;
  const sourceColumns = PREFIX_COLUMNS.map(column => `N'${column}'`).join(', ');
  const preflight = `IF OBJECT_ID(N'${qualified}', N'U') IS NULL
  THROW 51003, '${missing}', 1;
IF (SELECT COUNT(*) FROM sys.columns WHERE [object_id] = OBJECT_ID(N'${qualified}')
  AND [name] IN (${sourceColumns}) AND TYPE_NAME([system_type_id]) = N'nvarchar'
  AND [max_length] = -1 AND [is_computed] = 0) <> ${PREFIX_COLUMNS.length}
  THROW 51003, '[@nestarc/audit-log] Read indexes require the original NVARCHAR(MAX) audit columns.', 1;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE [object_id] = OBJECT_ID(N'${qualified}')
  AND [name] = N'id' AND TYPE_NAME([system_type_id]) = N'uniqueidentifier' AND [is_nullable] = 0 AND [is_computed] = 0)
  OR NOT EXISTS (SELECT 1 FROM sys.columns WHERE [object_id] = OBJECT_ID(N'${qualified}')
    AND [name] = N'created_at' AND TYPE_NAME([system_type_id]) = N'datetime2' AND [scale] = 7 AND [is_nullable] = 0 AND [is_computed] = 0)
  THROW 51003, '[@nestarc/audit-log] Read indexes require the documented audit id and timestamp columns.', 1;`;
  const columns = PREFIX_COLUMNS.map(column => {
    const name = prefixColumn(column);
    const expected = `convertnvarchar128,${column}collatelatin1_general_100_bin2`;
    return `IF EXISTS (SELECT 1 FROM sys.columns WHERE [object_id] = OBJECT_ID(N'${qualified}') AND [name] = N'${name}')
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sys.computed_columns WHERE [object_id] = OBJECT_ID(N'${qualified}')
    AND [name] = N'${name}' AND TYPE_NAME([system_type_id]) = N'nvarchar' AND [max_length] = 256
    AND ${normalizedSqlDefinition('[definition]')} = N'${expected}')
    THROW 51003, '[@nestarc/audit-log] Incompatible computed read column ${name}.', 1;
END
ELSE
  ALTER TABLE ${quoted} ADD [${name}] AS (CONVERT(NVARCHAR(128), [${column}] COLLATE Latin1_General_100_BIN2));`;
  });
  const indexes = readIndexes(table).map(index => {
    // Validate a same-named index instead of silently trusting or replacing it.
    const keyChecks = index.columns.map((column, position) => `NOT EXISTS (
      SELECT 1 FROM sys.index_columns AS k JOIN sys.columns AS c
        ON c.[object_id] = k.[object_id] AND c.[column_id] = k.[column_id]
      WHERE k.[object_id] = i.[object_id] AND k.[index_id] = i.[index_id]
        AND k.[key_ordinal] = ${position + 1} AND c.[name] = N'${column.name}'
        AND k.[is_descending_key] = ${column.descending ? 1 : 0})`).join('\n    OR ');
    return `IF EXISTS (SELECT 1 FROM sys.indexes AS i WHERE i.[object_id] = OBJECT_ID(N'${qualified}')
  AND i.[name] = N'${index.name}' AND (i.[type] <> 2 OR i.[is_unique] <> 0 OR i.[has_filter] <> 0
    OR i.[is_disabled] <> 0 OR i.[is_hypothetical] <> 0
    OR (SELECT COUNT(*) FROM sys.index_columns AS k WHERE k.[object_id] = i.[object_id]
      AND k.[index_id] = i.[index_id] AND k.[key_ordinal] > 0) <> ${index.columns.length}
    OR ${keyChecks}))
  THROW 51003, '[@nestarc/audit-log] Incompatible or disabled read index ${index.name}.', 1;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE [object_id] = OBJECT_ID(N'${qualified}') AND [name] = N'${index.name}')
  CREATE NONCLUSTERED INDEX [${index.name}] ON ${quoted} (${index.columns.map(column => `[${column.name}]${column.descending ? ' DESC' : ''}`).join(', ')});`;
  });
  return [preflight, ...columns, ...indexes].map(statement => `${SESSION_OPTIONS}\n${statement}`);
}

/** Run with an installer identity. Batches are sequential, additive, and not atomic. */
export async function applySqlServerAuditReadIndexes(
  prisma: SqlServerSchemaClient,
  options: SqlServerAuditStorageOptions = {},
): Promise<void> {
  for (const statement of getSqlServerAuditReadIndexStatements(options)) {
    await prisma.$executeRawUnsafe(statement);
  }
}

export interface SqlServerAuditColumnInspection {
  name: string;
  type: string;
  maxLength: number;
  nullable: boolean;
  computed: boolean;
  scale: number;
  definition?: string;
  defaultDefinition?: string;
}

export interface SqlServerAuditIndexInspection {
  name: string;
  type: number;
  disabled: boolean;
  primaryKey: boolean;
  keys: Array<{ name: string; descending: boolean }>;
}

export interface SqlServerAuditTriggerInspection {
  name: string;
  disabled: boolean;
  insteadOf: boolean;
  events: string[];
  definitionAvailable: boolean;
}

export interface SqlServerAuditConstraintInspection {
  name: string;
  disabled: boolean;
  untrusted: boolean;
  definition?: string;
}

export interface SqlServerAuditStorageInspection {
  tableName: string;
  status: 'inspected' | 'missing' | 'unavailable';
  metadataComplete: boolean;
  /** Catalog inspection does not prove a trigger body enforces append-only behavior. */
  enforcementVerified: false;
  /** Effective options on this inspection connection, not every pooled writer. */
  readIndexSessionCompatible: boolean | null;
  columns: SqlServerAuditColumnInspection[];
  indexes: SqlServerAuditIndexInspection[];
  triggers: SqlServerAuditTriggerInspection[];
  constraints: SqlServerAuditConstraintInspection[];
  issues: Array<{ code: string; object?: string; message: string }>;
  /** Original inspection failure, when database access or result decoding failed. */
  cause?: unknown;
}

const EXPECTED_COLUMNS: Array<[string, string, number, boolean, number]> = [
  ['id', 'uniqueidentifier', 16, false, 0],
  ['tenant_id', 'nvarchar', -1, true, 0],
  ['actor_id', 'nvarchar', -1, true, 0],
  ['actor_type', 'nvarchar', -1, false, 0],
  ['actor_ip', 'nvarchar', -1, true, 0],
  ['action', 'nvarchar', -1, false, 0],
  ['target_type', 'nvarchar', -1, true, 0],
  ['target_id', 'nvarchar', -1, true, 0],
  ['source', 'nvarchar', -1, false, 0],
  ['changes', 'nvarchar', -1, true, 0],
  ['metadata', 'nvarchar', -1, true, 0],
  ['result', 'nvarchar', -1, false, 0],
  ['created_at', 'datetime2', 8, false, 7],
];

function parseRows<T>(value: unknown): T[] {
  if (typeof value !== 'string') throw new Error('Invalid SQL Server inspection metadata result.');
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Invalid SQL Server inspection metadata array.');
  return parsed as T[];
}

/**
 * Read-only catalog diagnostics. Use an installer/diagnostic identity with VIEW
 * DEFINITION for complete results; INSERT-only runtime access remains sufficient
 * for logging. Missing metadata is never interpreted as an absent table unless
 * the connection is the effective database owner. A scope grant can still be
 * overridden by an object-level DENY, so it cannot prove absence on its own.
 */
export async function inspectSqlServerAuditStorage(
  prisma: SqlServerInspectionClient,
  options: SqlServerAuditStorageOptions = {},
): Promise<SqlServerAuditStorageInspection> {
  const { table, qualified } = getSqlServerTableName(options.tableName);
  const result: SqlServerAuditStorageInspection = {
    tableName: qualified, status: 'unavailable', metadataComplete: false,
    enforcementVerified: false, readIndexSessionCompatible: null,
    columns: [], indexes: [], triggers: [], constraints: [], issues: [],
  };
  const sql = `DECLARE @object_id INT = OBJECT_ID(N'${qualified}');
SELECT @object_id AS [objectId],
  (SELECT RTRIM([type]) FROM sys.objects WHERE [object_id] = @object_id) AS [objectType],
  CASE WHEN USER_NAME() = N'dbo' THEN 1 ELSE 0 END AS [canProveMissing],
  CASE WHEN HAS_PERMS_BY_NAME(N'${qualified}', N'OBJECT', N'VIEW DEFINITION') = 1 THEN 1 ELSE 0 END AS [canInspectObject],
  CASE WHEN SESSIONPROPERTY('ANSI_NULLS') = 1 AND SESSIONPROPERTY('ANSI_PADDING') = 1
    AND SESSIONPROPERTY('ANSI_WARNINGS') = 1 AND SESSIONPROPERTY('CONCAT_NULL_YIELDS_NULL') = 1
    AND SESSIONPROPERTY('QUOTED_IDENTIFIER') = 1 AND SESSIONPROPERTY('NUMERIC_ROUNDABORT') = 0
    AND (SESSIONPROPERTY('ARITHABORT') = 1 OR (SELECT [compatibility_level] FROM sys.databases WHERE [database_id] = DB_ID()) >= 90)
    THEN 1 ELSE 0 END AS [sessionCompatible],
  (SELECT c.[name], TYPE_NAME(c.[system_type_id]) AS [type], c.[max_length] AS [maxLength],
    c.[is_nullable] AS [nullable], c.[is_computed] AS [computed], c.[scale], cc.[definition], d.[definition] AS [defaultDefinition]
    FROM sys.columns AS c LEFT JOIN sys.computed_columns AS cc
      ON cc.[object_id] = c.[object_id] AND cc.[column_id] = c.[column_id]
    LEFT JOIN sys.default_constraints AS d ON d.[object_id] = c.[default_object_id]
    WHERE c.[object_id] = @object_id ORDER BY c.[column_id] FOR JSON PATH) AS [columnsJson],
  (SELECT i.[name], i.[type], i.[is_disabled] AS [disabled], i.[is_primary_key] AS [primaryKey],
    JSON_QUERY((SELECT c.[name], k.[is_descending_key] AS [descending]
      FROM sys.index_columns AS k JOIN sys.columns AS c ON c.[object_id] = k.[object_id] AND c.[column_id] = k.[column_id]
      WHERE k.[object_id] = i.[object_id] AND k.[index_id] = i.[index_id] AND k.[key_ordinal] > 0
      ORDER BY k.[key_ordinal] FOR JSON PATH)) AS [keys]
    FROM sys.indexes AS i WHERE i.[object_id] = @object_id AND i.[index_id] > 0 FOR JSON PATH) AS [indexesJson],
  (SELECT t.[name], t.[is_disabled] AS [disabled], t.[is_instead_of_trigger] AS [insteadOf],
    CASE WHEN OBJECT_DEFINITION(t.[object_id]) IS NULL THEN CAST(0 AS BIT) ELSE CAST(1 AS BIT) END AS [definitionAvailable],
    JSON_QUERY((SELECT e.[type_desc] AS [event] FROM sys.trigger_events AS e WHERE e.[object_id] = t.[object_id] FOR JSON PATH)) AS [events]
    FROM sys.triggers AS t WHERE t.[parent_id] = @object_id FOR JSON PATH) AS [triggersJson],
  (SELECT [name], [is_disabled] AS [disabled], [is_not_trusted] AS [untrusted], [definition]
    FROM sys.check_constraints WHERE [parent_object_id] = @object_id FOR JSON PATH) AS [constraintsJson];`;
  try {
    const rows = await prisma.$queryRawUnsafe(sql) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) throw new Error('SQL Server inspection returned no metadata row.');
    if (row.objectId !== null && !Number.isInteger(row.objectId)) throw new Error('Invalid SQL Server object metadata.');
    result.readIndexSessionCompatible = row.sessionCompatible === 1;
    const canProveMissing = row.canProveMissing === 1;
    result.metadataComplete = row.canInspectObject === 1;
    if (row.objectId === null) {
      result.status = canProveMissing ? 'missing' : 'unavailable';
      result.metadataComplete = canProveMissing;
      result.issues.push({
        code: canProveMissing ? 'TABLE_MISSING' : 'METADATA_UNAVAILABLE',
        message: canProveMissing ? 'The audit table does not exist.' : 'The table is absent or hidden by metadata permissions; an effective database owner can distinguish these cases.',
      });
      return result;
    }
    result.status = 'inspected';
    if (!result.metadataComplete) result.issues.push({ code: 'METADATA_PARTIAL', message: 'Catalog visibility is limited; use a diagnostic identity with VIEW DEFINITION.' });
    if (row.objectType !== 'U') result.issues.push({ code: 'NOT_A_TABLE', message: 'The configured object is not a user table.' });
    result.columns = parseRows<SqlServerAuditColumnInspection>(row.columnsJson);
    result.indexes = parseRows<SqlServerAuditIndexInspection>(row.indexesJson);
    result.triggers = parseRows<Omit<SqlServerAuditTriggerInspection, 'events'> & { events: Array<{ event: string }> }>(row.triggersJson)
      .map(trigger => ({ ...trigger, events: trigger.events.map(event => event.event) }));
    result.constraints = parseRows<SqlServerAuditConstraintInspection>(row.constraintsJson);
    for (const [name, type, maxLength, nullable, scale] of EXPECTED_COLUMNS) {
      const column = result.columns.find(candidate => candidate.name === name);
      if (!column || column.type !== type || column.maxLength !== maxLength || column.nullable !== nullable || column.scale !== scale || column.computed) {
        result.issues.push({ code: column ? 'COLUMN_INCOMPATIBLE' : 'COLUMN_MISSING', object: name, message: `Expected ${type}${maxLength === -1 ? '(MAX)' : ''} audit column with the documented nullability and precision.` });
      }
    }
    const normalize = (value?: string) => value?.toLowerCase().replace(/[\s[\]()]/g, '');
    for (const [name, expected] of [['id', 'newid'], ['created_at', 'sysutcdatetime']]) {
      if (normalize(result.columns.find(column => column.name === name)?.defaultDefinition) !== expected) {
        result.issues.push({ code: 'DEFAULT_INCOMPATIBLE', object: name, message: `Expected the documented ${expected} default; its definition may be absent or hidden.` });
      }
    }
    const primaryKey = result.indexes.find(index => index.primaryKey);
    if (!primaryKey || primaryKey.type !== 2 || primaryKey.disabled || primaryKey.keys.length !== 1 || primaryKey.keys[0].name !== 'id') {
      result.issues.push({ code: 'PRIMARY_KEY_INCOMPATIBLE', message: 'Expected an enabled nonclustered primary key on id.' });
    }
    for (const column of ['changes', 'metadata']) {
      const name = `${table}_${column}_json`;
      const constraint = result.constraints.find(candidate => candidate.name === name);
      if (!constraint || constraint.disabled || constraint.untrusted || normalize(constraint.definition) !== `${column}isnullorisjson${column}=1`) {
        result.issues.push({ code: 'JSON_CONSTRAINT_INCOMPATIBLE', object: name, message: 'Expected an enabled, trusted JSON validation constraint with a visible matching definition.' });
      }
    }
    const index = result.indexes.find(candidate => candidate.name === `idx_${table}_created`);
    if (!index || index.type !== 1 || index.disabled || index.keys.length !== 2 || index.keys.some((key, i) => key.name !== ['created_at', 'id'][i] || key.descending)) {
      result.issues.push({ code: 'CREATED_INDEX_INCOMPATIBLE', object: `idx_${table}_created`, message: 'Expected an enabled clustered (created_at, id) index.' });
    }
    for (const operation of ['UPDATE', 'DELETE']) {
      const name = `${table}_no_${operation.toLowerCase()}_trg`;
      const trigger = result.triggers.find(candidate => candidate.name === name);
      if (!trigger || trigger.disabled || trigger.insteadOf || !trigger.events.includes(operation)) {
        result.issues.push({ code: trigger?.disabled ? 'TRIGGER_DISABLED' : 'TRIGGER_INCOMPATIBLE', object: name, message: `Expected an enabled AFTER ${operation} trigger. Its body must be verified separately.` });
      } else if (!trigger.definitionAvailable) {
        result.issues.push({ code: 'TRIGGER_DEFINITION_UNAVAILABLE', object: name, message: 'The trigger body is hidden or encrypted; append-only behavior is not verified.' });
      }
    }
    for (const index of result.indexes.filter(candidate => candidate.disabled)) {
      if (index.name !== `idx_${table}_created`) result.issues.push({ code: 'INDEX_DISABLED', object: index.name, message: 'An audit-table index is disabled.' });
    }
    if (!result.readIndexSessionCompatible) result.issues.push({ code: 'READ_INDEX_SESSION_OPTIONS', message: 'This connection does not meet the SET-option requirements for indexed computed columns. Verify every writer before installing read indexes.' });
    return result;
  } catch (cause) {
    return { ...result, status: 'unavailable', metadataComplete: false, cause, issues: [{ code: 'INSPECTION_FAILED', message: 'The database inspection could not be completed; no storage health conclusion is available.' }] };
  }
}
