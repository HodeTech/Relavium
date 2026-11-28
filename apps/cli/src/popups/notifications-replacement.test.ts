/**
 * Review round 3: a popup's newer word on itself replaces the older one it DREW (O2-6) in the PLACE the older one held, and leaves no timer of
 * the older behind; what the host and other popups said waits its turn behind it. Only a popup's own word about itself is replaced (S3-1): the
 * Home's announcements and every host word queue in order, and a word that was never drawn is never dropped for a newer one (R3-S-1c).
 */
import { describe, expect, it } from 'vitest';

import { createNotificationChannel, NOTIFICATION_MS, type Schedule } from './notifications.js';

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

/** The popup host's acknowledgement of a frame that drew the word showing now (`PopupHost.shown` → `channel.seen`). */
const drawn = (channel: ReturnType<typeof createNotificationChannel>): void => {
  const showing = text(channel);
  if (showing !== undefined) channel.seen(showing);
};

describe('a popup’s newer word replaces the older one it drew', () => {
  it('it takes the place at once, ahead of the words that were waiting, and they follow in order', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const popup = {};
    channel.notifyFromPopup('popup says one', popup);
    drawn(channel);
    channel.notify('host says', undefined);
    channel.notify('other popup says', {});
    channel.notifyFromPopup('popup says two', popup);
    expect(text(channel)).toBe('popup says two');
    expect(channel.getSnapshot().queued).toBe(2);
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('host says');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('other popup says');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBeUndefined();
  });

  it('the older word leaves no timer behind, and the newer one lasts its own three seconds from when it came', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const popup = {};
    channel.notifyFromPopup('popup says one', popup);
    drawn(channel);
    time.advance(2000);
    channel.notifyFromPopup('popup says two', popup);
    expect(time.pending(), 'one timer: the newer word’s').toBe(1);
    time.advance(NOTIFICATION_MS - 1);
    expect(text(channel)).toBe('popup says two');
    time.advance(1);
    expect(text(channel)).toBeUndefined();
    expect(time.pending()).toBe(0);
  });

  it('a word that was not drawn yet is never replaced: the newer one waits its turn behind it (R3-S-1c)', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const popup = {};
    channel.notifyFromPopup('Nothing withdrawn: too soon.', popup);
    channel.notifyFromPopup('Withdrawn x.', popup);
    expect(text(channel), 'the refusal is not dropped for the newer word').toBe(
      'Nothing withdrawn: too soon.',
    );
    expect(channel.getSnapshot().queued).toBe(1);
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('Withdrawn x.');
  });

  it('a word still waiting behind a host word is shown, in turn, whatever the popup says later: it was never drawn', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const popup = {};
    channel.notify('Copied 12 characters.');
    channel.notifyFromPopup('Nothing withdrawn: too soon.', popup);
    channel.notifyFromPopup('Copied 40 characters.', popup);
    expect(channel.getSnapshot().queued).toBe(2);
    const shown: (string | undefined)[] = [text(channel)];
    for (let step = 0; step < 3; step += 1) {
      time.advance(NOTIFICATION_MS);
      if (text(channel) === 'Nothing withdrawn: too soon.') drawn(channel);
      shown.push(text(channel));
    }
    expect(shown).toEqual([
      'Copied 12 characters.',
      'Nothing withdrawn: too soon.',
      'Copied 40 characters.',
      undefined,
    ]);
  });

  it('a newer word does not jump a word of the same popup that still waits: the order they were said in is kept', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const popup = {};
    channel.notifyFromPopup('one', popup);
    channel.notifyFromPopup('two', popup); // not drawn yet: it waits behind `one`
    drawn(channel); // `one` is read now
    channel.notifyFromPopup('three', popup);
    expect(text(channel), '`one` was read, but `two` still waits: `three` does not pass it').toBe(
      'one',
    );
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('two');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('three');
  });

  it('another popup’s word is never replaced by this popup’s', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    channel.notifyFromPopup('the first popup says', {});
    drawn(channel);
    channel.notifyFromPopup('the second popup says', {});
    expect(text(channel)).toBe('the first popup says');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('the second popup says');
  });

  it('only a popup’s own word is replaced: a word the host said with the popup as its source queues in order', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const source = {};
    channel.notify('the host says one', source);
    drawn(channel);
    channel.notifyFromPopup('the popup says', source);
    channel.notify('the host says two', source);
    expect(text(channel)).toBe('the host says one');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('the popup says');
    time.advance(NOTIFICATION_MS);
    expect(text(channel)).toBe('the host says two');
  });
});

describe('the Home’s own words and every host word queue in order (S3-1)', () => {
  it('a word the Home announced under one source is shown its whole three seconds before the next, drawn or not', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const home = {};
    channel.notify('The draft looks like a key. It was not kept.', home);
    drawn(channel);
    time.advance(2900);
    channel.notify('Provider setup: saved.', home);
    expect(text(channel), 'the first is read to its end').toBe(
      'The draft looks like a key. It was not kept.',
    );
    time.advance(100);
    expect(text(channel)).toBe('Provider setup: saved.');
    time.advance(NOTIFICATION_MS - 1);
    expect(text(channel), 'and the second has its own three seconds').toBe(
      'Provider setup: saved.',
    );
    time.advance(1);
    expect(text(channel)).toBeUndefined();
  });

  it('held through a flow, the first word is shown again whole when the hold ends, and the later word waits its turn behind it', () => {
    const time = clock();
    const channel = createNotificationChannel({ schedule: time.schedule });
    const home = {};
    channel.hold(true);
    channel.notify('The draft looks like a key. It was not kept.', home);
    channel.notify('Provider setup: saved.', home);
    expect(text(channel)).toBeUndefined();
    channel.hold(false);
    expect(text(channel)).toBe('The draft looks like a key. It was not kept.');
    time.advance(NOTIFICATION_MS - 1);
    expect(text(channel)).toBe('The draft looks like a key. It was not kept.');
    time.advance(1);
    expect(text(channel)).toBe('Provider setup: saved.');
  });
});
