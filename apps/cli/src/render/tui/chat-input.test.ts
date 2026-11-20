import { describe, expect, it } from 'vitest';

import {
  applyEditorAction,
  deleteBeforeCursor,
  dropLastCodePoint,
  editorFromText,
  emptyEditor,
  insertAtCursor,
  killRange,
  moveCursor,
  pasteIsEditable,
  reduceChatKey,
  type ChatKey,
  type ChatKeyAction,
  type EditorState,
  type PasteEditableFlags,
} from './chat-input.js';

/** A bare key (no modifiers/specials set) — overlay only what a case exercises. */
const KEY: ChatKey = {};

describe('reduceChatKey', () => {
  it('Ctrl+C is not a key action: the interrupt keymap decides it before this reducer runs (ADR-0115), and it is never typing', () => {
    expect(reduceChatKey('c', { ctrl: true }, 'hi', false)).toEqual({ kind: 'none' });
    expect(reduceChatKey('c', { ctrl: true }, 'hi', true)).toEqual({ kind: 'none' });
  });

  it('ignores every other key while a turn is running (one turn at a time)', () => {
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

  it('emits a backspace OP for BOTH Backspace and the terminal Delete key (delete-before-cursor)', () => {
    expect(reduceChatKey('', { backspace: true }, 'abc', false)).toEqual({ kind: 'backspace' });
    // ink reports the Unix physical Backspace (DEL) as `key.delete`, indistinguishable from the forward-Delete
    // key — both mean a backward delete to the user, so both fold to backspace (parity with the submodes).
    expect(reduceChatKey('', { delete: true }, 'abc', false)).toEqual({ kind: 'backspace' });
  });

  it('emits an append OP carrying the printable char', () => {
    expect(reduceChatKey('a', KEY, 'h', false)).toEqual({ kind: 'append', char: 'a' });
    expect(reduceChatKey(' ', KEY, 'h', false)).toEqual({ kind: 'append', char: ' ' });
  });

  it('ignores an UNBOUND ctrl/meta chord and an empty keystroke (bound chords are motions — see below)', () => {
    expect(reduceChatKey('x', { ctrl: true }, 'h', false)).toEqual({ kind: 'none' }); // Ctrl-X: unbound
    expect(reduceChatKey('v', { meta: true }, 'h', false)).toEqual({ kind: 'none' }); // Meta-V: unbound
    expect(reduceChatKey('', KEY, 'h', false)).toEqual({ kind: 'none' }); // a bare modifier press
  });

  it('newline vs submit: Ctrl+J (bare LF) / Shift+Enter insert a newline; plain Return (CR) submits', () => {
    expect(reduceChatKey('\n', KEY, 'hi', false)).toEqual({ kind: 'newline' }); // Ctrl+J arrives as a bare '\n'
    expect(reduceChatKey('j', { ctrl: true }, 'hi', false)).toEqual({ kind: 'newline' }); // explicit Ctrl+J
    expect(reduceChatKey('', { return: true, shift: true }, 'hi', false)).toEqual({
      kind: 'newline',
    }); // Shift+Enter
    expect(reduceChatKey('\r', { return: true }, 'hi', false)).toEqual({
      kind: 'submit',
      line: 'hi',
    }); // Return=CR
  });

  it('normalizes a pasted CRLF / bare CR to LF in the appended text (no stray \\r reaches the model)', () => {
    expect(reduceChatKey('a\r\nb', KEY, '', false)).toEqual({ kind: 'append', char: 'a\nb' }); // CRLF → LF
    expect(reduceChatKey('a\rb', KEY, '', false)).toEqual({ kind: 'append', char: 'a\nb' }); // bare CR → LF
    expect(reduceChatKey('abc', KEY, '', false)).toEqual({ kind: 'append', char: 'abc' }); // no CR ⇒ unchanged
  });

  it('maps the cursor motions (arrows / word / line) and the kills (Ctrl+W/U/K)', () => {
    expect(reduceChatKey('', { leftArrow: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'left',
    });
    expect(reduceChatKey('', { rightArrow: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'right',
    });
    expect(reduceChatKey('', { leftArrow: true, ctrl: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'word-left',
    }); // a MODIFIED arrow is a word motion
    expect(reduceChatKey('', { rightArrow: true, meta: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'word-right',
    });
    expect(reduceChatKey('a', { ctrl: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'line-start',
    }); // Ctrl+A
    expect(reduceChatKey('e', { ctrl: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'line-end',
    }); // Ctrl+E
    expect(reduceChatKey('', { home: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'line-start',
    });
    expect(reduceChatKey('', { end: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'line-end',
    });
    expect(reduceChatKey('b', { meta: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'word-left',
    }); // Alt+B
    expect(reduceChatKey('f', { meta: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'word-right',
    }); // Alt+F
    expect(reduceChatKey('w', { ctrl: true }, 'hi', false)).toEqual({
      kind: 'kill',
      motion: 'word-back',
    });
    expect(reduceChatKey('u', { ctrl: true }, 'hi', false)).toEqual({
      kind: 'kill',
      motion: 'to-line-start',
    });
    expect(reduceChatKey('k', { ctrl: true }, 'hi', false)).toEqual({
      kind: 'kill',
      motion: 'to-line-end',
    });
    expect(reduceChatKey('', { upArrow: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'up',
    });
    expect(reduceChatKey('', { downArrow: true }, 'hi', false)).toEqual({
      kind: 'move',
      motion: 'down',
    });
  });

  it('motions/edits are ignored while a turn is running (one turn at a time)', () => {
    expect(reduceChatKey('', { leftArrow: true }, 'hi', true)).toEqual({ kind: 'none' });
    expect(reduceChatKey('\n', KEY, 'hi', true)).toEqual({ kind: 'none' }); // Ctrl+J too
    expect(reduceChatKey('a', { ctrl: true }, 'hi', true)).toEqual({ kind: 'none' }); // Ctrl+A too
  });

  it('maps Shift+Tab to cycle-mode idle OR running — the mode control, not the reducer, decides whether it applies (D6)', () => {
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

  it('maps Ctrl+T to toggle-reasoning (idle OR running — the thinking panel toggles mid-turn), 2.5.H', () => {
    expect(reduceChatKey('t', { ctrl: true }, 'h', false)).toEqual({ kind: 'toggle-reasoning' });
    expect(reduceChatKey('t', { ctrl: true }, 'h', true)).toEqual({ kind: 'toggle-reasoning' });
    // A bare 't' (no ctrl) is a normal character, never the toggle.
    expect(reduceChatKey('t', KEY, 'h', false)).toEqual({ kind: 'append', char: 't' });
  });
});

describe('reduceChatKey while a turn runs — what can come out, with a card or without (ADR-0057, ADR-0115)', () => {
  // A pending approval or question implies a running turn, and the card takes every key before this reducer sees it. The
  // reducer that once answered an approval for a key the card left is deleted, so this is the whole surface a running turn
  // leaves: Esc aborts, Ctrl+T toggles the thinking panel, Shift+Tab asks for a mode change (which a running turn refuses
  // with a notice), and nothing edits, submits or answers.
  it('only abort, toggle-reasoning and cycle-mode are ever produced while a turn runs — across a wide key sweep', () => {
    const allowed = new Set<ChatKeyAction['kind']>([
      'none',
      'abort',
      'toggle-reasoning',
      'cycle-mode',
    ]);
    const modifiers: ReadonlyArray<ChatKey> = [
      KEY,
      { ctrl: true },
      { meta: true },
      { shift: true },
    ];
    for (let code = 0x20; code < 0x7f; code++) {
      const char = String.fromCharCode(code);
      for (const key of modifiers) {
        const action = reduceChatKey(char, key, 'draft', true);
        expect(allowed.has(action.kind), `${JSON.stringify(char)} ${JSON.stringify(key)}`).toBe(
          true,
        );
      }
    }
    for (const key of [{ return: true }, { backspace: true }, { delete: true }, { tab: true }]) {
      expect(reduceChatKey('', key, 'draft', true), JSON.stringify(key)).toEqual({ kind: 'none' });
    }
  });

  it('a letter typed while a turn runs answers nothing — a bare letter is typing, never a decision (PR #99)', () => {
    for (const char of ['y', 'a', 'n', 'r', 'c', 'g', '1', '2', '3', 'Y', 'N']) {
      expect(reduceChatKey(char, KEY, '', true)).toEqual({ kind: 'none' });
      expect(reduceChatKey(char, { ctrl: true }, '', true), `Ctrl+${char}`).not.toEqual(
        expect.objectContaining({ kind: 'append' }),
      );
    }
  });

  it('Esc aborts (even with a modifier), Ctrl+T toggles the panel, Shift+Tab asks for a mode change', () => {
    expect(reduceChatKey('', { escape: true }, 'draft', true)).toEqual({ kind: 'abort' });
    expect(reduceChatKey('', { escape: true, ctrl: true }, 'draft', true)).toEqual({
      kind: 'abort',
    });
    expect(reduceChatKey('t', { ctrl: true }, 'draft', true)).toEqual({ kind: 'toggle-reasoning' });
    expect(reduceChatKey('', { tab: true, shift: true }, 'draft', true)).toEqual({
      kind: 'cycle-mode',
    });
    // Alt+T and a bare t are not the toggle.
    expect(reduceChatKey('t', { meta: true }, '', true)).toEqual({ kind: 'none' });
    expect(reduceChatKey('t', KEY, '', true)).toEqual({ kind: 'none' });
  });
});

describe('applyEditorAction (the functional-updater body, cursor-general)', () => {
  const at = (text: string, cursor = text.length): EditorState => ({ text, cursor });

  it('appends / backspaces at the cursor, and leaves the editor untouched for non-edit actions', () => {
    expect(applyEditorAction(at('ab'), { kind: 'append', char: 'c' })).toEqual(at('abc'));
    expect(applyEditorAction(at('abc'), { kind: 'backspace' })).toEqual(at('ab'));
    expect(applyEditorAction(at(''), { kind: 'backspace' })).toEqual(at('')); // no-op on an empty buffer
    expect(applyEditorAction(at('ab'), { kind: 'abort' })).toEqual(at('ab'));
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
    // An astral keystroke (one emoji) advances the cursor by 2 UNITS, not 1 code POINT — pins the code-unit math.
    expect(insertAtCursor({ text: '', cursor: 0 }, '😀')).toEqual({ text: '😀', cursor: 2 });
  });

  it('deleteBeforeCursor removes the code point before the cursor, moving it back', () => {
    expect(deleteBeforeCursor({ text: 'abc', cursor: 2 })).toEqual({ text: 'ac', cursor: 1 }); // mid-buffer
    expect(deleteBeforeCursor({ text: 'abc', cursor: 3 })).toEqual({ text: 'ab', cursor: 2 }); // at the end
    expect(deleteBeforeCursor({ text: 'abc', cursor: 0 })).toEqual({ text: 'abc', cursor: 0 }); // no-op at start
  });

  it('deleteBeforeCursor removes a whole astral char before the cursor (cursor back by 2 units)', () => {
    expect(deleteBeforeCursor({ text: 'a😀b', cursor: 3 })).toEqual({ text: 'ab', cursor: 1 }); // 😀 is 2 units
    expect(deleteBeforeCursor(editorFromText('hi😀'))).toEqual({ text: 'hi', cursor: 2 });
    // A LONE low surrogate before the cursor (with trailing content after it) drops just itself — the wrapper's
    // tail-append + cursor arithmetic must not over-delete the 'a' or corrupt the trailing 'b'.
    expect(deleteBeforeCursor({ text: 'a\uDC00b', cursor: 2 })).toEqual({ text: 'ab', cursor: 1 });
  });

  it('returns the SAME reference on a no-op (the documented Object.is render-skip contract)', () => {
    // The JSDoc promises `return editor` (same reference) on the no-op paths so React's functional updater can
    // Object.is-bail the re-render. `toEqual` alone would pass a regression that returned a fresh equal object;
    // `toBe` pins the reference-identity contract. deleteBeforeCursor's no-op (backspace on an empty buffer) is
    // an ordinary, frequent user action, so the skipped render is live — not merely theoretical.
    const e1: EditorState = { text: 'xy', cursor: 2 };
    expect(insertAtCursor(e1, '')).toBe(e1); // an empty insert
    const e2: EditorState = { text: 'abc', cursor: 0 };
    expect(deleteBeforeCursor(e2)).toBe(e2); // backspace at the start of the buffer
    const e3 = emptyEditor();
    expect(applyEditorAction(e3, { kind: 'backspace' })).toBe(e3); // backspace on an empty buffer
  });
});

describe('cursor motions + kills (2.5.D step 2)', () => {
  it('moveCursor left/right steps by CODE POINTS and clamps at the bounds (same ref when unchanged)', () => {
    expect(moveCursor({ text: 'abc', cursor: 2 }, 'left')).toEqual({ text: 'abc', cursor: 1 });
    expect(moveCursor({ text: 'abc', cursor: 1 }, 'right')).toEqual({ text: 'abc', cursor: 2 });
    const atStart: EditorState = { text: 'abc', cursor: 0 };
    expect(moveCursor(atStart, 'left')).toBe(atStart); // clamp at 0 ⇒ no-op, same reference
    const atEnd: EditorState = { text: 'abc', cursor: 3 };
    expect(moveCursor(atEnd, 'right')).toBe(atEnd); // clamp at length ⇒ no-op, same reference
  });

  it('moveCursor steps OVER an astral char (2 units), never landing mid-surrogate-pair (the step-1 MEDIUM)', () => {
    // 'a😀b' — 😀 is 2 units at index 1..2. Right from 1 lands at 3 (after 😀), NOT 2 (which would split the pair).
    expect(moveCursor({ text: 'a😀b', cursor: 1 }, 'right')).toEqual({ text: 'a😀b', cursor: 3 });
    expect(moveCursor({ text: 'a😀b', cursor: 3 }, 'left')).toEqual({ text: 'a😀b', cursor: 1 });
  });

  it('moveCursor word-left / word-right skip non-word then the word run (readline Alt+B/F)', () => {
    expect(moveCursor({ text: 'foo bar', cursor: 7 }, 'word-left')).toEqual({
      text: 'foo bar',
      cursor: 4,
    });
    expect(moveCursor({ text: 'foo bar', cursor: 4 }, 'word-left')).toEqual({
      text: 'foo bar',
      cursor: 0,
    });
    expect(moveCursor({ text: 'foo bar', cursor: 0 }, 'word-right')).toEqual({
      text: 'foo bar',
      cursor: 3,
    });
    expect(moveCursor({ text: 'foo bar', cursor: 3 }, 'word-right')).toEqual({
      text: 'foo bar',
      cursor: 7,
    });
  });

  it('moveCursor line-start / line-end are multiline-aware (bounded by the surrounding newlines)', () => {
    // 'ab\ncd\nef' — line1 spans [3,5]; the cursor at 4 is inside it.
    expect(moveCursor({ text: 'ab\ncd\nef', cursor: 4 }, 'line-start')).toEqual({
      text: 'ab\ncd\nef',
      cursor: 3,
    });
    expect(moveCursor({ text: 'ab\ncd\nef', cursor: 4 }, 'line-end')).toEqual({
      text: 'ab\ncd\nef',
      cursor: 5,
    });
    // first line clamps line-start to 0; last line clamps line-end to text.length.
    expect(moveCursor({ text: 'ab\ncd', cursor: 1 }, 'line-start')).toEqual({
      text: 'ab\ncd',
      cursor: 0,
    });
    expect(moveCursor({ text: 'ab\ncd', cursor: 4 }, 'line-end')).toEqual({
      text: 'ab\ncd',
      cursor: 5,
    });
  });

  it('moveCursor up/down move a visual line preserving the column, clamped to the target line length', () => {
    const text = 'ab\ncde\nfg'; // line0 'ab' [0,2], line1 'cde' [3,6], line2 'fg' [7,9]
    expect(moveCursor({ text, cursor: 5 }, 'up')).toEqual({ text, cursor: 2 }); // col 2 on line1 → clamped to line0 end
    expect(moveCursor({ text, cursor: 5 }, 'down')).toEqual({ text, cursor: 9 }); // → line2, clamped to its end
    expect(moveCursor({ text, cursor: 4 }, 'up')).toEqual({ text, cursor: 1 }); // col 1 preserved onto line0
  });

  it('moveCursor up/down are NO-OPS at the top/bottom edge (so the caller falls back to history recall)', () => {
    const single: EditorState = { text: 'abc', cursor: 1 };
    expect(moveCursor(single, 'up')).toBe(single); // no line above ⇒ same reference
    expect(moveCursor(single, 'down')).toBe(single); // no line below ⇒ same reference
    expect(moveCursor({ text: 'a\nb', cursor: 0 }, 'up')).toEqual({ text: 'a\nb', cursor: 0 }); // on the first line
    expect(moveCursor({ text: 'a\nb', cursor: 3 }, 'down')).toEqual({ text: 'a\nb', cursor: 3 }); // on the last line
  });

  it('line-start at cursor 0 of a LEADING-newline buffer is a no-op (regression: lastIndexOf(-1) clamping)', () => {
    // `'\nabc'.lastIndexOf('\n', -1)` clamps the negative fromIndex to 0 and would false-match text[0], returning
    // cursor 1 (jumping past the empty first line) and inverting the Ctrl+U cut range into a buffer corruption.
    const at0: EditorState = { text: '\nabc', cursor: 0 };
    expect(moveCursor(at0, 'line-start')).toBe(at0); // no-op, same reference (was cursor 1)
    expect(killRange(at0, 'to-line-start')).toBe(at0); // no-op, same reference (was corrupting to '\n\nabc')
    expect(killRange({ text: '\n', cursor: 0 }, 'to-line-start')).toEqual({
      text: '\n',
      cursor: 0,
    });
  });

  it('killRange word-back / to-line-start / to-line-end delete the expected range', () => {
    expect(killRange({ text: 'foo bar', cursor: 7 }, 'word-back')).toEqual({
      text: 'foo ',
      cursor: 4,
    });
    expect(killRange({ text: 'ab\ncd', cursor: 5 }, 'to-line-start')).toEqual({
      text: 'ab\n',
      cursor: 3,
    });
    expect(killRange({ text: 'ab\ncd', cursor: 3 }, 'to-line-end')).toEqual({
      text: 'ab\n',
      cursor: 3,
    });
    const atStart: EditorState = { text: 'abc', cursor: 0 };
    expect(killRange(atStart, 'word-back')).toBe(atStart); // nothing before the cursor ⇒ no-op, same reference
  });

  it('killRange word-back (Ctrl+W) is LINE-SCOPED — it never crosses a newline into a prior line', () => {
    // Without the lineStart clamp, Ctrl+W on/just after a blank line would wipe the whole previous line/paragraph.
    expect(killRange({ text: 'hello\n', cursor: 6 }, 'word-back')).toEqual({
      text: 'hello\n',
      cursor: 6,
    }); // no-op at line start
    expect(killRange({ text: 'para1\n\npara2', cursor: 6 }, 'word-back')).toEqual({
      text: 'para1\n\npara2',
      cursor: 6,
    }); // on the blank separator line ⇒ no-op, does NOT delete 'para1'
    expect(killRange({ text: 'ab\ncde', cursor: 6 }, 'word-back')).toEqual({
      text: 'ab\n',
      cursor: 3,
    }); // kills 'cde' only
  });

  it('word motions treat a base letter + combining diacritic as ONE word (\\p{M})', () => {
    // 'e' + U+0301 (combining acute) = 'é' as two code points; a word motion must not split them.
    const combined = 'éf g'; // "éf g" — one word "éf", then " g"
    expect(moveCursor({ text: combined, cursor: combined.length }, 'word-left')).toEqual({
      text: combined,
      cursor: 4,
    }); // to the start of " g"'s word ('g' at 4)
    expect(moveCursor({ text: combined, cursor: 4 }, 'word-left')).toEqual({
      text: combined,
      cursor: 0,
    }); // to start of "éf"
  });

  it('applyEditorAction routes newline / move / kill onto the editor', () => {
    expect(applyEditorAction({ text: 'ab', cursor: 1 }, { kind: 'newline' })).toEqual({
      text: 'a\nb',
      cursor: 2,
    });
    expect(applyEditorAction({ text: 'ab', cursor: 2 }, { kind: 'move', motion: 'left' })).toEqual({
      text: 'ab',
      cursor: 1,
    });
    expect(
      applyEditorAction({ text: 'foo bar', cursor: 7 }, { kind: 'kill', motion: 'word-back' }),
    ).toEqual({ text: 'foo ', cursor: 4 });
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

describe('pasteIsEditable (the SHARED bracketed-paste gate — ADR-0068 / ADR-0057)', () => {
  // The single source of truth both interactive surfaces call (the Home's HomeController.pasteEditable and the
  // standalone ChatApp's usePaste handler), so their paste gates can never drift. Testing it here proves BOTH.
  const ALL_CLEAR: PasteEditableFlags = {
    running: false,
    shellBusy: false,
    submitBusy: false,
    paletteOpen: false,
    searchOpen: false,
    mentionOpen: false,
    modelPickerOpen: false,
    effortPickerOpen: false,
    permissionsSheetOpen: false,
    approvalPending: false,
  };

  it('appends when the compose buffer is the active editable target (nothing else owns the keyboard)', () => {
    expect(pasteIsEditable(ALL_CLEAR)).toBe(true);
  });

  it('SECURITY: drops the paste while an approval is pending (a pasted token can NEVER answer the fail-closed floor)', () => {
    expect(pasteIsEditable({ ...ALL_CLEAR, approvalPending: true })).toBe(false);
  });

  it('drops the paste while ANY busy state or keyboard-owning overlay/submode is active (exhaustive per AND-term)', () => {
    // Flipping any single gate on must drop the paste — a future edit that omits one AND-term fails HERE, not only
    // in review, and the coverage holds for BOTH surfaces at once (they share this predicate). The gate list is
    // DERIVED from `ALL_CLEAR` (whose `PasteEditableFlags` type makes omitting a flag a compile error) rather than
    // restated, so a NEW flag is covered the moment it is added — a hand-kept list would silently under-test it.
    const gates = Object.keys(ALL_CLEAR);
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) {
      expect(pasteIsEditable({ ...ALL_CLEAR, [gate]: true })).toBe(false);
    }
  });
});
