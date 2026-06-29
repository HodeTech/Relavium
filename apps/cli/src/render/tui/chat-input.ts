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
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
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
  | { readonly kind: 'cancel' };

/**
 * Reduce one keystroke of the chat prompt to an action. Ctrl-C maps to `cancel` even mid-turn (so a streaming
 * turn can always be interrupted); while a turn is `running` every OTHER key is ignored (one turn at a time);
 * Return submits the current buffer (`input`); backspace/delete is a `backspace` op; a printable char (not a
 * ctrl/meta chord) is an `append` op. The edit ops carry no buffer value — the caller folds them functionally,
 * preserving the original `ChatApp` accumulating semantics across a batched multi-event chunk.
 */
export function reduceChatKey(
  char: string,
  key: ChatKey,
  input: string,
  running: boolean,
): ChatKeyAction {
  if (key.ctrl === true && char === 'c') return { kind: 'cancel' };
  if (running) return { kind: 'none' }; // one turn at a time — ignore typing while the assistant streams
  if (key.return === true) return { kind: 'submit', line: input };
  if (key.backspace === true || key.delete === true) return { kind: 'backspace' };
  if (char.length > 0 && key.ctrl !== true && key.meta !== true) return { kind: 'append', char };
  return { kind: 'none' };
}

/**
 * Drop the last Unicode CODE POINT from a buffer (one backspace). A `slice(0, -1)` removes a single UTF-16 code
 * unit, which would split a trailing astral char (emoji) and leave a lone high surrogate / mojibake — so when the
 * last unit is a low surrogate of a pair, drop both units. O(1): no whole-buffer spread.
 */
export function dropLastCodePoint(buffer: string): string {
  if (buffer.length === 0) return buffer;
  const last = buffer.charCodeAt(buffer.length - 1);
  const isLowSurrogate = last >= 0xdc00 && last <= 0xdfff;
  return buffer.slice(0, buffer.length - (isLowSurrogate && buffer.length >= 2 ? 2 : 1));
}

/** Apply a buffer-edit action to a buffer (the functional-updater body). `submit`/`cancel`/`none` don't edit. */
export function applyChatEdit(buffer: string, action: ChatKeyAction): string {
  switch (action.kind) {
    case 'append':
      return buffer + action.char;
    case 'backspace':
      return dropLastCodePoint(buffer);
    default:
      return buffer;
  }
}
