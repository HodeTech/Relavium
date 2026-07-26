import { type ReasoningEffort } from '@relavium/shared';

import { effortTiersFor, projectEffortToRow } from '../../chat/effort-notice.js';
import type { ModelPickerKey } from './model-picker.js';

/**
 * The standalone `/effort` overlay ([ADR-0066](../../../../../docs/decisions/0066-normalized-reasoning-effort-control.md) §6)
 * — a keyboard-owning submode (like the `/models` picker + the `/` palette) that lists the reasoning-effort tiers and,
 * on Enter, pushes the chosen tier as the session's per-turn override via the surface's effort setter (NO reseat —
 * effort changes neither provider, pricing, nor the plan).
 *
 * The rows come from the CATALOG, per model ([ADR-0071](../../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6)
 * — it used to be a fixed five-row list, and that was the bug: `gpt-5-pro` accepts exactly one of them.
 * It still needs no port and no async load; the catalog is a synchronous embedded snapshot.
 *
 * Two surfaces route the SAME fold (standalone `relavium chat` + the in-Home live chat); the accept is UNIFORM (call
 * `onSetEffort` + note), so — unlike the model picker's surface-divergent reseat-vs-default-write accept — no
 * per-surface branching lives here. Offered only when the model has a tier to offer; a model with none never opens
 * this overlay (the surface shows `effortUnavailableNote` instead). The pure fold + state live here; the ink
 * view is the shared {@link effort-tier-list.tsx} `EffortTierList`.
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
 * bound model must have at least one tier to OFFER. A model with none — no reasoning, no published knob, or no
 * catalog row at all — returns false, so the surface shows {@link effortUnavailableNote} rather than a dead overlay.
 * Shared by the standalone chat + the in-Home chat so the gate can never diverge between them.
 */
export function canControlEffort(model: string | undefined, setterWired: boolean): boolean {
  return setterWired && model !== undefined && effortTiersFor(model).length > 0;
}

/** Clamp an index to `0..count-1`, or 0 for an empty list (a model with no tiers never opens the overlay). */
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
  // The opening highlight lands on the bound tier, or the neutral `medium` when nothing is bound — but PROJECTED
  // onto a surviving row first (ADR-0066 amendment): a graded-collapsed model (deepseek [off,high,max]) has no
  // `medium` row, and a bare `indexOf('medium')` = -1 → 0 = `off` would silently open on reasoning-DISABLED. The
  // projection folds `medium`→`high` (its wire twin) / a budget model's neutral→the `on` row, so the cursor never
  // lands on `off` by accident. `undefined` (nothing represents it) still clamps to 0.
  const target = projectEffortToRow(model, tiers, current ?? 'medium');
  const index = target === undefined ? 0 : tiers.indexOf(target);
  return { tiers, selected: Math.max(0, index), current, model };
}

/**
 * Fold one keystroke into the open effort overlay (the keyboard-owning contract, mirroring the model-picker fold).
 * `Ctrl-C`/`Esc` cancel (nothing applied); `↑`/`↓` move over {@link EffortPickerState.tiers} — the tiers THIS
 * model accepts, not the fixed five; `Enter` accepts the
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
