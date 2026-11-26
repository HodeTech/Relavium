/**
 * The CONTINUE answer of a BUDGET gate (`Ctrl+Y`: the run goes on over its allowance, MVP-11 unit 7 round 2) is as consequential as an approval,
 * so it passes every layer one does: the card's frame must be painted, the lockout from the card's appearance and from the last key must be
 * clear, and a key held from before the card opened never answers it. `run-card-appearance-lockout.test.ts` runs its held-key grid on a human
 * gate only and exercises a budget gate only with its abort (`Ctrl+N`, which is never delayed), so a budget card whose `Ctrl+Y` skipped the
 * guard (`strict` false for a budget gate's continue) passed every other test. The product's own numbers throughout; the clock is injected.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RunBudgetGate } from '../../home/run-gates.js';
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
/** The initial repeat delays (none, Windows about 500, X11 660, a slow one) and the repeat intervals of the grid. */
const INITIAL_DELAYS_MS = [0, 500, 660, 1_800] as const;
const REPEAT_INTERVALS_MS = [30, 33, 50, 100] as const;

/** A budget card as the Home opens it: on the Home's chord history, with the key that opened it already stamped, its frame not yet painted. */
function opened() {
  let now = OPENED_AT;
  const history = createChordHistory();
  history.previousKeyAt = OPENED_AT; // the `Enter` that opened it
  const resume = vi.fn(() => Promise.resolve(STARTED));
  let painted = false;
  const card = createRunCard({
    runId: RUN,
    gates: [BUDGET],
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
    /** The card was handed to the terminal (its dwell starts) while its frame is not yet the one measured and flushed. */
    shown: (): void => {
      card.shown(card.getSnapshot());
    },
    /** The host measured and flushed the card's frame now. */
    paint: (): void => {
      painted = true;
      card.shown(card.getSnapshot());
    },
    press: (letter: 'y' | 'n') => card.input(letter, CTRL),
  };
}

describe('a Ctrl+Y held on a budget card from the moment it opened never continues the run, at any initial repeat delay and rate', () => {
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

describe('a deliberate Ctrl+Y on a budget card counts from two seconds after it appeared', () => {
  it('a single press at the lockout’s end continues the run once, with a budget decision', () => {
    const r = opened();
    r.at(OPENED_AT + 1);
    r.paint();
    r.at(OPENED_AT + APPROVAL_LOCKOUT_MS);
    expect(r.press('y')).toMatchObject({
      kind: 'answered',
      gateId: 'b1',
      decision: { decision: 'approved', approvedAmountMicrocents: 4_200_000 },
    });
    expect(r.resume).toHaveBeenCalledOnce();
    expect(r.resume).toHaveBeenCalledWith(expect.objectContaining({ kind: 'budget' }));
  });

  it('a press one millisecond before the end is refused, starts nothing, and restarts the window', () => {
    const r = opened();
    r.at(OPENED_AT + 1);
    r.paint();
    const refusedAt = OPENED_AT + APPROVAL_LOCKOUT_MS - 1;
    r.at(refusedAt);
    expect(r.press('y').kind, 'one millisecond inside the window').toBe('refused');
    expect(r.resume).not.toHaveBeenCalled();
    const lastRefused = refusedAt + APPROVAL_LOCKOUT_MS - 1;
    r.at(lastRefused);
    expect(r.press('y').kind, 'the refused press restarted the window').toBe('refused');
    r.at(lastRefused + APPROVAL_LOCKOUT_MS);
    expect(r.press('y').kind, 'two seconds after the last refused press').toBe('answered');
    expect(r.resume).toHaveBeenCalledOnce();
  });

  it('a card never shown refuses it even long after the lockout', () => {
    const r = opened();
    r.at(OPENED_AT + 10 * APPROVAL_LOCKOUT_MS);
    expect(r.press('y').kind).toBe('refused');
    expect(r.resume).not.toHaveBeenCalled();
  });

  it('a card shown but whose frame is not the one painted refuses it, and answers once it is: the person answers what is on screen', () => {
    const r = opened();
    r.at(OPENED_AT + 1);
    r.shown();
    r.at(OPENED_AT + 10 * APPROVAL_LOCKOUT_MS);
    expect(r.press('y').kind, 'dwell and lockout clear, frame not painted').toBe('refused');
    expect(r.resume).not.toHaveBeenCalled();
    r.at(OPENED_AT + 20 * APPROVAL_LOCKOUT_MS);
    r.paint();
    r.at(OPENED_AT + 30 * APPROVAL_LOCKOUT_MS);
    expect(r.press('y').kind, 'painted').toBe('answered');
    expect(r.resume).toHaveBeenCalledOnce();
  });
});

describe('the budget abort stays the safe, undelayed answer', () => {
  it('Ctrl+N answers at once, unpainted and inside the window, and stops the step at the budget', () => {
    const r = opened();
    r.at(OPENED_AT + FIRST_PRESS_AFTER_MS);
    expect(r.press('n')).toMatchObject({ kind: 'answered', gateId: 'b1' });
    expect(r.resume).toHaveBeenCalledWith(expect.objectContaining({ kind: 'budget' }));
  });
});
