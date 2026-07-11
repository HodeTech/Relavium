/**
 * The DECSET-1049 alternate-screen toggle, HOISTED above the per-session ink mount (2.6.F Step 4b-3,
 * [ADR-0068](../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md) §c).
 *
 * `relavium chat`'s REPL loop mounts + unmounts ink PER SESSION, and ink 7 ties the alternate-screen enter/exit
 * (DECSET 1049) to mount/unmount — so a `/clear` or `/models` re-drive flips the terminal primary→alt→primary, a
 * visible FLICKER (and the intro / clearedNotice lands on the primary buffer). ink 7 renders full-screen through
 * `log-update` (relative cursor moves), which is INDEPENDENT of the `alternateScreen` render option — so the fix is
 * to enter the alt buffer ONCE above the loop, mount every session with the ink option `alternateScreen:false` (ink
 * then toggles nothing), and exit ONCE at the end. This controller owns that toggle.
 *
 * The load-bearing guarantee is EXIT SAFETY: with the ink option false, ink's own restoration net goes inert, so this
 * `restore()` must run on EVERY termination path — the `finally`, a `process.exit` force-quit (via a `process.on('exit')`
 * net), and a SIGTERM/SIGHUP handler. It is therefore IDEMPOTENT (a `restored` latch), so calling it from several nets
 * is safe. Byte sequences are copied verbatim from ink (`ink/build/base.js` enter/exit + `cursor-helpers.js`) so the
 * hoisted toggle is indistinguishable from ink's.
 */

/** Enter the alternate screen buffer (DECSET 1049). Matches ink's `enterAlternativeScreen`. */
export const ENTER_ALT_SCREEN = '\x1b[?1049h';
/** Leave the alternate screen buffer, restoring the primary buffer + its scrollback (DECRST 1049). */
export const EXIT_ALT_SCREEN = '\x1b[?1049l';
/** Hide the cursor (paired with enter, as ink pairs them). */
export const HIDE_CURSOR = '\x1b[?25l';
/** Show the cursor (paired with exit — never leave the cursor invisibly hidden after the chat ends). */
export const SHOW_CURSOR = '\x1b[?25h';
/** Cursor-home + erase-to-end-of-screen — clears the persistent alt buffer BETWEEN a re-drive's unmount and the next
 *  mount, so successive sessions never STACK (ink's non-fullscreen unmount `log.done()` does not erase, and a fresh
 *  mount starts at `previousLineCount=0`). */
export const CLEAR_ALT_SCREEN = '\x1b[H\x1b[J';
/**
 * Enable terminal mouse reporting — **DECSET 1002** (button-event tracking: press, release, wheel, and motion ONLY
 * while a button is held) + SGR extended coordinates (1006, so columns past 223 report correctly).
 *
 * 1002, not 1000: the drag reports are what let the app implement TEXT SELECTION itself (2.6.F Step 6). A terminal
 * either reports mouse events or performs its own click-drag selection — never both — so with reporting on, giving
 * selection back to the user means owning it. NOT 1003 (any-motion), which reports every pointer move even with no
 * button held and floods the input stream for nothing.
 */
export const ENABLE_MOUSE = '\x1b[?1002h\x1b[?1006h';
/**
 * Disable mouse reporting — restore the emulator's native text-selection. Paired with the alt-buffer exit on every
 * path. It disables **1000 as well as 1002**: a disable of a mode that was never enabled is a no-op, and an earlier
 * Relavium (or any other program in this terminal) may have left 1000 armed.
 */
export const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

export interface AltScreenController {
  /** Enter the alt buffer + hide the cursor, exactly ONCE (a repeat call and the inactive case are no-ops). */
  enter(): void;
  /** Whether mouse reporting is currently ON — `enter()` ran AND the `mouse` option was set (2.6.F Step 5e,
   *  ADR-0068 §e). The `/scrollback` + `/edit` suspension asks this so it suspends the mouse only if we enabled it. */
  readonly isMouseEnabled: () => boolean;
  /** Exit the alt buffer + show the cursor, exactly ONCE — IDEMPOTENT, so the `finally`, the `process.on('exit')`
   *  net, and a signal handler can all call it without a double toggle. A no-op if `enter()` never ran. */
  restore(): void;
  /** Clear the persistent alt buffer between sessions (see {@link CLEAR_ALT_SCREEN}). No-op once restored / inactive. */
  clearBetween(): void;
  /** Whether the alt buffer is currently entered (and not yet restored) — for a caller that must know the live state. */
  readonly isEntered: () => boolean;
}

/**
 * Build an {@link AltScreenController} over a `write` sink (production: `process.stdout.write`; tests: a capture).
 * `active` is the resolved alt-mode decision — when `false` (inline / non-TTY / `--json` / CI), every method is a
 * no-op and NOTHING is written, so the machine / opt-out paths stay byte-identical (ADR-0068 §e).
 */
export function createAltScreenController(opts: {
  readonly write: (sequence: string) => void;
  readonly active: boolean;
  /** Enable mouse reporting with the buffer (2.6.F Step 5e, ADR-0068 §e). `false` (`--no-mouse` /
   *  `[preferences].mouse = false`) keeps the wheel inert and leaves the emulator's native click-drag selection
   *  working. Defaults to `true` so every existing caller/test keeps the Step-5b behaviour. */
  readonly mouse?: boolean;
}): AltScreenController {
  const { write, active } = opts;
  const mouse = opts.mouse ?? true;
  let entered = false;
  let restored = false;
  return {
    enter: (): void => {
      if (!active || entered) return;
      // Latch AFTER the write, for the same reason as `restore` below: a `write` that throws did not enter anything,
      // and pretending it did would make `restore` emit a DECRST-1049 for a buffer the terminal is not in.
      write(ENTER_ALT_SCREEN + HIDE_CURSOR + (mouse ? ENABLE_MOUSE : ''));
      entered = true;
    },
    restore: (): void => {
      if (!entered || restored) return; // never exit a buffer we never entered; never exit twice
      // Disable mouse reporting FIRST (restore native selection), then exit the alt buffer + show the cursor. The
      // DISABLE is UNCONDITIONAL even when `mouse` is off: a disable of a mode that was never enabled is a no-op, and
      // an unconditional teardown can never strand DECSET-1002 if the option is ever mis-threaded.
      //
      // The idempotence latch is set only AFTER the write SUCCEEDS. It used to be set first, so a single transient
      // write fault (an EIO on a half-dead TTY, an EPIPE) marked the terminal "restored" and every later net — the
      // `finally`, the `process.on('exit')` net, the signal handlers — silently declined to try again. The user was
      // left on the alt buffer with mouse reporting on, permanently (Step-6h Sonnet review). This is the same
      // "track what actually changed" discipline `suspend.ts`'s `suspendFullScreen` already applies.
      //
      // BEST-EFFORT, and it never throws: this runs from a `finally`, from an `'exit'` listener (where a throw is an
      // uncaught exception) and from signal handlers. The latch staying DOWN is how a failure is reported — the next
      // net retries.
      try {
        write(DISABLE_MOUSE + EXIT_ALT_SCREEN + SHOW_CURSOR);
      } catch {
        return; // a later net gets another chance at the terminal
      }
      restored = true;
    },
    clearBetween: (): void => {
      if (!entered || restored) return;
      write(CLEAR_ALT_SCREEN);
    },
    isEntered: (): boolean => entered && !restored,
    isMouseEnabled: (): boolean => mouse && entered && !restored,
  };
}
