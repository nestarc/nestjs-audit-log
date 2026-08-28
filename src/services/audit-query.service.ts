import {
  AuditEntry,
  AuditGetByIdOptions,
  AuditQueryOptions,
  AuditQueryResult,
} from '../interfaces/audit-entry.interface';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import { PrismaModuleLike } from '../prisma/prisma-namespace';
import { resolveTenantId } from '../utils/tenant';
import {
  decodeAuditCursor,
  encodeAuditCursor,
  escapeLikePattern,
} from './audit-cursor';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** @internal */
export class AuditQueryService {
  private unscopedQueryWarned = false;

  constructor(
    private readonly options: AuditLogModuleOptions,
    private readonly Prisma: PrismaModuleLike['Prisma'],
    private readonly tableRef: unknown | null,
  ) {}

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
      // Logging failures must not affect query behavior.
    }
  }

  private errorWithCause(message: string, cause: unknown): Error {
    const error = new Error(message);
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
  }
}
