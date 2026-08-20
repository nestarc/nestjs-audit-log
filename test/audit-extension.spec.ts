import { AuditContext } from '../src/services/audit-context';
import {
  _resetNoContextWarning,
  modelDelegateName,
  buildAuditInsertParams,
  getPkField,
} from '../src/prisma/audit-extension';

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
    beforeEach(() => {
      _resetNoContextWarning();
    });

    it('builds insert params from context and input', () => {
      const result = AuditContext.run(
        { actor: { id: 'u1', type: 'user', ip: '1.2.3.4' }, noAudit: false },
        () =>
          buildAuditInsertParams({
            action: 'User.created',
            targetType: 'User',
            targetId: 'user-1',
            changes: { name: { after: 'Alice' } },
            result: 'failure',
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
      expect(result.result).toBe('failure');
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

    it('merges context metadata and reason into audit insert params', () => {
      const result = AuditContext.run(
        {
          actor: { id: 'u1', type: 'user' },
          noAudit: false,
          metadata: { correlationId: 'req-1', source: 'context' },
          reason: 'context reason',
        },
        () =>
          buildAuditInsertParams({
            action: 'User.updated',
            targetType: 'User',
            targetId: 'user-1',
            changes: {},
            metadata: { source: 'input' },
          }),
      );

      expect(result.metadata).toEqual({
        correlationId: 'req-1',
        reason: 'context reason',
        source: 'input',
      });
    });

    it('defaults to system actor when no context', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = buildAuditInsertParams({
        action: 'User.created',
        targetType: 'User',
        targetId: 'user-1',
        changes: {},
      });

      expect(result.actorId).toBeNull();
      expect(result.actorType).toBe('system');
      expect(result.actorIp).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('reports a missing context store once via onAuditError', () => {
      const onAuditError = jest.fn();

      buildAuditInsertParams(
        {
          action: 'User.created',
          targetType: 'User',
          targetId: 'user-1',
          operation: 'create',
          changes: {},
        },
        { consistency: 'best-effort', onAuditError },
      );
      buildAuditInsertParams(
        {
          action: 'User.updated',
          targetType: 'User',
          targetId: 'user-1',
          operation: 'update',
          changes: {},
        },
        { consistency: 'best-effort', onAuditError },
      );

      expect(onAuditError).toHaveBeenCalledTimes(1);
      expect(onAuditError).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            '[@nestarc/audit-log] audited write executed without an audit context store — actorId will be null. Wrap background work in AuditContext.runAs(actor, fn). (warned once per process)',
        }),
        expect.objectContaining({
          phase: 'context',
          model: 'User',
          operation: 'create',
          action: 'User.created',
        }),
      );
    });

    it('uses logger.warn for a missing context store when onAuditError is absent', () => {
      const logger = { warn: jest.fn(), error: jest.fn() };

      buildAuditInsertParams(
        {
          action: 'User.created',
          targetType: 'User',
          targetId: 'user-1',
          operation: 'create',
          changes: {},
        },
        { consistency: 'best-effort', logger },
      );

      expect(logger.warn).toHaveBeenCalledWith(
        '[@nestarc/audit-log] audited write executed without an audit context store — actorId will be null. Wrap background work in AuditContext.runAs(actor, fn). (warned once per process)',
      );
    });
  });
});
