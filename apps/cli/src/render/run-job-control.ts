import { HIDE_CURSOR, SHOW_CURSOR } from './alt-screen.js';
import { defaultJobControlLifecycle, type JobControlLifecycle } from './suspend.js';
import { CliError } from '../process/errors.js';

/**
 * Minimal `SIGTSTP`/`SIGCONT` handling for the **run/gate** path (G0's residue).
 *
 * Deliberately NOT `wireJobControl`. That primitive serves the full-screen chat/Home surfaces: it releases and
 * reclaims the alternate screen and mouse reporting, coalesces concurrent requests, and owns a suspend hatch.
 * `driveRun` mounts none of that — `RunApp` uses no `useInput`, so the terminal stays in cooked mode and Ctrl-Z
 * is a real `SIGTSTP` rather than a keystroke the app reads. Reusing the heavy primitive here would add a
 * release/reclaim of state that was never entered.
 *
 * What `driveRun` DOES leave behind is narrower and was genuinely broken: ink hides the cursor while it renders,
 * and `signal-exit`'s signal list contains no `SIGTSTP`, so nothing restored it. A Ctrl-Z during
 * `relavium run` therefore returned the user to a shell with a **permanently invisible cursor** — for the rest
 * of that terminal's life, not just the run's.
 *
 * So: show the cursor before we stop, hide it again when we are foregrounded and ink resumes drawing. Nothing
 * else, because nothing else was entered.
 */
export interface RunJobControl {
  /** Detach the listeners. Idempotent; safe to call from a `finally` that also runs on the throw path. */
  readonly dispose: () => void;
  /** Actual completed registration/removal, independently of an early dispose request. */
  readonly released?: Promise<void>;
}

export interface WireRunJobControlOptions {
  readonly adopt?: (control: RunJobControl) => void;
  /** Observe the original self-stop failure before reversible listener recovery consumes it. */
  readonly onFailure?: (cause: unknown) => void;
  /** Where the cursor codes go — the same seam the renderers write through, so tests capture them. */
  readonly write: (text: string) => void;
  /** Injectable signal registration (`defaultJobControlLifecycle` in production; a fake in tests). */
  readonly lifecycle?: JobControlLifecycle;
}

export function wireRunJobControl(opts: WireRunJobControlOptions): RunJobControl {
  const lifecycle = opts.lifecycle ?? defaultJobControlLifecycle;
  let disposed = false;
  let constructing = true;
  let unknownRegistration = false;
  let registrations = 0;
  let attached = false;
  let continueRegistered = false;
  let removeSuspend: () => void = () => undefined;
  let removeContinue: () => void = () => undefined;
  let acknowledge: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const acknowledgeReleased = (): void => {
    if (
      disposed &&
      !constructing &&
      registrations === 0 &&
      !unknownRegistration &&
      !attached &&
      !continueRegistered
    )
      acknowledge();
  };
  const detached = (): void => {
    if (!attached) return;
    attached = false;
    registrations += 1; // Removal reentry cannot recurse into or acknowledge the same entered remover.
    try {
      removeSuspend();
    } catch (cause) {
      attached = true;
      throw cause;
    } finally {
      registrations -= 1;
    }
    acknowledgeReleased();
  };
  const dispose = (): void => {
    disposed = true; // Callback and future-registration admission closes before either native remover.
    let failed: { readonly cause: unknown } | undefined;
    try {
      detached();
    } catch (cause) {
      failed = { cause };
    }
    try {
      if (continueRegistered) {
        continueRegistered = false;
        registrations += 1;
        try {
          removeContinue();
        } catch (cause) {
          continueRegistered = true;
          throw cause;
        } finally {
          registrations -= 1;
        }
      }
    } catch (cause) {
      failed ??= { cause };
    }
    if (failed !== undefined) throw new CliError('cli_internal', '', { cause: failed.cause });
    acknowledgeReleased();
  };
  const writeCursor = (text: string): boolean => {
    try {
      opts.write(text);
      return true;
    } catch (cause) {
      // Native signal callbacks cannot throw past the creation owner. Its failure
      // path seals callbacks and retains the actual terminal restoration barrier.
      if (opts.onFailure === undefined) throw cause;
      opts.onFailure(cause);
      return false;
    }
  };
  const onSuspend = (): void => {
    if (disposed) return;
    if (!writeCursor(SHOW_CURSOR)) return;
    if (disposed) return;
    try {
      detached();
      if (disposed) return;
      try {
        lifecycle.suspendSelf();
      } catch (cause) {
        opts.onFailure?.(cause);
        attach();
      }
    } catch (cause) {
      if (opts.onFailure === undefined) throw cause;
      opts.onFailure(cause);
    }
  };
  const attach = (): void => {
    if (disposed || attached) return;
    registrations += 1; // A reentrant stop cannot retire a registration whose remover is not returned yet.
    let acquired = false;
    try {
      removeSuspend = lifecycle.onSuspend(onSuspend);
      acquired = true;
      attached = true;
      if (disposed) detached();
    } catch (cause) {
      if (!acquired) unknownRegistration = true;
      throw cause;
    } finally {
      registrations -= 1;
    }
    if (disposed) dispose();
  };
  const control = Object.freeze({ dispose, released });
  opts.adopt?.(control); // Ownership precedes the first potentially allocating native registration.
  let primaryFailure: { readonly cause: unknown } | undefined;
  let cleanupFailure: { readonly cause: unknown } | undefined;
  try {
    if (lifecycle.supported && !disposed) {
      attach();
      if (!disposed) {
        registrations += 1;
        try {
          removeContinue = lifecycle.onContinue(() => {
            if (disposed) return;
            try {
              attach();
              if (!disposed) writeCursor(HIDE_CURSOR);
            } catch (cause) {
              if (opts.onFailure === undefined) throw cause;
              opts.onFailure(cause);
            }
          });
          continueRegistered = true;
        } catch (cause) {
          unknownRegistration = true;
          throw cause;
        } finally {
          registrations -= 1;
        }
      }
    }
  } catch (cause) {
    primaryFailure = { cause };
    disposed = true;
  } finally {
    constructing = false;
    if (disposed || !lifecycle.supported) {
      try {
        dispose();
      } catch (cause) {
        cleanupFailure = { cause };
      }
    }
  }
  if (primaryFailure !== undefined && cleanupFailure === undefined) throw primaryFailure.cause;
  if (primaryFailure !== undefined || cleanupFailure !== undefined)
    throw new CliError('cli_internal', '', { cause: { primaryFailure, cleanupFailure } });
  return control;
}
