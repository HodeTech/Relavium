import { acceptedTiers, catalogModel } from '@relavium/llm';
import { REASONING_EFFORTS, type ReasoningEffort } from '@relavium/shared';

import type { ModelPickerKey } from './model-picker.js';

/**
 * The standalone `/effort` overlay ([ADR-0066](../../../../../docs/decisions/0066-normalized-reasoning-effort-control.md) §6)
 * — a keyboard-owning submode (like the `/models` picker + the `/` palette) that lists the reasoning-effort tiers and,
 * on Enter, pushes the chosen tier as the session's per-turn override via the surface's effort setter (NO reseat —
 * effort changes neither provider, pricing, nor the plan). It is a FIXED five-row list: no catalog, filter, or
 * refresh — so it needs no port and no async load, unlike the `/models` picker.
 *
 * Two surfaces route the SAME fold (standalone `relavium chat` + the in-Home live chat); the accept is UNIFORM (call
 * `onSetEffort` + note), so — unlike the model picker's surface-divergent reseat-vs-default-write accept — no
 * per-surface branching lives here. Offered ONLY when the bound model is reasoning-capable; a non-reasoning model
 * never opens this overlay (the surface falls through to the `/effort` notice instead). The pure fold + state live
 * here; the ink view is the shared {@link effort-tier-list.tsx} `EffortTierList`.
 */
export interface EffortPickerState {
  /**
   * The tiers THIS MODEL accepts, in canonical order ([ADR-0071](../../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6).
   *
   * It used to be the fixed five. That is the F3 bug: `gpt-5.4-pro` rejects `low`, `gpt-5-pro` accepts only
   * `high`, and `gemini-2.5-pro` cannot be turned off — yet every one of them was offered all five, and picking
   * the wrong one produced an opaque provider 400. **The interactive path can no longer produce an illegal tier,
   * because an illegal tier is not on the list.**
   */
  readonly tiers: readonly ReasoningEffort[];
  /** The highlighted index into {@link EffortPickerState.tiers}. */
  readonly selected: number;
  /** The session's currently-bound effort (the `✓` + the opening highlight); `undefined` ⇒ the provider default, so
   *  the list opens on a neutral middle tier. */
  readonly current: ReasoningEffort | undefined;
  /** The bound model id — shown after the "Reasoning effort" header (sanitized at the display boundary). */
  readonly model: string;
}

/** What a keystroke does to the open effort overlay. */
export type EffortPickerStep =
  | { readonly kind: 'close' } // Esc / Ctrl-C — cancel without acting
  | { readonly kind: 'accept'; readonly effort: ReasoningEffort } // Enter — apply the highlighted tier
  | { readonly kind: 'state'; readonly state: EffortPickerState };

/**
 * Whether a surface should open the interactive `/effort` overlay: the per-turn effort setter must be wired AND the
 * bound model reasoning-capable. A non-reasoning model (or no bound model yet / no setter) returns false, so the
 * surface falls through to the informational `/effort` notice rather than opening a dead overlay. Shared by the
 * standalone chat + the in-Home chat so the gate can never diverge between them.
 */
export function canControlEffort(model: string | undefined, setterWired: boolean): boolean {
  return setterWired && model !== undefined && effortTiersFor(model).length > 0;
}

/**
 * The tiers a model accepts, in canonical order — the picker's whole source of truth.
 *
 * Empty when the model does not reason, exposes no controllable tier (`deepseek-reasoner`), or is not in the
 * catalog at all (a custom endpoint). All three mean the same thing to a surface: there is nothing to offer, so
 * the overlay never opens and the informational notice shows instead.
 */
export function effortTiersFor(model: string): readonly ReasoningEffort[] {
  const entry = catalogModel(model);
  if (entry === undefined) return [];
  const accepted = acceptedTiers(entry.provider, entry.reasoning);
  return REASONING_EFFORTS.filter((tier) => accepted.has(tier)); // canonical order, never the Set's
}

/** Clamp an index to `0..count-1` (or 0 when the list is empty — never for the fixed non-empty tier list). */
function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/** The overlay's opening state: the highlight starts on the bound effort, else a neutral middle tier (`'medium'`). */
export function initialEffortPickerState(
  model: string,
  current: ReasoningEffort | undefined,
): EffortPickerState {
  const tiers = effortTiersFor(model);
  // The opening highlight lands on the bound tier when the model accepts it. The old default was a bare
  // `?? 'medium'` — which `gpt-5-pro` (only `high`) and `gpt-5.4-pro` (no `low`) do not necessarily accept, so
  // the cursor could open on a row that is not there. `indexOf` returning -1 collapses to 0, which is always a
  // tier the model takes, because the list only contains tiers the model takes.
  const index = current === undefined ? tiers.indexOf('medium') : tiers.indexOf(current);
  return { tiers, selected: Math.max(0, index), current, model };
}

/**
 * Fold one keystroke into the open effort overlay (the keyboard-owning contract, mirroring the model-picker fold).
 * `Ctrl-C`/`Esc` cancel (nothing applied); `↑`/`↓` move over {@link REASONING_EFFORTS}; `Enter` accepts the
 * highlighted tier. It is a fixed list with no filter/refresh, so every other key is inert (returns the same state).
 */
export function foldEffortPickerKey(
  char: string,
  key: ModelPickerKey,
  state: EffortPickerState,
): EffortPickerStep {
  if (key.escape === true || (key.ctrl === true && char === 'c')) return { kind: 'close' };
  if (key.upArrow === true) {
    return {
      kind: 'state',
      state: { ...state, selected: clampSelection(state.selected - 1, state.tiers.length) },
    };
  }
  if (key.downArrow === true) {
    return {
      kind: 'state',
      state: { ...state, selected: clampSelection(state.selected + 1, state.tiers.length) },
    };
  }
  if (key.return === true) {
    const effort = state.tiers[clampSelection(state.selected, state.tiers.length)];
    // Defensive: an out-of-range highlight (never expected — the fold clamps every move) closes rather than emitting
    // a malformed accept.
    return effort === undefined ? { kind: 'close' } : { kind: 'accept', effort };
  }
  return { kind: 'state', state };
}
