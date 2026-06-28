/**
 * The Home-mode key reducer for the bare-invocation Home (2.5.B / ADR-0054) — the read-only-strip counterpart of
 * {@link reduceChatKey}. Like the chat reducer it is a PURE `(char, key) → action` mapping so the keystroke
 * contract is unit-tested without mounting ink, and the single `useInput` owner (`RootApp`) just folds the action
 * into its ref-shadowed buffer. Home mode has no "running" notion (the strip is read-only): Ctrl-C exits the
 * Home, Return submits the buffer (the caller reads the latest committed value), and the rest edit the buffer.
 */

/** The subset of ink's `Key` the Home cares about (kept minimal + structurally testable). */
export interface HomeKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

/** A single Home keystroke's effect: exit the Home, submit the prompt, edit the buffer, or nothing. */
export type HomeKeyAction =
  | { readonly kind: 'exit' }
  | { readonly kind: 'submit' }
  | { readonly kind: 'append'; readonly char: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'none' };

/** Map one keystroke to its Home action. Ctrl-C → exit; Return → submit; Backspace/Delete → backspace; a
 *  printable char (no ctrl/meta modifier) → append; everything else → none (an arrow, a function key, …). */
export function reduceHomeKey(char: string, key: HomeKey): HomeKeyAction {
  if (key.ctrl === true && char === 'c') return { kind: 'exit' };
  if (key.return === true) return { kind: 'submit' };
  if (key.backspace === true || key.delete === true) return { kind: 'backspace' };
  if (char.length > 0 && key.ctrl !== true && key.meta !== true) return { kind: 'append', char };
  return { kind: 'none' };
}
