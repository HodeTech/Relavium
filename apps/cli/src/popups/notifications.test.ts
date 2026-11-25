/**
 * The one notification channel ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §6):
 * transient, one at a time and in order, never twice, held while a chord or secret surface is shown (and shown again, whole, after), with its
 * time on an injected timer.
 */
import { describe, expect, it } from 'vitest';

import {
  createNotificationChannel,
  NOTIFICATION_MS,
  notificationText,
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
