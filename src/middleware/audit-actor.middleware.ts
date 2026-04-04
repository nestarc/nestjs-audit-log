import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { AUDIT_LOG_OPTIONS } from '../audit-log.constants';
import { AuditLogModuleOptions } from '../interfaces/audit-log-options.interface';
import { AuditContext } from '../services/audit-context';

@Injectable()
export class AuditActorMiddleware implements NestMiddleware {
  constructor(
    @Inject(AUDIT_LOG_OPTIONS)
    private readonly options: AuditLogModuleOptions,
  ) {}

  use(req: any, _res: any, next: () => void): void {
    const actor = this.options.actorExtractor(req);
    AuditContext.run({ actor, noAudit: false }, next);
  }
}
