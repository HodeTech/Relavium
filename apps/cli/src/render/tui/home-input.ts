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

/**
 * Bracketed-paste support (DECSET 2004, 2.5.B). The control strings the host writes to ENABLE the mode on
 * mount and DISABLE it on teardown — with the mode on, a terminal wraps a paste in `ESC[200~ … ESC[201~`, so a
 * pasted multi-line block is delivered as bracketed literal text instead of its embedded newlines submitting
 * early. (ink 6.8 has no native 2004 support, so the host owns the enable/disable + the marker handling.)
 */
const ESC = '\x1b';
export const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
export const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;

/**
 * The paste-boundary markers as `useInput` surfaces them. ink's input layer strips the single leading ESC from
 * an unrecognized escape sequence, so `ESC[200~` arrives as the literal `[200~`; the raw form is matched too for
 * defence across terminals/ink builds. A real user can only produce these as one coalesced event via an actual
 * paste (typing the five chars sends five single-char events), so a whole-string match cannot false-trigger.
 */
const PASTE_START_FORMS = ['[200~', `${ESC}[200~`] as const; // ink-stripped form + the raw (ESC-prefixed) form
const PASTE_END_FORMS = ['[201~', `${ESC}[201~`] as const;

/** Whether this whole `useInput` chunk is the paste-start marker (host enters literal paste mode). */
export function isPasteStart(input: string): boolean {
  return (PASTE_START_FORMS as readonly string[]).includes(input);
}

/** Whether this whole `useInput` chunk is the paste-end marker (host leaves literal paste mode). */
export function isPasteEnd(input: string): boolean {
  return (PASTE_END_FORMS as readonly string[]).includes(input);
}
