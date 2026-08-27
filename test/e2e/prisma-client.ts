import type { PrismaModuleLike } from '../../src/prisma/prisma-namespace';

export interface PrismaClient {
  [key: string]: any;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $extends(extension: any): any;
  $executeRaw<T = number>(
    query: TemplateStringsArray | unknown,
    ...values: any[]
  ): Promise<T>;
  $executeRawUnsafe<T = number>(query: string, ...values: any[]): Promise<T>;
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | unknown,
    ...values: any[]
  ): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $transaction<R>(
    callback: (tx: any) => Promise<R>,
    options?: Record<string, unknown>,
  ): Promise<R>;
  $transaction<R>(queries: readonly unknown[], options?: Record<string, unknown>): Promise<R[]>;
}

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/audit_test';

const generatedModule: PrismaModuleLike & { PrismaClient: new (options: any) => any } =
  process.env.PRISMA_TEST_CLIENT === 'legacy'
    ? require('@prisma/client')
    : require('./generated/prisma/client');

export const Prisma: any = generatedModule.Prisma;
export const prismaModule: PrismaModuleLike = generatedModule;

export function createTestPrismaClient(
  options: Record<string, unknown> = {},
): PrismaClient {
  if (process.env.PRISMA_TEST_CLIENT === 'legacy') {
    return new generatedModule.PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
      ...options,
    }) as PrismaClient;
  }

  const { PrismaPg } = require('@prisma/adapter-pg');
  return new generatedModule.PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    ...options,
  }) as PrismaClient;
}
