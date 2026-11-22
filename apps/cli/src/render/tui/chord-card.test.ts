/**
 * The chord card: a native card answered by `Ctrl+Y` and `Ctrl+N` alone
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * The channel is driven without a terminal and with an injected clock, so every guard is measured in exact milliseconds. Each timing
 * rule is tested with the OTHER layers switched off (`0` switches a layer off), so a test names one rule and fails when that rule, and
 * only that rule, stops holding.
 */

import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { flush } from './harness-util.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_BACK,
  NATIVE_PROMPT_CANCEL,
  type NativePromptEscape,
} from './native-prompt-channel.js';
import type { ApprovalGuard } from './tool-review-model.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ctrl: Key = { ...none, ctrl: true };

/** Every timing layer off: what is left is the chord itself and the painted frame. */
const OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };
/** One layer on, the rest off. */
const only = (layer: keyof Omit<ApprovalGuard, 'confirmAlways'>, ms: number): ApprovalGuard => ({
  ...OFF,
  [layer]: ms,
});

function fixture(guard?: ApprovalGuard) {
  let now = 0;
  const channel = createNativePromptChannel({
    now: () => now,
    ...(guard === undefined ? {} : { guard }),
  });
  let painted = true;
  channel.ui.bindVisibility((snapshot) => painted && snapshot === channel.ui.getSnapshot());
  channel.flow.begin();
  return {
    ...channel,
    at: (ms: number): void => {
      now = ms;
    },
    paint: (visible: boolean): void => {
      painted = visible;
    },
    /** Open a card; the result records whether and how it settled. */
    ask: (escape?: NativePromptEscape) => {
      const result = { done: false, value: undefined as unknown };
      void channel.flow
        .chord({
          message: 'Allow it on this machine?',
          details: ['argument  --flag'],
          allow: 'Allow',
          deny: 'Refuse',
          ...(escape === undefined ? {} : { escape }),
        })
        .then((value) => {
          result.done = true;
          result.value = value;
        });
      return result;
    },
    /** The host acknowledged the card's current frame. */
    show: (): void => {
      channel.ui.shown(channel.ui.getSnapshot());
    },
    chord: (letter: 'y' | 'n'): void => {
      channel.ui.input(letter, ctrl);
    },
  };
}

describe('the chord card answers only with a Ctrl chord', () => {
  it('Ctrl+Y allows and Ctrl+N denies once the card is painted and has settled', async () => {
    const f = fixture();
    const allow = f.ask();
    f.at(0);
    f.show();
    f.at(10_000);
    f.chord('y');
    await flush();
    expect(allow).toEqual({ done: true, value: 'allow' });
    f.at(20_000);
    const deny = f.ask();
    f.at(30_000);
    f.chord('n');
    await flush();
    expect(deny).toEqual({ done: true, value: 'deny' });
  });

  it.each(['y', 'Y', 'n', 'N', ' ', 'a', '1'])(
    'a bare %j answers nothing, whatever the timing',
    async (letter) => {
      const f = fixture(OFF);
      const card = f.ask();
      f.at(1);
      f.show();
      f.at(10_000);
      f.ui.input(letter, none);
      await flush();
      expect(card.done).toBe(false);
      // The card is still alive: a real chord answers it.
      f.chord('y');
      await flush();
      expect(card).toEqual({ done: true, value: 'allow' });
    },
  );

  it('Enter, Tab, the arrows and a shifted letter answer nothing', async () => {
    const f = fixture(OFF);
    const card = f.ask();
    f.show();
    for (const key of [
      { ...none, return: true },
      { ...none, tab: true },
      { ...none, upArrow: true },
      { ...none, downArrow: true },
      { ...none, shift: true },
    ])
      f.ui.input('', key);
    f.ui.input('Y', { ...none, shift: true });
    await flush();
    expect(card.done).toBe(false);
  });

  it('pasted text answers nothing, however it spells a chord', async () => {
    const f = fixture(OFF);
    const card = f.ask();
    f.show();
    for (const text of ['y', 'n', 'yes', '\x19', '\x0e', 'Ctrl+Y', '\x1b[200~y\x1b[201~'])
      expect(f.ui.paste(text)).toBe(true);
    await flush();
    expect(card.done).toBe(false);
    expect(f.ui.getSnapshot().kind).toBe('chord');
  });

  it('a run of text that carries the chord letter is not a key', async () => {
    const f = fixture(OFF);
    const card = f.ask();
    f.show();
    f.ui.input('yy', ctrl);
    f.ui.input('y\r', ctrl);
    f.ui.input('ny', ctrl);
    await flush();
    expect(card.done).toBe(false);
  });

  it('a meta chord is not a chord: it cancels the card like every prompt, and never allows or denies', async () => {
    for (const letter of ['y', 'n']) {
      const f = fixture(OFF);
      const card = f.ask();
      f.show();
      f.ui.input(letter, { ...ctrl, meta: true });
      await flush();
      expect(card).toEqual({ done: true, value: NATIVE_PROMPT_CANCEL });
    }
  });

  it('Esc and Ctrl+C decide nothing: the card settles as cancelled, never as an answer', async () => {
    for (const press of [
      (f: ReturnType<typeof fixture>) => f.ui.input('', { ...none, escape: true }),
      (f: ReturnType<typeof fixture>) => f.ui.input('c', ctrl),
      // How the hosts forward a Ctrl+C they could not deliver: an ESC with the real key.
      (f: ReturnType<typeof fixture>) => f.ui.input('\x1b', ctrl),
    ]) {
      const f = fixture(OFF);
      const card = f.ask();
      f.show();
      press(f);
      await flush();
      expect(card).toEqual({ done: true, value: NATIVE_PROMPT_CANCEL });
      expect(f.ui.signal()?.aborted).toBe(true);
    }
  });

  it('Esc on a card opened to step back settles it as BACK and leaves the flow open', async () => {
    const f = fixture(OFF);
    const card = f.ask('back');
    f.show();
    f.ui.input('', { ...none, escape: true });
    await flush();
    expect(card).toEqual({ done: true, value: NATIVE_PROMPT_BACK });
    expect(f.ui.signal()?.aborted).toBe(false);
    expect(f.ui.getSnapshot().active).toBe(true);
  });
});

describe('the chord card passes the approval guards, one layer at a time', () => {
  it('dwell: an allow before the frame has been on screen for the settle time is refused', async () => {
    const f = fixture(only('settleMs', 400));
    const card = f.ask();
    f.at(100);
    f.show();
    f.at(300); // 200 ms after the frame was acknowledged
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
    f.at(600); // 500 ms after
    f.chord('y');
    await flush();
    expect(card).toEqual({ done: true, value: 'allow' });
  });

  it('dwell: a frame that was never acknowledged has not been on screen at all', async () => {
    const f = fixture(only('settleMs', 400));
    const card = f.ask();
    f.at(60_000);
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
  });

  it('dwell: a new frame (a resize, a lost screen) restarts it, and a frame acknowledged for another card does not count', async () => {
    const f = fixture(only('settleMs', 400));
    const first = f.ask();
    const stale = f.ui.getSnapshot();
    f.at(100);
    f.show();
    f.at(1000);
    f.show(); // the frame was drawn again
    f.at(1200);
    f.chord('y');
    await flush();
    expect(first.done).toBe(false);
    f.at(1500);
    f.chord('y');
    await flush();
    expect(first.done).toBe(true);
    // A second card: the first card's acknowledgement is not its own.
    f.at(2000);
    const second = f.ask();
    f.ui.shown(stale);
    f.at(9000);
    f.chord('y');
    await flush();
    expect(second.done).toBe(false);
  });

  it('quiet gap: an allow right on the heels of another key is refused, and each refusal restarts the gap', async () => {
    const f = fixture(only('quietMs', 300));
    const card = f.ask();
    f.show();
    f.at(1000);
    f.ui.input('x', none);
    f.at(1100);
    f.chord('y'); // 100 ms after the previous key
    f.at(1300);
    f.chord('y'); // 200 ms after the refused one
    await flush();
    expect(card.done).toBe(false);
    f.at(1700); // 400 ms after the last key
    f.chord('y');
    await flush();
    expect(card).toEqual({ done: true, value: 'allow' });
  });

  it('typeahead: an allow soon after typing is refused, and a refused allow is not typing', async () => {
    const f = fixture(only('typeaheadMs', 1500));
    const card = f.ask();
    f.show();
    f.at(0);
    f.ui.input('x', none); // typing at the card
    f.at(1000);
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
    f.at(1600); // 1600 ms after the typing, 600 after the refused chord
    f.chord('y');
    await flush();
    expect(card).toEqual({ done: true, value: 'allow' });
  });

  it('typeahead: a paste is typing', async () => {
    const f = fixture(only('typeaheadMs', 1500));
    const card = f.ask();
    f.show();
    f.at(0);
    f.ui.paste('some text');
    f.at(1000);
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
    f.at(1600);
    f.chord('y');
    await flush();
    expect(card.done).toBe(true);
  });

  it('typeahead: what was typed into the PREVIOUS prompt, and its Enter, still counts at this card', async () => {
    const f = fixture(only('typeaheadMs', 1500));
    const field = f.flow.password({ message: 'Secret' });
    f.at(0);
    f.ui.input('a', none);
    f.at(1);
    f.ui.input('', { ...none, return: true });
    expect(await field).toBe('a');
    const card = f.ask();
    f.show();
    f.at(1000);
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
    f.at(1600);
    f.chord('y');
    await flush();
    expect(card.done).toBe(true);
  });

  it('lockout: a card resolved by a key holds the next card shut, and a key held down keeps it shut', async () => {
    const f = fixture(only('lockoutMs', 2000));
    const first = f.ask();
    f.show();
    f.at(0);
    f.chord('n');
    await flush();
    expect(first).toEqual({ done: true, value: 'deny' });
    const second = f.ask();
    f.show();
    f.at(1500); // inside the window
    f.chord('y');
    f.at(3000); // 1500 ms after the refused repeat: the window restarted at 1500
    f.chord('y');
    f.at(4500); // and again at 3000
    f.chord('y');
    await flush();
    expect(second.done).toBe(false);
    f.at(6600); // released for 2100 ms
    f.chord('y');
    await flush();
    expect(second).toEqual({ done: true, value: 'allow' });
  });

  it('lockout: a prompt of any kind resolved by a key starts it', async () => {
    const f = fixture(only('lockoutMs', 2000));
    const choice = f.flow.select({ message: 'Pick', options: [{ value: 'a', label: 'A' }] });
    f.at(0);
    f.ui.input('', { ...none, return: true });
    expect(await choice).toBe('a');
    const card = f.ask();
    f.show();
    f.at(1000);
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
  });
});

describe('the chord card needs its frame on screen', () => {
  it('an allow on a frame that is not painted is refused, however long the card has been up', async () => {
    const f = fixture(OFF);
    const card = f.ask();
    f.show();
    f.paint(false);
    f.at(60_000);
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
    f.paint(true);
    f.chord('y');
    await flush();
    expect(card).toEqual({ done: true, value: 'allow' });
  });

  it('a channel whose host has bound no visibility never allows', async () => {
    const f = fixture(OFF);
    f.ui.bindVisibility(undefined);
    const card = f.ask();
    f.show();
    f.at(60_000);
    f.chord('y');
    await flush();
    expect(card.done).toBe(false);
  });
});

describe('a rejection is never delayed', () => {
  it('Ctrl+N denies at once: before the dwell, on the heels of typing, inside a lockout and on an unpainted frame', async () => {
    const f = fixture(); // every real layer on
    const card = f.ask();
    f.at(10);
    f.ui.input('x', none);
    f.ui.paste('typing');
    f.paint(false);
    f.at(11); // no frame acknowledged, a key 1 ms ago, typing 1 ms ago
    f.chord('n');
    await flush();
    expect(card).toEqual({ done: true, value: 'deny' });
  });

  it('a rejection settles the card with deny and is counted as a key that resolved it', async () => {
    const f = fixture();
    const card = f.ask();
    f.at(5);
    f.chord('n');
    await flush();
    expect(card).toEqual({ done: true, value: 'deny' });
  });
});
