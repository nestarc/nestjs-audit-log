import { Readable } from 'node:stream';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import { PrismaModuleLike } from '../src/prisma/prisma-namespace';
import { AuditContext } from '../src/services/audit-context';
import { AuditMaintenanceService } from '../src/services/audit-maintenance.service';
import { AuditScanService } from '../src/services/audit-scan.service';
import { AuditService } from '../src/services/audit.service';

interface SqlFragment {
  strings: readonly string[];
  values: unknown[];
}

function fixture(overrides: Partial<AuditLogModuleOptions> = {}) {
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
  };
  const Prisma = {
    defineExtension: jest.fn(),
    sql: jest.fn((strings: TemplateStringsArray | readonly string[], ...values: unknown[]): SqlFragment => ({
      strings: Array.from(strings), values,
    })),
    raw: jest.fn((value: string) => ({ raw: value })),
    join: jest.fn(),
    empty: {},
  } satisfies PrismaModuleLike['Prisma'];
  const options: AuditLogModuleOptions = {
    provider: 'sqlserver',
    prisma,
    prismaModule: { Prisma },
    actorExtractor: () => ({ id: null, type: 'system' }),
    ...overrides,
  };
  const service = new AuditService(options);
  return { prisma, Prisma, options, service };
}

function expectNoDatabaseCalls(prisma: ReturnType<typeof fixture>['prisma']): void {
  for (const method of Object.values(prisma)) expect(method).not.toHaveBeenCalled();
}

async function consumeStream(stream: Readable, chunks: unknown[]): Promise<void> {
  for await (const chunk of stream) chunks.push(chunk);
}

describe('SQL Server manual audit service', () => {
  it.each([
    [undefined, '[dbo].[audit_logs]'],
    ['Audit.Events', '[Audit].[Events]'],
    ['order', '[dbo].[order]'],
  ])('quotes the configured table %s and binds all event values', async (tableName, expectedTable) => {
    const { service, Prisma, prisma } = fixture({ tableName });
    const action = "invoice.approved'); DROP TABLE invoices; --";
    await service.log({ action, targetType: 'Invoice', targetId: 'invoice-한글😀' });

    expect(Prisma.raw).toHaveBeenCalledWith(expectedTable);
    const sql = prisma.$executeRaw.mock.calls[0][0] as SqlFragment;
    expect(sql.strings.join('')).toContain('INSERT INTO');
    expect(sql.strings.join('')).not.toContain('::jsonb');
    expect(sql.strings.join('')).not.toContain(action);
    expect(sql.values).toEqual([
      { raw: expectedTable }, null, null, 'system', null, action,
      'Invoice', 'invoice-한글😀', 'manual', null, 'success',
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('awaits the supplied transaction write and never falls back to the base client', async () => {
    const { service, prisma } = fixture();
    let resolveWrite!: (value: number) => void;
    const write = new Promise<number>(resolve => { resolveWrite = resolve; });
    const tx = { $executeRaw: jest.fn().mockReturnValue(write) };
    let completed = false;
    const completion = service.log({ action: 'invoice.approved' }, tx).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expectNoDatabaseCalls(prisma);
    resolveWrite(1);
    await completion;
    expect(completed).toBe(true);
  });

  it('propagates the original transaction SQL error without retry or base-client writes', async () => {
    const { service, prisma } = fixture();
    const failure = new Error('SQL constraint failed');
    const tx = { $executeRaw: jest.fn().mockRejectedValue(failure) };
    await expect(service.log({ action: 'invoice.approved' }, tx)).rejects.toBe(failure);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expectNoDatabaseCalls(prisma);
  });

  it('preserves actor, tenant, context metadata, input precedence and redaction', async () => {
    const { service, prisma } = fixture({
      actorRequired: true,
      tenantRequired: true,
      tenantResolver: () => 'tenant-한글',
      sensitiveFields: ['password'],
      sensitiveFieldsByModel: { Invoice: ['account'] },
    });
    const text = '한글😀'.repeat(2000);
    await AuditContext.run({
      actor: { id: 'user-1', type: 'user', ip: '127.0.0.1' },
      noAudit: false,
      reason: 'context reason',
      metadata: { correlationId: 'request-1', precedence: 'context' },
    }, () => service.log({
      action: 'invoice.rejected', targetType: 'Invoice', targetId: 'invoice-1', result: 'failure',
      metadata: { precedence: 'input', password: 'secret', nested: { account: 'private' }, text },
    }));

    const { values } = prisma.$executeRaw.mock.calls[0][0] as SqlFragment;
    expect(values.slice(1, 9)).toEqual([
      'tenant-한글', 'user-1', 'user', '127.0.0.1', 'invoice.rejected', 'Invoice', 'invoice-1', 'manual',
    ]);
    expect(JSON.parse(values[9] as string)).toEqual({
      correlationId: 'request-1', reason: 'context reason', precedence: 'input',
      password: '[REDACTED]', nested: { account: '[REDACTED]' }, text,
    });
    expect(values[10]).toBe('failure');
  });

  it('keeps an empty metadata object as SQL NULL', async () => {
    const { service, prisma } = fixture();
    await service.log({ action: 'empty', metadata: {} });
    expect((prisma.$executeRaw.mock.calls[0][0] as SqlFragment).values[9]).toBeNull();
  });

  it('rejects missing required actor before any transaction SQL', async () => {
    const { service, prisma } = fixture({
      actorRequired: true,
      logger: { error: jest.fn(), warn: jest.fn() },
    });
    const tx = { $executeRaw: jest.fn() };
    await expect(service.log({ action: 'missing-actor' }, tx)).rejects.toThrow('actorRequired');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expectNoDatabaseCalls(prisma);
  });

  it('rejects required tenant resolution failure before any transaction SQL', async () => {
    const { service, prisma } = fixture({
      tenantRequired: true,
      tenantResolver: () => { throw new Error('Tenant unavailable'); },
    });
    const tx = { $executeRaw: jest.fn() };
    await expect(service.log({ action: 'missing-tenant' }, tx)).rejects.toThrow('tenant context required');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expectNoDatabaseCalls(prisma);
  });

  it('propagates JSON serialization failures before any transaction SQL', async () => {
    const { service, prisma } = fixture();
    const tx = { $executeRaw: jest.fn() };
    await expect(service.log({ action: 'invalid-json', metadata: { bigint: 1n } }, tx)).rejects.toThrow();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expectNoDatabaseCalls(prisma);
  });

  it('keeps omitted and explicit PostgreSQL providers on the original SQL path', async () => {
    const implicit = fixture({ provider: undefined });
    const explicit = fixture({ provider: 'postgresql' });
    for (const item of [implicit, explicit]) {
      await item.service.log({ action: 'postgres.event', metadata: { unchanged: true } });
    }
    const original = implicit.prisma.$executeRaw.mock.calls[0][0] as SqlFragment;
    expect(original.strings.join('')).toContain('INSERT INTO audit_logs');
    expect(original.strings.join('')).toContain('::jsonb');
    expect(original.values[8]).toBe('{"unchanged":true}');
    expect(explicit.prisma.$executeRaw.mock.calls[0][0]).toEqual(original);
    expect(implicit.Prisma.raw).not.toHaveBeenCalled();
    expect(explicit.Prisma.raw).not.toHaveBeenCalled();
  });

  it('rejects an invalid provider before resolving a Prisma namespace', () => {
    expect(() => new AuditService({
      provider: 'mysql' as never,
      prisma: {},
      prismaModule: { Prisma: {} } as PrismaModuleLike,
      actorExtractor: () => ({ id: null, type: 'system' }),
    })).toThrow('provider');
  });

  it.each(['bad-schema.events', 'dbo.events;DROP', 'a.b.c', `${'a'.repeat(129)}.events`])(
    'rejects invalid MSSQL table identifiers %s', tableName => {
      expect(() => fixture({ tableName })).toThrow();
    },
  );
});

describe('SQL Server unsupported service operations', () => {
  it('rejects prune with no database or resolver calls', async () => {
    const tenantResolver = jest.fn(() => 'tenant-1');
    const { service, prisma } = fixture({ tenantResolver });
    const otherClient = { $queryRaw: jest.fn(), $executeRaw: jest.fn(), $transaction: jest.fn() };
    const prune = service.prune({ olderThan: new Date(), client: otherClient });
    expect(prune).toBeInstanceOf(Promise);
    await expect(prune).rejects.toThrow('AuditService.prune');
    expect(tenantResolver).not.toHaveBeenCalled();
    expectNoDatabaseCalls(prisma);
    for (const method of Object.values(otherClient)) expect(method).not.toHaveBeenCalled();
  });

  it('rejects scan when the async iterable is consumed', async () => {
    const { service, prisma } = fixture();
    const scan = service.scan({ allTenants: true });
    expectNoDatabaseCalls(prisma);
    await expect(scan[Symbol.asyncIterator]().next()).rejects.toThrow('AuditService.scan');
    expectNoDatabaseCalls(prisma);
  });

  it('reports export rejection through the stream before emitting a BOM or header', async () => {
    const { service, prisma } = fixture();
    const chunks: unknown[] = [];
    const stream = service.exportCsv({ allTenants: true, includeBom: true });
    expect(stream).toBeInstanceOf(Readable);
    await expect(consumeStream(stream, chunks)).rejects.toThrow('AuditService.exportCsv');
    expect(chunks).toEqual([]);
    expectNoDatabaseCalls(prisma);
  });

  it('also guards directly constructed internal services and an injected CSV scan callback', async () => {
    const { options, Prisma, prisma } = fixture();
    const scan = new AuditScanService(options, Prisma, null);
    const maintenance = new AuditMaintenanceService(options, Prisma, 'audit_logs', null);
    const injectedScan = jest.fn();
    const chunks: unknown[] = [];
    await expect(maintenance.prune({ olderThan: new Date() })).rejects.toThrow('AuditService.prune');
    await expect(scan.scan({ allTenants: true })[Symbol.asyncIterator]().next()).rejects.toThrow('AuditService.scan');
    await expect(consumeStream(scan.exportCsv({ allTenants: true, includeBom: true }, injectedScan), chunks))
      .rejects.toThrow('AuditService.exportCsv');
    expect(injectedScan).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
    expectNoDatabaseCalls(prisma);
  });

  it('captures the provider at construction instead of trusting later option mutation', async () => {
    const { service, options, prisma } = fixture();
    options.provider = 'postgresql';
    await expect(service.prune({ olderThan: new Date() })).rejects.toThrow('sqlserver');
    await service.log({ action: 'still-mssql' });
    expect((prisma.$executeRaw.mock.calls[0][0] as SqlFragment).strings.join('')).not.toContain('::jsonb');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
