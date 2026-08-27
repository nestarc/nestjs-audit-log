import { EventEmitter } from 'node:events';

type RunOptions = { cleanup?: boolean };
type RunScript = (
  script: string,
  args?: string[],
  options?: RunOptions,
) => Promise<number>;

interface FakeChild extends EventEmitter {
  pid: number;
  kill: jest.Mock;
}

type SpawnImpl = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => FakeChild;

interface ProcessController {
  getInterruptExitCode(): number;
  handleSignal(signal: string): void;
  run(command: string, args: string[], options?: RunOptions): Promise<number>;
}

const {
  createProcessController,
  exitCodeForSignal,
  main,
  npmInvocation,
  runE2E,
} = require('../scripts/run-e2e.cjs') as {
  createProcessController(options: {
    forceKillAfterMs?: number;
    killImpl?: (pid: number, signal: string) => boolean;
    platform?: NodeJS.Platform;
    spawnImpl: SpawnImpl;
    stderr?: { write(message: string): unknown };
  }): ProcessController;
  exitCodeForSignal(signal: string): number;
  main(options: {
    processRef: EventEmitter & {
      argv: string[];
      env: NodeJS.ProcessEnv;
      execPath: string;
      platform: NodeJS.Platform;
      stderr: { write(message: string): unknown };
    };
    spawnImpl: SpawnImpl;
  }): Promise<number>;
  npmInvocation(options: {
    env: NodeJS.ProcessEnv;
    execPath: string;
    platform: NodeJS.Platform;
  }): { command: string; args: string[] };
  runE2E(options: {
    getInterruptExitCode?: () => number;
    runScript: RunScript;
    testArgs?: string[];
  }): Promise<number>;
};

describe('E2E runner orchestration', () => {
  it('preserves conventional exit codes for unhandled POSIX child signals', () => {
    expect(exitCodeForSignal('SIGKILL')).toBe(137);
    expect(exitCodeForSignal('SIGSEGV')).toBe(139);
    expect(exitCodeForSignal('UNKNOWN')).toBe(1);
  });

  it('runs setup, tests, and teardown in order while forwarding Jest arguments', async () => {
    const runScript = jest.fn<ReturnType<RunScript>, Parameters<RunScript>>();
    runScript.mockResolvedValue(0);

    await expect(
      runE2E({
        runScript,
        testArgs: ['--runTestsByPath', 'test/e2e/audit-log.e2e-spec.ts'],
      }),
    ).resolves.toBe(0);

    expect(runScript.mock.calls).toEqual([
      ['test:e2e:setup'],
      ['test:e2e', ['--runTestsByPath', 'test/e2e/audit-log.e2e-spec.ts']],
      ['test:e2e:teardown', [], { cleanup: true }],
    ]);
  });

  it('cleans up after setup failure and preserves the setup exit code', async () => {
    const runScript = jest.fn<ReturnType<RunScript>, Parameters<RunScript>>();
    runScript.mockResolvedValueOnce(23).mockResolvedValueOnce(9);

    await expect(runE2E({ runScript })).resolves.toBe(23);
    expect(runScript.mock.calls).toEqual([
      ['test:e2e:setup'],
      ['test:e2e:teardown', [], { cleanup: true }],
    ]);
  });

  it('cleans up after test failure without masking the test exit code', async () => {
    const runScript = jest.fn<ReturnType<RunScript>, Parameters<RunScript>>();
    runScript.mockResolvedValueOnce(0).mockResolvedValueOnce(7).mockResolvedValueOnce(9);

    await expect(runE2E({ runScript })).resolves.toBe(7);
    expect(runScript).toHaveBeenCalledTimes(3);
  });

  it('returns the teardown exit code when the tests succeeded', async () => {
    const runScript = jest.fn<ReturnType<RunScript>, Parameters<RunScript>>();
    runScript.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(9);

    await expect(runE2E({ runScript })).resolves.toBe(9);
  });

  it('prefers an interrupt exit code over cleanup failure after successful work', async () => {
    const runScript = jest.fn<ReturnType<RunScript>, Parameters<RunScript>>();
    runScript.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(9);

    await expect(
      runE2E({ getInterruptExitCode: () => 130, runScript }),
    ).resolves.toBe(130);
  });
});

describe('E2E runner process control', () => {
  function fakeChild(pid = 4242): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = pid;
    child.kill = jest.fn();
    return child;
  }

  it('forwards only the first interrupt to the active POSIX process group', async () => {
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    const killImpl = jest.fn(() => true);
    const controller = createProcessController({
      forceKillAfterMs: 60_000,
      killImpl,
      platform: 'darwin',
      spawnImpl,
      stderr: { write: jest.fn() },
    });

    const result = controller.run('node', ['command.js']);
    controller.handleSignal('SIGINT');
    controller.handleSignal('SIGTERM');
    child.emit('close', null, 'SIGINT');

    await expect(result).resolves.toBe(130);
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGINT');
    expect(controller.getInterruptExitCode()).toBe(130);
  });

  it('preserves the original interrupt code when the child requires SIGKILL', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      const killImpl = jest.fn(() => true);
      const controller = createProcessController({
        forceKillAfterMs: 5_000,
        killImpl,
        platform: 'darwin',
        spawnImpl: () => child,
        stderr: { write: jest.fn() },
      });

      const result = controller.run('node', ['command.js']);
      controller.handleSignal('SIGTERM');
      jest.advanceTimersByTime(5_000);
      child.emit('close', null, 'SIGKILL');

      await expect(result).resolves.toBe(143);
      expect(killImpl.mock.calls).toEqual([
        [-4242, 'SIGTERM'],
        [-4242, 'SIGKILL'],
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite a numeric child failure that wins an interrupt race', async () => {
    const child = fakeChild();
    const controller = createProcessController({
      forceKillAfterMs: 60_000,
      killImpl: jest.fn(() => true),
      platform: 'darwin',
      spawnImpl: () => child,
      stderr: { write: jest.fn() },
    });

    const result = controller.run('node', ['command.js']);
    controller.handleSignal('SIGINT');
    child.emit('close', 7, null);

    await expect(result).resolves.toBe(7);
    expect(controller.getInterruptExitCode()).toBe(130);
  });

  it('skips new work after interruption but still permits cleanup', async () => {
    const cleanupChild = fakeChild();
    const spawnImpl = jest.fn(() => cleanupChild);
    const controller = createProcessController({
      platform: 'darwin',
      spawnImpl,
      stderr: { write: jest.fn() },
    });

    controller.handleSignal('SIGTERM');
    await expect(controller.run('node', ['test.js'])).resolves.toBe(143);
    expect(spawnImpl).not.toHaveBeenCalled();

    const cleanup = controller.run('node', ['cleanup.js'], { cleanup: true });
    expect(cleanupChild.kill).not.toHaveBeenCalled();
    cleanupChild.emit('close', 0, null);

    await expect(cleanup).resolves.toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('allows a repeated signal to stop cleanup that does not finish', async () => {
    const cleanupChild = fakeChild();
    const killImpl = jest.fn(() => true);
    const controller = createProcessController({
      forceKillAfterMs: 60_000,
      killImpl,
      platform: 'darwin',
      spawnImpl: () => cleanupChild,
      stderr: { write: jest.fn() },
    });

    const cleanup = controller.run('node', ['cleanup.js'], { cleanup: true });
    controller.handleSignal('SIGINT');
    expect(killImpl).not.toHaveBeenCalled();

    controller.handleSignal('SIGINT');
    expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGINT');
    cleanupChild.emit('close', null, 'SIGINT');

    await expect(cleanup).resolves.toBe(130);
  });

  it('settles once when a spawn error is followed by close', async () => {
    const child = fakeChild();
    const controller = createProcessController({
      platform: 'darwin',
      spawnImpl: () => child,
      stderr: { write: jest.fn() },
    });

    const result = controller.run('missing-command', []);
    child.emit('error', new Error('not found'));
    child.emit('close', 0, null);

    await expect(result).resolves.toBe(1);
  });

  it('uses the active npm CLI and keeps the Windows path shell-free', () => {
    expect(
      npmInvocation({
        env: { npm_execpath: '/opt/npm/npm-cli.js' },
        execPath: '/opt/node',
        platform: 'linux',
      }),
    ).toEqual({ command: '/opt/node', args: ['/opt/npm/npm-cli.js'] });
    expect(npmInvocation({ env: {}, execPath: 'node', platform: 'linux' })).toEqual({
      command: 'npm',
      args: [],
    });
    expect(() =>
      npmInvocation({ env: {}, execPath: 'node', platform: 'win32' }),
    ).toThrow('run the E2E wrapper through npm run test:e2e:full');
  });

  it('assembles npm arguments and removes signal handlers through main', async () => {
    let nextPid = 5000;
    const spawnImpl = jest.fn<ReturnType<SpawnImpl>, Parameters<SpawnImpl>>(() => {
      const child = fakeChild(nextPid++);
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    const processRef = Object.assign(new EventEmitter(), {
      argv: [
        '/opt/node',
        'scripts/run-e2e.cjs',
        '--runTestsByPath',
        'test/e2e/audit-log.e2e-spec.ts',
      ],
      env: { npm_execpath: '/opt/npm/npm-cli.js' },
      execPath: '/opt/node',
      platform: 'linux' as NodeJS.Platform,
      stderr: { write: jest.fn() },
    });

    await expect(main({ processRef, spawnImpl })).resolves.toBe(0);
    expect(
      spawnImpl.mock.calls.map(([command, args, options]) => ({
        args,
        command,
        shell: options.shell,
      })),
    ).toEqual([
      {
        args: ['/opt/npm/npm-cli.js', 'run', 'test:e2e:setup'],
        command: '/opt/node',
        shell: false,
      },
      {
        args: [
          '/opt/npm/npm-cli.js',
          'run',
          'test:e2e',
          '--',
          '--runTestsByPath',
          'test/e2e/audit-log.e2e-spec.ts',
        ],
        command: '/opt/node',
        shell: false,
      },
      {
        args: ['/opt/npm/npm-cli.js', 'run', 'test:e2e:teardown'],
        command: '/opt/node',
        shell: false,
      },
    ]);
    expect(processRef.listenerCount('SIGHUP')).toBe(0);
    expect(processRef.listenerCount('SIGINT')).toBe(0);
    expect(processRef.listenerCount('SIGTERM')).toBe(0);
  });
});
