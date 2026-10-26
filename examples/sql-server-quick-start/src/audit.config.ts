import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { defineAuditConfig } from '@nestarc/audit-log';
import { Prisma } from './generated/prisma/client';

export const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL in .env before running the example.');

export const tenantScope = new AsyncLocalStorage<{ tenantId: string }>();
export const auditConfig = defineAuditConfig({
  shared: {
    provider: 'sqlserver',
    tableName: 'dbo.audit_demo_logs',
    prismaModule: { Prisma },
    actorRequired: true,
    tenantRequired: true,
    tenantResolver: () => tenantScope.getStore()?.tenantId ?? null,
    sensitiveFields: ['password', 'token'],
  },
  module: {
    // The command-line smoke supplies its actor explicitly through AuditContext.runAs().
    actorExtractor: () => ({ id: null, type: 'system' }),
  },
});
