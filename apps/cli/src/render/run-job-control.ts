import { HIDE_CURSOR, SHOW_CURSOR } from './alt-screen.js';
import { defaultJobControlLifecycle, type JobControlLifecycle } from './suspend.js';

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
}

export interface WireRunJobControlOptions {
  /** Where the cursor codes go — the same seam the renderers write through, so tests capture them. */
  readonly write: (text: string) => void;
  /** Injectable signal registration (`defaultJobControlLifecycle` in production; a fake in tests). */
  readonly lifecycle?: JobControlLifecycle;
}

export function wireRunJobControl(opts: WireRunJobControlOptions): RunJobControl {
  const lifecycle = opts.lifecycle ?? defaultJobControlLifecycle;
  // Windows has no job control: `chmod`-style no-op rather than a half-wired handler (ADR-0050's precedent for
  // a documented per-platform divergence).
  if (!lifecycle.supported) {
    return { dispose: () => undefined };
  }

  let disposed = false;
  const removeSuspend = lifecycle.onSuspend(() => {
    // Restore the cursor BEFORE the process stops. Once stopped we run no code, so there is no later chance —
    // and the shell the user lands in inherits whatever state we left.
    opts.write(SHOW_CURSOR);
    // Re-raise so the process actually stops. Without this the handler swallows Ctrl-Z and the run keeps
    // going, which is worse than the bug being fixed: the user pressed a key that did nothing.
    lifecycle.suspendSelf();
  });
  const removeContinue = lifecycle.onContinue(() => {
    // Foregrounded: ink is drawing again, so hide the cursor as it expects. If the run already finished while
    // we were stopped, the extra hide is harmless — the renderer's own teardown shows it again.
    opts.write(HIDE_CURSOR);
  });

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // BOTH, not just one — the leak `suspend.ts`'s own `dispose` had (see its comment) is exactly this shape.
      removeSuspend();
      removeContinue();
    },
  };
}
