/**
 * The guarded wait is visible (the maintainer's ruling of 2026-11-26 on ADR-0145 §3, MVP-11 step 6 round 1, O4): while a key is locked by its
 * guard's 2 s lockout its legend part is drawn dim with `(wait)`, and once the lock opens it is drawn plain again, with ONE repaint at that
 * instant and nothing that ticks. This file pins the three pure parts every surface shares: the legend builder's `wait` item, the guard's
 * `lockedUntil` (the lockout rule read without a key, never a second copy of it) and the lock display with its one timer.
 */
import { describe, expect, it } from 'vitest';

import {
  createChordGuard,
  createChordHistory,
  createLockDisplay,
  type ChordStamp,
} from './chord-guard.js';
import {
  LEGEND_WAIT,
  exitKey,
  fitLegend,
  keyHint,
  legend,
  legendItems,
  legendSpans,
  type LegendItem,
} from './legend.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

const columnsOf = (text: string): number => [...text].length;

/** A manual clock whose one-shot timers run when time moves; `due` lists the instants of the timers still pending. */
function manualTimers() {
  const pending: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  return {
    now: (): number => now,
    schedule: (run: () => void, ms: number): (() => void) => {
      const timer = { at: now + ms, run, cancelled: false };
      pending.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const next = pending
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        next.cancelled = true;
        now = next.at;
        next.run();
      }
      now = end;
    },
    due: (): readonly number[] =>
      pending.filter((timer) => !timer.cancelled).map((timer) => timer.at),
  };
}

describe('the legend builder: a key that waits (LegendKey.wait)', () => {
  const allow: LegendItem = { keys: 'Ctrl+Y', verb: 'Create them', role: 'ok' };
  const deny: LegendItem = { keys: 'Ctrl+N', verb: 'Create nothing', role: 'danger' };

  it('the word is `(wait)`, one fixed word and never a time', () => {
    expect(LEGEND_WAIT).toBe('(wait)');
  });

  it('a waiting key reads `[Ctrl+Y] Create them (wait)` in the same text, and the rest of the legend is unchanged', () => {
    const waiting = legend([{ ...allow, wait: true }, deny], exitKey.decide('denies'));
    expect(waiting).toBe('[Ctrl+Y] Create them (wait) · [Ctrl+N] Create nothing · Esc denies');
    expect(legend([allow, deny], exitKey.decide('denies'))).toBe(
      '[Ctrl+Y] Create them · [Ctrl+N] Create nothing · Esc denies',
    );
    // Its plain text is seven columns longer: a fit must count them.
    expect(columnsOf(waiting) - columnsOf(legend([allow, deny], exitKey.decide('denies')))).toBe(7);
  });

  it('the whole waiting part is dim, its key too; a key that acts keeps its role', () => {
    const items = [{ ...allow, wait: true as const }, deny];
    const text = legend(items, exitKey.decide('denies'));
    const spans = legendSpans(items, exitKey.decide('denies'));
    const at = (from: number) => spans.find((span) => span.from === from);
    // `[Ctrl+Y]` dim, then ` Create them (wait)` dim, ending exactly before the separator.
    expect(at(0)).toEqual({ from: 0, to: 8, role: 'dim' });
    expect(at(8)).toEqual({ from: 8, to: '[Ctrl+Y] Create them (wait)'.length, role: 'dim' });
    // The refusal that acts now is drawn as it always was.
    const denyAt = text.indexOf('[Ctrl+N]');
    expect(at(denyAt)).toEqual({ from: denyAt, to: denyAt + 8, role: 'danger' });
    // The spans still cover the text once, in order.
    let end = 0;
    for (const span of spans) {
      expect(span.from).toBe(end);
      end = span.to;
    }
    expect(end).toBe(text.length);
  });

  it('a hint and an answer row draw it by the same rule (the card’s `[Ctrl+Y]` row is built here)', () => {
    expect(keyHint([{ keys: 'Ctrl+Y', verb: 'Allow', wait: true }])).toBe('[Ctrl+Y] Allow (wait)');
    expect(legendItems([{ keys: 'Enter', verb: 'choose', wait: true }]).spans).toEqual([
      { from: 0, to: 5, role: 'dim' },
      { from: 5, to: ' choose (wait)'.length + 5, role: 'dim' },
    ]);
  });

  it('a label that says `(wait)` is an ordinary label: nothing reads the state from a text', () => {
    // A forged label on a key that acts now: drawn in its role, never as a waiting part, and given no second `(wait)`.
    const forged: LegendItem = { keys: 'Ctrl+Y', verb: 'Allow (wait)', role: 'ok' };
    expect(keyHint([forged])).toBe('[Ctrl+Y] Allow (wait)');
    expect(legendItems([forged]).spans[0]).toEqual({ from: 0, to: 8, role: 'ok' });
    // And a waiting key whose label says it already gets the state's own word after it (the state is the flag, not the text).
    expect(keyHint([{ ...forged, wait: true }])).toBe('[Ctrl+Y] Allow (wait) (wait)');
  });

  it('fitLegend counts the seven columns: a legend that fits plain drops an item while its key waits', () => {
    const exit = exitKey.decide('denies');
    const plain = legend([allow, deny], exit);
    const columns = columnsOf(plain);
    const kept = (wait: boolean) =>
      fitLegend(
        [],
        [
          { item: wait ? { ...allow, wait: true } : allow, priority: 2 },
          { item: deny, priority: 1 },
        ],
        exit,
        columns,
        columnsOf,
      );
    expect(kept(false)).toHaveLength(2);
    expect(kept(true)).toEqual([{ ...allow, wait: true }]);
  });
});

describe('ChordGuard.lockedUntil: the lockout rule read without a key', () => {
  const NUMBERS = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: APPROVAL_LOCKOUT_MS };
  const stamp = (now: number, lastResolvedAt: number): ChordStamp => ({
    now,
    previousKeyAt: Number.NEGATIVE_INFINITY,
    lastForeignKeyAt: Number.NEGATIVE_INFINITY,
    lastResolvedAt,
  });

  it('is the lockout after the evidence’s last resolution: `decide` refuses one millisecond before it and answers at it', () => {
    const history = createChordHistory();
    history.lastResolvedAt = 1000;
    const guard = createChordGuard({ now: () => 0, guard: NUMBERS, history });
    const until = guard.lockedUntil();
    expect(until).toBe(1000 + APPROVAL_LOCKOUT_MS);
    // The same rule `decide` applies: a separate guard per probe, so the refused one (which restarts the lockout) does not move the other.
    const refused = createChordGuard({ now: () => 0, guard: NUMBERS });
    expect(refused.decide(stamp(until - 1, 1000), 'allow', true)).toBeUndefined();
    const answered = createChordGuard({ now: () => 0, guard: NUMBERS });
    expect(answered.decide(stamp(until, 1000), 'allow', true)).toBe('allow');
  });

  it('reads the evidence it is handed (a line armed against an earlier resolution), else the history now', () => {
    const history = createChordHistory();
    history.lastResolvedAt = 5000;
    const guard = createChordGuard({ now: () => 0, guard: NUMBERS, history });
    expect(guard.lockedUntil({ lastResolvedAt: 300 })).toBe(300 + APPROVAL_LOCKOUT_MS);
    expect(guard.lockedUntil()).toBe(5000 + APPROVAL_LOCKOUT_MS);
    // A refused press inside the lockout restarts it on the history, and the lock moves with it.
    guard.decide(stamp(5500, 5000), 'allow', false);
    expect(guard.lockedUntil()).toBe(5500 + APPROVAL_LOCKOUT_MS);
  });

  it('a guard with no lockout locks nothing, and no resolution yet locks nothing', () => {
    expect(
      createChordGuard({ now: () => 0, guard: { ...NUMBERS, lockoutMs: 0 } }).lockedUntil(),
    ).toBe(Number.NEGATIVE_INFINITY);
    expect(createChordGuard({ now: () => 0, guard: NUMBERS }).lockedUntil()).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});

describe('createLockDisplay: whether it is locked now, and one timer at the unlock instant', () => {
  function rig(initialUntil: number) {
    const time = manualTimers();
    let until = initialUntil;
    const lock = createLockDisplay({ now: time.now, schedule: time.schedule, until: () => until });
    const heard: boolean[] = [];
    lock.subscribe(() => heard.push(lock.read()));
    return {
      time,
      lock,
      heard,
      setUntil: (next: number): void => {
        until = next;
      },
    };
  }

  it('locked until the instant, then open, with ONE timer and one change heard; nothing in between', () => {
    const r = rig(2000);
    r.lock.sync();
    expect(r.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([2000]);
    expect(r.heard).toEqual([true]);
    // A sync with nothing changed keeps the one timer and says nothing.
    r.time.advance(1999);
    r.lock.sync();
    expect(r.time.due()).toEqual([2000]);
    expect(r.heard).toEqual([true]);
    r.time.advance(1);
    expect(r.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
    expect(r.heard).toEqual([true, false]);
  });

  it('a later end (a refused press restarted the lockout) moves the one timer; the part stays locked', () => {
    const r = rig(2000);
    r.lock.sync();
    r.time.advance(1500);
    r.setUntil(3500);
    r.lock.sync();
    expect(r.time.due()).toEqual([3500]);
    r.time.advance(500);
    expect(r.lock.read()).toBe(true);
    r.time.advance(1500);
    expect(r.lock.read()).toBe(false);
    expect(r.heard).toEqual([true, false]);
  });

  it('an end that has passed, or none, runs no timer at all', () => {
    const r = rig(Number.NEGATIVE_INFINITY);
    r.lock.sync();
    expect(r.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
    const past = rig(0);
    past.lock.sync();
    expect(past.lock.read()).toBe(false);
    expect(past.time.due()).toEqual([]);
    expect(past.heard).toEqual([]);
  });

  it('what held it went (the prompt settled): the timer goes at once and the change is heard', () => {
    const r = rig(2000);
    r.lock.sync();
    r.time.advance(300);
    r.setUntil(Number.NEGATIVE_INFINITY);
    r.lock.sync();
    expect(r.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
    expect(r.heard).toEqual([true, false]);
  });

  it('a timer that fires before the instant on the guard’s clock leaves it locked and sets one more at the instant', () => {
    const time = manualTimers();
    // A schedule that runs its callback 600 ms early, as a coarse timer on another clock could.
    const early = (run: () => void, ms: number) => time.schedule(run, Math.max(1, ms - 600));
    const lock = createLockDisplay({ now: time.now, schedule: early, until: () => 2000 });
    lock.sync();
    time.advance(1400);
    expect(lock.read()).toBe(true);
    expect(time.due()).toEqual([1400 + 1]);
    time.advance(600);
    expect(lock.read()).toBe(false);
  });

  it('dispose: the timer is cleared, nobody is told again, and a later sync does nothing', () => {
    const r = rig(2000);
    r.lock.sync();
    r.lock.dispose();
    expect(r.time.due()).toEqual([]);
    r.setUntil(9000);
    r.lock.sync();
    r.time.advance(10_000);
    expect(r.time.due()).toEqual([]);
    expect(r.heard).toEqual([true]);
  });
});
