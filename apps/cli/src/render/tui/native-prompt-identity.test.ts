/**
 * The native prompt's snapshot identity ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the measured-frame proof compares today's fields (`note` and `picker` included) PLUS the popup descriptor's (`title`, `origin`,
 * `stepIndex`, `stepCount`, `exitLabel`, `placement`, the stack depth). Every key of the snapshot is enumerated against the comparison and the
 * explicit exclusion list, so a field added to the snapshot without a decision fails here; and the descriptor reaches the snapshot through the
 * flow's one setter, sanitised.
 */
import { describe, expect, it } from 'vitest';

import {
  NATIVE_PROMPT_IDENTITY_EXCLUDED,
  sameNativePromptFrame,
} from './native-prompt-acknowledgement.js';
import {
  createNativePromptChannel,
  type NativePopupDescriptor,
  type NativePromptSnapshot,
} from './native-prompt-channel.js';

/** Every field of a snapshot, the optional ones too: a field added to the type without a value here does not compile. */
const FULL: Required<NativePromptSnapshot> = {
  active: true,
  kind: 'select',
  picker: {
    allDirectories: false,
    page: 1,
    cursor: 0,
    loading: false,
    hasNext: false,
    hasPrevious: false,
    retryable: false,
  },
  message: 'Pick one',
  note: 'Saved to ~/.relavium/config.toml',
  options: [{ value: 'a', label: 'A' }],
  selected: 0,
  display: '',
  error: '',
  escape: 'back',
  details: ['row'],
  popup: {
    placement: 'overlay',
    title: '/providers',
    origin: 'home',
    stepIndex: 1,
    stepCount: 3,
    exitLabel: 'close',
    depth: 1,
  },
};

/** Every field of the descriptor: a field added without a value here does not compile. */
const DESCRIPTOR: Required<NativePopupDescriptor> = FULL.popup;

/** A value of `key` that differs from FULL's, of the same type (a new object for a list, so a reference comparison sees it). */
function changed(key: keyof NativePromptSnapshot): NativePromptSnapshot {
  const variants: {
    readonly [K in keyof Required<NativePromptSnapshot>]: NativePromptSnapshot[K];
  } = {
    active: false,
    kind: 'text',
    picker: { ...FULL.picker },
    message: 'Pick another',
    note: '',
    options: [...FULL.options],
    selected: 1,
    display: '••••',
    error: 'Required.',
    escape: 'cancel',
    details: [...FULL.details],
    popup: { ...DESCRIPTOR },
  };
  return { ...FULL, [key]: variants[key] };
}

function changedDescriptor(key: keyof NativePopupDescriptor): NativePromptSnapshot {
  const variants: {
    readonly [K in keyof Required<NativePopupDescriptor>]: NativePopupDescriptor[K];
  } = {
    placement: 'replace',
    title: '/init',
    origin: 'chat',
    stepIndex: 2,
    stepCount: 4,
    exitLabel: 'back',
    depth: 2,
  };
  return { ...FULL, popup: { ...DESCRIPTOR, [key]: variants[key] } };
}

const KEYS = Object.keys(FULL) as (keyof NativePromptSnapshot)[];

describe('every field of the snapshot is identity or excluded with a reason', () => {
  it.each(KEYS.filter((key) => key !== 'popup'))('%s', (key) => {
    const excluded = NATIVE_PROMPT_IDENTITY_EXCLUDED[key];
    const same = sameNativePromptFrame(FULL, changed(key));
    if (excluded === undefined) expect(same, `${key} must be part of the identity`).toBe(false);
    else {
      expect(same, `${key} is excluded: ${excluded}`).toBe(true);
      expect(excluded.length).toBeGreaterThan(20);
    }
  });

  it('the exclusion list names only fields the snapshot has, and only `display` today', () => {
    for (const key of Object.keys(NATIVE_PROMPT_IDENTITY_EXCLUDED)) expect(KEYS).toContain(key);
    expect(Object.keys(NATIVE_PROMPT_IDENTITY_EXCLUDED)).toEqual(['display']);
  });

  it('`note` and `picker` are identity (they carry the key step’s destination and the config-rewrite notice)', () => {
    expect(sameNativePromptFrame(FULL, changed('note'))).toBe(false);
    expect(sameNativePromptFrame(FULL, changed('picker'))).toBe(false);
  });

  it('the same snapshot is the same card', () => {
    expect(sameNativePromptFrame(FULL, FULL)).toBe(true);
    expect(sameNativePromptFrame(FULL, { ...FULL })).toBe(true);
  });
});

describe('the popup descriptor is identity, field by field', () => {
  it.each(Object.keys(DESCRIPTOR) as (keyof NativePopupDescriptor)[])('%s', (key) => {
    expect(sameNativePromptFrame(FULL, changedDescriptor(key))).toBe(false);
  });

  it('a descriptor that appears or goes away is a new card; an equal one in a new object is not', () => {
    const { popup, ...card } = FULL;
    void popup;
    expect(sameNativePromptFrame(FULL, card)).toBe(false);
    expect(sameNativePromptFrame(card, FULL)).toBe(false);
    expect(sameNativePromptFrame(FULL, { ...FULL, popup: { ...DESCRIPTOR } })).toBe(true);
  });
});

describe('the flow’s one setter plumbs the descriptor into the snapshot', () => {
  it('sets it sanitised on an open flow, clears it, and does nothing with no flow open', () => {
    const channel = createNativePromptChannel({ now: () => 0 });
    channel.flow.popup?.({
      ...DESCRIPTOR,
      title: '/prov\u001b[31miders',
      exitLabel: 'cl\u0007ose',
      stepIndex: 1.7,
    });
    expect(channel.ui.getSnapshot().popup).toBeUndefined();
    channel.flow.begin();
    channel.flow.popup?.({
      ...DESCRIPTOR,
      title: '/prov\u001b[31miders',
      exitLabel: 'cl\u0007ose',
      stepIndex: 1.7,
    });
    expect(channel.ui.getSnapshot().popup).toEqual({
      ...DESCRIPTOR,
      title: '/providers',
      exitLabel: 'close',
      stepIndex: 1,
    });
    const set = channel.ui.getSnapshot();
    channel.flow.popup?.(undefined);
    expect(channel.ui.getSnapshot().popup).toBeUndefined();
    expect(sameNativePromptFrame(set, channel.ui.getSnapshot())).toBe(false);
    channel.ui.dispose();
  });

  it('a prompt opened under the descriptor keeps it, and the flow’s end clears it', async () => {
    const channel = createNativePromptChannel({ now: () => 0 });
    channel.flow.begin();
    channel.flow.popup?.(DESCRIPTOR);
    void channel.flow.select({ message: 'Pick', options: [{ value: 'a', label: 'A' }] });
    expect(channel.ui.getSnapshot().popup).toEqual(DESCRIPTOR);
    expect(channel.ui.getSnapshot().kind).toBe('select');
    await channel.flow.end();
    expect(channel.ui.getSnapshot().popup).toBeUndefined();
    channel.ui.dispose();
  });
});
