import type {
  AuditErrorContext,
  AuditErrorPhase,
  AuditLogger,
  AuditSharedOptions,
} from '../src';

describe('public API exports', () => {
  it('exports shared audit option types', () => {
    const phase: AuditErrorPhase = 'insert';
    const ctx: AuditErrorContext = { phase, model: 'User' };
    const logger: AuditLogger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    const options: AuditSharedOptions = {
      tableName: 'audit_logs',
      tenantRequired: true,
      tenantResolver: () => 'tenant-1',
      onAuditError: (_error, errorContext) => logger.warn(errorContext.phase),
      logger,
    };

    expect(ctx.phase).toBe('insert');
    expect(options.tenantResolver?.()).toBe('tenant-1');
  });
});
