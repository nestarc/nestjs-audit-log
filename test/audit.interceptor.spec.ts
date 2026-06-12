import 'reflect-metadata';
import { AuditInterceptor } from '../src/interceptors/audit.interceptor';
import { AuditContext } from '../src/services/audit-context';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { AUDIT_REASON_KEY } from '../src/decorators/audit-reason.decorator';

describe('AuditInterceptor', () => {
  let interceptor: AuditInterceptor;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new AuditInterceptor(reflector);
  });

  function createMockContext(
    handlerMetadata: Record<string, any> = {},
    classMetadata: Record<string, any> = {},
  ): ExecutionContext {
    const handler = function testHandler() {};
    for (const [key, value] of Object.entries(handlerMetadata)) {
      Reflect.defineMetadata(key, value, handler);
    }
    const cls = class TestController {};
    for (const [key, value] of Object.entries(classMetadata)) {
      Reflect.defineMetadata(key, value, cls);
    }
    return {
      getHandler: () => handler,
      getClass: () => cls,
      getType: () => 'http',
      switchToHttp: () => ({} as any),
      switchToRpc: () => ({} as any),
      switchToWs: () => ({} as any),
      getArgs: () => [],
      getArgByIndex: () => undefined,
    } as unknown as ExecutionContext;
  }

  const mockNext: CallHandler = {
    handle: () => of('result'),
  };

  it('sets noAudit=true when @NoAudit() is present', (done) => {
    const context = createMockContext({ NO_AUDIT: true });

    AuditContext.run({ actor: null, noAudit: false }, () => {
      interceptor.intercept(context, mockNext).subscribe(() => {
        expect(AuditContext.isNoAudit()).toBe(true);
        done();
      });
    });
  });

  it('sets actionOverride when @AuditAction() is present', (done) => {
    const context = createMockContext({ AUDIT_ACTION: 'custom.action' });

    AuditContext.run({ actor: null, noAudit: false }, () => {
      interceptor.intercept(context, mockNext).subscribe(() => {
        expect(AuditContext.getActionOverride()).toBe('custom.action');
        done();
      });
    });
  });

  it('does not modify store when no decorators are present', (done) => {
    const context = createMockContext();

    AuditContext.run({ actor: null, noAudit: false }, () => {
      interceptor.intercept(context, mockNext).subscribe(() => {
        expect(AuditContext.isNoAudit()).toBe(false);
        expect(AuditContext.getActionOverride()).toBeUndefined();
        done();
      });
    });
  });

  it('reads class-level @NoAudit() when handler has no decorator', (done) => {
    const context = createMockContext({}, { NO_AUDIT: true });

    AuditContext.run({ actor: null, noAudit: false }, () => {
      interceptor.intercept(context, mockNext).subscribe(() => {
        expect(AuditContext.isNoAudit()).toBe(true);
        done();
      });
    });
  });

  it('handler-level decorator overrides class-level', (done) => {
    const context = createMockContext(
      { AUDIT_ACTION: 'handler.action' },
      { AUDIT_ACTION: 'class.action' },
    );

    AuditContext.run({ actor: null, noAudit: false }, () => {
      interceptor.intercept(context, mockNext).subscribe(() => {
        expect(AuditContext.getActionOverride()).toBe('handler.action');
        done();
      });
    });
  });

  it('sets reason from @AuditReason metadata with handler override', (done) => {
    const context = createMockContext(
      { [AUDIT_REASON_KEY]: 'handler reason' },
      { [AUDIT_REASON_KEY]: 'class reason' },
    );

    AuditContext.run({ actor: null, noAudit: false }, () => {
      interceptor.intercept(context, mockNext).subscribe(() => {
        expect(AuditContext.getReason()).toBe('handler reason');
        done();
      });
    });
  });

  it('allows handler code to override @AuditReason with setReason', (done) => {
    const context = createMockContext({ [AUDIT_REASON_KEY]: 'decorator reason' });
    const next: CallHandler = {
      handle: () => {
        AuditContext.setReason('handler reason');
        return of('result');
      },
    };

    AuditContext.run({ actor: null, noAudit: false }, () => {
      interceptor.intercept(context, next).subscribe(() => {
        expect(AuditContext.getReason()).toBe('handler reason');
        done();
      });
    });
  });
});
