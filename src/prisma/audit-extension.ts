import { AuditContext } from '../services/audit-context';
import {
  shouldTrackModel,
  computeCreateChanges,
  computeUpdateChanges,
  computeDeleteChanges,
  Changes,
} from './diff';
import { getTenantId } from '../utils/tenant';

export interface AuditExtensionOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
}

export function modelDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

export function getPkField(
  model: string,
  options: AuditExtensionOptions,
): string {
  return options.primaryKey?.[model] ?? 'id';
}

export function buildAuditInsertParams(input: {
  action: string;
  targetType: string;
  targetId: string | null;
  changes: Changes;
  metadata?: Record<string, unknown>;
}): {
  tenantId: string | null;
  actorId: string | null;
  actorType: string;
  actorIp: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  source: 'auto';
  changes: Changes;
  metadata?: Record<string, unknown>;
} {
  const actor = AuditContext.getActor();
  const actionOverride = AuditContext.getActionOverride();

  return {
    tenantId: getTenantId(),
    actorId: actor?.id ?? null,
    actorType: actor?.type ?? 'system',
    actorIp: actor?.ip ?? null,
    action: actionOverride ?? input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    source: 'auto',
    changes: input.changes,
    metadata: input.metadata,
  };
}

async function insertAuditLog(
  client: any,
  params: ReturnType<typeof buildAuditInsertParams>,
): Promise<void> {
  const changesJson = JSON.stringify(params.changes);
  const metadataJson = params.metadata
    ? JSON.stringify(params.metadata)
    : null;

  await client.$executeRaw`
    INSERT INTO audit_logs
      (tenant_id, actor_id, actor_type, actor_ip, action,
       target_type, target_id, source, changes, metadata, result)
    VALUES (
      ${params.tenantId},
      ${params.actorId},
      ${params.actorType},
      ${params.actorIp},
      ${params.action},
      ${params.targetType},
      ${params.targetId},
      ${params.source},
      ${changesJson}::jsonb,
      ${metadataJson}::jsonb,
      ${'success'}
    )
  `;
}

function shouldSkip(
  model: string,
  trackedModels?: string[],
  ignoredModels?: string[],
): boolean {
  return (
    AuditContext.isNoAudit() ||
    !shouldTrackModel(model, trackedModels, ignoredModels)
  );
}

async function tryAuditLog(
  client: any,
  params: ReturnType<typeof buildAuditInsertParams>,
): Promise<void> {
  try {
    await insertAuditLog(client, params);
  } catch (error) {
    console.warn(
      '[@nestarc/audit-log] audit insert failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

export function createAuditExtension(options: AuditExtensionOptions) {
  const sensitiveFields = options.sensitiveFields ?? [];
  const { trackedModels, ignoredModels } = options;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Prisma } = require('@prisma/client');

  return Prisma.defineExtension((client: any) => {
    return client.$extends({
      query: {
        $allModels: {
          async create({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const result = await query(args);

            try {
              const pkValue =
                (result as any)[pkField] ??
                (args as any).data?.[pkField] ??
                null;
              const targetId =
                pkValue != null ? String(pkValue) : null;

              const canonical =
                pkValue != null
                  ? await (client as any)[delegateName].findFirst({
                      where: { [pkField]: pkValue },
                    })
                  : null;

              const changes = computeCreateChanges(
                (canonical ?? result) as Record<string, unknown>,
                sensitiveFields,
              );
              const params = buildAuditInsertParams({
                action: `${model}.created`,
                targetType: model,
                targetId,
                changes,
              });
              await tryAuditLog(client, params);
            } catch (error) {
              console.warn(
                '[@nestarc/audit-log] audit tracking failed:',
                error instanceof Error ? error.message : error,
              );
            }

            return result;
          },

          async update({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const delegate = (client as any)[delegateName];
            const before = await delegate.findFirst({
              where: args.where,
            });

            const result = await query(args);

            try {
              const beforePk = (before as any)?.[pkField];
              const afterCanonical =
                beforePk != null
                  ? await delegate.findFirst({
                      where: { [pkField]: beforePk },
                    })
                  : null;

              const changes = before
                ? computeUpdateChanges(
                    before as Record<string, unknown>,
                    (afterCanonical ?? result) as Record<
                      string,
                      unknown
                    >,
                    sensitiveFields,
                  )
                : {};
              const params = buildAuditInsertParams({
                action: `${model}.updated`,
                targetType: model,
                targetId:
                  beforePk != null
                    ? String(beforePk)
                    : String(
                        (result as any)[pkField] ?? null,
                      ),
                changes,
              });
              await tryAuditLog(client, params);
            } catch (error) {
              console.warn(
                '[@nestarc/audit-log] audit tracking failed:',
                error instanceof Error ? error.message : error,
              );
            }

            return result;
          },

          async delete({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const before = await (client as any)[
              delegateName
            ].findFirst({ where: args.where });

            const result = await query(args);

            try {
              const changes = before
                ? computeDeleteChanges(
                    before as Record<string, unknown>,
                    sensitiveFields,
                  )
                : {};
              const pkValue =
                (before as any)?.[pkField] ??
                (result as any)[pkField] ??
                null;
              const params = buildAuditInsertParams({
                action: `${model}.deleted`,
                targetType: model,
                targetId:
                  pkValue != null ? String(pkValue) : null,
                changes,
              });
              await tryAuditLog(client, params);
            } catch (error) {
              console.warn(
                '[@nestarc/audit-log] audit tracking failed:',
                error instanceof Error ? error.message : error,
              );
            }

            return result;
          },

          async upsert({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const delegate = (client as any)[delegateName];
            const before = await delegate.findFirst({
              where: args.where,
            });

            const result = await query(args);

            try {
              const isCreate = !before;
              const pkValue =
                (result as any)[pkField] ??
                (args as any).create?.[pkField] ??
                null;

              const canonical =
                pkValue != null
                  ? await delegate.findFirst({
                      where: { [pkField]: pkValue },
                    })
                  : null;

              const changes = isCreate
                ? computeCreateChanges(
                    (canonical ?? result) as Record<
                      string,
                      unknown
                    >,
                    sensitiveFields,
                  )
                : computeUpdateChanges(
                    before as Record<string, unknown>,
                    (canonical ?? result) as Record<
                      string,
                      unknown
                    >,
                    sensitiveFields,
                  );
              const params = buildAuditInsertParams({
                action: isCreate
                  ? `${model}.created`
                  : `${model}.updated`,
                targetType: model,
                targetId:
                  pkValue != null ? String(pkValue) : null,
                changes,
              });
              await tryAuditLog(client, params);
            } catch (error) {
              console.warn(
                '[@nestarc/audit-log] audit tracking failed:',
                error instanceof Error ? error.message : error,
              );
            }

            return result;
          },

          async createMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const result = await query(args);

            try {
              const params = buildAuditInsertParams({
                action: `${model}.createdMany`,
                targetType: model,
                targetId: null,
                changes: {},
                metadata: { count: (result as any).count },
              });
              await tryAuditLog(client, params);
            } catch (error) {
              console.warn(
                '[@nestarc/audit-log] audit tracking failed:',
                error instanceof Error ? error.message : error,
              );
            }

            return result;
          },

          async updateMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const result = await query(args);

            try {
              const params = buildAuditInsertParams({
                action: `${model}.updatedMany`,
                targetType: model,
                targetId: null,
                changes: {},
                metadata: { count: (result as any).count },
              });
              await tryAuditLog(client, params);
            } catch (error) {
              console.warn(
                '[@nestarc/audit-log] audit tracking failed:',
                error instanceof Error ? error.message : error,
              );
            }

            return result;
          },

          async deleteMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const pkField = getPkField(model, options);
            const delegateName = modelDelegateName(model);
            const records = await (client as any)[
              delegateName
            ].findMany({ where: args.where });

            const result = await query(args);

            try {
              for (const record of records) {
                const changes = computeDeleteChanges(
                  record as Record<string, unknown>,
                  sensitiveFields,
                );
                const recordPk =
                  (record as any)[pkField] ?? null;
                const params = buildAuditInsertParams({
                  action: `${model}.deleted`,
                  targetType: model,
                  targetId:
                    recordPk != null
                      ? String(recordPk)
                      : null,
                  changes,
                });
                await tryAuditLog(client, params);
              }
            } catch (error) {
              console.warn(
                '[@nestarc/audit-log] audit tracking failed:',
                error instanceof Error ? error.message : error,
              );
            }

            return result;
          },
        },
      },
    });
  });
}
