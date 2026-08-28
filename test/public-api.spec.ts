import {
  AuditActorMiddleware,
  AUDIT_CSV_COLUMNS_V1,
  AuditInterceptor,
  AuditReason,
  AUDIT_REASON_KEY,
  AuditService,
  ensurePartitions,
  createAuditedClient,
  mergeContextMetadata,
  AuditStreamRunner,
  HttpAuditStreamSink,
  PostgresAuditStreamStore,
} from '../src';
import type {
  AuditCapabilities,
  AuditCapabilityMethods,
  AuditDatabaseMapping,
  AuditCsvOptions,
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
  AuditScanOptions,
  AuditScanPage,
  EnsurePartitionsOptions,
  AuditStreamCheckpointStore,
  AuditStreamSink,
} from '../src';
import type {
  AuditInsertInput,
  AuditInsertParams,
} from '../src/prisma/audit-extension';
import { AuditService as DeepAuditService } from '../src/services/audit.service';

describe('public API exports', () => {
  it('preserves the AuditService facade identity, constructor, and methods', () => {
    expect(AuditService).toBe(DeepAuditService);
    expect(AuditService.length).toBe(1);
    expect(Object.getOwnPropertyNames(AuditService.prototype)).toEqual(
      expect.arrayContaining([
        'log',
        'query',
        'getById',
        'scan',
        'exportCsv',
        'prune',
      ]),
    );
  });

  it('preserves audit extension deep-import helper types', () => {
    const input: AuditInsertInput = {
      action: 'User.created',
      targetType: 'User',
      targetId: 'user-1',
      changes: { name: { after: 'Alice' } },
    };
    const params: AuditInsertParams = {
      tenantId: null,
      actorId: null,
      actorType: 'system',
      actorIp: null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      source: 'auto',
      changes: input.changes,
      result: 'success',
    };

    expect(params.targetId).toBe('user-1');
  });

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
    const prune: (
      options: AuditPruneOptions,
    ) => Promise<AuditPruneResult> = AuditService.prototype.prune;

    expect(ddlOptions.tableName).toBe('audit_logs');
    expect(partitionOptions.ahead).toBe(1);
    expect(pruneOptions.dryRun).toBe(true);
    expect(pruneResult.mode).toBe('delete');
    expect(prune.length).toBe(1);
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

  it('exports tenant-scoped scan and versioned CSV types', () => {
    const scan: AuditScanOptions = { tenantId: 'tenant-1', batchSize: 100 };
    const csv: AuditCsvOptions = { allTenants: true, columns: 'v1' };
    const page: AuditScanPage = {
      entries: [],
      checkpoint: null,
      highWatermark: 'checkpoint',
    };
    expect(scan.tenantId).toBe('tenant-1');
    expect(csv.columns).toBe('v1');
    expect(page.entries).toEqual([]);
    expect(AUDIT_CSV_COLUMNS_V1[0]).toBe('schemaVersion');
  });

  it('exports durable stream core, sink, and store APIs', () => {
    const checkpointStore: AuditStreamCheckpointStore = {
      load: async () => null,
      save: async () => undefined,
    };
    const sink: AuditStreamSink = { deliver: async () => undefined };
    expect(checkpointStore).toBeDefined();
    expect(sink).toBeDefined();
    expect(typeof AuditStreamRunner).toBe('function');
    expect(typeof HttpAuditStreamSink).toBe('function');
    expect(typeof PostgresAuditStreamStore).toBe('function');
  });

  it('excludes the removed experimental transaction option from the public type', () => {
    type ExperimentalTxAuditIsRemoved =
      'experimentalTxAudit' extends keyof AuditExtensionOptions ? false : true;
    const isRemoved: ExperimentalTxAuditIsRemoved = true;

    expect(isRemoved).toBe(true);
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
    const capabilities: AuditCapabilities = audited.getAuditCapabilities();
    const capabilityMethods: AuditCapabilityMethods = audited;

    expect(id).toBe('u1');
    expect(capabilityMethods.getAuditCapabilities()).toBe(capabilities);
    expect(capabilities).toEqual({
      consistency: 'atomic-required',
      atomicLifecycle: true,
    });
  });
});
