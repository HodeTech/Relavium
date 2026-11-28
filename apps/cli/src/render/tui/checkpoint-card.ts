/**
 * The continue-checkpoint card's pure model and projection
 * ([ADR-0136](../../../../../docs/decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md) §4).
 *
 * A turn that has used its interval of tool rounds pauses before the next one and asks the person. The card is host-authored
 * fixed text and two numbers (the rounds so far and what a "continue" grants) plus one elapsed time, so it is not a terminal
 * sink for untrusted content: nothing the model wrote reaches it.
 *
 * The keys: `Ctrl+Y` continues and, because it spends, is the one affirmative key and passes the approval guards in the store;
 * `Ctrl+N` and `Esc` stop at once; `Ctrl+C` stops and starts the interrupt keymap's arming window
 * ([ADR-0115](../../../../../docs/decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md) §1). Each stop is an ANSWER to the
 * engine's hook, not an abort, so the turn ends the same way (`turn_limit`) whichever of them the person pressed. A bare letter
 * answers nothing, and every other key is consumed.
 */

import { formatElapsed } from '../notation.js';
import type { ChatKey } from './chat-input.js';
import { isInterruptKey } from './interrupt-keymap.js';
import { exitKey, legend, legendItems, waitMark, type LegendExit } from './legend.js';
import { sheetRule } from './sheet-frame.js';

/** What the open card says: the rounds dispatched, the rounds a "continue" grants, and the turn's working time so far. */
export interface CheckpointCardState {
  readonly rounds: number;
  readonly interval: number;
  /** The turn's elapsed time at the moment the card opened, the person's own waits excluded. */
  readonly elapsedMs: number;
}

/** What one key means to the card. */
export type CheckpointKeyAction =
  /** `Ctrl+Y`: continue. Affirmative, so the store runs the approval guards before it counts. */
  | { readonly kind: 'continue' }
  /** `Ctrl+N` or `Esc`: stop here. Never delayed, never arms. */
  | { readonly kind: 'stop' }
  /** `Ctrl+C`: stop here, and the interrupt keymap is armed. Never delayed. */
  | { readonly kind: 'interrupt' }
  /** Any other key: consumed, nothing happens. */
  | { readonly kind: 'none' };

/**
 * Reduce one keystroke. The stop keys are matched before the affirmative one, so no key can both stop and continue, and none of
 * them depends on the card having been seen: a stop is never refused.
 */
export function reduceCheckpointKey(input: string, key: ChatKey): CheckpointKeyAction {
  if (isInterruptKey(input, key)) return { kind: 'interrupt' };
  if (key.escape === true) return { kind: 'stop' };
  if (key.ctrl === true && key.meta !== true) {
    if (input === 'n') return { kind: 'stop' };
    if (input === 'y') return { kind: 'continue' };
  }
  return { kind: 'none' };
}

/** The rows a card is drawn from. */
export interface CheckpointCardView {
  readonly rule: string;
  readonly fact: string;
  /** Always two rows: the answer keys, then the stop keys. */
  readonly keys: readonly [string, string];
}

/** What the checkpoint sheet's rule says it is (ADR-0147 §1): fixed host text. */
const RULE_LABEL = 'Checkpoint';

/**
 * The heavy rule that opens the card (ADR-0147 §1), with the wait clock on its right (`clock`, the host's display value; empty: none). As wide
 * as the thin rule it replaced, so the card's rows do not move.
 */
export function checkpointRule(columns: number, clock = ''): string {
  return sheetRule(RULE_LABEL, clock, Math.max(1, columns - 1)).text;
}

/**
 * `Esc` and `Ctrl+C` stop the turn at the checkpoint, the very act `[Ctrl+N] Stop here` is (ADR-0145 §4's progress family names it once):
 * the key that leaves says it in the same words, so the card does not name one act two ways.
 */
export const CHECKPOINT_STOP: LegendExit = exitKey.decide('stops here', ['Esc', 'Ctrl+C']);

/** Cut `text` to `width` display columns, ASCII only (the card's text is, by construction): never longer than the row. */
function head(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * The card for `state`, fitted to `columns` (the card is drawn two columns narrower than the terminal, as the other cards are).
 * The fact names what has happened and what a "continue" buys; it never claims a cost, because a checkpoint is not a budget
 * decision (ADR-0136 §2).
 */
export function projectCheckpointCard(
  state: CheckpointCardState,
  columns: number,
  /** The answer lockout holds `Ctrl+Y` now (the store's `answerLock`): it reads `(wait)` until the lock opens (ADR-0145 §3). */
  locked = false,
): CheckpointCardView {
  const width = Math.max(1, columns - 2);
  const rule = checkpointRule(columns);
  const rounds = `${String(state.rounds)} tool round${state.rounds === 1 ? '' : 's'}`;
  return {
    rule: head(rule, columns),
    fact: head(
      `This turn has used ${rounds} in ${formatElapsed(state.elapsedMs)}. Continue for ${String(state.interval)} more?`,
      width,
    ),
    keys: [
      head(
        legendItems([
          { keys: 'Ctrl+Y', verb: 'Continue', role: 'ok', ...waitMark(locked) },
          { keys: 'Ctrl+N', verb: 'Stop here', role: 'danger' },
        ]).text,
        width,
      ),
      head(legend([], CHECKPOINT_STOP), width),
    ],
  };
}
