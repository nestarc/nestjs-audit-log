// Public 0.8.0 contracts: run against the candidate, then the registry artifact after publication.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  applyAuditTableSchema, AuditContext, AuditInputError, AuditLogModule, AuditService,
  defineAuditConfig,
} from '@nestarc/audit-log';
import type { AuditErrorContext, AuditOperationEvent } from '@nestarc/audit-log';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { connectionString, databaseSchema } from '../src/audit-options';

const url = new URL(connectionString!);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/audit_test');
assert.match(databaseSchema, /^audit_docs_[a-f0-9]{32}$/);
const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema: databaseSchema }) });
const tenantScope = new AsyncLocalStorage<string>();
const operations: AuditOperationEvent[] = [];
const failures: AuditErrorContext[] = [];
const config = defineAuditConfig({
  shared: {
    prismaModule: { Prisma }, tableName: `${databaseSchema}.product_quality_events`,
    actorRequired: true, tenantRequired: true,
    tenantResolver: () => tenantScope.getStore() ?? null,
    sensitiveFields: ['password'], logger: { warn() {}, error() {} },
    onAuditError: (_error, context) => { failures.push(context); },
  },
  module: {
    actorExtractor: () => ({ id: null, type: 'system' }),
    strictManualValidation: true,
    maxMetadataBytes: 4096,
    onAuditOperation: async event => {
      operations.push(event);
      // Observability failure must not change a transaction's result or rejection.
      throw new Error('PRODUCT_QUALITY_OBSERVER_FAILURE');
    },
  },
});

@Module({ imports: [AuditLogModule.forRoot({ ...config.moduleOptions, prisma: base })] })
class ProductQualityModule {}

const userData = () => ({
  id: randomUUID(), name: 'Product quality', email: `${randomUUID()}@example.com`,
  password: 'private-password', tenantId: 'quality-tenant',
});

// Compiled against generated Prisma types from the installed public declarations; never executed.
function checkGeneratedClientInference(audit: AuditService) {
  const inferred = audit.withManualTransaction(base, async ({ tx, log }) => {
    // @ts-expect-error Generated UserCreateInput rejects unknown model input fields.
    await tx.user.create({ data: { unknownField: 'invalid' } });
    const selected = await tx.user.create({ data: userData(), select: { id: true } });
    // @ts-expect-error A selected generated model result does not contain email.
    const unavailable: string = selected.email;
    void unavailable;
    await log({ action: 'user.created', targetType: 'User', targetId: selected.id });
    return selected.id;
  });
  const expected: Promise<string> = inferred;
  // @ts-expect-error Callback result must remain string, not any or number.
  const wrongResult: Promise<number> = inferred;
  void wrongResult;
  return expected;
}
void checkGeneratedClientInference;

function scope<T>(operation: () => T): T {
  return tenantScope.run('quality-tenant', () =>
    AuditContext.runAs({ id: 'quality-worker', type: 'system' }, operation),
  );
}

async function main() {
  const app = await NestFactory.createApplicationContext(ProductQualityModule, { logger: false });
  try {
    await applyAuditTableSchema(base, config.schemaOptions);
    const audit = app.get(AuditService);
    assert.deepEqual(audit.getCapabilities(), {
      provider: 'postgresql', manualLogging: true, manualTransactions: true,
      automaticTracking: true, query: true, scan: true, exportCsv: true,
      retention: true, schemaInspection: false, readIndexes: false,
    });
    assert.ok(Object.isFrozen(audit.getCapabilities()));

    const committed = await scope(() => audit.withManualTransaction(base, async ({ tx, log }) => {
      const user = await tx.user.create({ data: userData(), select: { id: true, role: true } });
      await log({
        action: 'quality.user.created', targetType: 'User', targetId: user.id,
        metadata: { password: 'private-password', reason: 'verified commit' },
      });
      return user;
    }));
    const committedId: string = committed.id;
    const committedRole: string = committed.role;
    assert.equal(committedRole, 'member');
    assert.equal(await base.user.count({ where: { id: committedId } }), 1);
    const history = await audit.query({ tenantId: 'quality-tenant', targetId: committedId, includeTotal: false });
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].actorId, 'quality-worker');
    assert.equal(history.entries[0].tenantId, 'quality-tenant');
    assert.deepEqual(history.entries[0].metadata, { password: '[REDACTED]', reason: 'verified commit' });

    const rolledBack = userData();
    let caught: unknown;
    await assert.rejects(scope(() => audit.withManualTransaction(base, async ({ tx, log }) => {
      await tx.user.create({ data: rolledBack });
      await log({ action: 'quality.before.failure', targetType: 'User', targetId: rolledBack.id });
      try { await log({ action: '   ', targetType: 'User', targetId: rolledBack.id }); }
      catch (error) { caught = error; }
      // A fulfilled callback must still roll back because its audit writer failed.
      return rolledBack.id;
    })), error => error === caught && error instanceof AuditInputError && error.code === 'AUDIT_INPUT_INVALID');
    assert.equal(await base.user.count({ where: { id: rolledBack.id } }), 0);
    assert.equal((await audit.query({ tenantId: 'quality-tenant', targetId: rolledBack.id })).entries.length, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'AUDIT_INPUT_INVALID');
    assert.equal(failures[0].provider, 'postgresql');
    assert.equal(failures[0].phase, 'validation');

    const logs = operations.filter(event => event.operation === 'log');
    const transactions = operations.filter(event => event.operation === 'transaction');
    assert.deepEqual(logs.map(event => event.status), ['success', 'success', 'failure']);
    assert.deepEqual(transactions.map(event => event.status), ['success', 'failure']);
    assert.ok(transactions.every(event => event.transaction === 'managed'));
    assert.ok(logs.every(event => event.transaction === 'external'));
    assert.equal(transactions[1].code, 'AUDIT_TRANSACTION_FAILED');
    const allowedKeys = new Set(['provider', 'operation', 'status', 'durationMs', 'transaction', 'phase', 'code']);
    for (const event of operations) {
      assert.ok(Object.isFrozen(event));
      assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
      assert.ok(Object.keys(event).every(key => allowedKeys.has(key)));
    }
    for (const privateValue of ['quality-worker', 'quality-tenant', committedId, rolledBack.id, 'private-password']) {
      assert.ok(!JSON.stringify(operations).includes(privateValue));
    }
    console.log(JSON.stringify({
      mode: 'product-quality-0.8.0', result: 'passed',
      scenarios: ['generated-prisma-types', 'managed-commit', 'caught-validation-rollback',
        'observer-isolation-and-privacy', 'provider-capabilities'],
    }));
  } finally {
    await app.close();
    await base.$disconnect();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
