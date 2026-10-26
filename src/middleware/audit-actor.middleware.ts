import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { AUDIT_LOG_OPTIONS } from '../audit-log.constants';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import {
  AuditContext,
  AuditContextStore,
} from '../services/audit-context';
import { AuditErrorContext } from '../interfaces/audit-shared-options.interface';
import { errorMessage, invokeAuditObserver } from '../prisma/audit-extension/audit-errors';

// Keep the request and extractor out of the public context store. Weak keys let
// rejected requests and routes without an interceptor be collected normally.
const deferredActors = new WeakMap<AuditContextStore, () => Promise<void>>();

/** @internal Called by AuditInterceptor after Nest's guards have completed. */
export function resolveDeferredActor(
  store: AuditContextStore,
): Promise<void> | undefined {
  return deferredActors.get(store)?.();
}

@Injectable()
export class AuditActorMiddleware implements NestMiddleware {
  constructor(
    @Inject(AUDIT_LOG_OPTIONS)
    private readonly options: AuditLogModuleOptions,
  ) {}

  async use(req: any, _res: any, next: () => void): Promise<void> {
    const store: AuditContextStore = { actor: null, noAudit: false };
    const extractActor = async () => {
      try {
        store.actor = await this.options.actorExtractor(req);
      } catch (error) {
        this.reportContextError(error);
      }
    };

    if (this.options.actorExtractionStage === 'interceptor') {
      let extraction: Promise<void> | undefined;
      deferredActors.set(store, () => (extraction ??= extractActor()));
    } else {
      await extractActor();
    }

    store.metadata = this.getCorrelationMetadata(req);
    AuditContext.run(store, next);
  }

  private getCorrelationMetadata(
    req: any,
  ): Record<string, unknown> | undefined {
    let correlationId: string | undefined;

    try {
      if (this.options.correlationIdGetter) {
        correlationId = this.options.correlationIdGetter(req);
      } else {
        const headerName = this.options.correlationIdHeader ?? 'x-request-id';
        const headers = req?.headers ?? {};
        const value = headers[headerName] ?? headers[headerName.toLowerCase()];
        correlationId = Array.isArray(value) ? value[0] : value;
      }
    } catch (error) {
      this.reportContextError(error);
      return undefined;
    }

    return typeof correlationId === 'string' && correlationId.length > 0
      ? { correlationId }
      : undefined;
  }

  private reportContextError(error: unknown): void {
    const ctx: AuditErrorContext = { phase: 'context' };
    const logger = this.options.logger ?? console;

    const onAuditError = this.options.onAuditError;
    if (onAuditError) {
      invokeAuditObserver(
        (reportedError, context) => onAuditError.call(this.options, reportedError, context),
        [error, ctx],
        callbackError => logger.error(
          `[@nestarc/audit-log] onAuditError callback threw: ${errorMessage(callbackError)}`,
        ),
      );
      return;
    }

    invokeAuditObserver(
      () => logger.error(`[@nestarc/audit-log] audit context failed: ${errorMessage(error)}`),
      [],
    );
  }
}
