import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_LOG_OPTIONS } from '../audit-log.constants';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import {
  AuditEntry,
  AuditQueryOptions,
  AuditQueryResult,
  ManualAuditLogInput,
} from '../interfaces/audit-entry.interface';
import { AuditContext } from './audit-context';
import { resolveTenantId } from '../utils/tenant';
import { resolvePrismaNamespace } from '../prisma/prisma-namespace';
import { getSensitiveFieldsFor, redactObject } from '../prisma/diff';
import { validateAuditTableName } from '../sql/table-name';

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
    let tenantId: string | null = null;
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
    const metadata = input.metadata
      ? redactObject(
          input.metadata,
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
    const Prisma = this.Prisma;
    const conditions: unknown[] = [];
    const tenantId = this.resolveQueryTenantId(options);

    if (tenantId) {
      conditions.push(Prisma.sql!`tenant_id = ${tenantId}`);
    }
    if (options.actorId) {
      conditions.push(Prisma.sql!`actor_id = ${options.actorId}`);
    }
    if (options.action) {
      if (options.action.includes('*')) {
        const pattern = options.action.replace(/\*/g, '%');
        conditions.push(Prisma.sql!`action LIKE ${pattern}`);
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

    const where =
      conditions.length > 0
        ? Prisma.sql!`WHERE ${Prisma.join!(conditions, ' AND ')}`
        : Prisma.empty;

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const entriesSql = this.tableRef
      ? Prisma.sql!`
        SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
               actor_type AS "actorType", actor_ip AS "actorIp",
               action, target_type AS "targetType", target_id AS "targetId",
               source, changes, metadata, result, created_at AS "createdAt"
        FROM ${this.tableRef} ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
      : Prisma.sql!`
        SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
               actor_type AS "actorType", actor_ip AS "actorIp",
               action, target_type AS "targetType", target_id AS "targetId",
               source, changes, metadata, result, created_at AS "createdAt"
        FROM audit_logs ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    const countSql = this.tableRef
      ? Prisma.sql!`
        SELECT COUNT(*) AS count FROM ${this.tableRef} ${where}
      `
      : Prisma.sql!`
        SELECT COUNT(*) AS count FROM audit_logs ${where}
      `;

    const [entries, countResult] = await Promise.all([
      this.options.prisma.$queryRaw(entriesSql) as Promise<AuditEntry[]>,
      this.options.prisma.$queryRaw(countSql) as Promise<[{ count: bigint }]>,
    ]);

    return {
      entries,
      total: Number(countResult[0].count),
    };
  }

  private resolveQueryTenantId(options: AuditQueryOptions): string | null {
    if (options.tenantId && options.allTenants) {
      throw new TypeError(
        '[@nestarc/audit-log] tenantId and allTenants are mutually exclusive.',
      );
    }

    if (options.tenantId) {
      return options.tenantId;
    }

    if (options.allTenants) {
      return null;
    }

    let tenantId: string | null = null;
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

    if (tenantId) {
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
}
