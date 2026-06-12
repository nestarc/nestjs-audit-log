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

  it('awaits async actorExtractor before starting context', (done) => {
    middleware = new AuditActorMiddleware({
      prisma: {},
      actorExtractor: async () => ({
        id: 'async-user',
        type: 'user',
      }),
    });

    middleware.use({}, {}, () => {
      expect(AuditContext.getActor()).toEqual({
        id: 'async-user',
        type: 'user',
      });
      done();
    });
  });

  it('seeds correlationId metadata from x-request-id header', (done) => {
    const req = {
      headers: { 'x-request-id': 'req-1' },
      ip: '127.0.0.1',
    };

    middleware.use(req, {}, () => {
      expect(AuditContext.getMetadata()).toEqual({ correlationId: 'req-1' });
      done();
    });
  });

  it('uses custom correlationIdHeader and takes the first array value', (done) => {
    middleware = new AuditActorMiddleware({
      ...options,
      correlationIdHeader: 'x-correlation-id',
    });
    const req = {
      headers: { 'x-correlation-id': ['req-2', 'req-3'] },
      ip: '127.0.0.1',
    };

    middleware.use(req, {}, () => {
      expect(AuditContext.getMetadata()).toEqual({ correlationId: 'req-2' });
      done();
    });
  });

  it('lets correlationIdGetter replace header lookup entirely', (done) => {
    middleware = new AuditActorMiddleware({
      ...options,
      correlationIdGetter: () => undefined,
    });
    const req = {
      headers: { 'x-request-id': 'ignored' },
      ip: '127.0.0.1',
    };

    middleware.use(req, {}, () => {
      expect(AuditContext.getMetadata()).toBeUndefined();
      done();
    });
  });

  it('reports correlationIdGetter failures and continues without metadata', (done) => {
    const error = new Error('getter failed');
    const onAuditError = jest.fn();
    middleware = new AuditActorMiddleware({
      ...options,
      correlationIdGetter: () => {
        throw error;
      },
      onAuditError,
    });

    middleware.use({}, {}, () => {
      expect(AuditContext.getMetadata()).toBeUndefined();
      expect(onAuditError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ phase: 'context' }),
      );
      done();
    });
  });

  it('reports extractor failures and continues with null actor', (done) => {
    const error = new Error('extractor failed');
    const onAuditError = jest.fn();
    middleware = new AuditActorMiddleware({
      prisma: {},
      actorExtractor: () => {
        throw error;
      },
      onAuditError,
    });

    middleware.use({}, {}, () => {
      expect(AuditContext.getActor()).toBeNull();
      expect(onAuditError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ phase: 'context' }),
      );
      done();
    });
  });

  it('falls back to logger.error when context setup fails without onAuditError', (done) => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const error = new Error('extractor failed');
    middleware = new AuditActorMiddleware({
      prisma: {},
      actorExtractor: () => {
        throw error;
      },
      logger,
    });

    middleware.use({}, {}, () => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('extractor failed'),
      );
      done();
    });
  });
});
