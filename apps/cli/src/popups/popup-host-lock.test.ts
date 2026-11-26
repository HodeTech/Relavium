/**
 * The popup host's lock (`PopupHost.lock`; the maintainer's ruling of 2026-11-26 on ADR-0145 §3, MVP-11 step 6 round 1, O4): a guarded form's
 * `Enter` (`/mode` `auto`, `/models` to another provider) and a confirmation line's answer key read `(wait)`, dim, while the approval lockout
 * holds them, and plain at the unlock instant by ONE timer on the host's `schedule`; the lock is asked of the guard that decides (the form's
 * lockout from the answer before it, a line's from the evidence it was armed against) and ends exactly where that guard starts to answer; a
 * refused `Enter` moves the timer; a line that is disarmed, a popup that closes and a disposed host clear it; a step that holds nothing runs
 * none. It is not a snapshot field: the unlock publishes no frame, so the form's settle and the line's dwell are not restarted.
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordHistory, type ChordHistory } from '../render/tui/chord-guard.js';
import { legend, legendSpans } from '../render/tui/legend.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import type { PopupContent } from './frame-model.js';
import { createPopupHost, type PopupHandlers } from './popup-host.js';
import { popupLegend, type PopupKey, type PopupSpec, type PopupStep } from './popup-reducer.js';

const ENTER: PopupKey = { return: true };
const CTRL_Y: PopupKey = { ctrl: true };

/** The opening settle the rig waits out before its first answer (the host's 500 ms, and a little). */
const PAST_THE_OPENING_MS = 600;

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

const LIST: PopupStep = {
  name: 'Mode',
  content: { kind: 'list', rows: [{ id: 'auto', label: 'auto' }] },
  enter: 'choose',
};
const formStep = (guarded: boolean): PopupStep => ({
  name: 'Apply',
  content: {
    kind: 'form',
    summary: 'auto: every tool runs without asking',
    ...(guarded ? { guarded: true as const } : {}),
  },
  enter: 'apply',
  back: 0,
});
const REPORT: PopupContent = {
  kind: 'report',
  lines: ['Sends one request to:', '  https://a.example', 'Nothing else.'],
};
const LINE: PopupStep = {
  name: 'Confirm',
  content: REPORT,
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
};

/**
 * A host on a manual clock with its frame "on screen", the page and the width of a standard popup at 80×24, and what its lock heard. `ack` is the
 * slot's acknowledgement of the frame drawn now.
 */
function rig(spec: PopupSpec, history: ChordHistory = createChordHistory()) {
  const time = manualTimers();
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    history,
    placement: 'overlay',
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  const applied = vi.fn();
  const chord = vi.fn();
  const handlers: PopupHandlers = {
    enter: (context) => {
      context.goToStep(1);
    },
    apply: applied,
    chord,
  };
  const opened = host.openForUser(spec, handlers);
  if (!opened.opened) throw new Error('open');
  host.bindPageRows(() => 17);
  host.bindInnerWidth(() => 66);
  const heard: boolean[] = [];
  host.lock.subscribe(() => heard.push(host.lock.read()));
  let frames = 0;
  host.subscribe(() => {
    frames += 1;
  });
  const ack = (): void => host.shown(host.getSnapshot());
  ack();
  return {
    host,
    time,
    applied,
    chord,
    heard,
    ack,
    frames: (): number => frames,
    press: (input: string, key: PopupKey): boolean => host.input(input, key),
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
    /** The legend the slot draws for the frame now, with the host's lock. */
    legendText: (): string => {
      const frame = host.getSnapshot().frame;
      if (frame === undefined) return '';
      const parts = popupLegend(frame, 17, 66, host.lock.read());
      return legend(parts.items, parts.exit);
    },
  };
}

const formSpec = (guarded: boolean): PopupSpec => ({
  id: 'mode',
  title: '/mode',
  origin: 'chat',
  steps: [LIST, formStep(guarded)],
});

/** The guarded form reached by an `Enter` on the list at {@link PAST_THE_OPENING_MS}, its frame acknowledged then. */
function onTheForm(guarded = true) {
  const r = rig(formSpec(guarded));
  r.time.advance(PAST_THE_OPENING_MS);
  r.press('', ENTER);
  expect(r.step()).toBe(1);
  r.ack();
  return r;
}

describe('a guarded form: `Enter apply (wait)` from the Enter that reached it, for the lockout', () => {
  it('reads locked with ONE timer at the lockout’s end; its legend says so; at that instant it is open, heard once, no frame published', () => {
    const r = onTheForm();
    expect(r.host.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([PAST_THE_OPENING_MS + APPROVAL_LOCKOUT_MS]);
    expect(r.legendText()).toBe('Enter apply (wait) · [Ctrl+C] close · Esc back');
    const form = r.host.getSnapshot();
    const published = r.frames();
    r.time.advance(APPROVAL_LOCKOUT_MS - 1);
    expect(r.host.lock.read()).toBe(true);
    r.time.advance(1);
    expect(r.host.lock.read()).toBe(false);
    expect(r.heard).toEqual([true, false]);
    expect(r.time.due()).toEqual([]);
    expect(r.legendText()).toBe('Enter apply · [Ctrl+C] close · Esc back');
    expect(r.host.getSnapshot()).toBe(form);
    expect(r.frames()).toBe(published);
  });

  it('ends exactly where the form’s guard starts to apply: an Enter one millisecond before is refused, one at the instant applies', () => {
    const early = onTheForm();
    early.time.advance(APPROVAL_LOCKOUT_MS - 1);
    expect(early.host.lock.read()).toBe(true);
    early.press('', ENTER);
    expect(early.applied).not.toHaveBeenCalled();

    const exact = onTheForm();
    exact.time.advance(APPROVAL_LOCKOUT_MS);
    expect(exact.host.lock.read()).toBe(false);
    exact.press('', ENTER);
    expect(exact.applied).toHaveBeenCalledOnce();
  });

  it('a refused early Enter restarts the lockout: still locked, the one timer moved to the new instant, the part still waits', () => {
    const r = onTheForm();
    r.time.advance(1500);
    r.press('', ENTER);
    expect(r.applied).not.toHaveBeenCalled();
    expect(r.host.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([PAST_THE_OPENING_MS + 1500 + APPROVAL_LOCKOUT_MS]);
    expect(r.legendText()).toBe('Enter apply (wait) · [Ctrl+C] close · Esc back');
    r.time.advance(APPROVAL_LOCKOUT_MS);
    expect(r.host.lock.read()).toBe(false);
    r.press('', ENTER);
    expect(r.applied).toHaveBeenCalledOnce();
  });

  it('the waiting part is dim, its key too', () => {
    const r = onTheForm();
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no frame');
    const parts = popupLegend(frame, 17, 66, true);
    expect(legendSpans(parts.items, parts.exit)[0]).toEqual({ from: 0, to: 5, role: 'dim' });
  });

  it('going back (Esc) or closing clears it at once; a disposed host tells nobody again', () => {
    const back = onTheForm();
    back.press('', { escape: true });
    expect(back.step()).toBe(0);
    expect(back.host.lock.read()).toBe(false);
    expect(back.time.due()).toEqual([]);

    const closed = onTheForm();
    closed.host.closeAll('command');
    expect(closed.host.lock.read()).toBe(false);
    expect(closed.time.due()).toEqual([]);

    const disposed = onTheForm();
    disposed.host.dispose();
    expect(disposed.host.lock.read()).toBe(false);
    expect(disposed.time.due()).toEqual([]);
    expect(disposed.heard).toEqual([true, false]);
    disposed.time.advance(10_000);
    expect(disposed.heard).toEqual([true, false]);
  });
});

describe('a form that is not guarded, and a list, hold nothing', () => {
  it('a plain form reached by an Enter: never locked, no timer, `Enter apply` as it always was', () => {
    const r = onTheForm(false);
    expect(r.host.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
    expect(r.legendText()).toBe('Enter apply · [Ctrl+C] close · Esc back');
    expect(r.heard).toEqual([]);
  });

  it('even handed a lock, the legend marks only a guarded form’s Enter or a line’s answer', () => {
    const plainForm = onTheForm(false);
    const frame = plainForm.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no frame');
    expect(popupLegend(frame, 17, 66, true).items).toEqual([
      { keys: 'Enter', verb: 'apply' },
      {
        keys: 'Ctrl+C',
        verb: 'close',
      },
    ]);
    const list = rig(formSpec(true));
    const first = list.host.getSnapshot().frame;
    if (first === undefined) throw new Error('no frame');
    expect(popupLegend(first, 17, 66, true).items).not.toContainEqual(
      expect.objectContaining({ wait: true }),
    );
  });
});

describe('a confirmation line: its answer waits on the evidence it was armed against', () => {
  /** A popup that OPENS on its line (as `/doctor --deep`), the composer's last key stamped at `keyAt` and no resolution on the history. */
  function onTheLine(keyAt: number) {
    const history = createChordHistory();
    history.previousKeyAt = keyAt;
    const r = rig(
      { id: 'line', title: '/line', origin: 'chat', steps: [LIST, LINE], initialStep: 1 },
      history,
    );
    return { ...r, history };
  }

  it('locked until the lockout after the last key before it opened (the line’s own evidence, not the history’s resolutions), then its answer acts', () => {
    const r = onTheLine(0);
    expect(r.history.lastResolvedAt).toBe(Number.NEGATIVE_INFINITY);
    expect(r.host.lock.read()).toBe(true);
    expect(r.time.due()).toContain(APPROVAL_LOCKOUT_MS);
    expect(r.legendText()).toBe('[Ctrl+Y] send (wait) · Esc back');
    r.time.advance(APPROVAL_LOCKOUT_MS);
    expect(r.host.lock.read()).toBe(false);
    expect(r.legendText()).toBe('[Ctrl+Y] send · Esc back');
    r.press('y', CTRL_Y);
    expect(r.chord).toHaveBeenCalledOnce();
  });

  it('a refused early Ctrl+Y disarms the line: the lock and its timer go with it', () => {
    const r = onTheLine(0);
    r.time.advance(1000);
    r.press('y', CTRL_Y);
    expect(r.step()).toBe(0);
    expect(r.chord).not.toHaveBeenCalled();
    expect(r.host.lock.read()).toBe(false);
    expect(r.time.due()).not.toContain(APPROVAL_LOCKOUT_MS);
  });
});
