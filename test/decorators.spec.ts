import 'reflect-metadata';
import { NO_AUDIT_KEY, NoAudit } from '../src/decorators/no-audit.decorator';
import { AUDIT_ACTION_KEY, AuditAction } from '../src/decorators/audit-action.decorator';

describe('@NoAudit()', () => {
  it('sets NO_AUDIT metadata to true', () => {
    class TestController {
      @NoAudit()
      handler() {}
    }

    const metadata = Reflect.getMetadata(NO_AUDIT_KEY, new TestController().handler);
    // SetMetadata sets on the method descriptor
    const meta = Reflect.getMetadata(NO_AUDIT_KEY, TestController.prototype.handler);
    expect(meta).toBe(true);
  });
});

describe('@AuditAction()', () => {
  it('sets AUDIT_ACTION metadata to the provided action', () => {
    class TestController {
      @AuditAction('user.role.changed')
      handler() {}
    }

    const metadata = Reflect.getMetadata(AUDIT_ACTION_KEY, TestController.prototype.handler);
    expect(metadata).toBe('user.role.changed');
  });
});
