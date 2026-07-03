/**
 * The pure keystroke reducer for the chat prompt, extracted from the ink `useInput` callback so BOTH the
 * `relavium chat` `ChatApp` (2.M) and the 2.5.B Home's single-tree `RootApp` drive the prompt with the SAME
 * logic — one keystroke contract, one place to test it (no ink mount needed). The caller owns the input STATE
 * and applies the side effect (set the buffer / submit / cancel); this function decides only WHAT to do.
 */

/** The minimal `ink` `Key` fields the reducer reads (a structural subset, so a test needs no ink import). */
export interface ChatKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly tab?: boolean;
  readonly escape?: boolean;
}

/**
 * What a keystroke maps to. The buffer EDITS are operations (`append` / `backspace`), NOT a precomputed value,
 * so the caller applies them through React's functional updater (`setInput((cur) => …)`) — this is load-bearing:
 * ink dispatches every event parsed from one stdin chunk synchronously with no render flush between them (a
 * coalesced burst, e.g. a printable interleaved with an escape sequence), so a precomputed `value` would read a
 * STALE buffer and drop all but the last edit. `none` is a deliberately-ignored key (a chord, or mid-turn).
 */
export type ChatKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'append'; readonly char: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'submit'; readonly line: string }
  | { readonly kind: 'cancel' }
  /** Shift+Tab — advance the chat mode (ask → plan → accept-edits → auto → ask), ADR-0057. */
  | { readonly kind: 'cycle-mode' }
  /** Esc mid-turn — abort the in-flight turn but KEEP the session alive (EA7), distinct from `cancel`. */
  | { readonly kind: 'abort' }
  /** An approval-prompt decision (accept-edits / auto's protected-path fallback): `[y]` once / `[a]` always. */
  | { readonly kind: 'approve'; readonly scope: 'once' | 'always' }
  /** An approval-prompt rejection (`[n]`). */
  | { readonly kind: 'reject' };

/**
 * The approval-prompt keystroke intercept (accept-edits / auto's protected-path fallback), extracted so
 * {@link reduceChatKey} stays flat: `[y]`/`1` approve once, `[a]`/`2` approve always, `[n]`/`r`/`3` reject,
 * `Esc` aborts the whole turn (and this pending approval); every other key is ignored. It bypasses the
 * running-swallow so a pending approval can never deadlock.
 */
function reduceApprovalKey(char: string, key: ChatKey): ChatKeyAction {
  if (key.escape === true) return { kind: 'abort' };
  if (char === 'y' || char === '1') return { kind: 'approve', scope: 'once' };
  if (char === 'a' || char === '2') return { kind: 'approve', scope: 'always' };
  if (char === 'n' || char === 'r' || char === '3') return { kind: 'reject' };
  return { kind: 'none' };
}

/**
 * Reduce one keystroke of the chat prompt to an action.
 *
 * When an approval is pending (`approvalPending`), the prompt OWNS the keyboard (see {@link reduceApprovalKey}) —
 * the in-flight key-swallow bypass (ADR-0057, no deadlock). Otherwise: `Ctrl-C` maps to `cancel` even mid-turn (a
 * streaming turn can always be interrupted); `Shift+Tab` cycles the mode (harmless mid-turn — it applies to
 * the next turn); `Esc` while `running` is a mid-turn `abort` (EA7); while a turn is `running` every OTHER key
 * is ignored (one turn at a time); `Return` submits the buffer; backspace/delete is a `backspace` op; a
 * printable char (not a ctrl/meta chord) is an `append` op. The edit ops carry no buffer value — the caller
 * folds them functionally, preserving the accumulating semantics across a batched multi-event chunk.
 */
export function reduceChatKey(
  char: string,
  key: ChatKey,
  input: string,
  running: boolean,
  approvalPending = false,
): ChatKeyAction {
  if (approvalPending) return reduceApprovalKey(char, key);
  if (key.ctrl === true && char === 'c') return { kind: 'cancel' };
  if (key.tab === true && key.shift === true) return { kind: 'cycle-mode' }; // Shift+Tab cycles the chat mode
  if (key.escape === true && running) return { kind: 'abort' }; // mid-turn abort, keeps the session (EA7)
  if (running) return { kind: 'none' }; // one turn at a time — ignore typing while the assistant streams
  if (key.return === true) return { kind: 'submit', line: input };
  if (key.backspace === true || key.delete === true) return { kind: 'backspace' };
  if (char.length > 0 && key.ctrl !== true && key.meta !== true) return { kind: 'append', char };
  return { kind: 'none' };
}

/**
 * Drop the last Unicode CODE POINT from a buffer (one backspace). A `slice(0, -1)` removes a single UTF-16 code
 * unit, which would split a trailing astral char (emoji) and leave a lone surrogate / mojibake. `codePointAt` of
 * the second-to-last unit yields a value > 0xFFFF ONLY when a high surrogate is actually followed by a low one —
 * so drop both units for a real pair, else just one (a LONE surrogate must never over-delete the char before it).
 * O(1): no whole-buffer spread.
 */
export function dropLastCodePoint(buffer: string): string {
  if (buffer.length === 0) return buffer;
  if (buffer.length >= 2 && (buffer.codePointAt(buffer.length - 2) ?? 0) > 0xffff) {
    return buffer.slice(0, -2);
  }
  return buffer.slice(0, -1);
}

/* ------------------------------------------------------------------------------------------------ *
 * The cursor-bearing editor model (2.5.D step 1).
 *
 * The prompt buffer is a `{ text, cursor }` pair, NOT a bare string, so the readline motions (step 2) and
 * history/completion (step 3+) have a cursor to move. Step 1 is a PURE REFACTOR: the wiring only ever keeps
 * the cursor pinned at the END of the buffer (insert-at-cursor == append, delete-before-cursor == the old
 * backspace), so there is NO user-visible change — the primitives are cursor-general only so later steps
 * build on them without re-plumbing. Every transition is pure and returns a NEW state, so both the ChatApp
 * ref-shadow (`editorRef`) and the Home controller fold them identically over a coalesced stdin chunk (the
 * op-not-value contract on {@link ChatKeyAction} still holds — see {@link applyEditorAction}).
 * ------------------------------------------------------------------------------------------------ */

/**
 * The chat prompt buffer: `text` plus a `cursor` — a UTF-16 code-UNIT offset into `text`, in `0..text.length`.
 * The primitives keep the cursor off a surrogate-pair boundary (step 1 keeps it at `text.length` throughout,
 * so the invariant holds trivially; the cursor/word motions in step 2 maintain it explicitly).
 */
export interface EditorState {
  readonly text: string;
  readonly cursor: number;
}

/** The empty editor — an empty buffer with the cursor at the start. */
export function emptyEditor(): EditorState {
  return { text: '', cursor: 0 };
}

/** An editor holding `text` with the cursor at the END (a set-buffer, e.g. history recall in step 3). */
export function editorFromText(text: string): EditorState {
  return { text, cursor: text.length };
}

/**
 * Insert a string at the cursor, advancing the cursor past it. `insert` may be multi-character (a paste) or a
 * single char (a keystroke). An empty insert is a no-op (returns the same reference). Splices by code UNIT —
 * the caller only ever hands whole code points / a whole pasted block, so no surrogate pair is ever split.
 */
export function insertAtCursor(editor: EditorState, insert: string): EditorState {
  if (insert.length === 0) return editor;
  const { text, cursor } = editor;
  return {
    text: text.slice(0, cursor) + insert + text.slice(cursor),
    cursor: cursor + insert.length,
  };
}

/**
 * Delete the one Unicode code point immediately BEFORE the cursor (one backspace); a no-op at the start of the
 * buffer. Reuses {@link dropLastCodePoint} on the pre-cursor slice so a trailing astral char (emoji) is removed
 * whole and a lone surrogate drops just itself — the cursor moves back by the removed unit count (1 or 2).
 */
export function deleteBeforeCursor(editor: EditorState): EditorState {
  const { text, cursor } = editor;
  if (cursor === 0) return editor;
  const before = text.slice(0, cursor);
  const trimmed = dropLastCodePoint(before);
  return { text: trimmed + text.slice(cursor), cursor: cursor - (before.length - trimmed.length) };
}

/**
 * Apply a buffer-edit action to the editor (the functional-updater body). `submit`/`cancel`/`none`/the
 * motion+approval actions don't edit the buffer here. Kept as OPS (not precomputed values) so a coalesced
 * multi-event stdin chunk folds onto the accumulated state — a precomputed value would read a stale buffer
 * and drop all but the last edit (see the burst regression test).
 */
export function applyEditorAction(editor: EditorState, action: ChatKeyAction): EditorState {
  switch (action.kind) {
    case 'append':
      return insertAtCursor(editor, action.char);
    case 'backspace':
      return deleteBeforeCursor(editor);
    default:
      return editor;
  }
}
