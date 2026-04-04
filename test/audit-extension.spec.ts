import { AuditContext } from '../src/services/audit-context';
import { modelDelegateName, buildAuditInsertParams, getPkField } from '../src/prisma/audit-extension';

describe('Prisma Audit Extension helpers', () => {
  describe('getPkField', () => {
    it('returns "id" by default when no primaryKey map', () => {
      expect(getPkField('User', {})).toBe('id');
    });

    it('returns "id" when model is not in primaryKey map', () => {
      expect(getPkField('User', { primaryKey: { Order: 'orderNumber' } })).toBe('id');
    });

    it('returns custom PK when model is in primaryKey map', () => {
      expect(getPkField('Order', { primaryKey: { Order: 'orderNumber' } })).toBe('orderNumber');
    });
  });

  describe('modelDelegateName', () => {
    it('converts User to user', () => {
      expect(modelDelegateName('User')).toBe('user');
    });

    it('converts InvoiceItem to invoiceItem', () => {
      expect(modelDelegateName('InvoiceItem')).toBe('invoiceItem');
    });

    it('converts A to a', () => {
      expect(modelDelegateName('A')).toBe('a');
    });
  });

  describe('buildAuditInsertParams', () => {
    it('builds insert params from context and input', () => {
      const result = AuditContext.run(
        { actor: { id: 'u1', type: 'user', ip: '1.2.3.4' }, noAudit: false },
        () =>
          buildAuditInsertParams({
            action: 'User.created',
            targetType: 'User',
            targetId: 'user-1',
            changes: { name: { after: 'Alice' } },
          }),
      );

      expect(result.actorId).toBe('u1');
      expect(result.actorType).toBe('user');
      expect(result.actorIp).toBe('1.2.3.4');
      expect(result.action).toBe('User.created');
      expect(result.targetType).toBe('User');
      expect(result.targetId).toBe('user-1');
      expect(result.source).toBe('auto');
      expect(result.changes).toEqual({ name: { after: 'Alice' } });
    });

    it('uses actionOverride when present in context', () => {
      const result = AuditContext.run(
        {
          actor: { id: 'u1', type: 'user' },
          noAudit: false,
          actionOverride: 'custom.action',
        },
        () =>
          buildAuditInsertParams({
            action: 'User.created',
            targetType: 'User',
            targetId: 'user-1',
            changes: {},
          }),
      );

      expect(result.action).toBe('custom.action');
    });

    it('defaults to system actor when no context', () => {
      const result = buildAuditInsertParams({
        action: 'User.created',
        targetType: 'User',
        targetId: 'user-1',
        changes: {},
      });

      expect(result.actorId).toBeNull();
      expect(result.actorType).toBe('system');
      expect(result.actorIp).toBeNull();
    });
  });
});
