import {
  applySqlServerAuditReadIndexes,
  getSqlServerAuditReadIndexStatements,
  inspectSqlServerAuditStorage,
} from '../src/sql/sqlserver-maintenance';

function catalogRow(overrides: Record<string, unknown> = {}) {
  const columns = [
    { name: 'id', type: 'uniqueidentifier', maxLength: 16, nullable: false, computed: false, scale: 0, defaultDefinition: '(newid())' },
    ...['tenant_id', 'actor_id', 'actor_type', 'actor_ip', 'action', 'target_type', 'target_id', 'source', 'changes', 'metadata', 'result'].map(name => ({
      name, type: 'nvarchar', maxLength: -1, nullable: !['actor_type', 'action', 'source', 'result'].includes(name), computed: false, scale: 0,
    })),
    { name: 'created_at', type: 'datetime2', maxLength: 8, nullable: false, computed: false, scale: 7, defaultDefinition: '(sysutcdatetime())' },
  ];
  return {
    objectId: 42, objectType: 'U', canProveMissing: 1, canInspectObject: 1, sessionCompatible: 1,
    columnsJson: JSON.stringify(columns),
    indexesJson: JSON.stringify([
      { name: 'audit_logs_pkey', type: 2, disabled: false, primaryKey: true, keys: [{ name: 'id', descending: false }] },
      { name: 'idx_audit_logs_created', type: 1, disabled: false, primaryKey: false, keys: [{ name: 'created_at', descending: false }, { name: 'id', descending: false }] },
    ]),
    triggersJson: JSON.stringify(['UPDATE', 'DELETE'].map(event => ({
      name: `audit_logs_no_${event.toLowerCase()}_trg`, disabled: false, insteadOf: false, events: [{ event }], definitionAvailable: true,
    }))),
    constraintsJson: JSON.stringify(['changes', 'metadata'].map(column => ({
      name: `audit_logs_${column}_json`, disabled: false, untrusted: false, definition: `([${column}] IS NULL OR ISJSON([${column}])=(1))`,
    }))),
    ...overrides,
  };
}

function inspectionClient(overrides: Record<string, unknown> = {}) {
  return { $queryRawUnsafe: jest.fn().mockResolvedValue([catalogRow(overrides)]) };
}

describe('opt-in SQL Server read indexes', () => {
  it('adds bounded computed keys without changing original audit data columns', () => {
    const statements = getSqlServerAuditReadIndexStatements({ tableName: 'history.events' });
    expect(statements).toHaveLength(8);
    const sql = statements.join('\n');
    expect(sql).toContain('ALTER TABLE [history].[events] ADD [__audit_tenant_id_prefix] AS (CONVERT(NVARCHAR(128), [tenant_id] COLLATE Latin1_General_100_BIN2))');
    expect(sql).toContain('CREATE NONCLUSTERED INDEX [idx_events_read_target]');
    expect(sql).toContain('([__audit_tenant_id_prefix], [__audit_target_type_prefix], [__audit_target_id_prefix], [created_at] DESC, [id] DESC)');
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|UPDATE|DELETE)\b|ALTER COLUMN|DISABLE TRIGGER/i);
    expect(statements.every(statement => statement.startsWith('SET ANSI_NULLS ON;'))).toBe(true);
    expect(statements.every(statement => statement.includes('SET NUMERIC_ROUNDABORT OFF;'))).toBe(true);
  });

  it('validates existing prefix expressions and same-name index keys instead of overwriting them', () => {
    const statements = getSqlServerAuditReadIndexStatements();
    expect(statements[1]).toContain('FROM sys.computed_columns');
    expect(statements[1]).toContain("= N'convertnvarchar128,tenant_idcollatelatin1_general_100_bin2'");
    expect(statements[1]).toContain('THROW 51003');
    expect(statements[5]).toContain('i.[is_disabled] <> 0');
    expect(statements[5]).toContain('i.[has_filter] <> 0');
    expect(statements[5]).toContain("c.[name] = N'created_at'");
    expect(statements[5]).toContain('CREATE NONCLUSTERED INDEX');
  });

  it('stops on the original installer failure before later indexes are attempted', async () => {
    const failure = new Error('incompatible computed column');
    const prisma = { $executeRawUnsafe: jest.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(failure) };
    await expect(applySqlServerAuditReadIndexes(prisma)).rejects.toBe(failure);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('executes installer batches sequentially', async () => {
    let active = false;
    const prisma = { $executeRawUnsafe: jest.fn(async () => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
    }) };
    await applySqlServerAuditReadIndexes(prisma);
    expect(prisma.$executeRawUnsafe.mock.calls).toEqual(getSqlServerAuditReadIndexStatements().map(statement => [statement]));
  });

  it.each(['dbo.events;DROP', 'other.dbo.events', '[dbo].[events]'])('rejects invalid identifiers before any database access: %s', async tableName => {
    const prisma = { $executeRawUnsafe: jest.fn(), $queryRawUnsafe: jest.fn() };
    await expect(applySqlServerAuditReadIndexes(prisma, { tableName })).rejects.toThrow('Invalid audit tableName');
    await expect(inspectSqlServerAuditStorage(prisma, { tableName })).rejects.toThrow('Invalid audit tableName');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('SQL Server read-only storage inspection', () => {
  it('reports compatible visible catalog metadata without claiming trigger enforcement', async () => {
    const prisma = inspectionClient();
    const result = await inspectSqlServerAuditStorage(prisma);
    expect(result).toMatchObject({ status: 'inspected', metadataComplete: true, enforcementVerified: false, readIndexSessionCompatible: true, issues: [] });
    expect(result.columns.find(column => column.name === 'metadata')?.maxLength).toBe(-1);
    expect(result.triggers[0].events).toEqual(['UPDATE']);
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\b/i);
  });

  it('distinguishes owner-confirmed absence from hidden metadata', async () => {
    const absent = await inspectSqlServerAuditStorage(inspectionClient({ objectId: null }));
    expect(absent.status).toBe('missing');
    expect(absent.issues[0].code).toBe('TABLE_MISSING');
    const hidden = await inspectSqlServerAuditStorage(inspectionClient({ objectId: null, canProveMissing: 0, canInspectObject: 0 }));
    expect(hidden.status).toBe('unavailable');
    expect(hidden.metadataComplete).toBe(false);
    expect(hidden.issues[0].code).toBe('METADATA_UNAVAILABLE');
  });

  it('keeps object-level permission limits explicit even when catalog rows are visible', async () => {
    const result = await inspectSqlServerAuditStorage(inspectionClient({ canProveMissing: 0, canInspectObject: 0 }));
    expect(result.status).toBe('inspected');
    expect(result.metadataComplete).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'METADATA_PARTIAL' }));
  });

  it('reports altered columns, missing indexes, JSON constraints and disabled triggers independently', async () => {
    const result = await inspectSqlServerAuditStorage(inspectionClient({
      columnsJson: JSON.stringify([{ name: 'metadata', type: 'nvarchar', maxLength: 256, nullable: true, computed: false, scale: 0 }]),
      indexesJson: '[]', constraintsJson: '[]',
      triggersJson: JSON.stringify([{ name: 'audit_logs_no_update_trg', disabled: true, insteadOf: false, events: [{ event: 'UPDATE' }], definitionAvailable: true }]),
    }));
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COLUMN_INCOMPATIBLE', object: 'metadata' }),
      expect.objectContaining({ code: 'DEFAULT_INCOMPATIBLE', object: 'id' }),
      expect.objectContaining({ code: 'PRIMARY_KEY_INCOMPATIBLE' }),
      expect.objectContaining({ code: 'CREATED_INDEX_INCOMPATIBLE' }),
      expect.objectContaining({ code: 'JSON_CONSTRAINT_INCOMPATIBLE', object: 'audit_logs_metadata_json' }),
      expect.objectContaining({ code: 'TRIGGER_DISABLED', object: 'audit_logs_no_update_trg' }),
      expect.objectContaining({ code: 'TRIGGER_INCOMPATIBLE', object: 'audit_logs_no_delete_trg' }),
    ]));
  });

  it('does not trust an enabled same-named trigger with the wrong event or a hidden body', async () => {
    const result = await inspectSqlServerAuditStorage(inspectionClient({ triggersJson: JSON.stringify([
      { name: 'audit_logs_no_update_trg', disabled: false, insteadOf: false, events: [{ event: 'INSERT' }], definitionAvailable: true },
      { name: 'audit_logs_no_delete_trg', disabled: false, insteadOf: false, events: [{ event: 'DELETE' }], definitionAvailable: false },
    ]) }));
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TRIGGER_INCOMPATIBLE', object: 'audit_logs_no_update_trg' }),
      expect.objectContaining({ code: 'TRIGGER_DEFINITION_UNAVAILABLE', object: 'audit_logs_no_delete_trg' }),
    ]));
    expect(result.enforcementVerified).toBe(false);
  });

  it('reports incompatible inspection session options without changing them', async () => {
    const result = await inspectSqlServerAuditStorage(inspectionClient({ sessionCompatible: 0 }));
    expect(result.readIndexSessionCompatible).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'READ_INDEX_SESSION_OPTIONS' }));
  });

  it('preserves a database failure as unavailable rather than diagnosing missing storage', async () => {
    const cause = new Error('database unavailable');
    const result = await inspectSqlServerAuditStorage({ $queryRawUnsafe: jest.fn().mockRejectedValue(cause) });
    expect(result).toMatchObject({ status: 'unavailable', metadataComplete: false, enforcementVerified: false, cause });
    expect(result.issues).toEqual([{ code: 'INSPECTION_FAILED', message: expect.any(String) }]);
  });

  it('fails conservatively when catalog result decoding is incomplete', async () => {
    const result = await inspectSqlServerAuditStorage(inspectionClient({ columnsJson: null }));
    expect(result.status).toBe('unavailable');
    expect(result.metadataComplete).toBe(false);
    expect(result.issues[0].code).toBe('INSPECTION_FAILED');
  });
});
