import { describe, expect, it } from 'vitest';

import { parseMouseEvent, createMouseReportReader } from './mouse.js';

/**
 * The SGR mouse-report parser (2.6.F Step 6). The bit field is the whole contract: mistake the wheel bit for a button
 * and the wheel starts a text selection; mistake the motion bit and a drag is read as a fresh press, collapsing the
 * selection on every pointer move.
 *
 * Encoding: `ESC [ < Cb ; Cx ; Cy M|m` — `Cx` COLUMN and `Cy` ROW, both 1-based; `Cb` = button | 4 shift | 8 alt |
 * 16 ctrl | 32 motion | 64 wheel.
 */

const NO_MODS = { shift: false, alt: false, ctrl: false };

describe('parseMouseEvent — not a mouse report', () => {
  it('returns undefined for ordinary keys, so they fall through to the editor', () => {
    expect(parseMouseEvent('q')).toBeUndefined();
    expect(parseMouseEvent('')).toBeUndefined();
    expect(parseMouseEvent('\x1b[5~')).toBeUndefined(); // PgUp — a key, not a mouse report
    expect(parseMouseEvent('[<0;1;1X')).toBeUndefined(); // malformed terminator
    expect(parseMouseEvent('[<0;1M')).toBeUndefined(); // missing a coordinate
  });

  it('parses with OR without the leading ESC (ink may hand the CSI to `input` either way)', () => {
    expect(parseMouseEvent('\x1b[<0;3;7M')?.kind).toBe('press');
    expect(parseMouseEvent('[<0;3;7M')?.kind).toBe('press');
  });
});

describe('parseMouseEvent — buttons and motion', () => {
  it('button 0/1/2 with the final `M` is a PRESS, carrying 1-based column + row', () => {
    expect(parseMouseEvent('[<0;12;5M')).toEqual({
      kind: 'press',
      button: 'left',
      column: 12,
      row: 5,
      modifiers: NO_MODS,
    });
    expect(parseMouseEvent('[<1;1;1M')).toMatchObject({ kind: 'press', button: 'middle' });
    expect(parseMouseEvent('[<2;1;1M')).toMatchObject({ kind: 'press', button: 'right' });
  });

  it('the MOTION bit (+32) turns a press into a DRAG — not a second press', () => {
    // 32 = left button held + motion. Reading this as a press would restart the selection on every pointer move.
    expect(parseMouseEvent('[<32;20;9M')).toEqual({
      kind: 'drag',
      button: 'left',
      column: 20,
      row: 9,
      modifiers: NO_MODS,
    });
    expect(parseMouseEvent('[<33;1;1M')).toMatchObject({ kind: 'drag', button: 'middle' });
  });

  it('the final `m` is a RELEASE, and it carries WHICH button came up', () => {
    // xterm's ctlseqs on the SGR (1006) `m` byte: "A different final character is used for button release to resolve
    // the X10 ambiguity regarding which button was released." Step 6a's comment claimed the opposite, which is why a
    // right-click used to re-copy the live selection.
    expect(parseMouseEvent('[<0;12;5m')).toEqual({
      kind: 'release',
      button: 'left',
      column: 12,
      row: 5,
      modifiers: NO_MODS,
    });
    expect(parseMouseEvent('[<2;12;5m')).toMatchObject({ kind: 'release', button: 'right' });
    expect(parseMouseEvent('[<1;12;5m')).toMatchObject({ kind: 'release', button: 'middle' });
    expect(parseMouseEvent('[<32;12;5m')).toMatchObject({ kind: 'release', button: 'left' }); // after a drag
  });

  it('a release reporting the legacy X10 "no button" code 3 leaves the button UNKNOWN, not `other`', () => {
    // A press with code 3 is meaningless and becomes `other`; a RELEASE with code 3 is the X10 encoding and still
    // means "a button came up". Dropping it would strand a live drag on such a terminal — the selection would never
    // copy and never clear.
    expect(parseMouseEvent('[<3;12;5m')).toEqual({
      kind: 'release',
      button: undefined,
      column: 12,
      row: 5,
      modifiers: NO_MODS,
    });
    expect(parseMouseEvent('[<3;12;5M')).toEqual({ kind: 'other' });
  });

  it('decodes the modifier bits (shift 4, alt 8, ctrl 16)', () => {
    // Read through `toMatchObject` on the EVENT, not `?.modifiers`: the `other` variant deliberately carries no
    // modifiers, so the union has none in common — the type system is right and the test must go through a variant.
    expect(parseMouseEvent('[<4;1;1M')).toMatchObject({
      modifiers: { shift: true, alt: false, ctrl: false },
    });
    expect(parseMouseEvent('[<8;1;1M')).toMatchObject({
      modifiers: { shift: false, alt: true, ctrl: false },
    });
    expect(parseMouseEvent('[<16;1;1M')).toMatchObject({
      modifiers: { shift: false, alt: false, ctrl: true },
    });
    // 28 = 16|8|4 with button 0.
    expect(parseMouseEvent('[<28;1;1M')).toMatchObject({
      kind: 'press',
      button: 'left',
      modifiers: { shift: true, alt: true, ctrl: true },
    });
  });
});

describe('parseMouseEvent — the wheel', () => {
  it('the WHEEL bit (+64) re-purposes the low bits as a direction, NOT as a button', () => {
    // 64 read as a button would be "left press" and would start a selection on every wheel notch.
    expect(parseMouseEvent('[<64;10;5M')).toEqual({
      kind: 'wheel',
      direction: 'up',
      column: 10,
      row: 5,
      modifiers: NO_MODS,
    });
    expect(parseMouseEvent('[<65;10;5M')).toMatchObject({ kind: 'wheel', direction: 'down' });
  });

  it('a HORIZONTAL wheel (66/67) is `other` — consumed, never mistaken for a middle/right button', () => {
    expect(parseMouseEvent('[<66;1;1M')).toEqual({ kind: 'other' });
    expect(parseMouseEvent('[<67;1;1M')).toEqual({ kind: 'other' });
  });

  it('a modified wheel still scrolls (Ctrl+wheel is a zoom in some terminals; we treat it as a notch)', () => {
    expect(parseMouseEvent('[<80;1;1M')).toMatchObject({
      kind: 'wheel',
      direction: 'up',
      modifiers: { ctrl: true },
    }); // 64|16
  });

  it('a wheel report with the motion bit set is still a wheel, never a drag', () => {
    expect(parseMouseEvent('[<96;1;1M')).toMatchObject({ kind: 'wheel', direction: 'up' }); // 64|32
  });
});

describe('parseMouseEvent — the “no button” encoding', () => {
  it('button code 3 (no button) is `other`, not a right-click', () => {
    expect(parseMouseEvent('[<3;1;1M')).toEqual({ kind: 'other' });
    expect(parseMouseEvent('[<35;1;1M')).toEqual({ kind: 'other' }); // 3|32 — motion with no button (1003 mode)
  });
});

/**
 * A report SPLIT across two `useInput` calls (2.6.F Step 6f). Verified against a real ink 7.1.0 mount: three reports
 * written as ONE chunk arrive as three separate calls (so the anchored regex is right), but a report written as
 * `'\x1b[<0;1;'` then `'1M'` arrives as TWO calls. Before the reader, neither matched and both fell through to the
 * editor — typing `[<0;1;` into the user's prompt on any laggy link during a drag.
 */
describe('createMouseReportReader — a report split across chunks', () => {
  it('holds the fragment, CONSUMES it, and emits the event when the rest arrives', () => {
    const reader = createMouseReportReader();
    expect(reader.read('[<0;1;')).toEqual({ kind: 'partial' });
    expect(reader.read('1M')).toEqual({
      kind: 'event',
      event: { kind: 'press', button: 'left', row: 1, column: 1, modifiers: NO_MODS },
    });
  });

  it('a complete report in one chunk never touches the buffer', () => {
    const reader = createMouseReportReader();
    expect(reader.read('[<64;5;5M')).toMatchObject({ kind: 'event' });
    expect(reader.read('a')).toEqual({ kind: 'none' }); // no stale fragment prepended
  });

  it('an ordinary keystroke is never mistaken for a fragment — the buffer needs a leading `[<`', () => {
    const reader = createMouseReportReader();
    for (const key of ['[', '<', ';', '0', 'a', '', '\x1b']) {
      expect(reader.read(key), key).toEqual({ kind: 'none' });
    }
  });

  it('a fragment that never completes is DROPPED, and the keystroke after it still types', () => {
    const reader = createMouseReportReader();
    expect(reader.read('[<32;9;')).toEqual({ kind: 'partial' });
    // `a` does not complete the report. The fragment is discarded, and `a` is judged on its own — never swallowed.
    expect(reader.read('a')).toEqual({ kind: 'none' });
    expect(reader.read('[<0;1;1M')).toMatchObject({ kind: 'event' }); // the reader is not wedged
  });

  it('a fragment that grows past the cap is not held forever', () => {
    const reader = createMouseReportReader();
    const long = `[<${'9'.repeat(30)}`;
    expect(reader.read(long)).toEqual({ kind: 'none' }); // too long to be a report prefix
  });

  it('a SECOND fragment can follow a dropped one (a burst of split reports)', () => {
    const reader = createMouseReportReader();
    expect(reader.read('[<32;9;')).toEqual({ kind: 'partial' });
    expect(reader.read('[<32;')).toEqual({ kind: 'partial' }); // the first is dropped, this one starts fresh
    expect(reader.read('8;2M')).toMatchObject({
      kind: 'event',
      event: { kind: 'drag', button: 'left', row: 2, column: 8 },
    });
  });
});
