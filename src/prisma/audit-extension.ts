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
}

export function modelDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
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
    AuditContext.isAuditBypass() ||
    !shouldTrackModel(model, trackedModels, ignoredModels)
  );
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

            const store = AuditContext.getStore();
            const delegateName = modelDelegateName(model);

            return client.$transaction(async (tx: any) => {
              if (store) store._auditBypass = true;
              try {
                const result = await tx[delegateName].create(args);
                const targetId = String((result as any).id ?? null);

                // Canonical fetch for full record (projection-safe)
                const canonical =
                  targetId !== 'null'
                    ? await tx[delegateName].findFirst({
                        where: { id: (result as any).id },
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
                await insertAuditLog(tx, params);
                return result;
              } finally {
                if (store) store._auditBypass = false;
              }
            });
          },

          async update({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const store = AuditContext.getStore();
            const delegateName = modelDelegateName(model);

            return client.$transaction(async (tx: any) => {
              if (store) store._auditBypass = true;
              try {
                const before = await tx[delegateName].findFirst({
                  where: args.where,
                });
                const result = await tx[delegateName].update(args);

                // Canonical after-state (projection-safe)
                const afterCanonical = await tx[delegateName].findFirst({
                  where: args.where,
                });

                const changes = before
                  ? computeUpdateChanges(
                      before as Record<string, unknown>,
                      (afterCanonical ?? result) as Record<string, unknown>,
                      sensitiveFields,
                    )
                  : {};
                const params = buildAuditInsertParams({
                  action: `${model}.updated`,
                  targetType: model,
                  targetId: String((result as any).id ?? null),
                  changes,
                });
                await insertAuditLog(tx, params);
                return result;
              } finally {
                if (store) store._auditBypass = false;
              }
            });
          },

          async delete({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const store = AuditContext.getStore();
            const delegateName = modelDelegateName(model);

            return client.$transaction(async (tx: any) => {
              if (store) store._auditBypass = true;
              try {
                const before = await tx[delegateName].findFirst({
                  where: args.where,
                });
                const result = await tx[delegateName].delete(args);

                const changes = before
                  ? computeDeleteChanges(
                      before as Record<string, unknown>,
                      sensitiveFields,
                    )
                  : {};
                const params = buildAuditInsertParams({
                  action: `${model}.deleted`,
                  targetType: model,
                  targetId: String(
                    (before as any)?.id ?? (result as any).id ?? null,
                  ),
                  changes,
                });
                await insertAuditLog(tx, params);
                return result;
              } finally {
                if (store) store._auditBypass = false;
              }
            });
          },

          async upsert({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const store = AuditContext.getStore();
            const delegateName = modelDelegateName(model);

            return client.$transaction(async (tx: any) => {
              if (store) store._auditBypass = true;
              try {
                const before = await tx[delegateName].findFirst({
                  where: args.where,
                });
                const result = await tx[delegateName].upsert(args);
                const isCreate = !before;

                // Canonical after-state
                const canonical = await tx[delegateName].findFirst({
                  where: { id: (result as any).id },
                });

                const changes = isCreate
                  ? computeCreateChanges(
                      (canonical ?? result) as Record<string, unknown>,
                      sensitiveFields,
                    )
                  : computeUpdateChanges(
                      before as Record<string, unknown>,
                      (canonical ?? result) as Record<string, unknown>,
                      sensitiveFields,
                    );
                const params = buildAuditInsertParams({
                  action: isCreate
                    ? `${model}.created`
                    : `${model}.updated`,
                  targetType: model,
                  targetId: String((result as any).id ?? null),
                  changes,
                });
                await insertAuditLog(tx, params);
                return result;
              } finally {
                if (store) store._auditBypass = false;
              }
            });
          },

          async createMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const store = AuditContext.getStore();
            const delegateName = modelDelegateName(model);

            return client.$transaction(async (tx: any) => {
              if (store) store._auditBypass = true;
              try {
                const result = await tx[delegateName].createMany(args);
                const params = buildAuditInsertParams({
                  action: `${model}.createdMany`,
                  targetType: model,
                  targetId: null,
                  changes: {},
                  metadata: { count: (result as any).count },
                });
                await insertAuditLog(tx, params);
                return result;
              } finally {
                if (store) store._auditBypass = false;
              }
            });
          },

          async updateMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const store = AuditContext.getStore();
            const delegateName = modelDelegateName(model);

            return client.$transaction(async (tx: any) => {
              if (store) store._auditBypass = true;
              try {
                const result = await tx[delegateName].updateMany(args);
                const params = buildAuditInsertParams({
                  action: `${model}.updatedMany`,
                  targetType: model,
                  targetId: null,
                  changes: {},
                  metadata: { count: (result as any).count },
                });
                await insertAuditLog(tx, params);
                return result;
              } finally {
                if (store) store._auditBypass = false;
              }
            });
          },

          async deleteMany({ model, args, query }: any) {
            if (shouldSkip(model, trackedModels, ignoredModels)) {
              return query(args);
            }

            const store = AuditContext.getStore();
            const delegateName = modelDelegateName(model);

            return client.$transaction(async (tx: any) => {
              if (store) store._auditBypass = true;
              try {
                const records = await tx[delegateName].findMany({
                  where: args.where,
                });
                const result = await tx[delegateName].deleteMany(args);

                for (const record of records) {
                  const changes = computeDeleteChanges(
                    record as Record<string, unknown>,
                    sensitiveFields,
                  );
                  const params = buildAuditInsertParams({
                    action: `${model}.deleted`,
                    targetType: model,
                    targetId: String((record as any).id ?? null),
                    changes,
                  });
                  await insertAuditLog(tx, params);
                }

                return result;
              } finally {
                if (store) store._auditBypass = false;
              }
            });
          },
        },
      },
    });
  });
}
