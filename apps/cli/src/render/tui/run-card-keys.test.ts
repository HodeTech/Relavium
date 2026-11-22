/**
 * The human-gate card's keys
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4): only a Ctrl chord answers; a bare
 * letter, a paste, `Esc` and `Ctrl+C` decide nothing; and an affirmative chord passes dwell, quiet gap, typeahead and lockout and needs
 * its exact frame painted.
 *
 * The card runs on an injected monotonic clock, so every guard is measured in exact milliseconds. Each timing rule is tested with the
 * OTHER layers switched off (`0` switches a layer off), so a test names one rule and fails when that rule, and only that rule, stops
 * holding.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RunGate } from '../../home/run-gates.js';
import type { HostedLaunch } from '../../home/run-host.js';
import { flush } from './harness-util.js';
import type { ChatKey } from './chat-input.js';
import { createRunCard, type RunCard } from './run-card-model.js';
import type { ApprovalGuard } from './tool-review-model.js';

const RUN = 'run-0001';
const OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };
const only = (layer: keyof Omit<ApprovalGuard, 'confirmAlways'>, ms: number): ApprovalGuard => ({
  ...OFF,
  [layer]: ms,
});
const CTRL: ChatKey = { ctrl: true };

function gate(id: string, over: Partial<RunGate> = {}): RunGate {
  return {
    runId: RUN,
    gateId: id,
    nodeId: `node-${id}`,
    gateType: 'approval',
    message: `Approve ${id}?`,
    accepts: ['approved', 'rejected'],
    ...over,
  };
}

const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

function fixture(guard: ApprovalGuard, gates: readonly RunGate[] = [gate('a')]) {
  let now = 0;
  let painted = true;
  const resume = vi.fn(() => Promise.resolve(STARTED));
  const card: RunCard = createRunCard({
    runId: RUN,
    gates,
    resume,
    now: () => now,
    guard,
    painted: () => painted,
  });
  return {
    card,
    resume,
    at: (ms: number): void => {
      now = ms;
    },
    paint: (visible: boolean): void => {
      painted = visible;
    },
    /** The host acknowledged the card's current frame. */
    show: (): void => card.shown(card.getSnapshot()),
    chord: (letter: 'y' | 'n') => card.input(letter, CTRL),
  };
}

describe('only a Ctrl chord answers', () => {
  it('Ctrl+Y approves and Ctrl+N rejects once the card is painted and has settled', async () => {
    const f = fixture({ settleMs: 100, quietMs: 50, typeaheadMs: 50, lockoutMs: 50 });
    f.at(0);
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered', decision: { decision: 'approved' } });
    await flush();
    expect(f.resume).toHaveBeenCalledOnce();
  });

  it.each(['y', 'Y', 'n', 'N', ' ', 'a', '1', 'yes'])(
    'a bare %j answers nothing, whatever the timing, and the card stays answerable',
    (letter) => {
      const f = fixture(OFF);
      f.show();
      f.at(10_000);
      expect(f.card.input(letter, {})).toEqual({ kind: 'ignored' });
      expect(f.card.input(letter, { shift: true })).toEqual({ kind: 'ignored' });
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.card.getSnapshot().phase).toBe('open');
      expect(f.chord('y')).toMatchObject({ kind: 'answered' });
    },
  );

  it('Enter, Tab, Backspace, PgUp/PgDn, Home/End and the side arrows answer nothing', () => {
    const f = fixture(OFF);
    f.show();
    for (const key of [
      { return: true },
      { tab: true },
      { backspace: true },
      { delete: true },
      { pageUp: true },
      { pageDown: true },
      { home: true },
      { end: true },
      { leftArrow: true },
      { rightArrow: true },
    ] satisfies ChatKey[])
      expect(f.card.input('', key)).toEqual({ kind: 'ignored' });
    expect(f.resume).not.toHaveBeenCalled();
  });

  it('a Ctrl chord for any other letter, a chord with meta, and a letter that is not the whole input answer nothing', () => {
    const f = fixture(OFF);
    f.show();
    for (const letter of ['a', 'g', 'o', 'z', 'd', 'u'])
      expect(f.card.input(letter, CTRL)).toEqual({ kind: 'ignored' });
    expect(f.card.input('y', { ctrl: true, meta: true })).toEqual({ kind: 'ignored' });
    expect(f.card.input('n', { meta: true })).toEqual({ kind: 'ignored' });
    expect(f.card.input('yy', CTRL)).toEqual({ kind: 'ignored' });
    expect(f.card.input('y\n', CTRL)).toEqual({ kind: 'ignored' });
    expect(f.card.input('\x19', CTRL)).toEqual({ kind: 'ignored' });
    expect(f.resume).not.toHaveBeenCalled();
  });

  it('a paste answers nothing, even one that is exactly a chord letter, and counts as typing for the guard', () => {
    const f = fixture(only('typeaheadMs', 400));
    f.show();
    f.at(1_000);
    f.card.paste('y');
    f.card.paste('\x19');
    f.card.paste('approve\n');
    expect(f.resume).not.toHaveBeenCalled();
    f.at(1_300);
    expect(f.chord('y'), 'a chord soon after a paste is refused').toEqual({ kind: 'refused' });
    f.at(2_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });
});

describe('Esc and Ctrl+C decide nothing', () => {
  it('Esc leaves the card exactly as it was: nothing is approved, nothing is rejected, nothing is sent', () => {
    const f = fixture(OFF, [gate('a'), gate('b')]);
    f.show();
    f.at(5_000);
    const before = f.card.getSnapshot();
    expect(f.card.input('', { escape: true })).toEqual({ kind: 'ignored' });
    expect(f.card.input('\x1b', { escape: true })).toEqual({ kind: 'ignored' });
    expect(f.card.input('', { escape: true, ctrl: true })).toEqual({ kind: 'ignored' });
    expect(f.resume, 'Esc is not a decision').not.toHaveBeenCalled();
    expect(f.card.getSnapshot(), 'the card is as it was: same frame, same gates, still open').toBe(
      before,
    );
    expect(before.gates.map((entry) => entry.gateId)).toEqual(['a', 'b']);
    expect(before.phase).toBe('open');
  });

  it('Ctrl+C leaves the card as it was too: it is the view`s interrupt, never an answer', () => {
    const f = fixture(OFF, [gate('a'), gate('b')]);
    f.show();
    const before = f.card.getSnapshot();
    expect(f.card.input('c', CTRL)).toEqual({ kind: 'ignored' });
    expect(f.card.input('C', CTRL)).toEqual({ kind: 'ignored' });
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.card.getSnapshot()).toBe(before);
  });

  it('neither is a way round a guard: an Esc just before a chord is typing, so the chord is refused', () => {
    const f = fixture(only('typeaheadMs', 400));
    f.show();
    f.at(1_000);
    f.card.input('', { escape: true });
    f.at(1_100);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(1_600);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });
});

describe('the dwell, the quiet gap, the typeahead and the lockout', () => {
  it('dwell: Ctrl+Y counts only after the exact frame was shown and has stayed for the dwell', () => {
    const f = fixture(only('settleMs', 500));
    f.at(0);
    expect(f.chord('y'), 'never shown').toEqual({ kind: 'refused' });
    f.at(100);
    f.show();
    f.at(599);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(600);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('dwell: a frame that is not the card`s current one starts no dwell', () => {
    const f = fixture(only('settleMs', 500), [gate('a'), gate('b')]);
    const stale = f.card.getSnapshot();
    f.card.input('', { downArrow: true });
    f.at(100);
    f.card.shown(stale);
    f.at(10_000);
    expect(f.chord('y'), 'the stale frame was not the one on screen').toEqual({ kind: 'refused' });
    f.show();
    f.at(10_500);
    expect(f.chord('y')).toMatchObject({ kind: 'answered', gateId: 'b' });
  });

  it('dwell: a different gate under the cursor is a new frame, and its dwell restarts', () => {
    const f = fixture(only('settleMs', 500), [gate('a'), gate('b')]);
    f.at(0);
    f.show();
    f.at(1_000);
    f.card.input('', { downArrow: true });
    f.at(1_100);
    expect(f.chord('y'), 'the gate under the cursor changed a moment ago').toEqual({
      kind: 'refused',
    });
    f.show();
    f.at(1_599);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(1_600);
    expect(f.chord('y')).toMatchObject({ kind: 'answered', gateId: 'b' });
  });

  it('quiet gap: the previous key of any kind must be at least the gap old', () => {
    const f = fixture(only('quietMs', 300));
    f.show();
    f.at(1_000);
    f.card.input('', { shift: true }); // any key
    f.at(1_299);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(1_900);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('typeahead: a key the card has no use for, just before, makes the chord refuse', () => {
    const f = fixture(only('typeaheadMs', 400));
    f.show();
    f.at(1_000);
    f.card.input('x', {});
    f.at(1_399);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(1_800);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('typeahead: a key that reached the host while the frame could not take it is typing too', () => {
    const f = fixture(only('typeaheadMs', 400));
    f.show();
    f.at(1_000);
    f.card.unseenInput();
    f.at(1_200);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(1_700);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('lockout: the gate after an answered one refuses a held or double-tapped chord, and the window restarts with every refusal', async () => {
    const f = fixture(only('lockoutMs', 700), [gate('a'), gate('b')]);
    f.show();
    f.at(1_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered', gateId: 'a' });
    await flush();
    // The run parked again at the next gate: the host reads it and the card opens on it.
    f.at(1_300);
    f.card.update([gate('b')]);
    expect(f.chord('y'), 'a key held down').toEqual({ kind: 'refused' });
    f.at(1_900); // 600 ms after the refused repeat: still inside the restarted window
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(2_700); // 800 ms after the last refusal: the key was let go
    expect(f.chord('y')).toMatchObject({ kind: 'answered', gateId: 'b' });
  });

  it('lockout: a rejection also locks the next affirmative chord out', async () => {
    const f = fixture(only('lockoutMs', 700), [gate('a'), gate('b')]);
    f.show();
    f.at(1_000);
    expect(f.chord('n')).toMatchObject({ kind: 'answered', gateId: 'a' });
    await flush();
    f.at(1_100);
    f.card.update([gate('b')]);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(2_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered', gateId: 'b' });
  });

  it('a rejection is never delayed by a layer: it answers unpainted, unshown, mid-typing and inside the lockout', () => {
    const f = fixture({ settleMs: 5_000, quietMs: 5_000, typeaheadMs: 5_000, lockoutMs: 5_000 });
    f.paint(false);
    f.at(10);
    f.card.input('x', {});
    f.at(20);
    expect(f.chord('n')).toMatchObject({ kind: 'answered', decision: { decision: 'rejected' } });
  });
});

describe('an unpainted frame refuses', () => {
  it('Ctrl+Y answers nothing until this exact frame is painted, with every timing layer clear', () => {
    const f = fixture(OFF);
    f.paint(false);
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.card.getSnapshot().phase, 'a refusal changes nothing').toBe('open');
    f.paint(true);
    f.at(20_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('a host that never says a frame is painted can never approve (the default)', () => {
    const resume = vi.fn(() => Promise.resolve(STARTED));
    const card = createRunCard({ runId: RUN, gates: [gate('a')], resume, guard: OFF });
    card.shown(card.getSnapshot());
    expect(card.input('y', CTRL)).toEqual({ kind: 'refused' });
    expect(resume).not.toHaveBeenCalled();
    expect(card.input('n', CTRL), 'a rejection needs no painted frame').toMatchObject({
      kind: 'answered',
    });
  });

  it('asks the host about the very snapshot the chord is judged against', () => {
    const seen: unknown[] = [];
    const resume = vi.fn(() => Promise.resolve(STARTED));
    const card = createRunCard({
      runId: RUN,
      gates: [gate('a')],
      resume,
      guard: OFF,
      painted: (snapshot) => {
        seen.push(snapshot);
        return true;
      },
    });
    const frame = card.getSnapshot();
    card.shown(frame);
    card.input('y', CTRL);
    expect(seen).toEqual([frame]);
  });
});
