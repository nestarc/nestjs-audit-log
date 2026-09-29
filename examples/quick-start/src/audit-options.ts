import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from './generated/prisma/client';

export const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL before starting the example.');
export const databaseSchema = new URL(connectionString).searchParams.get('schema') ?? 'public';
export const tenantScope = new AsyncLocalStorage<{ tenantId: string }>();
export const prismaModule = { Prisma };
// 0.6.0: pass these options independently to the module and extension.
export const sharedAuditOptions = {
  prismaModule,
  tableName: `${databaseSchema}.audit_logs`,
  tenantRequired: true,
  tenantResolver: () => tenantScope.getStore()?.tenantId ?? null,
  sensitiveFields: ['password'],
};
