import { AuditService } from '../src/services/audit.service';
import { AuditContext } from '../src/services/audit-context';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import { AuditScanPage } from '../src/interfaces/audit-entry.interface';
import { decodeAuditCursor, encodeAuditCursor } from '../src/services/audit-cursor';

jest.mock('@prisma/client', () => ({
  Prisma: {
    defineExtension: jest.fn(),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    raw: (value: string) => ({ raw: value }),
    join: (values: readonly unknown[], separator = ',') => ({
      values,
      separator,
    }),
    empty: { empty: true },
  },
}));

const uuid1 = '11111111-1111-4111-8111-111111111111';
const uuid2 = '22222222-2222-4222-8222-222222222222';
const uuid3 = '33333333-3333-4333-8333-333333333333';

describe('AuditService', () => {
  let service: AuditService;
  let mockPrisma: any;
  let mockLogger: { warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    mockPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(),
    };
    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
    };

    const options: AuditLogModuleOptions = {
      prisma: mockPrisma,
      actorExtractor: () => ({ id: null, type: 'system' }),
      logger: mockLogger,
    };

    service = new AuditService(options);
  });

  describe('log()', () => {
    it('throws a helpful error for invalid tableName', () => {
      expect(
        () =>
          new AuditService({
            prisma: mockPrisma,
            actorExtractor: () => ({ id: null, type: 'system' }),
            tableName: 'audit-logs',
          }),
      ).toThrow('Invalid audit tableName');
    });

    it('inserts a manual audit log entry via $executeRaw', async () => {
      await AuditContext.run(
        { actor: { id: 'user-1', type: 'user', ip: '10.0.0.1' }, noAudit: false },
        () =>
          service.log({
            action: 'invoice.approved',
            targetId: 'inv-123',
            targetType: 'Invoice',
            metadata: { amount: 5000 },
          }),
      );

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('calls $executeRaw when no actor in context', async () => {
      await service.log({ action: 'system.startup' });
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('uses provided tx client instead of base prisma', async () => {
      const mockTx = { $executeRaw: jest.fn().mockResolvedValue(1) };
      await service.log({ action: 'invoice.approved' }, mockTx);
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('uses the provided prismaModule namespace to build manual insert SQL', async () => {
      const sql = jest.fn((
        strings: TemplateStringsArray | readonly string[],
        ...values: any[]
      ) => ({
        strings,
        values,
      }));
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        prismaModule: {
          Prisma: {
            defineExtension: jest.fn(),
            sql,
            join: jest.fn(),
            empty: { empty: true },
          },
        },
      });

      await customService.log({ action: 'system.startup' });

      expect(sql).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$executeRaw).toHaveBeenCalledWith(
        expect.objectContaining({
          strings: expect.any(Array),
          values: expect.any(Array),
        }),
      );
    });

    it('uses the configured tableName for manual insert SQL', async () => {
      const raw = jest.fn((value: string) => ({ raw: value }));
      const sql = jest.fn((
        strings: TemplateStringsArray | readonly string[],
        ...values: any[]
      ) => ({
        strings,
        values,
      }));
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tableName: 'audit.audit_logs',
        prismaModule: {
          Prisma: {
            defineExtension: jest.fn(),
            raw,
            sql,
            join: jest.fn(),
            empty: { empty: true },
          },
        },
      });

      await customService.log({ action: 'system.startup' });

      expect(raw).toHaveBeenCalledWith('audit.audit_logs');
      expect(sql.mock.results[0].value.values[0]).toEqual({
        raw: 'audit.audit_logs',
      });
    });

    it('uses module tenantResolver for manual logs', async () => {
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
        tenantResolver: () => 'tenant-1',
      });

      await customService.log({ action: 'system.startup' });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('redacts manual metadata using global and model-specific sensitive fields', async () => {
      const sql = jest.fn((
        strings: TemplateStringsArray | readonly string[],
        ...values: any[]
      ) => ({
        strings,
        values,
      }));
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        sensitiveFields: ['email'],
        sensitiveFieldsByModel: { User: ['ssn'] },
        prismaModule: {
          Prisma: {
            defineExtension: jest.fn(),
            sql,
            join: jest.fn(),
            empty: { empty: true },
          },
        },
      });

      await customService.log({
        action: 'user.updated',
        targetType: 'User',
        metadata: {
          email: 'alice@test.com',
          ssn: '123-45-6789',
          nested: { email: 'nested@test.com' },
        },
      });

      const metadataJson = sql.mock.results[0].value.values[8];
      expect(JSON.parse(metadataJson)).toEqual({
        email: '[REDACTED]',
        ssn: '[REDACTED]',
        nested: { email: '[REDACTED]' },
      });
    });

    it('merges context metadata and reason into manual metadata', async () => {
      const sql = jest.fn((
        strings: TemplateStringsArray | readonly string[],
        ...values: any[]
      ) => ({
        strings,
        values,
      }));
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        prismaModule: {
          Prisma: {
            defineExtension: jest.fn(),
            sql,
            join: jest.fn(),
            empty: { empty: true },
          },
        },
      });

      await AuditContext.run(
        {
          actor: null,
          noAudit: false,
          metadata: { correlationId: 'req-1', source: 'context' },
          reason: 'context reason',
        },
        () =>
          customService.log({
            action: 'manual.action',
            metadata: { source: 'input' },
          }),
      );

      const metadataJson = sql.mock.results[0].value.values[8];
      expect(JSON.parse(metadataJson)).toEqual({
        correlationId: 'req-1',
        reason: 'context reason',
        source: 'input',
      });
    });
  });

  describe('query()', () => {
    it('returns entries and total count', async () => {
      const mockEntries = [
        { id: uuid1, action: 'user.created', createdAt: new Date() },
      ];
      mockPrisma.$queryRaw
        .mockResolvedValueOnce(mockEntries)
        .mockResolvedValueOnce([{ count: 1n }]);

      const result = await service.query({ actorId: 'user-1' });

      expect(result.entries).toEqual(mockEntries);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('applies default limit and offset when none provided', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      const result = await service.query({});

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('fetches limit plus one, strips cursorTs, and encodes the returned last row as nextCursor', async () => {
      const rows = [
        {
          id: uuid1,
          action: 'a',
          createdAt: new Date('2026-06-11T03:14:17.000Z'),
          cursorTs: '2026-06-11T03:14:17.000001Z',
        },
        {
          id: uuid2,
          action: 'b',
          createdAt: new Date('2026-06-11T03:14:16.000Z'),
          cursorTs: '2026-06-11T03:14:16.000001Z',
        },
        {
          id: uuid3,
          action: 'c',
          createdAt: new Date('2026-06-11T03:14:15.000Z'),
          cursorTs: '2026-06-11T03:14:15.000001Z',
        },
      ];
      mockPrisma.$queryRaw
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ count: 3n }]);

      const result = await service.query({ limit: 2 });

      expect(result.entries).toEqual([
        {
          id: uuid1,
          action: 'a',
          createdAt: new Date('2026-06-11T03:14:17.000Z'),
        },
        {
          id: uuid2,
          action: 'b',
          createdAt: new Date('2026-06-11T03:14:16.000Z'),
        },
      ]);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(
        encodeAuditCursor('2026-06-11T03:14:16.000001Z', uuid2),
      );
      expect('cursorTs' in result.entries[0]).toBe(false);
    });

    it('omits COUNT and total when includeTotal=false', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);

      const result = await service.query({ includeTotal: false });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect('total' in result).toBe(false);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('throws before SQL when cursor and offset are both provided', async () => {
      await expect(
        service.query({
          cursor: encodeAuditCursor(
            '2026-06-11T03:14:15.926535Z',
            uuid1,
          ),
          offset: 0,
        }),
      ).rejects.toThrow(
        '[@nestarc/audit-log] cursor and offset are mutually exclusive. Pass only one.',
      );
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it.each([
      [{ limit: 0 }, '[@nestarc/audit-log] limit must be a positive integer.'],
      [{ limit: -1 }, '[@nestarc/audit-log] limit must be a positive integer.'],
      [{ limit: 1.5 }, '[@nestarc/audit-log] limit must be a positive integer.'],
      [{ limit: NaN }, '[@nestarc/audit-log] limit must be a positive integer.'],
      [{ offset: -1 }, '[@nestarc/audit-log] offset must be a non-negative integer.'],
      [{ offset: 1.5 }, '[@nestarc/audit-log] offset must be a non-negative integer.'],
    ])('validates pagination option %p', async (options, message) => {
      await expect(service.query(options as any)).rejects.toThrow(message);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('adds keyset conditions, deterministic ordering, and new filters', async () => {
      const customPrisma = {
        defineExtension: jest.fn(),
        sql: jest.fn((
          strings: TemplateStringsArray | readonly string[],
          ...values: any[]
        ) => ({ strings, values })),
        join: jest.fn((values: readonly any[], separator?: string) => ({
          values,
          separator,
        })),
        empty: { empty: true },
      };
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        prismaModule: { Prisma: customPrisma },
        logger: mockLogger,
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);

      await customService.query({
        actorId: 'user-1',
        actorType: 'api_key',
        source: 'auto',
        result: 'failure',
        cursor: encodeAuditCursor('2026-06-11T03:14:15.926535Z', uuid1),
        includeTotal: false,
      });

      const sqlTexts = customPrisma.sql.mock.calls.map((call) =>
        Array.from(call[0] as readonly string[]).join(''),
      );
      expect(sqlTexts).toEqual(
        expect.arrayContaining([
          expect.stringContaining('actor_type = '),
          expect.stringContaining('source = '),
          expect.stringContaining('result = '),
          expect.stringContaining('created_at <= '),
          expect.stringContaining('(created_at, id) <'),
          expect.stringContaining('ORDER BY created_at DESC, id DESC'),
        ]),
      );
    });

    it('escapes wildcard action filters with ESCAPE', async () => {
      const customPrisma = {
        defineExtension: jest.fn(),
        sql: jest.fn((
          strings: TemplateStringsArray | readonly string[],
          ...values: any[]
        ) => ({ strings, values })),
        join: jest.fn((values: readonly any[], separator?: string) => ({
          values,
          separator,
        })),
        empty: { empty: true },
      };
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        prismaModule: { Prisma: customPrisma },
        logger: mockLogger,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await customService.query({
        allTenants: true,
        action: 'discount_50.*',
      });

      const likeCall = customPrisma.sql.mock.calls.find((call) =>
        Array.from(call[0] as readonly string[]).join('').includes('action LIKE'),
      );
      expect(likeCall?.[1]).toBe('discount\\_50.%');
      expect(Array.from(likeCall?.[0] as readonly string[]).join('')).toContain(
        'ESCAPE',
      );
    });

    it('handles wildcard action filter', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({ action: 'user.*' });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('handles exact action filter (no wildcard)', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({ action: 'user.created' });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('handles targetType and targetId filters', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({ targetType: 'Invoice', targetId: 'inv-1' });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('handles from/to date range filters', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({
        from: new Date('2026-01-01'),
        to: new Date('2026-12-31'),
      });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('uses the provided prismaModule namespace to build query SQL', async () => {
      const customPrisma = {
        defineExtension: jest.fn(),
        sql: jest.fn((
          strings: TemplateStringsArray | readonly string[],
          ...values: any[]
        ) => ({ strings, values })),
        join: jest.fn((values: readonly any[], separator?: string) => ({
          values,
          separator,
        })),
        empty: { empty: true },
      };
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        prismaModule: { Prisma: customPrisma },
        logger: mockLogger,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await customService.query({ actorId: 'user-1' });

      expect(customPrisma.sql).toHaveBeenCalled();
      expect(customPrisma.join).toHaveBeenCalledWith(expect.any(Array), ' AND ');
      expect(mockPrisma.$queryRaw).toHaveBeenCalledWith(
        expect.objectContaining({
          strings: expect.any(Array),
          values: expect.any(Array),
        }),
      );
    });

    it('uses the configured tableName for query SQL', async () => {
      const customPrisma = {
        defineExtension: jest.fn(),
        raw: jest.fn((value: string) => ({ raw: value })),
        sql: jest.fn((
          strings: TemplateStringsArray | readonly string[],
          ...values: any[]
        ) => ({ strings, values })),
        join: jest.fn((values: readonly any[], separator?: string) => ({
          values,
          separator,
        })),
        empty: { empty: true },
      };
      const customService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tableName: 'audit.audit_logs',
        prismaModule: { Prisma: customPrisma },
        logger: mockLogger,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await customService.query({ allTenants: true });

      expect(customPrisma.raw).toHaveBeenCalledWith('audit.audit_logs');
      const values = customPrisma.sql.mock.results.flatMap(
        (result) => result.value.values,
      );
      expect(values).toEqual(
        expect.arrayContaining([
          { raw: 'audit.audit_logs' },
          { raw: 'audit.audit_logs' },
        ]),
      );
    });

    it('throws when tenantId and allTenants are both provided', async () => {
      await expect(
        service.query({ tenantId: 'tenant-1', allTenants: true }),
      ).rejects.toThrow('tenantId and allTenants are mutually exclusive');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('treats an empty explicit tenantId as mutually exclusive with allTenants', async () => {
      await expect(
        service.query({ tenantId: '', allTenants: true }),
      ).rejects.toThrow('tenantId and allTenants are mutually exclusive');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('allows explicit tenantId when tenantRequired is true and ambient tenant is missing', async () => {
      const strictService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await expect(
        strictService.query({ tenantId: 'tenant-1' }),
      ).resolves.toEqual({
        entries: [],
        total: 0,
        hasMore: false,
        nextCursor: null,
      });
    });

    it('allows explicit allTenants when tenantRequired is true and ambient tenant is missing', async () => {
      const strictService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
      });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await expect(
        strictService.query({ allTenants: true }),
      ).resolves.toEqual({
        entries: [],
        total: 0,
        hasMore: false,
        nextCursor: null,
      });
    });

    it('rejects runtime null tenantId before SQL execution', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(
        service.query({ tenantId: null, includeTotal: false } as any),
      ).rejects.toThrow('tenantId must be a string when provided');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('warns only once per service instance for unscoped queries', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }]);

      await service.query({});
      await service.query({});

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('query() executed without tenant scope'),
      );
    });
  });

  describe('scan() and exportCsv()', () => {
    const entry = (id: string, cursorTs: string, action = 'user.created') => ({
      id,
      tenantId: 'tenant-1',
      actorId: null,
      actorType: 'system',
      actorIp: null,
      action,
      targetType: 'User',
      targetId: id,
      source: 'manual' as const,
      changes: null,
      metadata: null,
      result: 'success' as const,
      createdAt: new Date(cursorTs),
      cursorTs,
    });

    it('streams forward pages under one fixed high-watermark without COUNT', async () => {
      const first = entry(uuid1, '2026-06-11T03:14:15.000001Z');
      const second = entry(uuid2, '2026-06-11T03:14:16.000001Z');
      const third = entry(uuid3, '2026-06-11T03:14:17.000001Z');
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ id: uuid3, cursorTs: third.cursorTs }])
        .mockResolvedValueOnce([first, second, third])
        .mockResolvedValueOnce([third]);

      const pages: AuditScanPage[] = [];
      for await (const page of service.scan({ tenantId: 'tenant-1', batchSize: 2 })) {
        pages.push(page);
      }

      expect(pages.map((page) => page.entries.map((item) => item.id))).toEqual([
        [uuid1, uuid2],
        [uuid3],
      ]);
      expect(pages[0].checkpoint).toBe(
        encodeAuditCursor(second.cursorTs, uuid2),
      );
      expect(pages[0].highWatermark).toBe(pages[1].highWatermark);
      expect(pages[0].highWatermark).toBe(
        encodeAuditCursor(third.cursorTs, uuid3),
      );
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect('cursorTs' in pages[0].entries[0]).toBe(false);
      const statements = mockPrisma.$queryRaw.mock.calls.map(
        (call: any[]) => Array.from(call[0].strings as readonly string[]).join(''),
      );
      expect(statements.join('\n')).not.toContain('COUNT(');
      expect(statements).toEqual(
        expect.arrayContaining([
          expect.stringContaining('ORDER BY created_at ASC, id ASC'),
        ]),
      );
    });

    it('yields one empty page with a resumable watermark for an empty scan', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);
      const pages: AuditScanPage[] = [];
      for await (const page of service.scan({ allTenants: true })) pages.push(page);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ entries: [], checkpoint: null });
      expect(pages[0].highWatermark).toEqual(expect.any(String));
      expect(() => decodeAuditCursor(pages[0].highWatermark)).not.toThrow();
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it.each([
      [{}, 'exactly one of tenantId or allTenants'],
      [{ tenantId: 'tenant-1', allTenants: true }, 'exactly one of tenantId or allTenants'],
      [{ tenantId: '' }, 'tenantId must be a non-empty string'],
      [{ allTenants: false }, 'allTenants must be true'],
      [{ allTenants: true, batchSize: 0 }, 'batchSize must be an integer between 1 and 10000'],
      [{ allTenants: true, from: new Date('invalid') }, 'from must be a valid Date'],
    ])('rejects invalid explicit export scope/options %#', (options, message) => {
      expect(() => service.scan(options as any)).toThrow(message);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('honors an already-aborted signal before querying', () => {
      const controller = new AbortController();
      controller.abort('stop');
      expect(() => service.scan({ allTenants: true, signal: controller.signal }))
        .toThrow(expect.objectContaining({ name: 'AbortError' }));
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean CSV BOM option before creating a stream', () => {
      expect(() =>
        service.exportCsv({ allTenants: true, includeBom: 'yes' } as any),
      ).toThrow('includeBom must be a boolean');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns a UTF-8 Readable with optional BOM, header, and streamed rows', async () => {
      const row = entry(uuid1, '2026-06-11T03:14:15.000001Z', '=formula');
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ id: uuid1, cursorTs: row.cursorTs }])
        .mockResolvedValueOnce([row]);

      const chunks: Buffer[] = [];
      for await (const chunk of service.exportCsv({ tenantId: 'tenant-1', includeBom: true })) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const csv = Buffer.concat(chunks).toString('utf8');
      expect(csv.startsWith('\uFEFFschemaVersion,id,tenantId')).toBe(true);
      expect(csv).toContain("'=formula");
      expect(csv.endsWith('\r\n')).toBe(true);
    });
  });

  describe('getById()', () => {
    it('returns null without SQL for invalid UUIDs', async () => {
      await expect(service.getById('not-a-uuid')).resolves.toBeNull();
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns a single audit entry for a valid UUID', async () => {
      const entry = {
        id: uuid1,
        tenantId: 'tenant-1',
        action: 'user.created',
        createdAt: new Date(),
      };
      mockPrisma.$queryRaw.mockResolvedValueOnce([entry]);

      await expect(
        service.getById(uuid1, { tenantId: 'tenant-1' }),
      ).resolves.toEqual(entry);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('throws when tenantId and allTenants are both provided', async () => {
      await expect(
        service.getById(uuid1, { tenantId: 'tenant-1', allTenants: true }),
      ).rejects.toThrow('tenantId and allTenants are mutually exclusive');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('treats an empty explicit tenantId as mutually exclusive with allTenants', async () => {
      await expect(
        service.getById(uuid1, { tenantId: '', allTenants: true }),
      ).rejects.toThrow('tenantId and allTenants are mutually exclusive');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('rejects runtime null tenantId before SQL execution', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(
        service.getById(uuid1, { tenantId: null } as any),
      ).rejects.toThrow('tenantId must be a string when provided');
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('throws with the query tenant message when tenantRequired and no tenant scope', async () => {
      const strictService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
      });

      await expect(strictService.getById(uuid1)).rejects.toThrow(
        'tenant context required but not available. Pass an explicit tenantId or allTenants option',
      );
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('tenantRequired', () => {
    let strictService: AuditService;

    beforeEach(() => {
      strictService = new AuditService({
        prisma: mockPrisma,
        actorExtractor: () => ({ id: null, type: 'system' }),
        tenantRequired: true,
      });
    });

    it('throws on log() when tenantRequired is true and no tenant', async () => {
      await expect(
        strictService.log({ action: 'test.action' }),
      ).rejects.toThrow('tenant context required');
    });

    it('throws on query() when tenantRequired is true and no tenant', async () => {
      await expect(
        strictService.query({}),
      ).rejects.toThrow('tenant context required');
    });
  });

  describe('prune()', () => {
    it.each([
      [{ olderThan: new Date('invalid') }, 'olderThan'],
      [{ olderThan: new Date(), timeoutMs: 0 }, 'timeoutMs'],
      [{ olderThan: new Date(), timeoutMs: 1.5 }, 'timeoutMs'],
      [{ olderThan: new Date(), maxWaitMs: -1 }, 'maxWaitMs'],
    ])('rejects invalid maintenance input before querying: %s', async (input, message) => {
      await expect(service.prune(input as any)).rejects.toThrow(message);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('deletes old rows on flat trigger-enforced tables inside a transaction', async () => {
      const tx = {
        $executeRaw: jest
          .fn()
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(0),
      };
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ relkind: 'r' }])
        .mockResolvedValueOnce([{ exists: true }]);
      mockPrisma.$transaction = jest.fn(async (fn: any) => fn(tx));

      const olderThan = new Date('2026-01-01T00:00:00.000Z');
      const result = await service.prune({ olderThan });

      expect(result).toEqual({
        layout: 'flat',
        mode: 'delete',
        prunedPartitions: [],
        deletedRows: 3,
        dryRun: false,
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { timeout: 60000, maxWait: 10000 },
      );
      expect(
        mockPrisma.$queryRaw.mock.calls[0][0].strings.join(''),
      ).toContain('relkind::text AS relkind');
      expect(
        mockPrisma.$queryRaw.mock.calls[1][0].strings.join(''),
      ).toContain('tgrelid = to_regclass');
      expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    });

    it('uses dryRun count for flat tables without deleting', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ relkind: 'r' }])
        .mockResolvedValueOnce([{ count: 5n }]);
      mockPrisma.$transaction = jest.fn();

      const result = await service.prune({
        olderThan: new Date('2026-01-01T00:00:00.000Z'),
        dryRun: true,
      });

      expect(result.deletedRows).toBe(5);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws when the audit table does not exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(
        service.prune({ olderThan: new Date('2026-01-01T00:00:00.000Z') }),
      ).rejects.toThrow('audit table');
    });

    it('dry-runs partitioned pruning using only partitions whose upper bound is old enough', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionName: 'audit_logs_y2025m12',
            upperBound: '2026-01-01 00:00:00+00',
          },
          {
            partitionName: 'audit_logs_y2026m01',
            upperBound: '2026-02-01 00:00:00+00',
          },
        ]);
      mockPrisma.$executeRawUnsafe = jest.fn();

      const result = await service.prune({
        olderThan: new Date('2026-01-15T00:00:00.000Z'),
        dryRun: true,
      });

      expect(result).toEqual({
        layout: 'partitioned',
        mode: 'drop',
        prunedPartitions: ['audit_logs_y2025m12'],
        deletedRows: null,
        dryRun: true,
      });
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('rejects invalid partition prune modes instead of defaulting to drop', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionName: 'audit_logs_y2025m12',
            upperBound: '2026-01-01 00:00:00+00',
          },
        ]);
      mockPrisma.$executeRawUnsafe = jest.fn();

      await expect(
        service.prune({
          olderThan: new Date('2026-02-01T00:00:00.000Z'),
          mode: 'detatch' as any,
        }),
      ).rejects.toThrow('prune mode must be either drop or detach');
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('drops old partitions by default on partitioned tables', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionName: 'audit_logs_y2025m12',
            upperBound: '2026-01-01 00:00:00+00',
          },
        ]);
      mockPrisma.$executeRawUnsafe = jest.fn().mockResolvedValue(undefined);

      const result = await service.prune({
        olderThan: new Date('2026-02-01T00:00:00.000Z'),
      });

      expect(result.prunedPartitions).toEqual(['audit_logs_y2025m12']);
      expect(result.mode).toBe('drop');
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
        'DROP TABLE audit_logs_y2025m12',
      );
    });

    it('reports successful partition pruning before a later partition failure', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ relkind: 'p' }])
        .mockResolvedValueOnce([
          {
            partitionName: 'audit_logs_y2025m11',
            upperBound: '2025-12-01 00:00:00+00',
          },
          {
            partitionName: 'audit_logs_y2025m12',
            upperBound: '2026-01-01 00:00:00+00',
          },
        ]);
      mockPrisma.$executeRawUnsafe = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('locked'));

      await expect(
        service.prune({
          olderThan: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow('already pruned: audit_logs_y2025m11');
    });

    it('temporarily drops and recreates legacy delete RULEs on flat tables', async () => {
      const tx = {
        $executeRaw: jest
          .fn()
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(4)
          .mockResolvedValueOnce(0),
      };
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ relkind: 'r' }])
        .mockResolvedValueOnce([{ exists: false }])
        .mockResolvedValueOnce([{ exists: true }]);
      mockPrisma.$transaction = jest.fn(async (fn: any) => fn(tx));

      const result = await service.prune({
        olderThan: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(result.deletedRows).toBe(4);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
      expect(
        mockPrisma.$queryRaw.mock.calls[2][0].strings.join(''),
      ).toContain('ev_class = to_regclass');
    });
  });
});
