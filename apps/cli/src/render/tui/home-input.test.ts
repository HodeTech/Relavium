import { describe, expect, it } from 'vitest';

import { reduceHomeKey, type HomeKey } from './home-input.js';

const KEY = (over: Partial<HomeKey> = {}): HomeKey => ({ ...over });

describe('reduceHomeKey (2.5.B Home-mode keystrokes)', () => {
  it('Ctrl-C exits the Home (a clean exit, in every mode the caller routes here)', () => {
    expect(reduceHomeKey('c', KEY({ ctrl: true }))).toEqual({ kind: 'exit' });
  });

  it('Return submits the buffer (the caller reads the latest committed value)', () => {
    expect(reduceHomeKey('', KEY({ return: true }))).toEqual({ kind: 'submit' });
  });

  it('Backspace and Delete both erase one char', () => {
    expect(reduceHomeKey('', KEY({ backspace: true }))).toEqual({ kind: 'backspace' });
    expect(reduceHomeKey('', KEY({ delete: true }))).toEqual({ kind: 'backspace' });
  });

  it('a printable char appends', () => {
    expect(reduceHomeKey('a', KEY())).toEqual({ kind: 'append', char: 'a' });
    expect(reduceHomeKey('é', KEY())).toEqual({ kind: 'append', char: 'é' });
    expect(reduceHomeKey(' ', KEY())).toEqual({ kind: 'append', char: ' ' });
  });

  it('a modified char is NOT appended (a ctrl/meta chord is not text)', () => {
    expect(reduceHomeKey('a', KEY({ ctrl: true }))).toEqual({ kind: 'none' });
    expect(reduceHomeKey('a', KEY({ meta: true }))).toEqual({ kind: 'none' });
  });

  it('a bare modifier / arrow / function key (no char) is none', () => {
    expect(reduceHomeKey('', KEY())).toEqual({ kind: 'none' });
  });

  it('Ctrl-C takes precedence over a coincident return flag', () => {
    expect(reduceHomeKey('c', KEY({ ctrl: true, return: true }))).toEqual({ kind: 'exit' });
  });
});
