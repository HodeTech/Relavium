/**
 * What a popup says, and when it is spent ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "Notifications"; MVP-11 step 4, review round 2, observation #1, the `t-20` and `t-2d` captures): a refusal the person already read was
 * pushed back to the front of the queue when a line held the channel, and replayed whole later, on the hint row of the Home where its `[d]`
 * means nothing, ahead of the fresh reason. Now:
 *
 * - a notification drawn in a popup frame the slot acknowledged is SEEN, and a hold that begins after it drops it instead of replaying it;
 * - a notification a popup raised (`PopupContext.notify`) is that popup's: it is discarded, shown or waiting, when the popup closes, and a
 *   popup that is closed says nothing more; the host's own words stay.
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { createNotificationChannel, NOTIFICATION_MS, type Schedule } from './notifications.js';
import {
  createPopupHost,
  type ChordRefusal,
  type PopupContext,
  type PopupHandlers,
} from './popup-host.js';
import type { PopupKey, PopupSpec, PopupStep } from './popup-reducer.js';

const CTRL_Y: PopupKey = { ctrl: true };
const ESC: PopupKey = { escape: true };

const LIST: PopupStep = {
  name: 'Checks',
  content: {
    kind: 'list',
    rows: [
      { id: 'a', label: 'alpha' },
      { id: 'b', label: 'bravo' },
    ],
  },
  controls: [
    { key: 'd', verb: 'arm' },
    { key: 'c', verb: 'copy' },
  ],
};
const LINE: PopupStep = {
  name: 'Confirm',
  content: { kind: 'report', lines: ['Sends one request to:', '  https://a.example'] },
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
};
const spec = (initialStep = 0): PopupSpec => ({
  id: 'notify',
  title: '/notify',
  origin: 'home',
  rail: 'path',
  steps: [LIST, LINE],
  initialStep,
});

/** What the popup's command says for each reason, as the doctor says it (the words are the command's; these are the test's). */
const said = (reason: ChordRefusal): string => `Not confirmed: ${reason}. [d] asks again.`;

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

function rig() {
  const time = timers();
  const notifications = createNotificationChannel({ schedule: time.schedule });
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    notifications,
    history: createChordHistory(),
    placement: 'overlay',
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => 18);
  const handlers: PopupHandlers = {
    control: (context, key) => {
      if (key === 'd') context.goToStep(1);
      if (key === 'c') context.notify('Copied 12 characters.');
    },
    chordRefused: (context, reason) => {
      context.notify(said(reason));
    },
  };
  const open = (initialStep = 0): PopupContext => {
    const opened = host.openForUser(spec(initialStep), handlers);
    if (!opened.opened) throw new Error('open');
    return opened.context;
  };
  return {
    host,
    time,
    notifications,
    open,
    /** The current frame was measured and flushed (the slot's acknowledgement). */
    show: (): void => host.shown(host.getSnapshot()),
    current: (): string | undefined => notifications.getSnapshot().current?.text,
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
  };
}

describe('what a popup says belongs to it', () => {
  it('is discarded when the popup closes, shown or waiting; the host’s own words stay', () => {
    const r = rig();
    const context = r.open();
    r.show();
    context.notify('first of the popup');
    context.notify('second of the popup');
    r.notifications.notify('the host says');
    expect(r.current()).toBe('first of the popup');
    r.time.advance(600);
    r.host.input('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.current()).toBe('the host says');
    r.time.advance(NOTIFICATION_MS);
    expect(r.current()).toBeUndefined();
  });

  it('a popup that is closed says nothing more (a late notify lands nowhere)', () => {
    const r = rig();
    const context = r.open();
    r.show();
    r.time.advance(600);
    r.host.input('', ESC);
    context.notify('too late');
    expect(r.current()).toBeUndefined();
    expect(r.notifications.getSnapshot().queued).toBe(0);
  });

  it('the host’s refusal of a second open, drawn in the open popup, outlives it', () => {
    const r = rig();
    r.open();
    r.show();
    expect(r.host.openForUser(spec()).opened).toBe(false);
    const refused = r.current();
    expect(refused).toContain('cannot open now');
    r.time.advance(600);
    r.host.input('', ESC);
    expect(r.current()).toBe(refused);
  });
});

describe('a notification seen in an acknowledged frame is spent by a hold', () => {
  it('drawn in the popup’s legend row and acknowledged, then a line holds the channel: dropped, never replayed', () => {
    const r = rig();
    r.open();
    r.show();
    r.time.advance(600);
    r.host.input('c', {});
    expect(r.host.getSnapshot().notice).toBe('Copied 12 characters.');
    r.show(); // the frame with the notice in its legend row is on screen
    r.host.input('d', {}); // the line holds the channel
    expect(r.current()).toBeUndefined();
    r.time.advance(600);
    r.host.input('', ESC); // back: the hold ends
    expect(r.step()).toBe(0);
    expect(r.current()).toBeUndefined();
    expect(r.notifications.getSnapshot().queued).toBe(0);
  });

  it('the control: one no acknowledged frame showed goes back to the front and is shown again when the hold ends', () => {
    const r = rig();
    r.open();
    r.show();
    r.time.advance(600);
    r.notifications.notify('the host says');
    // No acknowledgement of the frame that carries it: nobody can say it was read.
    r.host.input('d', {});
    expect(r.current()).toBeUndefined();
    r.time.advance(600);
    r.host.input('', ESC);
    expect(r.current()).toBe('the host says');
  });
});

describe('the captured sequences (MVP-11 step 4 round 2, observation t-20 and t-2d)', () => {
  it('t-20: a refused Ctrl+Y, Esc, the line reopened, Esc on it: the old refusal is never shown again', () => {
    const r = rig();
    r.open(1);
    r.host.input('y', CTRL_Y); // at once: refused, the line disarmed, the reason in the legend row
    expect(r.step()).toBe(0);
    expect(r.current()).toBe(said('unseen'));
    r.show();
    r.time.advance(300);
    r.host.input('', ESC); // the popup closes: what it said goes with it
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.current()).toBeUndefined();
    r.time.advance(200);
    r.open(1); // `/doctor --deep` again: the line holds the channel
    r.show();
    r.time.advance(1300);
    r.host.input('', ESC); // Esc on the line: silent
    expect(r.step()).toBe(0);
    expect(r.current()).toBeUndefined();
    r.time.advance(3100);
    expect(r.current()).toBeUndefined();
  });

  it('t-2d: a refused Ctrl+Y, `[d]` once its frame is up, then a stray key: the screen says "typed", not the old reason', () => {
    const r = rig();
    r.open(1);
    r.show();
    r.time.advance(75);
    r.host.input('y', CTRL_Y); // inside the popup's settle time: refused
    expect(r.current()).toBe(said('early'));
    r.show(); // the checks, with the reason in the legend row, on screen
    r.time.advance(1700);
    r.host.input('d', {}); // the line holds the channel: the reason was read, so it is spent
    r.show();
    r.time.advance(1600);
    r.host.input('x', {}); // a stray key disarms the line and is told
    expect(r.step()).toBe(0);
    expect(r.current()).toBe(said('typed'));
    r.time.advance(NOTIFICATION_MS);
    expect(r.current()).toBeUndefined();
    expect(r.notifications.getSnapshot().queued).toBe(0);
  });
});

describe('`[d]` inside the popup’s first half second after a refused Ctrl+Y (observation t-2c, documented in the host)', () => {
  it('is dropped by the opening guard like any answer there; from the half second on it arms the line', () => {
    const r = rig();
    const control = vi.fn();
    const opened = r.host.openForUser(spec(1), {
      control: (context, key) => {
        control(key);
        if (key === 'd') context.goToStep(1);
      },
    });
    expect(opened.opened).toBe(true);
    r.show();
    r.time.advance(75);
    r.host.input('y', CTRL_Y);
    expect(r.step()).toBe(0);
    r.show();
    r.time.advance(300); // 375 ms after the popup appeared
    r.host.input('d', {});
    expect(control).not.toHaveBeenCalled();
    expect(r.step()).toBe(0);
    r.time.advance(125); // 500 ms
    r.host.input('d', {});
    expect(control).toHaveBeenCalledWith('d');
    expect(r.step()).toBe(1);
  });
});
