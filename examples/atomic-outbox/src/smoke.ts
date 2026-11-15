import 'reflect-metadata';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  AuditContext, AuditService, applyAuditTableSchema,
  createOutboxAuditDelivery, defineAuditConfig,
} from '@nestarc/audit-log';
import {
  OutboxEmitter, OutboxModule, OutboxPoller,
  type OutboxPublisher, type OutboxRecord,
} from '@nestarc/outbox';
import { Prisma, PrismaClient } from './generated/prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL to a local PostgreSQL database.');
// The random identifier is generated here, never accepted from HTTP input.
const producerChild = process.argv.includes('--producer-child');
const schema = producerChild
  ? process.env.NESTARC_DEMO_SCHEMA ?? ''
  : `audit_outbox_demo_${randomUUID().replaceAll('-', '')}`;
if (!/^audit_outbox_demo_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid internal demo schema.');
const admin = new Pool({ connectionString });
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema},public` }, { schema }),
});
const tenant = new AsyncLocalStorage<string>();
const attempts = new Map<string, number>();
const receivedIds = new Map<string, string>();

@Injectable()
class DemoPublisher implements OutboxPublisher {
  async publish(record: OutboxRecord): Promise<void> {
    assert.equal(record.eventType, 'nestarc.audit.recorded.v1');
    const payload = record.payload;
    assert.deepEqual(Object.keys(payload).sort(), [
      'action', 'actorId', 'actorType', 'auditId', 'correlationId', 'result',
      'schemaVersion', 'source', 'targetId', 'targetType', 'tenantId',
    ].sort());
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.tenantId, record.tenantId);
    assert.equal(typeof payload.auditId, 'string');
    assert.equal(record.idempotencyKey, payload.auditId);
    assert.equal(record.causationId, payload.auditId);
    assert.ok(record.tenantId === 'tenant-a' || record.tenantId === 'tenant-b');
    const auditId = payload.auditId as string;
    const tenantId = record.tenantId;
    const previousId = receivedIds.get(auditId);
    if (previousId) assert.equal(record.id, previousId, 'redelivery preserves the Outbox event ID');
    receivedIds.set(auditId, record.id);
    attempts.set(auditId, (attempts.get(auditId) ?? 0) + 1);

    // Represents a remote receiver: its commit happens independently of the
    // producer transaction and before its acknowledgement reaches the poller.
    await prisma.$transaction(async tx => {
      const inserted = await tx.$queryRaw<Array<{ audit_id: string }>>`
        INSERT INTO consumer_receipts (tenant_id, audit_id)
        VALUES (${tenantId}, ${auditId})
        ON CONFLICT DO NOTHING RETURNING audit_id
      `;
      if (inserted.length === 0) return;
      await tx.$executeRaw`
        INSERT INTO consumer_totals (tenant_id, handled) VALUES (${tenantId}, 1)
        ON CONFLICT (tenant_id) DO UPDATE SET handled = consumer_totals.handled + 1
      `;
    });
    // The receiver committed, but the producer did not observe its ACK.
    // This deterministic fault makes the actual Outbox poller retry the event.
    if (attempts.get(auditId) === 1) throw new Error('demo: receiver committed; acknowledgement lost');
  }
}

@Module({ imports: [OutboxModule.forRoot({
  prisma,
  delivery: { mode: 'publisher' },
  transport: DemoPublisher,
  // Periodic polling stays enabled as required by Outbox 0.4.1. Explicit
  // poll() calls complete this smoke before the first timer fires.
  polling: { enabled: true, interval: 60_000, batchSize: 2 },
  retry: { maxRetries: 3, backoff: 'fixed', initialDelay: 50 },
})] })
class WorkerModule {}

function createProducer() {
  const emitter = new OutboxEmitter({ prisma });
  const config = defineAuditConfig({
    shared: {
      provider: 'postgresql', tableName: `${schema}.audit_logs`, prismaModule: { Prisma },
      actorRequired: true, tenantRequired: true, tenantResolver: () => tenant.getStore() ?? null,
      sensitiveFields: ['password'], delivery: createOutboxAuditDelivery(emitter),
    },
    module: { actorExtractor: () => ({ id: 'demo-operator', type: 'system' }), strictManualValidation: true },
  });
  return { audit: new AuditService({ ...config.moduleOptions, prisma }), config };
}

async function commitInChild(): Promise<void> {
  const { audit } = createProducer();
  await tenant.run('tenant-b', () => AuditContext.runAs({ id: 'demo-operator', type: 'system' }, () =>
    audit.withManualTransaction(prisma, async ({ tx, log }) => {
      const id = randomUUID();
      await tx.businessWrite.create({ data: { id, tenantId: 'tenant-b', name: 'Committed before process loss' } });
      await log({ action: 'business.created', targetType: 'BusinessWrite', targetId: id });
    }),
  ));
  if (!process.send) throw new Error('Producer child requires the parent IPC channel.');
  process.send({ committed: true });
  // Keep this producer alive until the parent kills it after the commit signal.
  setInterval(() => undefined, 60_000);
}

async function loseProducerAfterCommit(): Promise<void> {
  const child = fork(__filename, ['--producer-child'], {
    env: { ...process.env, NESTARC_DEMO_SCHEMA: schema },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolveCommit, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for producer commit')), 10_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Producer exited before commit signal')); });
      child.once('message', message => {
        clearTimeout(timeout);
        if (message && typeof message === 'object' && 'committed' in message && message.committed === true) {
          resolveCommit();
        } else reject(new Error('Unexpected producer IPC message'));
      });
    });
    assert.ok(child.kill('SIGKILL'), 'terminate only the producer child created by this smoke');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

async function main(): Promise<void> {
  let app: INestApplicationContext | undefined;
  let createdSchema = false;
  let completed = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    await prisma.$connect();
    const sql = [
      readFileSync(resolve('prisma/business.sql'), 'utf8'),
      readFileSync(require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'), 'utf8'),
    ];
    for (const source of sql) {
      for (const statement of source.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
        await prisma.$executeRawUnsafe(statement);
      }
    }
    const { audit, config } = createProducer();
    await applyAuditTableSchema(prisma, config.schemaOptions);
    app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    let poller = app.get(OutboxPoller);

    const write = async (tenantId: string, rollback = false) => tenant.run(tenantId, () =>
      AuditContext.runAs({ id: 'demo-operator', type: 'system', ip: '127.0.0.1' }, () =>
        audit.withManualTransaction(prisma, async ({ tx, log }) => {
          const id = randomUUID();
          await tx.businessWrite.create({ data: { id, tenantId, name: 'Audit + Outbox' } });
          await log({ action: 'business.created', targetType: 'BusinessWrite', targetId: id,
            metadata: { password: 'must-not-leave-the-audit-table', detail: 'private business detail' } });
          // A separate connection cannot see the uncommitted Outbox row.
          await poller.poll();
          assert.equal(attempts.size, 0, 'publisher must not run before producer commit');
          if (rollback) throw new Error('demo rollback');
        }),
      ),
    );

    await assert.rejects(write('tenant-a', true), /demo rollback/);
    assert.equal(await prisma.businessWrite.count(), 0);
    assert.equal((await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM outbox_events`)[0].count, 0n);
    assert.equal((await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM audit_logs`)[0].count, 0n);
    await write('tenant-a');
    await poller.stop();
    await app.close();
    app = undefined;
    // The second producer commits, then dies before any worker delivers its row.
    await loseProducerAfterCommit();
    app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    poller = app.get(OutboxPoller);
    assert.equal(attempts.size, 0);
    const rows = await prisma.$queryRaw<Array<{ id: string; tenant_id: string; payload: { auditId: string } }>>`
      SELECT id, tenant_id, payload FROM outbox_events ORDER BY tenant_id
    `;
    assert.deepEqual(rows.map(row => row.tenant_id), ['tenant-a', 'tenant-b']);
    for (const row of rows) {
      const entry = await audit.getById(row.payload.auditId, { tenantId: row.tenant_id });
      assert.ok(entry);
      assert.equal(entry.tenantId, row.tenant_id);
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await poller.poll();
      const [status] = await prisma.$queryRaw<Array<{ sent: bigint }>>`
        SELECT count(*) AS sent FROM outbox_events WHERE status = 'SENT'
      `;
      if (status.sent === 2n) break;
      await delay(60);
    }
    const states = await prisma.$queryRaw<Array<{ status: string; retry_count: number }>>`
      SELECT status, retry_count FROM outbox_events
    `;
    assert.equal(states.length, 2);
    assert.ok(states.every(row => row.status === 'SENT' && row.retry_count === 1));
    assert.deepEqual([...attempts.values()], [2, 2]);
    const totals = await prisma.$queryRaw<Array<{ tenant_id: string; handled: number }>>`
      SELECT tenant_id, handled FROM consumer_totals ORDER BY tenant_id
    `;
    assert.deepEqual(totals, [{ tenant_id: 'tenant-a', handled: 1 }, { tenant_id: 'tenant-b', handled: 1 }]);
    assert.equal(await prisma.businessWrite.count(), 2);
    console.log(JSON.stringify({ tenants: 2, committedWrites: 2, rollback: 'passed',
      producerLossAfterCommit: 'passed', deliveryAttempts: 4, consumerEffects: 2, deduplication: 'passed' }, null, 2));
    completed = true;
  } finally {
    const cleanupErrors: unknown[] = [];
    const attemptCleanup = async (operation: () => Promise<unknown>): Promise<void> => {
      try { await operation(); } catch (error) { cleanupErrors.push(error); }
    };
    // Each resource is independent: one shutdown failure must not prevent the
    // remaining connections from closing or the owned schema from being removed.
    if (app) {
      const closingApp = app;
      await attemptCleanup(() => closingApp.get(OutboxPoller).stop());
      await attemptCleanup(() => closingApp.close());
    }
    await attemptCleanup(() => prisma.$disconnect());
    if (createdSchema) await attemptCleanup(() => admin.query(`DROP SCHEMA "${schema}" CASCADE`));
    await attemptCleanup(() => admin.end());
    if (cleanupErrors.length > 0) {
      const failure = new AggregateError(cleanupErrors, 'Atomic Outbox example cleanup failed');
      // A failed smoke keeps its original rejection; successful work must still
      // fail verification when cleanup is incomplete.
      if (completed) throw failure;
      console.error(failure);
    }
  }
}
void (producerChild ? commitInChild() : main()).catch(async error => {
  console.error(error);
  process.exitCode = 1;
  if (producerChild) {
    await prisma.$disconnect();
    await admin.end();
    process.disconnect?.();
  }
});
