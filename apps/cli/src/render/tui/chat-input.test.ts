import { describe, expect, it } from 'vitest';

import {
  applyEditorAction,
  deleteBeforeCursor,
  dropLastCodePoint,
  editorFromText,
  emptyEditor,
  insertAtCursor,
  reduceChatKey,
  type ChatKey,
  type ChatKeyAction,
  type EditorState,
} from './chat-input.js';

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

  it('maps Shift+Tab to cycle-mode (idle OR running — a mode change applies to the next turn)', () => {
    expect(reduceChatKey('', { tab: true, shift: true }, 'h', false)).toEqual({
      kind: 'cycle-mode',
    });
    expect(reduceChatKey('', { tab: true, shift: true }, 'h', true)).toEqual({
      kind: 'cycle-mode',
    });
    // A plain Tab (no shift) is NOT a mode cycle.
    expect(reduceChatKey('', { tab: true }, 'h', false)).toEqual({ kind: 'none' });
  });

  it('maps Esc to a mid-turn abort ONLY while running (idle Esc is inert, not an abort)', () => {
    expect(reduceChatKey('', { escape: true }, 'h', true)).toEqual({ kind: 'abort' });
    expect(reduceChatKey('', { escape: true }, 'h', false)).toEqual({ kind: 'none' }); // idle Esc: nothing to abort
  });
});

describe('reduceChatKey — approval-prompt intercept (in-flight key-swallow bypass, ADR-0057)', () => {
  const PENDING = true;
  it('maps [y]/1 to approve-once and [a]/2 to approve-always', () => {
    expect(reduceChatKey('y', KEY, '', true, PENDING)).toEqual({ kind: 'approve', scope: 'once' });
    expect(reduceChatKey('1', KEY, '', true, PENDING)).toEqual({ kind: 'approve', scope: 'once' });
    expect(reduceChatKey('a', KEY, '', true, PENDING)).toEqual({
      kind: 'approve',
      scope: 'always',
    });
    expect(reduceChatKey('2', KEY, '', true, PENDING)).toEqual({
      kind: 'approve',
      scope: 'always',
    });
  });

  it('maps [n]/[r]/3 to reject', () => {
    expect(reduceChatKey('n', KEY, '', true, PENDING)).toEqual({ kind: 'reject' });
    expect(reduceChatKey('r', KEY, '', true, PENDING)).toEqual({ kind: 'reject' });
    expect(reduceChatKey('3', KEY, '', true, PENDING)).toEqual({ kind: 'reject' });
  });

  it('maps Esc to abort (cancels the whole turn AND the pending approval)', () => {
    expect(reduceChatKey('', { escape: true }, '', true, PENDING)).toEqual({ kind: 'abort' });
  });

  it('SWALLOWS every other key while an approval is pending (no deadlock, no stray edit)', () => {
    // Even Ctrl-C / Return / a printable are ignored during the approval — only y/a/n/1/2/3/Esc act.
    expect(reduceChatKey('c', { ctrl: true }, '', true, PENDING)).toEqual({ kind: 'none' });
    expect(reduceChatKey('', { return: true }, '', true, PENDING)).toEqual({ kind: 'none' });
    expect(reduceChatKey('z', KEY, '', true, PENDING)).toEqual({ kind: 'none' });
  });
});

describe('applyEditorAction (the functional-updater body, cursor-general)', () => {
  const at = (text: string, cursor = text.length): EditorState => ({ text, cursor });

  it('appends / backspaces at the cursor, and leaves the editor untouched for non-edit actions', () => {
    expect(applyEditorAction(at('ab'), { kind: 'append', char: 'c' })).toEqual(at('abc'));
    expect(applyEditorAction(at('abc'), { kind: 'backspace' })).toEqual(at('ab'));
    expect(applyEditorAction(at(''), { kind: 'backspace' })).toEqual(at('')); // no-op on an empty buffer
    expect(applyEditorAction(at('ab'), { kind: 'cancel' })).toEqual(at('ab'));
    expect(applyEditorAction(at('ab'), { kind: 'none' })).toEqual(at('ab'));
    expect(applyEditorAction(at('ab'), { kind: 'submit', line: 'ab' })).toEqual(at('ab')); // submit is a non-edit
  });

  it('REGRESSION: a coalesced multi-event chunk folds onto the LATEST editor (no dropped char)', () => {
    // ink dispatches every event parsed from one stdin chunk synchronously with no render flush between them
    // (e.g. a printable interleaved with an escape sequence: ['a', ESC[C (ignored), 'b']). The reducer is fed the
    // SAME stale text for each, so it MUST emit edit OPS that fold functionally — a precomputed value would
    // overwrite to 'b' (dropping 'a'). Fold the ops the way the functional updater does (over the accumulator).
    const events: Array<[string, ChatKey]> = [
      ['a', KEY],
      ['', { return: false }], // a non-edit event in the same chunk (e.g. an arrow-key CSI ink ignores)
      ['b', KEY],
    ];
    const STALE = ''; // every event in the chunk sees the same render-captured (stale) text
    let editor = emptyEditor();
    for (const [char, key] of events) {
      const action: ChatKeyAction = reduceChatKey(char, key, STALE, false);
      editor = applyEditorAction(editor, action); // functional fold over the ACCUMULATED editor
    }
    expect(editor).toEqual(at('ab')); // not 'b' — the 'a' is not dropped, and the cursor tracks the end

    // Anti-proof: the OLD value-form (a precomputed `value: STALE + char` applied by REPLACING the buffer) drops
    // 'a' — proving the op-form + functional fold is what fixes it, not just that the test produces 'ab'.
    let staleResult = STALE;
    for (const [char, key] of events) {
      if (char.length > 0 && key.ctrl !== true && key.meta !== true) staleResult = STALE + char; // last write wins
    }
    expect(staleResult).toBe('b'); // the regression the op-refactor fixed
  });

  it('NOTE: a same-chunk [type, Return] submits the stale render-captured buffer (the known [append, Return] limit)', () => {
    // reduceChatKey bakes the submit line from the `text` argument (the render capture), NOT the accumulated
    // editor. The two input owners close this gap DIFFERENTLY: ChatApp's React ref-shadow (`editorRef.current.text`,
    // chat-ink.tsx) MITIGATES it by passing the latest COMMITTED value into reduceChatKey, so a same-chunk Return
    // still submits the full buffer; the Home's `state.input.text` is a SYNCHRONOUS plain field (NOT a ref — see
    // home-controller.ts), so its submit reads the live value and RESOLVES the [type, Return] burst outright, with
    // no residual limit. At the pure-reducer level here the line is simply whatever `text` it was called with.
    expect(reduceChatKey('', { return: true }, 'partial', false)).toEqual({
      kind: 'submit',
      line: 'partial',
    });
  });
});

describe('the cursor-bearing editor primitives (2.5.D step 1)', () => {
  it('emptyEditor / editorFromText set the expected cursor', () => {
    expect(emptyEditor()).toEqual({ text: '', cursor: 0 });
    expect(editorFromText('hello')).toEqual({ text: 'hello', cursor: 5 }); // cursor at the END
  });

  it('insertAtCursor splices at the cursor and advances past the insert', () => {
    expect(insertAtCursor({ text: 'ac', cursor: 1 }, 'b')).toEqual({ text: 'abc', cursor: 2 }); // mid-buffer
    expect(insertAtCursor({ text: '', cursor: 0 }, 'hi')).toEqual({ text: 'hi', cursor: 2 }); // multi-char (paste)
    expect(insertAtCursor({ text: 'xy', cursor: 2 }, '')).toEqual({ text: 'xy', cursor: 2 }); // empty ⇒ no-op
    expect(insertAtCursor({ text: 'ab', cursor: 0 }, 'Z')).toEqual({ text: 'Zab', cursor: 1 }); // at the start
  });

  it('deleteBeforeCursor removes the code point before the cursor, moving it back', () => {
    expect(deleteBeforeCursor({ text: 'abc', cursor: 2 })).toEqual({ text: 'ac', cursor: 1 }); // mid-buffer
    expect(deleteBeforeCursor({ text: 'abc', cursor: 3 })).toEqual({ text: 'ab', cursor: 2 }); // at the end
    expect(deleteBeforeCursor({ text: 'abc', cursor: 0 })).toEqual({ text: 'abc', cursor: 0 }); // no-op at start
  });

  it('deleteBeforeCursor removes a whole astral char before the cursor (cursor back by 2 units)', () => {
    expect(deleteBeforeCursor({ text: 'a😀b', cursor: 3 })).toEqual({ text: 'ab', cursor: 1 }); // 😀 is 2 units
    expect(deleteBeforeCursor(editorFromText('hi😀'))).toEqual({ text: 'hi', cursor: 2 });
  });
});

describe('dropLastCodePoint (code-point-aware backspace)', () => {
  it('drops one BMP char', () => {
    expect(dropLastCodePoint('abc')).toBe('ab');
    expect(dropLastCodePoint('a')).toBe('');
    expect(dropLastCodePoint('')).toBe(''); // empty is a no-op
  });

  it('drops a whole astral char (emoji) — never a lone surrogate', () => {
    expect(dropLastCodePoint('hi😀')).toBe('hi'); // 😀 is two UTF-16 units; drop both, not just the low surrogate
    expect([...dropLastCodePoint('a😀b')]).toEqual(['a', '😀']); // mid-string astral chars survive intact
    expect(dropLastCodePoint('😀')).toBe(''); // a lone emoji clears the buffer (no orphan high surrogate)
  });

  it('drops ONLY one unit for a LONE surrogate (does not over-delete the char before it)', () => {
    // A trailing lone LOW surrogate not preceded by a high surrogate must drop just itself, not also the 'a'.
    expect(dropLastCodePoint('a\uDC00')).toBe('a');
    expect(dropLastCodePoint('a\uD800')).toBe('a'); // a trailing lone HIGH surrogate likewise drops just itself
  });

  it('a plain slice(0,-1) would corrupt an emoji — this helper does not', () => {
    expect('hi😀'.slice(0, -1)).not.toBe('hi'); // the naive cut leaves a lone surrogate
    expect(dropLastCodePoint('hi😀')).toBe('hi');
  });

  it('applyEditorAction backspace uses code-point removal (via deleteBeforeCursor)', () => {
    expect(applyEditorAction(editorFromText('go👍'), { kind: 'backspace' })).toEqual({
      text: 'go',
      cursor: 2,
    });
  });
});
