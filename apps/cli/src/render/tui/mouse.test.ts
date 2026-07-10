import { describe, expect, it } from 'vitest';

import { parseMouseEvent } from './mouse.js';

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

  it('the final `m` is a RELEASE — SGR does not encode WHICH button, and copy-on-select does not need it', () => {
    expect(parseMouseEvent('[<0;12;5m')).toEqual({
      kind: 'release',
      column: 12,
      row: 5,
      modifiers: NO_MODS,
    });
    expect(parseMouseEvent('[<32;12;5m')).toMatchObject({ kind: 'release' }); // a release after a drag
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
