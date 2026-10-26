import type { AuditErrorContext } from '../src/interfaces/audit-shared-options.interface';
import {
  invokeAuditObserver,
  reportAuditError,
} from '../src/prisma/audit-extension/audit-errors';
import type { AuditRuntimeOptions } from '../src/prisma/audit-extension/audit-errors';
import {
  _resetNoContextWarning,
  buildAuditInsertParams,
} from '../src/prisma/audit-extension/audit-insert';

const flushObservers = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const failingObservers: Array<[string, (failure: Error) => () => unknown]> = [
  ['synchronous throw', failure => () => { throw failure; }],
  ['rejected promise', failure => () => Promise.reject(failure)],
  ['rejecting thenable', failure => () => ({
    then(_resolve: unknown, reject: (error: unknown) => void) { reject(failure); },
  })],
  ['throwing thenable', failure => () => ({ then() { throw failure; } })],
  ['throwing then getter', failure => () => Object.defineProperty({}, 'then', {
    get() { throw failure; },
  })],
];

describe('audit observer isolation', () => {
  it.each(failingObservers)('isolates %s and reports its original cause once', async (_name, observer) => {
    const failure = new Error('diagnostic failed');
    const onError = jest.fn();
    expect(() => invokeAuditObserver(observer(failure), [], onError)).not.toThrow();
    await flushObservers();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it.each(failingObservers)('also isolates a failure reporter with %s', async (_name, observer) => {
    const reporter = jest.fn(observer(new Error('reporter failed')));
    expect(() => invokeAuditObserver(() => { throw new Error('observer failed'); }, [], reporter)).not.toThrow();
    await flushObservers();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('passes arguments synchronously and does not wait for observer completion', async () => {
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const callback = jest.fn((_value: { operation: string }) => pending);
    const value = { operation: 'log' };
    expect(invokeAuditObserver(callback, [value])).toBeUndefined();
    expect(callback).toHaveBeenCalledWith(value);
    complete();
    await flushObservers();
  });

  it('uses the first thenable settlement even if it later rejects and throws', async () => {
    const onError = jest.fn();
    invokeAuditObserver(() => ({
      then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        resolve(undefined);
        reject(new Error('late rejection'));
        throw new Error('late throw');
      },
    }), [], onError);
    await flushObservers();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not invoke a returned promise\'s overridden catch method', async () => {
    const failure = new Error('observer failed');
    const promise = Promise.reject(failure);
    const poison = jest.fn(() => { throw new Error('poisoned catch'); });
    void Object.defineProperty(promise, 'catch', { value: poison });
    const onError = jest.fn();
    invokeAuditObserver(() => promise, [], onError);
    await flushObservers();
    expect(poison).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe('automatic audit error reporting', () => {
  const context: AuditErrorContext = { phase: 'insert', model: 'Invoice', operation: 'update' };

  it.each(failingObservers)('preserves best-effort completion when its hook has %s', async (_name, observer) => {
    const original = new Error('audit insert failed');
    const logger = { warn: jest.fn(), error: jest.fn() };
    const hook = jest.fn(observer(new Error('hook failed')));
    expect(() => reportAuditError({ consistency: 'best-effort', onAuditError: hook, logger }, original, context)).not.toThrow();
    await flushObservers();
    expect(hook).toHaveBeenCalledWith(original, context);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('onAuditError callback threw: hook failed'));
  });

  it.each(failingObservers)('marks atomic failure before a hook with %s and throws the original error', async (_name, observer) => {
    const original = new Error('audit insert failed');
    const order: string[] = [];
    const callback = observer(new Error('hook failed'));
    const markAtomicFailure = jest.fn((error: unknown) => {
      expect(error).toBe(original);
      order.push('mark');
    });
    const options: AuditRuntimeOptions = {
      consistency: 'atomic-required', markAtomicFailure,
      onAuditError: () => { order.push('hook'); return callback(); },
      logger: { warn: jest.fn(), error: (): unknown => Promise.reject(new Error('logger failed')) },
    };
    let thrown: unknown;
    try { reportAuditError(options, original, context); } catch (error) { thrown = error; }
    expect(thrown).toBe(original);
    expect(order).toEqual(['mark', 'hook']);
    await flushObservers();
    expect(markAtomicFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps atomic failure semantics when a callback changes its options', () => {
    const original = new Error('audit insert failed');
    const options: AuditRuntimeOptions = {
      consistency: 'atomic-required',
      onAuditError: () => { options.consistency = 'best-effort'; },
    };
    expect(() => reportAuditError(options, original, context)).toThrow(original);
  });

  it.each(failingObservers)('isolates default warnings with %s', async (_name, observer) => {
    const original = new Error('audit insert failed');
    const warn = observer(new Error('logger failed'));
    expect(() => reportAuditError({ consistency: 'best-effort', logger: { warn, error: jest.fn() } }, original, context)).not.toThrow();
    await flushObservers();
  });

  it('preserves original atomic failures even when diagnostic formatting throws', () => {
    const original = { toString: () => { throw new Error('formatting failed'); } };
    let thrown: unknown;
    try {
      reportAuditError({ consistency: 'atomic-required', logger: { warn: jest.fn(), error: jest.fn() } }, original, context);
    } catch (error) { thrown = error; }
    expect(thrown).toBe(original);
  });
});

describe('missing-context diagnostics', () => {
  const input = { action: 'Invoice.updated', targetType: 'Invoice', targetId: 'invoice-1', changes: {} };
  beforeEach(_resetNoContextWarning);
  afterEach(_resetNoContextWarning);

  it.each(failingObservers)('keeps the once-only warning and insert parameters when its hook has %s', async (_name, observer) => {
    const onAuditError = jest.fn(observer(new Error('hook failed')));
    const logger = { warn: jest.fn(), error: () => Promise.reject(new Error('logger failed')) };
    const options = { consistency: 'atomic-required' as const, onAuditError, logger };
    expect(buildAuditInsertParams(input, options)).toMatchObject({ actorId: null, action: input.action });
    expect(buildAuditInsertParams(input, options)).toMatchObject({ actorId: null, action: input.action });
    await flushObservers();
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(onAuditError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('without an audit context store') }),
      expect.objectContaining({ phase: 'context', model: 'Invoice' }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('absorbs rejected default warning promises and warns only once', async () => {
    const warn = jest.fn(() => Promise.reject(new Error('logger failed')));
    const options = { logger: { warn, error: jest.fn() } };
    expect(buildAuditInsertParams(input, options)).not.toBeNull();
    expect(buildAuditInsertParams(input, options)).not.toBeNull();
    await flushObservers();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
