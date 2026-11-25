/**
 * Which key is a chord, and which chord answers (`chord-guard.ts`; MVP-11 step 4, review round 2, security F4): a terminal that reports key
 * events (the kitty protocol's "report event types", which Ink 7 parses) sends a held key's repeat and its release as keys of their own. A
 * repeat is never a first press and a release is no press at all, so neither answers anything on a surface that reads its answer through
 * `reduceChordKey` (a popup's line, a gate or budget card, the MCP consent card); `chordOf` still recognises them as the chord they are (a held
 * `Ctrl+Y` is a refused affirmative on a step that is no line).
 */
import { describe, expect, it } from 'vitest';

import { chordOf, reduceChordKey, type ChordKey } from './chord-guard.js';

const CTRL: ChordKey = { ctrl: true };

describe('reduceChordKey answers only a press', () => {
  it.each([
    ['y', 'allow'],
    ['n', 'deny'],
  ] as const)('Ctrl+%s pressed (no event type, or `press`) is %s', (letter, answer) => {
    expect(reduceChordKey(letter, CTRL)).toBe(answer);
    expect(reduceChordKey(letter, { ...CTRL, eventType: 'press' })).toBe(answer);
  });

  it.each(['repeat', 'release'] as const)(
    'a %s of Ctrl+Y or Ctrl+N answers nothing',
    (eventType) => {
      expect(reduceChordKey('y', { ...CTRL, eventType })).toBeUndefined();
      expect(reduceChordKey('n', { ...CTRL, eventType })).toBeUndefined();
    },
  );

  it('a bare letter, a meta chord and a pasted run are no chord, whatever the event', () => {
    expect(reduceChordKey('y', {})).toBeUndefined();
    expect(reduceChordKey('y', { ctrl: true, meta: true })).toBeUndefined();
    expect(reduceChordKey('yy', CTRL)).toBeUndefined();
  });
});

describe('chordOf recognises the chord of every event', () => {
  it.each([undefined, 'press', 'repeat', 'release'] as const)(
    'Ctrl+Y (%s) is the allow chord',
    (eventType) => {
      expect(chordOf('y', eventType === undefined ? CTRL : { ...CTRL, eventType })).toBe('allow');
    },
  );

  it('and nothing that is not a chord', () => {
    expect(chordOf('y', {})).toBeUndefined();
    expect(chordOf('y', { ctrl: true, meta: true })).toBeUndefined();
    expect(chordOf('x', CTRL)).toBeUndefined();
  });
});
