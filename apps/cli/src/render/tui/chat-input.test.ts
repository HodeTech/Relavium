import { describe, expect, it } from 'vitest';

import { reduceChatKey, type ChatKey } from './chat-input.js';

/** A bare key (no modifiers/specials set) — overlay only what a case exercises. */
const KEY: ChatKey = {};

describe('reduceChatKey', () => {
  it('maps Ctrl-C to cancel — even mid-turn (a streaming turn must be interruptible)', () => {
    expect(reduceChatKey('c', { ctrl: true }, 'hi', false)).toEqual({ kind: 'cancel' });
    expect(reduceChatKey('c', { ctrl: true }, 'hi', true)).toEqual({ kind: 'cancel' });
  });

  it('ignores every non-Ctrl-C key while a turn is running (one turn at a time)', () => {
    expect(reduceChatKey('x', KEY, 'hi', true)).toEqual({ kind: 'none' });
    expect(reduceChatKey('', { return: true }, 'hi', true)).toEqual({ kind: 'none' });
    expect(reduceChatKey('', { backspace: true }, 'hi', true)).toEqual({ kind: 'none' });
  });

  it('submits the current buffer on Return', () => {
    expect(reduceChatKey('', { return: true }, 'hello', false)).toEqual({
      kind: 'submit',
      line: 'hello',
    });
    // An empty buffer still submits (the caller/slash layer decides what an empty line means).
    expect(reduceChatKey('', { return: true }, '', false)).toEqual({ kind: 'submit', line: '' });
  });

  it('trims one char on backspace or delete (and is a no-op on an empty buffer)', () => {
    expect(reduceChatKey('', { backspace: true }, 'abc', false)).toEqual({
      kind: 'input',
      value: 'ab',
    });
    expect(reduceChatKey('', { delete: true }, 'abc', false)).toEqual({
      kind: 'input',
      value: 'ab',
    });
    expect(reduceChatKey('', { backspace: true }, '', false)).toEqual({ kind: 'input', value: '' });
  });

  it('appends a printable char', () => {
    expect(reduceChatKey('a', KEY, 'h', false)).toEqual({ kind: 'input', value: 'ha' });
    expect(reduceChatKey(' ', KEY, 'h', false)).toEqual({ kind: 'input', value: 'h ' });
  });

  it('ignores a ctrl/meta chord that is not Ctrl-C, and an empty keystroke', () => {
    expect(reduceChatKey('a', { ctrl: true }, 'h', false)).toEqual({ kind: 'none' }); // Ctrl-A
    expect(reduceChatKey('v', { meta: true }, 'h', false)).toEqual({ kind: 'none' }); // Meta-V
    expect(reduceChatKey('', KEY, 'h', false)).toEqual({ kind: 'none' }); // a bare modifier press
  });
});
