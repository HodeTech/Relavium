/**
 * The one interrupt keymap ([ADR-0115](../../../../../docs/decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md) §1):
 * what the FIRST `Ctrl+C` does in each state, whether it arms an exit, and that a SECOND `Ctrl+C` inside the arming window ends
 * the session. A pure reducer over an injected monotonic clock, so every raw-mode surface (the standalone chat, the in-Home chat
 * and the Home itself) decides from the same table and none of them keeps its own copy of it.
 *
 * This module decides *what* a press means. It performs nothing: the surface carries the decision out (it owns the turn's abort,
 * the approval's rejection, the editor and the exit), and `Esc` is not here at all — `Esc` never arms and never ends anything,
 * and each card decides what it steps back from ([ADR-0115 §3](../../../../../docs/decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md)).
 */

/** How long after an interrupt a second `Ctrl+C` still means "end the session". One named constant, on a monotonic clock. */
export const INTERRUPT_ARM_WINDOW_MS = 2000;

/**
 * Where the person is when they press `Ctrl+C`.
 *
 * - `card` — an approval review (any screen, or its reason or search box), an `ask_user` card (or its own-answer field) or a
 *   continue checkpoint is open. The card stops the work in its own way (reject-first for an approval, an answer of "stop" for a
 *   checkpoint, a cancelled call for a question); the keymap only says that the press stops and arms.
 * - `work` — a model turn or a `!` command is running.
 * - `prompt` — nothing is running; `hasText` says whether the composer holds a draft.
 * - `overlay` — a details view, palette, picker, `@` mention, reverse search or a confirmation card is open.
 * - `home` — the bare Home, with no chat; `loading` is true until it has read its first snapshot.
 */
export type InterruptContext =
  | { readonly kind: 'card' }
  | { readonly kind: 'work' }
  | { readonly kind: 'prompt'; readonly hasText: boolean }
  | { readonly kind: 'overlay' }
  | { readonly kind: 'home'; readonly loading: boolean };

/** What the surface must do for a `Ctrl+C`. */
export type InterruptAction =
  /** The second press inside the window: end the session (a chat ends as `/cancel` does; the Home exits with code 0). */
  | 'end-session'
  /** The first press at a card or while work runs: stop it, then the keymap is armed. */
  | 'stop-and-arm'
  /** The first press at an idle prompt holding a draft: clear the draft; nothing is armed (one stray press must not also arm an exit). */
  | 'clear-text'
  /** The first press at an idle empty prompt, or at the loaded Home: show the exit hint; the keymap is armed. */
  | 'arm-hint'
  /** The first press with an overlay open: close it; nothing is armed. */
  | 'close-overlay'
  /** The Home while it is still loading: leave at once (nothing is loaded and nothing can be lost). */
  | 'exit-now';

/** The keymap's whole state: when it was armed, on the injected clock, or `undefined` when it is not. */
export interface InterruptState {
  readonly armedAt: number | undefined;
}

export const DISARMED: InterruptState = { armedAt: undefined };

/** Whether `state` is armed at `now`: armed, and the window has not run out. */
export function isArmed(state: InterruptState, now: number): boolean {
  return state.armedAt !== undefined && now - state.armedAt <= INTERRUPT_ARM_WINDOW_MS;
}

/**
 * The effect of a `Ctrl+C` at `now` in `context`.
 *
 * Armed first: a second press inside the window ends the session wherever the person is, because they have just said "stop" and
 * "stop" again. Otherwise the first press decides by context, and arms exactly when the table says so (a draft being cleared, an
 * overlay being closed and a loading Home arm nothing).
 */
export function pressInterrupt(
  state: InterruptState,
  context: InterruptContext,
  now: number,
): { readonly state: InterruptState; readonly action: InterruptAction } {
  if (isArmed(state, now)) return { state: DISARMED, action: 'end-session' };
  switch (context.kind) {
    case 'card':
    case 'work':
      return { state: { armedAt: now }, action: 'stop-and-arm' };
    case 'prompt':
      return context.hasText
        ? { state: DISARMED, action: 'clear-text' }
        : { state: { armedAt: now }, action: 'arm-hint' };
    case 'overlay':
      return { state: DISARMED, action: 'close-overlay' };
    case 'home':
      return context.loading
        ? { state: DISARMED, action: 'exit-now' }
        : { state: { armedAt: now }, action: 'arm-hint' };
  }
}

/** Any key that is not `Ctrl+C` ends the armed state at once: a `Ctrl+C` long after an interrupt starts over. */
export function pressOtherKey(): InterruptState {
  return DISARMED;
}
