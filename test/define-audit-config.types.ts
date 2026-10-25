// Compiled by typecheck; also usable against the packed public declaration entry point.
import {
  AuditLogModule, createAuditedClient, defineAuditConfig, applyAuditTableSchema, ensurePartitions,
} from '../src';
import type { AuditConfigInput, AuditDatabaseProvider } from '../src';

export function configExamples(base: {
  user: { findUnique(args: { where: { id: string } }): Promise<{ id: string } | null> };
  $extends(extension: any): any;
  $transaction<T>(callback: (tx: { user: { create(args: { data: { name: string } }): Promise<{ id: string }> } }) => Promise<T>): Promise<T>;
}) {
  const module = { actorExtractor: () => ({ id: 'user-1', type: 'user' as const }) };
  const manual = defineAuditConfig({ module });
  const absent: undefined = manual.extensionOptions;
  const provider: AuditDatabaseProvider = 'sqlserver';
  const sqlserver = defineAuditConfig({ shared: { provider, tableName: 'dbo.events' }, module });
  AuditLogModule.forRoot({ ...sqlserver.moduleOptions, prisma: base });
  // @ts-expect-error Provider belongs in shared so DDL and writes cannot diverge.
  defineAuditConfig({ module, schema: { provider } });
  // @ts-expect-error Only Prisma's canonical provider names are accepted.
  defineAuditConfig({ module, shared: { provider: 'mssql' } });
  AuditLogModule.forRoot({ ...manual.moduleOptions, prisma: base });
  AuditLogModule.forRootAsync({ useFactory: async () => ({ ...manual.moduleOptions, prisma: base }) });
  const automatic = defineAuditConfig({ module, extension: { consistency: 'atomic-required', trackedModels: ['User'] } });
  const audited = createAuditedClient(base, automatic.extensionOptions);
  const result: Promise<string> = audited.withAuditTransaction(async tx => {
    const user = await tx.user.create({ data: { name: 'Alice' } });
    // @ts-expect-error Transaction models retain their argument types.
    await tx.user.create({ data: { missing: true } });
    // @ts-expect-error Transaction result is not any.
    const wrong: number = user.id;
    return user.id + wrong;
  });
  const model: Promise<{ id: string } | null> = audited.user.findUnique({ where: { id: 'user-1' } });
  // @ts-expect-error Base client models retain their argument types.
  void audited.user.findUnique({ where: { missing: true } });
  const setup: Promise<void> = applyAuditTableSchema(base, automatic.schemaOptions);
  const partitions: Promise<string[]> = ensurePartitions(base, { ...automatic.partitionOptions, ahead: 1 });
  const optionalInput: AuditConfigInput = { module, extension: Math.random() > 0.5 ? { consistency: 'best-effort' } : undefined };
  const optional = defineAuditConfig(optionalInput);
  // @ts-expect-error A possibly absent extension must be narrowed before use.
  createAuditedClient(base, optional.extensionOptions);
  // @ts-expect-error Consistency is mandatory when extension is provided.
  defineAuditConfig({ module, extension: { trackedModels: ['User'] } });
  const misplaced = { ...module, tableName: 'events' };
  // @ts-expect-error Non-literal module objects cannot override shared fields either.
  defineAuditConfig({ module: misplaced });
  // @ts-expect-error The client is supplied only when registering the module.
  defineAuditConfig({ module: { ...module, prisma: base } });
  // @ts-expect-error Extension masking belongs in shared.
  defineAuditConfig({ module, extension: { consistency: 'atomic-required', sensitiveFields: [] } });
  // @ts-expect-error Schema tableName belongs in shared.
  defineAuditConfig({ module, schema: { tableName: 'events' } });
  return { absent, result, model, setup, partitions };
}
