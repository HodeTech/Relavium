/**
 * The popup host's contract where the mutation sweep of MVP-11 step 4's second review round found it unpinned
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §3, §5, §8). Each case names the
 * mutant it kills (A07 … A139). The contract chosen for A07/A112: a line a key's handler arms (an `Enter` that moves to it, as `[d]` does) is
 * armed against what came BEFORE that key, so the key that armed it does not lock it (the lockout is for a key held through, which the key's
 * own handler is not); a line a popup OPENS on is locked by the last key before the open (`popup-held-chord.test.tsx`).
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { createNotificationChannel, type Schedule } from './notifications.js';
import {
  CHORD_STEP_WINDOW_MS,
  createPopupHost,
  type PopupContext,
  type PopupHostOptions,
} from './popup-host.js';
import { currentStep, type PopupSpec, type PopupStep } from './popup-reducer.js';

const ENTER = { return: true } as const;
const CTRL_Y = { ctrl: true } as const;

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
    set: (to: number): void => {
      now = to;
    },
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
    /** Fire the live timers now, whatever their time (a timer that fires early). */
    fireAll: (): void => {
      for (const timer of pending.filter((t) => !t.cancelled)) {
        timer.cancelled = true;
        timer.run();
      }
    },
    live: () => pending.filter((timer) => !timer.cancelled).length,
  };
}

function rig(options: Partial<PopupHostOptions> = {}) {
  const time = timers();
  const notifications = createNotificationChannel({ schedule: time.schedule });
  const history = createChordHistory();
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    notifications,
    history,
    placement: 'overlay',
    ...options,
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  const show = (): void => host.shown(host.getSnapshot());
  return { host, time, notifications, history, show };
}

const LIST: PopupStep = {
  name: 'Pick',
  content: { kind: 'list', rows: [{ id: 'one', label: 'one' }] },
  enter: 'arm',
  controls: [{ key: 'd', verb: 'arm' }],
};
const LINE: PopupStep = {
  name: 'Confirm',
  content: { kind: 'report', lines: ['Sends one request to:', '  https://a.example'] },
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
};
const spec = (steps: PopupStep[] = [LIST, LINE], over: Partial<PopupSpec> = {}): PopupSpec => ({
  id: 'p',
  title: '/p',
  origin: 'chat',
  steps,
  ...over,
});

describe('the popup host’s contract (MVP-11 step 4, review round 2, mutation sweep)', () => {
  it('P1 (A39): a timer that fires exactly at the window leaves the line answerable (the last moment still answers)', () => {
    const r = rig();
    const chord = vi.fn();
    const chordRefused = vi.fn();
    r.host.openForUser(spec([LIST, LINE], { initialStep: 1 }), { chord, chordRefused });
    r.show();
    const shownAt = r.time.now();
    // The host's expiry timer fires early, at exactly shownAt + window (what a Node timer can do).
    r.time.set(shownAt + CHORD_STEP_WINDOW_MS);
    r.time.fireAll();
    expect(chordRefused).not.toHaveBeenCalled();
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(1);
    // and it re-armed itself: a later firing past the window expires it.
    r.time.set(shownAt + CHORD_STEP_WINDOW_MS + 1);
    r.time.fireAll();
    expect(chordRefused).toHaveBeenCalledWith(expect.anything(), 'expired');
  });

  it('P2 (A07/A112): a line armed by an Enter handler is not locked out by the Enter that armed it', () => {
    const r = rig();
    const chord = vi.fn();
    let context: PopupContext | undefined;
    const opened = r.host.openForUser(spec(), {
      enter: (ctx) => {
        ctx.goToStep(1);
      },
      chord,
    });
    if (opened.opened) context = opened.context;
    expect(context).toBeDefined();
    r.show();
    r.time.advance(600);
    r.host.input('', ENTER); // resolves (stamps lastResolvedAt = 600) and arms the line
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(1);
    r.show();
    r.time.advance(900); // past the dwell (800) and the quiet gap (300), inside the lockout (2000) of the Enter
    r.host.input('y', CTRL_Y);
    expect(chord).toHaveBeenCalledOnce();
  });

  it('P3a (A117): a paste over a line with nothing to confirm tells the command nothing', () => {
    const r = rig();
    const chordRefused = vi.fn();
    r.host.openForUser(
      spec(
        [LIST, { ...LINE, content: { kind: 'empty', what: 'Nothing to confirm.', next: 'Esc.' } }],
        { initialStep: 1 },
      ),
      { chordRefused },
    );
    r.show();
    r.time.advance(600);
    r.host.paste('hello');
    expect(chordRefused).not.toHaveBeenCalled();
  });

  it('P3b (A58): a Ctrl+Y dropped by the opening guard on a line with nothing to confirm neither disarms nor tells', () => {
    const r = rig();
    const chordRefused = vi.fn();
    r.host.openForUser(
      spec(
        [LIST, { ...LINE, content: { kind: 'empty', what: 'Nothing to confirm.', next: 'Esc.' } }],
        { initialStep: 1 },
      ),
      { chordRefused },
    );
    r.show();
    r.time.advance(100); // inside the settle: the guard drops the answer
    r.host.input('y', CTRL_Y);
    expect(chordRefused).not.toHaveBeenCalled();
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(1);
  });

  it('P3c (A85): a Ctrl+Y on a line with nothing to confirm is still a refused affirmative on the key history', () => {
    const r = rig();
    r.host.openForUser(
      spec(
        [LIST, { ...LINE, content: { kind: 'empty', what: 'Nothing to confirm.', next: 'Esc.' } }],
        { initialStep: 1 },
      ),
    );
    r.show();
    r.time.advance(600);
    const at = r.time.now();
    r.host.input('y', CTRL_Y);
    expect(r.history.lastResolvedAt).toBe(at);
  });

  it('P4a (A75): a result landing on another step does not stop the current step’s loading clock', () => {
    const r = rig();
    let context: PopupContext | undefined;
    const opened = r.host.openForUser(
      spec([{ ...LIST, content: { kind: 'loading', what: 'Reading' } }, LINE]),
      {},
    );
    if (opened.opened) context = opened.context;
    r.show();
    r.time.advance(6000);
    expect(r.host.clock.read()).toBe('6 s');
    context?.setContent(1, { kind: 'report', lines: ['x'] });
    r.time.advance(1000);
    expect(r.host.clock.read()).toBe('7 s');
  });

  it('P4b (A52): a step that is already loading when the popup moves to it starts its clock then', () => {
    const r = rig();
    let context: PopupContext | undefined;
    const opened = r.host.openForUser(
      spec([
        LIST,
        {
          ...LINE,
          chord: undefined,
          holds: undefined,
          content: { kind: 'loading', what: 'Reading' },
        },
      ]),
      {},
    );
    if (opened.opened) context = opened.context;
    r.show();
    r.time.advance(2000);
    context?.goToStep(1);
    r.time.advance(6000);
    expect(r.host.clock.read()).toBe('6 s');
  });

  it('P5a (A132): a resize below the floor closes the whole stack when the child holds a chord', () => {
    const r = rig();
    const closed: string[] = [];
    const opened = r.host.openForUser(spec([LIST], { title: '/parent' }), {
      closed: (why) => closed.push(`parent:${why}`),
    });
    if (!opened.opened) throw new Error('open');
    r.show();
    r.time.advance(600);
    const child = opened.context.openChild(spec([LINE], { title: '/child' }), {
      closed: (why) => closed.push(`child:${why}`),
    });
    expect(child.opened).toBe(true);
    r.host.resized(40, 10);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(closed).toEqual(['child:resize', 'parent:resize']);
  });

  it('P5b (A80): a child opened after the host was disposed is refused as closed', () => {
    const r = rig();
    const opened = r.host.openForUser(spec([LIST]), {});
    if (!opened.opened) throw new Error('open');
    r.host.dispose();
    expect(opened.context.openChild(spec([LIST]))).toEqual({ opened: false, reason: 'closed' });
  });

  it('P6 (A139): dispose unsubscribes from the notification channel', () => {
    const r = rig();
    const off = vi.fn();
    const subscribe = r.notifications.subscribe;
    const wrapped = createPopupHost({
      now: r.time.now,
      schedule: r.time.schedule,
      notifications: {
        ...r.notifications,
        subscribe: (l) => {
          const stop = subscribe(l);
          return () => {
            off();
            stop();
          };
        },
      },
      placement: 'overlay',
    });
    wrapped.dispose();
    expect(off).toHaveBeenCalledOnce();
  });

  it('P7 (A88): a page height of 0 still scrolls a report to its last line, not past it', () => {
    const r = rig();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`);
    r.host.openForUser(spec([{ name: 'R', content: { kind: 'report', lines } }]), {});
    r.host.bindPageRows(() => 0);
    r.show();
    r.time.advance(600);
    r.host.input('', { end: true });
    expect(
      currentStep(
        r.host.getSnapshot().frame ??
          (() => {
            throw new Error('open');
          })(),
      ).state.offset,
    ).toBe(29);
  });

  it('P9 (A107): a Ctrl+Y inside the settle time on a line still being prepared is told as unseen', () => {
    const r = rig();
    const reasons: string[] = [];
    r.host.openForUser(
      spec([LIST, { ...LINE, content: { kind: 'loading', what: 'Preparing' } }], {
        initialStep: 1,
      }),
      { chordRefused: (_c, reason) => reasons.push(reason) },
    );
    r.show();
    r.time.advance(100);
    r.host.input('y', CTRL_Y);
    expect(reasons).toEqual(['unseen']);
  });

  it('P10 (A113): a line a command opens on its own right after a resolving key is locked out by that key', () => {
    const r = rig();
    const chord = vi.fn();
    const first = r.host.openForUser(spec([LIST]), {});
    if (!first.opened) throw new Error('open');
    r.show();
    r.time.advance(600);
    r.host.input('', { escape: true }); // closes (a resolution at 600)
    expect(r.host.getSnapshot().open).toBe(false);
    r.time.advance(100);
    r.host.openForUser(spec([LIST, LINE], { initialStep: 1 }), { chord }); // opened by a command, no key
    r.show();
    r.time.advance(900); // 900 ms after the frame, 1000 ms after the Esc: inside its 2000 ms lockout
    r.host.input('y', CTRL_Y);
    expect(chord).not.toHaveBeenCalled();
  });

  it('P11 (A105/A106): a Ctrl+Y at the very moment the line appeared is told as unseen, not early', () => {
    const r = rig();
    const reasons: string[] = [];
    r.host.openForUser(spec([LIST, LINE], { initialStep: 1 }), {
      chordRefused: (_c, reason) => reasons.push(reason),
    });
    r.show();
    r.host.input('y', CTRL_Y);
    expect(reasons).toEqual(['unseen']);
  });

  it('P12 (A120): a paste at the very moment the frame appeared is dropped by the opening guard', () => {
    const r = rig();
    r.host.openForUser(spec([{ ...LIST, filter: true }]), {});
    r.show();
    r.host.paste('abc');
    expect(
      currentStep(
        r.host.getSnapshot().frame ??
          (() => {
            throw new Error('open');
          })(),
      ).state.filter,
    ).toBe('');
  });

  it('P13 (A122): a paste of several spaces becomes one', () => {
    const r = rig();
    r.host.openForUser(spec([{ ...LIST, filter: true }]), {});
    r.show();
    r.time.advance(600);
    r.host.paste('a     b');
    expect(
      currentStep(
        r.host.getSnapshot().frame ??
          (() => {
            throw new Error('open');
          })(),
      ).state.filter,
    ).toBe('a b');
  });
});

describe('a line with no step to go back to closes its popup as it is disarmed (round 3, security L4 and mutant H52)', () => {
  /** A popup whose ONLY step is its confirmation line: a refused `Ctrl+Y` disarms it, and with no step before it that closes the popup. */
  const lineOnly = (): PopupSpec => spec([{ ...LINE, back: undefined }]);

  it('what the command says about the refusal is raised on the host channel, drawn once the popup is gone', () => {
    const r = rig();
    const reasons: string[] = [];
    const closed: string[] = [];
    r.host.openForUser(lineOnly(), {
      chordRefused: (context, reason) => {
        reasons.push(reason);
        context.notify(`Nothing was sent: ${reason}.`);
      },
      closed: (reason) => closed.push(reason),
    });
    r.show();
    r.time.advance(100);
    r.host.input('y', CTRL_Y); // inside the opening settle time: early
    expect(r.host.getSnapshot().open).toBe(false);
    expect(closed).toEqual(['escape']);
    expect(reasons).toEqual(['early']);
    expect(r.notifications.getSnapshot().current?.text).toBe('Nothing was sent: early.');
    // It is the host's: no popup closing later discards it.
    r.host.closeAll('command');
    expect(r.notifications.getSnapshot().current?.text).toBe('Nothing was sent: early.');
  });

  it('the same when the window runs out on it (expired) and when a key typed over it closes it (typed)', () => {
    for (const how of ['expired', 'typed'] as const) {
      const r = rig();
      r.host.openForUser(lineOnly(), {
        chordRefused: (context, reason) => context.notify(`refused: ${reason}`),
      });
      r.show();
      if (how === 'expired') r.time.advance(CHORD_STEP_WINDOW_MS + 1);
      else {
        r.time.advance(600);
        r.host.input('x', {});
      }
      expect(r.host.getSnapshot().open).toBe(false);
      expect(r.notifications.getSnapshot().current?.text).toBe(`refused: ${how}`);
    }
  });

  it('only what the command says in that call: a context it kept says nothing after it', () => {
    const r = rig();
    let kept: PopupContext | undefined;
    r.host.openForUser(lineOnly(), {
      chordRefused: (context) => {
        kept = context;
      },
    });
    r.show();
    r.time.advance(100);
    r.host.input('y', CTRL_Y);
    expect(r.host.getSnapshot().open).toBe(false);
    kept?.notify('a late word');
    expect(r.notifications.getSnapshot().current).toBeUndefined();
    expect(r.notifications.getSnapshot().queued).toBe(0);
  });

  it('a line that goes back to a step keeps its words with its popup (they end when it closes)', () => {
    const r = rig();
    r.host.openForUser(spec([LIST, LINE], { initialStep: 1 }), {
      chordRefused: (context, reason) => context.notify(`refused: ${reason}`),
    });
    r.show();
    r.time.advance(100);
    r.host.input('y', CTRL_Y);
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(0);
    expect(r.host.getSnapshot().notice).toBe('refused: early');
    r.host.closeAll('command');
    expect(r.notifications.getSnapshot().current).toBeUndefined();
  });

  it('H52: the context the command is told with belongs to a closed run: its signal is aborted and it moves nothing', () => {
    const r = rig();
    const signals: boolean[] = [];
    const steps: (number | undefined)[] = [];
    const moved: boolean[] = [];
    r.host.openForUser(lineOnly(), {
      chordRefused: (context) => {
        signals.push(context.signal.aborted);
        steps.push(context.stepIndex());
        moved.push(context.goToStep(0));
      },
    });
    r.show();
    r.time.advance(100);
    r.host.input('y', CTRL_Y);
    expect(signals).toEqual([true]);
    expect(steps).toEqual([undefined]);
    expect(moved).toEqual([false]);
  });
});
