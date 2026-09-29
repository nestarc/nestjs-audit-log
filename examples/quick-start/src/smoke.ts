import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AuditContext, AuditService } from '@nestarc/audit-log';
import type { AuditQueryResult } from '@nestarc/audit-log';
import { AppModule } from './app.module';
import { PrismaService } from './prisma.service';
import { tenantScope } from './audit-options';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const response = await fetch(`${url}/users`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'demo-request' },
      body: JSON.stringify({ name: 'Alice', email: `${randomUUID()}@example.com`, password: 'secret' }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 201, responseText);
    const created = JSON.parse(responseText) as { id: string; password?: string };
    assert.ok(created.id);
    assert.equal(created.password, undefined);
    const review = await fetch(`${url}/users/${created.id}/review`, { method: 'POST' });
    assert.equal(review.status, 201);
    const roleResponse = await fetch(`${url}/users/${created.id}/role`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(roleResponse.status, 201);
    const history = await fetch(`${url}/users/${created.id}/audit`);
    assert.equal(history.status, 200);
    const { entries } = await history.json() as AuditQueryResult;
    const automatic = entries.find(entry => entry.action === 'User.created');
    const manual = entries.find(entry => entry.action === 'user.reviewed');
    const roleChange = entries.find(entry => entry.action === 'User.updated');
    assert.ok(roleChange);
    assert.equal(roleChange.actorId, 'demo-user');
    assert.equal(roleChange.tenantId, 'demo-tenant');
    assert.equal(roleChange.targetId, created.id);
    assert.deepEqual(roleChange.changes?.role, { before: 'member', after: 'admin' });
    assert.ok(automatic);
    assert.equal(automatic.source, 'auto');
    assert.equal(automatic.actorId, 'demo-user');
    assert.equal(automatic.tenantId, 'demo-tenant');
    assert.equal(automatic.changes?.password.after, '[REDACTED]');
    assert.equal(automatic.metadata?.correlationId, 'demo-request');
    assert.ok(manual);
    assert.equal(manual.source, 'manual');
    assert.equal(manual.actorId, 'demo-user');
    assert.equal(manual.tenantId, 'demo-tenant');
    assert.equal(manual.metadata?.reason, 'Profile reviewed');

    const audit = app.get(AuditService);
    const filtered = await audit.query({ tenantId: 'demo-tenant', action: 'User.*', source: 'auto', targetId: created.id });
    assert.equal(filtered.entries.length, 2);
    await tenantScope.run({ tenantId: 'demo-tenant' }, () =>
      AuditContext.runAs({ id: 'worker-demo', type: 'system' }, () =>
        audit.log({ action: 'user.exported', targetType: 'User', targetId: created.id })),
    );
    const background = await audit.query({ tenantId: 'demo-tenant', action: 'user.exported', targetId: created.id });
    assert.equal(background.entries.length, 1);
    assert.equal(background.entries[0].actorId, 'worker-demo');
    assert.equal(background.entries[0].tenantId, 'demo-tenant');

    const prisma = app.get(PrismaService);
    const rolledBackEmail = `${randomUUID()}@example.com`;
    let rolledBackId: string | undefined;
    await tenantScope.run({ tenantId: 'demo-tenant' }, () =>
      AuditContext.runAs({ id: 'rollback-worker', type: 'system' }, () =>
        assert.rejects(prisma.client.withAuditTransaction(async tx => {
          const pending = await tx.user.create({ data: { name: 'Rollback', email: rolledBackEmail, password: 'secret' } });
          rolledBackId = pending.id;
          throw new Error('rollback probe');
        }), /rollback probe/),
      ),
    );
    assert.ok(rolledBackId);
    assert.equal(await prisma.base.user.count({ where: { email: rolledBackEmail } }), 0);
    const rolledBackAudit = await audit.query({ tenantId: 'demo-tenant', targetType: 'User', targetId: rolledBackId });
    assert.equal(rolledBackAudit.entries.length, 0);
    console.log(JSON.stringify({ action: automatic.action, targetType: automatic.targetType, source: automatic.source,
      actorId: automatic.actorId, tenantId: automatic.tenantId, password: automatic.changes?.password,
      role: roleChange.changes?.role, manualAction: manual.action, backgroundActor: background.entries[0].actorId, rollback: 'passed' }, null, 2));
  } finally { await app.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
