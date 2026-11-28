/**
 * The Home's gate and budget card counts its own APPEARANCE as an answer just before the first key (MVP-11 unit 7, round 1): the lockout runs
 * from the moment the card opened, as the native chord cards' does (`createChordCardGuard`, unit 6). A card opened by `Enter` with a `Ctrl+Y`
 * pressed 5 ms later and HELD had no lockout to meet: the first press was refused (its frame was not painted yet) and started nothing, and the
 * first auto-repeat, after an initial repeat delay of 400 ms or more (Windows about 500, X11 660), passed the dwell and the quiet gap and
 * approved the gate. With the appearance as the lockout's origin every press inside the first two seconds is refused and restarts it, so a key
 * held at any repeat rate never answers; a deliberate `Ctrl+Y` two seconds after the card appeared still does. A budget abort (`Ctrl+N`) is
 * never delayed. The product's own numbers throughout; the clock is injected.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RunBudgetGate, RunCardGate, RunGate } from '../../home/run-gates.js';
import type { HostedLaunch } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import { createChordHistory } from './chord-guard.js';
import { createRunCard } from './run-card-model.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

const RUN = 'run-0001';
const CTRL: ChatKey = { ctrl: true };
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};
const APPROVAL: RunGate = {
  runId: RUN,
  gateId: 'g1',
  nodeId: 'review',
  gateType: 'approval',
  message: 'Ship?',
  accepts: ['approved', 'rejected'],
};
const BUDGET: RunBudgetGate = {
  runId: RUN,
  gateId: 'b1',
  nodeId: 'writer',
  allowance: { kind: 'amount', microcents: 4_200_000 },
  accepts: ['approved', 'rejected'],
};
/** When the key that opened the card arrived, and when the card opened (the host builds it in the same turn). */
const OPENED_AT = 10_000;
/** The first press of the chord: 5 ms after the `Enter` that opened the card, before its frame was painted. */
const FIRST_PRESS_AFTER_MS = 5;
/** How long a held key is held in the grid. */
const HOLD_MS = 4_000;
/** The initial repeat delays and the repeat intervals of the grid (a key's first auto-repeat comes after the first, the rest at the interval). */
const INITIAL_DELAYS_MS = [0, 250, 400, 450, 500, 600, 660, 1_800] as const;
const REPEAT_INTERVALS_MS = [30, 33, 50, 100] as const;

/**
 * The card as the Home opens it: on the Home's chord history, with the key that opened it (`Enter` at {@link OPENED_AT}) already stamped as a key
 * the landing took, its frame painted from the first moment the host could measure it.
 */
function opened(gates: readonly RunCardGate[] = [APPROVAL]) {
  let now = OPENED_AT;
  const history = createChordHistory();
  history.previousKeyAt = OPENED_AT; // the `Enter` that opened it
  const resume = vi.fn(() => Promise.resolve(STARTED));
  let painted = false;
  const card = createRunCard({
    runId: RUN,
    gates,
    resume,
    now: () => now,
    history,
    painted: (snapshot) => painted && snapshot === card.getSnapshot(),
  });
  return {
    card,
    resume,
    at: (ms: number): void => {
      now = ms;
    },
    /** The host measured and flushed the card's frame now. */
    paint: (): void => {
      painted = true;
      card.shown(card.getSnapshot());
    },
    press: (letter: 'y' | 'n') => card.input(letter, CTRL),
  };
}

describe('a Ctrl+Y held from the moment the card opened never answers it, at any initial repeat delay and rate', () => {
  for (const initial of INITIAL_DELAYS_MS) {
    for (const interval of REPEAT_INTERVALS_MS) {
      it(`initial ${String(initial)} ms, every ${String(interval)} ms`, () => {
        const r = opened();
        const first = OPENED_AT + FIRST_PRESS_AFTER_MS;
        r.at(first);
        expect(r.press('y').kind, 'the first press: the card is not painted yet').toBe('refused');
        r.paint(); // the card's frame is on screen from here
        for (let at = first + initial; at <= first + HOLD_MS; at += interval) {
          r.at(at);
          expect(r.press('y').kind, `the repeat at +${String(at - OPENED_AT)} ms`).toBe('refused');
        }
        expect(r.resume).not.toHaveBeenCalled();
      });
    }
  }
});

describe('a deliberate Ctrl+Y counts from two seconds after the card appeared', () => {
  it('a single press at the lockout’s end approves; one a moment before it is refused, and restarts it', () => {
    const r = opened();
    r.at(OPENED_AT + 1);
    r.paint();
    r.at(OPENED_AT + APPROVAL_LOCKOUT_MS);
    expect(r.press('y').kind).toBe('answered');
    expect(r.resume).toHaveBeenCalledOnce();

    const early = opened();
    early.at(OPENED_AT + 1);
    early.paint();
    const refusedAt = OPENED_AT + APPROVAL_LOCKOUT_MS - 1;
    early.at(refusedAt);
    expect(early.press('y').kind, 'inside the window').toBe('refused');
    early.at(refusedAt + APPROVAL_LOCKOUT_MS - 1);
    expect(early.press('y').kind, 'the refused press restarted the window').toBe('refused');
    const lastRefused = refusedAt + APPROVAL_LOCKOUT_MS - 1;
    early.at(lastRefused + APPROVAL_LOCKOUT_MS);
    expect(early.press('y').kind, 'two seconds after the last refused press').toBe('answered');
    expect(early.resume).toHaveBeenCalledOnce();
  });

  it('a human gate’s rejection continues the run, so it waits as an approval does; a budget abort is never delayed', () => {
    const human = opened();
    human.at(OPENED_AT + 1);
    human.paint();
    human.at(OPENED_AT + 1_000);
    expect(human.press('n').kind, 'Ctrl+N on a human gate inside the window').toBe('refused');

    const budget = opened([BUDGET]);
    budget.at(OPENED_AT + FIRST_PRESS_AFTER_MS);
    expect(budget.press('n')).toMatchObject({ kind: 'answered', gateId: 'b1' });
    expect(budget.resume).toHaveBeenCalledWith(expect.objectContaining({ kind: 'budget' }));
  });
});
