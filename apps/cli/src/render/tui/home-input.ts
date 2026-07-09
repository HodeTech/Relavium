import { reduceEditorMotion, type EditorEditAction } from './chat-input.js';

/**
 * The Home-mode key reducer for the bare-invocation Home (2.5.B / ADR-0054) — the read-only-strip counterpart of
 * {@link reduceChatKey}. Like the chat reducer it is a PURE `(char, key) → action` mapping so the keystroke
 * contract is unit-tested without mounting ink; `HomeController` folds the action into its plain prompt-buffer
 * field. Home mode has no "running" notion (the strip is read-only): Ctrl-C exits the Home, Return submits the
 * buffer (the caller reads the latest committed value), and every buffer edit / cursor motion comes from the
 * SHARED {@link reduceEditorMotion} so the Home prompt and the chat prompt can never drift (2.5.D step 2).
 */

/** The subset of ink's `Key` the Home cares about — the editor keys {@link reduceEditorMotion} reads plus the
 *  Home's own Ctrl-C/Return (kept minimal + structurally testable; assignable to `ChatKey`). */
export interface HomeKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
}

/** A single Home keystroke's effect: exit the Home, submit the prompt, a shared editor edit/motion, or nothing. */
export type HomeKeyAction =
  | EditorEditAction
  | { readonly kind: 'exit' }
  | { readonly kind: 'submit' }
  | { readonly kind: 'none' };

/** Map one keystroke to its Home action. Ctrl-C → exit; then the shared editor edit/motion contract
 *  ({@link reduceEditorMotion} — printable append, backspace, Ctrl+J newline, cursor/word/line motions, kills);
 *  a plain Return (which that helper declines) → submit; everything else → none. */
export function reduceHomeKey(char: string, key: HomeKey): HomeKeyAction {
  if (key.ctrl === true && char === 'c') return { kind: 'exit' };
  const edit = reduceEditorMotion(char, key);
  if (edit !== undefined) return edit;
  if (key.return === true) return { kind: 'submit' };
  return { kind: 'none' };
}

// Bracketed paste (DECSET 2004) is handled NATIVELY by ink 7's `usePaste` (adopted 2.6.F Step 2, ADR-0068):
// ink enables/disables 2004 itself and delivers a whole paste as one event on a channel separate from `useInput`,
// routed to `HomeController.handlePaste`. The previous hand-rolled enable + marker parsing (isPasteStart/isPasteEnd
// + the `pasting` latch) is removed — on ink 7 the markers never reach `useInput`, so it was dead code.
//
// The DISABLE sequence is kept as a defensive teardown belt-and-suspenders: `usePaste` disables 2004 on unmount
// (React cleanup), but the signal/exit teardown ALSO writes it after `instance.unmount()` so the terminal is never
// left in bracketed-paste mode if a render-cleanup edge is missed on an external signal. Enable is `usePaste`'s alone.
const ESC = '\x1b';
export const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;
