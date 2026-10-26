import type { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import type { PrismaModuleLike } from '../src/prisma/prisma-namespace';
import { decodeAuditCursor, encodeAuditCursor } from '../src/services/audit-cursor';
import { AuditQueryService } from '../src/services/audit-query.service';
import { decodeSqlServerAuditCursor, encodeSqlServerAuditCursor } from '../src/services/audit-sqlserver-cursor';

type Fragment = { strings: readonly string[]; values: readonly unknown[] };

function compiled(fragment: unknown): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  function render(value: unknown): string {
    if (value && typeof value === 'object') {
      if ('strings' in value) {
        const sql = value as Fragment;
        return sql.strings.reduce((text, part, index) => text + part + (index < sql.values.length ? render(sql.values[index]) : ''), '');
      }
      if ('raw' in value) return String(value.raw);
      if ('join' in value && 'separator' in value) return (value.join as unknown[]).map(render).join(String(value.separator));
    }
    values.push(value);
    return `@p${values.length}`;
  }
  return { text: render(fragment).replace(/\s+/g, ' ').trim(), values };
}

function fixture(overrides: Partial<AuditLogModuleOptions> = {}) {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
  const Prisma = {
    defineExtension: jest.fn(),
    sql: (strings: TemplateStringsArray | readonly string[], ...values: unknown[]): Fragment => ({ strings, values }),
    raw: (raw: string) => ({ raw }),
    join: (join: readonly unknown[], separator = ',') => ({ join, separator }),
    empty: { raw: '' },
  } satisfies PrismaModuleLike['Prisma'];
  const options: AuditLogModuleOptions = {
    prisma, prismaModule: { Prisma }, provider: 'sqlserver',
    actorExtractor: () => ({ id: null, type: 'system' }),
    tenantResolver: () => 'ambient-tenant',
    ...overrides,
  };
  return { prisma, options, service: new AuditQueryService(options, Prisma, null) };
}

const idA = 'ffffffff-ffff-ffff-ffff-000000000001';
const idB = '00000000-0000-0000-0000-000000000002';
const timestamp = '2026-10-26T03:14:15.1234567Z';

function row(id = idA, cursorTs = timestamp) {
  return {
    id, cursorTs, tenantId: 'ambient-tenant', actorId: null, actorType: 'system', actorIp: null,
    action: 'invoice.approved', targetType: 'Invoice', targetId: 'invoice-1', source: 'manual',
    changes: '{"status":{"before":"draft","after":"approved"}}', metadata: '{"name":"한글😀"}', result: 'success',
  };
}

describe('SQL Server audit reads', () => {
  it('preserves bound full-value filters alongside optional-index expressions, parses JSON and counts beyond INT', async () => {
    const { prisma, service } = fixture({ tableName: 'history.events' });
    prisma.$queryRaw.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ count: 3_000_000_000n }]);
    const longId = '한글😀'.repeat(2000);
    const action = "invoice.approved'); DROP TABLE audit_logs; --";
    const result = await service.query({
      tenantId: longId, actorId: 'actor', actorType: 'user', action,
      targetType: 'Invoice', targetId: longId, source: 'manual', result: 'success',
      from: new Date('2026-10-25T01:00:00+09:00'), to: new Date('2026-10-27T01:00:00+09:00'),
      limit: 2, offset: 5,
    });
    const entries = compiled(prisma.$queryRaw.mock.calls[0][0]);
    const count = compiled(prisma.$queryRaw.mock.calls[1][0]);
    expect(entries.text).toContain('FROM [history].[events]');
    expect(entries.text).toContain('CONVERT(NVARCHAR(128), [tenant_id] COLLATE Latin1_General_100_BIN2)');
    expect(entries.text).toMatch(/AND \[tenant_id\] COLLATE Latin1_General_100_BIN2 = CAST\(@p\d+ AS NVARCHAR\(MAX\)\)/);
    expect(entries.text).toMatch(/AND \[target_id\] COLLATE Latin1_General_100_BIN2 = CAST\(@p\d+ AS NVARCHAR\(MAX\)\)/);
    expect(entries.text).toContain('DATALENGTH([tenant_id]) = DATALENGTH(');
    expect(entries.text).toContain('ORDER BY [created_at] DESC, [id] DESC');
    expect(entries.text).toMatch(/OFFSET @p\d+ ROWS FETCH NEXT @p\d+ ROWS ONLY/);
    expect(entries.text).not.toContain(action);
    expect(entries.text).not.toContain('__audit_');
    expect(entries.text).not.toContain('::');
    expect(entries.values).toEqual([
      longId, longId, longId, 'actor', 'actor', 'actor', 'user', 'user', action, action,
      'Invoice', 'Invoice', 'Invoice', longId, longId, longId, 'manual', 'manual', 'success', 'success',
      '2026-10-24T16:00:00.000', '2026-10-26T16:00:00.000', 5, 3,
    ]);
    expect(count.text).toContain('COUNT_BIG(*)');
    expect(count.values).toEqual(entries.values.slice(0, -2));
    expect(result).toEqual({
      entries: [{
        ...row(), cursorTs: undefined, changes: { status: { before: 'draft', after: 'approved' } },
        metadata: { name: '한글😀' }, createdAt: new Date('2026-10-26T03:14:15.123Z'),
      }], total: 3_000_000_000, hasMore: false, nextCursor: null,
    });
    expect(result.entries[0]).not.toHaveProperty('cursorTs');
  });

  it('keeps 100ns cursor precision and uses SQL Server UUID ordering without sorting rows in JavaScript', async () => {
    const { prisma, service } = fixture();
    // Native UNIQUEIDENTIFIER comparison orders these opposite to their strings.
    prisma.$queryRaw.mockResolvedValueOnce([row(idB), row(idA)]).mockResolvedValueOnce([{ count: 2n }]);
    const first = await service.query({ limit: 1 });
    expect(first.entries[0].id).toBe(idB);
    expect(first.hasMore).toBe(true);
    expect(decodeSqlServerAuditCursor(first.nextCursor!)).toEqual({ ts: timestamp, id: idB });
    prisma.$queryRaw.mockResolvedValueOnce([row(idA)]).mockResolvedValueOnce([{ count: 2n }]);
    const second = await service.query({ cursor: first.nextCursor!, limit: 1 });
    const entries = compiled(prisma.$queryRaw.mock.calls[2][0]);
    const count = compiled(prisma.$queryRaw.mock.calls[3][0]);
    expect(entries.text).toMatch(/\[created_at\] < CAST\(@p\d+ AS DATETIME2\(7\)\) OR/);
    expect(entries.text).toMatch(/\[id\] < CAST\(@p\d+ AS UNIQUEIDENTIFIER\)/);
    expect(entries.values).toEqual(['ambient-tenant', 'ambient-tenant', 'ambient-tenant', timestamp.slice(0, -1), timestamp.slice(0, -1), idB, 0, 2]);
    expect(count.values).toEqual(['ambient-tenant', 'ambient-tenant', 'ambient-tenant']);
    expect(second.entries[0].id).toBe(idA);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(2);
  });

  it('escapes SQL Server bracket classes and LIKE literals while treating only asterisks as wildcards', async () => {
    const { prisma, service } = fixture();
    await service.query({ action: 'Invoice.[ab]_%\\*', allTenants: true, includeTotal: false });
    const sql = compiled(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql.text).toContain("[action] COLLATE Latin1_General_100_BIN2 LIKE @p1 COLLATE Latin1_General_100_BIN2 ESCAPE '\\'");
    expect(sql.values).toEqual(['Invoice.\\[ab\\]\\_\\%\\\\%', 0, 51]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sql.text).not.toContain('tenant_id] =');
  });

  it('uses shared tenant resolution for lookup and returns parsed rows or null', async () => {
    const { prisma, service } = fixture({ tenantRequired: true });
    prisma.$queryRaw.mockResolvedValueOnce([row(idA.toUpperCase())]);
    const found = await service.getById(idA.toUpperCase());
    const sql = compiled(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql.text).toContain('SELECT TOP (1)');
    expect(sql.text).toContain('[id] = CAST(@p1 AS UNIQUEIDENTIFIER)');
    expect(sql.values).toEqual([idA, 'ambient-tenant', 'ambient-tenant', 'ambient-tenant']);
    expect(found?.id).toBe(idA);
    expect(found?.metadata).toEqual({ name: '한글😀' });
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.getById(idB, { tenantId: 'other-tenant' })).resolves.toBeNull();
    expect(compiled(prisma.$queryRaw.mock.calls[1][0]).values).toEqual([idB, 'other-tenant', 'other-tenant', 'other-tenant']);
  });

  it.each(['Tenant ', 'TENANT', 'ténant', `${'x'.repeat(127)}æ`])(
    'keeps exact tenant identifier %s intact and checks binary equality plus its complete byte length', async tenantId => {
      const { prisma, service } = fixture();
      await service.getById(idA, { tenantId });
      const sql = compiled(prisma.$queryRaw.mock.calls[0][0]);
      expect(sql.values).toEqual([idA, tenantId, tenantId, tenantId]);
      expect(sql.text).toContain('CONVERT(NVARCHAR(128), [tenant_id] COLLATE Latin1_General_100_BIN2)');
      expect(sql.text).toContain('[tenant_id] COLLATE Latin1_General_100_BIN2 = CAST(@p3 AS NVARCHAR(MAX)) COLLATE Latin1_General_100_BIN2');
      expect(sql.text).toContain('DATALENGTH([tenant_id]) = DATALENGTH(CAST(@p4 AS NVARCHAR(MAX)) COLLATE Latin1_General_100_BIN2)');
    },
  );

  it('supports nullable JSON and UTC timestamps with zero fractional seconds', async () => {
    const { prisma, service } = fixture();
    prisma.$queryRaw.mockResolvedValueOnce([{ ...row(idA, '2026-10-26T00:00:00.0000000Z'), changes: null, metadata: null }]);
    const result = await service.query({ includeTotal: false });
    expect(result.entries[0]).toMatchObject({ changes: null, metadata: null, createdAt: new Date('2026-10-26T00:00:00.000Z') });
    expect(result).not.toHaveProperty('total');
  });

  it('fails closed on tenant errors and invalid pagination before database reads', async () => {
    const failure = new Error('tenant unavailable');
    const tenantResolver = jest.fn(() => { throw failure; });
    const { prisma, service } = fixture({ tenantRequired: true, tenantResolver });
    await expect(service.query({})).rejects.toMatchObject({ cause: failure });
    await expect(service.getById(idA)).rejects.toMatchObject({ cause: failure });
    await expect(service.query({ tenantId: 'x', allTenants: true })).rejects.toThrow('mutually exclusive');
    await expect(service.query({ cursor: 'cursor', offset: 0 })).rejects.toThrow('mutually exclusive');
    await expect(service.query({ limit: 0 })).rejects.toThrow('positive integer');
    await expect(service.query({ offset: -1 })).rejects.toThrow('non-negative integer');
    await expect(service.getById('not-a-uuid')).resolves.toBeNull();
    expect(tenantResolver).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('allows explicit tenant or allTenants and warns once when optional ambient scope is missing', async () => {
    const tenantResolver = jest.fn(() => null);
    const logger = { warn: jest.fn(), error: jest.fn() };
    const strict = fixture({ tenantRequired: true, tenantResolver });
    await expect(strict.service.query({ includeTotal: false })).rejects.toThrow('tenant context required');
    await strict.service.query({ tenantId: '', includeTotal: false });
    await strict.service.query({ allTenants: true, includeTotal: false });
    expect(compiled(strict.prisma.$queryRaw.mock.calls[0][0]).values).toEqual(['', '', '', 0, 51]);
    expect(compiled(strict.prisma.$queryRaw.mock.calls[1][0]).values).toEqual([0, 51]);
    const optional = fixture({ tenantResolver, logger });
    await optional.service.query({ includeTotal: false });
    await optional.service.getById(idA);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-provider and malformed cursors before SQL', async () => {
    const { prisma, service } = fixture();
    const postgresCursor = encodeAuditCursor('2026-10-26T03:14:15.123456Z', idA);
    await expect(service.query({ cursor: postgresCursor })).rejects.toThrow('invalid SQL Server cursor');
    await expect(service.query({ cursor: 'not-a-cursor' })).rejects.toThrow('invalid SQL Server cursor');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    const postgres = fixture({ provider: 'postgresql' });
    await expect(postgres.service.query({ cursor: encodeSqlServerAuditCursor(timestamp, idA) })).rejects.toThrow('invalid cursor');
    expect(postgres.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not silently round a total that cannot be represented by the public number type', async () => {
    const { prisma, service } = fixture();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 9_007_199_254_740_993n }]);
    await expect(service.query({})).rejects.toThrow('safe integer range');
  });

  it('retains the selected provider even if the caller mutates its options', async () => {
    const { prisma, service, options } = fixture();
    options.provider = 'postgresql';
    await service.query({ includeTotal: false });
    expect(compiled(prisma.$queryRaw.mock.calls[0][0]).text).toContain('FETCH NEXT');
  });
});

describe('SQL Server audit cursors', () => {
  it('round-trips all seven digits and normalized UUIDs without a Date round trip', () => {
    const cursor = encodeSqlServerAuditCursor(timestamp, idA.toUpperCase());
    expect(decodeSqlServerAuditCursor(cursor)).toEqual({ ts: timestamp, id: idA });
    expect(() => decodeAuditCursor(cursor)).toThrow('invalid cursor');
  });

  it.each([
    '2026-10-26T03:14:15.123456Z', '2026-02-30T03:14:15.0000000Z', '0000-01-01T00:00:00.0000000Z',
    '2026-10-26T24:14:15.0000000Z', '2026-10-26T03:14:15.0000000+00:00',
  ])('rejects unsupported or invalid timestamp %s', ts => {
    expect(() => encodeSqlServerAuditCursor(ts, idA)).toThrow('invalid SQL Server cursor');
    expect(() => decodeSqlServerAuditCursor(Buffer.from(`mssql1|${ts}|${idA}`).toString('base64url'))).toThrow('invalid SQL Server cursor');
  });

  it.each(['', 'wrong-id', idA.toUpperCase()])('rejects malformed stored cursor IDs %s', id => {
    expect(() => decodeSqlServerAuditCursor(Buffer.from(`mssql1|${timestamp}|${id}`).toString('base64url'))).toThrow('invalid SQL Server cursor');
  });
});
