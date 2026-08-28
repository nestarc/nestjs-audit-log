import {
  AuditCsvOptions,
  AuditEntry,
  AuditScanOptions,
  AuditScanPage,
} from '../src/interfaces/audit-entry.interface';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import { PrismaModuleLike } from '../src/prisma/prisma-namespace';
import { encodeAuditCursor } from '../src/services/audit-cursor';
import { AuditQueryService } from '../src/services/audit-query.service';
import { AuditScanService } from '../src/services/audit-scan.service';

type SqlFragment = {
  strings: readonly string[];
  values: readonly unknown[];
};

type JoinFragment = {
  kind: 'join';
  values: readonly unknown[];
  separator: string;
};

const uuid1 = '11111111-1111-4111-8111-111111111111';
const uuid2 = '22222222-2222-4222-8222-222222222222';
const uuid3 = '33333333-3333-4333-8333-333333333333';
const uuid4 = '44444444-4444-4444-8444-444444444444';

function createPrismaNamespace() {
  return {
    defineExtension: jest.fn(),
    sql: jest.fn(
      (
        strings: TemplateStringsArray | readonly string[],
        ...values: unknown[]
      ): SqlFragment => ({ strings: Array.from(strings), values }),
    ),
    join: jest.fn(
      (
        values: readonly unknown[],
        separator = ',',
      ): JoinFragment => ({ kind: 'join', values, separator }),
    ),
    empty: { kind: 'empty' },
  } satisfies PrismaModuleLike['Prisma'];
}

function createOptions(
  prisma: { $queryRaw: jest.Mock },
  overrides: Partial<AuditLogModuleOptions> = {},
): AuditLogModuleOptions {
  return {
    prisma,
    actorExtractor: () => ({ id: null, type: 'system' }),
    ...overrides,
  };
}

function entry(
  id: string,
  cursorTs: string,
  action = 'read.test',
): AuditEntry & { cursorTs: string } {
  return {
    id,
    tenantId: 'tenant-1',
    actorId: null,
    actorType: 'system',
    actorIp: null,
    action,
    targetType: 'User',
    targetId: id,
    source: 'manual',
    changes: null,
    metadata: null,
    result: 'success',
    createdAt: new Date(cursorTs),
    cursorTs,
  };
}

function stripCursorTs({
  cursorTs: _cursorTs,
  ...auditEntry
}: AuditEntry & { cursorTs: string }): AuditEntry {
  return auditEntry;
}

function isSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    'strings' in value &&
    Array.isArray((value as SqlFragment).strings) &&
    'values' in value &&
    Array.isArray((value as SqlFragment).values)
  );
}

function isJoinFragment(value: unknown): value is JoinFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'join'
  );
}

function renderSql(value: unknown): string {
  if (isSqlFragment(value)) {
    return value.strings.reduce(
      (rendered, part, index) =>
        `${rendered}${part}${
          index < value.values.length ? renderSql(value.values[index]) : ''
        }`,
      '',
    );
  }
  if (isJoinFragment(value)) {
    return value.values.map(renderSql).join(value.separator);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'empty'
  ) {
    return '';
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizedSql(value: unknown): string {
  return renderSql(value).replace(/\s+/g, ' ').trim();
}

describe('internal audit read services', () => {
  describe('AuditQueryService', () => {
    it('keeps tenant/base filters in entries and COUNT while applying the cursor only to entries', async () => {
      const Prisma = createPrismaNamespace();
      const cursor = encodeAuditCursor(
        '2026-08-28T12:00:04.000004Z',
        uuid4,
      );
      const rows = [
        entry(uuid1, '2026-08-28T12:00:03.000003Z'),
        entry(uuid2, '2026-08-28T12:00:02.000002Z'),
        entry(uuid3, '2026-08-28T12:00:01.000001Z'),
      ];
      const prisma = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce(rows)
          .mockResolvedValueOnce([{ count: 9n }]),
      };
      const service = new AuditQueryService(
        createOptions(prisma),
        Prisma,
        null,
      );

      const result = await service.query({
        tenantId: 'tenant-1',
        actorId: 'actor-1',
        cursor,
        limit: 2,
      });

      const entriesSql = normalizedSql(prisma.$queryRaw.mock.calls[0][0]);
      const countSql = normalizedSql(prisma.$queryRaw.mock.calls[1][0]);
      expect(entriesSql).toContain('tenant_id = tenant-1');
      expect(entriesSql).toContain('actor_id = actor-1');
      expect(entriesSql).toContain('created_at <= 2026-08-28T12:00:04.000004Z');
      expect(entriesSql).toContain('(created_at, id) <');
      expect(entriesSql).toContain('ORDER BY created_at DESC, id DESC');
      expect(entriesSql).toContain('LIMIT 3');
      expect(countSql).toContain('tenant_id = tenant-1');
      expect(countSql).toContain('actor_id = actor-1');
      expect(countSql).not.toContain('(created_at, id) <');
      expect(countSql).not.toContain('created_at <=');

      expect(result).toEqual({
        entries: rows.slice(0, 2).map(({ cursorTs: _cursorTs, ...row }) => row),
        hasMore: true,
        nextCursor: encodeAuditCursor(rows[1].cursorTs, uuid2),
        total: 9,
      });
    });

    it('returns null for an invalid UUID before resolving tenant scope or executing SQL', async () => {
      const Prisma = createPrismaNamespace();
      const tenantResolver = jest.fn(() => 'tenant-1');
      const prisma = { $queryRaw: jest.fn() };
      const service = new AuditQueryService(
        createOptions(prisma, { tenantRequired: true, tenantResolver }),
        Prisma,
        null,
      );

      await expect(service.getById('not-a-uuid')).resolves.toBeNull();

      expect(tenantResolver).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(Prisma.sql).not.toHaveBeenCalled();
    });

    it('preserves a strict tenant resolver failure as the query error cause', async () => {
      const Prisma = createPrismaNamespace();
      const resolverError = new Error('tenant lookup failed');
      const tenantResolver = jest.fn(() => {
        throw resolverError;
      });
      const prisma = { $queryRaw: jest.fn() };
      const service = new AuditQueryService(
        createOptions(prisma, { tenantRequired: true, tenantResolver }),
        Prisma,
        null,
      );

      await expect(service.query({})).rejects.toMatchObject({
        message: expect.stringContaining('tenant context required'),
        cause: resolverError,
      });
      expect(tenantResolver).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('AuditScanService', () => {
    it('streams multiple forward pages under one fixed tenant-scoped high-watermark', async () => {
      const Prisma = createPrismaNamespace();
      const first = entry(uuid1, '2026-08-28T12:00:01.000001Z');
      const second = entry(uuid2, '2026-08-28T12:00:02.000002Z');
      const third = entry(uuid3, '2026-08-28T12:00:03.000003Z');
      const prisma = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: uuid3, cursorTs: third.cursorTs }])
          .mockResolvedValueOnce([first, second, third])
          .mockResolvedValueOnce([third]),
      };
      const service = new AuditScanService(
        createOptions(prisma),
        Prisma,
        null,
      );

      const pages: AuditScanPage[] = [];
      for await (const page of service.scan({
        tenantId: 'tenant-1',
        batchSize: 2,
      })) {
        pages.push(page);
      }

      const highWatermark = encodeAuditCursor(third.cursorTs, uuid3);
      expect(pages).toEqual([
        {
          entries: [first, second].map(({ cursorTs: _cursorTs, ...row }) => row),
          checkpoint: encodeAuditCursor(second.cursorTs, uuid2),
          highWatermark,
        },
        {
          entries: [third].map(({ cursorTs: _cursorTs, ...row }) => row),
          checkpoint: highWatermark,
          highWatermark,
        },
      ]);

      const statements = prisma.$queryRaw.mock.calls.map(([sql]) =>
        normalizedSql(sql),
      );
      expect(statements).toHaveLength(3);
      expect(statements[0]).toContain('ORDER BY created_at DESC, id DESC');
      expect(statements[1]).toContain('ORDER BY created_at ASC, id ASC');
      expect(statements[2]).toContain('ORDER BY created_at ASC, id ASC');
      expect(statements.every((sql) => sql.includes('tenant_id = tenant-1'))).toBe(
        true,
      );
      expect(statements.join('\n')).not.toContain('COUNT(');
    });

    it('preserves the abort reason after high-watermark resolution and skips the batch query', async () => {
      const Prisma = createPrismaNamespace();
      const controller = new AbortController();
      const reason = new Error('stop after high-watermark');
      const prisma = {
        $queryRaw: jest.fn().mockImplementationOnce(() => {
          controller.abort(reason);
          return Promise.resolve([
            {
              id: uuid1,
              cursorTs: '2026-08-28T12:00:01.000001Z',
            },
          ]);
        }),
      };
      const service = new AuditScanService(
        createOptions(prisma),
        Prisma,
        null,
      );
      const iterator = service.scan({
        allTenants: true,
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toMatchObject({
        name: 'AbortError',
        cause: reason,
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(normalizedSql(prisma.$queryRaw.mock.calls[0][0])).toContain(
        'ORDER BY created_at DESC, id DESC',
      );
    });

    it('builds every scan filter for wildcard actions and keeps exact actions on equality', async () => {
      const Prisma = createPrismaNamespace();
      const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
      const service = new AuditScanService(
        createOptions(prisma),
        Prisma,
        null,
      );
      const after = encodeAuditCursor(
        '2026-08-28T12:00:01.000001Z',
        uuid1,
      );
      const until = encodeAuditCursor(
        '2026-08-28T12:00:03.000003Z',
        uuid3,
      );

      const wildcardPages: AuditScanPage[] = [];
      for await (const page of service.scan({
        tenantId: 'tenant-1',
        actorId: 'actor-1',
        action: 'audit_*.done',
        targetType: 'User',
        targetId: 'user-1',
        from: new Date('2026-08-28T00:00:00.000Z'),
        to: new Date('2026-08-29T00:00:00.000Z'),
        after,
        until,
      })) {
        wildcardPages.push(page);
      }

      const exactPages: AuditScanPage[] = [];
      for await (const page of service.scan({
        allTenants: true,
        action: 'audit.done',
      })) {
        exactPages.push(page);
      }

      expect(wildcardPages).toEqual([
        { entries: [], checkpoint: null, highWatermark: after },
      ]);
      expect(exactPages).toHaveLength(1);
      const wildcardSql = normalizedSql(prisma.$queryRaw.mock.calls[0][0]);
      const exactSql = normalizedSql(prisma.$queryRaw.mock.calls[1][0]);
      expect(wildcardSql).toContain('tenant_id = tenant-1');
      expect(wildcardSql).toContain('actor_id = actor-1');
      expect(wildcardSql).toContain('action LIKE audit\\_%.done');
      expect(wildcardSql).toContain('target_type = User');
      expect(wildcardSql).toContain('target_id = user-1');
      expect(wildcardSql).toContain('created_at >= 2026-08-28T00:00:00.000Z');
      expect(wildcardSql).toContain('created_at <= 2026-08-29T00:00:00.000Z');
      expect(wildcardSql).toContain('(created_at, id) >');
      expect(wildcardSql).toContain('(created_at, id) <=');
      expect(exactSql).toContain('action = audit.done');
      expect(exactSql).not.toContain('action LIKE');
    });

    it('uses its default scan callback and emits only the header for an empty export', async () => {
      const Prisma = createPrismaNamespace();
      const prisma = { $queryRaw: jest.fn().mockResolvedValueOnce([]) };
      const service = new AuditScanService(
        createOptions(prisma),
        Prisma,
        null,
      );

      const csvStream = service.exportCsv({ allTenants: true, columns: 'v1' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();

      const chunks: Buffer[] = [];
      for await (const chunk of csvStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const csv = Buffer.concat(chunks).toString('utf8');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(normalizedSql(prisma.$queryRaw.mock.calls[0][0])).toContain(
        'ORDER BY created_at DESC, id DESC',
      );
      expect(csv.startsWith('schemaVersion,id,tenantId,actorId')).toBe(true);
      expect(csv.startsWith('\uFEFF')).toBe(false);
      expect(csv.split('\r\n')).toHaveLength(2);
    });

    it('invokes the supplied scan callback lazily and preserves the BOM/header stream', async () => {
      const Prisma = createPrismaNamespace();
      const prisma = { $queryRaw: jest.fn() };
      const service = new AuditScanService(
        createOptions(prisma),
        Prisma,
        null,
      );
      const row = entry(
        uuid1,
        '2026-08-28T12:00:01.000001Z',
        'export.callback',
      );
      const scan = jest.fn(
        (_options: AuditScanOptions): AsyncIterable<AuditScanPage> =>
          (async function* () {
            yield {
              entries: [stripCursorTs(row)],
              checkpoint: encodeAuditCursor(row.cursorTs, row.id),
              highWatermark: encodeAuditCursor(row.cursorTs, row.id),
            };
          })(),
      );
      const options: AuditCsvOptions = {
        tenantId: 'tenant-1',
        includeBom: true,
        columns: 'v1',
      };

      const csvStream = service.exportCsv(options, scan);
      expect(scan).not.toHaveBeenCalled();

      const chunks: Buffer[] = [];
      for await (const chunk of csvStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const csv = Buffer.concat(chunks).toString('utf8');

      expect(scan).toHaveBeenCalledTimes(1);
      expect(scan).toHaveBeenCalledWith(options);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(csv.startsWith('\uFEFFschemaVersion,id,tenantId,actorId')).toBe(true);
      expect(csv).toContain('export.callback');
      expect(csv.endsWith('\r\n')).toBe(true);
    });
  });
});
