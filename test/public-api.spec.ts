import {
  AuditActorMiddleware,
  AuditInterceptor,
  AuditReason,
  AUDIT_REASON_KEY,
  ensurePartitions,
  createAuditedClient,
  mergeContextMetadata,
} from '../src';
import type {
  AuditDatabaseMapping,
  AuditGetByIdOptions,
  AuditExtensionOptions,
  AuditErrorContext,
  AuditErrorPhase,
  AuditLogger,
  AuditSharedOptions,
  AuditPruneOptions,
  AuditPruneResult,
  AuditTableSQLOptions,
  AuditQueryResult,
  EnsurePartitionsOptions,
} from '../src';

describe('public API exports', () => {
  it('exports shared audit option types', () => {
    const databaseMapping: AuditDatabaseMapping = {
      tableName: 'users',
      schema: 'public',
      primaryKeyColumn: 'id',
    };
    const phase: AuditErrorPhase = 'insert';
    const ctx: AuditErrorContext = { phase, model: 'User' };
    const logger: AuditLogger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    expect(databaseMapping.tableName).toBe('users');
    const options: AuditSharedOptions = {
      tableName: 'audit_logs',
      tenantRequired: true,
      tenantResolver: () => 'tenant-1',
      onAuditError: (_error, errorContext) => logger.warn(errorContext.phase),
      logger,
    };

    expect(ctx.phase).toBe('insert');
    expect(options.tenantResolver?.()).toBe('tenant-1');
  });

  it('exports storage and retention option types', () => {
    const ddlOptions: AuditTableSQLOptions = {
      tableName: 'audit_logs',
      partitioned: true,
      enforcement: 'trigger',
      ginIndex: true,
    };
    const partitionOptions: EnsurePartitionsOptions = { ahead: 1 };
    const pruneOptions: AuditPruneOptions = {
      olderThan: new Date('2026-01-01T00:00:00.000Z'),
      dryRun: true,
    };
    const pruneResult: AuditPruneResult = {
      layout: 'flat',
      mode: 'delete',
      prunedPartitions: [],
      deletedRows: 0,
      dryRun: true,
    };

    expect(ddlOptions.tableName).toBe('audit_logs');
    expect(partitionOptions.ahead).toBe(1);
    expect(pruneOptions.dryRun).toBe(true);
    expect(pruneResult.mode).toBe('delete');
    expect(typeof ensurePartitions).toBe('function');
  });

  it('exports actor context and manual binding APIs', () => {
    expect(AUDIT_REASON_KEY).toBe('AUDIT_REASON');
    expect(typeof AuditReason).toBe('function');
    expect(typeof AuditInterceptor).toBe('function');
    expect(typeof AuditActorMiddleware).toBe('function');
    expect(mergeContextMetadata()).toBeUndefined();
  });

  it('exports query v2 types', () => {
    const getByIdOptions: AuditGetByIdOptions = {
      tenantId: 'tenant-1',
    };
    const queryResult: AuditQueryResult = {
      entries: [],
      hasMore: false,
      nextCursor: null,
    };

    expect(getByIdOptions.tenantId).toBe('tenant-1');
    expect(queryResult.nextCursor).toBeNull();
  });

  it('exports experimental transaction audit option type', () => {
    const options: AuditExtensionOptions = {
      consistency: 'best-effort',
      experimentalTxAudit: true,
    };

    expect(options.experimentalTxAudit).toBe(true);
  });

  it('preserves transaction callback and result types for createAuditedClient', async () => {
    type TransactionClient = {
      user: { findUnique(): Promise<{ id: string } | null> };
    };
    const tx: TransactionClient = {
      user: { findUnique: async () => ({ id: 'u1' }) },
    };
    const base = {
      $extends(extension: any): any {
        if (typeof extension === 'function') return extension(this);
        return Object.assign(Object.create(this), extension.client);
      },
      async $transaction<TResult>(
        callback: (transaction: TransactionClient) => Promise<TResult>,
      ): Promise<TResult> {
        return callback(tx);
      },
    };
    const prismaModule = {
      Prisma: { defineExtension: (factory: any) => factory },
    };
    const audited = createAuditedClient(base, {
      consistency: 'atomic-required',
      trackedModels: ['User'],
      prismaModule,
    });

    const id: string | undefined = await audited.withAuditTransaction(
      async (transaction) => (await transaction.user.findUnique())?.id,
    );

    expect(id).toBe('u1');
  });
});
