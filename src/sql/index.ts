import { readFileSync } from 'fs';
import { join } from 'path';

export function getAuditTableSQL(): string {
  return readFileSync(join(__dirname, 'audit-log-schema.sql'), 'utf-8');
}

/**
 * Split the audit table SQL into individual executable statements.
 * Handles PL/pgSQL DO blocks ($$...$$) that contain inner semicolons.
 * Useful because Prisma's $executeRawUnsafe cannot run multiple statements at once.
 */
export function getAuditTableStatements(): string[] {
  const sql = getAuditTableSQL();
  const statements: string[] = [];
  let current = '';
  let inDollarBlock = false;

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('--')) {
      if (inDollarBlock) current += line + '\n';
      continue;
    }

    current += line + '\n';

    // Track $$ blocks
    const dollarCount = (line.match(/\$\$/g) || []).length;
    if (dollarCount % 2 !== 0) {
      inDollarBlock = !inDollarBlock;
    }

    // Statement ends at ; outside of $$ block
    if (!inDollarBlock && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt.length > 0) statements.push(stmt);
      current = '';
    }
  }

  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

/**
 * Execute the audit table schema SQL using a Prisma client.
 * Runs each statement individually to work with Prisma's prepared statement limit.
 */
export async function applyAuditTableSchema(prisma: any): Promise<void> {
  for (const stmt of getAuditTableStatements()) {
    await prisma.$executeRawUnsafe(stmt);
  }
}
