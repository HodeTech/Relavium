import { REASONING_EFFORTS } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  effortRejectedNote,
  effortRowLabel,
  effortTiersFor,
  effortUnavailableNote,
  projectEffortToRow,
} from '../../chat/effort-notice.js';

import {
  canControlEffort,
  foldEffortPickerKey,
  initialEffortPickerState,
  type EffortPickerState,
} from './effort-picker.js';

function state(partial: Partial<EffortPickerState> = {}): EffortPickerState {
  // A SYNTHETIC full tier list, so the fold/navigation tests below exercise every arrow move regardless of what a
  // real model's projection collapses to (that projection — dedupe, budget off/on — is covered by the
  // `effortTiersFor` tests above). The `model` is only carried through the fold, not re-projected here.
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

  it('a model with no controllable tier, and an unknown model, offer NOTHING', () => {
    expect(effortTiersFor('deepseek-reasoner')).toEqual([]); // reasons; publishes no control
    expect(effortTiersFor('some-custom-endpoint-model')).toEqual([]); // not in the catalog at all
  });

  it('the tiers are in CANONICAL order (off → max), never the accepted-set insertion order', () => {
    expect(effortTiersFor('claude-opus-4-8')).toEqual(['off', 'low', 'medium', 'high', 'max']);
  });
});

describe('effortTiersFor — the GENERAL presentation rule: one row per distinct outcome (ADR-0066 amendment)', () => {
  it('BUDGET model → off/on, never a fake 5-tier ladder (claude-haiku-4-5)', () => {
    // A continuous token budget has no meaningful discrete rungs. Its picker is a two-row off/on; "on" is the
    // canonical `medium` tier (a real member of the accepted set, so the accept sends a value the gate accepts).
    expect(effortTiersFor('claude-haiku-4-5')).toEqual(['off', 'medium']);
    // …and 'medium' READS "on" (the label the whole surface shows).
    expect(effortRowLabel('claude-haiku-4-5', 'medium')).toEqual({
      label: 'on',
      hint: 'reasoning on',
    });
    expect(effortRowLabel('claude-haiku-4-5', 'off').label).toBe('off');
  });

  it('BUDGET model that cannot be turned off → NO overlay (gemini-2.5-pro)', () => {
    // Google: "N/A: Cannot disable thinking". With no `off` and no discrete ladder there is nothing to toggle, so
    // the list is empty and the overlay never opens (was: five rows, one of them the rejected `off`).
    expect(effortTiersFor('gemini-2.5-pro')).toEqual([]);
    expect(canControlEffort('gemini-2.5-pro', true)).toBe(false);
  });

  it('GRADED model → deduped by distinct WIRE value: deepseek-v4-pro low/medium/high all send `high`', () => {
    // DeepSeek publishes only two effort levels; Relavium's low/medium/high all map to `high`, so they collapse to
    // ONE row — the representative reads "high" (the name that matches the wire), not "low".
    expect(effortTiersFor('deepseek-v4-pro')).toEqual(['off', 'high', 'max']);
    expect(effortRowLabel('deepseek-v4-pro', 'high').label).toBe('high'); // a graded tier keeps its own name
  });

  it('GRADED model → Gemini `max` coarsens onto `high`, so it collapses (gemini-3.5-flash)', () => {
    // GEMINI_WIRE maps `max` onto `high`, so `high` and `max` are the same call — keep the name-match `high`.
    expect(effortTiersFor('gemini-3.5-flash')).toEqual(['low', 'medium', 'high']);
  });

  it('GRADED model with all-distinct wires is UNCHANGED (claude-opus-4-8 full ladder, gpt-5.4-pro)', () => {
    expect(effortTiersFor('claude-opus-4-8')).toEqual(['off', 'low', 'medium', 'high', 'max']);
    expect(effortTiersFor('gpt-5.4-pro')).toEqual(['medium', 'high', 'max']);
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

  // The Bug-1 opening-highlight regression: after the amendment collapsed graded/budget models to one row per
  // DISTINCT outcome, `medium` is no longer necessarily a row. The old `tiers.indexOf(neutral)` returned -1 →
  // clamped to 0 = the FIRST row, which for a disableable model is `off`. So a fresh picker highlighted `off`, and
  // an immediate Enter WROTE `off` — silently turning reasoning off on a model the user opened to turn it up.
  it('a collapsed graded model opens on the neutral tier’s REPRESENTATIVE row, never `off`', () => {
    // deepseek-v4-pro rows = [off, high, max]; `medium` maps to the `high` wire, so it collapses onto that row.
    const s = initialEffortPickerState('deepseek-v4-pro', undefined);
    expect(s.tiers).toEqual(['off', 'high', 'max']);
    expect(s.tiers[s.selected]).toBe('high');
    expect(s.tiers[s.selected]).not.toBe('off');
  });

  it('a budget model opens on the `on` row (the canonical medium), never `off`', () => {
    // claude-haiku-4-5 is a toggle → rows = [off, medium]; `medium` is displayed "on". It must open on `on`.
    const s = initialEffortPickerState('claude-haiku-4-5', undefined);
    expect(s.tiers).toEqual(['off', 'medium']);
    expect(s.tiers[s.selected]).toBe('medium');
  });

  it('a BOUND tier that was deduped away opens on its representative row', () => {
    // deepseek bound to `low` (an authored agent / config default) — `low` is not a row; open on `high`, its twin.
    const graded = initialEffortPickerState('deepseek-v4-pro', 'low');
    expect(graded.tiers[graded.selected]).toBe('high');
    // a budget model bound to `high` → the `on` row.
    const budget = initialEffortPickerState('claude-haiku-4-5', 'high');
    expect(budget.tiers[budget.selected]).toBe('medium');
  });
});

describe('projectEffortToRow — a tier maps to the row that REPRESENTS it (ADR-0066/0071 amendment)', () => {
  it('returns the tier itself when it is a row', () => {
    expect(projectEffortToRow('deepseek-v4-pro', ['off', 'high', 'max'], 'high')).toBe('high');
    expect(projectEffortToRow('deepseek-v4-pro', ['off', 'high', 'max'], 'off')).toBe('off');
  });

  it('projects a deduped graded tier onto its wire twin', () => {
    // `medium` and `low` both wire to `high` for deepseek → both project onto the `high` row.
    expect(projectEffortToRow('deepseek-v4-pro', ['off', 'high', 'max'], 'medium')).toBe('high');
    expect(projectEffortToRow('deepseek-v4-pro', ['off', 'high', 'max'], 'low')).toBe('high');
  });

  it('projects any on-tier of a budget model onto the canonical `on` row', () => {
    expect(projectEffortToRow('claude-haiku-4-5', ['off', 'medium'], 'high')).toBe('medium');
    expect(projectEffortToRow('claude-haiku-4-5', ['off', 'medium'], 'max')).toBe('medium');
    expect(projectEffortToRow('claude-haiku-4-5', ['off', 'medium'], 'off')).toBe('off');
  });

  it('returns undefined when the tier has no representative (nothing to highlight)', () => {
    // a model whose rows do not include `off` and whose wire twin is absent → no row represents `off`.
    expect(projectEffortToRow('gpt-5-pro', ['high'], 'off')).toBeUndefined();
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

/**
 * ONE PREDICATE, ASKED BY EVERY SURFACE (ADR-0071 §6).
 *
 * These lock the facts the two blockers turned on. The CLI used to carry four answers to "can the user set effort
 * on this model": this list, the `/models` sub-step, the engine's gate, and — the odd one out — `modelSupportsReasoning`,
 * an id heuristic over the hand-typed pricing table that the footer and the `/effort` command still read. An
 * adversarial review computed the disagreement: **sixteen shipped models**, and on each one the user was either
 * billed for reasoning with no indicator, or told a tier applied that the engine then silently dropped.
 */
describe('effortTiersFor — the one answer every surface reads', () => {
  it('lists ONLY the tiers the model publishes — `gpt-5.4-pro` takes neither `low` nor `off`', () => {
    // The maintainer's original bug report. The typed `/effort low` used to validate against the fixed five, say
    // "applies to your next message", show `low` in the footer — and send nothing, because the gate dropped it.
    const tiers = effortTiersFor('gpt-5.4-pro'); // catalog: effortValues ['medium','high','xhigh']
    expect(tiers).toEqual(['medium', 'high', 'max']);
    expect(tiers).not.toContain('low');
    expect(tiers).not.toContain('off'); // on OpenAI, `off` IS an effort value ('none') — and this model omits it
  });

  it("is CANONICALLY ordered, never the accepted Set's insertion order", () => {
    // `acceptedTiers` adds `off` LAST (it rides a different axis), so a raw spread of the Set would render
    // `low, medium, high, max, off` — the rows must read in tier order, every time, on every model.
    const tiers = effortTiersFor('claude-opus-4-8');
    expect(tiers).toEqual(REASONING_EFFORTS.filter((t) => tiers.includes(t)));
    expect(tiers[0]).toBe('off');
  });

  it('a model the OLD boolean called non-reasoning still has tiers — the sixteen-model disagreement', () => {
    // `claude-sonnet-4-5` is not in the hand-typed `MODEL_PRICING` at all, so the heuristic answered `false` — while
    // the picker offered five tiers and the engine sent the chosen one. The footer stayed blank and the user paid
    // for extended thinking with nothing on screen to say it was on.
    expect(effortTiersFor('claude-sonnet-4-5').length).toBeGreaterThan(0);
    expect(canControlEffort('claude-sonnet-4-5', true)).toBe(true);
  });

  it('EMPTY for a model with no knob, and for one the catalog does not carry — but they are not the same sentence', () => {
    expect(effortTiersFor('deepseek-reasoner')).toEqual([]); // reasoning: {} — reasons, publishes nothing
    expect(effortTiersFor('some-custom-endpoint-model')).toEqual([]); // not in the catalog at all
    expect(canControlEffort('deepseek-reasoner', true)).toBe(false);

    // Same empty list, different ACTION: one is fixable by a catalog refresh, the other never will be. The old
    // heuristic said "no reasoning control" for both, which tells the user nothing they can do.
    expect(effortUnavailableNote('deepseek-reasoner')).toContain(
      'publishes no controllable reasoning tier',
    );
    expect(effortUnavailableNote('some-custom-endpoint-model')).toContain('models refresh');
  });
});

describe('effortRejectedNote — a rejection the user cannot see is worse than the 400 it replaced', () => {
  it('names the tier refused AND the tiers that would work, in canonical order', () => {
    const note = effortRejectedNote('gpt-5.4-pro', 'low', effortTiersFor('gpt-5.4-pro'));
    expect(note).toContain("does not accept reasoning effort 'low'");
    expect(note).toContain('it takes medium, high, max');
    expect(note).toContain('No tier is sent.'); // the consequence, stated — not left for the bill to reveal
  });

  it("takes the engine gate's Set as readily as the picker's array — one sentence, both callers", () => {
    // `EffortGateResult.rejected` carries `accepted` as an array; the CLI's own list is an array too; the seam's
    // `effortTiersFor` hands back a Set. All three reach this function, and all three must read the same.
    const fromSet = effortRejectedNote('gpt-5.4-pro', 'off', new Set(['high', 'medium'] as const));
    expect(fromSet).toContain('it takes medium, high'); // canonical order, NOT the Set's ['high','medium']
  });

  it('degrades to the unavailable note when NOTHING is accepted — never "it takes " with an empty list', () => {
    expect(effortRejectedNote('deepseek-reasoner', 'high', [])).toBe(
      effortUnavailableNote('deepseek-reasoner'),
    );
  });
});
