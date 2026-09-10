import 'dotenv/config';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuditedClient } from '@nestarc/audit-log';
import { Prisma, PrismaClient } from './generated/prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL before starting the example.');
export const databaseSchema = new URL(connectionString).searchParams.get('schema') ?? 'public';
export const prismaModule = { Prisma };
export const sharedAuditOptions = {
  prismaModule,
  tableName: `${databaseSchema}.audit_logs`,
  tenantRequired: true,
  tenantResolver: () => 'demo-tenant',
  sensitiveFields: ['password'],
};

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, { schema: databaseSchema }),
  });
  readonly client = createAuditedClient(this.base, {
    ...sharedAuditOptions,
    consistency: 'atomic-required',
    trackedModels: ['User'],
    databaseMapping: { User: { tableName: 'users', schema: databaseSchema } },
  });

  async onModuleInit() { await this.base.$connect(); }
  async onModuleDestroy() { await this.base.$disconnect(); }
}
