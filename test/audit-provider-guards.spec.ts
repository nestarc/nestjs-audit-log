import { Test } from '@nestjs/testing';
import {
  AuditContext,
  AuditLogModule,
  AuditService,
  createAuditExtension,
  createAuditedClient,
} from '../src';
import type {
  AuditDatabaseProvider,
  AuditExtensionOptions,
  AuditLogModuleOptions,
  PrismaModuleLike,
} from '../src';

function fixture(provider?: AuditDatabaseProvider) {
  const client = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
    $extends: jest.fn(),
    user: { findFirst: jest.fn() },
  };
  client.$extends.mockImplementation((extension: any) =>
    typeof extension === 'function'
      ? extension(client)
      : { ...client, ...extension.client },
  );
  const Prisma = {
    defineExtension: jest.fn((extension: any) => extension),
    sql: jest.fn((strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => ({
      strings: Array.from(strings), values,
    })),
    raw: jest.fn((value: string) => ({ raw: value })),
  } satisfies PrismaModuleLike['Prisma'];
  const readNamespace = jest.fn(() => Prisma);
  const prismaModule = { get Prisma() { return readNamespace(); } };
  const extensionOptions: AuditExtensionOptions = {
    provider,
    consistency: 'best-effort',
    trackedModels: ['User'],
    prismaModule,
  };
  const moduleOptions: AuditLogModuleOptions = {
    provider,
    prisma: client,
    prismaModule,
    actorExtractor: jest.fn(() => ({ id: null, type: 'system' as const })),
  };
  return { client, Prisma, readNamespace, extensionOptions, moduleOptions };
}

function expectNoClientCalls(client: ReturnType<typeof fixture>['client']): void {
  for (const method of Object.values(client)) {
    if (typeof method === 'function') expect(method).not.toHaveBeenCalled();
  }
  expect(client.user.findFirst).not.toHaveBeenCalled();
}

describe.each(['createAuditExtension', 'createAuditedClient'] as const)(
  '%s public provider guards', factory => {
    it.each([
      ['sqlserver', 'Automatic audit tracking is not supported for provider "sqlserver"'],
      ['mysql', 'provider must be "postgresql" or "sqlserver"'],
      [null, 'provider must be "postgresql" or "sqlserver"'],
    ])('rejects provider %s before namespace access, client extension or SQL', (provider, message) => {
      const { client, Prisma, readNamespace, extensionOptions } = fixture(provider as never);
      expect(() => factory === 'createAuditedClient'
        ? createAuditedClient(client, extensionOptions)
        : createAuditExtension(extensionOptions),
      ).toThrow(message!);
      expect(readNamespace).not.toHaveBeenCalled();
      expect(Prisma.defineExtension).not.toHaveBeenCalled();
      expectNoClientCalls(client);
    });

    it('preserves automatic PostgreSQL writes for omitted and explicit providers', async () => {
      const writes: unknown[][] = [];
      for (const provider of [undefined, 'postgresql'] as const) {
        const { client, Prisma, extensionOptions } = fixture(provider);
        const extended = factory === 'createAuditedClient'
          ? createAuditedClient(client, extensionOptions)
          : client.$extends(createAuditExtension(extensionOptions));
        expect(extended.getAuditCapabilities()).toEqual({
          consistency: 'best-effort', atomicLifecycle: false,
        });
        expect(Prisma.defineExtension).toHaveBeenCalledTimes(1);
        const definition = client.$extends.mock.calls.find(
          ([extension]) => typeof extension !== 'function',
        )![0];
        const created = { id: 'user-1', name: 'Alice' };
        client.user.findFirst.mockResolvedValue(created);
        const query = jest.fn().mockResolvedValue(created);
        const args = { data: { name: 'Alice' } };
        const result = await AuditContext.runAs({ id: 'actor-1', type: 'user' }, () =>
          definition.query.$allModels.create({ model: 'User', args, query }),
        );

        expect(result).toBe(created);
        expect(query).toHaveBeenCalledWith(args);
        expect(client.$executeRaw).toHaveBeenCalledTimes(1);
        const insert = client.$executeRaw.mock.calls[0];
        expect(insert[0].join('')).toContain('INSERT INTO audit_logs');
        expect(insert[0].join('')).toContain('::jsonb');
        expect(insert.slice(1)).toEqual([
          null, 'actor-1', 'user', null, 'User.created', 'User', 'user-1', 'auto',
          '{"id":{"after":"user-1"},"name":{"after":"Alice"}}', null, 'success',
        ]);
        expect(client.$transaction).not.toHaveBeenCalled();
        writes.push(insert);
      }
      expect(writes[1]).toEqual(writes[0]);
    });
  },
);

describe.each(['forRoot', 'forRootAsync'] as const)(
  'AuditLogModule.%s provider validation', registration => {
    it('rejects invalid provider during module construction before any client access', async () => {
      const { client, Prisma, moduleOptions } = fixture('mysql' as never);
      const dynamicModule = registration === 'forRoot'
        ? AuditLogModule.forRoot(moduleOptions)
        : AuditLogModule.forRootAsync({ useFactory: async () => moduleOptions });
      await expect(Test.createTestingModule({ imports: [dynamicModule] }).compile())
        .rejects.toThrow('provider must be "postgresql" or "sqlserver"');
      // Nest 10 token hashing may read useValue getters before service construction.
      // Reading the namespace is harmless; invoking Prisma or a client is not.
      for (const method of Object.values(Prisma)) expect(method).not.toHaveBeenCalled();
      expect(moduleOptions.actorExtractor).not.toHaveBeenCalled();
      expectNoClientCalls(client);
    });

    it('provides the MSSQL manual service without applying the automatic extension', async () => {
      const { client, Prisma, moduleOptions } = fixture('sqlserver');
      const dynamicModule = registration === 'forRoot'
        ? AuditLogModule.forRoot(moduleOptions)
        : AuditLogModule.forRootAsync({ useFactory: async () => moduleOptions });
      const module = await Test.createTestingModule({ imports: [dynamicModule] }).compile();
      try {
        const service = module.get(AuditService);
        const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
        await service.log({ action: 'manual.from-module' }, tx);
        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
        const insert = tx.$executeRaw.mock.calls[0][0];
        expect(insert.strings.join('')).not.toContain('::jsonb');
        expect(insert.values[0]).toEqual({ raw: '[dbo].[audit_logs]' });
        expect(Prisma.defineExtension).not.toHaveBeenCalled();
        expectNoClientCalls(client);
      } finally {
        await module.close();
      }
    });
  },
);
