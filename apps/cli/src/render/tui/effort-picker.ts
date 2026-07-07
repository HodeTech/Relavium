import { modelSupportsReasoning } from '@relavium/llm';
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
  /** The highlighted index into {@link REASONING_EFFORTS}. */
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
  return setterWired && model !== undefined && modelSupportsReasoning(model);
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
  return { selected: Math.max(0, REASONING_EFFORTS.indexOf(current ?? 'medium')), current, model };
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
      state: { ...state, selected: clampSelection(state.selected - 1, REASONING_EFFORTS.length) },
    };
  }
  if (key.downArrow === true) {
    return {
      kind: 'state',
      state: { ...state, selected: clampSelection(state.selected + 1, REASONING_EFFORTS.length) },
    };
  }
  if (key.return === true) {
    const effort = REASONING_EFFORTS[clampSelection(state.selected, REASONING_EFFORTS.length)];
    // Defensive: an out-of-range highlight (never expected — the fold clamps every move) closes rather than emitting
    // a malformed accept.
    return effort === undefined ? { kind: 'close' } : { kind: 'accept', effort };
  }
  return { kind: 'state', state };
}
