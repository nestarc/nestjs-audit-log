import type { AuditEntry, AuditQueryOptions, AuditQueryResult } from '../interfaces/audit-entry.interface';
import type { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import type { PrismaModuleLike } from '../prisma/prisma-namespace';
import { getSqlServerTableName } from '../sql/table-name';
import { escapeLikePattern } from './audit-cursor';
import { decodeSqlServerAuditCursor, encodeSqlServerAuditCursor } from './audit-sqlserver-cursor';

type SqlServerAuditRow = Omit<AuditEntry, 'changes' | 'metadata' | 'createdAt'> & {
  changes: string | null;
  metadata: string | null;
  cursorTs: string;
};

/** @internal SQL Server reads share tenancy policy with AuditQueryService. */
export class SqlServerAuditQuery {
  private readonly table: unknown;
  private readonly columns: unknown;

  constructor(
    private readonly options: AuditLogModuleOptions,
    private readonly Prisma: PrismaModuleLike['Prisma'],
    tableRef: unknown | null,
  ) {
    this.table = tableRef ?? Prisma.raw!(getSqlServerTableName(options.tableName).quoted);
    // Construct the fractional portion explicitly: datetime text conversions can
    // omit zero fractions. Date is used only for the public entry, never paging.
    this.columns = Prisma.sql!`
      [id], [tenant_id] AS [tenantId], [actor_id] AS [actorId],
      [actor_type] AS [actorType], [actor_ip] AS [actorIp], [action],
      [target_type] AS [targetType], [target_id] AS [targetId],
      [source], [changes], [metadata], [result],
      CONVERT(CHAR(19), [created_at], 126) + '.' +
        RIGHT('0000000' + CONVERT(VARCHAR(7), DATEPART(NANOSECOND, [created_at]) / 100), 7) + 'Z' AS [cursorTs]
    `;
  }

  async query(query: AuditQueryOptions, tenantId: string | null): Promise<AuditQueryResult> {
    const Prisma = this.Prisma;
    const baseConditions: unknown[] = [];
    if (tenantId !== null) baseConditions.push(this.equal('tenant_id', tenantId, true));
    if (query.actorId) baseConditions.push(this.equal('actor_id', query.actorId, true));
    if (query.actorType) baseConditions.push(this.equal('actor_type', query.actorType));
    if (query.action) {
      if (query.action.includes('*')) {
        // SQL Server adds [character classes] to LIKE; escape both brackets so
        // the public API continues to treat only '*' as a wildcard.
        const pattern = escapeLikePattern(query.action).replace(/[[\]]/g, '\\$&').replace(/\*/g, '%');
        baseConditions.push(Prisma.sql!`[action] COLLATE Latin1_General_100_BIN2 LIKE ${pattern} COLLATE Latin1_General_100_BIN2 ESCAPE '\\'`);
      } else {
        baseConditions.push(this.equal('action', query.action));
      }
    }
    if (query.targetType) baseConditions.push(this.equal('target_type', query.targetType, true));
    if (query.targetId) baseConditions.push(this.equal('target_id', query.targetId, true));
    if (query.source) baseConditions.push(this.equal('source', query.source));
    if (query.result) baseConditions.push(this.equal('result', query.result));
    if (query.from) baseConditions.push(Prisma.sql!`[created_at] >= CAST(${this.utcDate(query.from)} AS DATETIME2(7))`);
    if (query.to) baseConditions.push(Prisma.sql!`[created_at] <= CAST(${this.utcDate(query.to)} AS DATETIME2(7))`);

    const conditions = [...baseConditions];
    if (query.cursor) {
      const cursor = decodeSqlServerAuditCursor(query.cursor);
      const timestamp = cursor.ts.slice(0, -1);
      // UNIQUEIDENTIFIER ordering differs from lexical UUID ordering. Keep
      // comparison and sorting in SQL Server with the same native types.
      conditions.push(Prisma.sql!`(
        [created_at] < CAST(${timestamp} AS DATETIME2(7)) OR
        ([created_at] = CAST(${timestamp} AS DATETIME2(7)) AND [id] < CAST(${cursor.id} AS UNIQUEIDENTIFIER))
      )`);
    }
    const limit = query.limit ?? 50;
    const offset = query.cursor ? 0 : query.offset ?? 0;
    const rowsSql = Prisma.sql!`
      SELECT ${this.columns} FROM ${this.table} ${this.where(conditions)}
      ORDER BY [created_at] DESC, [id] DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY
    `;
    const includeTotal = query.includeTotal !== false;
    const [rows, counts] = await Promise.all([
      this.options.prisma.$queryRaw(rowsSql) as Promise<SqlServerAuditRow[]>,
      includeTotal
        ? this.options.prisma.$queryRaw(Prisma.sql!`SELECT COUNT_BIG(*) AS [count] FROM ${this.table} ${this.where(baseConditions)}`) as Promise<Array<{ count: bigint }>>
        : undefined,
    ]);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = hasMore ? page[page.length - 1] : undefined;
    const result: AuditQueryResult = {
      entries: page.map(row => this.entry(row)),
      hasMore,
      nextCursor: last ? encodeSqlServerAuditCursor(last.cursorTs, last.id) : null,
    };
    if (counts) {
      const total = Number(counts[0].count);
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new RangeError('[@nestarc/audit-log] SQL Server audit total exceeds the safe integer range; use includeTotal: false.');
      }
      result.total = total;
    }
    return result;
  }

  async getById(id: string, tenantId: string | null): Promise<AuditEntry | null> {
    const Prisma = this.Prisma;
    const conditions = [Prisma.sql!`[id] = CAST(${id} AS UNIQUEIDENTIFIER)`];
    if (tenantId !== null) conditions.push(this.equal('tenant_id', tenantId, true));
    const rows = await this.options.prisma.$queryRaw(Prisma.sql!`
      SELECT TOP (1) ${this.columns} FROM ${this.table} ${this.where(conditions)}
    `) as SqlServerAuditRow[];
    return rows[0] ? this.entry(rows[0]) : null;
  }

  private equal(column: string, value: string, prefix = false): unknown {
    const Prisma = this.Prisma;
    const field = Prisma.raw!(`[${column}]`);
    const exactField = Prisma.sql!`${field} COLLATE Latin1_General_100_BIN2`;
    const parameter = Prisma.sql!`CAST(${value} AS NVARCHAR(MAX)) COLLATE Latin1_General_100_BIN2`;
    const fullEquality = Prisma.sql!`${exactField} = ${parameter} AND DATALENGTH(${field}) = DATALENGTH(${parameter})`;
    // Exact, case-sensitive identifiers avoid linguistic collation equivalences.
    // DATALENGTH also distinguishes trailing spaces, which SQL equality pads.
    // The identical prefix expressions work before optional indexes are installed;
    // applying BIN2 before truncation keeps surrogate handling consistent too.
    return prefix
      ? Prisma.sql!`(CONVERT(NVARCHAR(128), ${exactField}) = CONVERT(NVARCHAR(128), ${parameter}) AND ${fullEquality})`
      : Prisma.sql!`(${fullEquality})`;
  }

  private where(conditions: unknown[]): unknown {
    return conditions.length
      ? this.Prisma.sql!`WHERE ${this.Prisma.join!(conditions, ' AND ')}`
      : this.Prisma.empty;
  }

  private utcDate(date: Date): string {
    return date.toISOString().slice(0, -1);
  }

  private entry(row: SqlServerAuditRow): AuditEntry {
    const { cursorTs, changes, metadata, ...fields } = row;
    return {
      ...fields,
      id: row.id.toLowerCase(),
      changes: changes === null ? null : JSON.parse(changes) as AuditEntry['changes'],
      metadata: metadata === null ? null : JSON.parse(metadata) as AuditEntry['metadata'],
      createdAt: new Date(cursorTs),
    };
  }
}
