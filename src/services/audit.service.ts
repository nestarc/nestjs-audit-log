import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUDIT_LOG_OPTIONS } from '../audit-log.constants';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import {
  AuditEntry,
  AuditQueryOptions,
  AuditQueryResult,
  ManualAuditLogInput,
} from '../interfaces/audit-entry.interface';
import { AuditContext } from './audit-context';
import { getTenantId } from '../utils/tenant';

@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_LOG_OPTIONS)
    private readonly options: AuditLogModuleOptions,
  ) {}

  async log(input: ManualAuditLogInput): Promise<void> {
    const actor = AuditContext.getActor();
    const tenantId = getTenantId();
    const metadataJson = input.metadata
      ? JSON.stringify(input.metadata)
      : null;

    await this.options.prisma.$executeRaw`
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
  }

  async query(options: AuditQueryOptions): Promise<AuditQueryResult> {
    const tenantId = getTenantId();
    const conditions: Prisma.Sql[] = [];

    if (tenantId) {
      conditions.push(Prisma.sql`tenant_id = ${tenantId}`);
    }
    if (options.actorId) {
      conditions.push(Prisma.sql`actor_id = ${options.actorId}`);
    }
    if (options.action) {
      if (options.action.includes('*')) {
        const pattern = options.action.replace(/\*/g, '%');
        conditions.push(Prisma.sql`action LIKE ${pattern}`);
      } else {
        conditions.push(Prisma.sql`action = ${options.action}`);
      }
    }
    if (options.targetType) {
      conditions.push(Prisma.sql`target_type = ${options.targetType}`);
    }
    if (options.targetId) {
      conditions.push(Prisma.sql`target_id = ${options.targetId}`);
    }
    if (options.from) {
      conditions.push(Prisma.sql`created_at >= ${options.from}`);
    }
    if (options.to) {
      conditions.push(Prisma.sql`created_at <= ${options.to}`);
    }

    const where =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const [entries, countResult] = await Promise.all([
      this.options.prisma.$queryRaw<AuditEntry[]>`
        SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
               actor_type AS "actorType", actor_ip AS "actorIp",
               action, target_type AS "targetType", target_id AS "targetId",
               source, changes, metadata, result, created_at AS "createdAt"
        FROM audit_logs ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.options.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) AS count FROM audit_logs ${where}
      `,
    ]);

    return {
      entries,
      total: Number(countResult[0].count),
    };
  }
}
