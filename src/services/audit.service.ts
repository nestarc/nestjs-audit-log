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
import { resolvePrismaNamespace } from '../prisma/prisma-namespace';
import { getSensitiveFieldsFor, redactObject } from '../prisma/diff';
import { validateAuditTableName } from '../sql/table-name';
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

@Injectable()
export class AuditService {
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
    this.Prisma = resolvePrismaNamespace({
      prismaModule: options.prismaModule,
    });
    this.tableName = validateAuditTableName(options.tableName);
    this.tableRef =
      this.tableName === 'audit_logs' ? null : this.Prisma.raw!(this.tableName);
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
    const client = tx ?? this.options.prisma;
    const actor = AuditContext.getActor();
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
    const mergedMetadata = mergeContextMetadata(input.metadata);
    const metadata = mergedMetadata
      ? redactObject(
          mergedMetadata,
          getSensitiveFieldsFor(input.targetType ?? null, this.options),
        )
      : undefined;
    const metadataJson = metadata
      ? JSON.stringify(metadata)
      : null;

    const Prisma = this.Prisma;
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
