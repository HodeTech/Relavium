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

/**
 * Bracketed-paste support (DECSET 2004, 2.5.B). The control strings the host writes to ENABLE the mode on
 * mount and DISABLE it on teardown — with the mode on, a terminal wraps a paste in `ESC[200~ … ESC[201~`, so a
 * pasted multi-line block is delivered as bracketed literal text instead of its embedded newlines submitting
 * early. (ink 6.8 has no native 2004 support, so the host owns the enable/disable + the marker handling.)
 */
export const ENABLE_BRACKETED_PASTE = '[?2004h';
export const DISABLE_BRACKETED_PASTE = '[?2004l';

/**
 * The paste-boundary markers as `useInput` surfaces them. ink's input layer strips the single leading ESC from
 * an unrecognized escape sequence, so `ESC[200~` arrives as the literal `[200~`; the raw form is matched too for
 * defence across terminals/ink builds. A real user can only produce these as one coalesced event via an actual
 * paste (typing the five chars sends five single-char events), so a whole-string match cannot false-trigger.
 */
const PASTE_START_FORMS = ['[200~', '[200~'] as const;
const PASTE_END_FORMS = ['[201~', '[201~'] as const;

/** Whether this whole `useInput` chunk is the paste-start marker (host enters literal paste mode). */
export function isPasteStart(input: string): boolean {
  return (PASTE_START_FORMS as readonly string[]).includes(input);
}

/** Whether this whole `useInput` chunk is the paste-end marker (host leaves literal paste mode). */
export function isPasteEnd(input: string): boolean {
  return (PASTE_END_FORMS as readonly string[]).includes(input);
}
