import { validateAuditTableName } from './table-name';

export interface AuditTableSQLOptions {
  tableName?: string;
  partitioned?: boolean;
  enforcement?: 'trigger' | 'rule';
  ginIndex?: boolean;
}

export interface EnsurePartitionsOptions {
  tableName?: string;
  ahead?: number;
}

interface AuditObjectNames {
  tableName: string;
  tablePart: string;
  triggerFunction: string;
  updateTrigger: string;
  deleteTrigger: string;
  updateRule: string;
  deleteRule: string;
  tenantCreatedIndex: string;
  actorIndex: string;
  targetIndex: string;
  actionIndex: string;
  createdBrinIndex: string;
  changesGinIndex: string;
  metadataGinIndex: string;
}

function schemaQualified(tableName: string, objectName: string): string {
  const parts = tableName.split('.');
  return parts.length === 2 ? `${parts[0]}.${objectName}` : objectName;
}

function tablePartOf(tableName: string): string {
  return tableName.split('.').pop() ?? tableName;
}

export function deriveAuditObjectNames(tableName: string): AuditObjectNames {
  const tablePart = tablePartOf(tableName);
  const legacy = tableName === 'audit_logs';
  return {
    tableName,
    tablePart,
    triggerFunction: schemaQualified(tableName, `${tablePart}_block_mutation`),
    updateTrigger: `${tablePart}_no_update_trg`,
    deleteTrigger: `${tablePart}_no_delete_trg`,
    updateRule: `${tablePart}_no_update`,
    deleteRule: `${tablePart}_no_delete`,
    tenantCreatedIndex: legacy
      ? 'idx_audit_tenant_created'
      : `idx_${tablePart}_tenant_created`,
    actorIndex: legacy ? 'idx_audit_actor' : `idx_${tablePart}_actor`,
    targetIndex: legacy ? 'idx_audit_target' : `idx_${tablePart}_target`,
    actionIndex: legacy ? 'idx_audit_action' : `idx_${tablePart}_action`,
    createdBrinIndex: legacy
      ? 'idx_audit_created_brin'
      : `idx_${tablePart}_created_brin`,
    changesGinIndex: legacy
      ? 'idx_audit_changes_gin'
      : `idx_${tablePart}_changes_gin`,
    metadataGinIndex: legacy
      ? 'idx_audit_metadata_gin'
      : `idx_${tablePart}_metadata_gin`,
  };
}

function createTableStatement(names: AuditObjectNames, partitioned: boolean): string {
  if (partitioned) {
    return `CREATE TABLE IF NOT EXISTS ${names.tableName} (
  id            UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  actor_id      TEXT,
  actor_type    TEXT NOT NULL DEFAULT 'user',
  actor_ip      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',
  changes       JSONB,
  metadata      JSONB,
  result        TEXT NOT NULL DEFAULT 'success',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ${names.tablePart}_pkey PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);`;
  }

  return `CREATE TABLE IF NOT EXISTS ${names.tableName} (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  actor_id      TEXT,
  actor_type    TEXT NOT NULL DEFAULT 'user',
  actor_ip      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',
  changes       JSONB,
  metadata      JSONB,
  result        TEXT NOT NULL DEFAULT 'success',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);`;
}

function triggerStatements(names: AuditObjectNames): string[] {
  return [
    `DROP RULE IF EXISTS ${names.updateRule} ON ${names.tableName};`,
    `DROP RULE IF EXISTS ${names.deleteRule} ON ${names.tableName};`,
    `CREATE OR REPLACE FUNCTION ${names.triggerFunction}() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '@nestarc/audit-log: % blocked on append-only table %',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          HINT = 'Use AuditService.prune() for retention maintenance.';
END;
$$;`,
    `DROP TRIGGER IF EXISTS ${names.updateTrigger} ON ${names.tableName};`,
    `CREATE TRIGGER ${names.updateTrigger}
  BEFORE UPDATE ON ${names.tableName}
  FOR EACH ROW EXECUTE FUNCTION ${names.triggerFunction}();`,
    `DROP TRIGGER IF EXISTS ${names.deleteTrigger} ON ${names.tableName};`,
    `CREATE TRIGGER ${names.deleteTrigger}
  BEFORE DELETE ON ${names.tableName}
  FOR EACH ROW EXECUTE FUNCTION ${names.triggerFunction}();`,
  ];
}

function ruleStatements(
  names: AuditObjectNames,
  partitioned: boolean,
): string[] {
  const statements = [
    `DO $$ BEGIN
  CREATE RULE ${names.updateRule} AS ON UPDATE TO ${names.tableName} DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
    `DO $$ BEGIN
  CREATE RULE ${names.deleteRule} AS ON DELETE TO ${names.tableName} DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
  ];

  if (!partitioned) {
    return statements;
  }

  return [
    `-- WARNING: legacy RULE enforcement is applied only to the partitioned parent table; direct DML against child partitions is not blocked. Prefer trigger enforcement for partitioned audit tables.`,
    ...statements,
  ];
}

function indexStatements(names: AuditObjectNames, options: AuditTableSQLOptions): string[] {
  const statements: string[] = [];
  if (options.partitioned) {
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${names.createdBrinIndex} ON ${names.tableName} USING BRIN (created_at);`,
    );
  }
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${names.tenantCreatedIndex} ON ${names.tableName} (tenant_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS ${names.actorIndex} ON ${names.tableName} (actor_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS ${names.targetIndex} ON ${names.tableName} (target_type, target_id);`,
    `CREATE INDEX IF NOT EXISTS ${names.actionIndex} ON ${names.tableName} (action);`,
  );
  if (options.ginIndex) {
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${names.changesGinIndex} ON ${names.tableName} USING GIN (changes jsonb_path_ops);`,
      `CREATE INDEX IF NOT EXISTS ${names.metadataGinIndex} ON ${names.tableName} USING GIN (metadata jsonb_path_ops);`,
    );
  }
  return statements;
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatUtcMonthStart(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01 00:00:00+00`;
}

function partitionPlan(
  names: AuditObjectNames,
  ahead: number,
): Array<{ name: string; statement: string }> {
  const now = new Date();
  const current = addMonths(now, 0);
  return Array.from({ length: ahead + 1 }, (_unused, offset) => {
    const start = addMonths(current, offset);
    const end = addMonths(current, offset + 1);
    const year = start.getUTCFullYear();
    const month = String(start.getUTCMonth() + 1).padStart(2, '0');
    const partitionName = schemaQualified(
      names.tableName,
      `${names.tablePart}_y${year}m${month}`,
    );
    return {
      name: partitionName,
      statement: `CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF ${names.tableName}
  FOR VALUES FROM ('${formatUtcMonthStart(start)}') TO ('${formatUtcMonthStart(end)}');`,
    };
  });
}

function partitionStatements(names: AuditObjectNames, ahead = 1): string[] {
  return partitionPlan(names, ahead).map((partition) => partition.statement);
}

export function getAuditTableStatements(
  options: AuditTableSQLOptions = {},
): string[] {
  const tableName = validateAuditTableName(options.tableName);
  const names = deriveAuditObjectNames(tableName);
  const enforcement = options.enforcement ?? 'trigger';
  const statements = [
    createTableStatement(names, options.partitioned ?? false),
    ...(enforcement === 'rule'
      ? ruleStatements(names, options.partitioned ?? false)
      : triggerStatements(names)),
    ...indexStatements(names, options),
  ];
  if (options.partitioned) {
    statements.push(...partitionStatements(names));
  }
  return statements;
}

export function getAuditTableSQL(options: AuditTableSQLOptions = {}): string {
  return getAuditTableStatements(options).join('\n\n');
}

async function getTableRelkind(
  prisma: any,
  tableName: string,
): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT relkind FROM pg_class WHERE oid = to_regclass($1)',
    tableName,
  ) as Array<{ relkind?: string }>;
  return rows[0]?.relkind ?? null;
}

export async function applyAuditTableSchema(
  prisma: any,
  options: AuditTableSQLOptions = {},
): Promise<void> {
  const tableName = validateAuditTableName(options.tableName);
  if (options.partitioned) {
    const relkind = await getTableRelkind(prisma, tableName);
    if (relkind === 'r') {
      throw new Error(
        `[@nestarc/audit-log] flat audit table already exists for '${tableName}'. ` +
          'Follow the documented flat-to-partitioned migration procedure before applying partitioned DDL.',
      );
    }
    if (relkind !== null && relkind !== 'p') {
      throw new Error(
        `[@nestarc/audit-log] audit table '${tableName}' exists but is not a supported partitioned table.`,
      );
    }
  }

  for (const stmt of getAuditTableStatements(options)) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

function duplicateTableError(error: unknown): boolean {
  const maybePgError = error as { code?: string; message?: string };
  return (
    maybePgError?.code === '42P07' ||
    maybePgError?.message?.includes('already exists') === true
  );
}

export async function ensurePartitions(
  prisma: any,
  options: EnsurePartitionsOptions = {},
): Promise<string[]> {
  const tableName = validateAuditTableName(options.tableName);
  const names = deriveAuditObjectNames(tableName);
  const ahead = options.ahead ?? 1;
  if (!Number.isInteger(ahead) || ahead < 0) {
    throw new Error(
      '[@nestarc/audit-log] ahead must be a non-negative integer.',
    );
  }

  const relkind = await getTableRelkind(prisma, tableName);
  if (relkind !== 'p') {
    throw new Error(
      `[@nestarc/audit-log] ensurePartitions target '${tableName}' must be a partitioned table.`,
    );
  }

  const partitions = partitionPlan(names, ahead);
  const created: string[] = [];

  for (const partition of partitions) {
    const existsRows = await prisma.$queryRawUnsafe(
      'SELECT to_regclass($1) AS "exists"',
      partition.name,
    ) as Array<{ exists: string | null }>;
    if (existsRows[0]?.exists) {
      continue;
    }

    try {
      await prisma.$executeRawUnsafe(partition.statement);
      created.push(partition.name);
    } catch (error) {
      if (!duplicateTableError(error)) {
        throw error;
      }
    }
  }

  return created;
}
