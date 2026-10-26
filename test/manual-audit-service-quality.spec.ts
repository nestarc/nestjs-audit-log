import { AuditContext } from '../src/services/audit-context';
import { AuditService } from '../src/services/audit.service';
import { AuditInputError } from '../src/services/manual-audit-validation';
import type { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';
import type { AuditOperationEvent } from '../src/interfaces/audit-shared-options.interface';

function fixture(overrides: Partial<AuditLogModuleOptions> = {}) {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(1), $queryRaw: jest.fn() };
  const onAuditError = jest.fn();
  const onAuditOperation = jest.fn();
  const options: AuditLogModuleOptions = {
    prisma, actorExtractor: () => ({ id: null, type: 'system' }),
    prismaModule: { Prisma: {
      defineExtension: jest.fn(), raw: (value: string) => value,
      sql: (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => ({ strings, values }),
      join: jest.fn(), empty: {},
    } },
    onAuditError, onAuditOperation, logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
  return { prisma, onAuditError, onAuditOperation, options, service: new AuditService(options) };
}

describe('manual service diagnostics and strict policy', () => {
  it('reports a throwing DTO accessor once without re-reading it or replacing its error', async () => {
    const { service, onAuditError, prisma } = fixture({ strictManualValidation: true });
    const original = new Error('original validation failure');
    let reads = 0;
    const input = { get action(): string { reads += 1; throw reads === 1 ? original : new Error('secondary getter'); } };
    await expect(service.log(input)).rejects.toBe(original);
    expect(reads).toBe(1);
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(onAuditError).toHaveBeenCalledWith(original, expect.objectContaining({ phase: 'validation' }));
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it.each(['postgresql', 'sqlserver'] as const)('reports %s insert failures once and retains original errors', async provider => {
    const { service, prisma, onAuditError, onAuditOperation } = fixture({ provider });
    const error = Object.assign(new Error('database failure'), { code: 'P2010' });
    const tx = { $executeRaw: jest.fn().mockRejectedValue(error) };
    await expect(service.log({ action: 'invoice.approved' }, tx)).rejects.toBe(error);
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(onAuditError).toHaveBeenCalledWith(error, expect.objectContaining({
      phase: 'insert', code: 'AUDIT_INSERT_FAILED', provider, operation: 'log',
    }));
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(onAuditOperation).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'log', status: 'failure', transaction: 'external', code: 'AUDIT_INSERT_FAILED',
    }));
  });

  it.each([
    [{ actorRequired: true }, { action: 'event' }, 'context', 'AUDIT_CONTEXT_INVALID'],
    [{ tenantRequired: true, tenantResolver: () => null }, { action: 'event' }, 'tenant-resolution', 'AUDIT_TENANT_INVALID'],
    [{}, { action: 'event', metadata: { value: 1n } }, 'serialization', 'AUDIT_SERIALIZATION_FAILED'],
    [{ strictManualValidation: true }, { action: '  ' }, 'validation', 'AUDIT_INPUT_INVALID'],
    [{ maxMetadataBytes: 2 }, { action: 'event', metadata: { value: '😀' } }, 'serialization', 'AUDIT_METADATA_TOO_LARGE'],
  ] as const)('reports rejected stage %s once before SQL', async (options, input, phase, code) => {
    const { service, prisma, onAuditError } = fixture(options);
    await expect(service.log(input)).rejects.toBeDefined();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(onAuditError.mock.calls[0][1]).toEqual(expect.objectContaining({ phase, code }));
  });

  it('preserves existing non-strict defaults and makes strict tenant validation explicit', async () => {
    const legacy = fixture({ tenantRequired: true, tenantResolver: () => '   ' });
    await legacy.service.log({ action: '' });
    expect(legacy.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const strict = fixture({ strictManualValidation: true, tenantResolver: () => '   ' });
    await expect(strict.service.log({ action: 'event' })).rejects.toMatchObject({ field: 'tenantId' });
    expect(strict.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('validates cyclic metadata before recursive redaction', async () => {
    const { service, prisma } = fixture({ strictManualValidation: true });
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    await expect(service.log({ action: 'event', metadata })).rejects.toBeInstanceOf(AuditInputError);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('applies the byte limit after redaction and preserves Unicode', async () => {
    const metadata = { secret: '[REDACTED]', label: '한글😀' };
    const { service, prisma } = fixture({
      strictManualValidation: true, sensitiveFields: ['secret'],
      maxMetadataBytes: Buffer.byteLength(JSON.stringify(metadata), 'utf8'),
    });
    await service.log({ action: 'event', metadata: { ...metadata, secret: 'x'.repeat(10000) } });
    expect(prisma.$executeRaw.mock.calls[0][0].values).toContain(JSON.stringify(metadata));
  });

  it('isolates asynchronous error and operation observers from original outcomes', async () => {
    const { service, prisma } = fixture({
      onAuditError: async () => { throw new Error('observer'); },
      onAuditOperation: async () => { throw new Error('metric observer'); },
    });
    await service.log({ action: 'successful' });
    const error = new Error('insert');
    prisma.$executeRaw.mockRejectedValueOnce(error);
    await expect(service.log({ action: 'failed' })).rejects.toBe(error);
    await new Promise(resolve => setImmediate(resolve));
  });

  it('emits privacy-safe frozen timings without claiming an external commit', async () => {
    const { service, onAuditOperation } = fixture({ tenantResolver: () => 'private-tenant' });
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await AuditContext.runAs({ id: 'private-actor', type: 'user' }, () => service.log({
      action: 'private-action', targetId: 'private-target', metadata: { secret: 'private-value' },
    }, tx));
    const event = onAuditOperation.mock.calls[0][0] as AuditOperationEvent;
    expect(Object.isFrozen(event)).toBe(true);
    expect(event).toEqual({
      provider: 'postgresql', operation: 'log', status: 'success', transaction: 'external',
      durationMs: expect.any(Number),
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(event)).not.toContain('private');
  });

  it('reports managed commit separately and rolls back caught strict failures', async () => {
    const { service, onAuditOperation, onAuditError } = fixture({ strictManualValidation: true });
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const committed = jest.fn();
    const client = { $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
      const result = await fn(tx);
      committed();
      return result;
    } };
    await expect(service.withManualTransaction(client, async ({ log }) => {
      try { await log({ action: '' }); } catch { /* Caller cannot force commit. */ }
      return 'ignored';
    })).rejects.toBeInstanceOf(AuditInputError);
    expect(committed).not.toHaveBeenCalled();
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(onAuditOperation.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      operation: 'transaction', status: 'failure', transaction: 'managed',
    }));
    await expect(service.withManualTransaction(client, async ({ log }) => {
      await log({ action: 'approved' });
      return 42;
    })).resolves.toBe(42);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(onAuditOperation.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      operation: 'transaction', status: 'success', transaction: 'managed',
    }));
  });

  it.each(['postgresql', 'sqlserver'] as const)('advertises %s capabilities without database I/O', provider => {
    const { service, prisma } = fixture({ provider });
    const capabilities = service.getCapabilities();
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(capabilities).toEqual({
      provider, manualLogging: true, manualTransactions: true, query: true,
      automaticTracking: provider === 'postgresql', scan: provider === 'postgresql',
      exportCsv: provider === 'postgresql', retention: provider === 'postgresql',
      schemaInspection: provider === 'sqlserver', readIndexes: provider === 'sqlserver',
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
