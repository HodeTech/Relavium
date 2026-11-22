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
 * - `home` — the Home with no chat on screen; `loading` is true while the first message's chat is being built (nothing is loaded
 *   yet and nothing can be lost), false for the loaded Home.
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

/**
 * Whether a raw key is `Ctrl+C`. Raw mode delivers it as the key (the kernel no longer turns it into SIGINT), as ink's `useInput`
 * parses it: the letter with `ctrl` set. A key with `meta` set is a different chord and is not an interrupt.
 */
export function isInterruptKey(
  input: string,
  key: { readonly ctrl?: boolean; readonly meta?: boolean },
): boolean {
  return key.ctrl === true && key.meta !== true && input.toLowerCase() === 'c';
}

/** Any key that is not `Ctrl+C` ends the armed state at once: a `Ctrl+C` long after an interrupt starts over. */
export function pressOtherKey(): InterruptState {
  return DISARMED;
}

/**
 * Leaving the Home while a workflow run executes
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6). The rows below are the exit guard: what
 * a request to end the Home does, and what each key means at the confirmation card it opens. Like the `Ctrl+C` table above they decide
 * and perform nothing: the controller owns the card, the cancel and the exit.
 */

/** Whether the Home's run host has a leg that would be lost with the Home: none, one executing, or one already cancelling. */
export type HostedLegState = 'none' | 'executing' | 'cancelling';

/** What a request to end the Home does: leave now, or ask first. */
export type ExitDecision = 'exit' | 'ask';

/**
 * Every way to end the Home (`/exit`, the second `Ctrl+C` on the loaded landing, `Ctrl+D` on an empty prompt, the loading bail-out)
 * asks this one question. With no leg the Home leaves exactly as it always did; with a leg executing or cancelling it asks, because
 * cancelling a run is irreversible (a cancelled run cannot be resumed).
 */
export function decideExit(leg: HostedLegState): ExitDecision {
  return leg === 'none' ? 'exit' : 'ask';
}

/** What a key means at the exit-guard card. */
export type ExitGuardAnswer =
  /** `Ctrl+Y`: cancel the run and leave. */
  | 'confirm'
  /** `Esc`, `Ctrl+C` or `Ctrl+N`: close the card and stay. A confirmation treats both interrupt keys as cancel, never as confirm. */
  | 'stay'
  /** Every other key (a bare letter, `Enter`, `Ctrl+D`, a chord with `meta`): the card is still open and nothing is decided. */
  | 'ignore';

/**
 * The card's keys. The chord is the one the Home's other cards use (a Ctrl letter, the letter being the whole input, `meta` unset),
 * written out here because `chord-guard.ts` imports this module through the review model, so it cannot be imported back.
 */
export function pressExitGuardKey(
  input: string,
  key: { readonly ctrl?: boolean; readonly meta?: boolean; readonly escape?: boolean },
): ExitGuardAnswer {
  if (key.escape === true) return 'stay';
  if (isInterruptKey(input, key)) return 'stay';
  if (key.ctrl !== true || key.meta === true) return 'ignore';
  if (input === 'n') return 'stay';
  if (input === 'y') return 'confirm';
  return 'ignore';
}
