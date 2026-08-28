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
import { deriveAuditObjectNames } from '../sql';
import {
  decodeAuditCursor,
  encodeAuditCursor,
  escapeLikePattern,
} from './audit-cursor';
import {
  serializeAuditCsvEntry,
  serializeAuditCsvHeader,
} from './audit-csv';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_SCAN_CHECKPOINT = encodeAuditCursor(
  '0001-01-01T00:00:00.000000Z',
  '00000000-0000-0000-0000-000000000000',
);

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

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
  private unscopedQueryWarned = false;

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

  async query(options: AuditQueryOptions): Promise<AuditQueryResult> {
    this.validateQueryPagination(options);
    const Prisma = this.Prisma;
    const baseConditions: unknown[] = [];
    const tenantId = this.resolveQueryTenantId(options);
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    if (tenantId !== null) {
      baseConditions.push(Prisma.sql!`tenant_id = ${tenantId}`);
    }
    if (options.actorId) {
      baseConditions.push(Prisma.sql!`actor_id = ${options.actorId}`);
    }
    if (options.actorType) {
      baseConditions.push(Prisma.sql!`actor_type = ${options.actorType}`);
    }
    if (options.action) {
      if (options.action.includes('*')) {
        const pattern = escapeLikePattern(options.action).replace(/\*/g, '%');
        baseConditions.push(Prisma.sql!`action LIKE ${pattern} ESCAPE '\\'`);
      } else {
        baseConditions.push(Prisma.sql!`action = ${options.action}`);
      }
    }
    if (options.targetType) {
      baseConditions.push(Prisma.sql!`target_type = ${options.targetType}`);
    }
    if (options.targetId) {
      baseConditions.push(Prisma.sql!`target_id = ${options.targetId}`);
    }
    if (options.source) {
      baseConditions.push(Prisma.sql!`source = ${options.source}`);
    }
    if (options.result) {
      baseConditions.push(Prisma.sql!`result = ${options.result}`);
    }
    if (options.from) {
      baseConditions.push(Prisma.sql!`created_at >= ${options.from}`);
    }
    if (options.to) {
      baseConditions.push(Prisma.sql!`created_at <= ${options.to}`);
    }

    const entryConditions = [...baseConditions];
    if (options.cursor) {
      const cursor = decodeAuditCursor(options.cursor);
      entryConditions.push(
        Prisma.sql!`created_at <= ${cursor.ts}::timestamptz`,
      );
      entryConditions.push(
        Prisma.sql!`(created_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const where = this.buildWhere(entryConditions);
    const countWhere = this.buildWhere(baseConditions);
    const pageLimit = limit + 1;
    const entriesSql = this.tableRef
      ? Prisma.sql!`
        SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
               actor_type AS "actorType", actor_ip AS "actorIp",
               action, target_type AS "targetType", target_id AS "targetId",
               source, changes, metadata, result, created_at AS "createdAt",
               to_char(created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
        FROM ${this.tableRef} ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${pageLimit} ${options.cursor ? Prisma.empty : Prisma.sql!`OFFSET ${offset}`}
      `
      : Prisma.sql!`
        SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
               actor_type AS "actorType", actor_ip AS "actorIp",
               action, target_type AS "targetType", target_id AS "targetId",
               source, changes, metadata, result, created_at AS "createdAt",
               to_char(created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
        FROM audit_logs ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${pageLimit} ${options.cursor ? Prisma.empty : Prisma.sql!`OFFSET ${offset}`}
      `;
    const countSql = this.tableRef
      ? Prisma.sql!`
        SELECT COUNT(*) AS count FROM ${this.tableRef} ${countWhere}
      `
      : Prisma.sql!`
        SELECT COUNT(*) AS count FROM audit_logs ${countWhere}
      `;

    const includeTotal = options.includeTotal !== false;
    const [rawEntries, countResult] = includeTotal
      ? await Promise.all([
          this.options.prisma.$queryRaw(entriesSql) as Promise<
            Array<AuditEntry & { cursorTs?: string }>
          >,
          this.options.prisma.$queryRaw(countSql) as Promise<[{ count: bigint }]>,
        ])
      : [
          (await this.options.prisma.$queryRaw(entriesSql)) as Array<
            AuditEntry & { cursorTs?: string }
          >,
          undefined,
        ];

    const { entries, hasMore, nextCursor } = this.pageEntries(
      rawEntries,
      limit,
    );
    const result: AuditQueryResult = {
      entries,
      hasMore,
      nextCursor,
    };

    if (includeTotal) {
      result.total = Number(countResult![0].count);
    }

    return result;
  }

  async getById(
    id: string,
    options: AuditGetByIdOptions = {},
  ): Promise<AuditEntry | null> {
    const normalizedId = id.toLowerCase();
    if (!isUuid(normalizedId)) {
      return null;
    }

    const Prisma = this.Prisma;
    const conditions: unknown[] = [Prisma.sql!`id = ${normalizedId}::uuid`];
    const tenantId = this.resolveQueryTenantId(options);
    if (tenantId !== null) {
      conditions.push(Prisma.sql!`tenant_id = ${tenantId}`);
    }

    const where = this.buildWhere(conditions);
    const sql = this.tableRef
      ? Prisma.sql!`
        SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
               actor_type AS "actorType", actor_ip AS "actorIp",
               action, target_type AS "targetType", target_id AS "targetId",
               source, changes, metadata, result, created_at AS "createdAt"
        FROM ${this.tableRef} ${where}
        LIMIT 1
      `
      : Prisma.sql!`
        SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
               actor_type AS "actorType", actor_ip AS "actorIp",
               action, target_type AS "targetType", target_id AS "targetId",
               source, changes, metadata, result, created_at AS "createdAt"
        FROM audit_logs ${where}
        LIMIT 1
      `;

    const rows = (await this.options.prisma.$queryRaw(sql)) as AuditEntry[];
    return rows[0] ?? null;
  }

  scan(options: AuditScanOptions): AsyncIterable<AuditScanPage> {
    this.validateScanOptions(options);
    return this.scanPages(options);
  }

  exportCsv(options: AuditCsvOptions): Readable {
    this.validateScanOptions(options);
    if (options.columns !== undefined && options.columns !== 'v1') {
      throw new TypeError(
        '[@nestarc/audit-log] CSV columns must be the supported version v1.',
      );
    }
    return Readable.from(this.csvChunks(options), { objectMode: false });
  }

  private async *scanPages(
    options: AuditScanOptions,
  ): AsyncGenerator<AuditScanPage> {
    this.throwIfAborted(options.signal);
    const baseConditions = this.buildScanConditions(options);
    const highWatermark = await this.resolveScanHighWatermark(
      baseConditions,
      options,
    );
    this.throwIfAborted(options.signal);

    if (!highWatermark.hasEntries) {
      yield {
        entries: [],
        checkpoint: null,
        highWatermark: highWatermark.checkpoint,
      };
      return;
    }

    const Prisma = this.Prisma;
    const batchSize = options.batchSize ?? 500;
    let after = options.after;
    while (true) {
      this.throwIfAborted(options.signal);
      const conditions = [...baseConditions];
      if (after) {
        const cursor = decodeAuditCursor(after);
        conditions.push(
          Prisma.sql!`(created_at, id) > (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      const upper = decodeAuditCursor(highWatermark.checkpoint);
      conditions.push(
        Prisma.sql!`(created_at, id) <= (${upper.ts}::timestamptz, ${upper.id}::uuid)`,
      );
      const where = this.buildWhere(conditions);
      const pageLimit = batchSize + 1;
      const sql = this.tableRef
        ? Prisma.sql!`
          SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
                 actor_type AS "actorType", actor_ip AS "actorIp",
                 action, target_type AS "targetType", target_id AS "targetId",
                 source, changes, metadata, result, created_at AS "createdAt",
                 to_char(created_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
          FROM ${this.tableRef} ${where}
          ORDER BY created_at ASC, id ASC
          LIMIT ${pageLimit}
        `
        : Prisma.sql!`
          SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
                 actor_type AS "actorType", actor_ip AS "actorIp",
                 action, target_type AS "targetType", target_id AS "targetId",
                 source, changes, metadata, result, created_at AS "createdAt",
                 to_char(created_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
          FROM audit_logs ${where}
          ORDER BY created_at ASC, id ASC
          LIMIT ${pageLimit}
        `;
      const rows = (await this.options.prisma.$queryRaw(sql)) as Array<
        AuditEntry & { cursorTs: string }
      >;
      this.throwIfAborted(options.signal);
      if (rows.length === 0) return;

      const pageRows = rows.slice(0, batchSize);
      const last = pageRows[pageRows.length - 1];
      const checkpoint = encodeAuditCursor(last.cursorTs, last.id);
      const entries = pageRows.map(({ cursorTs: _cursorTs, ...entry }) => entry);
      yield { entries, checkpoint, highWatermark: highWatermark.checkpoint };

      if (rows.length <= batchSize) return;
      after = checkpoint;
    }
  }

  private async *csvChunks(options: AuditCsvOptions): AsyncGenerator<string> {
    this.throwIfAborted(options.signal);
    if (options.includeBom) yield '\uFEFF';
    yield serializeAuditCsvHeader();
    for await (const page of this.scan(options)) {
      for (const entry of page.entries) {
        this.throwIfAborted(options.signal);
        yield serializeAuditCsvEntry(entry);
      }
    }
  }

  private buildScanConditions(options: AuditScanOptions): unknown[] {
    const Prisma = this.Prisma;
    const conditions: unknown[] = [];
    if ('tenantId' in options) {
      conditions.push(Prisma.sql!`tenant_id = ${options.tenantId}`);
    }
    if (options.actorId) conditions.push(Prisma.sql!`actor_id = ${options.actorId}`);
    if (options.action) {
      if (options.action.includes('*')) {
        const pattern = escapeLikePattern(options.action).replace(/\*/g, '%');
        conditions.push(Prisma.sql!`action LIKE ${pattern} ESCAPE '\\'`);
      } else {
        conditions.push(Prisma.sql!`action = ${options.action}`);
      }
    }
    if (options.targetType) conditions.push(Prisma.sql!`target_type = ${options.targetType}`);
    if (options.targetId) conditions.push(Prisma.sql!`target_id = ${options.targetId}`);
    if (options.from) conditions.push(Prisma.sql!`created_at >= ${options.from}`);
    if (options.to) conditions.push(Prisma.sql!`created_at <= ${options.to}`);
    if (options.after) {
      const after = decodeAuditCursor(options.after);
      conditions.push(
        Prisma.sql!`(created_at, id) > (${after.ts}::timestamptz, ${after.id}::uuid)`,
      );
    }
    if (options.until) {
      const until = decodeAuditCursor(options.until);
      conditions.push(
        Prisma.sql!`(created_at, id) <= (${until.ts}::timestamptz, ${until.id}::uuid)`,
      );
    }
    return conditions;
  }

  private async resolveScanHighWatermark(
    conditions: unknown[],
    options: AuditScanOptions,
  ): Promise<{ checkpoint: string; hasEntries: boolean }> {
    const Prisma = this.Prisma;
    const where = this.buildWhere(conditions);
    const sql = this.tableRef
      ? Prisma.sql!`
        SELECT id,
               to_char(created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
        FROM ${this.tableRef} ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      : Prisma.sql!`
        SELECT id,
               to_char(created_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
        FROM audit_logs ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;
    const rows = (await this.options.prisma.$queryRaw(sql)) as Array<{
      id: string;
      cursorTs: string;
    }>;
    const row = rows[0];
    return row
      ? { checkpoint: encodeAuditCursor(row.cursorTs, row.id), hasEntries: true }
      : {
          checkpoint: options.after ?? options.until ?? EMPTY_SCAN_CHECKPOINT,
          hasEntries: false,
        };
  }

  private validateScanOptions(options: AuditScanOptions): void {
    if (!options || typeof options !== 'object') {
      throw new TypeError('[@nestarc/audit-log] scan options are required.');
    }
    const hasTenantId = Object.prototype.hasOwnProperty.call(options, 'tenantId');
    const hasAllTenants = Object.prototype.hasOwnProperty.call(options, 'allTenants');
    if (hasTenantId === hasAllTenants) {
      throw new TypeError(
        '[@nestarc/audit-log] scan/export requires exactly one of tenantId or allTenants: true.',
      );
    }
    if (hasTenantId && (typeof options.tenantId !== 'string' || options.tenantId.length === 0)) {
      throw new TypeError('[@nestarc/audit-log] tenantId must be a non-empty string.');
    }
    if (hasAllTenants && options.allTenants !== true) {
      throw new TypeError('[@nestarc/audit-log] allTenants must be true when provided.');
    }
    if (
      options.batchSize !== undefined &&
      (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10000)
    ) {
      throw new TypeError(
        '[@nestarc/audit-log] batchSize must be an integer between 1 and 10000.',
      );
    }
    for (const [name, value] of [['from', options.from], ['to', options.to]] as const) {
      if (value !== undefined && (!(value instanceof Date) || !Number.isFinite(value.getTime()))) {
        throw new TypeError(`[@nestarc/audit-log] ${name} must be a valid Date.`);
      }
    }
    if (options.from && options.to && options.from.getTime() > options.to.getTime()) {
      throw new TypeError('[@nestarc/audit-log] from must be before or equal to to.');
    }
    const after = options.after ? decodeAuditCursor(options.after) : undefined;
    const until = options.until ? decodeAuditCursor(options.until) : undefined;
    if (after && until && this.compareCursorParts(after, until) >= 0) {
      throw new TypeError('[@nestarc/audit-log] after must be before until.');
    }
    if (options.signal !== undefined && typeof options.signal.aborted !== 'boolean') {
      throw new TypeError('[@nestarc/audit-log] signal must be an AbortSignal.');
    }
    if (
      'includeBom' in options &&
      options.includeBom !== undefined &&
      typeof options.includeBom !== 'boolean'
    ) {
      throw new TypeError('[@nestarc/audit-log] includeBom must be a boolean.');
    }
    this.throwIfAborted(options.signal);
  }

  private compareCursorParts(
    left: { ts: string; id: string },
    right: { ts: string; id: string },
  ): number {
    return left.ts === right.ts ? left.id.localeCompare(right.id) : left.ts.localeCompare(right.ts);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('[@nestarc/audit-log] scan/export aborted.');
    error.name = 'AbortError';
    (error as Error & { cause?: unknown }).cause = signal.reason;
    throw error;
  }

  private buildWhere(conditions: unknown[]): unknown {
    const Prisma = this.Prisma;
    return conditions.length > 0
      ? Prisma.sql!`WHERE ${Prisma.join!(conditions, ' AND ')}`
      : Prisma.empty;
  }

  private validateQueryPagination(options: AuditQueryOptions): void {
    if (options.cursor !== undefined && options.offset !== undefined) {
      throw new Error(
        '[@nestarc/audit-log] cursor and offset are mutually exclusive. Pass only one.',
      );
    }

    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1)
    ) {
      throw new Error('[@nestarc/audit-log] limit must be a positive integer.');
    }

    if (
      options.offset !== undefined &&
      (!Number.isInteger(options.offset) || options.offset < 0)
    ) {
      throw new Error(
        '[@nestarc/audit-log] offset must be a non-negative integer.',
      );
    }
  }

  private pageEntries(
    rawEntries: Array<AuditEntry & { cursorTs?: string }>,
    limit: number,
  ): {
    entries: AuditEntry[];
    hasMore: boolean;
    nextCursor: string | null;
  } {
    const hasMore = rawEntries.length > limit;
    const pageRows = rawEntries.slice(0, limit);
    const lastRow = hasMore ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor =
      lastRow?.cursorTs && lastRow.id
        ? encodeAuditCursor(lastRow.cursorTs, lastRow.id)
        : null;
    const entries = pageRows.map(({ cursorTs: _cursorTs, ...entry }) => entry);

    return {
      entries,
      hasMore,
      nextCursor,
    };
  }

  async prune(options: AuditPruneOptions): Promise<AuditPruneResult> {
    this.validatePruneOptions(options);
    const client = options.client ?? this.options.prisma;
    const Prisma = this.Prisma;
    const relkindRows = await client.$queryRaw(
      Prisma.sql!`SELECT relkind::text AS relkind FROM pg_class WHERE oid = to_regclass(${this.tableName})`,
    ) as Array<{ relkind: string }>;
    const relkind = relkindRows[0]?.relkind;

    if (relkind !== 'r' && relkind !== 'p') {
      throw new Error(
        `[@nestarc/audit-log] audit table '${this.tableName}' does not exist or is not a supported table.`,
      );
    }

    if (relkind === 'p') {
      return this.prunePartitioned(client, options);
    }

    return this.pruneFlat(client, options);
  }

  private async prunePartitioned(
    client: any,
    options: AuditPruneOptions,
  ): Promise<AuditPruneResult> {
    const Prisma = this.Prisma;
    const mode = this.resolvePartitionPruneMode(options.mode);
    const rows = await client.$queryRaw(
      Prisma.sql!`
        SELECT child_ns.nspname AS "partitionSchema",
               child.relname AS "partitionName",
               pg_get_expr(child.relpartbound, child.oid) AS "partitionBound",
               NULL::text AS "upperBound"
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        JOIN pg_class child ON pg_inherits.inhrelid = child.oid
        JOIN pg_namespace child_ns ON child.relnamespace = child_ns.oid
        WHERE parent.oid = to_regclass(${this.tableName})
      `,
    ) as Array<{
      partitionSchema: string;
      partitionName: string;
      upperBound?: string | Date | null;
      partitionBound?: string | null;
    }>;
    const targets = rows
      .filter((row) => {
        const upperBound = row.upperBound ?? this.parsePartitionUpperBound(
          row.partitionBound,
        );
        return upperBound
          ? new Date(upperBound).getTime() <= options.olderThan.getTime()
          : false;
      })
      .map((row) => this.qualifyPartitionName(row));

    if (options.dryRun) {
      return {
        layout: 'partitioned',
        mode,
        prunedPartitions: targets,
        deletedRows: null,
        dryRun: true,
      };
    }

    const succeeded: string[] = [];
    for (const partition of targets) {
      try {
        if (mode === 'detach') {
          await client.$executeRawUnsafe(
            `ALTER TABLE ${this.tableName} DETACH PARTITION ${partition}`,
          );
        } else {
          await client.$executeRawUnsafe(`DROP TABLE ${partition}`);
        }
        succeeded.push(partition);
      } catch (error) {
        throw this.errorWithCause(
          `[@nestarc/audit-log] failed to prune partition '${partition}': ${this.errorMessage(error)}; ` +
            `already pruned: ${succeeded.length > 0 ? succeeded.join(', ') : '(none)'}`,
          error,
        );
      }
    }

    return {
      layout: 'partitioned',
      mode,
      prunedPartitions: targets,
      deletedRows: null,
      dryRun: false,
    };
  }

  private resolvePartitionPruneMode(
    mode?: AuditPruneOptions['mode'],
  ): 'drop' | 'detach' {
    if (mode === undefined) {
      return 'drop';
    }
    if (mode === 'drop' || mode === 'detach') {
      return mode;
    }
    throw new TypeError(
      '[@nestarc/audit-log] prune mode must be either drop or detach.',
    );
  }

  private parsePartitionUpperBound(bound?: string | null): string | null {
    if (!bound) return null;
    const match = bound.match(/TO \('([^']+)'\)/);
    return match?.[1] ?? null;
  }

  private qualifyPartitionName(row: {
    partitionSchema: string;
    partitionName: string;
  }): string {
    const partitionName = validateAuditTableName(row.partitionName);
    if (!this.tableName.includes('.')) {
      return partitionName;
    }
    return validateAuditTableName(`${row.partitionSchema}.${partitionName}`);
  }

  private async pruneFlat(
    client: any,
    options: AuditPruneOptions,
  ): Promise<AuditPruneResult> {
    const Prisma = this.Prisma;
    if (options.dryRun) {
      const rows = await client.$queryRaw(
        Prisma.sql!`SELECT COUNT(*) AS count FROM ${this.tableRef ?? Prisma.raw!('audit_logs')} WHERE created_at < ${options.olderThan}`,
      ) as Array<{ count: bigint | number }>;
      return {
        layout: 'flat',
        mode: 'delete',
        prunedPartitions: [],
        deletedRows: Number(rows[0]?.count ?? 0),
        dryRun: true,
      };
    }

    const names = deriveAuditObjectNames(this.tableName);
    const triggerRows = await client.$queryRaw(
      Prisma.sql!`SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = ${names.deleteTrigger}
          AND tgrelid = to_regclass(${this.tableName})
      ) AS "exists"`,
    ) as Array<{ exists: boolean }>;
    const hasTrigger = triggerRows[0]?.exists === true;
    const ruleRows = hasTrigger
      ? [{ exists: false }]
      : await client.$queryRaw(
          Prisma.sql!`SELECT EXISTS (
            SELECT 1 FROM pg_rewrite
            WHERE rulename = ${names.deleteRule}
              AND ev_class = to_regclass(${this.tableName})
          ) AS "exists"`,
        ) as Array<{ exists: boolean }>;
    const hasRule = ruleRows[0]?.exists === true;
    const tableRef = this.tableRef ?? Prisma.raw!('audit_logs');
    const deleteTriggerRef = Prisma.raw!(names.deleteTrigger);
    const deleteRuleRef = Prisma.raw!(names.deleteRule);

    const deletedRows = await client.$transaction(
      async (tx: any) => {
        if (hasTrigger) {
          await tx.$executeRaw(
            Prisma.sql!`ALTER TABLE ${tableRef} DISABLE TRIGGER ${deleteTriggerRef}`,
          );
        } else if (hasRule) {
          await tx.$executeRaw(
            Prisma.sql!`DROP RULE ${deleteRuleRef} ON ${tableRef}`,
          );
        } else {
          this.warn(
            `[@nestarc/audit-log] append-only delete enforcement not found on '${this.tableName}'; pruning with plain DELETE.`,
          );
        }
        const deleted = await tx.$executeRaw(
          Prisma.sql!`DELETE FROM ${tableRef} WHERE created_at < ${options.olderThan}`,
        );
        if (hasTrigger) {
          await tx.$executeRaw(
            Prisma.sql!`ALTER TABLE ${tableRef} ENABLE TRIGGER ${deleteTriggerRef}`,
          );
        } else if (hasRule) {
          await tx.$executeRaw(
            Prisma.sql!`CREATE RULE ${deleteRuleRef} AS ON DELETE TO ${tableRef} DO INSTEAD NOTHING`,
          );
        }
        return Number(deleted ?? 0);
      },
      {
        timeout: options.timeoutMs ?? 60000,
        maxWait: options.maxWaitMs ?? 10000,
      },
    );

    return {
      layout: 'flat',
      mode: 'delete',
      prunedPartitions: [],
      deletedRows,
      dryRun: false,
    };
  }

  private validatePruneOptions(options: AuditPruneOptions): void {
    if (
      !options ||
      !(options.olderThan instanceof Date) ||
      !Number.isFinite(options.olderThan.getTime())
    ) {
      throw new TypeError(
        '[@nestarc/audit-log] olderThan must be a valid Date.',
      );
    }
    for (const [name, value] of [
      ['timeoutMs', options.timeoutMs],
      ['maxWaitMs', options.maxWaitMs],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new TypeError(
          `[@nestarc/audit-log] ${name} must be a positive integer.`,
        );
      }
    }
    if (options.requiredCheckpoints !== undefined) {
      if (!Array.isArray(options.requiredCheckpoints)) {
        throw new TypeError(
          '[@nestarc/audit-log] requiredCheckpoints must be an array of scan checkpoints.',
        );
      }
      for (const checkpoint of options.requiredCheckpoints) {
        const decoded = decodeAuditCursor(checkpoint);
        if (options.olderThan.getTime() > Date.parse(decoded.ts)) {
          throw new Error(
            '[@nestarc/audit-log] retention cutoff is ahead of a required stream checkpoint. ' +
              'Advance the slow stream or use an externally managed detach-first archive procedure.',
          );
        }
      }
    }
  }

  private resolveQueryTenantId(
    options: AuditQueryOptions | AuditGetByIdOptions,
  ): string | null {
    const explicitTenantId = options.tenantId;
    const hasExplicitTenantId = explicitTenantId !== undefined;

    if (hasExplicitTenantId && options.allTenants) {
      throw new TypeError(
        '[@nestarc/audit-log] tenantId and allTenants are mutually exclusive.',
      );
    }

    if (hasExplicitTenantId) {
      if (typeof explicitTenantId !== 'string') {
        throw new TypeError(
          '[@nestarc/audit-log] tenantId must be a string when provided.',
        );
      }
      return explicitTenantId;
    }

    if (options.allTenants) {
      return null;
    }

    let tenantId: string | null;
    try {
      tenantId = resolveTenantId({
        tenantResolver: this.options.tenantResolver,
      });
    } catch (error) {
      if (this.options.tenantRequired) {
        throw this.errorWithCause(
          '[@nestarc/audit-log] tenant context required but not available. ' +
            'Pass an explicit tenantId or allTenants option, or ensure tenant context is set ' +
            '(tenantResolver / @nestarc/tenancy).',
          error,
        );
      }
      this.warnUnscopedQuery();
      return null;
    }

    if (tenantId !== null) {
      return tenantId;
    }

    if (this.options.tenantRequired) {
      throw new Error(
        '[@nestarc/audit-log] tenant context required but not available. ' +
          'Pass an explicit tenantId or allTenants option, or ensure tenant context is set ' +
          '(tenantResolver / @nestarc/tenancy).',
      );
    }

    this.warnUnscopedQuery();
    return null;
  }

  private warnUnscopedQuery(): void {
    if (this.unscopedQueryWarned) return;
    this.unscopedQueryWarned = true;
    this.warn(
      '[@nestarc/audit-log] query() executed without tenant scope. Pass tenantId, ' +
        'set allTenants: true explicitly, or enable tenantRequired.',
    );
  }

  private warn(message: string): void {
    try {
      (this.options.logger ?? console).warn(message);
    } catch {
      // Logging failures must not affect query/log behavior.
    }
  }

  private errorWithCause(message: string, cause: unknown): Error {
    const error = new Error(message);
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
