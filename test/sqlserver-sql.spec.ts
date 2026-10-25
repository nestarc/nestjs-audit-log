import {
  applyAuditTableSchema,
  ensurePartitions,
  getAuditTableSQL,
  getAuditTableStatements,
} from '../src/sql';
import type { AuditTableSQLOptions } from '../src/sql';
import { getSqlServerTableName, validateAuditTableName } from '../src/sql/table-name';

const sqlServer = { provider: 'sqlserver' } as const;

function mockPrisma() {
  return {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRawUnsafe: jest.fn(),
  };
}

describe('SQL Server audit DDL', () => {
  it('uses dbo by default and quotes schema and table independently', () => {
    expect(getSqlServerTableName()).toEqual({
      schema: 'dbo',
      table: 'audit_logs',
      quoted: '[dbo].[audit_logs]',
      qualified: 'dbo.audit_logs',
    });
    expect(getSqlServerTableName('select.order').quoted).toBe('[select].[order]');
    const statements = getAuditTableStatements({ ...sqlServer, tableName: 'select.order' });
    expect(statements[0]).toContain('CREATE TABLE [select].[order]');
    expect(statements).toContainEqual(expect.stringContaining('CREATE OR ALTER TRIGGER [select].[order_no_update_trg]'));
    expect(statements.join('\n')).not.toContain('CREATE SCHEMA');
    expect(statements[0]).toContain("IF SCHEMA_ID(N'select') IS NULL");
  });

  it('limits SQL Server schema identifiers without changing PostgreSQL validation', () => {
    const longSchema = 'a'.repeat(129);
    expect(getSqlServerTableName(`${'a'.repeat(128)}.${'b'.repeat(44)}`).schema).toHaveLength(128);
    expect(() => getSqlServerTableName(`${longSchema}.events`)).toThrow('128 characters');
    expect(validateAuditTableName(`${longSchema}.events`)).toBe(`${longSchema}.events`);
  });

  it.each(['database.dbo.events', '[dbo].[events]', 'dbo.events;DROP', 'dbo..events', 'audit-logs', 'a'.repeat(45)])(
    'rejects unsafe or unsupported identifier %s before executing SQL',
    async (tableName) => {
      const prisma = mockPrisma();
      await expect(applyAuditTableSchema(prisma, { ...sqlServer, tableName })).rejects.toThrow('Invalid audit tableName');
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it('preserves unbounded Unicode audit fields and creates UUID and UTC time defaults', () => {
    const statements = getAuditTableStatements(sqlServer);
    const create = statements[0];
    const textColumns = ['tenant_id', 'actor_id', 'actor_type', 'actor_ip', 'action', 'target_type', 'target_id', 'source', 'changes', 'metadata', 'result'];
    for (const column of textColumns) {
      expect(create).toContain(`[${column}] NVARCHAR(MAX)`);
    }
    expect(create).toContain('[id] UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID()');
    expect(create).toContain('[created_at] DATETIME2(7) NOT NULL DEFAULT SYSUTCDATETIME()');
    expect(create).toContain('PRIMARY KEY NONCLUSTERED ([id])');
    expect(statements.join('\n')).toContain('CREATE CLUSTERED INDEX [idx_audit_logs_created] ON [dbo].[audit_logs] ([created_at], [id])');
    expect(statements.join('\n')).not.toMatch(/JSONB|TIMESTAMPTZ|gen_random_uuid|pg_class|USING GIN|NVARCHAR\(255\)/);
  });

  it('validates compatible existing tables instead of dropping or replacing them', () => {
    const statements = getAuditTableStatements(sqlServer);
    expect(statements[0]).toContain("IF OBJECT_ID(N'dbo.audit_logs', N'U') IS NULL");
    const validation = statements[1];
    expect(validation).toContain("(N'id', N'uniqueidentifier', 16, 0, 0)");
    expect(validation).toContain("(N'created_at', N'datetime2', 8, 0, 7)");
    expect(validation).toContain("(N'metadata', N'nvarchar', -1, 1, 0)");
    expect(validation).toContain('actual.[is_nullable] <> expected.[nullable]');
    expect(validation).toContain("= N'newid'");
    expect(validation).toContain("= N'sysutcdatetime'");
    expect(validation).toContain('i.[is_primary_key] = 1');
    expect(validation).toContain('THROW 51002');
    expect(validation).toContain('Incompatible SQL Server audit table');
    expect(validation).toContain('FROM sys.check_constraints');
    expect(validation).toContain("i.[name] <> N'idx_audit_logs_created'");
    expect(validation).not.toMatch(/ALTER TABLE|CREATE CLUSTERED INDEX/);
    expect(statements.join('\n')).not.toMatch(/DROP\s+(?:TABLE|TRIGGER|INDEX)|TRUNCATE/i);
  });

  it('validates nullable JSON documents and restores check enforcement on reapply', () => {
    const checks = getAuditTableStatements(sqlServer)[2];
    for (const column of ['changes', 'metadata']) {
      expect(checks).toContain(`CHECK ([${column}] IS NULL OR ISJSON([${column}]) = 1)`);
      expect(checks).toContain(`WITH CHECK CHECK CONSTRAINT [audit_logs_${column}_json]`);
    }
    expect(checks).toContain('FROM sys.check_constraints');
    expect(checks).toContain('[is_disabled] = 1 OR [is_not_trusted] = 1');
    // The one-argument form permits both JSON objects and arrays.
    expect(checks).not.toContain(', OBJECT');
  });

  it('keeps trigger creation first in its batch, permits zero-row mutations and reenables triggers', () => {
    const statements = getAuditTableStatements(sqlServer);
    const triggerBatches = statements.filter((statement) => statement.startsWith('CREATE OR ALTER TRIGGER'));
    expect(triggerBatches).toHaveLength(2);
    for (const operation of ['UPDATE', 'DELETE']) {
      const batch = triggerBatches.find((statement) => statement.includes(`AFTER ${operation}`));
      expect(batch).toContain('SET NOCOUNT ON;');
      expect(batch).toMatch(/IF EXISTS \(SELECT 1 FROM deleted\)\s+THROW 51001/);
      expect(batch).toContain(`${operation} blocked on append-only audit table dbo.audit_logs`);
      expect(statements).toContain(`ENABLE TRIGGER [dbo].[audit_logs_no_${operation.toLowerCase()}_trg] ON [dbo].[audit_logs];`);
    }
  });

  it('exports a fail-fast sqlcmd script while executing each Prisma batch separately in order', async () => {
    const options = { ...sqlServer, tableName: 'audit.events' };
    const statements = getAuditTableStatements(options);
    expect(getAuditTableSQL(options)).toBe(`:ON ERROR EXIT\n${statements.join('\nGO\n')}\nGO\n`);
    const prisma = mockPrisma();
    await applyAuditTableSchema(prisma, options);
    expect(prisma.$executeRawUnsafe.mock.calls).toEqual(statements.map((statement) => [statement]));
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    for (const [statement] of prisma.$executeRawUnsafe.mock.calls) {
      expect(statement).not.toMatch(/^GO$|^:ON ERROR EXIT$/m);
    }
  });

  it('propagates database validation errors and stops before later batches', async () => {
    const prisma = mockPrisma();
    const mismatch = new Error('Incompatible SQL Server audit table');
    prisma.$executeRawUnsafe.mockResolvedValueOnce(0).mockRejectedValueOnce(mismatch);
    await expect(applyAuditTableSchema(prisma, sqlServer)).rejects.toBe(mismatch);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it.each<AuditTableSQLOptions>([
    { ...sqlServer, partitioned: true },
    { ...sqlServer, ginIndex: true },
    { ...sqlServer, enforcement: 'rule' },
  ])('rejects PostgreSQL-only DDL options before I/O: %j', async (options) => {
    expect(() => getAuditTableStatements(options)).toThrow('not supported');
    const prisma = mockPrisma();
    await expect(applyAuditTableSchema(prisma, options)).rejects.toThrow('not supported');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects unknown providers and unsupported partition maintenance before I/O', async () => {
    const prisma = mockPrisma();
    const invalid = { provider: 'mysql' } as unknown as AuditTableSQLOptions;
    await expect(applyAuditTableSchema(prisma, invalid)).rejects.toThrow('provider must be');
    await expect(ensurePartitions(prisma, sqlServer)).rejects.toThrow('ensurePartitions is not supported');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each<AuditTableSQLOptions>([{}, { enforcement: 'rule' }, { ginIndex: true }, { tableName: 'audit.events', partitioned: true }])(
    'keeps omitted-provider PostgreSQL SQL identical to explicit PostgreSQL: %j',
    (options) => {
      expect(getAuditTableStatements(options)).toEqual(getAuditTableStatements({ ...options, provider: 'postgresql' }));
      expect(getAuditTableSQL(options)).toBe(getAuditTableSQL({ ...options, provider: 'postgresql' }));
      expect(getAuditTableSQL(options)).toBe(getAuditTableStatements(options).join('\n\n'));
    },
  );
});
