import { describe, expect, it } from 'vitest';

import { applyChatEdit, reduceChatKey, type ChatKey, type ChatKeyAction } from './chat-input.js';

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

  it('emits a backspace OP on backspace or delete (no precomputed value — see the burst test)', () => {
    expect(reduceChatKey('', { backspace: true }, 'abc', false)).toEqual({ kind: 'backspace' });
    expect(reduceChatKey('', { delete: true }, 'abc', false)).toEqual({ kind: 'backspace' });
  });

  it('emits an append OP carrying the printable char', () => {
    expect(reduceChatKey('a', KEY, 'h', false)).toEqual({ kind: 'append', char: 'a' });
    expect(reduceChatKey(' ', KEY, 'h', false)).toEqual({ kind: 'append', char: ' ' });
  });

  it('ignores a ctrl/meta chord that is not Ctrl-C, and an empty keystroke', () => {
    expect(reduceChatKey('a', { ctrl: true }, 'h', false)).toEqual({ kind: 'none' }); // Ctrl-A
    expect(reduceChatKey('v', { meta: true }, 'h', false)).toEqual({ kind: 'none' }); // Meta-V
    expect(reduceChatKey('', KEY, 'h', false)).toEqual({ kind: 'none' }); // a bare modifier press
  });
});

describe('applyChatEdit (the functional-updater body)', () => {
  it('appends / backspaces, and leaves the buffer untouched for non-edit actions', () => {
    expect(applyChatEdit('ab', { kind: 'append', char: 'c' })).toBe('abc');
    expect(applyChatEdit('abc', { kind: 'backspace' })).toBe('ab');
    expect(applyChatEdit('', { kind: 'backspace' })).toBe(''); // no-op on an empty buffer
    expect(applyChatEdit('ab', { kind: 'cancel' })).toBe('ab');
    expect(applyChatEdit('ab', { kind: 'none' })).toBe('ab');
    expect(applyChatEdit('ab', { kind: 'submit', line: 'ab' })).toBe('ab'); // submit is a non-edit
  });

  it('REGRESSION: a coalesced multi-event chunk composes onto the LATEST buffer (no dropped char)', () => {
    // ink dispatches every event parsed from one stdin chunk synchronously with no render flush between them
    // (e.g. a printable interleaved with an escape sequence: ['a', ESC[C (ignored), 'b']). The reducer is fed the
    // SAME stale `input` for each, so it MUST emit edit OPS that fold functionally — a precomputed value would
    // overwrite to 'b' (dropping 'a'). Fold the ops the way the functional updater does (over the accumulator).
    const events: Array<[string, ChatKey]> = [
      ['a', KEY],
      ['', { return: false }], // a non-edit event in the same chunk (e.g. an arrow-key CSI ink ignores)
      ['b', KEY],
    ];
    const STALE = ''; // every event in the chunk sees the same render-captured (stale) buffer
    let buffer = STALE;
    for (const [char, key] of events) {
      const action: ChatKeyAction = reduceChatKey(char, key, STALE, false);
      buffer = applyChatEdit(buffer, action); // functional fold over the ACCUMULATED buffer
    }
    expect(buffer).toBe('ab'); // not 'b' — the 'a' is not dropped

    // Anti-proof: the OLD value-form (a precomputed `value: STALE + char` applied by REPLACING the buffer) drops
    // 'a' — proving the op-form + functional fold is what fixes it, not just that the test produces 'ab'.
    let staleResult = STALE;
    for (const [char, key] of events) {
      if (char.length > 0 && key.ctrl !== true && key.meta !== true) staleResult = STALE + char; // last write wins
    }
    expect(staleResult).toBe('b'); // the regression the op-refactor fixed
  });

  it('NOTE: a same-chunk [type, Return] submits the stale render-captured buffer (the known [append, Return] limit)', () => {
    // reduceChatKey bakes the submit line from the `input` argument (the render capture), NOT the accumulated
    // buffer — so a Return arriving in the same chunk as a preceding char submits the PRE-edit buffer. The
    // ChatApp ref-shadow (inputRef.current) mitigates this for the real component by passing the latest committed
    // value; at the pure-reducer level the line is whatever `input` it was called with.
    expect(reduceChatKey('', { return: true }, 'partial', false)).toEqual({
      kind: 'submit',
      line: 'partial',
    });
  });
});
