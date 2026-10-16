import { CliError } from './cli-error.js';
import { assertTerminatingSignalNumber } from './exit-observations.js';
import {
  FATAL_TERMINATION_MS,
  type InvocationClock,
  type InvocationRegistry,
} from './invocation-registry.js';

export interface FiniteExitPorts {
  readonly setExitCode: (code: number) => void;
  readonly exit: (code: number) => void;
}

/** One explicitly activated exit authority, shared by workflow signals and the later native adapter. */
export interface InvocationFiniteExit {
  readonly fail: (code: 'cli_internal' | 'output_unavailable') => void;
  readonly signal: (signalNumber: number) => void;
  readonly handoff: (registry: InvocationRegistry, changed: () => void) => () => void;
  readonly exitNow: () => void;
  readonly hasExited: () => boolean;
  readonly exited: Promise<number>;
}

/** Construction is inert: no registry observer, timer, process listener or service access. */
export function createInvocationFiniteExit(
  registry: InvocationRegistry,
  clock: InvocationClock,
  ports: FiniteExitPorts,
): InvocationFiniteExit {
  let mode: 'idle' | 'fallback' | 'native' | 'disposed' = 'idle';
  let generation = 0;
  let exited = false;
  let observing = false;
  let following = false;
  let removeObserver: (() => void) | undefined;
  let notifyNative: (() => void) | undefined;
  let disarm: (() => void) | undefined;
  let scheduledDeadline: number | undefined;
  let resolveExit: (code: number) => void = () => undefined;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const clearTimer = (): void => {
    const cancel = disarm;
    disarm = undefined;
    try {
      cancel?.();
    } catch {
      registry.observations.observeFailure('cli_internal');
    }
  };
  const exitNow = (): void => {
    if (exited || mode === 'disposed') return;
    exited = true;
    clearTimer();
    registry.sampleWorkflowHealth();
    const code = registry.observations.exitCode();
    resolveExit(code);
    try {
      ports.setExitCode(code);
    } finally {
      ports.exit(code);
    }
  };
  const backstop = (): void => {
    if (exited || mode === 'disposed') return;
    const remaining = registry.budget.remainingMs();
    // Includes a failed clock/scheduler with no usable absolute deadline. Stop-all runs first.
    if (remaining === 0) {
      queueMicrotask(exitNow);
      return;
    }
    const deadline = registry.budget.deadline();
    if (deadline === undefined || remaining === undefined || scheduledDeadline === deadline) return;
    scheduledDeadline = deadline;
    clearTimer();
    try {
      disarm = clock.schedule(remaining, () => queueMicrotask(exitNow));
    } catch {
      registry.observations.observeFailure('cli_internal');
      queueMicrotask(exitNow);
    }
  };
  const changed = (): void => {
    backstop();
    if (exited || mode === 'disposed') return;
    if (mode === 'native') {
      notifyNative?.();
      return;
    }
    const termination = registry.termination;
    if (mode !== 'fallback' || following || termination === undefined) return;
    following = true;
    const observedGeneration = generation;
    void termination.then(() => {
      // A queued settled-cleanup continuation cannot bypass the native diagnostic ACK after handoff.
      if (
        mode === 'fallback' &&
        generation === observedGeneration &&
        !registry.observations.hasInfrastructureFailure()
      )
        exitNow();
    });
  };
  const observe = (): void => {
    if (observing) return;
    observing = true;
    removeObserver = registry.observeTermination(changed);
  };
  return Object.freeze({
    fail: (code: 'cli_internal' | 'output_unavailable') => {
      if (code !== 'cli_internal' && code !== 'output_unavailable')
        throw new CliError('cli_internal', '');
      if (exited || mode === 'disposed') return;
      if (mode === 'idle') {
        mode = 'fallback';
        generation += 1;
        observe();
      }
      // Fast cleanup leaves outer diagnostic rendering time; only the unchanged absolute backstop
      // exits this staged fallback. The later native handoff owns positive diagnostic ACK/early exit.
      void registry.terminate({ kind: 'infrastructure', code });
    },
    signal: (signalNumber: number) => {
      assertTerminatingSignalNumber(signalNumber);
      if (exited || mode === 'disposed') return;
      if (mode === 'idle') {
        mode = 'fallback';
        generation += 1;
        observe();
      }
      let deadline: number;
      try {
        deadline = clock.now() + FATAL_TERMINATION_MS;
        if (!Number.isFinite(deadline)) throw new CliError('cli_internal', '');
      } catch {
        // Do not let a clock fault escape an OS signal callback or certify any owner settled.
        void registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
        return;
      }
      void registry.terminate({ kind: 'signal', signalNumber, deadline });
    },
    handoff: (candidate: InvocationRegistry, callback: () => void) => {
      if (candidate !== registry || mode === 'native' || mode === 'disposed' || exited)
        throw new CliError('cli_internal', '');
      mode = 'native';
      generation += 1;
      notifyNative = callback;
      observe();
      // observeTermination replays only on first acquisition; a fallback already owns the observer.
      if (registry.termination !== undefined) changed();
      return () => {
        if (mode === 'disposed') return;
        mode = 'disposed';
        generation += 1;
        notifyNative = undefined;
        clearTimer();
        removeObserver?.();
        removeObserver = undefined;
      };
    },
    exitNow,
    hasExited: () => exited,
    exited: exitPromise,
  });
}
