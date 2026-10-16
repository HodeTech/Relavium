import { createBackgroundObserver } from './background-observer.js';
import type { DiagnosticPolicy } from './diagnostic-policy.js';
import { formatFixedDiagnostic } from './fixed-diagnostic.js';
import type { InvocationRegistry } from './invocation-registry.js';
import { acknowledgeWrite, canWrite } from './io.js';

export interface NativeInvocationPorts {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly schedule: (milliseconds: number, fire: () => void) => () => void;
  readonly onFatal: (listener: () => void) => () => void;
  readonly onBackground: (listener: (reason: unknown) => void) => () => void;
  readonly readExitCode: () => string | number | null | undefined;
  readonly setExitCode: (code: number) => void;
  readonly exit: (code: number) => void;
}

export interface NativeInvocation {
  readonly fail: (code: 'cli_internal' | 'output_unavailable') => void;
  /** Caller owns the original absolute terminating-signal deadline, not a renewed cleanup allowance. */
  readonly signal: (signalNumber: number, deadline: number) => void;
  /** Runtime owners publish the actual surface outcome/health before calling complete. */
  readonly complete: () => Promise<number>;
  readonly finished: Promise<number>;
  /** Fixture/lifetime disposal only; never acknowledges owner retirement or terminal restoration. */
  readonly dispose: () => void;
}

function processPorts(): NativeInvocationPorts {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    schedule: (milliseconds, fire) => {
      const timer = setTimeout(fire, milliseconds);
      return () => clearTimeout(timer);
    },
    onFatal: (listener) => {
      process.on('uncaughtException', listener);
      return () => process.off('uncaughtException', listener);
    },
    onBackground: (listener) => {
      process.on('unhandledRejection', listener);
      return () => process.off('unhandledRejection', listener);
    },
    readExitCode: () => process.exitCode,
    setExitCode: (code) => {
      process.exitCode = code;
    },
    exit: (code) => process.exit(code),
  };
}

/**
 * Explicitly installed native foundation. Product bootstrap activation waits for Step 8d's actual owners.
 * No import-time listeners, service imports, cause inspection, DB close or receipt acknowledgement.
 */
export function installNativeInvocation(
  registry: InvocationRegistry,
  policy: DiagnosticPolicy,
  ports: NativeInvocationPorts = processPorts(),
): NativeInvocation {
  let finalizationPending = false;
  let changedWhilePending = false;
  let exited = false;
  let disposed = false;
  let diagnosticStarted = false;
  let stderrUsable = canWrite(ports.stderr);
  let stdoutUsable = canWrite(ports.stdout);
  let disarm: (() => void) | undefined;
  let scheduledDeadline: number | undefined;
  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const clearTimer = (): void => {
    const previous = disarm;
    disarm = undefined;
    try {
      previous?.();
    } catch {
      registry.observations.observeFailure('cli_internal');
    }
  };
  const exitNow = (): void => {
    if (exited || disposed) return;
    exited = true;
    clearTimer();
    registry.sampleWorkflowHealth();
    const code = registry.observations.exitCode();
    ports.setExitCode(code);
    finish(code);
    ports.exit(code);
  };
  const scheduleBackstop = (): void => {
    const deadline = registry.budget.deadline();
    if (exited || disposed || deadline === undefined || scheduledDeadline === deadline) return;
    scheduledDeadline = deadline;
    clearTimer();
    const remaining = registry.budget.remainingMs();
    if (remaining === undefined || remaining <= 0) {
      // Notifications run inside the registry's attempt-all stop pass. Never preempt sibling cancellation.
      queueMicrotask(exitNow);
      return;
    }
    try {
      disarm = ports.schedule(remaining, () => queueMicrotask(exitNow));
    } catch {
      registry.observations.observeFailure('cli_internal');
      queueMicrotask(exitNow);
    }
  };
  const fail = (code: 'cli_internal' | 'output_unavailable'): void => {
    if (exited || disposed) return;
    void registry.terminate({ kind: 'infrastructure', code });
  };
  const finalize = async (): Promise<void> => {
    const termination = registry.termination;
    if (termination === undefined || exited || disposed) return;
    const result = await termination;
    if (exited || disposed) return;
    registry.sampleWorkflowHealth();
    if (result.kind === 'deadline' || registry.budget.remainingMs() === 0) {
      exitNow();
      return;
    }
    if (registry.observations.hasInfrastructureFailure() && stderrUsable && !diagnosticStarted) {
      diagnosticStarted = true;
      const code = registry.observations.infrastructureCode() ?? 'cli_internal';
      try {
        await acknowledgeWrite(ports.stderr, formatFixedDiagnostic(code, policy));
      } catch {
        stderrUsable = false;
        fail('output_unavailable');
      }
    }
    if (exited || disposed) return;
    registry.sampleWorkflowHealth();
    if (
      registry.observations.hasInfrastructureFailure() ||
      registry.observations.hasTerminatingSignal()
    ) {
      exitNow();
      return;
    }
    clearTimer();
    const code = registry.observations.exitCode();
    ports.setExitCode(code);
    finish(code);
  };
  const changed = (): void => {
    scheduleBackstop();
    if (exited || disposed) return;
    if (finalizationPending) {
      changedWhilePending = true;
      return;
    }
    finalizationPending = true;
    changedWhilePending = false;
    queueMicrotask(() => {
      void finalize()
        .catch(() => {
          fail('cli_internal');
          exitNow();
        })
        .finally(() => {
          finalizationPending = false;
          // complete() can resolve before this finally reaction runs. Retain any competing late fault.
          if (
            changedWhilePending &&
            !exited &&
            !disposed &&
            (registry.observations.hasInfrastructureFailure() ||
              registry.observations.hasTerminatingSignal())
          )
            changed();
        });
    });
  };
  const removeObserver = registry.observeTermination(changed);
  const stdoutFailed = (): void => {
    stdoutUsable = false;
    fail('output_unavailable');
  };
  const stderrFailed = (): void => {
    stderrUsable = false;
    fail('output_unavailable');
  };
  ports.stdout.on('error', stdoutFailed);
  ports.stdout.on('close', stdoutFailed);
  ports.stderr.on('error', stderrFailed);
  ports.stderr.on('close', stderrFailed);
  const background = createBackgroundObserver({
    observations: registry.observations,
    policy,
    readExitCode: ports.readExitCode,
    setExitCode: ports.setExitCode,
    write: (text) => {
      if (!stderrUsable) return Promise.reject(new Error('Diagnostic output is unavailable.'));
      return acknowledgeWrite(ports.stderr, text);
    },
    outputFailed: stderrFailed,
  });
  const removeFatal = ports.onFatal(() => fail('cli_internal'));
  const removeBackground = ports.onBackground(background.observe);
  if (!stdoutUsable) stdoutFailed();
  if (!stderrUsable) stderrFailed();
  return Object.freeze({
    fail,
    signal: (signalNumber: number, deadline: number) => {
      void registry.terminate({ kind: 'signal', signalNumber, deadline });
    },
    complete: () => {
      void registry.terminate({ kind: 'normal' });
      return finished;
    },
    finished,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimer();
      removeObserver();
      removeFatal();
      removeBackground();
      ports.stdout.off('error', stdoutFailed);
      ports.stdout.off('close', stdoutFailed);
      ports.stderr.off('error', stderrFailed);
      ports.stderr.off('close', stderrFailed);
    },
  });
}
