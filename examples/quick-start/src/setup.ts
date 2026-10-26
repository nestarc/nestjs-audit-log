import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { applyAuditTableSchema } from '@nestarc/audit-log';
import { PrismaClient } from './generated/prisma/client';
import { connectionString, databaseSchema, auditConfig } from './audit-options';

async function main() {
  const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema: databaseSchema }) });
  try {
    await applyAuditTableSchema(base, auditConfig.schemaOptions);
    console.log('Audit storage ready.');
  } finally { await base.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
