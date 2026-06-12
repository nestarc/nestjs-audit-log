import { PrismaClient } from '@prisma/client';
import { applyAuditTableSchema } from '../../src/sql';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

describe('append-only enforcement E2E', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });
  });

  beforeEach(async () => {
    await dropAuditTable('audit_logs_rule_mode');
    await dropAuditTable('audit_logs_trigger_mode');
  });

  afterAll(async () => {
    await dropAuditTable('audit_logs_rule_mode');
    await dropAuditTable('audit_logs_trigger_mode');
    await prisma.$disconnect();
  });

  it('keeps rule mode as silent no-op for UPDATE and DELETE', async () => {
    await applyAuditTableSchema(prisma, {
      tableName: 'audit_logs_rule_mode',
      enforcement: 'rule',
    });
    const id = await insertAuditRow('audit_logs_rule_mode', 'original');

    const updated = await prisma.$executeRawUnsafe(
      `UPDATE audit_logs_rule_mode SET action = 'tampered' WHERE id = '${id}'`,
    );
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs_rule_mode WHERE id = '${id}'`,
    );
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT action FROM audit_logs_rule_mode WHERE id = '${id}'`,
    );

    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    expect(rows).toEqual([{ action: 'original' }]);
  });

  it('raises in trigger mode for UPDATE and DELETE while allowing INSERT', async () => {
    await applyAuditTableSchema(prisma, {
      tableName: 'audit_logs_trigger_mode',
      enforcement: 'trigger',
    });
    const id = await insertAuditRow('audit_logs_trigger_mode', 'original');

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE audit_logs_trigger_mode SET action = 'tampered' WHERE id = '${id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM audit_logs_trigger_mode WHERE id = '${id}'`,
      ),
    ).rejects.toThrow();

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT action FROM audit_logs_trigger_mode WHERE id = '${id}'`,
    );
    expect(rows).toEqual([{ action: 'original' }]);
  });

  async function insertAuditRow(
    tableName: 'audit_logs_rule_mode' | 'audit_logs_trigger_mode',
    action: string,
  ): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${tableName} (actor_type, action, source, result)
       VALUES ('system', '${action}', 'manual', 'success')
       RETURNING id`,
    );
    return rows[0].id;
  }

  async function dropAuditTable(tableName: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS ${tableName}_block_mutation() CASCADE`,
    );
  }
});
