/**
 * The Home's gate and budget card says when its lockout holds a key (MVP-11 unit 8, owed by unit 7's round 1 and unit 6's owed table): a
 * deliberate first `Ctrl+Y` counts about two seconds after the card appeared, and the card now says so where the key is named, with the fixed
 * word `(wait)` (ADR-0145 §3, the rule unit 6 built for the popups): a display value read beside the snapshot, never a field of it, with one timer
 * at the instant the lock opens and no ticking. The human gate's `Ctrl+N` waits too (its rejection continues the run and is guarded as an
 * approval is); a budget abort never waits. The product's own numbers; the clock and the one-shot timer are injected.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RunBudgetGate, RunCardGate, RunGate } from '../../home/run-gates.js';
import type { HostedLaunch } from '../../home/run-host.js';
import { createChordHistory } from './chord-guard.js';
import { createRunCard, projectRunCard } from './run-card-model.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

const RUN = 'run-0001';
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
const OPENED_AT = 10_000;

/** A card on an injected clock, with the lock display's one-shot timers held by the test. */
function rig(gates: readonly RunCardGate[] = [APPROVAL]) {
  let now = OPENED_AT;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const card = createRunCard({
    runId: RUN,
    gates,
    resume: vi.fn(() => Promise.resolve(STARTED)),
    now: () => now,
    history: createChordHistory(),
    painted: () => true,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  card.shown(card.getSnapshot()); // the host measured and flushed its frame at once: only the lockout holds the keys
  let notified = 0;
  card.lock.subscribe(() => {
    notified += 1;
  });
  /** Move the clock to `at` (absolute) and fire every timer that is due, in order. */
  const advanceTo = (at: number): void => {
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= at)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      now = due.at;
      due.run();
    }
    now = at;
  };
  const legend = (): string =>
    projectRunCard(card.getSnapshot(), {
      columns: 80,
      rows: 24,
      nowMs: 0,
      locked: card.lock.read(),
    }).rows.at(-1)?.text ?? '';
  const live = (): number => timers.filter((timer) => !timer.cancelled).length;
  return {
    card,
    advanceTo,
    legend,
    live,
    notified: () => notified,
    setNow: (at: number) => {
      now = at;
    },
  };
}

describe('the card says (wait) while its lockout holds a key', () => {
  it('from its appearance until the lockout has run, then once at the instant it opens, with one timer and no tick', () => {
    const r = rig();
    expect(r.card.lock.read(), 'the card has just appeared: its keys are held').toBe(true);
    expect(r.legend()).toBe(
      '[Ctrl+Y] Approve (wait) · [Ctrl+N] Reject (wait) · Esc leaves it pending',
    );
    expect(r.live(), 'one timer, at the instant the lock opens').toBe(1);
    r.advanceTo(OPENED_AT + APPROVAL_LOCKOUT_MS - 1);
    expect(r.card.lock.read(), 'a millisecond before').toBe(true);
    expect(r.notified()).toBe(0);
    r.advanceTo(OPENED_AT + APPROVAL_LOCKOUT_MS);
    expect(r.card.lock.read(), 'open at the instant').toBe(false);
    expect(r.notified(), 'one repaint, at the moment it opens').toBe(1);
    expect(r.legend()).toBe('[Ctrl+Y] Approve · [Ctrl+N] Reject · Esc leaves it pending');
    expect(r.live(), 'nothing left ticking').toBe(0);
  });

  it('a refused press inside the lockout moves its end, and the (wait) holds until the new end', () => {
    const r = rig();
    r.setNow(OPENED_AT + 1_900);
    expect(r.card.input('y', { ctrl: true }).kind, 'held: refused').toBe('refused');
    r.advanceTo(OPENED_AT + APPROVAL_LOCKOUT_MS);
    expect(r.card.lock.read(), 'the window restarted at the refused press').toBe(true);
    r.advanceTo(OPENED_AT + 1_900 + APPROVAL_LOCKOUT_MS);
    expect(r.card.lock.read()).toBe(false);
    // And the card's own answer agrees with what it says: the next deliberate press counts.
    expect(r.card.input('y', { ctrl: true }).kind).toBe('answered');
  });

  it('a budget gate: Ctrl+Y waits, its Abort never does', () => {
    const r = rig([BUDGET]);
    expect(r.legend()).toBe('[Ctrl+Y] Approve (wait) · [Ctrl+N] Abort · Esc leaves it pending');
    expect(r.card.input('n', { ctrl: true }).kind, 'an abort is never delayed').toBe('answered');
  });

  it('nothing is held once the card is no longer asking, and the lock is a display value: the snapshot is not touched', () => {
    const r = rig();
    const before = r.card.getSnapshot();
    r.advanceTo(OPENED_AT + APPROVAL_LOCKOUT_MS);
    expect(r.card.getSnapshot(), 'the lock opening made no new snapshot').toBe(before);
    expect(r.card.input('y', { ctrl: true }).kind).toBe('answered');
    expect(r.card.lock.read(), 'an answered card holds no key').toBe(false);
    r.card.dispose();
    expect(r.live()).toBe(0);
  });
});

describe('the card wears the sheet’s heavy rule, its wait clock on the right while it waits (ADR-0147 §1, §2)', () => {
  const snapshotOf = (phase: 'open' | 'answered') => ({
    runId: RUN,
    gates: phase === 'open' ? [APPROVAL] : [],
    cursor: 0,
    phase,
    notice: undefined,
    refused: false,
  });

  it('an open gate: `Waiting for you` and the host’s clock, the card’s width; no clock without one', () => {
    const at = (clock?: string) =>
      projectRunCard(snapshotOf('open'), { columns: 80, rows: 24, nowMs: 0, clock }).rows[0];
    expect(at('waiting 1h 07m')?.role).toBe('rule');
    expect(at('waiting 1h 07m')?.text).toMatch(/^━━ Waiting for you ━+ waiting 1h 07m ━━$/u);
    expect(at('waiting 1h 07m')?.text.length).toBe(78);
    expect(at()?.text).toMatch(/^━━ Waiting for you ━+$/u);
    // A tick never moves the card's rows: the rule is one row whatever the clock says.
    expect(
      projectRunCard(snapshotOf('open'), { columns: 80, rows: 24, nowMs: 0 }).rows,
    ).toHaveLength(
      projectRunCard(snapshotOf('open'), { columns: 80, rows: 24, nowMs: 0, clock: 'waiting 0:41' })
        .rows.length,
    );
  });

  it('a card that no longer asks draws no clock, whatever the host hands it', () => {
    const rule = projectRunCard(snapshotOf('answered'), {
      columns: 80,
      rows: 24,
      nowMs: 0,
      clock: 'waiting 0:41',
    }).rows[0];
    expect(rule?.text).toMatch(/^━━ Run gate ━+$/u);
  });
});
