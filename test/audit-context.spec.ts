import { AuditContext } from '../src/services/audit-context';
import { AuditActor } from '../src/interfaces/actor.interface';

describe('AuditContext', () => {
  const actor: AuditActor = { id: 'user-1', type: 'user', ip: '127.0.0.1' };

  it('returns null actor outside a context', () => {
    expect(AuditContext.getActor()).toBeNull();
  });

  it('returns false for noAudit outside a context', () => {
    expect(AuditContext.isNoAudit()).toBe(false);
  });

  it('returns undefined actionOverride outside a context', () => {
    expect(AuditContext.getActionOverride()).toBeUndefined();
  });

  it('stores and retrieves actor within a run', () => {
    AuditContext.run({ actor, noAudit: false }, () => {
      expect(AuditContext.getActor()).toEqual(actor);
    });
  });

  it('stores and retrieves noAudit flag', () => {
    AuditContext.run({ actor, noAudit: true }, () => {
      expect(AuditContext.isNoAudit()).toBe(true);
    });
  });

  it('stores and retrieves actionOverride', () => {
    AuditContext.run({ actor, noAudit: false, actionOverride: 'custom.action' }, () => {
      expect(AuditContext.getActionOverride()).toBe('custom.action');
    });
  });

  it('allows mutating the store within a run', () => {
    AuditContext.run({ actor, noAudit: false }, () => {
      const store = AuditContext.getStore();
      expect(store).toBeDefined();
      store!.noAudit = true;
      store!.actionOverride = 'overridden';
      expect(AuditContext.isNoAudit()).toBe(true);
      expect(AuditContext.getActionOverride()).toBe('overridden');
    });
  });

  it('returns false for auditBypass outside a context', () => {
    expect(AuditContext.isAuditBypass()).toBe(false);
  });

  it('supports _auditBypass flag for recursion guard', () => {
    AuditContext.run({ actor, noAudit: false, _auditBypass: true }, () => {
      expect(AuditContext.isAuditBypass()).toBe(true);
    });
  });

  it('isolates contexts between nested runs', async () => {
    await new Promise<void>((resolve) => {
      AuditContext.run({ actor, noAudit: false }, () => {
        expect(AuditContext.getActor()?.id).toBe('user-1');

        const otherActor: AuditActor = { id: 'user-2', type: 'system' };
        AuditContext.run({ actor: otherActor, noAudit: true }, () => {
          expect(AuditContext.getActor()?.id).toBe('user-2');
          expect(AuditContext.isNoAudit()).toBe(true);
        });

        // Outer context restored
        expect(AuditContext.getActor()?.id).toBe('user-1');
        expect(AuditContext.isNoAudit()).toBe(false);
        resolve();
      });
    });
  });
});
