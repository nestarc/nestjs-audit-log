import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { AUDIT_LOG_OPTIONS } from '../audit-log.constants';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import { AuditContext } from '../services/audit-context';
import { AuditActor } from '../interfaces/actor.interface';
import { AuditErrorContext } from '../interfaces/audit-shared-options.interface';

@Injectable()
export class AuditActorMiddleware implements NestMiddleware {
  constructor(
    @Inject(AUDIT_LOG_OPTIONS)
    private readonly options: AuditLogModuleOptions,
  ) {}

  async use(req: any, _res: any, next: () => void): Promise<void> {
    let actor: AuditActor | null = null;

    try {
      actor = await this.options.actorExtractor(req);
    } catch (error) {
      this.reportContextError(error);
    }

    const metadata = this.getCorrelationMetadata(req);
    AuditContext.run({ actor, noAudit: false, metadata }, next);
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

    if (this.options.onAuditError) {
      try {
        this.options.onAuditError(error, ctx);
        return;
      } catch (callbackError) {
        try {
          logger.error(
            `[@nestarc/audit-log] onAuditError callback threw: ${
              callbackError instanceof Error
                ? callbackError.message
                : String(callbackError)
            }`,
          );
        } catch {
          // Reporting must never block request handling.
        }
        return;
      }
    }

    try {
      logger.error(
        `[@nestarc/audit-log] audit context failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } catch {
      // Reporting must never block request handling.
    }
  }
}
