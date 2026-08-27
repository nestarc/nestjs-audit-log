'use strict';

const { spawn } = require('node:child_process');
const { constants: osConstants } = require('node:os');

const SIGNAL_EXIT_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149,
});

function exitCodeForSignal(signal) {
  const signalNumber = osConstants.signals[signal];
  return SIGNAL_EXIT_CODES[signal] ??
    (typeof signalNumber === 'number' ? 128 + signalNumber : 1);
}

function exitCodeForResult(code, signal) {
  if (typeof code === 'number') {
    return code;
  }

  return signal ? exitCodeForSignal(signal) : 1;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createProcessController({
  spawnImpl = spawn,
  killImpl = process.kill,
  platform = process.platform,
  stderr = process.stderr,
  forceKillAfterMs = 5_000,
} = {}) {
  let activeChild;
  let activeChildInterruptSignal;
  let activeChildIsCleanup = false;
  let forceKillTimer;
  let interruptSignal;

  function clearForceKillTimer() {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  }

  function signalChild(child, signal) {
    try {
      if (platform !== 'win32' && typeof child.pid === 'number') {
        killImpl(-child.pid, signal);
        return;
      }

      child.kill(signal);
    } catch (error) {
      if (error && error.code === 'ESRCH') {
        return;
      }

      try {
        child.kill(signal);
      } catch (fallbackError) {
        if (!fallbackError || fallbackError.code !== 'ESRCH') {
          stderr.write(
            `[e2e] Failed to send ${signal} to the active command: ${errorMessage(
              fallbackError,
            )}\n`,
          );
        }
      }
    }
  }

  function scheduleForceKill(child) {
    if (forceKillTimer) {
      return;
    }

    forceKillTimer = setTimeout(() => {
      if (activeChild === child) {
        signalChild(child, 'SIGKILL');
      }
    }, forceKillAfterMs);
    forceKillTimer.unref?.();
  }

  function handleSignal(signal) {
    if (interruptSignal) {
      if (activeChild && activeChildIsCleanup) {
        const interruptedCleanup = activeChild;
        signalChild(interruptedCleanup, signal);
        scheduleForceKill(interruptedCleanup);
      }
      return;
    }

    interruptSignal = signal;
    stderr.write(`[e2e] Received ${signal}; cleaning up PostgreSQL before exit.\n`);

    if (!activeChild || activeChildIsCleanup) {
      return;
    }

    const interruptedChild = activeChild;
    activeChildInterruptSignal = signal;
    signalChild(interruptedChild, signal);
    scheduleForceKill(interruptedChild);
  }

  function run(command, args, { cleanup = false } = {}) {
    if (interruptSignal && !cleanup) {
      return Promise.resolve(exitCodeForSignal(interruptSignal));
    }

    return new Promise((resolve) => {
      let child;
      let settled = false;

      function settle(code) {
        if (settled) {
          return;
        }

        settled = true;
        if (activeChild === child) {
          activeChild = undefined;
          activeChildInterruptSignal = undefined;
          activeChildIsCleanup = false;
          clearForceKillTimer();
        }
        resolve(code);
      }

      try {
        child = spawnImpl(command, args, {
          detached: platform !== 'win32',
          shell: false,
          stdio: 'inherit',
        });
      } catch (error) {
        stderr.write(`[e2e] Failed to start ${command}: ${errorMessage(error)}\n`);
        settle(1);
        return;
      }

      activeChild = child;
      activeChildInterruptSignal = undefined;
      activeChildIsCleanup = cleanup;

      child.once('error', (error) => {
        stderr.write(`[e2e] Failed to run ${command}: ${errorMessage(error)}\n`);
        settle(
          activeChild === child && activeChildInterruptSignal
            ? exitCodeForSignal(activeChildInterruptSignal)
            : 1,
        );
      });
      child.once('close', (code, signal) => {
        settle(
          typeof code !== 'number' && activeChild === child && activeChildInterruptSignal
            ? exitCodeForSignal(activeChildInterruptSignal)
            : exitCodeForResult(code, signal),
        );
      });
    });
  }

  return {
    getInterruptExitCode() {
      return interruptSignal ? exitCodeForSignal(interruptSignal) : 0;
    },
    handleSignal,
    run,
  };
}

async function runE2E({ runScript, testArgs = [], getInterruptExitCode = () => 0 }) {
  let primaryExitCode = 0;
  let cleanupExitCode = 0;

  try {
    primaryExitCode = await runScript('test:e2e:setup');
    if (primaryExitCode === 0) {
      primaryExitCode = await runScript('test:e2e', testArgs);
    }
  } finally {
    cleanupExitCode = await runScript('test:e2e:teardown', [], { cleanup: true });
  }

  if (primaryExitCode !== 0) {
    return primaryExitCode;
  }

  const interruptExitCode = getInterruptExitCode();
  if (interruptExitCode !== 0) {
    return interruptExitCode;
  }

  return cleanupExitCode;
}

function npmInvocation({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (env.npm_execpath) {
    return { command: execPath, args: [env.npm_execpath] };
  }

  if (platform === 'win32') {
    throw new Error('On Windows, run the E2E wrapper through npm run test:e2e:full.');
  }

  return { command: 'npm', args: [] };
}

async function main({ processRef = process, spawnImpl = spawn } = {}) {
  const controller = createProcessController({
    platform: processRef.platform,
    spawnImpl,
    stderr: processRef.stderr,
  });
  const npm = npmInvocation({
    env: processRef.env,
    execPath: processRef.execPath,
    platform: processRef.platform,
  });
  const handledSignals = Object.keys(SIGNAL_EXIT_CODES).filter(
    (signal) => signal !== 'SIGBREAK' || processRef.platform === 'win32',
  );
  const handlers = new Map(
    handledSignals.map((signal) => [signal, () => controller.handleSignal(signal)]),
  );

  for (const [signal, handler] of handlers) {
    processRef.on(signal, handler);
  }

  try {
    return await runE2E({
      getInterruptExitCode: controller.getInterruptExitCode,
      runScript(script, args = [], options) {
        const forwardedArgs = args.length > 0 ? ['--', ...args] : [];
        return controller.run(
          npm.command,
          [...npm.args, 'run', script, ...forwardedArgs],
          options,
        );
      },
      testArgs: processRef.argv.slice(2),
    });
  } finally {
    for (const [signal, handler] of handlers) {
      processRef.off(signal, handler);
    }
  }
}

if (require.main === module) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`[e2e] Runner failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  createProcessController,
  exitCodeForSignal,
  main,
  npmInvocation,
  runE2E,
};
