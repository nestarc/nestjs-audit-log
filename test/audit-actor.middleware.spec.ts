import { AuditActorMiddleware } from '../src/middleware/audit-actor.middleware';
import { AuditContext } from '../src/services/audit-context';
import { AuditLogModuleOptions } from '../src/interfaces/audit-log-options.interface';

describe('AuditActorMiddleware', () => {
  const options: AuditLogModuleOptions = {
    prisma: {},
    actorExtractor: (req: any) => ({
      id: req.user?.id ?? null,
      type: req.user ? 'user' : 'system',
      ip: req.ip,
    }),
  };

  let middleware: AuditActorMiddleware;

  beforeEach(() => {
    middleware = new AuditActorMiddleware(options);
  });

  it('extracts actor from request and sets AuditContext', (done) => {
    const req = { user: { id: 'user-1' }, ip: '10.0.0.1' };
    const res = {};

    middleware.use(req, res, () => {
      const actor = AuditContext.getActor();
      expect(actor).toEqual({ id: 'user-1', type: 'user', ip: '10.0.0.1' });
      done();
    });
  });

  it('sets system actor when no user on request', (done) => {
    const req = { ip: '10.0.0.1' };
    const res = {};

    middleware.use(req, res, () => {
      const actor = AuditContext.getActor();
      expect(actor).toEqual({ id: null, type: 'system', ip: '10.0.0.1' });
      done();
    });
  });

  it('initializes noAudit to false', (done) => {
    const req = { ip: '127.0.0.1' };
    const res = {};

    middleware.use(req, res, () => {
      expect(AuditContext.isNoAudit()).toBe(false);
      done();
    });
  });
});
