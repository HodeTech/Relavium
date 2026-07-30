import {
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from './alt-screen.js';

/**
 * **Suspend the full-screen renderer** and hand the raw terminal to something else — the substrate for the ADR-0068 §e
 * copy-and-search escape hatches (`/scrollback` dumps the transcript into native scrollback; `/edit` opens it in
 * `$EDITOR`). 2.6.F Step 5d.
 *
 * It wraps ink 7's `useApp().suspendTerminal(cb)`, whose contract (read from `ink@7.1.0/build/ink.js`
 * `beginSuspend`/`endSuspend`, since none of this is documented) decides everything below:
 *
 * 1. `beginSuspend()` flushes + **erases ink's current frame** (`log.clear()` + `log.done()`), then `pauseInput()` —
 *    which turns OFF raw mode and bracketed paste (DECSET 2004) and detaches ink's stdin listeners. So we must NOT
 *    touch raw mode or bracketed paste ourselves: ink owns both, symmetrically.
 * 2. It toggles the alternate screen (DECSET 1049) **only `if (this.alternateScreen)`** — ink's *render option*, not
 *    whether the terminal happens to be in the alt buffer. That option is `true` for the bare Home but HARD `false`
 *    for `relavium chat`, whose hoisted `AltScreenController` owns 1049 (Step 4b-3). Hence {@link
 *    SuspendFullScreenOptions.inkOwnsAltScreen}: on the chat surface we exit/re-enter 1049 ourselves, or `$EDITOR`
 *    would paint into the alt buffer and vanish on resume. Both halves ALSO early-return under
 *    `!interactive || isUnmounted || isUnmounting`, so ink's half of the work is skipped once the instance is torn
 *    down — harmless, because `unmount()` itself writes `exitAlternativeScreen + showCursor` and clears the option,
 *    and because `beginSuspend()` runs synchronously at the head of `suspendTerminal` (a mounted instance cannot
 *    become unmounted between the check and our writes).
 * 3. ink writes **no mouse escapes at all** (verified: its whole build contains no `?1000`/`?1006`). Mouse reporting
 *    is entirely ours, so we suspend and restore it on both surfaces — leaving DECSET 1002 on while a child owns the
 *    TTY floods that child with `\x1b[<…M` reports.
 * 4. `endSuspend()` calls `resumeInput()` **before** re-entering the alt buffer, then forces a full redraw. So every
 *    write we make must land inside the callback, while input is still paused — never after it returns.
 *
 * ORDERING, therefore: exit the alt buffer INSIDE the callback (after ink erased its frame). Doing it earlier would
 * make ink's `log.clear()` erase the *primary* buffer — scrolling the user's shell history away.
 *
 * EXIT SAFETY, in the spirit of `withHoistedAltScreen`. Three rules, and NOT a `finally` — see below:
 *   - **Restore only what was changed.** A release write that throws part-way must not be "undone" (re-entering an
 *     alt buffer we never exited would corrupt a terminal ink left intact).
 *   - **The restores are isolated.** Each reclaim write has its own `try`, so a failing alt-buffer re-enter can
 *     never skip the mouse restore after it — a stranded DECSET-1000 is the worst state we can leave.
 *   - **The first error wins.** A `finally` cannot express this: a throw from a `finally` REPLACES the throw already
 *     unwinding out of its `try`, so a failing restore write would mask the real cause and tell the user "stdout
 *     closed" instead of "could not start $EDITOR" (`error-handling.md`). The body's error is captured into
 *     `pending` and rethrown after the reclaim; a secondary write failure is dropped.
 */

/** ink 7's `useApp().suspendTerminal` in its callback form. Rejects if the terminal is ALREADY suspended
 *  (`beginSuspend` throws), so a surface must gate re-entrancy before calling {@link suspendFullScreen}. */
export type SuspendTerminal = (callback: () => Promise<void>) => Promise<void>;

export interface SuspendFullScreenOptions {
  /** ink's `useApp().suspendTerminal` — the only way to make ink release raw mode, bracketed paste, and its frame. */
  readonly suspendTerminal: SuspendTerminal;
  /** Write a raw control sequence to the TTY (production: `process.stdout.write`; tests: a capture). */
  readonly writeControl: (sequence: string) => void;
  /**
   * `true` when ink's `alternateScreen` RENDER OPTION is on — the bare Home, where ink's own `beginSuspend`/
   * `endSuspend` exit and re-enter DECSET-1049 for us. `false` for `relavium chat` (the option is hard-`false`; the
   * hoisted controller owns 1049), where WE must toggle it. Getting this backwards either strands `$EDITOR` inside
   * the invisible alt buffer, or double-toggles 1049 and loses the frame.
   */
  readonly inkOwnsAltScreen: boolean;
  /** `true` when the alt buffer is currently entered. `false` on the inline renderer — there is no buffer to leave,
   *  and `suspendFullScreen` degrades to "ink hands over raw mode" (which `/edit` still needs). */
  readonly altActive: boolean;
  /** `true` when mouse reporting (DECSET 1002+1006) is currently on. Independent of {@link altActive} on purpose:
   *  once `--no-mouse` lands, the alt screen can be active with the mouse off. */
  readonly mouseActive: boolean;
}

/**
 * Run `body` with the terminal handed back to the user (or to a TTY-inheriting child), then restore the full-screen
 * renderer exactly as it was. Rejects with whatever `body` (or ink) threw, AFTER restoring.
 */
export async function suspendFullScreen(
  opts: SuspendFullScreenOptions,
  body: () => Promise<void>,
): Promise<void> {
  const { suspendTerminal, writeControl, inkOwnsAltScreen, altActive, mouseActive } = opts;
  const weOwnAltScreen = altActive && !inkOwnsAltScreen;

  await suspendTerminal(async () => {
    // Track what we ACTUALLY changed, so a write that throws part-way cannot leave a half-restored terminal (a
    // blind symmetric restore would, say, re-enter an alt buffer we never exited).
    let mouseSuspended = false;
    let altExited = false;
    // The FIRST error seen — the root cause. A later restore-write failure must never replace it: the user needs to
    // read "could not start $EDITOR", not "stdout closed" (error-handling.md — never swallow a root cause to
    // re-throw a vaguer one). A `finally` cannot express this: a throw from a `finally` REPLACES the pending throw.
    let pending: { readonly error: unknown } | undefined;

    // RELEASE — hand the terminal over.
    try {
      if (mouseActive) {
        writeControl(DISABLE_MOUSE); // restore native selection + stop flooding the child with mouse reports
        mouseSuspended = true;
      }
      if (weOwnAltScreen) {
        writeControl(EXIT_ALT_SCREEN + SHOW_CURSOR); // ink did not: its render option is false on this surface
        altExited = true;
      }
      await body();
    } catch (error) {
      pending = { error };
    }

    // RECLAIM — mirror the release, innermost-first. Each write is isolated, so one failing sequence can never skip
    // the next: a stranded DECSET-1000 (mouse reporting left on) is the worst terminal state we can leave, and it is
    // restored even when re-entering the alt buffer throws.
    const reclaim = (sequence: string): void => {
      try {
        writeControl(sequence);
      } catch (error) {
        pending ??= { error }; // only the root cause survives; a secondary write failure on a dead stdout is noise
      }
    };
    if (altExited) reclaim(ENTER_ALT_SCREEN + HIDE_CURSOR);
    if (mouseSuspended) reclaim(ENABLE_MOUSE);

    if (pending !== undefined) throw pending.error;
  });
}

/**
 * The **suspend port** — the repo's first React→core capability bridge, and the reason the hatches need no
 * surface-specific interception at all.
 *
 * `suspendTerminal` exists ONLY inside a mounted ink tree (`useApp()`), but the slash-command dispatch that must call
 * it lives outside React: `relavium chat`'s `ReplCommandContext` is built before `driveInk` mounts, and the Home's
 * `createHomeController` is built before `RootApp` mounts. Every existing port (`runShellCommand`, `modelPicker`,
 * `mentionReader`) flows the other way — built outside React, consumed inside. This one inverts that: the non-React
 * layer creates an empty port, hands it to both the command context and the component; the component `attach`es its
 * `suspendTerminal` on mount and detaches on unmount.
 *
 * `current()` is therefore the honest answer to "is there a live full-screen renderer right now?" — `undefined` on a
 * plain / `--json` driver (no ink at all), and between a session's unmount and the next mount. A hatch that reads
 * `undefined` surfaces an actionable notice instead of failing.
 */
export interface SuspendPort {
  /** Called by the ink tree: the live `suspendTerminal` on mount, `undefined` on unmount. */
  readonly attach: (suspend: SuspendTerminal | undefined) => void;
  /** The live `suspendTerminal`, or `undefined` when no ink tree is mounted. Read at CALL time, never captured. */
  readonly current: () => SuspendTerminal | undefined;
  /**
   * `true` for exactly as long as a suspension obtained from {@link current} is in flight.
   *
   * LOAD-BEARING, not diagnostic. During a suspension ink has turned raw mode OFF, so a keyboard **Ctrl-C is no
   * longer swallowed by `useInput`** — the tty line discipline delivers it as a REAL process SIGINT. The chat's
   * `process.on('SIGINT')` handler would then run its cooperative `/cancel`, unmount ink, and exit the hoisted alt
   * buffer *behind the suspension's back* — while the suspension is still awaiting `$EDITOR` or the "press Enter"
   * prompt. Its reclaim would later re-enter the alt buffer and re-enable the mouse on the user's SHELL. A signal
   * handler must therefore ask this before acting (Step-5d-3 Sonnet review).
   */
  readonly isSuspended: () => boolean;
}

/**
 * The flag is maintained by the PORT, wrapped around the ink call it hands out — not by the caller. A caller cannot
 * forget to set it, and it is impossible for `isSuspended()` to disagree with what the terminal is actually doing.
 */
export function createSuspendPort(): SuspendPort {
  let suspend: SuspendTerminal | undefined;
  let suspended = false;
  return {
    attach: (next) => {
      suspend = next;
    },
    current: () => {
      const live = suspend;
      if (live === undefined) return undefined;
      return async (callback) => {
        suspended = true;
        try {
          await live(callback);
        } finally {
          suspended = false;
        }
      };
    },
    isSuspended: () => suspended,
  };
}

/**
 * The named, POSIX-only job-control signal seam. `SIGTSTP`/`SIGCONT` are deliberately NOT folded into the normal
 * termination callbacks: stopping a foreground job is reversible, whereas SIGINT/TERM/HUP/QUIT tear the command
 * down, close its database, and exit. Keeping the names here also avoids treating platform-specific signal numbers
 * as a public contract.
 */
export interface JobControlLifecycle {
  /** `false` on platforms without POSIX job control (notably Windows): no listeners are installed and Ctrl-Z is inert. */
  readonly supported: boolean;
  /** Register the catchable stop request; returns its exact remover. */
  readonly onSuspend: (listener: () => void) => () => void;
  /** Register the continuation notification; it remains installed while the process is stopped. */
  readonly onContinue: (listener: () => void) => () => void;
  /** Re-deliver SIGTSTP to this process after our listener has released terminal state and removed itself. */
  readonly suspendSelf: () => void;
}

const noop = (): void => undefined;

/** Production process binding for {@link JobControlLifecycle}. No unsupported Windows signal is ever registered. */
export const defaultJobControlLifecycle: JobControlLifecycle = {
  supported: process.platform !== 'win32',
  onSuspend: (listener) => {
    if (process.platform === 'win32') return noop;
    process.on('SIGTSTP', listener);
    return () => process.removeListener('SIGTSTP', listener);
  },
  onContinue: (listener) => {
    if (process.platform === 'win32') return noop;
    process.on('SIGCONT', listener);
    return () => process.removeListener('SIGCONT', listener);
  },
  suspendSelf: () => {
    if (process.platform !== 'win32') process.kill(process.pid, 'SIGTSTP');
  },
};

/**
 * Perform an Ink-aware terminal release and wait for a matching SIGCONT. `run` must use {@link suspendFullScreen}
 * (rather than calling Ink directly), preserving each surface's proven alt-screen and mouse ownership rules.
 */
export type JobControlRun = (
  suspendTerminal: SuspendTerminal,
  waitForContinue: () => Promise<void>,
) => Promise<void>;

/** The reversible job-control binding returned by {@link wireJobControl}. */
export interface JobControlBinding {
  /** Request a stop from either a process SIGTSTP or the raw-mode Ctrl-Z input byte. */
  readonly requestSuspend: () => void;
  /** Remove the process listeners; safe to call more than once. */
  readonly dispose: () => void;
}

/**
 * Bind POSIX job control to one mounted Ink surface.
 *
 * The critical ordering is enforced in one place:
 *
 * 1. `run` enters Ink's suspension window and releases mouse/alt state.
 * 2. only inside that released window do we remove our SIGTSTP listener and re-deliver SIGTSTP to the process;
 * 3. SIGCONT re-arms SIGTSTP before resolving the wait, after which Ink restores raw input and redraws. A second
 *    stop received while that reclaim is in flight is remembered and replayed only after Ink has finished its redraw;
 *    it is never silently swallowed.
 *
 * A hatch may already own `SuspendPort` (`/scrollback`/`/edit`), and a chat rebuild has a brief interval with no Ink
 * tree at all. Those paths deliberately do not nest Ink suspension: they release/reclaim only the optional hoisted
 * terminal state around the real stop, then let the existing owner resume normally.
 */
export function wireJobControl(opts: {
  readonly suspendPort: SuspendPort;
  readonly lifecycle: JobControlLifecycle;
  readonly run: JobControlRun;
  /** Optional reversible release for an interval with no Ink tree (the chat hoist's rebuild window). */
  readonly releaseWithoutInk?: () => boolean;
  /** Mirrors {@link releaseWithoutInk} after the stopped process is foregrounded again. */
  readonly reclaimWithoutInk?: () => void;
}): JobControlBinding {
  if (!opts.lifecycle.supported) return { requestSuspend: noop, dispose: noop };

  let disposed = false;
  let suspending = false;
  let pendingSuspend = false;
  let resolveContinue: (() => void) | undefined;
  let removeSuspend: (() => void) | undefined;
  let removeContinue: (() => void) | undefined;

  const removeSuspendListener = (): void => {
    removeSuspend?.();
    removeSuspend = undefined;
  };

  const installSuspendListener = (): void => {
    if (disposed || removeSuspend !== undefined) return;
    removeSuspend = opts.lifecycle.onSuspend(requestSuspend);
  };

  const continueSuspension = (): void => {
    const resolve = resolveContinue;
    if (resolve === undefined) return; // a stray SIGCONT must not perturb an active surface
    // Re-arm BEFORE Ink resumes input/redraws. A fast second Ctrl-Z is then captured by our handler rather than
    // falling through to a default stop while the terminal is still being reclaimed.
    installSuspendListener();
    resolveContinue = undefined;
    resolve();
  };

  /** Remove our handler just long enough for the OS default SIGTSTP action to stop the process. */
  const forwardSuspend = (): void => {
    removeSuspendListener();
    try {
      opts.lifecycle.suspendSelf();
    } catch {
      // A failed self-signal means there was no stop/continuation. Resolve a pending release so Ink can reclaim;
      // the finally below restores our SIGTSTP listener too.
      continueSuspension();
    } finally {
      // `suspendSelf()` returns only after SIGCONT. This is the re-arm for the no-Ink and hatch-owned paths; the
      // Ink-owned path already re-arms in `continueSuspension` before it resolves the deferred, so this is a no-op.
      installSuspendListener();
    }
  };

  const settle = (): void => {
    resolveContinue = undefined;
    suspending = false;
    installSuspendListener();
    // `SIGCONT` deliberately re-arms before Ink starts reclaiming terminal state: an external SIGTSTP can otherwise
    // default-stop the process in the tiny interval after 1049/raw input has been restored but before the mouse/
    // redraw have completed. The coordinator is still busy, so retain ONE request and replay it after the terminal is
    // coherent again. `queueMicrotask` also keeps the signal callback itself synchronous and side-effect bounded.
    queueMicrotask(() => {
      if (disposed || suspending || !pendingSuspend) return;
      pendingSuspend = false;
      requestSuspend();
    });
  };

  function requestSuspend(): void {
    if (disposed) return;
    if (suspending) {
      // Coalesce a burst into one real follow-up stop. Dropping it would make a fast Ctrl-Z / SIGTSTP after `fg`
      // appear to succeed (the listener consumed it) while leaving the process running.
      pendingSuspend = true;
      return;
    }

    // A hatch has already released Ink's input and its terminal modes. Nesting `suspendTerminal` would throw
    // "already suspended" and could reclaim the hatch's terminal behind its back, so just perform genuine POSIX job
    // control and let the still-pending hatch resume after foregrounding.
    if (opts.suspendPort.isSuspended()) {
      forwardSuspend();
      return;
    }

    const suspendTerminal = opts.suspendPort.current();
    if (suspendTerminal === undefined) {
      // Before Home mounts (onboarding) there is no Ink state to release. In the chat's rebuild window there can be
      // a live hoisted alt buffer, supplied by the reversible hooks below.
      if (opts.releaseWithoutInk !== undefined && !opts.releaseWithoutInk()) return;
      forwardSuspend();
      opts.reclaimWithoutInk?.();
      return;
    }

    suspending = true;
    const waitForContinue = (): Promise<void> =>
      new Promise((resolve) => {
        resolveContinue = resolve;
        forwardSuspend();
      });
    // Signals cannot await a promise. Absorb a terminal-write/Ink failure here: `suspendFullScreen` has already
    // performed its own partial-state reclaim, and an unhandled rejection from a signal handler is strictly worse.
    // We intentionally do not re-raise after a failed release because terminal release never reached the safe point.
    void opts.run(suspendTerminal, waitForContinue).catch(noop).finally(settle);
  }

  removeContinue = opts.lifecycle.onContinue(continueSuspension);
  installSuspendListener();

  return {
    requestSuspend,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      pendingSuspend = false;
      removeSuspendListener();
      removeContinue?.();
      removeContinue = undefined;
    },
  };
}
