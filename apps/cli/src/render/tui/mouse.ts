/**
 * The SGR (DECSET 1006) terminal mouse-report parser — the input half of in-app text selection + copy-on-select
 * (2.6.F Step 6, ADR-0068 §e amendment).
 *
 * WHY THE APP MUST OWN THE MOUSE. A terminal either reports mouse events to the application or performs its own
 * click-drag selection — never both. With reporting on, the emulator hands us the clicks and stops selecting; with it
 * off, the wheel never reaches us. There is no in-between (DECSET 1007 "alternate scroll" turns the wheel into arrow
 * keys, which collide irrecoverably with the prompt's history keys). So a full-screen TUI that wants BOTH a scrolling
 * wheel and text selection must implement selection itself. This module is where that starts.
 *
 * WHAT WE ENABLE. **DECSET 1002** (button-event tracking): press, release, wheel, and motion **only while a button is
 * held** — i.e. drag. NOT 1003 (any-motion), which reports every pointer move and floods the input stream for nothing.
 *
 * THE ENCODING. `ESC [ < Cb ; Cx ; Cy M` (press or drag) / `… m` (release), 1-based column `Cx` and row `Cy`. `Cb` is
 * a bit field: the low two bits are the button (0 left, 1 middle, 2 right), then `+4` shift, `+8` meta/alt, `+16`
 * ctrl, `+32` motion, `+64` wheel — and when the wheel bit is set, the low two bits select the wheel direction
 * (0 up, 1 down, 2 left, 3 right) rather than a button.
 */

/** The physical button of a press/drag. Wheel "buttons" are reported separately — see {@link MouseEvent}. */
export type MouseButton = 'left' | 'middle' | 'right';

/** Modifier keys held during the report. A terminal that uses Shift as its own selection-bypass modifier will not
 *  report the event at all, so `shift` is usually false in practice — it is parsed, not relied upon. */
export interface MouseModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

/** A parsed mouse report. `row`/`column` are the terminal's own 1-based cell coordinates. */
export type MouseEvent =
  /** A wheel notch. Horizontal wheels (buttons 66/67) are reported as {@link MouseOther}. */
  | {
      readonly kind: 'wheel';
      readonly direction: 'up' | 'down';
      readonly row: number;
      readonly column: number;
      readonly modifiers: MouseModifiers;
    }
  /** A button went down — the selection ANCHOR. */
  | {
      readonly kind: 'press';
      readonly button: MouseButton;
      readonly row: number;
      readonly column: number;
      readonly modifiers: MouseModifiers;
    }
  /** The pointer moved with a button held — the selection FOCUS. */
  | {
      readonly kind: 'drag';
      readonly button: MouseButton;
      readonly row: number;
      readonly column: number;
      readonly modifiers: MouseModifiers;
    }
  /**
   * A button came up — where copy-on-select fires.
   *
   * SGR **does** encode which button was released, and that is the whole reason the mode exists: xterm's `ctlseqs`
   * says of the `m` final byte, *"A different final character is used for button release to resolve the X10 ambiguity
   * regarding which button was released."* A terminal that still reports the X10 "no button" code 3 leaves
   * {@link button} `undefined`, which the reducer treats as "some button came up" — the legacy meaning.
   */
  | {
      readonly kind: 'release';
      readonly button: MouseButton | undefined;
      readonly row: number;
      readonly column: number;
      readonly modifiers: MouseModifiers;
    }
  /** A mouse report we do not act on (a horizontal wheel, an exotic button). CONSUMED, never typed. */
  | MouseOther;

export interface MouseOther {
  readonly kind: 'other';
}

const BUTTON_MASK = 0b11;
const SHIFT_BIT = 4;
const ALT_BIT = 8;
const CTRL_BIT = 16;
const MOTION_BIT = 32;
const WHEEL_BIT = 64;

/** The leading ESC is OPTIONAL: ink's `parse-keypress` hands an unrecognized CSI to `input` with or without it. */
// eslint-disable-next-line no-control-regex -- the SGR mouse report is introduced by ESC (U+001B)
const SGR_MOUSE = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/;

function buttonOf(code: number): MouseButton | undefined {
  switch (code & BUTTON_MASK) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return undefined; // 3 = "no button" — only meaningful in the legacy X10 release encoding
  }
}

/**
 * Parse one SGR mouse report. Returns `undefined` when `input` is not a mouse report at all (a normal key), so the
 * caller can fall through to the editor. Every other result must be CONSUMED — a mouse report's raw bytes must never
 * reach the prompt.
 */
export function parseMouseEvent(input: string): MouseEvent | undefined {
  const match = SGR_MOUSE.exec(input);
  if (match === null) return undefined;

  const code = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  const released = match[4] === 'm';
  const modifiers: MouseModifiers = {
    shift: (code & SHIFT_BIT) !== 0,
    alt: (code & ALT_BIT) !== 0,
    ctrl: (code & CTRL_BIT) !== 0,
  };

  if ((code & WHEEL_BIT) !== 0) {
    // The wheel bit re-purposes the low two bits as a direction. Vertical only: a horizontal wheel (2/3) scrolls
    // nothing here and must not be mistaken for a middle/right button.
    const direction = code & BUTTON_MASK;
    if (direction === 0) return { kind: 'wheel', direction: 'up', row, column, modifiers };
    if (direction === 1) return { kind: 'wheel', direction: 'down', row, column, modifiers };
    return { kind: 'other' };
  }

  const button = buttonOf(code);
  // A release keeps its button (`undefined` only from a terminal still emitting the X10 code 3). Copy-on-select needs
  // it: without it, a right-click while a selection is live reads as "the drag ended" and re-writes the clipboard.
  if (released) return { kind: 'release', button, row, column, modifiers };

  if (button === undefined) return { kind: 'other' };
  return (code & MOTION_BIT) !== 0
    ? { kind: 'drag', button, row, column, modifiers }
    : { kind: 'press', button, row, column, modifiers };
}

/**
 * The longest fragment we will hold waiting for the rest of a report. A complete report is at most
 * `ESC [ < 3d ; 4d ; 4d M` — comfortably under this. The cap is what stops a malformed stream from growing a buffer.
 */
const MAX_PARTIAL_LENGTH = 24;

/** A strict PREFIX of an SGR mouse report: at least `[<`, then digits and up to two semicolons, and no final byte.
 *  Requiring `[<` is what keeps a user's keystroke out of the buffer — ink delivers one keypress per `useInput` call,
 *  and no single keypress is `[<`. */
// eslint-disable-next-line no-control-regex -- the SGR mouse report is introduced by ESC (U+001B)
const SGR_MOUSE_PREFIX = /^\x1b?\[<\d*(?:;\d*){0,2}$/;

/** What {@link MouseReportReader.read} decided about one `useInput` payload. */
export type MouseRead =
  /** A complete report. Act on it, and CONSUME it. */
  | { readonly kind: 'event'; readonly event: MouseEvent }
  /** The leading bytes of a report; the rest has not arrived. CONSUME it and wait. */
  | { readonly kind: 'partial' }
  /** Not a mouse report. Hand it to the editor. */
  | { readonly kind: 'none' };

export interface MouseReportReader {
  read: (input: string) => MouseRead;
}

/**
 * A stateful reader that survives an SGR report SPLIT across two `useInput` calls (2.6.F Step 6f).
 *
 * ink coalesces nothing and splits nothing on purpose — it hands over whatever the stream gave it. Verified against
 * ink 7.1.0 with a real mount: three reports written as one chunk arrive as three separate `useInput` calls (so the
 * anchored regex is right), but a report written as `'\x1b[<0;1;'` + `'1M'` arrives as TWO calls, and neither matched.
 * Both fell through to the editor, typing `[<0;1;` into the user's prompt — reachable whenever a pty read lands
 * mid-report, i.e. on any laggy SSH link during a drag.
 *
 * The buffer only ever starts on something that already looks like a report (`[<`…), is length-capped, and — when the
 * next payload does not complete it — is DISCARDED while that payload is processed normally. So a stray fragment can
 * never swallow the keystroke that follows it.
 */
export function createMouseReportReader(): MouseReportReader {
  let pending = '';

  const classify = (input: string): MouseRead | undefined => {
    const event = parseMouseEvent(input);
    if (event !== undefined) return { kind: 'event', event };
    if (input.length <= MAX_PARTIAL_LENGTH && SGR_MOUSE_PREFIX.test(input)) {
      pending = input;
      return { kind: 'partial' };
    }
    return undefined;
  };

  return {
    read: (input: string): MouseRead => {
      if (pending !== '') {
        const joined = pending + input;
        pending = '';
        const resolved = classify(joined);
        if (resolved !== undefined) return resolved;
        // The fragment did not grow into a report. Drop it (it was never a keystroke) and judge `input` on its own.
      }
      return classify(input) ?? { kind: 'none' };
    },
  };
}
