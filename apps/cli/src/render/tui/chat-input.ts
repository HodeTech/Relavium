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
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
}

/** A cursor MOVE (no text change). A modified arrow (Ctrl/Alt) or Alt+B/F is a word motion; Home/End (or
 *  Ctrl+A/Ctrl+E) go to the start/end of the CURRENT line (multiline-aware); `up`/`down` move a visual line
 *  within a multi-line buffer (a NO-OP at the top/bottom edge — the caller falls back to history recall there). */
export type CursorMotion =
  | 'left'
  | 'right'
  | 'word-left'
  | 'word-right'
  | 'line-start'
  | 'line-end'
  | 'up'
  | 'down';
/** A KILL (delete a range): Ctrl+W deletes the word before the cursor, Ctrl+U to the line start, Ctrl+K to the
 *  line end. */
export type KillMotion = 'word-back' | 'to-line-start' | 'to-line-end';

/**
 * The editor-mutating keystroke actions SHARED by the chat and Home reducers — the one keystroke contract for
 * buffer edits + cursor motions. Both surfaces map these identically via {@link reduceEditorMotion}; each adds
 * its own surface actions (submit / cancel / … for chat, exit / submit for the Home) on top. The edits are
 * OPERATIONS (`append` / `newline` / a motion), NOT a precomputed value, so the caller folds them onto the
 * accumulated editor — the ChatApp via React's functional updater (`setEditor((cur) => applyEditorAction(cur,
 * action))`), the Home via a synchronous `set({ input })`. This is load-bearing: ink dispatches every event
 * parsed from one stdin chunk synchronously with no render flush (a coalesced burst — a printable interleaved
 * with an escape sequence), so a precomputed value would read a STALE buffer and drop all but the last edit.
 */
export type EditorEditAction =
  | { readonly kind: 'append'; readonly char: string }
  /** Backspace — delete the code point BEFORE the cursor. Also covers the terminal `Delete` key: on Unix ink
   *  reports the physical Backspace (DEL, `\x7f`) as `key.delete`, indistinguishable from the forward-Delete key. */
  | { readonly kind: 'backspace' }
  /** `Ctrl+J` (canonical) / `Shift+Enter` (best-effort) — insert a newline at the cursor, NOT submit. */
  | { readonly kind: 'newline' }
  /** A cursor motion (no text change) — arrows / word / line-start / line-end. */
  | { readonly kind: 'move'; readonly motion: CursorMotion }
  /** A kill (delete a range) — `Ctrl+W` / `Ctrl+U` / `Ctrl+K`. */
  | { readonly kind: 'kill'; readonly motion: KillMotion };

export type ChatKeyAction =
  | EditorEditAction
  | { readonly kind: 'none' }
  | { readonly kind: 'submit'; readonly line: string }
  | { readonly kind: 'cancel' }
  /** Shift+Tab — advance the chat mode (ask → plan → accept-edits → auto → ask), ADR-0057. */
  | { readonly kind: 'cycle-mode' }
  /** Ctrl+T — toggle the collapsible "thinking" panel (2.5.H); a pure UI-view flip, valid MID-turn (it is decided
   *  before the running-swallow, so a user can expand reasoning while it streams). */
  | { readonly kind: 'toggle-reasoning' }
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
  if (key.escape === true) return { kind: 'abort' }; // Esc aborts regardless of modifiers
  // Only an UNMODIFIED key answers the prompt. Otherwise a now-bound editor chord (Ctrl+A line-start, Ctrl+W kill,
  // Alt+B word-left) OR a meta+digit (Alt+1 — reachable via ink's ESC-prefixed parsing, `\x1b1` → char '1',
  // meta:true) would, during a pending approval, silently pick the most-permissive, session-persistent approve /
  // reject, subverting the fail-closed confirmAction floor (ADR-0057). Both letters AND digits require `bare`.
  const bare = key.ctrl !== true && key.meta !== true;
  if (!bare) return { kind: 'none' };
  if (char === 'y' || char === '1') return { kind: 'approve', scope: 'once' };
  if (char === 'a' || char === '2') return { kind: 'approve', scope: 'always' };
  if (char === 'n' || char === 'r' || char === '3') return { kind: 'reject' };
  return { kind: 'none' };
}

/** Line-boundary + readline word chords: `Home`/`Ctrl+A` → line-start, `End`/`Ctrl+E` → line-end, `Alt+B`/`Alt+F`
 *  → word-left/right. `undefined` when the key is not one of these. */
function reduceLineMotion(char: string, key: ChatKey): EditorEditAction | undefined {
  if (key.home === true || (key.ctrl === true && char === 'a'))
    return { kind: 'move', motion: 'line-start' };
  if (key.end === true || (key.ctrl === true && char === 'e'))
    return { kind: 'move', motion: 'line-end' };
  if (key.meta === true && char === 'b') return { kind: 'move', motion: 'word-left' }; // readline Alt+B
  if (key.meta === true && char === 'f') return { kind: 'move', motion: 'word-right' }; // readline Alt+F
  return undefined;
}

/** A cursor motion (arrows / `Ctrl+A`/`Ctrl+E` / `Home`/`End` / `Alt+B`/`Alt+F`), or `undefined` when not a motion.
 *  A modified arrow (Ctrl/Alt+arrow) is a WORD motion; a bare arrow steps one code point. */
function reduceCursorMotion(char: string, key: ChatKey): EditorEditAction | undefined {
  const wordMod = key.ctrl === true || key.meta === true;
  if (key.leftArrow === true) return { kind: 'move', motion: wordMod ? 'word-left' : 'left' };
  if (key.rightArrow === true) return { kind: 'move', motion: wordMod ? 'word-right' : 'right' };
  // Up/Down move a visual line within a multi-line buffer; at the top/bottom edge the move is a no-op and the
  // chat callers fall back to history recall (the bare Home has no history, so there it is simply a no-op).
  if (key.upArrow === true) return { kind: 'move', motion: 'up' };
  if (key.downArrow === true) return { kind: 'move', motion: 'down' };
  return reduceLineMotion(char, key);
}

/** A kill (delete a range) — `Ctrl+W` word-back / `Ctrl+U` to-line-start / `Ctrl+K` to-line-end — or `undefined`. */
function reduceKill(char: string, key: ChatKey): EditorEditAction | undefined {
  if (key.ctrl === true && char === 'w') return { kind: 'kill', motion: 'word-back' };
  if (key.ctrl === true && char === 'u') return { kind: 'kill', motion: 'to-line-start' };
  if (key.ctrl === true && char === 'k') return { kind: 'kill', motion: 'to-line-end' };
  return undefined;
}

/**
 * Map one keystroke to a SHARED editor edit/motion action, or `undefined` when it is not an editor key (so the
 * surface reducer handles its own keys — plain `Return`, `Ctrl-C`, `Shift+Tab`, …). This is the ONE home for the
 * buffer-edit + cursor-motion keystroke contract; both {@link reduceChatKey} and `reduceHomeKey` delegate here so
 * the two surfaces can never drift. `Shift+Enter` / `Ctrl+J` insert a newline (delegating cursor motions to
 * {@link reduceCursorMotion} and kills to {@link reduceKill}); Backspace (and the terminal Delete key, which ink
 * reports as `key.delete`) deletes BEFORE the cursor; a printable char appends. Plain `Return` returns `undefined`
 * so the surface submits instead of appending.
 */
export function reduceEditorMotion(char: string, key: ChatKey): EditorEditAction | undefined {
  // Newline vs submit: Shift+Enter / Ctrl+J / a bare LF insert a newline; plain Return is surface-specific (submit).
  if (key.return === true) return key.shift === true ? { kind: 'newline' } : undefined;
  if (char === '\n' || (key.ctrl === true && char === 'j')) return { kind: 'newline' }; // Ctrl+J (canonical)
  const motion = reduceCursorMotion(char, key);
  if (motion !== undefined) return motion;
  const kill = reduceKill(char, key);
  if (kill !== undefined) return kill;
  // Delete the code point BEFORE the cursor. BOTH `key.backspace` AND `key.delete` map here: on Unix terminals the
  // physical Backspace key sends DEL (`\x7f`), which ink reports as `key.delete` (NOT `key.backspace` — see ink's
  // parse-keypress), and the true forward-Delete key (`\x1b[3~`) is reported as `key.delete` too and is
  // indistinguishable at this layer. A backward delete is what a user pressing Backspace means (the common case),
  // so both go here — consistent with the palette / reverse-search / mention submodes, which already fold both.
  if (key.backspace === true || key.delete === true) return { kind: 'backspace' };
  if (char.length > 0 && char !== '\n' && key.ctrl !== true && key.meta !== true) {
    // Normalize any carriage return WITHIN the inserted text (a multi-char paste can carry CRLF / a bare CR):
    // CRLF/CR → LF, so a pasted line break becomes a real newline in the buffer + sent to the model, never a
    // stray '\r' that the display strips but the transcript keeps. A single typed char is unaffected (no CR).
    return { kind: 'append', char: char.replace(/\r\n?/g, '\n') };
  }
  return undefined;
}

/**
 * Reduce one keystroke of the chat prompt to an action.
 *
 * When an approval is pending (`approvalPending`), the prompt OWNS the keyboard (see {@link reduceApprovalKey}) —
 * the in-flight key-swallow bypass (ADR-0057, no deadlock). Otherwise: `Ctrl-C` maps to `cancel` even mid-turn (a
 * streaming turn can always be interrupted); `Shift+Tab` cycles the mode (harmless mid-turn — it applies to the
 * next turn); `Esc` while `running` is a mid-turn `abort` (EA7); while a turn is `running` every OTHER key is
 * ignored (one turn at a time). Idle, the buffer edits + cursor motions come from the shared
 * {@link reduceEditorMotion}; a plain `Return` (which that helper declines) submits the buffer. The edit/motion
 * ops carry no buffer value — the caller folds them functionally over the accumulated editor, preserving the
 * accumulating semantics across a batched multi-event chunk.
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
  if (key.ctrl === true && char === 't') return { kind: 'toggle-reasoning' }; // Ctrl+T toggles the thinking panel (mid-turn OK)
  if (key.escape === true && running) return { kind: 'abort' }; // mid-turn abort, keeps the session (EA7)
  if (running) return { kind: 'none' }; // one turn at a time — ignore typing while the assistant streams
  const edit = reduceEditorMotion(char, key);
  if (edit !== undefined) return edit;
  if (key.return === true) return { kind: 'submit', line: input };
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
 * The chat prompt buffer: `text` plus a `cursor` — a UTF-16 code-UNIT offset into `text`, in `0..text.length`,
 * that must never split a surrogate pair. Step 1 keeps the cursor at `text.length` throughout, so the invariant
 * holds trivially. The insert/delete primitives TRUST this invariant — they do not re-validate — so step 2's
 * cursor/word motions are responsible for clamping every movement to a code-point boundary within `0..text.length`
 * (a cursor that lands mid-pair or out of range would silently corrupt the buffer — see the step-2 motion tests).
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

/* --- Cursor motions (2.5.D step 2). All step by whole CODE POINTS and clamp to `0..text.length`, so the cursor
 * the insert/delete primitives TRUST can never land mid-surrogate-pair or out of range (closing the step-1
 * codepoint-review MEDIUM). --- */

/** The code-unit index of the code-point boundary one step LEFT of `i` (clamped to 0). */
function stepLeft(text: string, i: number): number {
  if (i <= 0) return 0;
  // codePointAt(i-2) > 0xffff ⇒ text[i-2..i-1] is a real astral pair ending at the cursor — step over both units.
  if (i >= 2 && (text.codePointAt(i - 2) ?? 0) > 0xffff) return i - 2;
  return i - 1;
}

/** The code-unit index of the code-point boundary one step RIGHT of `i` (clamped to `text.length`). */
function stepRight(text: string, i: number): number {
  if (i >= text.length) return text.length;
  // codePointAt(i) > 0xffff ⇒ an astral pair STARTS at i — step over both units.
  return (text.codePointAt(i) ?? 0) > 0xffff ? i + 2 : i + 1;
}

/** Whether the code point starting at code-unit index `i` is a "word" char (Unicode letter / number / `_`). */
const WORD_CODE_POINT = /[\p{L}\p{M}\p{N}_]/u; // include \p{M} so a base + combining diacritic is ONE word
function isWordAt(text: string, i: number): boolean {
  const cp = text.codePointAt(i);
  return cp !== undefined && WORD_CODE_POINT.test(String.fromCodePoint(cp));
}

/** The code-unit index one word LEFT of `i`: skip non-word code points, then the word run (readline `Alt+B`). */
function wordLeft(text: string, i: number): number {
  let j = i;
  while (j > 0 && !isWordAt(text, stepLeft(text, j))) j = stepLeft(text, j);
  while (j > 0 && isWordAt(text, stepLeft(text, j))) j = stepLeft(text, j);
  return j;
}

/** The code-unit index one word RIGHT of `i`: skip non-word code points, then the word run (readline `Alt+F`). */
function wordRight(text: string, i: number): number {
  let j = i;
  const n = text.length;
  while (j < n && !isWordAt(text, j)) j = stepRight(text, j);
  while (j < n && isWordAt(text, j)) j = stepRight(text, j);
  return j;
}

/** The start of the line containing `i` (just after the previous `\n`, or 0) — multiline `Ctrl+A` / `Home`. */
function lineStart(text: string, i: number): number {
  // Guard i<=0: `lastIndexOf('\n', -1)` clamps the negative fromIndex to 0 and would false-match a LEADING '\n',
  // returning 1 (jumping past the empty first line + inverting the Ctrl+U cut range). At the buffer start there is
  // no preceding line, so the line start is always 0.
  const nl = i <= 0 ? -1 : text.lastIndexOf('\n', i - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** The end of the line containing `i` (just before the next `\n`, or `text.length`) — multiline `Ctrl+E` / `End`. */
function lineEnd(text: string, i: number): number {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}

/** Back off `i` to a code-point boundary if it splits a surrogate pair (a column-preserving vertical move can land
 *  mid-pair on a line with an astral char). `codePointAt(i-1) > 0xffff` ⇔ a real astral pair straddles `i`. */
function snapCodePoint(text: string, i: number): number {
  if (i > 0 && i < text.length && (text.codePointAt(i - 1) ?? 0) > 0xffff) return i - 1;
  return i;
}

/**
 * A visual-line move (`Up`/`Down`), preserving the code-unit column. Returns the SAME index (a no-op) at the
 * top/bottom edge — there is no line above/below — so the caller falls back to history recall there.
 */
function verticalMove(text: string, cursor: number, dir: 'up' | 'down'): number {
  const curStart = lineStart(text, cursor);
  const col = cursor - curStart;
  if (dir === 'up') {
    if (curStart === 0) return cursor; // no line above ⇒ no-op
    const prevStart = lineStart(text, curStart - 1); // curStart-1 is the '\n' ending the previous line
    const prevLen = curStart - 1 - prevStart;
    return snapCodePoint(text, prevStart + Math.min(col, prevLen));
  }
  const curEnd = lineEnd(text, cursor);
  if (curEnd === text.length) return cursor; // no line below ⇒ no-op
  const nextStart = curEnd + 1; // just after the '\n'
  const nextLen = lineEnd(text, nextStart) - nextStart;
  return snapCodePoint(text, nextStart + Math.min(col, nextLen));
}

/** Move the cursor per a {@link CursorMotion} (text unchanged); a no-op returns the same reference. */
export function moveCursor(editor: EditorState, motion: CursorMotion): EditorState {
  const { text, cursor } = editor;
  let next: number;
  switch (motion) {
    case 'left':
      next = stepLeft(text, cursor);
      break;
    case 'right':
      next = stepRight(text, cursor);
      break;
    case 'word-left':
      next = wordLeft(text, cursor);
      break;
    case 'word-right':
      next = wordRight(text, cursor);
      break;
    case 'line-start':
      next = lineStart(text, cursor);
      break;
    case 'line-end':
      next = lineEnd(text, cursor);
      break;
    case 'up':
      next = verticalMove(text, cursor, 'up');
      break;
    case 'down':
      next = verticalMove(text, cursor, 'down');
      break;
  }
  return next === cursor ? editor : { text, cursor: next };
}

/** Delete a range per a {@link KillMotion}, leaving the cursor at the cut point; a no-op returns the same ref. */
export function killRange(editor: EditorState, motion: KillMotion): EditorState {
  const { text, cursor } = editor;
  let from: number;
  let to: number;
  switch (motion) {
    case 'word-back':
      // Line-scoped like to-line-start / to-line-end: a word-back kill never crosses a '\n'. Without the clamp,
      // wordLeft treats '\n' as ordinary whitespace, so Ctrl+W on / just after a blank line would wipe the whole
      // previous line or paragraph in one keystroke.
      from = Math.max(wordLeft(text, cursor), lineStart(text, cursor));
      to = cursor;
      break;
    case 'to-line-start':
      from = lineStart(text, cursor);
      to = cursor;
      break;
    case 'to-line-end':
      from = cursor;
      to = lineEnd(text, cursor);
      break;
  }
  if (from >= to) return editor; // `>=` (not just `===`) is defense-in-depth: an inverted range never duplicates
  return { text: text.slice(0, from) + text.slice(to), cursor: from };
}

/**
 * Apply a buffer-edit / motion action to the editor (the functional-updater body). `submit`/`cancel`/`none`/the
 * approval actions don't change the editor here. Kept as OPS (not precomputed values) so a coalesced multi-event
 * stdin chunk folds onto the accumulated state — a precomputed value would read a stale buffer and drop all but
 * the last edit (see the burst regression test).
 */
export function applyEditorAction(editor: EditorState, action: ChatKeyAction): EditorState {
  switch (action.kind) {
    case 'append':
      return insertAtCursor(editor, action.char);
    case 'backspace':
      return deleteBeforeCursor(editor);
    case 'newline':
      return insertAtCursor(editor, '\n');
    case 'move':
      return moveCursor(editor, action.motion);
    case 'kill':
      return killRange(editor, action.motion);
    default:
      return editor;
  }
}
