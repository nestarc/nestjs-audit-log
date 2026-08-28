import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import { PrismaModuleLike } from '../src/prisma/prisma-namespace';
import { AuditMaintenanceService } from '../src/services/audit-maintenance.service';

function createPrismaNamespace(): PrismaModuleLike['Prisma'] {
  return {
    defineExtension: jest.fn(),
    sql: jest.fn(
      (
        strings: TemplateStringsArray | readonly string[],
        ...values: unknown[]
      ) => ({ strings: Array.from(strings), values }),
    ),
    raw: jest.fn((value: string) => ({ raw: value })),
    join: jest.fn(),
    empty: { empty: true },
  };
}

function createService(
  prisma: any,
  Prisma: PrismaModuleLike['Prisma'],
  tableName = 'audit_logs',
  overrides: Partial<AuditLogModuleOptions> = {},
): AuditMaintenanceService {
  const options: AuditLogModuleOptions = {
    prisma,
    actorExtractor: () => ({ id: null, type: 'system' }),
    ...overrides,
  };
  const tableRef = tableName === 'audit_logs' ? null : Prisma.raw!(tableName);
  return new AuditMaintenanceService(options, Prisma, tableName, tableRef);
}

describe('AuditMaintenanceService', () => {
  it('parses catalog partition bounds and qualifies targets for a schema table', async () => {
    const Prisma = createPrismaNamespace();
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionSchema: 'audit',
            partitionName: 'audit_logs_y2025m12',
            partitionBound:
              "FOR VALUES FROM ('2025-12-01 00:00:00+00') TO ('2026-01-01 00:00:00+00')",
          },
          {
            partitionSchema: 'audit',
            partitionName: 'audit_logs_y2026m01',
            partitionBound:
              "FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00')",
          },
          {
            partitionSchema: 'audit',
            partitionName: 'audit_logs_default',
            partitionBound: 'DEFAULT',
          },
          {
            partitionSchema: 'audit',
            partitionName: 'audit_logs_max',
            partitionBound:
              "FOR VALUES FROM ('2026-02-01 00:00:00+00') TO (MAXVALUE)",
          },
          {
            partitionSchema: 'audit',
            partitionName: 'audit_logs_unknown',
            partitionBound: null,
          },
        ]),
      $executeRawUnsafe: jest.fn(),
    };
    const service = createService(
      prisma,
      Prisma,
      'audit.audit_logs',
    );

    const result = await service.prune({
      olderThan: new Date('2026-01-01T00:00:00.000Z'),
      dryRun: true,
    });

    expect(result).toEqual({
      layout: 'partitioned',
      mode: 'drop',
      prunedPartitions: ['audit.audit_logs_y2025m12'],
      deletedRows: null,
      dryRun: true,
    });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('uses fully qualified identifiers when detaching a partition', async () => {
    const Prisma = createPrismaNamespace();
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionSchema: 'audit',
            partitionName: 'audit_logs_y2025m12',
            partitionBound:
              "FOR VALUES FROM ('2025-12-01 00:00:00+00') TO ('2026-01-01 00:00:00+00')",
          },
        ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(
      prisma,
      Prisma,
      'audit.audit_logs',
    );

    const result = await service.prune({
      olderThan: new Date('2026-02-01T00:00:00.000Z'),
      mode: 'detach',
    });

    expect(result.prunedPartitions).toEqual([
      'audit.audit_logs_y2025m12',
    ]);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      'ALTER TABLE audit.audit_logs DETACH PARTITION audit.audit_logs_y2025m12',
    );
  });

  it('keeps partition DDL unqualified for an unqualified parent table', async () => {
    const Prisma = createPrismaNamespace();
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionSchema: 'archive',
            partitionName: 'audit_logs_y2025m12',
            upperBound: '2026-01-01 00:00:00+00',
          },
        ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(prisma, Prisma);

    await service.prune({
      olderThan: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      'DROP TABLE audit_logs_y2025m12',
    );
  });

  it('reports an exact error when the first partition prune fails', async () => {
    const Prisma = createPrismaNamespace();
    const cause = 'partition locked';
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionSchema: 'public',
            partitionName: 'audit_logs_y2025m12',
            upperBound: '2026-01-01 00:00:00+00',
          },
        ]),
      $executeRawUnsafe: jest.fn().mockRejectedValue(cause),
    };
    const service = createService(prisma, Prisma);

    await expect(
      service.prune({
        olderThan: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      name: 'Error',
      message:
        "[@nestarc/audit-log] failed to prune partition 'audit_logs_y2025m12': partition locked; " +
        'already pruned: (none)',
      cause,
    });
  });

  it.each([
    {
      partitionSchema: 'audit',
      partitionName: 'audit_logs;drop',
      invalidName: 'audit_logs;drop',
    },
    {
      partitionSchema: 'audit-archive',
      partitionName: 'audit_logs_y2025m12',
      invalidName: 'audit-archive.audit_logs_y2025m12',
    },
  ])(
    'rejects an unsafe catalog identifier before partition DDL: $invalidName',
    async ({ partitionSchema, partitionName, invalidName }) => {
      const Prisma = createPrismaNamespace();
      const prisma = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ relkind: 'p' }])
          .mockResolvedValueOnce([
            {
              partitionSchema,
              partitionName,
              upperBound: '2026-01-01 00:00:00+00',
            },
          ]),
        $executeRawUnsafe: jest.fn(),
      };
      const service = createService(
        prisma,
        Prisma,
        'audit.audit_logs',
      );

      await expect(
        service.prune({
          olderThan: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({
        name: 'Error',
        message: expect.stringContaining(
          `Invalid audit tableName '${invalidName}'`,
        ),
      });
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    },
  );

  it('continues a plain flat prune when the warning logger throws', async () => {
    const Prisma = createPrismaNamespace();
    const warn = jest.fn(() => {
      throw new Error('logger unavailable');
    });
    const tx = { $executeRaw: jest.fn().mockResolvedValue(4) };
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ relkind: 'r' }])
        .mockResolvedValueOnce([{ exists: false }])
        .mockResolvedValueOnce([{ exists: false }]),
      $transaction: jest.fn(async (callback: (client: any) => unknown) =>
        callback(tx),
      ),
    };
    const service = createService(prisma, Prisma, 'audit_logs', {
      logger: { warn, error: jest.fn() },
    });

    const result = await service.prune({
      olderThan: new Date('2026-02-01T00:00:00.000Z'),
      timeoutMs: 1200,
      maxWaitMs: 300,
    });

    expect(result.deletedRows).toBe(4);
    expect(warn).toHaveBeenCalledWith(
      "[@nestarc/audit-log] append-only delete enforcement not found on 'audit_logs'; pruning with plain DELETE.",
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 1200, maxWait: 300 },
    );
  });
});
