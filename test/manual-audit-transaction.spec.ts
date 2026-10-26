import type { ManualAuditLogInput } from '../src/interfaces/audit-entry.interface';
import { AuditContext } from '../src/services/audit-context';
import {
  runManualAuditTransaction,
  type ManualAuditTransactionOptions,
  type ManualAuditTransactionScope,
} from '../src/services/manual-audit-transaction';

interface FakeTransaction {
  id: number;
  events: string[];
  write(value: string): Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const started = jest.fn();
  const committed: string[][] = [];
  const rolledBack: string[][] = [];
  let nextId = 0;
  const client = {
    async $transaction<T>(
      callback: (tx: FakeTransaction) => Promise<T>,
      options?: ManualAuditTransactionOptions,
    ): Promise<T> {
      started(options);
      const events: string[] = [];
      const tx: FakeTransaction = {
        id: ++nextId,
        events,
        write: async value => { events.push(`business:${value}`); },
      };
      try {
        const value = await callback(tx);
        committed.push([...events]);
        return value;
      } catch (error) {
        rolledBack.push([...events]);
        throw error;
      }
    },
  };
  const logFn = jest.fn(async (input: ManualAuditLogInput, tx: FakeTransaction) => {
    tx.events.push(`audit:${input.action}`);
  });
  return { client, started, committed, rolledBack, logFn };
}

describe('manual audit transaction helper', () => {
  it('uses the official transaction client for business and audit writes and returns the result', async () => {
    const f = fixture();
    const options = { timeout: 5_000, maxWait: 2_000, isolationLevel: 'Serializable' as const };
    const result = await runManualAuditTransaction(f.client, f.logFn, async ({ tx, log }) => {
      await tx.write('approved');
      await log({ action: 'invoice.approved' });
      expect(f.logFn.mock.calls[0][1]).toBe(tx);
      return { id: tx.id };
    }, options);
    expect(result).toEqual({ id: 1 });
    expect(f.started).toHaveBeenCalledWith(options);
    expect(f.started.mock.calls[0][0]).not.toBe(options);
    expect(f.committed).toEqual([['business:approved', 'audit:invoice.approved']]);
    expect(f.rolledBack).toEqual([]);
  });

  it.each([new Error('audit insert failed'), null, undefined])(
    'rolls back a caught audit failure and preserves the thrown value %s', async failure => {
      const f = fixture();
      f.logFn.mockRejectedValueOnce(failure);
      await expect(runManualAuditTransaction(f.client, f.logFn, async ({ tx, log }) => {
        await tx.write('before');
        try { await log({ action: 'failed' }); } catch { /* Caller attempts to continue. */ }
        await tx.write('after');
        return 'caught';
      })).rejects.toBe(failure);
      expect(f.committed).toEqual([]);
      expect(f.rolledBack).toEqual([['business:before', 'business:after']]);
    },
  );

  it('remembers the first audit rejection even after a later successful log and another failure', async () => {
    const f = fixture();
    const first = { failure: 'first' };
    f.logFn.mockRejectedValueOnce(first).mockResolvedValueOnce(undefined).mockRejectedValueOnce('last');
    await expect(runManualAuditTransaction(f.client, f.logFn, async ({ log }) => {
      for (const action of ['first', 'success', 'last']) {
        try { await log({ action }); } catch { /* Exercise sticky failure state. */ }
      }
    })).rejects.toBe(first);
    expect(f.logFn).toHaveBeenCalledTimes(3);
    expect(f.committed).toEqual([]);
  });

  it('also captures a synchronous log function throw', async () => {
    const f = fixture();
    const failure = new Error('serialization');
    f.logFn.mockImplementationOnce(() => { throw failure; });
    await expect(runManualAuditTransaction(f.client, f.logFn, async ({ log }) => {
      await log({ action: 'invalid' });
    })).rejects.toBe(failure);
    expect(f.rolledBack).toHaveLength(1);
  });

  it('waits for a started but unawaited audit call before committing', async () => {
    const f = fixture();
    const write = deferred<void>();
    const callbackDone = deferred<void>();
    f.logFn.mockImplementationOnce(async (input, tx) => {
      await write.promise;
      tx.events.push(`audit:${input.action}`);
    });
    const completion = runManualAuditTransaction(f.client, f.logFn, async ({ tx, log }) => {
      await tx.write('before');
      void log({ action: 'unawaited' });
      callbackDone.resolve();
      return 'done';
    });
    await callbackDone.promise;
    await Promise.resolve();
    expect(f.committed).toEqual([]);
    write.resolve();
    await expect(completion).resolves.toBe('done');
    expect(f.committed).toEqual([['business:before', 'audit:unawaited']]);
  });

  it('invokes logging at the call site before synchronous context or input mutations', async () => {
    const f = fixture();
    const actor = { id: 'original-actor', type: 'user' as const };
    const input = { action: 'original-action' };
    const observed: Array<{ actorId: string | null | undefined; action: string }> = [];
    f.logFn.mockImplementation(async event => {
      observed.push({ actorId: AuditContext.getActor()?.id, action: event.action });
    });
    await AuditContext.runAs(actor, () => runManualAuditTransaction(f.client, f.logFn, async ({ log }) => {
      void log(input);
      actor.id = 'mutated-actor';
      input.action = 'mutated-action';
    }));
    expect(observed).toEqual([{ actorId: 'original-actor', action: 'original-action' }]);
  });

  it('rolls back a started but unawaited audit failure without an unhandled rejection', async () => {
    const f = fixture();
    const write = deferred<void>();
    const callbackDone = deferred<void>();
    const failure = new Error('late insert failure');
    f.logFn.mockImplementationOnce(() => write.promise);
    const completion = runManualAuditTransaction(f.client, f.logFn, async ({ log }) => {
      void log({ action: 'unawaited' });
      callbackDone.resolve();
    });
    const assertion = expect(completion).rejects.toBe(failure);
    await callbackDone.promise;
    write.reject(failure);
    await assertion;
    expect(f.committed).toEqual([]);
    expect(f.rolledBack).toHaveLength(1);
  });

  it.each([new Error('business failed'), null, undefined])(
    'preserves callback failure %s and drains already-started writes before rollback', async failure => {
      const f = fixture();
      const write = deferred<void>();
      const callbackDone = deferred<void>();
      f.logFn.mockImplementationOnce(() => write.promise);
      const completion = runManualAuditTransaction(f.client, f.logFn, async ({ log }) => {
        void log({ action: 'pending' });
        callbackDone.resolve();
        throw failure;
      });
      const assertion = expect(completion).rejects.toBe(failure);
      await callbackDone.promise;
      await Promise.resolve();
      expect(f.rolledBack).toEqual([]);
      write.reject(new Error('secondary audit failure'));
      await assertion;
      expect(f.committed).toEqual([]);
      expect(f.rolledBack).toHaveLength(1);
    },
  );

  it('isolates concurrent helper scopes and their failure markers', async () => {
    const f = fixture();
    const secondEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const failure = new Error('first only');
    f.logFn.mockImplementation(async (input, tx) => {
      if (input.action === 'fail') throw failure;
      tx.events.push(`audit:${input.action}`);
    });
    const first = runManualAuditTransaction(f.client, f.logFn, async ({ tx, log }) => {
      await tx.write('first');
      await secondEntered.promise;
      try { await log({ action: 'fail' }); } catch { /* First scope remains failed. */ }
      await releaseFirst.promise;
    });
    const firstAssertion = expect(first).rejects.toBe(failure);
    const second = runManualAuditTransaction(f.client, f.logFn, async ({ tx, log }) => {
      secondEntered.resolve();
      await tx.write('second');
      await log({ action: 'success' });
      return tx.id;
    });
    await expect(second).resolves.toBe(2);
    releaseFirst.resolve();
    await firstAssertion;
    expect(f.committed).toEqual([['business:second', 'audit:success']]);
    expect(f.rolledBack).toEqual([['business:first']]);
  });

  it('rejects a nested helper even with another client and writer', async () => {
    const outer = fixture();
    const inner = fixture();
    await expect(runManualAuditTransaction(outer.client, outer.logFn, async () =>
      runManualAuditTransaction(inner.client, inner.logFn, async () => 'nested'),
    )).rejects.toThrow('nested withManualTransaction');
    expect(inner.started).not.toHaveBeenCalled();
    expect(outer.rolledBack).toHaveLength(1);
  });

  it('continues rejecting nested helpers until the host finishes committing', async () => {
    const outer = fixture();
    const inner = fixture();
    const commitStarted = deferred<void>();
    const releaseCommit = deferred<void>();
    const callbackEntered = deferred<void>();
    let nestedCompletion!: Promise<string>;
    const client = {
      async $transaction<T>(callback: (tx: FakeTransaction) => Promise<T>): Promise<T> {
        const result = await outer.client.$transaction(callback);
        commitStarted.resolve();
        await releaseCommit.promise;
        return result;
      },
    };
    const completion = runManualAuditTransaction(client, outer.logFn, async () => {
      nestedCompletion = commitStarted.promise.then(() =>
        runManualAuditTransaction(inner.client, inner.logFn, async () => 'nested'),
      );
      void nestedCompletion.catch(() => undefined);
      callbackEntered.resolve();
      return 'outer';
    });
    await callbackEntered.promise;
    await expect(nestedCompletion).rejects.toThrow('nested withManualTransaction');
    expect(inner.started).not.toHaveBeenCalled();
    releaseCommit.resolve();
    await expect(completion).resolves.toBe('outer');
  });

  it('revokes the writer as soon as the callback ends while existing writes drain', async () => {
    const f = fixture();
    const pendingWrite = deferred<void>();
    const callbackDone = deferred<void>();
    let captured!: ManualAuditTransactionScope<FakeTransaction>;
    f.logFn.mockImplementationOnce(() => pendingWrite.promise);
    const completion = runManualAuditTransaction(f.client, f.logFn, async scope => {
      captured = scope;
      void scope.log({ action: 'accepted' });
      callbackDone.resolve();
    });
    await callbackDone.promise;
    await Promise.resolve();
    await expect(captured.log({ action: 'too-late' })).rejects.toThrow('scope has ended');
    expect(f.logFn).toHaveBeenCalledTimes(1);
    pendingWrite.resolve();
    await completion;
    await expect(captured.log({ action: 'after-commit' })).rejects.toThrow('scope has ended');
    expect(f.logFn).toHaveBeenCalledTimes(1);
  });

  it('revokes the writer when the transaction host aborts before the callback settles', async () => {
    const f = fixture();
    const callbackEntered = deferred<void>();
    const callbackRelease = deferred<void>();
    const hostAbort = deferred<never>();
    let captured!: ManualAuditTransactionScope<FakeTransaction>;
    const client = {
      $transaction<T>(callback: (tx: FakeTransaction) => Promise<T>): Promise<T> {
        return Promise.race([f.client.$transaction(callback), hostAbort.promise]);
      },
    };
    const completion = runManualAuditTransaction(client, f.logFn, async scope => {
      captured = scope;
      callbackEntered.resolve();
      await callbackRelease.promise;
    });
    const timeout = new Error('transaction timeout');
    const assertion = expect(completion).rejects.toBe(timeout);
    await callbackEntered.promise;
    hostAbort.reject(timeout);
    await assertion;
    await expect(captured.log({ action: 'expired' })).rejects.toThrow('scope has ended');
    expect(f.logFn).not.toHaveBeenCalled();
    callbackRelease.resolve();
  });

  it.each([
    null, [], { timeout: 0 }, { timeout: -1 }, { maxWait: 1.5 },
    { timeout: NaN }, { timeout: Infinity }, { timeout: Number.MAX_SAFE_INTEGER + 1 },
    { isolationLevel: 'invalid' }, { unexpected: true }, { timeout: '1000' },
  ])('rejects invalid options before starting a transaction: %p', async options => {
    const f = fixture();
    await expect(runManualAuditTransaction(
      f.client, f.logFn, async () => undefined, options as ManualAuditTransactionOptions,
    )).rejects.toBeInstanceOf(TypeError);
    expect(f.started).not.toHaveBeenCalled();
    expect(f.logFn).not.toHaveBeenCalled();
  });

  it('validates the host and callbacks before database access', async () => {
    const f = fixture();
    for (const client of [undefined, null, {}]) {
      await expect(runManualAuditTransaction(client as never, f.logFn, async () => undefined))
        .rejects.toThrow('transaction client host');
    }
    await expect(runManualAuditTransaction(f.client, null as never, async () => undefined))
      .rejects.toThrow('log function and callback');
    await expect(runManualAuditTransaction(f.client, f.logFn, undefined as never))
      .rejects.toThrow('log function and callback');
    expect(f.started).not.toHaveBeenCalled();
  });
});
