import { readFileSync } from 'fs';
import {
  getAuditTableSQL,
  getAuditTableStatements,
  applyAuditTableSchema,
} from '../src/sql';

jest.mock('fs', () => ({
  readFileSync: jest.fn(),
}));

const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

describe('SQL utilities', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getAuditTableSQL()', () => {
    it('reads the SQL file from the correct path', () => {
      mockReadFileSync.mockReturnValue('CREATE TABLE audit_logs (...);');
      const result = getAuditTableSQL();
      expect(result).toBe('CREATE TABLE audit_logs (...);');
      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining('audit-log-schema.sql'),
        'utf-8',
      );
    });
  });

  describe('getAuditTableStatements()', () => {
    it('splits simple statements by semicolon', () => {
      mockReadFileSync.mockReturnValue(
        'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);',
      );
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(2);
      expect(stmts[0]).toContain('CREATE TABLE a');
      expect(stmts[1]).toContain('CREATE TABLE b');
    });

    it('skips empty lines and comments', () => {
      mockReadFileSync.mockReturnValue(
        '-- This is a comment\n\nCREATE TABLE a (id INT);\n-- Another comment\n',
      );
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(1);
      expect(stmts[0]).toContain('CREATE TABLE a');
    });

    it('handles PL/pgSQL $$ blocks with inner semicolons', () => {
      mockReadFileSync.mockReturnValue(
        [
          'DO $$ BEGIN',
          "  CREATE RULE no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;",
          'EXCEPTION WHEN duplicate_object THEN NULL;',
          'END $$;',
        ].join('\n'),
      );
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(1);
      expect(stmts[0]).toContain('DO $$ BEGIN');
      expect(stmts[0]).toContain('END $$;');
    });

    it('handles multiple statements with $$ blocks interspersed', () => {
      mockReadFileSync.mockReturnValue(
        [
          'CREATE TABLE audit_logs (id UUID);',
          '',
          'DO $$ BEGIN',
          '  CREATE RULE r1 AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;',
          'EXCEPTION WHEN duplicate_object THEN NULL;',
          'END $$;',
          '',
          'CREATE INDEX idx_audit ON audit_logs (id);',
        ].join('\n'),
      );
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(3);
      expect(stmts[0]).toContain('CREATE TABLE');
      expect(stmts[1]).toContain('DO $$');
      expect(stmts[2]).toContain('CREATE INDEX');
    });

    it('handles statement without trailing semicolon', () => {
      mockReadFileSync.mockReturnValue('CREATE TABLE a (id INT)');
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(1);
      expect(stmts[0]).toContain('CREATE TABLE a');
    });

    it('returns empty array for empty SQL', () => {
      mockReadFileSync.mockReturnValue('');
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(0);
    });

    it('returns empty array for comments-only SQL', () => {
      mockReadFileSync.mockReturnValue('-- just a comment\n-- another one\n');
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(0);
    });

    it('preserves comments inside $$ blocks', () => {
      mockReadFileSync.mockReturnValue(
        [
          'DO $$ BEGIN',
          '  -- inner comment',
          '  NULL;',
          'END $$;',
        ].join('\n'),
      );
      const stmts = getAuditTableStatements();
      expect(stmts).toHaveLength(1);
      expect(stmts[0]).toContain('-- inner comment');
    });
  });

  describe('applyAuditTableSchema()', () => {
    it('executes each statement via prisma.$executeRawUnsafe', async () => {
      mockReadFileSync.mockReturnValue(
        'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);',
      );
      const mockPrisma = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      };

      await applyAuditTableSchema(mockPrisma);

      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      expect(mockPrisma.$executeRawUnsafe.mock.calls[0][0]).toContain('CREATE TABLE a');
      expect(mockPrisma.$executeRawUnsafe.mock.calls[1][0]).toContain('CREATE TABLE b');
    });

    it('propagates errors from prisma', async () => {
      mockReadFileSync.mockReturnValue('INVALID SQL;');
      const mockPrisma = {
        $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('syntax error')),
      };

      await expect(applyAuditTableSchema(mockPrisma)).rejects.toThrow('syntax error');
    });
  });
});
