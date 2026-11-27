/**
 * A confirmation line answered by `Enter` (`chord.key: 'enter'`; `/permissions`' withdrawal, MVP-11 step 5c) is the SAME line as one answered
 * by `Ctrl+Y` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §8): one
 * implementation of the host, parameterised by the answer key. So every rule of the line is run here on BOTH kinds from one table (the numbers
 * pinned by their literal values, the reasons, the window and its timer, the whole-on-page rule, a held key), and then what only the `Enter`
 * kind adds: `Enter` is a key typing makes, so a control letter after typing arms nothing, and the key that opened the popup starts the line's
 * lockout. The held-key matrix holds `Enter` across the arming at every repeat rate from 30 ms to 2.5 s.
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordGuard, createChordHistory } from '../render/tui/chord-guard.js';
import { legend } from '../render/tui/legend.js';
import type { PopupContent } from './frame-model.js';
import { createNotificationChannel, type Schedule } from './notifications.js';
import { createPopupHost, type ChordRefusal, type PopupContext } from './popup-host.js';
import {
  hasEnterLine,
  lineAnswerKeyOf,
  openFrame,
  popupLegend,
  reducePopupKey,
  typingOf,
  withContent,
  type LineAnswerKey,
  type PopupKey,
  type PopupSpec,
  type PopupStep,
} from './popup-reducer.js';

const CTRL_Y: PopupKey = { ctrl: true };
const ENTER: PopupKey = { return: true };
const ESC: PopupKey = { escape: true };
const DOWN: PopupKey = { downArrow: true };

const REPORT: PopupContent = {
  kind: 'report',
  lines: ['Withdraw this remembered command?', '  npm, 1 argument', 'Nothing else.'],
};
const LIST: PopupStep = {
  name: 'Rows',
  content: {
    kind: 'list',
    rows: [
      { id: 'a', label: 'alpha' },
      { id: 'b', label: 'beta' },
    ],
  },
  controls: [{ key: 'd', verb: 'arm', deleteKey: true }],
};
const lineStep = (answer: LineAnswerKey, over: Partial<PopupStep> = {}): PopupStep => ({
  name: 'Confirm',
  content: REPORT,
  back: 0,
  holds: 'chord',
  chord: { verb: 'withdraw', key: answer },
  ...over,
});
const specOf = (answer: LineAnswerKey, line: Partial<PopupStep> = {}): PopupSpec => ({
  id: 'line',
  title: '/line',
  origin: 'chat',
  rail: 'path',
  steps: [LIST, lineStep(answer, line)],
});

/** Each kind of line, and the press that answers it and the one that is the OTHER kind's answer (a key typed over it). */
const KINDS = [
  { kind: 'ctrl-y', answer: ['y', CTRL_Y], other: ['', ENTER] },
  { kind: 'enter', answer: ['', ENTER], other: ['y', CTRL_Y] },
] as const satisfies readonly {
  readonly kind: LineAnswerKey;
  readonly answer: readonly [string, PopupKey];
  readonly other: readonly [string, PopupKey];
}[];

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
 * A host with a line's popup open on its list, appeared and settled (600 ms), its frame "on screen" unless hidden. `arm()` presses `[d]` (the
 * command moves to the line) and acknowledges the line's frame. `before` runs before the open (keys the composer took).
 */
function rig(
  answer: LineAnswerKey,
  options: {
    readonly line?: Partial<PopupStep>;
    readonly dropTimers?: boolean;
    readonly before?: (
      history: ReturnType<typeof createChordHistory>,
      clock: { now: () => number; advance: (ms: number) => void },
    ) => void;
  } = {},
) {
  const time = timers(options.dropTimers === true);
  const notifications = createNotificationChannel({ schedule: time.schedule });
  const history = createChordHistory();
  options.before?.(history, time);
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    notifications,
    history,
    placement: 'overlay',
  });
  let painted = true;
  host.bindVisibility(() => painted);
  host.bindOpenGate(() => undefined);
  const chord = vi.fn();
  const control = vi.fn((c: PopupContext, key: string) => {
    if (key === 'd') c.goToStep(1);
  });
  const refusals: ChordRefusal[] = [];
  const stepChanged = vi.fn();
  const opened = host.openForUser(specOf(answer, options.line), {
    chord,
    chordRefused: (_context, reason) => refusals.push(reason),
    stepChanged,
    control,
  });
  if (!opened.opened) throw new Error('open');
  host.bindPageRows(() => 18);
  host.bindInnerWidth(() => 66);
  const show = (): void => host.shown(host.getSnapshot());
  show();
  time.advance(600);
  return {
    host,
    time,
    history,
    chord,
    control,
    refusals,
    stepChanged,
    context: (): PopupContext => opened.context,
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

describe.each(KINDS)(
  'a line answered by $kind: the line’s rules, one implementation',
  ({ kind, answer, other }) => {
    const press = (r: ReturnType<typeof rig>): boolean => r.press(answer[0], answer[1]);

    it('the dwell is 800 ms from the acknowledgement: 799 is refused (early) and the line is gone, 800 answers', () => {
      const early = rig(kind);
      early.arm();
      early.time.advance(799);
      press(early);
      expect(early.chord).not.toHaveBeenCalled();
      expect(early.refusals).toEqual(['early']);
      expect(early.step()).toBe(0);
      const exact = rig(kind);
      exact.arm();
      exact.time.advance(800);
      press(exact);
      expect(exact.chord).toHaveBeenCalledOnce();
    });

    it('the window is ten seconds from the acknowledged frame: 10 000 ms answers, 10 001 ms is gone (the host’s timer), and a key before a late timer is judged expired', () => {
      const at = rig(kind);
      at.arm();
      at.time.advance(10_000);
      press(at);
      expect(at.chord).toHaveBeenCalledOnce();
      const timed = rig(kind);
      timed.arm();
      timed.time.advance(10_001);
      expect(timed.refusals).toEqual(['expired']);
      expect(timed.step()).toBe(0);
      expect(timed.stepChanged).toHaveBeenCalledWith(expect.anything(), 1, 0);
      const late = rig(kind, { dropTimers: true });
      late.arm();
      late.time.advance(10_001);
      expect(late.step()).toBe(1);
      press(late);
      expect(late.refusals).toEqual(['expired']);
      expect(late.chord).not.toHaveBeenCalled();
    });

    it('unseen: a line whose frame was never acknowledged, or not on screen when the key came; the key is still a resolution', () => {
      const never = rig(kind);
      never.press('d');
      never.time.advance(2000);
      press(never);
      expect(never.refusals).toEqual(['unseen']);
      const hidden = rig(kind);
      hidden.arm();
      hidden.hide();
      hidden.time.advance(900);
      press(hidden);
      expect(hidden.refusals).toEqual(['unseen']);
      expect(hidden.history.lastResolvedAt).toBe(hidden.time.now());
      expect(hidden.chord).not.toHaveBeenCalled();
    });

    it('the quiet gap: a navigation key 100 ms before the answer refuses it (early)', () => {
      const r = rig(kind);
      r.arm();
      r.time.advance(1000);
      r.press('', DOWN);
      r.show();
      r.time.advance(100);
      press(r);
      expect(r.refusals).toEqual(['early']);
      expect(r.chord).not.toHaveBeenCalled();
    });

    it('the lockout: a key that resolved something 1.9 s before the answer (before the key that armed it) refuses it; 2.1 s does not', () => {
      for (const [gap, answers] of [
        [1900, false],
        [2100, true],
      ] as const) {
        const r = rig(kind);
        r.history.lastResolvedAt = r.time.now();
        r.time.advance(100);
        r.arm();
        r.time.advance(gap - 100);
        press(r);
        expect(r.chord.mock.calls.length, `${String(gap)} ms`).toBe(answers ? 1 : 0);
      }
    });

    it('a held key’s repeat (a terminal that reports key events) is refused as early, however long after the frame', () => {
      const r = rig(kind);
      r.arm();
      r.time.advance(3000);
      r.press(answer[0], { ...answer[1], eventType: 'repeat' });
      expect(r.refusals).toEqual(['early']);
      expect(r.chord).not.toHaveBeenCalled();
    });

    it('a key typed over the line (a letter, the other kind’s answer, Backspace) and a paste disarm it and are told as typed; Esc and Ctrl+C are cancels', () => {
      for (const [input, key] of [['x', {}], other, ['', { backspace: true }]] as const) {
        const r = rig(kind);
        r.arm();
        r.time.advance(900);
        r.press(input, key);
        expect(r.step()).toBe(0);
        expect(r.refusals).toEqual(['typed']);
        expect(r.chord).not.toHaveBeenCalled();
      }
      const pasted = rig(kind);
      pasted.arm();
      pasted.time.advance(900);
      pasted.host.paste('\r');
      expect(pasted.refusals).toEqual(['typed']);
      for (const [input, key] of [
        ['', ESC],
        ['c', { ctrl: true }],
      ] as const) {
        const r = rig(kind);
        r.arm();
        r.time.advance(900);
        r.press(input, key);
        expect(r.step()).toBe(0);
        expect(r.refusals).toEqual([]);
      }
    });

    it('typed: an answer key counted on a line with nothing to confirm is evidence against the line it becomes', () => {
      const r = rig(kind, {
        line: { content: { kind: 'empty', what: 'Nothing.', next: 'Esc goes back.' } },
      });
      r.arm();
      r.time.advance(600);
      press(r);
      expect(r.step()).toBe(1);
      r.context().setContent(1, REPORT);
      r.show();
      r.time.advance(2500);
      press(r);
      expect(r.refusals).toEqual(['typed']);
      expect(r.chord).not.toHaveBeenCalled();
    });

    it('the whole line or no answer: a page that cuts it offers none (the key stays a refused affirmative), and a frame that cuts it disarms it as cut', () => {
      const short = rig(kind);
      short.host.bindPageRows(() => 2);
      short.arm();
      short.time.advance(900);
      press(short);
      expect(short.chord).not.toHaveBeenCalled();
      expect(short.step()).toBe(1);
      expect(short.refusals).toEqual([]);
      const cut = rig(kind);
      cut.arm();
      cut.host.bindPageRows(() => 2);
      cut.host.resized(80, 24);
      cut.show();
      expect(cut.refusals).toEqual(['cut']);
      expect(cut.step()).toBe(0);
    });

    it('the expiry timer goes with an answer', () => {
      const r = rig(kind);
      r.arm();
      // The expiry timer, and on a line answered by `Enter` the one that ends its `(wait)` mark when the dwell has passed (review round 1, O-7).
      expect(r.time.live()).toBe(kind === 'enter' ? 2 : 1);
      r.time.advance(900);
      press(r);
      expect(r.chord).toHaveBeenCalledOnce();
      expect(r.time.live()).toBe(0);
    });
  },
);

describe('the reducer: what a key is on a line answered by Enter', () => {
  const line = lineStep('enter');
  const on = (input: string, key: PopupKey = {}) => reducePopupKey(input, key, line);

  it('a plain Enter is the answer, its repeat or release a held one; Enter with Ctrl, Meta (Esc then Enter) or Shift is a key typed over it', () => {
    expect(on('', ENTER)).toEqual({ kind: 'chord' });
    expect(on('\r', ENTER)).toEqual({ kind: 'chord' });
    expect(on('', { ...ENTER, eventType: 'repeat' })).toEqual({ kind: 'chord', held: true });
    expect(on('', { ...ENTER, eventType: 'release' })).toEqual({ kind: 'chord', held: true });
    for (const held of [{ ctrl: true }, { meta: true }, { shift: true }])
      expect(on('', { ...ENTER, ...held })).toEqual({ kind: 'disarm', cause: 'typed' });
  });

  it('Ctrl+Y is no answer here: a key typed over it; Esc steps back, Ctrl+C is a cancel, the arrows move', () => {
    expect(on('y', CTRL_Y)).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(on('', ESC)).toEqual({ kind: 'leave' });
    expect(on('c', { ctrl: true })).toEqual({ kind: 'disarm', cause: 'interrupt' });
    expect(on('', DOWN)).toEqual({ kind: 'move', delta: 1 });
  });

  it('a line names its key: `Enter withdraw · Esc keep` with the step’s own word for Esc, `Ctrl+Y` for the other kind (whose Esc stays `back`)', () => {
    const enter = withContent(
      { ...openFrame(specOf('enter', { exitVerb: 'keep' }), 1), stepIndex: 1 },
      1,
      REPORT,
    );
    const parts = popupLegend(enter, 18, 66);
    expect(legend(parts.items, parts.exit)).toBe('Enter withdraw · Esc keep');
    const chord = withContent({ ...openFrame(specOf('ctrl-y'), 1), stepIndex: 1 }, 1, REPORT);
    const chordParts = popupLegend(chord, 18, 66);
    expect(legend(chordParts.items, chordParts.exit)).toBe('[Ctrl+Y] withdraw · Esc back');
  });

  it('the answer key of a step, and whether a popup has an Enter line', () => {
    expect(lineAnswerKeyOf(LIST)).toBeUndefined();
    expect(lineAnswerKeyOf({ ...lineStep('ctrl-y'), chord: { verb: 'send' } })).toBe('ctrl-y');
    expect(lineAnswerKeyOf(lineStep('enter'))).toBe('enter');
    expect(hasEnterLine(specOf('enter'))).toBe(true);
    expect(hasEnterLine(specOf('ctrl-y'))).toBe(false);
  });

  it('what a key says about typing: navigation is choosing, a cancel, a control and a line’s own key say nothing, the rest is typing', () => {
    expect(typingOf({ kind: 'move', delta: 1 })).toBe(false);
    expect(typingOf({ kind: 'page', delta: -1 })).toBe(false);
    expect(typingOf({ kind: 'jump', to: 'first' })).toBe(false);
    expect(typingOf({ kind: 'adjust', delta: 1 })).toBe(false);
    for (const kind of ['enter', 'backspace', 'none'] as const)
      expect(typingOf({ kind })).toBe(true);
    expect(typingOf({ kind: 'append', text: 'x' })).toBe(true);
    expect(typingOf({ kind: 'disarm', cause: 'typed' })).toBe(true);
    expect(typingOf({ kind: 'disarm', cause: 'interrupt' })).toBeUndefined();
    for (const kind of ['leave', 'close-all'] as const) expect(typingOf({ kind })).toBeUndefined();
    expect(typingOf({ kind: 'control', key: 'd' })).toBeUndefined();
    expect(typingOf({ kind: 'chord' })).toBeUndefined();
  });
});

describe('the Delete key is a control that says so (`[d] / Del`)', () => {
  it('Delete and Backspace are the control on a step without a filter; with Ctrl or Meta, or on a step with a filter, they edit', () => {
    expect(reducePopupKey('', { delete: true }, LIST)).toEqual({ kind: 'control', key: 'd' });
    expect(reducePopupKey('', { backspace: true }, LIST)).toEqual({ kind: 'control', key: 'd' });
    expect(reducePopupKey('', { delete: true, ctrl: true }, LIST)).toEqual({ kind: 'backspace' });
    expect(reducePopupKey('', { delete: true, meta: true }, LIST)).toEqual({ kind: 'backspace' });
    expect(reducePopupKey('', { delete: true }, { ...LIST, filter: true })).toEqual({
      kind: 'backspace',
    });
    const plain = { ...LIST, controls: [{ key: 'd', verb: 'arm' }] };
    expect(reducePopupKey('', { delete: true }, plain)).toEqual({ kind: 'backspace' });
  });

  it('the legend names both keys of the control', () => {
    const parts = popupLegend(openFrame(specOf('enter'), 1), 18, 66);
    expect(legend(parts.items, parts.exit)).toBe('↑/↓ select · [d] / Del arm · Esc close');
  });

  it('Delete arms the line on the host', () => {
    const r = rig('enter');
    r.press('', { delete: true });
    expect(r.control).toHaveBeenCalledWith(expect.anything(), 'd', { id: 'a', label: 'alpha' });
    expect(r.step()).toBe(1);
  });
});

describe('only on a popup with an Enter line: a control letter after typing arms nothing (the rule of the sheet it replaces)', () => {
  it.each([
    ['a letter that is no control', 'x', {}],
    ['Enter where it answers nothing', '', ENTER],
    ['Backspace with Ctrl', '', { backspace: true, ctrl: true }],
    ['a chord', 'y', CTRL_Y],
  ] as const)(
    '%s, then [d]: not armed, told as typed; an arrow key, then [d]: armed',
    (_name, input, key) => {
      const r = rig('enter');
      r.press(input, key);
      r.press('d');
      expect(r.control).not.toHaveBeenCalled();
      expect(r.step()).toBe(0);
      expect(r.refusals).toEqual(['typed']);
      r.press('', DOWN);
      r.press('d');
      expect(r.control).toHaveBeenCalledOnce();
      expect(r.step()).toBe(1);
    },
  );

  it('a paste on the list is typing too, and so is a key dropped before the frame was seen', () => {
    const pasted = rig('enter');
    pasted.host.paste('words');
    pasted.press('d');
    expect(pasted.control).not.toHaveBeenCalled();
    const dropped = rig('enter');
    dropped.hide();
    dropped.press('x');
    dropped.reveal();
    dropped.press('d');
    expect(dropped.control).not.toHaveBeenCalled();
    expect(dropped.refusals).toEqual(['typed']);
  });

  it('a key typed over the line counts: back on the list, [d] arms nothing until an arrow key; an early Enter and Esc do not', () => {
    const typed = rig('enter');
    typed.arm();
    typed.time.advance(900);
    typed.press('x');
    expect(typed.step()).toBe(0);
    typed.press('d');
    expect(typed.control).toHaveBeenCalledOnce();
    expect(typed.refusals).toEqual(['typed', 'typed']);
    for (const [input, key] of [
      ['', ENTER],
      ['', ESC],
    ] as const) {
      const r = rig('enter');
      r.arm();
      r.time.advance(200);
      r.press(input, key);
      expect(r.step()).toBe(0);
      r.time.advance(2100);
      r.press('d');
      expect(r.control, JSON.stringify(key)).toHaveBeenCalledTimes(2);
      r.show();
      r.time.advance(900);
      r.press('', ENTER);
      expect(r.chord, JSON.stringify(key)).toHaveBeenCalledOnce();
    }
  });

  it('a popup whose line is answered by Ctrl+Y: an Enter that answers nothing is no refused affirmative there (it does not restart the lockout), as before', () => {
    const r = rig('ctrl-y');
    r.press('', ENTER);
    r.time.advance(100);
    r.arm();
    r.time.advance(900);
    r.press('y', CTRL_Y);
    expect(r.chord).toHaveBeenCalledOnce();
    // On a popup with an Enter line the same Enter is one: the line it arms 100 ms later is locked.
    const e = rig('enter');
    e.press('', ENTER);
    e.press('', DOWN);
    e.time.advance(100);
    e.arm();
    e.time.advance(900);
    e.press('', ENTER);
    expect(e.chord).not.toHaveBeenCalled();
    expect(e.refusals).toEqual(['early']);
  });

  it('a popup whose line is answered by Ctrl+Y reads no such rule: a letter, then [d], arms it (byte for byte as before)', () => {
    const r = rig('ctrl-y');
    r.press('x');
    r.press('', ENTER);
    r.press('d');
    expect(r.control).toHaveBeenCalledOnce();
    expect(r.step()).toBe(1);
    expect(r.refusals).toEqual([]);
  });
});

describe('the key that opened the popup starts an Enter line’s lockout, wherever in the popup it is armed', () => {
  /** The composer took a key `at` ms before the popup opened (its `Enter` that typed the command): stamped as a key, never a resolution. */
  const typedBefore = (
    history: ReturnType<typeof createChordHistory>,
    clock: { now: () => number; advance: (ms: number) => void },
  ): void => {
    clock.advance(1000);
    createChordGuard({ now: clock.now, history }).stamp();
    clock.advance(30);
  };

  it.each([
    [1900, 0],
    [2100, 1],
  ] as const)(
    'an Enter %i ms after the composer’s key, on a line [d] armed in between: %i withdrawal(s)',
    (after, answered) => {
      const r = rig('enter', { before: typedBefore });
      const composerKeyAt = 1000;
      r.time.advance(100);
      r.arm();
      r.time.advance(composerKeyAt + after - r.time.now());
      r.press('', ENTER);
      expect(r.chord.mock.calls.length).toBe(answered);
    },
  );

  it('a Ctrl+Y line armed in the popup is armed against the key that armed it only (as before)', () => {
    const r = rig('ctrl-y', { before: typedBefore });
    r.time.advance(100);
    r.arm();
    r.time.advance(900);
    r.press('y', CTRL_Y);
    expect(r.chord).toHaveBeenCalledOnce();
  });
});

describe('the held-key matrix: Enter held across the arming never withdraws', () => {
  /** Repeat intervals from a fast OS repeat to longer than the lockout, and whether the terminal reports the repeat as one. */
  const RATES = [30, 100, 250, 500, 800, 1000, 1500, 1800, 2000, 2500] as const;

  it.each(
    RATES.flatMap((every) => [
      [every, 'a legacy terminal (the repeat is a press)'] as const,
      [every, 'a terminal that reports key events'] as const,
    ]),
  )(
    'repeats every %i ms, %s: [d] between two repeats arms nothing, and nothing is answered',
    (every, terminal) => {
      const reported = terminal.startsWith('a terminal that');
      const r = rig('enter');
      const enter = (first: boolean): boolean =>
        r.press('', first || !reported ? ENTER : { ...ENTER, eventType: 'repeat' });
      // The key went down on the list and repeats; `[d]` comes 10 ms after one repeat (5 ms at 30 ms), then the repeats go on.
      enter(true);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        r.time.advance(every);
        enter(false);
      }
      r.time.advance(Math.min(10, every / 3));
      r.press('d');
      r.show();
      for (let repeat = 0; repeat < 8; repeat += 1) {
        r.time.advance(repeat === 0 ? every - Math.min(10, every / 3) : every);
        enter(false);
        r.show();
      }
      expect(r.chord).not.toHaveBeenCalled();
      expect(r.control, 'the [d] after the repeats armed nothing').not.toHaveBeenCalled();
    },
  );

  /** An arrow key between the repeats and `[d]`: the line arms, and the repeats that reach it meet the lockout every refused one restarts. */
  const heldThroughAnArrow = (every: number) => {
    const r = rig('enter');
    r.press('', ENTER);
    r.time.advance(every);
    r.press('', ENTER);
    r.time.advance(Math.min(5, every / 4));
    r.press('', DOWN);
    r.press('', { upArrow: true });
    r.press('d');
    r.show();
    for (let repeat = 0; repeat < 8; repeat += 1) {
      r.time.advance(every);
      r.press('', ENTER);
      r.show();
    }
    return r;
  };

  it.each(RATES.filter((every) => every < 2000))(
    'the same with an arrow key before [d] (the key still down), every %i ms: the line arms, and each repeat on it is refused',
    (every) => {
      const r = heldThroughAnArrow(every);
      expect(r.control, 'the arrow key let [d] arm the line').toHaveBeenCalled();
      expect(r.chord, `${String(every)} ms`).not.toHaveBeenCalled();
    },
  );

  it('the limit, as for a Ctrl+Y line: a repeat slower than the lockout (2 s) after an arrow key and [d] is a deliberate press to the guard (an OS stops a key’s repeat when another key goes down)', () => {
    expect(heldThroughAnArrow(2500).chord).toHaveBeenCalled();
  });
});
