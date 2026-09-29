import 'dotenv/config';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuditedClient } from '@nestarc/audit-log';
import { PrismaClient } from './generated/prisma/client';

import { connectionString, databaseSchema, sharedAuditOptions } from './audit-options';

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
