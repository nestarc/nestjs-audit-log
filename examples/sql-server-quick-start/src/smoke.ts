import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditContext, AuditLogModule, AuditService } from '@nestarc/audit-log';
import { auditConfig, tenantScope } from './audit.config';
import { createClient } from './client';
import { readInvoiceHistory, type DemoPrincipal } from './history';

const base = createClient();
@Module({ imports: [AuditLogModule.forRoot({ ...auditConfig.moduleOptions, prisma: base })] })
class DemoModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(DemoModule, { logger: false });
  try {
    const audit = app.get(AuditService);
    const tenantId = `demo-${randomUUID()}`;
    const invoiceId = randomUUID();
    const principal: DemoPrincipal = {
      id: 'demo-operator', tenantIds: [tenantId], permissions: ['audit:read'],
    };
    await tenantScope.run({ tenantId }, () =>
      AuditContext.runAs({ id: principal.id, type: 'user' }, async () => {
        await base.$transaction(async tx => {
          await tx.invoice.create({ data: { id: invoiceId, tenantId, status: 'approved' } });
          await audit.log({
            action: 'invoice.approved', targetType: 'Invoice', targetId: invoiceId,
            metadata: { reason: '승인 확인 ✓', password: 'must-not-be-stored' },
          }, tx);
        });
        const history = await readInvoiceHistory(base, principal, tenantId, invoiceId);
        assert.equal(history.length, 1);
        const entry = history[0];
        assert.equal(entry.actorId, principal.id);
        assert.equal(entry.tenantId, tenantId);
        assert.equal(entry.targetId, invoiceId);
        assert.equal(entry.action, 'invoice.approved');
        assert.equal(entry.source, 'manual');
        assert.deepEqual(JSON.parse(entry.metadata!), {
          reason: '승인 확인 ✓', password: '[REDACTED]',
        });
        assert.equal((await base.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status, 'approved');

        const rolledBackId = randomUUID();
        await assert.rejects(base.$transaction(async tx => {
          await tx.invoice.create({ data: { id: rolledBackId, tenantId, status: 'approved' } });
          await audit.log({ action: 'invoice.approved', targetType: 'Invoice', targetId: rolledBackId }, tx);
          throw new Error('DEMO_ROLLBACK');
        }), /DEMO_ROLLBACK/);
        assert.equal(await base.invoice.count({ where: { id: rolledBackId } }), 0);
        assert.equal((await readInvoiceHistory(base, principal, tenantId, rolledBackId)).length, 0);

        const missingActorId = randomUUID();
        await AuditContext.runAs({ id: null, type: 'user' }, async () => {
          await assert.rejects(base.$transaction(async tx => {
            await tx.invoice.create({ data: { id: missingActorId, tenantId, status: 'approved' } });
            await audit.log({ action: 'invoice.approved', targetType: 'Invoice', targetId: missingActorId }, tx);
          }), /actor/i);
        });
        assert.equal(await base.invoice.count({ where: { id: missingActorId } }), 0);
        assert.equal((await readInvoiceHistory(base, principal, tenantId, missingActorId)).length, 0);

        await assert.rejects(readInvoiceHistory(base, principal, 'another-tenant', invoiceId), /AUDIT_READ_FORBIDDEN/);
        await assert.rejects(readInvoiceHistory(base, { ...principal, permissions: [] }, tenantId, invoiceId), /AUDIT_READ_FORBIDDEN/);
        const otherTenantPrincipal = { ...principal, tenantIds: ['another-tenant'] };
        assert.equal((await readInvoiceHistory(base, otherTenantPrincipal, 'another-tenant', invoiceId)).length, 0);
      }),
    );

    const missingTenantId = randomUUID();
    await AuditContext.runAs({ id: principal.id, type: 'user' }, async () => {
      await assert.rejects(base.$transaction(async tx => {
        await tx.invoice.create({ data: { id: missingTenantId, tenantId, status: 'approved' } });
        await audit.log({ action: 'invoice.approved', targetType: 'Invoice', targetId: missingTenantId }, tx);
      }), /tenant context required/i);
    });
    assert.equal(await base.invoice.count({ where: { id: missingTenantId } }), 0);
    assert.equal((await readInvoiceHistory(base, principal, tenantId, missingTenantId)).length, 0);
    console.log(JSON.stringify({
      mode: 'sqlserver-manual', action: 'invoice.approved', actor: principal.id,
      commit: 'passed', rollback: 'passed', actorPolicy: 'passed', tenantPolicy: 'passed',
      redaction: 'passed', unicode: 'passed', authorizedHistory: 'passed',
    }, null, 2));
  } finally {
    await app.close();
    await base.$disconnect();
  }
}

void main().catch(error => {
  console.error('SQL Server smoke failed.', { name: error?.name, code: error?.code });
  process.exitCode = 1;
});
