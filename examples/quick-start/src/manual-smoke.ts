import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuditContext, AuditLogModule, AuditService } from '@nestarc/audit-log';
import { PrismaClient } from './generated/prisma/client';
import { connectionString, databaseSchema, auditConfig, tenantScope } from './audit-options';
import { changeRoleWithEvent } from './manual-role';

// This module creates no automatic extension or audited client.
const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema: databaseSchema }) });
@Module({ imports: [AuditLogModule.forRoot({
  ...auditConfig.moduleOptions, prisma: base,
})] })
class ManualModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(ManualModule, { logger: false });
  try {
    const audit = app.get(AuditService);
    await tenantScope.run({ tenantId: 'demo-tenant' }, () =>
      AuditContext.runAs({ id: 'demo-operator', type: 'user' }, async () => {
        const user = await base.user.create({ data: {
          name: 'Manual', email: `${randomUUID()}@example.com`, password: 'secret', tenantId: 'demo-tenant',
        } });
        // Illustrates manual metadata masking, including inherited context metadata.
        AuditContext.setMetadata({ password: 'secret' });
        await base.$transaction(tx => changeRoleWithEvent(tx, audit, 'demo-tenant', user.id, 'admin'));
        const page = await audit.query({ tenantId: 'demo-tenant', targetType: 'User', targetId: user.id });
        assert.equal(page.entries.length, 1); // No automatic create/update records.
        const entry = page.entries[0];
        assert.equal(entry.action, 'user.role.changed');
        assert.equal(entry.source, 'manual');
        assert.equal(entry.actorId, 'demo-operator');
        assert.equal(entry.tenantId, 'demo-tenant');
        assert.equal(entry.targetId, user.id);
        assert.deepEqual(entry.metadata?.role, { before: 'member', after: 'admin' });
        assert.equal(entry.metadata?.password, '[REDACTED]');
        assert.equal(entry.changes, null); // Manual before/after is application-supplied metadata.
        await assert.rejects(base.$transaction(async tx => {
          await changeRoleWithEvent(tx, audit, 'demo-tenant', user.id, 'member');
          throw new Error('manual rollback probe');
        }), /manual rollback probe/);
        assert.equal((await base.user.findUniqueOrThrow({ where: { id: user.id } })).role, 'admin');
        assert.equal((await audit.query({ tenantId: 'demo-tenant', targetId: user.id })).entries.length, 1);
        console.log(JSON.stringify({ mode: 'manual-only', action: entry.action, actorId: entry.actorId,
          tenantId: entry.tenantId, role: entry.metadata?.role, password: entry.metadata?.password,
          rollback: 'passed' }, null, 2));
      }),
    );
  } finally {
    await app.close();
    await base.$disconnect();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
