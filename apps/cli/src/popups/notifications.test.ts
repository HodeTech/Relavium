/**
 * The one notification channel ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §6):
 * transient, one at a time and in order, never twice, held while a chord or secret surface is shown (and shown again, whole, after), with its
 * time on an injected timer.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createNotificationChannel,
  NOTIFICATION_MS,
  notificationText,
  unrefTimer,
  type Schedule,
} from './notifications.js';

/** A manual timer: what is due runs when the test moves time. */
function clock() {
  let now = 0;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const schedule: Schedule = (run, ms) => {
    const timer = { at: now + ms, run, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      now = due.at;
      due.run();
    }
    now = end;
  };
  return { schedule, advance, pending: () => timers.filter((timer) => !timer.cancelled).length };
}

const text = (channel: ReturnType<typeof createNotificationChannel>): string | undefined =>
  channel.getSnapshot().current?.text;

describe('one at a time, in order, for its few seconds', () => {
  it('shows the first at once, the next when it expires, and nothing after the last', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('first');
    channel.notify('second');
    expect(text(channel)).toBe('first');
    expect(channel.getSnapshot().queued).toBe(1);
    time.advance(NOTIFICATION_MS - 1);
    expect(text(channel)).toBe('first');
    time.advance(1);
    expect(text(channel)).toBe('second');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBeUndefined();
    expect(time.pending()).toBe(0);
  });

  it('is about three seconds', () => {
    expect(NOTIFICATION_MS).toBe(3000);
  });
});

describe('never twice', () => {
  it('a text that is shown or waiting is not queued again', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('/doctor cannot open now: a turn is running');
    channel.notify('/doctor cannot open now: a turn is running');
    channel.notify('other');
    channel.notify('other');
    expect(channel.getSnapshot().queued).toBe(1);
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('other');
  });
});

describe('held while a chord or secret surface is shown', () => {
  it('queues what arrives, and shows nothing until the hold ends', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.hold(true);
    channel.notify('waits');
    expect(text(channel)).toBeUndefined();
    time.advance(NOTIFICATION_MS * 5);
    expect(channel.getSnapshot().queued).toBe(1);
    channel.hold(false);
    expect(text(channel)).toBe('waits');
  });

  it('puts the one that was showing back at the front, and shows it again whole when the hold ends (nobody said it was seen)', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('one');
    channel.notify('two');
    time.advance(NOTIFICATION_MS - 100);
    channel.hold(true);
    expect(text(channel)).toBeUndefined();
    time.advance(10_000);
    channel.hold(false);
    expect(text(channel)).toBe('one');
    time.advance(NOTIFICATION_MS - 1);
    expect(text(channel), 'shown whole again, not for the 100 ms it had left').toBe('one');
    time.advance(1);
    expect(text(channel)).toBe('two');
  });
});

describe('a notification that was seen is spent; what a popup raised goes with it (MVP-11 step 4 round 2, observation #1)', () => {
  it('one a frame showed (`seen`) is dropped when a hold begins, not replayed; the next one waits its turn', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('one');
    channel.notify('two');
    time.advance(1000);
    channel.seen('one');
    channel.hold(true);
    expect(text(channel)).toBeUndefined();
    expect(channel.getSnapshot().queued).toBe(1);
    time.advance(10_000);
    channel.hold(false);
    expect(text(channel)).toBe('two');
    time.advance(NOTIFICATION_MS);
    expect(text(channel), 'the seen one is never shown again').toBeUndefined();
  });

  it('only the one showing is marked, by its own text: another text marks nothing', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('one');
    channel.seen('two');
    channel.hold(true);
    channel.hold(false);
    expect(text(channel)).toBe('one');
  });

  it('the mark belongs to the one that was showing: the next one is unseen until it is shown', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('one');
    channel.notify('two');
    channel.seen('one');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('two');
    channel.hold(true);
    channel.hold(false);
    expect(text(channel), 'two was never seen: it is shown again').toBe('two');
  });

  it('`discard` drops what one popup raised, showing or waiting, and nothing else', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const popup = {};
    const other = {};
    channel.notify('the popup says', popup);
    channel.notify('the host says');
    channel.notify('the popup again', popup);
    channel.notify('another popup', other);
    expect(text(channel)).toBe('the popup says');
    const before = channel.getSnapshot();
    channel.discard(popup);
    expect(channel.getSnapshot()).not.toBe(before);
    expect(text(channel)).toBe('the host says');
    expect(channel.getSnapshot().queued).toBe(1);
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('another popup');
    // Nothing of that popup's to drop: nothing changes, and no listener is woken.
    const quiet = channel.getSnapshot();
    channel.discard(popup);
    expect(channel.getSnapshot()).toBe(quiet);
    expect(time.pending()).toBe(1);
  });

  it('a discard of what only waits is published too (the count of what waits changed)', () => {
    const channel = createNotificationChannel({ schedule: clock().schedule });
    const popup = {};
    channel.notify('the host says');
    channel.notify('the popup says', popup);
    const listener = vi.fn();
    channel.subscribe(listener);
    expect(channel.getSnapshot().queued).toBe(1);
    channel.discard(popup);
    expect(channel.getSnapshot().queued).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(text(channel)).toBe('the host says');
  });

  it('a discarded one showing gives its row and its timer to the next at once', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const popup = {};
    channel.notify('the popup says', popup);
    channel.notify('next');
    time.advance(2000);
    channel.discard(popup);
    expect(text(channel)).toBe('next');
    expect(time.pending()).toBe(1);
    time.advance(NOTIFICATION_MS - 1);
    expect(text(channel), 'the next one has its own three seconds').toBe('next');
  });
});

describe('the production timer (C38)', () => {
  it('never keeps the process alive (it is unref’d) and cancels', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const fired = vi.fn();
    try {
      const cancel = unrefTimer(fired, 100_000);
      expect(spy).toHaveBeenCalledOnce();
      const handle: unknown = spy.mock.results[0]?.value;
      const isTimer = (value: unknown): value is NodeJS.Timeout =>
        typeof value === 'object' && value !== null && 'hasRef' in value;
      if (!isTimer(handle)) throw new Error('setTimeout returned no timer');
      expect(handle.hasRef()).toBe(false);
      cancel();
      expect(fired).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('what it shows is safe on the row it is drawn on: the author-text floor (MVP-11 step 4 review)', () => {
  // Built at runtime (no contiguous secret literal: leakwatch).
  const ANTHROPIC = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'].join('-');
  const GOOGLE = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('');

  it('removes a control sequence, an OSC and an answer chord, and keeps the product’s own key tokens and separator as written', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('\u001b[31mred\u001b[0m [Ctrl+Y] Allow · now');
    expect(text(channel)).toBe('red [[chord]] Allow · now');
    channel.dispose();
    const next = createNotificationChannel({ schedule: time.schedule });
    next.notify('\u001b]0;pwned\u0007Deep check not confirmed. Nothing was sent; [d] asks again.');
    expect(text(next)).toBe('Deep check not confirmed. Nothing was sent; [d] asks again.');
    const sep = createNotificationChannel({ schedule: time.schedule });
    sep.notify('Resized · key cleared, paste it again');
    expect(text(sep)).toBe('Resized · key cleared, paste it again');
  });

  it('scrubs a key a provider or a project could have put in it (an Anthropic key, a Google key)', () => {
    for (const key of [ANTHROPIC, GOOGLE]) {
      const channel = createNotificationChannel({ schedule: clock().schedule });
      channel.notify(`The provider said: ${key} is not valid.`);
      const shown = text(channel) ?? '';
      expect(shown).not.toContain(key);
      expect(shown).not.toContain(key.slice(4, 20));
      expect(shown.startsWith('The provider said:')).toBe(true);
    }
  });

  it('removes the invisible characters and blanks a host glyph', () => {
    const channel = createNotificationChannel({ schedule: clock().schedule });
    channel.notify('a\u200bb\u202ec ✓ done');
    const shown = text(channel) ?? '';
    expect(shown).not.toMatch(/[\u200b\u202e✓]/u);
    expect(shown.startsWith('abc')).toBe(true);
  });

  it('folds a line or paragraph separator to a space (a terminal draws it as nothing, the width measure as a column)', () => {
    const channel = createNotificationChannel({ schedule: clock().schedule });
    channel.notify(`one${String.fromCharCode(0x2028)}two${String.fromCharCode(0x2029)}three`);
    expect(text(channel)).toBe('one two three');
    expect(notificationText(`x${String.fromCharCode(0x2028)}`)).toBe('x');
  });

  it('ignores an empty text', () => {
    const channel = createNotificationChannel({ schedule: clock().schedule });
    channel.notify('   ');
    expect(channel.getSnapshot()).toEqual({ current: undefined, queued: 0, held: false });
  });
});

describe('the snapshot and the lifetime', () => {
  it('the snapshot is reference-stable until what the hint row draws changes', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const before = channel.getSnapshot();
    channel.hold(false);
    expect(channel.getSnapshot()).toBe(before);
    channel.notify('x');
    expect(channel.getSnapshot()).not.toBe(before);
  });

  it('N14: a hold that changes nothing else is still a new snapshot, heard by a listener (`held` is what the hold tests read)', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const heard = vi.fn();
    channel.subscribe(heard);
    const before = channel.getSnapshot();
    channel.popupHold(true);
    expect(channel.getSnapshot()).not.toBe(before);
    expect(channel.getSnapshot()).toEqual({ current: undefined, queued: 0, held: true });
    expect(heard).toHaveBeenCalledOnce();
    channel.popupHold(undefined);
    expect(channel.getSnapshot().held).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('dispose drops what waits and leaves no timer', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('a');
    channel.notify('b');
    channel.dispose();
    expect(time.pending()).toBe(0);
    expect(channel.getSnapshot().current).toBeUndefined();
    channel.notify('after');
    expect(channel.getSnapshot().current).toBeUndefined();
  });
});

describe('the popup’s hold: while a popup is open it decides alone (MVP-11 step 4 review)', () => {
  it('lets a notification through while the host holds its hint row, and holds it while the popup says so', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    // The host holds: inline, an open popup replaces the hint row.
    channel.hold(true);
    channel.notify('copied');
    expect(text(channel)).toBeUndefined();
    // A popup opens and draws the notification in its own legend row.
    channel.popupHold(false);
    expect(text(channel)).toBe('copied');
    expect(channel.getSnapshot().held).toBe(false);
    // Its step offers a chord answer: held, and the one showing goes back to the front.
    time.advance(1000);
    channel.popupHold(true);
    expect(text(channel)).toBeUndefined();
    expect(channel.getSnapshot()).toMatchObject({ held: true, queued: 1 });
    channel.popupHold(false);
    expect(text(channel)).toBe('copied');
    // The popup closes: the host's hold applies again.
    channel.popupHold(undefined);
    expect(text(channel)).toBeUndefined();
    expect(channel.getSnapshot().held).toBe(true);
    channel.hold(false);
    expect(text(channel)).toBe('copied');
  });

  it('a popup that holds overrides a host that does not', () => {
    const channel = createNotificationChannel({ schedule: clock().schedule });
    channel.popupHold(true);
    channel.notify('later');
    expect(text(channel)).toBeUndefined();
    channel.hold(false);
    expect(
      text(channel),
      'the host releasing changes nothing while the popup holds',
    ).toBeUndefined();
    channel.popupHold(undefined);
    expect(text(channel)).toBe('later');
  });
});
