import type { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaModuleLike } from '../../prisma-namespace';
import type { AuditExtensionOptions } from '../audit-types';

export interface LifecycleSuppressionScope {
  model: string;
  operation: 'delete' | 'deleteMany';
  successfulTokens: Set<symbol>;
}

export interface OperationHandlerDependencies {
  client: any;
  options: AuditExtensionOptions;
  Prisma: PrismaModuleLike['Prisma'];
  auditTableRef?: unknown;
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFieldsFor(model: string): string[];
  getTransactionClient(): any;
  lifecycleSuppressionScope: AsyncLocalStorage<LifecycleSuppressionScope>;
}

export interface OperationHandlerInput {
  model: string;
  args: any;
  query(args: any): Promise<any>;
}

export type OperationHandler = (
  input: OperationHandlerInput,
) => Promise<any>;

export interface OperationHandlers {
  create: OperationHandler;
  update: OperationHandler;
  delete: OperationHandler;
  upsert: OperationHandler;
  createMany: OperationHandler;
  updateMany: OperationHandler;
  deleteMany: OperationHandler;
}
