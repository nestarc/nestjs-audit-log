import 'reflect-metadata';
import { applyAuditTableSchema } from '@nestarc/audit-log';
import { auditConfig } from './audit.config';
import { createClient } from './client';

async function main() {
  const base = createClient();
  try {
    await applyAuditTableSchema(base, auditConfig.schemaOptions);
    console.log('SQL Server audit storage ready. Run npm run smoke.');
  } finally { await base.$disconnect(); }
}

void main().catch(error => {
  // Do not print raw driver errors, which can contain a connection string or input values.
  console.error('Audit setup failed.', { name: error?.name, code: error?.code });
  process.exitCode = 1;
});
