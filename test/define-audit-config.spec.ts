import { RequestMethod } from '@nestjs/common';
import { defineAuditConfig, getAuditTableSQL } from '../src';
import type { AuditConfigInput, AuditConfigSharedOptions } from '../src';

const actorExtractor = jest.fn(() => ({ id: 'user-1', type: 'user' as const }));

describe('defineAuditConfig', () => {
  it('preserves omitted defaults and supports manual-only configuration', () => {
    const config = defineAuditConfig({ module: { actorExtractor } });
    const noExtension: undefined = config.extensionOptions;
    expect(noExtension).toBeUndefined();
    expect(config.moduleOptions).toEqual({ actorExtractor });
    expect(config.schemaOptions).toEqual({});
    expect(config.partitionOptions).toEqual({});
    expect(getAuditTableSQL(config.schemaOptions)).toContain('CREATE TABLE IF NOT EXISTS audit_logs');
  });

  it('copies all data settings independently and preserves opaque runtime dependencies without invoking them', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const Prisma = { defineExtension: jest.fn(), raw: jest.fn() };
    const tenantResolver = jest.fn(() => 'tenant-1');
    const onAuditError = jest.fn();
    const correlationIdGetter = jest.fn(() => 'correlation-1');
    const input: AuditConfigInput & { extension: NonNullable<AuditConfigInput['extension']> } = {
      shared: {
        tableName: 'history.events', prismaModule: { Prisma }, logger,
        tenantRequired: true, actorRequired: true, tenantResolver, onAuditError,
        sensitiveFields: ['password'], sensitiveFieldsByModel: { User: ['ssn'] },
      },
      module: {
        actorExtractor, actorExtractionStage: 'interceptor',
        excludeRoutes: [{ path: '/health', method: RequestMethod.GET }],
        registerGlobalInterceptor: false, correlationIdHeader: 'x-correlation', correlationIdGetter,
      },
      extension: {
        consistency: 'atomic-required', trackedModels: ['User'], ignoredModels: ['Post'],
        primaryKey: { User: 'id' }, databaseMapping: { User: { tableName: 'users' } },
        maxBatchRecords: 10, batchOverflow: 'reject', logFailures: false, ignoreTimestampOnlyUpdates: true,
      },
      schema: { partitioned: true, enforcement: 'trigger', ginIndex: true },
    };
    const config = defineAuditConfig(input);
    expect(config.extensionOptions.consistency).toBe('atomic-required');
    expect(config.schemaOptions).toEqual({ tableName: 'history.events', ...input.schema });
    expect(config.partitionOptions).toEqual({ tableName: 'history.events' });
    for (const options of [config.moduleOptions, config.extensionOptions]) {
      expect(options).toMatchObject(input.shared!);
      expect(options.logger).toBe(logger);
      expect(options.prismaModule!.Prisma).toBe(Prisma);
      expect(options.prismaModule).not.toBe(input.shared!.prismaModule);
      expect(options.tenantResolver).toBe(tenantResolver);
      expect(options.onAuditError).toBe(onAuditError);
    }
    input.shared!.sensitiveFields!.push('name');
    input.shared!.sensitiveFieldsByModel!.User.push('email');
    input.extension.trackedModels!.push('Post');
    input.extension.ignoredModels!.push('Other');
    input.extension.primaryKey!.User = 'otherId';
    input.extension.databaseMapping!.User.tableName = 'other_users';
    input.module.excludeRoutes![0].path = '/other';
    input.schema!.partitioned = false;
    expect(config.extensionOptions.trackedModels).toEqual(['User']);
    expect(config.extensionOptions.ignoredModels).toEqual(['Post']);
    expect(config.extensionOptions.primaryKey).toEqual({ User: 'id' });
    expect(config.extensionOptions.databaseMapping!.User.tableName).toBe('users');
    expect(config.moduleOptions.excludeRoutes![0].path).toBe('/health');
    expect(config.schemaOptions.partitioned).toBe(true);
    config.moduleOptions.sensitiveFields!.push('moduleOnly');
    config.moduleOptions.sensitiveFieldsByModel!.User.push('moduleOnly');
    config.moduleOptions.prismaModule!.Prisma = { defineExtension: jest.fn() };
    config.moduleOptions.tableName = 'other_events';
    config.schemaOptions.tableName = 'ddl_events';
    expect(config.extensionOptions.sensitiveFields).toEqual(['password']);
    expect(config.extensionOptions.sensitiveFieldsByModel).toEqual({ User: ['ssn'] });
    expect(config.extensionOptions.prismaModule!.Prisma).toBe(Prisma);
    expect(config.extensionOptions.tableName).toBe('history.events');
    expect(config.partitionOptions.tableName).toBe('history.events');
    config.extensionOptions.sensitiveFieldsByModel!.User.push('extensionOnly');
    expect(input.shared!.sensitiveFieldsByModel!.User).toEqual(['ssn', 'email']);
    expect(Object.isFrozen(logger)).toBe(false);
    expect(Object.isFrozen(Prisma)).toBe(false);
    for (const callback of [actorExtractor, tenantResolver, onAuditError, correlationIdGetter,
      logger.warn, logger.error, Prisma.defineExtension, Prisma.raw]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  const sharedFields: Array<keyof AuditConfigSharedOptions> = [
    'tableName', 'prismaModule', 'tenantRequired', 'tenantResolver', 'actorRequired',
    'sensitiveFields', 'sensitiveFieldsByModel', 'logger', 'onAuditError',
  ];
  it.each(sharedFields)('rejects misplaced shared field %s even when undefined in JavaScript', key => {
    for (const section of ['module', 'extension', 'schema']) {
      const input: any = { module: { actorExtractor }, extension: { consistency: 'atomic-required' } };
      input[section] = { ...input[section], [key]: undefined };
      expect(() => defineAuditConfig(input)).toThrow(`${section}.${key}; configure shared.${key} instead`);
    }
  });

  it.each([
    { module: { actorExtractor, prisma: {} } },
    { module: { actorExtractor }, shared: { consistency: 'best-effort' } },
    { module: { actorExtractor }, schema: { tenantId: 'tenant-1' } },
    { module: { actorExtractor }, extension: { consistency: 'best-effort', actorExtractor } },
    { module: { actorExtractor }, tableName: 'events' },
  ])('rejects misplaced options: %j', input => {
    expect(() => defineAuditConfig(input as any)).toThrow('Invalid option location');
  });

  it.each([null, [], undefined, { module: null }, { module: { actorExtractor }, shared: null },
    { module: { actorExtractor }, extension: null }, { module: { actorExtractor }, schema: [] }])(
    'rejects malformed sections: %j', input => {
      expect(() => defineAuditConfig(input as any)).toThrow('must be an options object');
    },
  );

  it.each([
    [{}, 'consistency'],
    [{ consistency: 'unknown' }, 'consistency'],
    [{ consistency: 'atomic-required', maxBatchRecords: 0 }, 'maxBatchRecords'],
    [{ consistency: 'atomic-required', batchOverflow: 'other' }, 'batchOverflow'],
    [{ consistency: 'atomic-required', batchOverflow: 'summary' }, 'best-effort'],
  ])('reuses extension validation for %j', (extension, message) => {
    expect(() => defineAuditConfig({ module: { actorExtractor }, extension } as any)).toThrow(message);
  });

  it('reuses table validation and accepts explicit best-effort summary mode', () => {
    expect(() => defineAuditConfig({ module: { actorExtractor }, shared: { tableName: 'bad;table' } })).toThrow('Invalid audit tableName');
    const config = defineAuditConfig({ module: { actorExtractor }, extension: { consistency: 'best-effort', batchOverflow: 'summary' } });
    expect(config.extensionOptions.batchOverflow).toBe('summary');
  });
});
