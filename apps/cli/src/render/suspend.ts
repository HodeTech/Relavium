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
 *    is entirely ours, so we suspend and restore it on both surfaces — leaving DECSET 1000 on while a child owns the
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
  /** `true` when mouse reporting (DECSET 1000+1006) is currently on. Independent of {@link altActive} on purpose:
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
