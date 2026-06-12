import {
  getAuditTableSQL,
  getAuditTableStatements,
  applyAuditTableSchema,
  ensurePartitions,
} from '../src/sql';
import { validateAuditTableName } from '../src/sql/table-name';

describe('SQL utilities', () => {
  describe('validateAuditTableName()', () => {
    it.each([
      'audit_logs',
      'Audit_Logs2',
      'audit.audit_logs',
      'a'.repeat(44),
    ])('accepts valid tableName %s', (tableName) => {
      expect(validateAuditTableName(tableName)).toBe(tableName);
    });

    it.each([
      'audit-logs',
      '1abc',
      'a.b.c',
      'a;DROP',
      'a'.repeat(45),
      '',
    ])('rejects invalid tableName %s', (tableName) => {
      expect(() => validateAuditTableName(tableName)).toThrow(
        'Invalid audit tableName',
      );
    });
  });

  describe('getAuditTableSQL()', () => {
    it('generates flat trigger-enforced DDL by default', () => {
      const sql = getAuditTableSQL();

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_logs');
      expect(sql).toContain('DROP RULE IF EXISTS audit_logs_no_update');
      expect(sql).toContain('CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger');
      expect(sql).toContain('CREATE TRIGGER audit_logs_no_update_trg');
      expect(sql).toContain("ERRCODE = 'P0001'");
      expect(sql).not.toContain('CREATE RULE audit_logs_no_update');
      expect(sql).not.toContain('USING GIN');
    });

    it('generates legacy rule enforcement when requested', () => {
      const sql = getAuditTableSQL({ enforcement: 'rule' });

      expect(sql).toContain('CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING');
      expect(sql).toContain('CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING');
      expect(sql).not.toContain('CREATE TRIGGER audit_logs_no_update_trg');
    });

    it('generates partitioned DDL with BRIN and initial partitions', () => {
      const sql = getAuditTableSQL({ partitioned: true });

      expect(sql).toContain('PRIMARY KEY (id, created_at)');
      expect(sql).toContain('PARTITION BY RANGE (created_at)');
      expect(sql).toContain('USING BRIN (created_at)');
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_logs_y\d{4}m\d{2} PARTITION OF audit_logs/);
      expect(sql).not.toContain('DEFAULT PARTITION');
    });

    it('adds GIN indexes when requested', () => {
      const sql = getAuditTableSQL({ ginIndex: true });

      expect(sql).toContain('idx_audit_changes_gin');
      expect(sql).toContain('idx_audit_metadata_gin');
      expect(sql).toContain('USING GIN (changes jsonb_path_ops)');
      expect(sql).toContain('USING GIN (metadata jsonb_path_ops)');
    });

    it('uses derived object names for custom tableName', () => {
      const sql = getAuditTableSQL({ tableName: 'audit.events' });

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit.events');
      expect(sql).toContain('CREATE OR REPLACE FUNCTION audit.events_block_mutation() RETURNS trigger');
      expect(sql).toContain('CREATE TRIGGER events_no_update_trg');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_events_tenant_created');
    });
  });

  describe('getAuditTableStatements()', () => {
    it('matches getAuditTableSQL joined with blank lines', () => {
      const options = { tableName: 'audit.events', ginIndex: true };

      expect(getAuditTableStatements(options).join('\n\n')).toBe(
        getAuditTableSQL(options),
      );
    });
  });

  describe('applyAuditTableSchema()', () => {
    it('executes each generated statement via prisma.$executeRawUnsafe', async () => {
      const mockPrisma = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      };

      await applyAuditTableSchema(mockPrisma, { enforcement: 'rule' });

      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(
        getAuditTableStatements({ enforcement: 'rule' }).length,
      );
      expect(mockPrisma.$executeRawUnsafe.mock.calls[0][0]).toContain(
        'CREATE TABLE IF NOT EXISTS audit_logs',
      );
    });

    it('propagates errors from prisma', async () => {
      const mockPrisma = {
        $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('syntax error')),
      };

      await expect(applyAuditTableSchema(mockPrisma)).rejects.toThrow(
        'syntax error',
      );
    });
  });

  describe('ensurePartitions()', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-12T00:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('creates current and ahead monthly partitions and returns their names', async () => {
      const mockPrisma = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      };

      const created = await ensurePartitions(mockPrisma, {
        tableName: 'audit.events',
        ahead: 1,
      });

      expect(created).toEqual(['audit.events_y2026m06', 'audit.events_y2026m07']);
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      expect(mockPrisma.$executeRawUnsafe.mock.calls[0][0]).toContain(
        'CREATE TABLE IF NOT EXISTS audit.events_y2026m06 PARTITION OF audit.events',
      );
      expect(mockPrisma.$executeRawUnsafe.mock.calls[0][0]).toContain(
        "FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')",
      );
    });

    it('rejects invalid tableName', async () => {
      await expect(
        ensurePartitions({ $executeRawUnsafe: jest.fn() }, { tableName: 'bad-name' }),
      ).rejects.toThrow('Invalid audit tableName');
    });
  });
});
