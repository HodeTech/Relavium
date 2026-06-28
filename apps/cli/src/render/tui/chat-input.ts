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

/** What a keystroke maps to; the caller applies it. `none` is a deliberately-ignored key (a chord, or mid-turn). */
export type ChatKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'input'; readonly value: string }
  | { readonly kind: 'submit'; readonly line: string }
  | { readonly kind: 'cancel' };

/**
 * Reduce one keystroke of the chat prompt to an action. Ctrl-C maps to `cancel` even mid-turn (so a streaming
 * turn can always be interrupted); while a turn is `running` every OTHER key is ignored (one turn at a time);
 * Return submits the current buffer; backspace/delete trims one char; a printable char (not a ctrl/meta chord)
 * appends. Mirrors the original `ChatApp` `useInput` body exactly.
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
  if (key.backspace === true || key.delete === true) {
    return { kind: 'input', value: input.slice(0, -1) };
  }
  if (char.length > 0 && key.ctrl !== true && key.meta !== true) {
    return { kind: 'input', value: input + char };
  }
  return { kind: 'none' };
}
