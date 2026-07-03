import { describe, expect, it } from 'vitest';

import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  isPasteEnd,
  isPasteStart,
  reduceHomeKey,
  type HomeKey,
} from './home-input.js';

const KEY = (over: Partial<HomeKey> = {}): HomeKey => ({ ...over });

describe('reduceHomeKey (2.5.B Home-mode keystrokes)', () => {
  it('Ctrl-C exits the Home (a clean exit, in every mode the caller routes here)', () => {
    expect(reduceHomeKey('c', KEY({ ctrl: true }))).toEqual({ kind: 'exit' });
  });

  it('Return submits the buffer (the caller reads the latest committed value)', () => {
    expect(reduceHomeKey('', KEY({ return: true }))).toEqual({ kind: 'submit' });
  });

  it('Backspace erases before the cursor; the terminal Delete key does too (ink reports DEL as key.delete)', () => {
    expect(reduceHomeKey('', KEY({ backspace: true }))).toEqual({ kind: 'backspace' });
    expect(reduceHomeKey('', KEY({ delete: true }))).toEqual({ kind: 'backspace' }); // Unix Backspace ⇒ key.delete
  });

  it('a printable char appends', () => {
    expect(reduceHomeKey('a', KEY())).toEqual({ kind: 'append', char: 'a' });
    expect(reduceHomeKey('é', KEY())).toEqual({ kind: 'append', char: 'é' });
    expect(reduceHomeKey(' ', KEY())).toEqual({ kind: 'append', char: ' ' });
  });

  it('an UNBOUND modified char is NOT appended and is none (bound chords are motions — see below)', () => {
    expect(reduceHomeKey('x', KEY({ ctrl: true }))).toEqual({ kind: 'none' }); // Ctrl-X: unbound
    expect(reduceHomeKey('a', KEY({ meta: true }))).toEqual({ kind: 'none' }); // Meta-A: unbound (Alt+B/F are word motions)
  });

  it('a bare modifier or an empty keystroke (no char, no bound key) is none', () => {
    expect(reduceHomeKey('', KEY())).toEqual({ kind: 'none' });
  });

  it('the Home prompt shares the chat editor motions (2.5.D step 2 — reduceEditorMotion)', () => {
    // The bare Home prompt is a first-class line editor too: the same Ctrl+J newline + cursor/word/line motions +
    // kills the chat prompt has, delegated to the shared reduceEditorMotion so the two surfaces cannot drift.
    expect(reduceHomeKey('\n', KEY())).toEqual({ kind: 'newline' }); // Ctrl+J (a bare LF)
    expect(reduceHomeKey('', KEY({ leftArrow: true }))).toEqual({ kind: 'move', motion: 'left' });
    expect(reduceHomeKey('', KEY({ rightArrow: true, ctrl: true }))).toEqual({
      kind: 'move',
      motion: 'word-right',
    });
    expect(reduceHomeKey('a', KEY({ ctrl: true }))).toEqual({ kind: 'move', motion: 'line-start' }); // Ctrl+A
    expect(reduceHomeKey('', KEY({ end: true }))).toEqual({ kind: 'move', motion: 'line-end' });
    expect(reduceHomeKey('w', KEY({ ctrl: true }))).toEqual({ kind: 'kill', motion: 'word-back' });
    // A plain Return still submits (reduceEditorMotion declines it so the surface owns submit).
    expect(reduceHomeKey('\r', KEY({ return: true }))).toEqual({ kind: 'submit' });
  });

  it('Ctrl-C takes precedence over a coincident return flag', () => {
    expect(reduceHomeKey('c', KEY({ ctrl: true, return: true }))).toEqual({ kind: 'exit' });
  });
});

describe('bracketed-paste markers (DECSET 2004)', () => {
  it('recognizes the paste-start marker in both the ink-stripped and the raw form', () => {
    expect(isPasteStart('[200~')).toBe(true); // ink strips the leading ESC
    expect(isPasteStart('\x1b[200~')).toBe(true); // raw, defensive
    expect(isPasteStart('[201~')).toBe(false);
    expect(isPasteStart('[200~x')).toBe(false); // a whole-string match only — no substring false-trigger
    expect(isPasteStart('hello')).toBe(false);
  });

  it('recognizes the paste-end marker in both forms', () => {
    expect(isPasteEnd('[201~')).toBe(true);
    expect(isPasteEnd('\x1b[201~')).toBe(true);
    expect(isPasteEnd('[200~')).toBe(false);
    expect(isPasteEnd('')).toBe(false);
  });

  it('the DECSET 2004 enable/disable strings are REAL CSI sequences (first byte ESC, not a literal "[")', () => {
    // A non-tautological guard: the first byte MUST be ESC (0x1b), else the terminal prints `[?2004h` as garbage
    // and bracketed paste is silently never enabled (the whole feature dies on a real TTY).
    expect(ENABLE_BRACKETED_PASTE.charCodeAt(0)).toBe(0x1b);
    expect(DISABLE_BRACKETED_PASTE.charCodeAt(0)).toBe(0x1b);
    expect(ENABLE_BRACKETED_PASTE).toBe('\x1b[?2004h');
    expect(DISABLE_BRACKETED_PASTE).toBe('\x1b[?2004l');
  });
});
