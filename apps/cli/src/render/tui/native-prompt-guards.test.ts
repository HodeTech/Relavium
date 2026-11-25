/**
 * The two input guards out of the channel's closure (`native-prompt-guards.ts`): what a key is as a framed flow's opening guard counts it, the
 * opening admission reset per flow, and the guarded option whose lockout runs from the select's opening (the 6.1 sitting's F1).
 */
import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import { createChordHistory, type ChordStamp } from './chord-guard.js';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import {
  cancelsPrompt,
  createGuardedSelect,
  createOpeningAdmission,
  firstBoundary,
  GUARDED_SELECT_GUARD,
  nativeOpeningKey,
  navigates,
} from './native-prompt-guards.js';
import { APPROVAL_CONFIRM_MIN_MS, APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

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

const SNAPSHOT: NativePromptSnapshot = {
  active: true,
  kind: 'select',
  message: 'Pick',
  note: '',
  options: [{ value: 'a', label: 'A' }],
  selected: 0,
  display: '',
  error: '',
  escape: 'cancel',
  details: [],
};

describe('what a key is to the opening guard', () => {
  const of = (kind: NativePromptSnapshot['kind'], input: string, key: Key, open = true) =>
    nativeOpeningKey({ ...SNAPSHOT, kind }, open, input, key);

  it('the keys that leave: Esc, Ctrl+C, a meta chord, an escape or an ETX byte in a chunk, and a chord card’s Ctrl+N', () => {
    expect(of('select', '', { ...none, escape: true })).toBe('leave');
    expect(of('select', 'c', { ...none, ctrl: true })).toBe('leave');
    expect(of('select', 'x', { ...none, meta: true })).toBe('leave');
    expect(of('text', 'ab\u001b', none)).toBe('leave');
    expect(of('text', 'ab\u0003', none)).toBe('leave');
    expect(of('chord', 'n', { ...none, ctrl: true })).toBe('leave');
  });

  it('the answers: Enter, a chunk that holds a return or a newline (`key.return` false), a chord card’s Ctrl+Y', () => {
    expect(of('select', '', { ...none, return: true })).toBe('answer');
    expect(of('select', 'y\r', none)).toBe('answer');
    expect(of('text', 'abc\n', none)).toBe('answer');
    expect(of('picker', '', { ...none, return: true })).toBe('answer');
    expect(of('chord', 'y', { ...none, ctrl: true })).toBe('answer');
  });

  it('navigation: the arrows and the pages on any prompt, Tab on the picker only', () => {
    for (const key of [
      { upArrow: true },
      { downArrow: true },
      { pageUp: true },
      { pageDown: true },
    ])
      expect(of('select', '', { ...none, ...key })).toBe('navigate');
    expect(of('picker', '', { ...none, tab: true })).toBe('navigate');
    expect(of('select', '', { ...none, tab: true })).toBe('type');
  });

  it('typing: a letter, a chord card’s other keys (a chunk that holds Ctrl+Y’s letter is not one), a key on a wait or with no prompt open', () => {
    expect(of('text', 'a', none)).toBe('type');
    expect(of('chord', 'x', none)).toBe('type');
    expect(of('chord', 'y\r', { ...none, ctrl: true })).toBe('type');
    expect(of('busy', '', { ...none, return: true })).toBe('type');
    expect(of('select', '', { ...none, return: true }, false)).toBe('type');
  });

  it('the helpers it is made of', () => {
    expect(firstBoundary('ab\ncd\re')).toBe(2);
    expect(firstBoundary('ab\u0003\u001b')).toBe(2);
    expect(firstBoundary('abc')).toBe(-1);
    expect(cancelsPrompt('C', { ...none, ctrl: true })).toBe(true);
    expect(cancelsPrompt('x', { ...none, ctrl: true })).toBe(false);
    expect(navigates({ ...none, leftArrow: true })).toBe(false);
  });
});

describe('the opening admission of a flow', () => {
  it('admits nothing but the keys that leave before the flow’s first frame, an answer only after the settle, and begins again per flow', () => {
    let clock = 1000;
    const admission = createOpeningAdmission({ now: () => clock });
    expect(admission.admits('navigate', clock)).toBe(false);
    expect(admission.admits('leave', clock)).toBe(true);
    admission.shown();
    clock += 1;
    expect(admission.admits('navigate', clock)).toBe(true);
    expect(admission.admits('answer', clock)).toBe(false);
    expect(admission.admits('answer', clock - 1 + POPUP_SELECT_SETTLE_MS)).toBe(true);
    admission.begin();
    expect(admission.admits('navigate', clock + 10_000)).toBe(false);
  });

  it('honours an injected settle time', () => {
    let clock = 1000;
    const admission = createOpeningAdmission({ now: () => clock, settleMs: 0 });
    admission.shown();
    clock += 1;
    expect(admission.admits('answer', clock)).toBe(true);
  });
});

describe('the guarded option', () => {
  function rig() {
    let clock = 50_000;
    const history = createChordHistory();
    const guarded = createGuardedSelect({ now: () => clock, history });
    const stamp = (): ChordStamp => {
      const before: ChordStamp = { now: clock, ...history };
      history.previousKeyAt = clock;
      return before;
    };
    return {
      history,
      guarded,
      stamp,
      at: (ms: number): void => {
        clock = ms;
      },
      now: (): number => clock,
    };
  }

  it('its numbers are the approval card’s with the confirmation dwell', () => {
    expect(GUARDED_SELECT_GUARD.settleMs).toBe(APPROVAL_CONFIRM_MIN_MS);
    expect(GUARDED_SELECT_GUARD.lockoutMs).toBe(APPROVAL_LOCKOUT_MS);
  });

  it('opened guarded: its lockout runs from the opening, with no answer before it; a refusal inside it restarts it', () => {
    const r = rig();
    const opened = r.now();
    r.guarded.open(true);
    r.guarded.shown();
    r.at(opened + APPROVAL_LOCKOUT_MS - 1);
    expect(r.guarded.decide(r.stamp(), true)).toBe(false);
    expect(r.history.lastResolvedAt).toBe(opened + APPROVAL_LOCKOUT_MS - 1);
    r.at(opened + APPROVAL_LOCKOUT_MS - 1 + APPROVAL_LOCKOUT_MS);
    expect(r.guarded.decide(r.stamp(), true)).toBe(true);
  });

  it('opened unguarded (another prompt): no lockout of its own', () => {
    const r = rig();
    r.guarded.open(false);
    r.guarded.shown();
    r.at(r.now() + APPROVAL_CONFIRM_MIN_MS);
    expect(r.guarded.decide(r.stamp(), true)).toBe(true);
  });

  it('`refuse` restarts the lockout inside it (the opening counted), and leaves it outside it', () => {
    const r = rig();
    const opened = r.now();
    r.guarded.open(true);
    r.at(opened + 500);
    r.guarded.refuse(r.stamp());
    expect(r.history.lastResolvedAt).toBe(opened + 500);
    r.at(opened + 500 + APPROVAL_LOCKOUT_MS + 1);
    r.guarded.refuse(r.stamp());
    expect(r.history.lastResolvedAt).toBe(opened + 500);
  });

  it('a frame not on screen, or not acknowledged at all, is never answered', () => {
    const r = rig();
    r.guarded.open(true);
    r.at(r.now() + 10_000);
    expect(r.guarded.decide(r.stamp(), true)).toBe(false);
    r.guarded.shown();
    r.at(r.now() + 10_000);
    expect(r.guarded.decide(r.stamp(), false)).toBe(false);
    r.at(r.now() + 400);
    expect(r.guarded.decide(r.stamp(), true)).toBe(true);
  });
});
