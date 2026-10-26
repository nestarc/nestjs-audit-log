import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { AUDIT_LOG_OPTIONS } from '../audit-log.constants';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import {
  AuditEntry,
  AuditCsvOptions,
  AuditGetByIdOptions,
  AuditQueryOptions,
  AuditQueryResult,
  AuditScanOptions,
  AuditScanPage,
  ManualAuditLogInput,
} from '../interfaces/audit-entry.interface';
import { AuditContext, mergeContextMetadata } from './audit-context';
import { resolveTenantId } from '../utils/tenant';
import { snapshotAuditActor } from '../utils/actor';
import { invokeAuditObserver, reportAuditError } from '../prisma/audit-extension/audit-errors';
import type { AuditErrorCode, AuditErrorPhase, AuditOperationEvent } from '../interfaces/audit-shared-options.interface';
import {
  AuditInputError, enforceManualMetadataSize, validateManualAuditInput,
  validateManualAuditOptions, validateManualIdentity, validateManualMetadata,
} from './manual-audit-validation';
import {
  runManualAuditTransaction,
  type ManualAuditTransactionClient, type ManualAuditTransactionHost,
  type ManualAuditTransactionOptions, type ManualAuditTransactionScope,
} from './manual-audit-transaction';
import { resolvePrismaNamespace } from '../prisma/prisma-namespace';
import { getSensitiveFieldsFor, redactObject } from '../prisma/diff';
import { getSqlServerTableName, validateAuditTableName } from '../sql/table-name';
import { AuditDatabaseProvider, resolveAuditProvider } from '../sql/provider';
import { AuditMaintenanceService } from './audit-maintenance.service';
import { AuditQueryService } from './audit-query.service';
import { AuditScanService } from './audit-scan.service';

export interface AuditPruneOptions {
  olderThan: Date;
  mode?: 'drop' | 'detach';
  dryRun?: boolean;
  client?: any;
  timeoutMs?: number;
  maxWaitMs?: number;
  /**
   * Last ACKed checkpoints for every required stream. Pruning is rejected when
   * it would pass any checkpoint and remove entries that stream has not ACKed.
   */
  requiredCheckpoints?: readonly string[];
}

export interface AuditPruneResult {
  layout: 'flat' | 'partitioned';
  mode: 'drop' | 'detach' | 'delete';
  prunedPartitions: string[];
  deletedRows: number | null;
  dryRun: boolean;
}

export interface AuditServiceCapabilities {
  readonly provider: AuditDatabaseProvider;
  readonly manualLogging: true;
  readonly manualTransactions: true;
  readonly automaticTracking: boolean;
  readonly query: true;
  readonly scan: boolean;
  readonly exportCsv: boolean;
  readonly retention: boolean;
  readonly schemaInspection: boolean;
  readonly readIndexes: boolean;
}

const manualErrorCodes: Partial<Record<AuditErrorPhase, AuditErrorCode>> = {
  validation: 'AUDIT_INPUT_INVALID', context: 'AUDIT_CONTEXT_INVALID',
  'tenant-resolution': 'AUDIT_TENANT_INVALID', serialization: 'AUDIT_SERIALIZATION_FAILED',
  insert: 'AUDIT_INSERT_FAILED',
};

/** Diagnostics must not evaluate failed DTO accessors or replace the real error. */
function manualErrorDetails(input: unknown): { model?: string; action?: string; targetId?: string } {
  const details: { model?: string; action?: string; targetId?: string } = {};
  if (input === null || typeof input !== 'object') return details;
  for (const [field, key] of [['targetType', 'model'], ['action', 'action'], ['targetId', 'targetId']] as const) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
        details[key] = descriptor.value;
      }
    } catch {
      // Proxies can reject descriptor inspection too; omit unavailable context.
    }
  }
  return details;
}

@Injectable()
export class AuditService {
  private readonly provider: AuditDatabaseProvider;
  private readonly Prisma: ReturnType<typeof resolvePrismaNamespace>;
  private readonly tableName: string;
  private readonly tableRef: unknown | null;
  private readonly maintenanceService: AuditMaintenanceService;
  private readonly queryService: AuditQueryService;
  private readonly scanService: AuditScanService;

  constructor(
    @Inject(AUDIT_LOG_OPTIONS)
    private readonly options: AuditLogModuleOptions,
  ) {
    validateManualAuditOptions(options);
    this.provider = resolveAuditProvider(options.provider);
    this.Prisma = resolvePrismaNamespace({
      prismaModule: options.prismaModule,
    });
    this.tableName = validateAuditTableName(options.tableName);
    this.tableRef = this.provider === 'sqlserver'
      ? this.Prisma.raw!(getSqlServerTableName(options.tableName).quoted)
      : this.tableName === 'audit_logs' ? null : this.Prisma.raw!(this.tableName);
    this.queryService = new AuditQueryService(
      options,
      this.Prisma,
      this.tableRef,
    );
    this.scanService = new AuditScanService(
      options,
      this.Prisma,
      this.tableRef,
    );
    this.maintenanceService = new AuditMaintenanceService(
      options,
      this.Prisma,
      this.tableName,
      this.tableRef,
    );
  }

  async log(input: ManualAuditLogInput, tx?: any): Promise<void> {
    const observe = Boolean(this.options.onAuditOperation);
    const started = observe || this.options.onAuditError ? performance.now() : undefined;
    const stage: { phase: AuditErrorPhase } = { phase: 'validation' };
    let code: AuditErrorCode | undefined;
    let status: 'success' | 'failure' = 'success';
    try {
      await this.writeManualLog(input, tx, value => { stage.phase = value; });
    } catch (error) {
      const phase = stage.phase;
      status = 'failure';
      code = error instanceof AuditInputError ? error.code : manualErrorCodes[phase];
      // Preserve manual INSERT rejection identity and legacy logging defaults.
      // All rejected stages reach an explicitly configured observer exactly once.
      if (this.options.onAuditError || phase === 'context') {
        reportAuditError({ ...this.options, consistency: 'best-effort' }, error, {
          phase, code, provider: this.provider,
          ...(started === undefined ? {} : { durationMs: performance.now() - started }),
          ...manualErrorDetails(input), operation: 'log',
        });
      }
      throw error;
    } finally {
      if (observe) {
        this.observeOperation({
          provider: this.provider, operation: 'log', status,
          durationMs: performance.now() - started!,
          transaction: tx == null ? 'standalone' : 'external',
          ...(status === 'failure' ? { phase: stage.phase, code } : {}),
        });
      }
    }
  }

  /** Own a transaction and supply a writer that cannot fall back to the base client. */
  async withManualTransaction<TClient extends ManualAuditTransactionHost, TResult>(
    client: TClient,
    callback: (scope: ManualAuditTransactionScope<ManualAuditTransactionClient<TClient>>) => Promise<TResult>,
    options?: ManualAuditTransactionOptions,
  ): Promise<TResult> {
    const started = this.options.onAuditOperation ? performance.now() : undefined;
    let status: 'success' | 'failure' = 'success';
    try {
      return await runManualAuditTransaction(client, (input, tx) => this.log(input, tx), callback, options);
    } catch (error) {
      status = 'failure';
      throw error;
    } finally {
      if (started !== undefined) {
        this.observeOperation({
          provider: this.provider, operation: 'transaction', status,
          durationMs: performance.now() - started, transaction: 'managed',
          ...(status === 'failure' ? { code: 'AUDIT_TRANSACTION_FAILED' as const } : {}),
        });
      }
    }
  }

  getCapabilities(): Readonly<AuditServiceCapabilities> {
    const postgres = this.provider === 'postgresql';
    return Object.freeze({
      provider: this.provider, manualLogging: true, manualTransactions: true,
      automaticTracking: postgres, query: true, scan: postgres, exportCsv: postgres,
      retention: postgres, schemaInspection: !postgres, readIndexes: !postgres,
    });
  }

  private observeOperation(event: AuditOperationEvent): void {
    if (this.options.onAuditOperation) {
      invokeAuditObserver(value => this.options.onAuditOperation!(value), [Object.freeze(event)]);
    }
  }

  private async writeManualLog(
    input: ManualAuditLogInput, tx: any, markPhase: (phase: AuditErrorPhase) => void,
  ): Promise<void> {
    const client = tx ?? this.options.prisma;
    if (this.options.strictManualValidation) validateManualAuditInput(input);
    markPhase('context');
    const actor = snapshotAuditActor(AuditContext.getActor(), this.options.actorRequired);
    if (this.options.strictManualValidation) {
      validateManualIdentity(actor?.id, 'actor.id', this.options.actorRequired);
    }
    markPhase('tenant-resolution');
    let tenantId: string | null;
    try {
      tenantId = resolveTenantId({
        tenantResolver: this.options.tenantResolver,
      });
    } catch (error) {
      if (this.options.tenantRequired) {
        throw this.errorWithCause(
          '[@nestarc/audit-log] tenant context required but not available. ' +
            'Provide tenantResolver or ensure the ambient tenant context is set.',
          error,
        );
      }
      this.warn(
        `[@nestarc/audit-log] tenant resolver failed; manual audit log will be written without tenant_id: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      tenantId = null;
    }
    if (!tenantId && this.options.tenantRequired) {
      throw new Error(
        '[@nestarc/audit-log] tenant context required but not available. ' +
          'Provide tenantResolver or ensure the ambient tenant context is set.',
      );
    }
    if (this.options.strictManualValidation) {
      validateManualIdentity(tenantId, 'tenantId', this.options.tenantRequired);
    }
    markPhase('serialization');
    if (this.options.strictManualValidation) {
      if (input.metadata !== undefined) validateManualMetadata(input.metadata);
      const contextMetadata = AuditContext.getMetadata();
      if (contextMetadata !== undefined) validateManualMetadata(contextMetadata);
    }
    const mergedMetadata = mergeContextMetadata(input.metadata);
    if (this.options.strictManualValidation && mergedMetadata !== undefined) {
      validateManualMetadata(mergedMetadata);
    }
    const metadata = mergedMetadata
      ? redactObject(
          mergedMetadata,
          getSensitiveFieldsFor(input.targetType ?? null, this.options),
        )
      : undefined;
    const metadataJson = metadata
      ? JSON.stringify(metadata)
      : null;
    enforceManualMetadataSize(metadataJson, this.options.maxMetadataBytes);

    markPhase('insert');
    const Prisma = this.Prisma;
    if (this.provider === 'sqlserver') {
      await client.$executeRaw(Prisma.sql!`
        INSERT INTO ${this.tableRef}
          ([tenant_id], [actor_id], [actor_type], [actor_ip], [action],
           [target_type], [target_id], [source], [metadata], [result])
        VALUES (
          ${tenantId},
          ${actor?.id ?? null},
          ${actor?.type ?? 'system'},
          ${actor?.ip ?? null},
          ${input.action},
          ${input.targetType ?? null},
          ${input.targetId ?? null},
          ${'manual'},
          ${metadataJson},
          ${input.result ?? 'success'}
        )
      `);
      return;
    }
    const insertSql = this.tableRef
      ? Prisma.sql!`
      INSERT INTO ${this.tableRef}
        (tenant_id, actor_id, actor_type, actor_ip, action,
         target_type, target_id, source, metadata, result)
      VALUES (
        ${tenantId},
        ${actor?.id ?? null},
        ${actor?.type ?? 'system'},
        ${actor?.ip ?? null},
        ${input.action},
        ${input.targetType ?? null},
        ${input.targetId ?? null},
        ${'manual'},
        ${metadataJson}::jsonb,
        ${input.result ?? 'success'}
      )
    `
      : Prisma.sql!`
      INSERT INTO audit_logs
        (tenant_id, actor_id, actor_type, actor_ip, action,
         target_type, target_id, source, metadata, result)
      VALUES (
        ${tenantId},
        ${actor?.id ?? null},
        ${actor?.type ?? 'system'},
        ${actor?.ip ?? null},
        ${input.action},
        ${input.targetType ?? null},
        ${input.targetId ?? null},
        ${'manual'},
        ${metadataJson}::jsonb,
        ${input.result ?? 'success'}
      )
    `;
    await client.$executeRaw(insertSql);
  }

  query(options: AuditQueryOptions): Promise<AuditQueryResult> {
    return this.queryService.query(options);
  }

  getById(
    id: string,
    options: AuditGetByIdOptions = {},
  ): Promise<AuditEntry | null> {
    return this.queryService.getById(id, options);
  }

  scan(options: AuditScanOptions): AsyncIterable<AuditScanPage> {
    return this.scanService.scan(options);
  }

  exportCsv(options: AuditCsvOptions): Readable {
    return this.scanService.exportCsv(options, (scanOptions) =>
      this.scan(scanOptions),
    );
  }

  prune(options: AuditPruneOptions): Promise<AuditPruneResult> {
    return this.maintenanceService.prune(options);
  }

  private warn(message: string): void {
    try {
      (this.options.logger ?? console).warn(message);
    } catch {
      // Logging failures must not affect manual audit logging.
    }
  }

  private errorWithCause(message: string, cause: unknown): Error {
    const error = new Error(message);
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
  }
}
