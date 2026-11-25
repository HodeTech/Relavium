/**
 * The one notification channel ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §6):
 * transient, one at a time and in order, never twice, held while a chord or secret surface is shown (and shown again, whole, after), with its
 * time on an injected timer.
 */
import { describe, expect, it } from 'vitest';

import { createNotificationChannel, NOTIFICATION_MS, type Schedule } from './notifications.js';

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

  it('puts the one that was showing back at the front, and shows it again whole when the hold ends', () => {
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

describe('what it shows is safe on the hint row', () => {
  it('sanitises a control sequence and makes a key token and a separator inert', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notify('\u001b[31mred\u001b[0m [Ctrl+Y] Allow · now');
    expect(text(channel)).toBe('red (Ctrl+Y) Allow - now');
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
