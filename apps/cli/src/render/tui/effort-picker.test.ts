import { REASONING_EFFORTS } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  canControlEffort,
  foldEffortPickerKey,
  initialEffortPickerState,
  type EffortPickerState,
} from './effort-picker.js';

function state(partial: Partial<EffortPickerState> = {}): EffortPickerState {
  return { selected: 0, current: undefined, model: 'deepseek-v4-flash', ...partial };
}

describe('canControlEffort', () => {
  it('is true only when the setter is wired AND the bound model is reasoning-capable', () => {
    expect(canControlEffort('claude-opus-4-8', true)).toBe(true); // registry reasoning model + setter
    expect(canControlEffort('deepseek-v4-flash', true)).toBe(true);
  });

  it('is false for a non-reasoning model, an unbound model, or an unwired setter', () => {
    expect(canControlEffort('gpt-4o', true)).toBe(false); // gpt-4o is not a reasoning model
    expect(canControlEffort('deepseek-chat', true)).toBe(false); // the legacy non-thinking alias
    expect(canControlEffort(undefined, true)).toBe(false); // no bound model yet (pre session:started)
    expect(canControlEffort('claude-opus-4-8', false)).toBe(false); // setter not wired (a non-interactive driver)
  });
});

describe('initialEffortPickerState', () => {
  it('opens on the bound effort when set', () => {
    // 'high' is index 3 in [off, low, medium, high, max].
    expect(initialEffortPickerState('m', 'high').selected).toBe(REASONING_EFFORTS.indexOf('high'));
    expect(initialEffortPickerState('m', 'off').selected).toBe(REASONING_EFFORTS.indexOf('off'));
  });

  it('opens on a neutral middle tier (medium) when no effort is bound', () => {
    const s = initialEffortPickerState('m', undefined);
    expect(REASONING_EFFORTS[s.selected]).toBe('medium');
  });

  it('carries the model + current through', () => {
    const s = initialEffortPickerState('deepseek-v4-pro', 'max');
    expect(s.model).toBe('deepseek-v4-pro');
    expect(s.current).toBe('max');
  });
});

describe('foldEffortPickerKey', () => {
  it('Esc and Ctrl-C close (no apply)', () => {
    expect(foldEffortPickerKey('', { escape: true }, state()).kind).toBe('close');
    expect(foldEffortPickerKey('c', { ctrl: true }, state()).kind).toBe('close');
  });

  it('↑/↓ move the highlight, clamped to the tier list', () => {
    const down = foldEffortPickerKey('', { downArrow: true }, state({ selected: 0 }));
    expect(down).toEqual({ kind: 'state', state: state({ selected: 1 }) });
    // Clamp at the top edge — Up on index 0 stays 0.
    const up = foldEffortPickerKey('', { upArrow: true }, state({ selected: 0 }));
    expect(up).toEqual({ kind: 'state', state: state({ selected: 0 }) });
    // Clamp at the bottom edge — Down on the last index stays.
    const last = REASONING_EFFORTS.length - 1;
    const downLast = foldEffortPickerKey('', { downArrow: true }, state({ selected: last }));
    expect(downLast).toEqual({ kind: 'state', state: state({ selected: last }) });
  });

  it('Enter accepts the highlighted tier', () => {
    const step = foldEffortPickerKey(
      '',
      { return: true },
      state({ selected: REASONING_EFFORTS.indexOf('high') }),
    );
    expect(step).toEqual({ kind: 'accept', effort: 'high' });
  });

  it('Enter accepts each tier by index (all five reachable)', () => {
    REASONING_EFFORTS.forEach((effort, index) => {
      const step = foldEffortPickerKey('', { return: true }, state({ selected: index }));
      expect(step).toEqual({ kind: 'accept', effort });
    });
  });

  it('a clamped/out-of-range highlight accepts the last valid tier (never a malformed accept)', () => {
    // Enter clamps the index, so a hand-built OOR index resolves to the last tier — the `undefined` guard branch is
    // unreachable for the fixed non-empty list, but this pins that Enter never emits an out-of-range/undefined tier.
    const step = foldEffortPickerKey('', { return: true }, state({ selected: 999 }));
    expect(step).toEqual({
      kind: 'accept',
      effort: REASONING_EFFORTS[REASONING_EFFORTS.length - 1],
    });
  });

  it('any other key is inert (returns the same state ref)', () => {
    const s = state({ selected: 2 });
    const step = foldEffortPickerKey('x', {}, s);
    expect(step).toEqual({ kind: 'state', state: s });
    if (step.kind === 'state') expect(step.state).toBe(s); // same ref — no needless re-render/hint-wipe
  });
});
