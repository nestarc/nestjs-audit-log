import 'reflect-metadata';
import { AuditInterceptor } from '../src/interceptors/audit.interceptor';
import { AuditContext } from '../src/services/audit-context';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';

describe('AuditInterceptor', () => {
  let interceptor: AuditInterceptor;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new AuditInterceptor(reflector);
  });

  function createMockContext(handlerMetadata: Record<string, any> = {}): ExecutionContext {
    const handler = function testHandler() {};
    for (const [key, value] of Object.entries(handlerMetadata)) {
      Reflect.defineMetadata(key, value, handler);
    }
    return {
      getHandler: () => handler,
      getClass: () => class {},
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
});
