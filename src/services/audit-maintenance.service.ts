import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import { PrismaModuleLike } from '../prisma/prisma-namespace';
import { deriveAuditObjectNames } from '../sql';
import { validateAuditTableName } from '../sql/table-name';
import { decodeAuditCursor } from './audit-cursor';
import type {
  AuditPruneOptions,
  AuditPruneResult,
} from './audit.service';

type AuditPartitionRow = {
  partitionSchema: string;
  partitionName: string;
  upperBound?: string | Date | null;
  partitionBound?: string | null;
};

/** @internal */
export class AuditMaintenanceService {
  constructor(
    private readonly options: AuditLogModuleOptions,
    private readonly Prisma: PrismaModuleLike['Prisma'],
    private readonly tableName: string,
    private readonly tableRef: unknown | null,
  ) {}

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
    ) as AuditPartitionRow[];
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

  private qualifyPartitionName(row: AuditPartitionRow): string {
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

  private warn(message: string): void {
    try {
      (this.options.logger ?? console).warn(message);
    } catch {
      // Logging failures must not affect audit-log maintenance.
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
