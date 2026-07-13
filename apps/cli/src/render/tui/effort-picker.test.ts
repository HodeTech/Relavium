import { REASONING_EFFORTS } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  canControlEffort,
  effortTiersFor,
  foldEffortPickerKey,
  initialEffortPickerState,
  type EffortPickerState,
} from './effort-picker.js';

function state(partial: Partial<EffortPickerState> = {}): EffortPickerState {
  // `deepseek-v4-flash` accepts all five (its low/medium/high all coarsen onto one wire value, and `off` is the
  // independent disable switch) — so the DEFAULT fixture is still a five-row list, and a test that wants a
  // narrower model says so explicitly.
  return {
    tiers: [...REASONING_EFFORTS],
    selected: 0,
    current: undefined,
    model: 'deepseek-v4-flash',
    ...partial,
  };
}

describe('canControlEffort', () => {
  it('is true only when the setter is wired AND the bound model is reasoning-capable', () => {
    expect(canControlEffort('claude-opus-4-8', true)).toBe(true); // registry reasoning model + setter
    expect(canControlEffort('deepseek-v4-flash', true)).toBe(true);
  });

  it('is false for a non-reasoning model, an unbound model, or an unwired setter', () => {
    expect(canControlEffort('gpt-4o', true)).toBe(false); // gpt-4o is not a reasoning model
    expect(canControlEffort('deepseek-chat', true)).toBe(false); // the legacy non-thinking alias
    // …and a model that REASONS but publishes no controllable tier is also false: opening a five-row overlay for
    // it (as the old `supportsReasoning` gate did) offers five rows the model does not take.
    expect(canControlEffort('deepseek-reasoner', true)).toBe(false);
    expect(canControlEffort(undefined, true)).toBe(false); // no bound model yet (pre session:started)
    expect(canControlEffort('claude-opus-4-8', false)).toBe(false); // setter not wired (a non-interactive driver)
  });
});

describe('effortTiersFor + initialEffortPickerState — the picker can no longer OFFER an illegal tier', () => {
  it('THE BUG: gpt-5.4-pro is offered {medium, high, max} — NOT `low`, NOT `off`', () => {
    // The picker used to show all five to every reasoning model. Picking `low` on this one produced an opaque
    // provider 400 — the maintainer's report. The interactive path cannot produce it now, because it is not a row.
    expect(effortTiersFor('gpt-5.4-pro')).toEqual(['medium', 'high', 'max']);
  });

  it('gpt-5-pro is offered ONE tier — a single-row list, which a boolean could never have produced', () => {
    expect(effortTiersFor('gpt-5-pro')).toEqual(['high']);
  });

  it('gemini-2.5-pro is NOT offered `off` — Google: "N/A: Cannot disable thinking"', () => {
    expect(effortTiersFor('gemini-2.5-pro')).not.toContain('off');
  });

  it('a model with no controllable tier, and an unknown model, offer NOTHING', () => {
    expect(effortTiersFor('deepseek-reasoner')).toEqual([]); // reasons; publishes no control
    expect(effortTiersFor('some-custom-endpoint-model')).toEqual([]); // not in the catalog at all
  });

  it('the tiers are in CANONICAL order (off → max), never the accepted-set insertion order', () => {
    expect(effortTiersFor('claude-opus-4-8')).toEqual(['off', 'low', 'medium', 'high', 'max']);
  });
});

describe('initialEffortPickerState', () => {
  it('opens on the bound effort when the model accepts it', () => {
    const s = initialEffortPickerState('claude-opus-4-8', 'high');
    expect(s.tiers[s.selected]).toBe('high');
  });

  it('opens on `medium` when nothing is bound and the model accepts medium', () => {
    const s = initialEffortPickerState('claude-opus-4-8', undefined);
    expect(s.tiers[s.selected]).toBe('medium');
  });

  it('NEVER opens on a row the model does not have — the old `?? medium` default could', () => {
    // gpt-5-pro accepts only `high`. The old code took `REASONING_EFFORTS.indexOf('medium')` = 2 and highlighted
    // a row that, in a one-row list, does not exist. The highlight now always lands on a tier the model takes,
    // because the list only contains tiers the model takes.
    const s = initialEffortPickerState('gpt-5-pro', undefined);
    expect(s.tiers).toEqual(['high']);
    expect(s.selected).toBe(0);
    expect(s.tiers[s.selected]).toBe('high');

    // …and the same when the BOUND tier is one the model rejects (a model swap can leave a stale tier bound).
    const stale = initialEffortPickerState('gpt-5.4-pro', 'low'); // gpt-5.4-pro rejects `low`
    expect(stale.tiers).not.toContain('low');
    expect(stale.tiers[stale.selected]).toBe('medium'); // the first row, never an index into thin air
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
