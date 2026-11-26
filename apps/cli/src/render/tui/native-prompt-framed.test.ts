/**
 * The native prompt channel as a popup body, its rules on a manual clock ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §4; MVP-11 unit 6, sub-step 6.1):
 *
 * - **The opening guard of a framed flow**: a key before the flow's first framed frame answers nothing and is typing; nothing answers for
 *   `POPUP_SELECT_SETTLE_MS` after that frame appeared; an answer needs a key that arrived after it; the arrows, `Esc` and `Ctrl+C` act at once;
 *   per flow, reset by `begin`, and only while a descriptor is set.
 * - **The guarded option**: its `Enter` counts only when the approval card's layers pass (`GUARDED_SELECT_GUARD`: dwell 800 ms from the
 *   acknowledged frame, quiet 300 ms, the typing window 1.5 s, the lockout 2 s that an early `Enter` restarts); a held key at any repeat rate
 *   never answers it, and one patient press after the lockout does.
 * - **Arrows stop at the ends** of a framed select and a framed picker; a card wraps, as it always did.
 * - **Any resize clears a secret**: a masked field that held anything is emptied and says `NATIVE_PROMPT_RESIZED`; nothing of it survives.
 *
 * The acknowledgement is played by hand here (`ui.bindVisibility`, `ui.shown`): what it does for real is pinned in its own suites and in the
 * mounted tests (`native-prompt-framed-hosts.test.tsx`).
 */
import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import { createChordHistory, type ChordHistory } from './chord-guard.js';
import {
  createNativePromptAcknowledgement,
  type NativePromptAcknowledgement,
} from './native-prompt-acknowledgement.js';
import {
  createNativePromptChannel,
  GUARDED_SELECT_GUARD,
  NATIVE_PROMPT_BACK,
  NATIVE_PROMPT_CANCEL,
  NATIVE_PROMPT_RESIZED,
  STEP_BACK_HOLD_MS,
  type NativePopupDescriptor,
  type NativePromptOption,
  type NativePromptSnapshot,
} from './native-prompt-channel.js';
import {
  APPROVAL_CONFIRM_MIN_MS,
  APPROVAL_LOCKOUT_MS,
  APPROVAL_QUIET_MS,
  APPROVAL_TYPEAHEAD_MS,
} from './tool-review-model.js';

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
const ENTER: Key = { ...none, return: true };
const DOWN: Key = { ...none, downArrow: true };
const UP: Key = { ...none, upArrow: true };
const ESC: Key = { ...none, escape: true };
const CTRL: Key = { ...none, ctrl: true };
const REPEAT_ENTER: Key = { ...ENTER, eventType: 'repeat' };
const REPEAT_CTRL: Key = { ...CTRL, eventType: 'repeat' };

const DESCRIPTOR: NativePopupDescriptor = {
  title: '/flow',
  origin: 'home',
  stepIndex: 0,
  stepCount: 2,
  stepNames: ['One', 'Two'],
  exitLabel: 'close',
  depth: 1,
};

const PLAIN: readonly NativePromptOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
];
const CONSENT: readonly NativePromptOption[] = [
  { value: 'use', label: 'Use it', guarded: true },
  { value: 'later', label: 'Not now' },
];

/** A settled promise's value, or `PENDING`: what a prompt has answered so far, read after the microtasks ran. */
const PENDING = Symbol('pending');
async function settled<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => setImmediate(() => resolve(PENDING))),
  ]);
}

/** The channel on a manual clock, its acknowledgement played by hand: `show()` is "this exact snapshot was just measured and flushed". */
function rig(options: { framed?: boolean; settleMs?: number; history?: ChordHistory } = {}) {
  let clock = 10_000;
  const history = options.history ?? createChordHistory();
  const channel = createNativePromptChannel({
    now: () => clock,
    history,
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  });
  let visible = true;
  channel.ui.bindVisibility(() => visible);
  channel.flow.begin();
  if (options.framed !== false) channel.flow.popup?.(DESCRIPTOR);
  return {
    channel,
    history,
    now: (): number => clock,
    at: (ms: number): void => {
      clock = ms;
    },
    advance: (ms: number): void => {
      clock += ms;
    },
    setVisible: (value: boolean): void => {
      visible = value;
    },
    show: (): void => channel.ui.shown(channel.ui.getSnapshot()),
    key: (input: string, key: Key): boolean => channel.ui.input(input, key),
    snapshot: (): NativePromptSnapshot => channel.ui.getSnapshot(),
  };
}

describe('the opening guard of a framed flow (ADR-0148 §3)', () => {
  it('an Enter inside the settle answers nothing and is typing; the same key after it answers', async () => {
    const r = rig();
    const answer = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    const appeared = r.now();
    r.at(appeared + POPUP_SELECT_SETTLE_MS - 1);
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    expect(r.history.lastForeignKeyAt).toBe(appeared + POPUP_SELECT_SETTLE_MS - 1);
    r.at(appeared + POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await answer).toBe('a');
  });

  it('the arrows move at once, and Esc and Ctrl+C leave at once', async () => {
    const r = rig();
    const answer = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(1);
    r.key('', DOWN);
    expect(r.snapshot().selected).toBe(1);
    r.advance(1);
    r.key('', ESC);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);

    const again = rig();
    const second = again.channel.flow.text({ message: 'Name' });
    again.show();
    again.advance(1);
    again.key('c', CTRL);
    expect(await second).toBe(NATIVE_PROMPT_CANCEL);
  });

  it('before the flow’s first framed frame nothing acts, a navigation key included; at the very moment it appeared an answer is refused (rule 3)', async () => {
    const r = rig({ settleMs: 0 });
    const answer = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.key('', DOWN);
    expect(r.snapshot().selected).toBe(0);
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    r.show();
    r.key('', ENTER); // the same millisecond the frame appeared: a key already on its way
    expect(await settled(answer)).toBe(PENDING);
    r.advance(1);
    r.key('', ENTER);
    expect(await answer).toBe('a');
  });

  it('a raw chunk that holds a carriage return (`key.return` false) is an answer: inside the settle it answers nothing, after it, it does', async () => {
    const r = rig();
    const answer = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(100);
    r.key('y\r', none);
    expect(await settled(answer)).toBe(PENDING);
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('y\r', none);
    expect(await answer).toBe('a');
  });

  it('runs per FLOW: a later prompt of the same flow is not settled again, and `begin` starts a new guard', async () => {
    const r = rig();
    const first = r.channel.flow.select({ message: 'First', options: PLAIN });
    r.show();
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await first).toBe('a');
    const second = r.channel.flow.select({ message: 'Second', options: PLAIN });
    r.show();
    r.advance(1);
    r.key('', ENTER);
    expect(await second).toBe('a');
    await r.channel.flow.end();
    r.channel.flow.begin();
    r.channel.flow.popup?.(DESCRIPTOR);
    const third = r.channel.flow.select({ message: 'Third', options: PLAIN });
    r.show();
    r.advance(1);
    r.key('', ENTER);
    expect(await settled(third)).toBe(PENDING);
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await third).toBe('a');
  });

  it('runs only while a descriptor is set: a card answers at once, as it always did', async () => {
    const r = rig({ framed: false });
    const answer = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(1);
    r.key('', ENTER);
    expect(await answer).toBe('a');
  });

  it('the first framed frame starts it even when it is a wait, and a frame shown before the descriptor was set does not', async () => {
    const r = rig({ framed: false });
    r.channel.flow.busy('Loading');
    r.show(); // a card's frame: no descriptor yet
    r.advance(1000);
    r.channel.flow.popup?.(DESCRIPTOR);
    r.show(); // the busy frame, now framed: the flow appeared here
    const appeared = r.now();
    const answer = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.at(appeared + POPUP_SELECT_SETTLE_MS - 1);
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    r.at(appeared + POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await answer).toBe('a');
  });

  it('a field takes typing at once after it appeared, and its Enter waits out the settle', async () => {
    const r = rig();
    const answer = r.channel.flow.text({ message: 'Name' });
    r.key('x', none); // before the frame: nothing
    r.show();
    const appeared = r.now();
    r.advance(1);
    r.key('a', none);
    r.key('b', none);
    expect(r.snapshot().display).toBe('ab');
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    r.at(appeared + POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await answer).toBe('ab');
  });

  it('a paste before the flow’s first frame types nothing; one after it does', async () => {
    const r = rig();
    const answer = r.channel.flow.password({ message: 'Key' });
    r.channel.ui.paste('early-paste');
    expect(r.snapshot().display).toBe('');
    r.show();
    r.advance(1);
    r.channel.ui.paste('late');
    expect(r.snapshot().display).toBe('••••');
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await answer).toBe('late');
  });

  it('a framed chord card: a Ctrl+Y inside the settle is a refused affirmative that restarts a running lockout; its Ctrl+N is never delayed', async () => {
    const r = rig({ settleMs: POPUP_SELECT_SETTLE_MS });
    const first = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await first).toBe('a');
    const resolvedAt = r.now();
    const chord = r.channel.flow.chord({ message: 'Write?', allow: 'Write', deny: 'Skip' });
    r.show();
    // A new flow would have a new opening guard; within this one, a chord step right after is guarded by the card's own layers.
    r.advance(100);
    r.key('y', CTRL);
    expect(await settled(chord)).toBe(PENDING);
    expect(r.history.lastResolvedAt).toBe(resolvedAt + 100);
    r.key('n', CTRL);
    expect(await chord).toBe('deny');

    const fresh = rig();
    const card = fresh.channel.flow.chord({ message: 'Write?', allow: 'Write', deny: 'Skip' });
    fresh.show();
    fresh.advance(1);
    fresh.key('n', CTRL);
    expect(await card).toBe('deny');
  });

  it('framed, a new flow’s opening guard drops an early Ctrl+Y on a chord step as a refused affirmative (the lockout restarts inside it), never as typing', async () => {
    const r = rig({ settleMs: POPUP_SELECT_SETTLE_MS });
    const first = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await first).toBe('a');
    await r.channel.flow.end();
    r.channel.flow.begin();
    r.channel.flow.popup?.(DESCRIPTOR);
    const card = r.channel.flow.chord({ message: 'Write?', allow: 'Write', deny: 'Skip' });
    r.show();
    const foreignBefore = r.history.lastForeignKeyAt;
    r.advance(100);
    r.key('y', CTRL);
    expect(await settled(card)).toBe(PENDING);
    expect(r.history.lastResolvedAt).toBe(r.now());
    expect(r.history.lastForeignKeyAt).toBe(foreignBefore);
    r.channel.flow.cancel();
    expect(await card).toBe(NATIVE_PROMPT_CANCEL);
  });

  it('a framed chord card’s Ctrl+Y inside the opening settle answers nothing even when every card layer would pass', async () => {
    const r = rig({ settleMs: 5000 });
    const card = r.channel.flow.chord({ message: 'Write?', allow: 'Write', deny: 'Skip' });
    r.show();
    r.advance(3000);
    r.key('y', CTRL);
    expect(await settled(card)).toBe(PENDING);
    r.advance(2000);
    r.advance(APPROVAL_LOCKOUT_MS);
    r.key('y', CTRL);
    expect(await card).toBe('allow');
  });
});

describe('a guarded option (the consent’s affirmative, ADR-0148 §3)', () => {
  /** A select of the consent's two options, opened on `Use it`, its frame shown at a known moment, with no key in its history. */
  function consent(options: { framed?: boolean; initial?: string } = {}) {
    const r = rig({ framed: options.framed ?? false, settleMs: 0 });
    const answer = r.channel.flow.select({
      message: 'OPENAI_API_KEY is available for OpenAI. Allow this source?',
      options: CONSENT,
      initialValue: options.initial ?? 'use',
    });
    r.show();
    return { ...r, answer, shownAt: r.now() };
  }

  it('the numbers are the approval card’s, with the confirmation dwell', () => {
    expect(GUARDED_SELECT_GUARD).toEqual({
      settleMs: APPROVAL_CONFIRM_MIN_MS,
      quietMs: APPROVAL_QUIET_MS,
      typeaheadMs: APPROVAL_TYPEAHEAD_MS,
      lockoutMs: APPROVAL_LOCKOUT_MS,
    });
    expect([
      APPROVAL_CONFIRM_MIN_MS,
      APPROVAL_QUIET_MS,
      APPROVAL_TYPEAHEAD_MS,
      APPROVAL_LOCKOUT_MS,
    ]).toEqual([800, 300, 1500, 2000]);
  });

  it('the dwell: an Enter before 800 ms of the acknowledged frame is dropped, one at 800 ms answers (the select opened long before)', async () => {
    // The lockout runs from the select's opening too (see below), so the frame is shown here past it: what is left is the dwell alone.
    const r = rig({ framed: false, settleMs: 0 });
    const answer = r.channel.flow.select({ message: 'Allow?', options: CONSENT });
    r.advance(APPROVAL_LOCKOUT_MS + 500);
    r.show();
    const shownAt = r.now();
    r.at(shownAt + APPROVAL_CONFIRM_MIN_MS - 1);
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    r.at(shownAt + APPROVAL_CONFIRM_MIN_MS + APPROVAL_QUIET_MS);
    r.key('', ENTER);
    expect(await answer).toBe('use');
  });

  it('the lockout runs from the moment the guarded select opened: a deliberate Enter needs about two seconds after it appeared', async () => {
    const c = consent();
    const openedAt = c.shownAt;
    // Every other layer is clear at 1.999 s (the dwell 800 ms, the quiet gap, no typing, no answer before): only the opening lockout refuses.
    c.at(openedAt + APPROVAL_LOCKOUT_MS - 1);
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    // That refusal came inside the lockout and restarted it.
    expect(c.history.lastResolvedAt).toBe(openedAt + APPROVAL_LOCKOUT_MS - 1);
    c.at(openedAt + APPROVAL_LOCKOUT_MS - 1 + APPROVAL_LOCKOUT_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
  });

  it('a frame never acknowledged has no dwell at all: nothing answers', async () => {
    const r = rig({ framed: false });
    const answer = r.channel.flow.select({ message: 'Allow?', options: CONSENT });
    r.advance(60_000);
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
  });

  it('the quiet gap: a key of any kind 299 ms before refuses it; 300 ms after the last key is enough', async () => {
    const c = consent({ framed: true });
    c.advance(5000);
    c.key('', UP); // already on the first option: a key, which moves nothing (and is not typing on a guarded select)
    const keyAt = c.now();
    c.at(keyAt + APPROVAL_QUIET_MS - 1);
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    // the refused Enter is a key too: the gap is counted from it
    c.advance(APPROVAL_QUIET_MS - 1);
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    c.advance(APPROVAL_QUIET_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
  });

  it('the typing window: a letter typed at the prompt 1.5 s before refuses it; after 1.5 s it answers', async () => {
    const c = consent();
    c.advance(5000);
    c.key('x', none);
    const typedAt = c.now();
    c.at(typedAt + APPROVAL_TYPEAHEAD_MS - 1);
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    c.at(typedAt + APPROVAL_TYPEAHEAD_MS + APPROVAL_QUIET_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
  });

  it('the typing window counts the keys the host dropped before the frame was on screen (`unseenInput`)', async () => {
    const c = consent();
    c.advance(5000);
    c.channel.ui.unseenInput('h', none);
    const typedAt = c.now();
    c.at(typedAt + APPROVAL_TYPEAHEAD_MS - 1);
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    c.at(typedAt + APPROVAL_TYPEAHEAD_MS + APPROVAL_QUIET_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
  });

  it('on a guarded select the arrows are the person using it, not typing: ↓ ↑ then a patient Enter answers', async () => {
    const c = consent({ initial: 'later' });
    c.advance(5000);
    c.key('', UP);
    c.show();
    const shown = c.now();
    c.at(shown + APPROVAL_CONFIRM_MIN_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
    expect(c.history.lastForeignKeyAt).toBe(Number.NEGATIVE_INFINITY);
  });

  it('the lockout: an Enter 2 s after the answer before it is refused and RESTARTS it; a patient one after the restart answers', async () => {
    const r = rig({ framed: false });
    const first = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(1);
    r.key('', ENTER);
    expect(await first).toBe('a');
    const resolvedAt = r.now();
    const answer = r.channel.flow.select({ message: 'Allow?', options: CONSENT });
    r.show();
    r.at(resolvedAt + APPROVAL_LOCKOUT_MS - 1);
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    expect(r.history.lastResolvedAt).toBe(resolvedAt + APPROVAL_LOCKOUT_MS - 1);
    r.at(resolvedAt + APPROVAL_LOCKOUT_MS + 500); // past the first lockout, inside the restarted one
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    const restarted = r.now();
    r.at(restarted + APPROVAL_LOCKOUT_MS);
    r.key('', ENTER);
    expect(await answer).toBe('use');
  });

  it('a refused Enter inside the two seconds after the select opened restarts the lockout; one after them, refused by another layer, does not', async () => {
    const c = consent();
    c.advance(APPROVAL_CONFIRM_MIN_MS - 100); // inside the dwell AND the opening lockout
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    expect(c.history.lastResolvedAt).toBe(c.now());
    const restarted = c.now();
    c.at(restarted + APPROVAL_LOCKOUT_MS);
    c.setVisible(false); // refused by the frame, outside any lockout: no restart
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    expect(c.history.lastResolvedAt).toBe(restarted);
    c.setVisible(true);
    c.advance(APPROVAL_QUIET_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
  });

  it('the frame must be on screen now, and a kitty repeat is never an answer', async () => {
    const c = consent();
    c.advance(5000);
    c.setVisible(false);
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    c.setVisible(true);
    c.advance(APPROVAL_QUIET_MS);
    c.key('', REPEAT_ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    c.advance(APPROVAL_QUIET_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
  });

  it('a new frame (the highlight moved onto it) restarts the dwell', async () => {
    const c = consent({ initial: 'later' });
    c.advance(5000);
    c.key('', UP);
    c.show();
    const moved = c.now();
    c.at(moved + APPROVAL_CONFIRM_MIN_MS - 1);
    c.key('', ENTER);
    expect(await settled(c.answer)).toBe(PENDING);
    c.at(moved + APPROVAL_CONFIRM_MIN_MS + APPROVAL_QUIET_MS);
    c.key('', ENTER);
    expect(await c.answer).toBe('use');
  });

  it('every other option answers on Enter as before', async () => {
    const c = consent({ initial: 'later' });
    c.advance(1);
    c.key('', ENTER);
    expect(await c.answer).toBe('later');
  });

  it('a dropped Enter (or an unnamed dropped key) inside the lockout restarts it; a dropped letter does not', () => {
    const r = rig({ framed: false });
    void r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(1);
    r.key('', ENTER);
    void r.channel.flow.select({ message: 'Allow?', options: CONSENT });
    r.show();
    r.advance(500);
    r.channel.ui.unseenInput('q', none);
    const afterLetter = r.history.lastResolvedAt;
    r.advance(500);
    r.channel.ui.unseenInput('\r', ENTER);
    expect(r.history.lastResolvedAt).toBe(r.now());
    expect(r.history.lastResolvedAt).toBeGreaterThan(afterLetter);
    r.advance(500);
    r.channel.ui.unseenInput();
    expect(r.history.lastResolvedAt).toBe(r.now());
  });

  it('framed, the opening guard drops an early Enter on it as a refused affirmative (the lockout restarts inside it)', async () => {
    const r = rig({ settleMs: POPUP_SELECT_SETTLE_MS });
    const first = r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER);
    expect(await first).toBe('a');
    await r.channel.flow.end();
    // A new flow: its own opening guard, the lockout of the answer above still running.
    r.channel.flow.begin();
    r.channel.flow.popup?.(DESCRIPTOR);
    const answer = r.channel.flow.select({ message: 'Allow?', options: CONSENT });
    r.show();
    const foreignBefore = r.history.lastForeignKeyAt;
    r.advance(100);
    r.key('', ENTER);
    expect(await settled(answer)).toBe(PENDING);
    expect(r.history.lastResolvedAt).toBe(r.now());
    // a refused affirmative, not typing
    expect(r.history.lastForeignKeyAt).toBe(foreignBefore);
  });

  describe('on a select opened with `escape: back` (a failed key check’s `Retry the check`, guarded and highlighted)', () => {
    const RETRY: readonly NativePromptOption[] = [
      { value: 'retry', label: 'Retry the check', guarded: true },
      { value: 'save', label: 'Save it anyway' },
    ];
    const retryAfterTheCheck = (r: ReturnType<typeof rig>): Promise<string | symbol> => {
      const retry = r.channel.flow.select({
        message: 'The check failed',
        options: RETRY,
        escape: 'back',
      });
      r.show();
      return retry;
    };

    /**
     * The key step's `Enter` sent the key and stays down: its repeats land on the check's wait as typing, then on the retry select that the
     * failed check opens 700 ms later. Returns whether a repeat answered it; one patient press after the key is let go must.
     */
    async function heldFromTheKeyStep(delay: number, rate: number): Promise<boolean> {
      const r = rig({ settleMs: POPUP_SELECT_SETTLE_MS });
      const key = r.channel.flow.password({ message: 'Paste your key', escape: 'back' });
      r.show();
      r.advance(POPUP_SELECT_SETTLE_MS);
      r.channel.ui.paste('sk-test');
      r.advance(APPROVAL_QUIET_MS);
      r.key('', ENTER);
      expect(await key).toBe('sk-test');
      const t0 = r.now();
      r.channel.flow.busy('Checking your key · one request to api.example.com');
      r.show();
      let retry: Promise<string | symbol> | undefined;
      let last = t0;
      for (let at = t0 + delay; at <= t0 + 8000; at += rate) {
        r.at(at);
        last = at;
        if (retry === undefined && at >= t0 + 700) retry = retryAfterTheCheck(r);
        r.key('', ENTER);
      }
      if (retry === undefined) throw new Error('the retry select never opened');
      const answered = (await settled(retry)) !== PENDING;
      r.at(last + APPROVAL_LOCKOUT_MS);
      r.key('', ENTER);
      expect(await retry, `the patient press after ${String(delay)}/${String(rate)}`).toBe('retry');
      return answered;
    }

    it('the Enter held from the key step never re-sends the check; a patient Enter after it was let go does', async () => {
      const answered: string[] = [];
      for (const delay of [250, 1000] as const)
        for (const rate of [30, 450, 1800] as const)
          if (await heldFromTheKeyStep(delay, rate))
            answered.push(`${String(delay)}/${String(rate)}`);
      expect(answered).toEqual([]);
    });

    it('Esc steps back at once: never delayed by the guarded row it sits on', async () => {
      const r = rig({ settleMs: POPUP_SELECT_SETTLE_MS });
      const retry = retryAfterTheCheck(r);
      r.advance(1);
      r.key('', ESC);
      expect(await retry).toBe(NATIVE_PROMPT_BACK);
    });
  });

  describe('a held key never answers it; one patient press after it was let go does', () => {
    const DELAYS = [250, 400, 516, 660, 1000, 1400, 1800] as const;
    const RATES = [30, 60, 100, 300, 450, 700, 1000, 1100, 1400, 1800] as const;
    const HELD_FOR_MS = 8000;
    const cases = DELAYS.flatMap((delay) =>
      RATES.flatMap((rate) =>
        (['plain', 'kitty', 'unseen'] as const).map((mode) => [delay, rate, mode] as const),
      ),
    );

    it.each(cases)('initial delay %i ms, rate %i ms, %s repeats', async (delay, rate, mode) => {
      const r = rig({ settleMs: POPUP_SELECT_SETTLE_MS });
      // The press that answered the step before, at t0.
      const before = r.channel.flow.select({ message: 'Provider', options: PLAIN });
      r.show();
      r.advance(POPUP_SELECT_SETTLE_MS);
      r.key('', ENTER);
      expect(await before).toBe('a');
      const t0 = r.now();
      const answer = r.channel.flow.select({ message: 'Allow?', options: CONSENT });
      r.advance(16);
      r.show();
      let last = t0;
      let index = 0;
      for (let at = t0 + delay; at <= t0 + HELD_FOR_MS; at += rate, index += 1) {
        r.at(at);
        last = at;
        // A realistic host drops one repeat in four as unseen (a notice landing, a resize, a re-render) in the `unseen` mode.
        if (mode === 'unseen' && index % 4 === 1) {
          r.setVisible(false);
          r.channel.ui.unseenInput('\r', ENTER);
          r.setVisible(true);
        } else r.key('', mode === 'kitty' ? REPEAT_ENTER : ENTER);
      }
      expect(await settled(answer)).toBe(PENDING);
      // Let go, wait out the lockout from the last repeat, press once.
      r.at(last + APPROVAL_LOCKOUT_MS);
      r.key('', ENTER);
      expect(await answer).toBe('use');
    });
  });
});

describe('arrows stop at the ends of a framed list; a card wraps (ADR-0148 §3)', () => {
  it('a framed select: ↑ on the first and ↓ on the last stay, and publish nothing', async () => {
    const r = rig();
    void r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.advance(1);
    const first = r.snapshot();
    r.key('', UP);
    expect(r.snapshot()).toBe(first);
    r.key('', DOWN);
    r.key('', DOWN);
    expect(r.snapshot().selected).toBe(2);
    const last = r.snapshot();
    r.key('', DOWN);
    expect(r.snapshot()).toBe(last);
    r.key('', UP);
    expect(r.snapshot().selected).toBe(1);
    await r.channel.flow.end();
  });

  it('a card select wraps, as it always did', async () => {
    const r = rig({ framed: false });
    void r.channel.flow.select({ message: 'Pick', options: PLAIN });
    r.show();
    r.key('', UP);
    expect(r.snapshot().selected).toBe(2);
    r.key('', DOWN);
    expect(r.snapshot().selected).toBe(0);
    await r.channel.flow.end();
  });

  it.each([true, false])(
    'the picker, framed=%s: stops at its ends only when framed',
    async (framed) => {
      const r = rig({ framed });
      void r.channel.flow.pick({
        message: 'Resume a session',
        load: () =>
          Promise.resolve({
            options: [
              { value: 's1', label: 'one' },
              { value: 's2', label: 'two' },
            ],
          }),
      });
      for (let tries = 0; tries < 20 && r.snapshot().options.length === 0; tries += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(r.snapshot().kind).toBe('picker');
      r.show();
      r.advance(1);
      r.key('', UP);
      expect(r.snapshot().selected).toBe(framed ? 0 : 1);
      r.key('', DOWN);
      expect(r.snapshot().selected).toBe(framed ? 1 : 0);
      r.key('', DOWN);
      expect(r.snapshot().selected).toBe(framed ? 1 : 1);
      await r.channel.flow.end();
    },
  );
});

describe('any resize clears a secret (ADR-0148 §4)', () => {
  it.each([true, false])(
    'framed=%s: a masked field that held something is emptied, says so, and only what is typed after it is answered',
    async (framed) => {
      const r = rig({ framed, settleMs: 0 });
      const answer = r.channel.flow.password({
        message: 'Paste your key',
        validate: (value) => (value === '' ? 'required' : undefined),
      });
      r.show();
      r.advance(1);
      r.channel.ui.paste('sk-old-secret-4829');
      expect(r.snapshot().display).not.toBe('');
      const seen: NativePromptSnapshot[] = [];
      const stop = r.channel.ui.subscribe(() => seen.push(r.snapshot()));
      r.channel.ui.resized();
      expect(r.snapshot().display).toBe('');
      expect(r.snapshot().error).toBe(NATIVE_PROMPT_RESIZED);
      r.key('', ENTER); // nothing typed since: a valid value is required, the old one is gone
      expect(await settled(answer)).toBe(PENDING);
      r.channel.ui.paste('sk-new');
      expect(r.snapshot().error).toBe('');
      r.key('', ENTER);
      expect(await answer).toBe('sk-new');
      stop();
      for (const snapshot of seen) expect(JSON.stringify(snapshot)).not.toContain('4829');
      expect(seen[0]?.display).toBe('');
    },
  );

  it('an empty field, a text field and a closed prompt are left as they are', async () => {
    const r = rig({ settleMs: 0 });
    const secret = r.channel.flow.password({ message: 'Key' });
    r.show();
    const empty = r.snapshot();
    r.channel.ui.resized();
    expect(r.snapshot()).toBe(empty);
    r.channel.flow.cancel();
    expect(await secret).toBe(NATIVE_PROMPT_CANCEL);
    const t = rig({ settleMs: 0 });
    void t.channel.flow.text({ message: 'Name' });
    t.show();
    t.advance(1);
    t.key('a', none);
    const typed = t.snapshot();
    t.channel.ui.resized();
    expect(t.snapshot()).toBe(typed);
  });

  it('a rejected paste is cleared too (the latch drops), so the field takes a paste again', async () => {
    const r = rig({ settleMs: 0, framed: false });
    const answer = r.channel.flow.password({ message: 'Key' });
    r.show();
    r.channel.ui.paste('bad\u0007key');
    expect(r.snapshot().error).not.toBe('');
    r.channel.ui.resized();
    expect(r.snapshot().error).toBe(NATIVE_PROMPT_RESIZED);
    r.channel.ui.paste('good');
    r.key('', ENTER);
    expect(await answer).toBe('good');
  });

  describe('the acknowledgement tells the channel of a size it has not seen', () => {
    function acked() {
      let size = { cols: 80, rows: 24 };
      const r = rig({ settleMs: 0, framed: false });
      const ack: NativePromptAcknowledgement = createNativePromptAcknowledgement(
        r.channel.ui,
        () => size,
      );
      return {
        r,
        ack,
        resize: (next: { cols: number; rows: number }): void => {
          size = next;
        },
      };
    }

    it('on the invalidation a host’s resize listener makes: a new size clears, the same size does not', async () => {
      const { r, ack, resize } = acked();
      const answer = r.channel.flow.password({ message: 'Key' });
      r.channel.ui.paste('secret-one');
      ack.invalidate();
      expect(r.snapshot().display).not.toBe('');
      resize({ cols: 100, rows: 30 });
      ack.invalidate();
      expect(r.snapshot().display).toBe('');
      expect(r.snapshot().error).toBe(NATIVE_PROMPT_RESIZED);
      r.channel.ui.paste('secret-two');
      ack.invalidate();
      expect(r.snapshot().display).not.toBe('');
      r.channel.flow.cancel();
      expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
      ack.dispose();
    });

    it('at any size, larger or smaller, above the floor or below it', () => {
      for (const next of [
        { cols: 81, rows: 24 },
        { cols: 80, rows: 25 },
        { cols: 60, rows: 20 },
        { cols: 200, rows: 60 },
      ]) {
        const { r, ack, resize } = acked();
        void r.channel.flow.password({ message: 'Key' });
        r.channel.ui.paste('secret');
        resize(next);
        ack.invalidate();
        expect(r.snapshot().display, JSON.stringify(next)).toBe('');
        ack.dispose();
      }
    });

    it('a commit at a new size clears it too (the backstop for a host that would not invalidate)', () => {
      const { r, ack, resize } = acked();
      void r.channel.flow.password({ message: 'Key' });
      r.channel.ui.paste('secret');
      resize({ cols: 90, rows: 30 });
      ack.commit(r.snapshot(), null, () => Promise.resolve());
      expect(r.snapshot().display).toBe('');
      ack.dispose();
    });
  });
});

/**
 * The held-key cases the 6.1 sitting found (F1, F2): a guarded select that no answer came just before (the first prompt of a flow opened by
 * the composer's `Enter`, which the landing stamps as a key and never as a resolution; one reached after a wait with the key held through it),
 * and a chord card after another chord card answered by the held `Ctrl+Y`, one repeat of which is dropped as unseen. Each case holds the key for
 * eight seconds at an operating system's initial delay and repeat rate, then lets go and presses once: the held key never answers, the patient
 * press does.
 */
describe('a held key never answers what it was not pressed for (F1, F2)', () => {
  const DELAYS = [250, 400, 516, 660, 1000, 1400, 1800] as const;
  const RATES = [30, 60, 100, 300, 450, 700, 1000, 1100, 1400, 1800] as const;
  const ACKS = [16, 300, 900] as const;
  const HELD_FOR_MS = 8000;
  const MODES = ['legacy', 'kitty'] as const;

  /**
   * Hold `Enter` from `from` (the first repeat one initial delay later, then one per `rate`) to `from + HELD_FOR_MS`, a repeat the host could not
   * deliver (before `visibleFrom`) dropped as unseen, as the host drops it. Returns the time of the last repeat.
   */
  function holdEnter(
    r: ReturnType<typeof rig>,
    from: number,
    delay: number,
    rate: number,
    mode: (typeof MODES)[number],
    visibleFrom: () => number,
  ): number {
    let last = from;
    for (let at = from + delay; at <= from + HELD_FOR_MS; at += rate) {
      r.at(at);
      last = at;
      const key = mode === 'kitty' ? REPEAT_ENTER : ENTER;
      if (at < visibleFrom()) r.channel.ui.unseenInput('\r', key);
      else r.key('', key);
    }
    return last;
  }

  const firstPromptCases = [true, false].flatMap((framed) =>
    ACKS.flatMap((ack) => MODES.map((mode) => [framed, ack, mode] as const)),
  );

  it.each(firstPromptCases)(
    'framed=%s, frame acknowledged at %i ms, %s repeats: the guarded select is the first prompt of a flow a composer Enter opened',
    async (framed, ack, mode) => {
      const answered: string[] = [];
      for (const delay of DELAYS)
        for (const rate of RATES) {
          const history = createChordHistory();
          const r = rig({ framed, history });
          const t0 = r.now();
          history.previousKeyAt = t0; // the composer's Enter: a key the landing stamped, not a resolution
          const answer = r.channel.flow.select({ message: 'Allow?', options: CONSENT });
          let shownAt = Number.POSITIVE_INFINITY;
          const last = holdEnter(r, t0, delay, rate, mode, () => {
            if (r.now() >= t0 + ack && shownAt === Number.POSITIVE_INFINITY) {
              const now = r.now();
              r.at(t0 + ack);
              r.show();
              r.at(now);
              shownAt = t0 + ack;
            }
            return shownAt;
          });
          if ((await settled(answer)) !== PENDING)
            answered.push(`${String(delay)}/${String(rate)}`);
          if (shownAt === Number.POSITIVE_INFINITY) r.show();
          r.at(last + APPROVAL_LOCKOUT_MS);
          r.key('', ENTER);
          expect(await answer, `the patient press after ${String(delay)}/${String(rate)}`).toBe(
            'use',
          );
        }
      expect(answered).toEqual([]);
    },
  );

  const waitCases = [2500, 4000, 10_000].flatMap((wait) =>
    [true, false].flatMap((framed) =>
      ACKS.flatMap((ack) => MODES.map((mode) => [wait, framed, ack, mode] as const)),
    ),
  );

  it.each(waitCases)(
    'reached after a %i ms wait with the Enter held through it, framed=%s, frame at %i ms, %s repeats',
    async (wait, framed, ack, mode) => {
      const answered: string[] = [];
      for (const delay of DELAYS)
        for (const rate of RATES) {
          const history = createChordHistory();
          const r = rig({ framed, history });
          const t0 = r.now();
          history.previousKeyAt = t0;
          r.channel.flow.busy('Checking your key');
          r.at(t0 + 16);
          r.show(); // the wait is on screen: the flow's first frame
          let answer: Promise<string | symbol> | undefined;
          let shownAt = Number.POSITIVE_INFINITY;
          const last = holdEnter(r, t0, delay, rate, mode, () => {
            const now = r.now();
            if (answer === undefined && now >= t0 + wait) {
              r.at(t0 + wait);
              answer = r.channel.flow.select({ message: 'Allow?', options: CONSENT });
              r.at(now);
            }
            if (
              answer !== undefined &&
              shownAt === Number.POSITIVE_INFINITY &&
              now >= t0 + wait + ack
            ) {
              r.at(t0 + wait + ack);
              r.show();
              r.at(now);
              shownAt = t0 + wait + ack;
            }
            // a key while the wait is on screen is delivered; one between the select's publication and its frame is not
            return answer === undefined ? t0 + 16 : shownAt;
          });
          answer ??= r.channel.flow.select({ message: 'Allow?', options: CONSENT });
          if ((await settled(answer)) !== PENDING)
            answered.push(`${String(delay)}/${String(rate)}`);
          r.show();
          r.at(Math.max(last, r.now()) + APPROVAL_LOCKOUT_MS);
          r.key('', ENTER);
          expect(await answer, `the patient press after ${String(delay)}/${String(rate)}`).toBe(
            'use',
          );
        }
      expect(answered).toEqual([]);
    },
  );

  it('a chord card after one a held Ctrl+Y answered, one repeat dropped as unseen: never answered while held; a patient press after it is', async () => {
    const CHORD_DELAYS = [250, 400, 516, 660, 900, 1000, 1400, 1800] as const;
    const answered: string[] = [];
    for (const delay of CHORD_DELAYS)
      for (const rate of RATES) {
        const r = rig({ framed: false });
        const first = r.channel.flow.chord({ message: 'First?', allow: 'Yes', deny: 'No' });
        r.show();
        r.advance(5000);
        r.key('y', CTRL);
        expect(await first).toBe('allow');
        const t0 = r.now();
        const second = r.channel.flow.chord({ message: 'Second?', allow: 'Yes', deny: 'No' });
        r.at(t0 + 16);
        r.show();
        let index = 0;
        let last = t0;
        for (let at = t0 + delay; at <= t0 + HELD_FOR_MS; at += rate, index += 1) {
          r.at(at);
          last = at;
          if (index === 1) r.channel.ui.unseenInput('y', CTRL);
          else r.key('y', CTRL);
        }
        if ((await settled(second)) !== PENDING) answered.push(`${String(delay)}/${String(rate)}`);
        r.at(last + APPROVAL_LOCKOUT_MS);
        r.key('y', CTRL);
        expect(await second, `the patient press after ${String(delay)}/${String(rate)}`).toBe(
          'allow',
        );
      }
    expect(answered).toEqual([]);
  });

  it('a dropped key on a chord card that is not its Ctrl+Y is typing only: it does not touch a running lockout; a dropped Ctrl+Y restarts it', async () => {
    const r = rig({ framed: false });
    const first = r.channel.flow.chord({ message: 'First?', allow: 'Yes', deny: 'No' });
    r.show();
    r.advance(5000);
    r.key('y', CTRL);
    expect(await first).toBe('allow');
    const resolvedAt = r.history.lastResolvedAt;
    void r.channel.flow.chord({ message: 'Write?', allow: 'Yes', deny: 'No' });
    r.show();
    r.advance(100); // inside the lockout of the answer above
    r.channel.ui.unseenInput('n', CTRL);
    r.channel.ui.unseenInput('x', none);
    expect(r.history.lastResolvedAt).toBe(resolvedAt);
    expect(r.history.lastForeignKeyAt).toBe(r.now());
    r.advance(100);
    r.channel.ui.unseenInput('y', CTRL);
    expect(r.history.lastResolvedAt).toBe(r.now());
  });

  /**
   * Hold `Ctrl+Y` from `from` (the first repeat one initial delay later, then one per `rate`) to `until`, a repeat the host could not deliver
   * (before `visibleFrom`) dropped as unseen, as the host drops it. Returns the time of the last repeat.
   */
  function holdCtrlY(
    r: ReturnType<typeof rig>,
    from: number,
    until: number,
    delay: number,
    rate: number,
    mode: (typeof MODES)[number],
    visibleFrom: () => number,
  ): number {
    let last = from;
    for (let at = from + delay; at <= until; at += rate) {
      r.at(at);
      last = at;
      const key = mode === 'kitty' ? REPEAT_CTRL : CTRL;
      if (at < visibleFrom()) r.channel.ui.unseenInput('y', key);
      else r.key('y', key);
    }
    return last;
  }

  /**
   * Unit 6 round 1 (S2/A1, the hunt of S1): a chord card that is the FIRST prompt of a flow (`/init`, the Defined export, `/run` started by `r` on
   * a workflow with no inputs) had no answer before it, so its lockout ran from nothing: a `Ctrl+Y` held from the moment it appeared answered it
   * once the dwell and the quiet gap had passed (624 of 1,680 held-key configurations on the channel, every legacy one with a repeat gap past the
   * quiet gap). Its lockout now runs from the moment it opened. Framed, the early repeats meet the flow's opening guard (refused there, they
   * restart the lockout); before the frame is on screen, the host drops them as unseen (they restart it too).
   */
  it.each(firstPromptCases)(
    'framed=%s, frame acknowledged at %i ms, %s repeats: a chord card that is the first prompt of a flow a key opened',
    async (framed, ack, mode) => {
      const answered: string[] = [];
      for (const delay of DELAYS)
        for (const rate of RATES) {
          const history = createChordHistory();
          const r = rig({ framed, history });
          const t0 = r.now();
          history.previousKeyAt = t0; // the key that opened the flow: a key, never a resolution
          const card = r.channel.flow.chord({ message: 'Write?', allow: 'Write', deny: 'Skip' });
          // No key lands at the very moment the card appears: the first repeat is the first thing to meet the card, so the path that refuses it
          // (the host's unseen drop before the frame, the flow's opening guard inside its settle, the card itself) is the one that must restart
          // the lockout from the card's opening.
          let shownAt = Number.POSITIVE_INFINITY;
          const last = holdCtrlY(r, t0, t0 + HELD_FOR_MS, delay, rate, mode, () => {
            if (r.now() >= t0 + ack && shownAt === Number.POSITIVE_INFINITY) {
              const now = r.now();
              r.at(t0 + ack);
              r.show();
              r.at(now);
              shownAt = t0 + ack;
            }
            return shownAt;
          });
          if ((await settled(card)) !== PENDING) answered.push(`${String(delay)}/${String(rate)}`);
          if (shownAt === Number.POSITIVE_INFINITY) r.show();
          r.at(last + APPROVAL_LOCKOUT_MS);
          r.key('y', CTRL);
          expect(await card, `the patient press after ${String(delay)}/${String(rate)}`).toBe(
            'allow',
          );
        }
      expect(answered).toEqual([]);
    },
  );

  const chordWaitCases = [300, 1500, 2500, 5000].flatMap((wait) =>
    [true, false].flatMap((framed) =>
      ACKS.flatMap((ack) => MODES.map((mode) => [wait, framed, ack, mode] as const)),
    ),
  );

  /**
   * Unit 6 round 1 (S1): the `Ctrl+Y` that answered one chord card stays down through a wait (`Starting the run…`), and the card that wait raises
   * (the MCP consent card of the start) appears under its repeats. The repeats on the wait are typing only, so once the wait outlasted the
   * lockout of the answer before it nothing was left to hold the next card: the held key answered it. The card's own opening now starts a
   * lockout that each refused repeat restarts. The whole launch over the real `/run` flow is `run-card-cross-lockout.test.ts`'s.
   */
  it.each(chordWaitCases)(
    'a chord card reached after a %i ms wait with the Ctrl+Y that answered the card before held through it, framed=%s, frame at %i ms, %s repeats',
    async (wait, framed, ack, mode) => {
      const answered: string[] = [];
      for (const delay of DELAYS)
        for (const rate of RATES) {
          const r = rig({ framed });
          const first = r.channel.flow.chord({ message: 'Start?', allow: 'Start', deny: 'No' });
          r.show();
          r.advance(5000);
          r.key('y', CTRL); // the deliberate press that the key then stays down after
          expect(await first).toBe('allow');
          const t0 = r.now();
          r.channel.flow.busy('Starting the run…');
          let card: Promise<string | symbol> | undefined;
          let busyShown = false;
          let shownAt = Number.POSITIVE_INFINITY;
          const last = holdCtrlY(r, t0, t0 + wait + HELD_FOR_MS, delay, rate, mode, () => {
            const now = r.now();
            if (!busyShown && now >= t0 + 16) {
              r.at(t0 + 16);
              r.show();
              r.at(now);
              busyShown = true;
            }
            if (card === undefined && now >= t0 + wait) {
              r.at(t0 + wait);
              card = r.channel.flow.chord({ message: 'Allow?', allow: 'Allow', deny: 'Refuse' });
              r.at(now);
            }
            if (
              card !== undefined &&
              shownAt === Number.POSITIVE_INFINITY &&
              now >= t0 + wait + ack
            ) {
              r.at(t0 + wait + ack);
              r.show();
              r.at(now);
              shownAt = t0 + wait + ack;
            }
            // a key while the wait is on screen is delivered (typing); one between the card's publication and its frame is not
            if (card === undefined) return busyShown ? t0 + 16 : Number.POSITIVE_INFINITY;
            return shownAt;
          });
          card ??= r.channel.flow.chord({ message: 'Allow?', allow: 'Allow', deny: 'Refuse' });
          if ((await settled(card)) !== PENDING) answered.push(`${String(delay)}/${String(rate)}`);
          r.show();
          r.at(Math.max(last, r.now()) + APPROVAL_LOCKOUT_MS);
          r.key('y', CTRL);
          expect(await card, `the patient press after ${String(delay)}/${String(rate)}`).toBe(
            'allow',
          );
        }
      expect(answered).toEqual([]);
    },
  );
});

describe('W7 (MVP-11 unit 6, round 1 second pass): a step back needs a key that arrived after the popup appeared (item 4)', () => {
  const PICK_BACK = { message: 'Pick', options: PLAIN, escape: 'back' } as const;

  it('a lone Esc that arrived before the flow’s first framed frame, on a prompt opened to step back, leaves the flow as a cancel, never a step back', async () => {
    const r = rig();
    const answer = r.channel.flow.select(PICK_BACK);
    r.key('', ESC);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
    expect(r.channel.ui.signal()?.aborted).toBe(true);
  });

  it('one forwarded by a host that could not show the frame (`\\x1b` with its key) is a cancel too', async () => {
    const r = rig();
    const answer = r.channel.flow.select(PICK_BACK);
    r.key('\x1b', ESC);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
  });

  it('one at the very moment the frame appeared is a cancel (a key already on its way, rule 3); one a moment after it steps back', async () => {
    const r = rig();
    const answer = r.channel.flow.select(PICK_BACK);
    r.show();
    r.key('', ESC);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);

    const later = rig();
    const back = later.channel.flow.select(PICK_BACK);
    later.show();
    later.advance(1);
    later.key('', ESC);
    expect(await back).toBe(NATIVE_PROMPT_BACK);
    expect(later.channel.ui.signal()?.aborted).toBe(false);
  });

  it('a card (no descriptor: no popup opening) steps back at once, as it always did', async () => {
    const r = rig({ framed: false });
    const answer = r.channel.flow.select(PICK_BACK);
    r.key('', ESC);
    expect(await answer).toBe(NATIVE_PROMPT_BACK);
  });
});

describe('W7 (item 2, O6): a wait that steps back', () => {
  const PICK_BACK = { message: 'Key', options: PLAIN, escape: 'back' } as const;

  /** A framed flow whose first frame has appeared, waiting with a step back; how many times it was taken. */
  function waiting() {
    const r = rig();
    let taken = 0;
    r.channel.flow.busy('Checking your key', {
      onBack: () => {
        taken += 1;
      },
    });
    r.show();
    r.advance(1);
    return { r, taken: (): number => taken };
  }

  it('says `back` on its snapshot; a lone Esc takes the step back once and leaves the flow open; another Esc on the same wait does nothing', () => {
    const { r, taken } = waiting();
    expect(r.snapshot().kind).toBe('busy');
    expect(r.snapshot().escape).toBe('back');
    r.key('', ESC);
    expect(taken()).toBe(1);
    expect(r.channel.ui.signal()?.aborted).toBe(false);
    r.advance(10);
    r.key('', ESC);
    expect(taken()).toBe(1);
    expect(r.channel.ui.signal()?.aborted).toBe(false);
    // Past the hold too: the wait's step back was taken, and it is taken once.
    r.advance(STEP_BACK_HOLD_MS + 10);
    r.key('', ESC);
    expect(taken()).toBe(1);
    expect(r.channel.ui.signal()?.aborted).toBe(false);
  });

  it('`Ctrl+C` on it leaves the flow, and takes no step back', () => {
    const { r, taken } = waiting();
    r.key('c', CTRL);
    expect(r.channel.ui.signal()?.aborted).toBe(true);
    expect(taken()).toBe(0);
  });

  it('a wait with none cancels on Esc, as it always did; a later wait or prompt drops a step back that was not taken', async () => {
    const plain = rig();
    plain.channel.flow.busy('Loading');
    expect(plain.snapshot().escape).toBe('cancel');
    plain.show();
    plain.advance(1);
    plain.key('', ESC);
    expect(plain.channel.ui.signal()?.aborted).toBe(true);

    const { r, taken } = waiting();
    r.channel.flow.busy('Saving');
    expect(r.snapshot().escape).toBe('cancel');
    const { r: other, taken: otherTaken } = waiting();
    const answer = other.channel.flow.select({ message: 'Pick', options: PLAIN });
    other.show();
    other.advance(1);
    other.key('', ESC);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
    expect(taken()).toBe(0);
    expect(otherTaken()).toBe(0);
  });

  it('the hold: an Esc on the prompt the step back opened is refused for the hold and restarts it; one after it steps back; the hold goes with that prompt', async () => {
    const { r } = waiting();
    r.key('', ESC); // the step back out of the wait, at t0
    const key = r.channel.flow.select(PICK_BACK);
    r.show();
    r.advance(STEP_BACK_HOLD_MS - 1);
    r.key('', ESC); // still the same hold: refused, and the hold restarts here
    expect(await settled(key)).toBe(PENDING);
    r.advance(STEP_BACK_HOLD_MS - 1);
    r.key('', ESC);
    expect(await settled(key)).toBe(PENDING);
    r.advance(STEP_BACK_HOLD_MS);
    r.key('', ESC);
    expect(await key).toBe(NATIVE_PROMPT_BACK);
    // Resolved: the hold went with it, and the next step back is taken at once.
    const next = r.channel.flow.select(PICK_BACK);
    r.show();
    r.advance(1);
    r.key('', ESC);
    expect(await next).toBe(NATIVE_PROMPT_BACK);
  });

  it('the hold goes when the prompt it guards is answered, even inside it: the next prompt steps back at once', async () => {
    const { r } = waiting();
    r.key('', ESC); // the step back out of the wait
    const key = r.channel.flow.select(PICK_BACK);
    r.show();
    r.advance(POPUP_SELECT_SETTLE_MS);
    r.key('', ENTER); // answered well inside the hold
    expect(await key).toBe('a');
    const next = r.channel.flow.select(PICK_BACK);
    r.show();
    r.advance(1);
    r.key('', ESC);
    expect(await next).toBe(NATIVE_PROMPT_BACK);
  });

  it('`Ctrl+C` is never held: it leaves the prompt the step back opened at once', async () => {
    const { r } = waiting();
    r.key('', ESC);
    const key = r.channel.flow.select(PICK_BACK);
    r.show();
    r.advance(1);
    r.key('c', CTRL);
    expect(await key).toBe(NATIVE_PROMPT_CANCEL);
  });

  it('STEP_BACK_HOLD_MS is the approval lockout: a key held at any repeat rate never gets past it', () => {
    expect(STEP_BACK_HOLD_MS).toBe(APPROVAL_LOCKOUT_MS);
  });
});
