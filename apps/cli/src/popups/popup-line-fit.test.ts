/**
 * The whole line, or no answer ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8;
 * MVP-11 step 4, review round 2, security F1): a confirmation line names what leaves and to whom, so the HOST answers it only while every one of
 * its lines is on the page its frame is drawn on. Inline a page is ten rows, so a line of 11 to 17 rows was drawn cut (`▼ N more`), acknowledged
 * and answerable with origins never on screen. The rule is the host's, for every chord step (`/doctor`'s and `/cost`'s alike): a line cut short
 * offers nothing (its legend names no `Ctrl+Y`, a `Ctrl+Y` is a refused affirmative that leaves it, the channel is not held), and a line that
 * offered its answer and is cut on a new frame (a smaller page) is disarmed at once and told as `cut`.
 *
 * Round 3 (security L2): the rule counted LINES, while the frame cuts each line to the inner width (`…`): a line with one row wider than the
 * popup was drawn ending in `…` and still answered. A row must also be whole, as drawn: a line with a row wider than the page's inner width
 * offers nothing exactly like a line with too many rows, and a page that becomes narrower under a line that offered its answer disarms it as
 * `cut`. The rigs bind the page AFTER the popup opened, as the slot does (it binds it when the popup's first frame is rendered).
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
import { framePage } from './popup-slot.js';
import { popupGeometry } from './geometry.js';

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

/** The inner width of a standard popup at 80×24 (68 columns less a column of margin on each side). */
const FLOOR_WIDTH = 66;

/**
 * A host whose page is `page` rows of `width` columns (what the slot binds from its geometry), the popup `opened` on it (default: the line of
 * `count` rows) and its first frame acknowledged. The page is bound AFTER the open, as the slot binds it when the popup's first frame renders.
 */
function rig(count: number, page: number, width = FLOOR_WIDTH, opened: PopupSpec = spec(count)) {
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
  let columns = width;
  const chord = vi.fn();
  const refusals: ChordRefusal[] = [];
  const closed: string[] = [];
  const open = host.openForUser(opened, {
    chord,
    chordRefused: (_context, reason) => refusals.push(reason),
    closed: (reason) => closed.push(reason),
    control: (context, key) => {
      if (key === 'd') context.goToStep(1);
    },
  });
  if (!open.opened) throw new Error('open');
  host.bindPageRows(() => rows);
  host.bindInnerWidth(() => columns);
  const show = (): void => host.shown(host.getSnapshot());
  show();
  return {
    host,
    time,
    notifications,
    history,
    chord,
    refusals,
    closed,
    show,
    context: (): PopupContext => open.context,
    setPage: (next: number): void => {
      rows = next;
    },
    setWidth: (next: number): void => {
      columns = next;
    },
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
  };
}

/** A line of two rows whose second is exactly `columns` wide (an origin, as the doctor's line names them; at least 18). */
const wideLine = (columns: number): string[] => [
  'Sends your key to:',
  `  https://${'a'.repeat(columns - 18)}.example`,
];

/** A popup of a list and a line of `lines` its `[d]` arms (or that it opens on: `initialStep`). */
const linePopup = (lines: readonly string[], initialStep = 1): PopupSpec => ({
  ...spec(0, initialStep),
  steps: [LIST, { ...line(0), content: { kind: 'report', lines } }],
});

/** Past the dwell, the quiet gap and the lockout of anything before: a deliberate press. */
const PATIENT_MS = 2600;

describe('the one predicate (`lineFitsPage`)', () => {
  it('a report of at least one line and no more lines than the page, and nothing else', () => {
    expect(lineFitsPage({ kind: 'report', lines: linesOf(10) }, 10, FLOOR_WIDTH)).toBe(true);
    expect(lineFitsPage({ kind: 'report', lines: linesOf(11) }, 10, FLOOR_WIDTH)).toBe(false);
    expect(lineFitsPage({ kind: 'report', lines: linesOf(1) }, 1, FLOOR_WIDTH)).toBe(true);
    expect(lineFitsPage({ kind: 'report', lines: [] }, 10, FLOOR_WIDTH)).toBe(false);
    expect(lineFitsPage({ kind: 'report', lines: linesOf(1) }, 0, FLOOR_WIDTH)).toBe(false);
    expect(lineFitsPage({ kind: 'empty', what: 'x', next: 'y' }, 10, FLOOR_WIDTH)).toBe(false);
    expect(lineFitsPage({ kind: 'loading', what: 'x' }, 10, FLOOR_WIDTH)).toBe(false);
  });

  it('and none of its lines wider than the row: exactly the inner width is whole, one column more is cut (round 3, security L2)', () => {
    const exact = wideLine(FLOOR_WIDTH);
    expect(exact[1]).toHaveLength(FLOOR_WIDTH);
    expect(lineFitsPage({ kind: 'report', lines: exact }, 10, FLOOR_WIDTH)).toBe(true);
    expect(
      lineFitsPage({ kind: 'report', lines: wideLine(FLOOR_WIDTH + 1) }, 10, FLOOR_WIDTH),
    ).toBe(false);
    // Display columns, not characters: a wide character is two.
    expect(lineFitsPage({ kind: 'report', lines: ['漢'.repeat(33)] }, 1, FLOOR_WIDTH)).toBe(true);
    expect(lineFitsPage({ kind: 'report', lines: ['漢'.repeat(33), 'a'] }, 2, 65)).toBe(false);
  });

  it('the width is the line AS DRAWN: a tab drawn as a space counts, a control sequence the sanitiser removes does not', () => {
    // 64 columns, a tab and one more: 65 as written (a tab measures nothing) and 66 as drawn (the tab is drawn as a space).
    const tabbed = `${'x'.repeat(64)}\tx`;
    expect(lineFitsPage({ kind: 'report', lines: [tabbed] }, 1, 66)).toBe(true);
    expect(lineFitsPage({ kind: 'report', lines: [tabbed] }, 1, 65)).toBe(false);
    // 66 columns drawn, with a colour sequence inside that the sanitiser takes out (it measures four more as written).
    const coloured = `${'x'.repeat(33)}\u001b[31m${'x'.repeat(33)}`;
    expect(lineFitsPage({ kind: 'report', lines: [coloured] }, 1, 66)).toBe(true);
  });
});

describe('a line with a row wider than its page offers nothing, like a line cut short (round 3, security L2)', () => {
  it('one column over the inner width: Ctrl+Y answers nothing, the line stays and says nothing, the channel is not held', () => {
    const r = rig(0, 10, FLOOR_WIDTH, linePopup(wideLine(FLOOR_WIDTH + 1)));
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).not.toHaveBeenCalled();
    expect(r.refusals).toEqual([]);
    expect(r.step()).toBe(1);
    expect(r.history.lastResolvedAt).toBe(r.time.now());
    r.notifications.notify('a note');
    expect(r.notifications.getSnapshot().current?.text).toBe('a note');
  });

  it('exactly the inner width: answered', () => {
    const r = rig(0, 10, FLOOR_WIDTH, linePopup(wideLine(FLOOR_WIDTH)));
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).toHaveBeenCalledOnce();
  });

  it('its legend names no Ctrl+Y on the row it is drawn in, and names it on a row that holds it', () => {
    const frame = { ...openFrame(linePopup(wideLine(70)), 1), stepIndex: 1 };
    const cut = popupLegend(frame, 10, FLOOR_WIDTH);
    expect(legend(cut.items, cut.exit)).toBe('Esc back');
    const whole = popupLegend(frame, 10, 74);
    expect(legend(whole.items, whole.exit)).toBe('[Ctrl+Y] send · Esc back');
    // With no row of its own the legend judges the row of a popup at the floor (66 columns), as the page.
    const floor = popupLegend(frame, 10);
    expect(legend(floor.items, floor.exit)).toBe('Esc back');
    const fitting = { ...openFrame(linePopup(wideLine(FLOOR_WIDTH)), 1), stepIndex: 1 };
    const fits = popupLegend(fitting, 10);
    expect(legend(fits.items, fits.exit)).toBe('[Ctrl+Y] send · Esc back');
  });

  it('a page that becomes narrower under a line that offered its answer disarms it at its next frame, told as cut', () => {
    const r = rig(0, 10, 74, linePopup(wideLine(70)));
    r.time.advance(300);
    // The resize: the host is told, then the frame at the new size (a 66-column row) is drawn and acknowledged.
    r.host.resized(80, 24);
    r.setWidth(FLOOR_WIDTH);
    r.show();
    expect(r.step()).toBe(0);
    expect(r.refusals).toEqual(['cut']);
    expect(r.chord).not.toHaveBeenCalled();
    // `[d]` asks again on the narrow page: the line comes back cut and offers nothing.
    r.time.advance(PATIENT_MS);
    r.host.input('d', {});
    r.show();
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).not.toHaveBeenCalled();
    expect(r.step()).toBe(1);
  });

  it('a page that becomes wider under a line that was cut makes it answerable from its next acknowledged frame', () => {
    const r = rig(0, 10, FLOOR_WIDTH, linePopup(wideLine(70)));
    r.time.advance(300);
    r.setWidth(74);
    r.show();
    expect(r.refusals).toEqual([]);
    r.time.advance(PATIENT_MS);
    r.host.input('y', CTRL_Y);
    expect(r.chord).toHaveBeenCalledOnce();
  });
});

describe('the page is bound after the popup opened, as the slot binds it (round 3, mutants H98 and H15)', () => {
  it('H98: a line the page cuts does not keep the channel held once its first frame is acknowledged (rows)', () => {
    const r = rig(14, 10);
    r.notifications.notify('a note');
    expect(r.notifications.getSnapshot().held).toBe(false);
    expect(r.notifications.getSnapshot().current?.text).toBe('a note');
  });

  it('H98: nor one whose row the page cuts (columns)', () => {
    const r = rig(0, 10, FLOOR_WIDTH, linePopup(wideLine(FLOOR_WIDTH + 4)));
    r.notifications.notify('a note');
    expect(r.notifications.getSnapshot().current?.text).toBe('a note');
  });

  it('H15: leaving a line that offered its answer for a report longer than the page leaves the popup open, and nothing is told as cut', () => {
    const report: PopupStep = {
      name: 'Report',
      content: { kind: 'report', lines: linesOf(12) },
      controls: [{ key: 'd', verb: 'arm' }],
    };
    const r = rig(0, 5, FLOOR_WIDTH, {
      ...spec(4),
      steps: [report, line(4)],
    });
    r.time.advance(900);
    r.host.input('', { escape: true });
    r.show();
    expect(r.host.getSnapshot().open).toBe(true);
    expect(r.step()).toBe(0);
    expect(r.refusals).toEqual([]);
    expect(r.closed).toEqual([]);
  });
});

describe('the page of a report is its own, not the list window (`framePage`, popup-slot.tsx)', () => {
  it('a report under a filter line is drawn one row shorter than the window: 17 lines on a 17-row body are cut, and offer nothing', () => {
    const lines = linesOf(17);
    const filtered: PopupSpec = {
      ...spec(17),
      steps: [LIST, { ...line(17), filter: true }],
    };
    const frame = { ...openFrame(filtered, 1), stepIndex: 1 };
    const geometry = popupGeometry({
      columns: 80,
      rows: 24,
      kind: 'standard',
      placement: 'overlay',
      rail: true,
      bodyRows: 18,
    });
    if (!geometry.fits) throw new Error('fits');
    expect(geometry.listRows).toBe(17);
    expect(framePage(frame, geometry)).toEqual({ rows: 16, innerWidth: FLOOR_WIDTH });
    expect(lineFitsPage({ kind: 'report', lines }, framePage(frame, geometry).rows, 66)).toBe(
      false,
    );
    // No frame drawn: one row of no column, so nothing fits.
    expect(framePage(frame, { fits: false, reason: 'below-floor' })).toEqual({
      rows: 1,
      innerWidth: 0,
    });
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
