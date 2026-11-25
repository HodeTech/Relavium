/**
 * The whole line, or no answer ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8;
 * MVP-11 step 4, review round 2, security F1): a confirmation line names what leaves and to whom, so the HOST answers it only while every one of
 * its lines is on the page its frame is drawn on. Inline a page is ten rows, so a line of 11 to 17 rows was drawn cut (`▼ N more`), acknowledged
 * and answerable with origins never on screen. The rule is the host's, for every chord step (`/doctor`'s and `/cost`'s alike): a line cut short
 * offers nothing (its legend names no `Ctrl+Y`, a `Ctrl+Y` is a refused affirmative that leaves it, the channel is not held), and a line that
 * offered its answer and is cut on a new frame (a smaller page) is disarmed at once and told as `cut`.
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { legend } from '../render/tui/legend.js';
import { createNotificationChannel, type Schedule } from './notifications.js';
import { createPopupHost, type ChordRefusal, type PopupContext } from './popup-host.js';
import {
  lineFitsPage,
  openFrame,
  popupLegend,
  type PopupKey,
  type PopupSpec,
  type PopupStep,
} from './popup-reducer.js';

const CTRL_Y: PopupKey = { ctrl: true };

const linesOf = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `  https://origin-${String(index)}.example`);

const LIST: PopupStep = {
  name: 'Checks',
  content: { kind: 'list', rows: [{ id: 'a', label: 'alpha' }] },
  controls: [{ key: 'd', verb: 'arm' }],
};
const line = (count: number): PopupStep => ({
  name: 'Confirm',
  content: { kind: 'report', lines: linesOf(count) },
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
});
const spec = (count: number, initialStep = 1): PopupSpec => ({
  id: 'fit',
  title: '/fit',
  origin: 'chat',
  rail: 'path',
  steps: [LIST, line(count)],
  initialStep,
});

function timers() {
  const pending: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  const schedule: Schedule = (run, ms) => {
    const timer = { at: now + ms, run, cancelled: false };
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
  };
}

/** A host whose page is `page` rows (what the slot binds from its geometry), the line's popup open on it and its first frame acknowledged. */
function rig(count: number, page: number) {
  const time = timers();
  const notifications = createNotificationChannel({ schedule: time.schedule });
  const history = createChordHistory();
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    notifications,
    history,
    placement: 'replace',
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  let rows = page;
  host.bindPageRows(() => rows);
  const chord = vi.fn();
  const refusals: ChordRefusal[] = [];
  const opened = host.openForUser(spec(count), {
    chord,
    chordRefused: (_context, reason) => refusals.push(reason),
    control: (context, key) => {
      if (key === 'd') context.goToStep(1);
    },
  });
  if (!opened.opened) throw new Error('open');
  const show = (): void => host.shown(host.getSnapshot());
  show();
  return {
    host,
    time,
    notifications,
    history,
    chord,
    refusals,
    show,
    context: (): PopupContext => opened.context,
    setPage: (next: number): void => {
      rows = next;
    },
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
  };
}

/** Past the dwell, the quiet gap and the lockout of anything before: a deliberate press. */
const PATIENT_MS = 2600;

describe('the one predicate (`lineFitsPage`)', () => {
  it('a report of at least one line and no more lines than the page, and nothing else', () => {
    expect(lineFitsPage({ kind: 'report', lines: linesOf(10) }, 10)).toBe(true);
    expect(lineFitsPage({ kind: 'report', lines: linesOf(11) }, 10)).toBe(false);
    expect(lineFitsPage({ kind: 'report', lines: linesOf(1) }, 1)).toBe(true);
    expect(lineFitsPage({ kind: 'report', lines: [] }, 10)).toBe(false);
    expect(lineFitsPage({ kind: 'report', lines: linesOf(1) }, 0)).toBe(false);
    expect(lineFitsPage({ kind: 'empty', what: 'x', next: 'y' }, 10)).toBe(false);
    expect(lineFitsPage({ kind: 'loading', what: 'x' }, 10)).toBe(false);
  });
});

describe('a line cut short offers nothing, on any page (the inline page is ten rows)', () => {
  it.each([11, 14, 17])(
    'a line of %i rows on a page of 10: Ctrl+Y is refused, nothing is answered, the line stays and says nothing',
    (count) => {
      const r = rig(count, 10);
      r.time.advance(PATIENT_MS);
      r.host.input('y', CTRL_Y);
      expect(r.chord).not.toHaveBeenCalled();
      expect(r.refusals).toEqual([]);
      expect(r.step()).toBe(1);
      // A refused affirmative on the shared history, as any Ctrl+Y that answers nothing.
      expect(r.history.lastResolvedAt).toBe(r.time.now());
    },
  );

  it.each([
    [10, 10],
    [17, 17],
    [3, 18],
  ])(
    'a line of %i rows on a page of %i (it fits whole, the page exactly included) is answered',
    (count, page) => {
      const r = rig(count, page);
      r.time.advance(PATIENT_MS);
      r.host.input('y', CTRL_Y);
      expect(r.chord).toHaveBeenCalledOnce();
    },
  );

  it('one row more than the page is cut: 18 rows on a page of 17 take no answer', () => {
    const r = rig(18, 17);
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).not.toHaveBeenCalled();
  });

  it('a line that says nothing (a report of no line) takes no answer either', () => {
    const r = rig(0, 10);
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).not.toHaveBeenCalled();
  });

  it('its legend names no Ctrl+Y on the page it is drawn on, and names it where it fits', () => {
    const frame = { ...openFrame(spec(14), 1), stepIndex: 1 };
    const cut = popupLegend(frame, 10);
    expect(legend(cut.items, cut.exit)).toBe('Esc back');
    const whole = popupLegend(frame, 14);
    expect(legend(whole.items, whole.exit)).toBe('[Ctrl+Y] send · Esc back');
  });

  it('does not hold the notification channel (it offers no answer); a line that fits does', () => {
    const cut = rig(14, 10);
    cut.notifications.notify('a note');
    expect(cut.notifications.getSnapshot().current?.text).toBe('a note');
    const whole = rig(4, 10);
    whole.notifications.notify('a note');
    expect(whole.notifications.getSnapshot().current).toBeUndefined();
    expect(whole.notifications.getSnapshot().queued).toBe(1);
  });

  it('runs no expiry timer: the line that cannot be answered is never "expired"', () => {
    const r = rig(14, 10);
    r.time.advance(20_000);
    expect(r.refusals).toEqual([]);
    expect(r.step()).toBe(1);
  });
});

describe('a line that offered its answer and is cut on a new frame is disarmed at once, and told as `cut`', () => {
  it('a resize that makes the page smaller: the first frame at the new size disarms it', () => {
    const r = rig(14, 17);
    r.time.advance(300);
    // The resize: the host is told (the line's dwell restarts), then the frame at the new size is drawn on a page of ten and acknowledged.
    r.host.resized(100, 30);
    r.setPage(10);
    r.show();
    expect(r.step()).toBe(0);
    expect(r.refusals).toEqual(['cut']);
    expect(r.chord).not.toHaveBeenCalled();
    // `[d]` asks again on the small page: the line comes back cut and offers nothing.
    r.time.advance(PATIENT_MS);
    r.host.input('d', {});
    r.show();
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).not.toHaveBeenCalled();
    expect(r.step()).toBe(1);
  });

  it('a Ctrl+Y between the resize and the new frame is no answer either (the frame is not acknowledged)', () => {
    const r = rig(14, 17);
    r.time.advance(PATIENT_MS);
    r.host.resized(100, 30);
    r.setPage(10);
    r.host.input('y', CTRL_Y);
    expect(r.chord).not.toHaveBeenCalled();
  });

  it('a page that grows under a line that was cut makes it answerable from its next acknowledged frame', () => {
    const r = rig(14, 10);
    r.time.advance(300);
    r.setPage(17);
    r.show();
    expect(r.refusals).toEqual([]);
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).toHaveBeenCalledOnce();
  });

  it('a line that never offered its answer is not told as cut (the command already says why)', () => {
    const r = rig(14, 10);
    r.show();
    r.show();
    expect(r.refusals).toEqual([]);
    expect(r.step()).toBe(1);
  });
});
