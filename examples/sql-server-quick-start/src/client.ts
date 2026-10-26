import { PrismaMssql } from '@prisma/adapter-mssql';
import { PrismaClient } from './generated/prisma/client';
import { connectionString } from './audit.config';

export function createClient() {
  return new PrismaClient({
    adapter: new PrismaMssql(connectionString!, { schema: 'dbo' }),
    transactionOptions: { maxWait: 10_000, timeout: 10_000 },
  });
}
