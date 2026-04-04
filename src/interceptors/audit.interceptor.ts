import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { NO_AUDIT_KEY } from '../decorators/no-audit.decorator';
import { AUDIT_ACTION_KEY } from '../decorators/audit-action.decorator';
import { AuditContext } from '../services/audit-context';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const targets = [context.getHandler(), context.getClass()];
    const noAudit =
      this.reflector.getAllAndOverride<boolean>(NO_AUDIT_KEY, targets) ??
      false;
    const actionOverride = this.reflector.getAllAndOverride<string>(
      AUDIT_ACTION_KEY,
      targets,
    );

    const store = AuditContext.getStore();
    if (store) {
      store.noAudit = noAudit;
      if (actionOverride) {
        store.actionOverride = actionOverride;
      }
    }

    return next.handle();
  }
}
