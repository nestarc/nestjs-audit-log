import { createCreateHandler } from './create';
import { createUpdateHandler } from './update';
import { createDeleteHandler } from './delete';
import { createUpsertHandler } from './upsert';
import {
  createCreateManyHandler,
  createDeleteManyHandler,
  createUpdateManyHandler,
} from './bulk';
import type {
  OperationHandlerDependencies,
  OperationHandlers,
} from './types';

export { createCreateHandler } from './create';
export { createUpdateHandler } from './update';
export { createDeleteHandler } from './delete';
export { createUpsertHandler } from './upsert';
export {
  createCreateManyHandler,
  createDeleteManyHandler,
  createUpdateManyHandler,
} from './bulk';
export type {
  LifecycleSuppressionScope,
  OperationHandler,
  OperationHandlerDependencies,
  OperationHandlerInput,
  OperationHandlers,
} from './types';

export function createOperationHandlers(
  dependencies: OperationHandlerDependencies,
): OperationHandlers {
  return {
    create: createCreateHandler(dependencies),
    update: createUpdateHandler(dependencies),
    delete: createDeleteHandler(dependencies),
    upsert: createUpsertHandler(dependencies),
    createMany: createCreateManyHandler(dependencies),
    updateMany: createUpdateManyHandler(dependencies),
    deleteMany: createDeleteManyHandler(dependencies),
  };
}
