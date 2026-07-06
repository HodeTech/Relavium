import type { ModelCatalogEntry } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import {
  foldModelPickerKey,
  formatContextWindow,
  formatModelPrice,
  formatRefreshedBadge,
  partialFailureBanner,
  visibleModels,
  type ModelPickerState,
} from './model-picker.js';

/** A merged catalog entry with sensible defaults; override what a case cares about. */
function entry(
  partial: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'modelId'>,
): ModelCatalogEntry {
  return {
    provider: 'anthropic',
    displayName: partial.modelId,
    pricingSource: 'registry',
    priceKnown: true,
    available: true,
    deprecated: false,
    supportsReasoning: false,
    ...partial,
  };
}

function state(partial: Partial<ModelPickerState> = {}): ModelPickerState {
  return {
    entries: [entry({ modelId: 'a' }), entry({ modelId: 'b' }), entry({ modelId: 'c' })],
    filter: '',
    selected: 0,
    loading: false,
    currentDefault: undefined,
    refreshedAt: undefined,
    banner: undefined,
    hint: undefined,
    phase: 'model',
    effortStep: false,
    pending: undefined,
    effortSelected: 0,
    currentEffort: undefined,
    ...partial,
  };
}

describe('foldModelPickerKey', () => {
  it('Esc and Ctrl-C close the picker (no write)', () => {
    expect(foldModelPickerKey('', { escape: true }, state()).kind).toBe('close');
    expect(foldModelPickerKey('c', { ctrl: true }, state()).kind).toBe('close');
  });

  it('Ctrl+R refreshes; a bare "r" extends the filter; Ctrl+R is IGNORED while already loading', () => {
    expect(foldModelPickerKey('r', { ctrl: true }, state()).kind).toBe('refresh');
    const typed = foldModelPickerKey('r', {}, state());
    expect(typed).toEqual({ kind: 'state', state: state({ filter: 'r', selected: 0 }) });
    // While a refresh is in flight, Ctrl+R is a no-op (stays open, unchanged) — no racing double-refresh.
    const loading = state({ loading: true });
    expect(foldModelPickerKey('r', { ctrl: true }, loading)).toEqual({
      kind: 'state',
      state: loading,
    });
  });

  it('arrows move the selection, clamped to the visible list', () => {
    const down = foldModelPickerKey('', { downArrow: true }, state({ selected: 0 }));
    expect(down).toEqual({ kind: 'state', state: state({ selected: 1 }) });
    // Clamp at the top: Up from 0 stays 0.
    expect(foldModelPickerKey('', { upArrow: true }, state({ selected: 0 }))).toEqual({
      kind: 'state',
      state: state({ selected: 0 }),
    });
    // Clamp at the bottom: Down from the last visible index stays there.
    expect(foldModelPickerKey('', { downArrow: true }, state({ selected: 2 }))).toEqual({
      kind: 'state',
      state: state({ selected: 2 }),
    });
  });

  it('Enter on an AVAILABLE model accepts it (modelId + displayName + provider for the reseat target)', () => {
    const s = state({
      entries: [entry({ modelId: 'x', displayName: 'Model X', provider: 'openai' })],
      selected: 0,
    });
    expect(foldModelPickerKey('', { return: true }, s)).toEqual({
      kind: 'accept',
      modelId: 'x',
      displayName: 'Model X',
      provider: 'openai', // the entry is authoritative — the chat reseat (ADR-0059) needs it
    });
  });

  it('Enter on a DIMMED (unavailable) model is BLOCKED, never an accept — carrying the provider (ADR §6)', () => {
    const s = state({
      entries: [
        entry({ modelId: 'x', displayName: 'Model X', available: false, provider: 'openai' }),
      ],
      selected: 0,
    });
    expect(foldModelPickerKey('', { return: true }, s)).toEqual({
      kind: 'blocked',
      displayName: 'Model X',
      provider: 'openai',
    });
  });

  it('a `no-key` blocked step carries the reason (so the host hint can name the remedy) (2.5.G)', () => {
    const s = state({
      entries: [
        entry({
          modelId: 'y',
          displayName: 'Model Y',
          provider: 'gemini',
          available: false,
          unavailableReason: 'no-key',
        }),
      ],
      selected: 0,
    });
    expect(foldModelPickerKey('', { return: true }, s)).toEqual({
      kind: 'blocked',
      displayName: 'Model Y',
      provider: 'gemini',
      reason: 'no-key',
    });
  });

  it('Enter on an EMPTY (over-filtered) list is a gentle close, not a crash', () => {
    const s = state({ filter: 'zzzz' }); // matches nothing
    expect(visibleModels(s)).toHaveLength(0);
    expect(foldModelPickerKey('', { return: true }, s).kind).toBe('close');
  });

  it('a printable char extends the filter and resets the selection; backspace trims it', () => {
    const typed = foldModelPickerKey('b', {}, state({ selected: 2 }));
    expect(typed).toEqual({ kind: 'state', state: state({ filter: 'b', selected: 0 }) });
    const trimmed = foldModelPickerKey(
      '',
      { backspace: true },
      state({ filter: 'ab', selected: 1 }),
    );
    expect(trimmed).toEqual({ kind: 'state', state: state({ filter: 'a', selected: 0 }) });
    // Backspace on an EMPTY filter is inert (Esc cancels; backspace never closes) — stays open, unchanged.
    expect(foldModelPickerKey('', { backspace: true }, state({ filter: '' }))).toEqual({
      kind: 'state',
      state: state({ filter: '' }),
    });
  });

  it('drops a multi-char paste blob (only a single code point extends the filter)', () => {
    const blob = foldModelPickerKey('pasted text', {}, state());
    expect(blob).toEqual({ kind: 'state', state: state() }); // unchanged
  });

  it('ignores a single CONTROL character (Tab / ESC / NUL / DEL) \u2014 never inserted as invisible filter text', () => {
    for (const control of ['\t', '\x1b', '\x00', '\x7f']) {
      const s = state({ filter: 'ab' });
      expect(foldModelPickerKey(control, {}, s)).toEqual({ kind: 'state', state: s }); // filter unchanged
    }
    // A regular printable char still extends it (the guard rejects only control chars).
    expect(foldModelPickerKey('x', {}, state({ filter: 'ab' }))).toEqual({
      kind: 'state',
      state: state({ filter: 'abx', selected: 0 }),
    });
  });
});

describe('foldModelPickerKey — the ADR-0066 effort sub-step', () => {
  // A reasoning-capable catalog whose first entry (empty filter ⇒ selected 0) supports reasoning.
  const reasoningState = (partial: Partial<ModelPickerState> = {}): ModelPickerState =>
    state({
      entries: [
        entry({ modelId: 'claude-opus-4-8', displayName: 'Opus', supportsReasoning: true }),
        entry({ modelId: 'deepseek-chat', displayName: 'DeepSeek', supportsReasoning: false }),
      ],
      effortStep: true,
      ...partial,
    });

  it('accepts IMMEDIATELY (no effort sub-step) when the surface does not offer it (effortStep=false)', () => {
    // The bare-Home default-write path: even a reasoning-capable model accepts straight to a model-only write.
    const step = foldModelPickerKey('', { return: true }, reasoningState({ effortStep: false }));
    expect(step).toEqual({
      kind: 'accept',
      modelId: 'claude-opus-4-8',
      displayName: 'Opus',
      provider: 'anthropic',
    });
    expect('reasoningEffort' in step).toBe(false); // no tier on a non-effort surface
  });

  it('accepts IMMEDIATELY when the chosen model does NOT support reasoning (even on an effort surface)', () => {
    const step = foldModelPickerKey('', { return: true }, reasoningState({ selected: 1 })); // deepseek (no reasoning)
    expect(step).toEqual({
      kind: 'accept',
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek',
      provider: 'anthropic',
    });
  });

  it('a reasoning model on an effort surface ADVANCES to the effort phase (not an immediate accept)', () => {
    const step = foldModelPickerKey('', { return: true }, reasoningState());
    expect(step.kind).toBe('state');
    if (step.kind !== 'state') throw new Error('expected a state step');
    expect(step.state.phase).toBe('effort');
    expect(step.state.pending).toEqual({
      modelId: 'claude-opus-4-8',
      displayName: 'Opus',
      provider: 'anthropic',
    });
    // No bound effort ⇒ the sub-list opens on the neutral middle tier ('medium', index 2 of off/low/medium/high/max).
    expect(step.state.effortSelected).toBe(2);
  });

  it('opens the effort sub-list on the session BOUND effort when one is set', () => {
    const step = foldModelPickerKey(
      '',
      { return: true },
      reasoningState({ currentEffort: 'high' }),
    );
    if (step.kind !== 'state') throw new Error('expected a state step');
    expect(step.state.effortSelected).toBe(3); // index of 'high'
  });

  // A picker already parked in the effort phase over a pending model (selected tier = 'medium').
  const effortPhase = (partial: Partial<ModelPickerState> = {}): ModelPickerState =>
    reasoningState({
      phase: 'effort',
      pending: { modelId: 'claude-opus-4-8', displayName: 'Opus', provider: 'anthropic' },
      effortSelected: 2,
      ...partial,
    });

  it('↑/↓ move the effort selection, clamped to the tier list', () => {
    expect(foldModelPickerKey('', { downArrow: true }, effortPhase())).toEqual({
      kind: 'state',
      state: effortPhase({ effortSelected: 3 }),
    });
    expect(foldModelPickerKey('', { upArrow: true }, effortPhase())).toEqual({
      kind: 'state',
      state: effortPhase({ effortSelected: 1 }),
    });
    // Clamp at the ends: max (index 4) Down stays 4; off (index 0) Up stays 0.
    expect(foldModelPickerKey('', { downArrow: true }, effortPhase({ effortSelected: 4 }))).toEqual(
      {
        kind: 'state',
        state: effortPhase({ effortSelected: 4 }),
      },
    );
    expect(foldModelPickerKey('', { upArrow: true }, effortPhase({ effortSelected: 0 }))).toEqual({
      kind: 'state',
      state: effortPhase({ effortSelected: 0 }),
    });
  });

  it('Enter in the effort phase accepts the pending model + the highlighted tier', () => {
    expect(foldModelPickerKey('', { return: true }, effortPhase({ effortSelected: 3 }))).toEqual({
      kind: 'accept',
      modelId: 'claude-opus-4-8',
      displayName: 'Opus',
      provider: 'anthropic',
      reasoningEffort: 'high',
    });
    // The lowest tier 'off' is a valid pick (disables reasoning), not a "cancel".
    expect(foldModelPickerKey('', { return: true }, effortPhase({ effortSelected: 0 }))).toEqual({
      kind: 'accept',
      modelId: 'claude-opus-4-8',
      displayName: 'Opus',
      provider: 'anthropic',
      reasoningEffort: 'off',
    });
  });

  it('Esc in the effort phase BACKS OUT to the model list (clears pending) — it does NOT cancel the picker', () => {
    const step = foldModelPickerKey('', { escape: true }, effortPhase());
    expect(step).toEqual({
      kind: 'state',
      state: effortPhase({ phase: 'model', pending: undefined }),
    });
  });

  it('Ctrl-C in the effort phase is the HARD cancel (closes the whole picker)', () => {
    expect(foldModelPickerKey('c', { ctrl: true }, effortPhase()).kind).toBe('close');
  });

  it('filter / other keys are inert in the fixed effort list', () => {
    const s = effortPhase();
    expect(foldModelPickerKey('x', {}, s)).toEqual({ kind: 'state', state: s }); // typing does not filter
    expect(foldModelPickerKey('', { backspace: true }, s)).toEqual({ kind: 'state', state: s });
    expect(foldModelPickerKey('r', { ctrl: true }, s)).toEqual({ kind: 'state', state: s }); // no refresh here
  });
});

describe('visibleModels', () => {
  it('filters by display name, model id, OR provider (case-insensitive)', () => {
    const s = state({
      entries: [
        entry({ modelId: 'claude-opus', displayName: 'Opus', provider: 'anthropic' }),
        entry({ modelId: 'gpt-x', displayName: 'GPT', provider: 'openai' }),
      ],
    });
    expect(visibleModels({ ...s, filter: 'opus' }).map((e) => e.modelId)).toEqual(['claude-opus']);
    expect(visibleModels({ ...s, filter: 'OPENAI' }).map((e) => e.modelId)).toEqual(['gpt-x']);
    expect(visibleModels({ ...s, filter: 'gpt-x' }).map((e) => e.modelId)).toEqual(['gpt-x']);
    expect(visibleModels({ ...s, filter: '' })).toHaveLength(2); // empty filter shows all
  });
});

describe('display formatters', () => {
  it('formats the price, or the "cost cap will not apply" hint when unknown', () => {
    const priced = entry({
      modelId: 'x',
      pricing: {
        provider: 'anthropic',
        nativeId: 'x',
        displayName: 'X',
        contextWindowTokens: 200_000,
        maxOutputTokens: 64_000,
        inputPerMtokMicrocents: 300_000_000, // $3.00
        outputPerMtokMicrocents: 1_500_000_000, // $15.00
        cachedInputPerMtokMicrocents: 0,
      },
      priceKnown: true,
    });
    expect(formatModelPrice(priced)).toBe('$3/$15 per Mtok');
    const unpriced = entry({ modelId: 'y', priceKnown: false, pricingSource: 'none' });
    expect(formatModelPrice(unpriced)).toBe('no price — cost cap will not apply');
  });

  it('formats a fractional price to 2 decimals', () => {
    const priced = entry({
      modelId: 'z',
      pricing: {
        provider: 'openai',
        nativeId: 'z',
        displayName: 'Z',
        contextWindowTokens: 1000,
        maxOutputTokens: 100,
        inputPerMtokMicrocents: 15_000_000, // $0.15
        outputPerMtokMicrocents: 125_000_000, // $1.25
        cachedInputPerMtokMicrocents: 0,
      },
    });
    expect(formatModelPrice(priced)).toBe('$0.15/$1.25 per Mtok');
  });

  it('formats the context window compactly (K / M), or empty when unknown', () => {
    expect(formatContextWindow(200_000)).toBe('200K ctx');
    expect(formatContextWindow(1_000_000)).toBe('1M ctx');
    expect(formatContextWindow(1_500_000)).toBe('1.5M ctx');
    expect(formatContextWindow(undefined)).toBe('');
    expect(formatContextWindow(0)).toBe(''); // the "unknown" sentinel reads as empty, never "0 ctx"
  });

  it('formats the freshness badge from the newest live-refresh stamp', () => {
    expect(formatRefreshedBadge(undefined, 1_000_000)).toBe('never refreshed');
    expect(formatRefreshedBadge(1_000_000, 1_000_000)).toBe('updated just now');
    expect(formatRefreshedBadge(0, 5 * 60_000)).toBe('updated 5m ago');
    expect(formatRefreshedBadge(0, 3 * 60 * 60_000)).toBe('updated 3h ago');
    expect(formatRefreshedBadge(0, 2 * 24 * 60 * 60_000)).toBe('updated 2d ago');
    // A future/negative delta clamps to "just now", never a negative age.
    expect(formatRefreshedBadge(2_000_000, 1_000_000)).toBe('updated just now');
  });

  it('summarizes partial refresh failures into a secret-free banner (or undefined when clean)', () => {
    expect(partialFailureBanner([])).toBeUndefined();
    expect(partialFailureBanner(['openai'])).toBe(
      "couldn't refresh openai — showing last-known models",
    );
    expect(partialFailureBanner(['openai', 'gemini'])).toBe(
      "couldn't refresh openai, gemini — showing last-known models",
    );
  });
});
