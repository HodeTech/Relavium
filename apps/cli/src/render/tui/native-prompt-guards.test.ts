/**
 * The input guards out of the channel's closure (`native-prompt-guards.ts`): what a key is as a framed flow's opening guard counts it, the
 * opening admission reset per flow, the guarded option whose lockout runs from the select's opening (the 6.1 sitting's F1), and the chord card
 * whose lockout runs from the card's opening (unit 6's round-1 S1/S2: a first-prompt card and a card after a wait a held key repeated through).
 */
import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import { createChordGuard, createChordHistory, type ChordStamp } from './chord-guard.js';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import {
  cancelsPrompt,
  createChordCardGuard,
  createGuardedSelect,
  createOpeningAdmission,
  firstBoundary,
  GUARDED_SELECT_GUARD,
  nativeOpeningKey,
  navigates,
} from './native-prompt-guards.js';
import {
  APPROVAL_CONFIRM_MIN_MS,
  APPROVAL_LOCKOUT_MS,
  APPROVAL_SETTLE_MS,
  type ApprovalGuard,
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

  it('W7: says whether a key arrived AFTER the flow’s first frame appeared (rule 3: not at the same moment), and forgets it per flow', () => {
    const clock = 1000;
    const admission = createOpeningAdmission({ now: () => clock });
    expect(admission.appeared(clock + 50), 'no frame yet').toBe(false);
    admission.shown();
    expect(admission.appeared(clock), 'the same moment').toBe(false);
    expect(admission.appeared(clock - 1), 'before it').toBe(false);
    expect(admission.appeared(clock + 1)).toBe(true);
    admission.begin();
    expect(admission.appeared(clock + 1), 'a new flow has not appeared').toBe(false);
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

describe('the chord card', () => {
  /** The channel's chord guard on a clock the test moves, with no key in its history, and the card's own guard over it. */
  function rig(guard?: ApprovalGuard) {
    let clock = 50_000;
    const history = createChordHistory();
    const chord = createChordGuard({ now: () => clock, history, guard });
    const card = createChordCardGuard({ now: () => clock, chord });
    /** A card (or another prompt) opens now and its frame is acknowledged at once. */
    const open = (isChord: boolean): number => {
      chord.begin();
      card.open(isChord);
      chord.shown();
      return clock;
    };
    return {
      history,
      card,
      open,
      stamp: (): ChordStamp => chord.stamp(),
      at: (ms: number): void => {
        clock = ms;
      },
      now: (): number => clock,
    };
  }

  it('opened as a chord card: its lockout runs from the opening, with no answer before it; a refused Ctrl+Y inside it restarts it on the shared history', () => {
    const r = rig();
    const opened = r.open(true);
    r.at(opened + APPROVAL_LOCKOUT_MS - 1);
    expect(r.card.decide(r.stamp(), 'allow', true)).toBeUndefined();
    expect(r.history.lastResolvedAt, 'restarted, on the history every card reads').toBe(
      opened + APPROVAL_LOCKOUT_MS - 1,
    );
    r.at(opened + APPROVAL_LOCKOUT_MS - 1 + APPROVAL_LOCKOUT_MS);
    expect(r.card.decide(r.stamp(), 'allow', true)).toBe('allow');
  });

  it('a Ctrl+N is never delayed: it answers at the very moment the card opened', () => {
    const r = rig();
    r.open(true);
    expect(r.card.decide(r.stamp(), 'deny', true)).toBe('deny');
  });

  it('opened as another prompt: no lockout of its own, the dwell alone decides', () => {
    const r = rig();
    const opened = r.open(false);
    r.at(opened + APPROVAL_SETTLE_MS);
    expect(r.card.decide(r.stamp(), 'allow', true)).toBe('allow');
  });

  it('the later of the answer before it and its opening counts: an answer after the card opened runs its own lockout', () => {
    const r = rig();
    const opened = r.open(true);
    r.history.lastResolvedAt = opened + 1000; // another card of the Home answered by a key, on the shared history
    r.at(opened + APPROVAL_LOCKOUT_MS + 500);
    expect(r.card.decide(r.stamp(), 'allow', true)).toBeUndefined();
  });

  it('a refusal outside the lockout (the frame was not on screen) restarts nothing', () => {
    const r = rig();
    const opened = r.open(true);
    r.at(opened + APPROVAL_LOCKOUT_MS);
    expect(r.card.decide(r.stamp(), 'allow', false)).toBeUndefined();
    expect(r.history.lastResolvedAt).toBe(Number.NEGATIVE_INFINITY);
    r.at(r.now() + APPROVAL_SETTLE_MS);
    expect(r.card.decide(r.stamp(), 'allow', true)).toBe('allow');
  });

  it('a channel whose numbers switch the lockout off (`lockoutMs: 0`, a test that isolates another layer) has no opening lockout either', () => {
    const r = rig({ settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 });
    r.open(true);
    expect(r.card.decide(r.stamp(), 'allow', true)).toBe('allow');
  });
});
