import 'dotenv/config';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAuditedClient } from '@nestarc/audit-log';
import { PrismaClient } from './generated/prisma/client';

import { connectionString, databaseSchema, auditConfig } from './audit-options';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, { schema: databaseSchema }),
  });
  readonly client = createAuditedClient(this.base, auditConfig.extensionOptions);

  async onModuleInit() { await this.base.$connect(); }
  async onModuleDestroy() { await this.base.$disconnect(); }
}
