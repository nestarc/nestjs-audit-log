import {
  enforceUnsupportedReturningOperation,
  shouldSkip,
} from '../mutation-policy';
import type { UnsupportedReturningOperation } from '../mutation-policy';
import type { OperationHandler, OperationHandlerDependencies } from './types';

export function createUnsupportedReturningHandler(
  dependencies: OperationHandlerDependencies,
  operation: UnsupportedReturningOperation,
): OperationHandler {
  const { options, trackedModels, ignoredModels, unsupportedOperationWarnings } = dependencies;

  return async ({ model, args, query }) => {
    if (!shouldSkip(model, trackedModels, ignoredModels)) {
      enforceUnsupportedReturningOperation(
        model, operation, options, unsupportedOperationWarnings,
      );
    }
    return query(args);
  };
}
