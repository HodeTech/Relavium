/**
 * How a confirmation line goes away unanswered ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §8; MVP-11 step 4, review round 1), on the popup host with a generic line: every `Ctrl+Y` that does not count disarms the line AT ONCE
 * and the command is told the exact reason (`unseen`, `early`, `expired`, `typed`), the `Ctrl+Y` the frame or the opening guard dropped
 * included; a key typed over the line and a paste are told as `typed`, `Esc` and `Ctrl+C` are cancels and are not; the window is the `[d]`
 * family's ten seconds from the line's acknowledged frame, and when it runs out the host disarms the line itself, on one timer that never
 * outlives the line. The numbers are pinned by their literal values here, not by the constants they are built from.
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import type { PopupContent } from './frame-model.js';
import { createNotificationChannel, type Schedule } from './notifications.js';
import {
  CHORD_STEP_GUARD,
  CHORD_STEP_WINDOW_MS,
  createPopupHost,
  type ChordRefusal,
  type PopupContext,
} from './popup-host.js';
import type { PopupKey, PopupSpec, PopupStep } from './popup-reducer.js';

const CTRL_Y: PopupKey = { ctrl: true };
const ESC: PopupKey = { escape: true };
const ENTER: PopupKey = { return: true };
const DOWN: PopupKey = { downArrow: true };

const REPORT: PopupContent = {
  kind: 'report',
  lines: ['Sends one request to:', '  https://a.example', 'Nothing else.'],
};
const LIST: PopupStep = {
  name: 'Checks',
  content: { kind: 'list', rows: [{ id: 'a', label: 'alpha' }] },
  controls: [{ key: 'd', verb: 'arm' }],
};
const LINE: PopupStep = {
  name: 'Confirm',
  content: REPORT,
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
};
const spec = (line: Partial<PopupStep> = {}): PopupSpec => ({
  id: 'line',
  title: '/line',
  origin: 'chat',
  rail: 'path',
  steps: [LIST, { ...LINE, ...line }],
});

/** A manual clock whose timers run when time moves; `live` counts the ones still pending. A `dropTimers` rig schedules nothing that runs. */
function timers(dropTimers = false) {
  const pending: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  const schedule: Schedule = (run, ms) => {
    const timer = { at: now + ms, run, cancelled: dropTimers };
    pending.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return {
    schedule,
    now: () => now,
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const due = pending
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.run();
      }
      now = end;
    },
    live: () => pending.filter((timer) => !timer.cancelled).length,
  };
}

/**
 * A host with the line's popup open on its first step, appeared and settled (600 ms), its frame "on screen" unless hidden. `arm()` presses
 * `[d]` (the command moves to the line) and acknowledges the line's frame; it returns the time of that acknowledgement.
 */
function rig(options: { readonly line?: Partial<PopupStep>; readonly dropTimers?: boolean } = {}) {
  const time = timers(options.dropTimers === true);
  const notifications = createNotificationChannel({ schedule: time.schedule });
  const history = createChordHistory();
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    notifications,
    history,
    placement: 'overlay',
  });
  let painted = true;
  host.bindVisibility(() => painted);
  host.bindPageRows(() => 1);
  const chord = vi.fn();
  const refusals: ChordRefusal[] = [];
  const stepChanged = vi.fn();
  const opened = host.openForUser(spec(options.line), {
    chord,
    chordRefused: (_context, reason) => refusals.push(reason),
    stepChanged,
    control: (c, key) => {
      if (key === 'd') c.goToStep(1);
    },
  });
  if (!opened.opened) throw new Error('open');
  const context = opened.context;
  const show = (): void => host.shown(host.getSnapshot());
  show();
  time.advance(600);
  return {
    host,
    time,
    notifications,
    history,
    chord,
    refusals,
    stepChanged,
    context: (): PopupContext => context,
    show,
    hide: (): void => {
      painted = false;
    },
    reveal: (): void => {
      painted = true;
    },
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
    press: (input: string, key: PopupKey = {}): boolean => host.input(input, key),
    arm: (): number => {
      host.input('d', {});
      show();
      return time.now();
    },
  };
}

describe('the numbers, pinned by their values (ADR-0148 §3, §8)', () => {
  it('the guard is the approval’s: 800 ms dwell, 300 ms quiet gap, no typeahead layer, 2000 ms lockout; the window is ten seconds', () => {
    expect({ ...CHORD_STEP_GUARD }).toEqual({
      settleMs: 800,
      quietMs: 300,
      typeaheadMs: 0,
      lockoutMs: 2000,
    });
    expect(CHORD_STEP_WINDOW_MS).toBe(10_000);
  });

  it('a Ctrl+Y at exactly ten seconds from the acknowledged frame answers; one millisecond later the line is gone', () => {
    const at = rig();
    const ack = at.arm();
    at.time.advance(10_000);
    expect(at.time.now() - ack).toBe(10_000);
    at.press('y', CTRL_Y);
    expect(at.chord).toHaveBeenCalledOnce();

    const after = rig();
    after.arm();
    after.time.advance(10_001);
    expect(after.step()).toBe(0);
    after.press('y', CTRL_Y);
    expect(after.chord).not.toHaveBeenCalled();
    expect(after.refusals).toEqual(['expired']);
  });

  it('the dwell is 800 ms from the acknowledgement: 799 is refused, 800 answers', () => {
    const early = rig();
    early.arm();
    early.time.advance(799);
    early.press('y', CTRL_Y);
    expect(early.chord).not.toHaveBeenCalled();
    expect(early.refusals).toEqual(['early']);
    const exact = rig();
    exact.arm();
    exact.time.advance(800);
    exact.press('y', CTRL_Y);
    expect(exact.chord).toHaveBeenCalledOnce();
  });
});

describe('the exact reason of each refusal, and the line is gone at once (MVP-11 step 4 review)', () => {
  it('unseen: the line’s frame was never acknowledged', () => {
    const r = rig();
    r.press('d');
    r.time.advance(2000);
    r.press('y', CTRL_Y);
    expect(r.refusals).toEqual(['unseen']);
    expect(r.step()).toBe(0);
    expect(r.chord).not.toHaveBeenCalled();
  });

  it('unseen: the frame was not on screen when the key came (dropped), and the line goes at once', () => {
    const r = rig();
    r.arm();
    r.hide();
    r.time.advance(900);
    r.press('y', CTRL_Y);
    expect(r.refusals).toEqual(['unseen']);
    expect(r.step()).toBe(0);
    // It was still counted, and stamped: a resolution on the history.
    expect(r.history.lastResolvedAt).toBe(r.time.now());
  });

  it('unseen: the line was still being prepared', () => {
    const r = rig({ line: { content: { kind: 'loading', what: 'Reading' } } });
    r.arm();
    r.time.advance(900);
    r.press('y', CTRL_Y);
    expect(r.refusals).toEqual(['unseen']);
    expect(r.step()).toBe(0);
  });

  it('early: a guard layer refused it (the dwell, the quiet gap, the lockout)', () => {
    const dwell = rig();
    dwell.arm();
    dwell.time.advance(500);
    dwell.press('y', CTRL_Y);
    expect(dwell.refusals).toEqual(['early']);
    const quiet = rig();
    quiet.arm();
    quiet.time.advance(1000);
    quiet.press('', DOWN);
    quiet.show();
    quiet.time.advance(100);
    quiet.press('y', CTRL_Y);
    expect(quiet.refusals).toEqual(['early']);
  });

  it('expired: the key came after the window (a timer that has not run yet), and expired: the host’s own timer', () => {
    // A key that arrives before a late timer runs is judged by the key path itself.
    const late = rig({ dropTimers: true });
    late.arm();
    late.time.advance(10_001);
    expect(late.step()).toBe(1);
    late.press('y', CTRL_Y);
    expect(late.refusals).toEqual(['expired']);
    expect(late.step()).toBe(0);
    // The host's timer disarms a line nobody answered, and says so.
    const timed = rig();
    timed.arm();
    timed.time.advance(10_001);
    expect(timed.refusals).toEqual(['expired']);
    expect(timed.step()).toBe(0);
    expect(timed.stepChanged).toHaveBeenCalledWith(expect.anything(), 1, 0);
  });

  it('typed: a key that is not a navigation key was counted on the line before the Ctrl+Y (here one on a line with nothing to confirm)', () => {
    const r = rig({
      line: { content: { kind: 'empty', what: 'Nothing.', next: 'Esc goes back.' } },
    });
    r.arm();
    r.time.advance(600);
    r.press('y', CTRL_Y);
    // Nothing to confirm: the line stays, says nothing, and the key is counted.
    expect(r.step()).toBe(1);
    expect(r.refusals).toEqual([]);
    r.context().setContent(1, REPORT);
    r.show();
    r.time.advance(2500);
    r.press('y', CTRL_Y);
    expect(r.refusals).toEqual(['typed']);
    expect(r.chord).not.toHaveBeenCalled();
  });
});

describe('a Ctrl+Y the opening guard dropped disarms the line at once and says why (MVP-11 step 4 review)', () => {
  /** A popup that opens ON its line, as `/doctor --deep` and `/cost --release` do; `appearAt` is when its first frame is acknowledged. */
  function onTheLine() {
    const time = timers();
    const notifications = createNotificationChannel({ schedule: time.schedule });
    const host = createPopupHost({
      now: time.now,
      schedule: time.schedule,
      notifications,
      placement: 'overlay',
    });
    host.bindVisibility(() => true);
    const refusals: ChordRefusal[] = [];
    const chord = vi.fn();
    host.openForUser(
      { ...spec(), initialStep: 1 },
      {
        chord,
        chordRefused: (_context, reason) => refusals.push(reason),
        control: (c, key) => {
          if (key === 'd') c.goToStep(1);
        },
      },
    );
    return { host, time, refusals, chord, show: () => host.shown(host.getSnapshot()) };
  }

  it('75 ms after the popup appeared (its settle time): early, the line is gone, `[d]` re-arms it and a patient press answers', () => {
    const r = onTheLine();
    r.show();
    r.time.advance(75);
    r.host.input('y', CTRL_Y);
    expect(r.refusals).toEqual(['early']);
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(0);
    expect(r.chord).not.toHaveBeenCalled();
    // The lockout of that refused key passes, the line is armed again by a deliberate `[d]`, and a patient Ctrl+Y answers.
    r.time.advance(2000);
    r.host.input('d', {});
    r.show();
    r.time.advance(900);
    r.host.input('y', CTRL_Y);
    expect(r.chord).toHaveBeenCalledOnce();
  });

  it('before the popup’s first frame: unseen, the line is gone', () => {
    const r = onTheLine();
    r.host.input('y', CTRL_Y);
    expect(r.refusals).toEqual(['unseen']);
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(0);
  });
});

describe('a key typed over the line is told; the cancels are not (MVP-11 step 4 review)', () => {
  it.each([
    ['a letter', 'x', {}],
    ['Enter', '', ENTER],
    ['another chord', 'n', CTRL_Y],
    ['Backspace', '', { backspace: true }],
  ] as const)('%s disarms the line and is told as typed', (_name, input, key) => {
    const r = rig();
    r.arm();
    r.time.advance(900);
    r.press(input, key);
    expect(r.step()).toBe(0);
    expect(r.refusals).toEqual(['typed']);
    expect(r.chord).not.toHaveBeenCalled();
  });

  it('a paste disarms the line and is told as typed', () => {
    const r = rig();
    r.arm();
    r.time.advance(900);
    r.host.paste('\u0019');
    expect(r.step()).toBe(0);
    expect(r.refusals).toEqual(['typed']);
  });

  it.each([
    ['Esc', '', ESC],
    ['Ctrl+C', 'c', { ctrl: true }],
    ['the Ctrl+C byte', '\u0003', {}],
  ] as const)('%s disarms the line and says nothing (a cancel)', (_name, input, key) => {
    const r = rig();
    r.arm();
    r.time.advance(900);
    r.press(input, key);
    expect(r.step()).toBe(0);
    expect(r.host.getSnapshot().open).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  it('a line with nothing to confirm goes back on a typed key without a word (there was nothing to refuse)', () => {
    const r = rig({
      line: { content: { kind: 'empty', what: 'Nothing.', next: 'Esc goes back.' } },
    });
    r.arm();
    r.time.advance(900);
    r.press('x');
    expect(r.step()).toBe(0);
    expect(r.refusals).toEqual([]);
  });

  it('the navigation keys only move', () => {
    const r = rig();
    r.arm();
    r.time.advance(100);
    r.press('', DOWN);
    expect(r.step()).toBe(1);
    expect(r.refusals).toEqual([]);
  });
});

describe('the line’s expiry timer never outlives the line (MVP-11 step 4 review)', () => {
  it('one timer from the acknowledged frame, cleared by a new frame, a disarm, an answer, a step change, a close and dispose', () => {
    // A new frame (a scroll): the timer goes with the frame, and the next acknowledgement starts a new one.
    const frame = rig();
    expect(frame.time.live()).toBe(0);
    frame.arm();
    expect(frame.time.live()).toBe(1);
    frame.press('', DOWN);
    expect(frame.time.live()).toBe(0);
    frame.show();
    expect(frame.time.live()).toBe(1);
    // A disarm (Esc).
    frame.press('', ESC);
    expect(frame.time.live()).toBe(0);

    const answer = rig();
    answer.arm();
    answer.time.advance(900);
    answer.press('y', CTRL_Y);
    expect(answer.chord).toHaveBeenCalledOnce();
    expect(answer.time.live()).toBe(0);

    const moved = rig();
    moved.arm();
    moved.context().goToStep(0);
    expect(moved.time.live()).toBe(0);

    const closed = rig();
    closed.arm();
    closed.host.closeAll('command');
    expect(closed.time.live()).toBe(0);

    const disposed = rig();
    disposed.arm();
    disposed.host.dispose();
    expect(disposed.time.live()).toBe(0);

    // A line that offers nothing to answer, or that is still being prepared, runs none.
    const empty = rig({ line: { content: { kind: 'empty', what: 'x', next: 'y' } } });
    empty.arm();
    expect(empty.time.live()).toBe(0);
  });

  it('the window restarts at every acknowledged frame of the line: a re-measure at 9 s gives the line ten more', () => {
    const r = rig();
    r.arm();
    r.time.advance(9000);
    r.press('', DOWN);
    r.show();
    r.time.advance(9000);
    expect(r.step()).toBe(1);
    expect(r.refusals).toEqual([]);
    r.time.advance(1001);
    expect(r.step()).toBe(0);
    expect(r.refusals).toEqual(['expired']);
  });

  it('the line that expired never says [Ctrl+Y] again: the popup is back on the step it came from', () => {
    const r = rig();
    r.arm();
    r.time.advance(10_001);
    const frame = r.host.getSnapshot().frame;
    expect(frame?.stepIndex).toBe(0);
    expect(frame?.spec.steps[frame.stepIndex]?.chord).toBeUndefined();
  });
});
