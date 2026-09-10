import 'reflect-metadata';
import { applyAuditTableSchema } from '@nestarc/audit-log';
import { PrismaService, sharedAuditOptions } from './prisma.service';

async function main() {
  const prisma = new PrismaService();
  try {
    await applyAuditTableSchema(prisma.base, { tableName: sharedAuditOptions.tableName });
    console.log('Audit storage ready.');
  } finally { await prisma.onModuleDestroy(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
