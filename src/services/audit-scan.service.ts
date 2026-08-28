import { Readable } from 'node:stream';
import {
  AuditCsvOptions,
  AuditEntry,
  AuditScanOptions,
  AuditScanPage,
} from '../interfaces/audit-entry.interface';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import { PrismaModuleLike } from '../prisma/prisma-namespace';
import {
  decodeAuditCursor,
  encodeAuditCursor,
  escapeLikePattern,
} from './audit-cursor';
import {
  serializeAuditCsvEntry,
  serializeAuditCsvHeader,
} from './audit-csv';

const EMPTY_SCAN_CHECKPOINT = encodeAuditCursor(
  '0001-01-01T00:00:00.000000Z',
  '00000000-0000-0000-0000-000000000000',
);

/** @internal */
export class AuditScanService {
  constructor(
    private readonly options: AuditLogModuleOptions,
    private readonly Prisma: PrismaModuleLike['Prisma'],
    private readonly tableRef: unknown | null,
  ) {}

  scan(options: AuditScanOptions): AsyncIterable<AuditScanPage> {
    this.validateScanOptions(options);
    return this.scanPages(options);
  }

  exportCsv(
    options: AuditCsvOptions,
    scan: (options: AuditScanOptions) => AsyncIterable<AuditScanPage> = (
      scanOptions,
    ) => this.scan(scanOptions),
  ): Readable {
    this.validateScanOptions(options);
    if (options.columns !== undefined && options.columns !== 'v1') {
      throw new TypeError(
        '[@nestarc/audit-log] CSV columns must be the supported version v1.',
      );
    }
    return Readable.from(this.csvChunks(options, scan), { objectMode: false });
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

  private async *csvChunks(
    options: AuditCsvOptions,
    scan: (options: AuditScanOptions) => AsyncIterable<AuditScanPage>,
  ): AsyncGenerator<string> {
    this.throwIfAborted(options.signal);
    if (options.includeBom) yield '\uFEFF';
    yield serializeAuditCsvHeader();
    for await (const page of scan(options)) {
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
    if (options.actorId) {
      conditions.push(Prisma.sql!`actor_id = ${options.actorId}`);
    }
    if (options.action) {
      if (options.action.includes('*')) {
        const pattern = escapeLikePattern(options.action).replace(/\*/g, '%');
        conditions.push(Prisma.sql!`action LIKE ${pattern} ESCAPE '\\'`);
      } else {
        conditions.push(Prisma.sql!`action = ${options.action}`);
      }
    }
    if (options.targetType) {
      conditions.push(Prisma.sql!`target_type = ${options.targetType}`);
    }
    if (options.targetId) {
      conditions.push(Prisma.sql!`target_id = ${options.targetId}`);
    }
    if (options.from) {
      conditions.push(Prisma.sql!`created_at >= ${options.from}`);
    }
    if (options.to) {
      conditions.push(Prisma.sql!`created_at <= ${options.to}`);
    }
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
    const hasTenantId = Object.prototype.hasOwnProperty.call(
      options,
      'tenantId',
    );
    const hasAllTenants = Object.prototype.hasOwnProperty.call(
      options,
      'allTenants',
    );
    if (hasTenantId === hasAllTenants) {
      throw new TypeError(
        '[@nestarc/audit-log] scan/export requires exactly one of tenantId or allTenants: true.',
      );
    }
    if (
      hasTenantId &&
      (typeof options.tenantId !== 'string' || options.tenantId.length === 0)
    ) {
      throw new TypeError(
        '[@nestarc/audit-log] tenantId must be a non-empty string.',
      );
    }
    if (hasAllTenants && options.allTenants !== true) {
      throw new TypeError(
        '[@nestarc/audit-log] allTenants must be true when provided.',
      );
    }
    if (
      options.batchSize !== undefined &&
      (!Number.isInteger(options.batchSize) ||
        options.batchSize < 1 ||
        options.batchSize > 10000)
    ) {
      throw new TypeError(
        '[@nestarc/audit-log] batchSize must be an integer between 1 and 10000.',
      );
    }
    for (const [name, value] of [
      ['from', options.from],
      ['to', options.to],
    ] as const) {
      if (
        value !== undefined &&
        (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      ) {
        throw new TypeError(`[@nestarc/audit-log] ${name} must be a valid Date.`);
      }
    }
    if (
      options.from &&
      options.to &&
      options.from.getTime() > options.to.getTime()
    ) {
      throw new TypeError(
        '[@nestarc/audit-log] from must be before or equal to to.',
      );
    }
    const after = options.after ? decodeAuditCursor(options.after) : undefined;
    const until = options.until ? decodeAuditCursor(options.until) : undefined;
    if (after && until && this.compareCursorParts(after, until) >= 0) {
      throw new TypeError('[@nestarc/audit-log] after must be before until.');
    }
    if (
      options.signal !== undefined &&
      typeof options.signal.aborted !== 'boolean'
    ) {
      throw new TypeError(
        '[@nestarc/audit-log] signal must be an AbortSignal.',
      );
    }
    if (
      'includeBom' in options &&
      options.includeBom !== undefined &&
      typeof options.includeBom !== 'boolean'
    ) {
      throw new TypeError(
        '[@nestarc/audit-log] includeBom must be a boolean.',
      );
    }
    this.throwIfAborted(options.signal);
  }

  private compareCursorParts(
    left: { ts: string; id: string },
    right: { ts: string; id: string },
  ): number {
    return left.ts === right.ts
      ? left.id.localeCompare(right.id)
      : left.ts.localeCompare(right.ts);
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
}
