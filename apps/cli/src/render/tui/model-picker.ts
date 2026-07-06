import type { ModelCatalogEntry, ProviderId } from '@relavium/llm';
import { REASONING_EFFORTS, type ReasoningEffort } from '@relavium/shared';

import { dropLastCodePoint } from './chat-input.js';

/**
 * The `/models` picker submode (workstream **2.5.G S7**, [ADR-0064](../../../../../docs/decisions/0064-live-model-catalog.md) §10)
 * — a keyboard-owning overlay (like the `/` palette + the `@`-mention completion) that lists the MERGED model
 * catalog and, on selection, acts on the chosen model. It serves TWO surfaces off the SAME pure fold: the **Home**
 * writes the NEXT session's default model ([ADR-0063](../../../../../docs/decisions/0063-cli-config-write-contract.md)),
 * and the **chat REPL** (ADR-0059) rebinds the live session mid-conversation via a host-side reseat — both keyed off
 * the one `accept` step (which carries the model id + provider). The Home version is `availableIn: ['home']` for the
 * config-write action; the chat version is triggered by a typed `/models` intercepted at the ink layer.
 *
 * The PURE model — state + fold + the display formatters — lives here; the ink view ({@link model-picker-view.tsx})
 * renders it and each surface (the Home controller / the chat ink `ChatApp`) routes keys + does the async db/refresh
 * + the accept action (mirroring the mention submode). A DIMMED (unavailable-on-your-key) or a deprecated model is
 * still shown (ADR-0064 §6/§7: dim/flag, never hide) but a dimmed model is **non-selectable** — accepting one yields
 * a `blocked` step, not an action.
 */

/**
 * The picker submode state. `entries` is the whole merged catalog (all providers, already deterministically
 * ordered by the merge); `filter` narrows it (case-insensitive, over display name / model id / provider);
 * `selected` indexes the VISIBLE (filtered) subset; `loading` is `true` while a refresh is in flight (the spinner);
 * `currentDefault` is the effective default model marked `✓`; `refreshedAt` is the newest live-refresh epoch-ms
 * (the "last updated" badge).
 *
 * Two DISTINCT status channels (kept separate so an async refresh completing can never wipe a synchronous action
 * message, and vice versa): `banner` is the secret-free per-provider partial-failure **refresh status** (set only
 * by a refresh; persists until the next refresh); `hint` is the transient **user-action** feedback (a dimmed
 * "not available on your key" / a "could not save" note), cleared on the next navigation/filter keystroke.
 */
export interface ModelPickerState {
  readonly entries: readonly ModelCatalogEntry[];
  readonly filter: string;
  readonly selected: number;
  readonly loading: boolean;
  readonly currentDefault: string | undefined;
  readonly refreshedAt: number | undefined;
  readonly banner: string | undefined;
  readonly hint: string | undefined;
  /**
   * The picker's TWO-PHASE step ([ADR-0066](../../../../../docs/decisions/0066-normalized-reasoning-effort-control.md)):
   * `'model'` is the catalog list (the default); accepting a reasoning-capable model on a reseat surface
   * ({@link effortStep}) advances to `'effort'` — a fixed sub-list of the reasoning-effort tiers for the chosen
   * model. The two surfaces route the SAME fold, so the phase transition lives here, not in either host.
   */
  readonly phase: 'model' | 'effort';
  /**
   * Whether this picker offers the reasoning-effort sub-step. `true` for a LIVE reseat surface (standalone
   * `relavium chat` + the in-Home live chat, where the effort binds onto the reseated agent, ADR-0059); `false`
   * for the bare-Home next-session-default write (which persists only the model, ADR-0063 — the effort default is
   * the `[chat].reasoning_effort` config key, not a per-write pick), so a non-reseat surface stays single-phase.
   */
  readonly effortStep: boolean;
  /** The model chosen in `'model'` phase, awaiting an effort pick — carried so `'effort'`'s accept emits the pair. */
  readonly pending: {
    readonly modelId: string;
    readonly displayName: string;
    readonly provider: ProviderId;
  } | undefined;
  /** The highlighted index into {@link REASONING_EFFORTS} while in `'effort'` phase. */
  readonly effortSelected: number;
  /** The session's currently-bound effort (the `✓` in the effort sub-list + the initial highlight); `undefined` ⇒
   *  no effort bound (the provider default), so the sub-list opens on a neutral middle tier. */
  readonly currentEffort: ReasoningEffort | undefined;
}

/** The minimal key fields the picker fold reads (a structural subset of ink's `Key`). */
export interface ModelPickerKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly escape?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
}

/** What a keystroke does to the open picker. */
export type ModelPickerStep =
  | { readonly kind: 'close' } // Esc / Ctrl-C — cancel without acting
  // Accept the selected model. `provider` rides along (the entry is authoritative) so the chat reseat (ADR-0059)
  // has its `{ modelId, provider }` target; the Home's default-write reads only `modelId`/`displayName`.
  // `reasoningEffort` is present iff the effort sub-step ran (a reasoning-capable model on a reseat surface,
  // ADR-0066); absent ⇒ the reseat drops any prior effort (a non-reasoning model can't use one) / the default-write
  // ignores it.
  | {
      readonly kind: 'accept';
      readonly modelId: string;
      readonly displayName: string;
      readonly provider: ProviderId;
      readonly reasoningEffort?: ReasoningEffort;
    }
  | {
      readonly kind: 'blocked'; // a dimmed/unavailable model — non-selectable (ADR-0064 §6)
      readonly displayName: string;
      readonly provider: ProviderId; // so the host hint can name the remedy (`no key for <provider>`)
      readonly reason?: 'no-key' | 'not-on-key'; // WHY it is unavailable (2.5.G key-awareness)
    }
  | { readonly kind: 'refresh' } // Ctrl+R — force a live re-fetch of every connected provider
  | { readonly kind: 'state'; readonly state: ModelPickerState };

/** The visible entries — those whose display name / model id / provider contains `filter` (case-insensitive);
 *  order is the merge's (deterministic). An empty filter shows everything. */
export function visibleModels(state: ModelPickerState): readonly ModelCatalogEntry[] {
  if (state.filter.length === 0) return state.entries;
  const needle = state.filter.toLowerCase();
  return state.entries.filter(
    (entry) =>
      entry.displayName.toLowerCase().includes(needle) ||
      entry.modelId.toLowerCase().includes(needle) ||
      entry.provider.toLowerCase().includes(needle),
  );
}

/** Clamp a selection index to `0..count-1` (or 0 when the list is empty). */
function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/** `↑`/`↓` move the selection (clamped to the visible list); `undefined` when the key is not an arrow. */
function foldArrow(
  key: ModelPickerKey,
  state: ModelPickerState,
  visibleCount: number,
): ModelPickerStep | undefined {
  if (key.upArrow === true) {
    return { kind: 'state', state: { ...state, selected: clampSelection(state.selected - 1, visibleCount) } };
  }
  if (key.downArrow === true) {
    return { kind: 'state', state: { ...state, selected: clampSelection(state.selected + 1, visibleCount) } };
  }
  return undefined;
}

/**
 * Fold one keystroke into the open picker (the keyboard-owning contract, mirroring the mention submode). Two phases
 * (ADR-0066): `'model'` (the catalog) delegates to {@link foldModelPhaseKey}; `'effort'` (the reasoning-effort
 * sub-list) delegates to {@link foldEffortPhaseKey}. `Ctrl-C` is the hard cancel from EITHER phase (nothing written).
 */
export function foldModelPickerKey(
  char: string,
  key: ModelPickerKey,
  state: ModelPickerState,
): ModelPickerStep {
  // Ctrl-C is the hard cancel from any phase (nothing is written). Esc is phase-scoped: it cancels the model list
  // but only backs OUT of the effort sub-list to the model list (handled in foldEffortPhaseKey).
  if (key.ctrl === true && char === 'c') return { kind: 'close' };
  return state.phase === 'effort'
    ? foldEffortPhaseKey(char, key, state)
    : foldModelPhaseKey(char, key, state);
}

/**
 * The `'model'` phase fold: `Esc` cancels (no write); `Ctrl+R` refreshes; `↑`/`↓` move; `Enter` accepts the selected
 * model — a DIMMED (unavailable) model yields `blocked` (non-selectable, ADR §6), an empty list closes; a
 * reasoning-capable model on a reseat surface (`effortStep`) instead advances to the `'effort'` sub-step (ADR-0066);
 * backspace trims the filter; a single printable code point extends the filter (a multi-char paste blob is dropped);
 * every other key stays open.
 */
function foldModelPhaseKey(
  char: string,
  key: ModelPickerKey,
  state: ModelPickerState,
): ModelPickerStep {
  if (key.escape === true) return { kind: 'close' };
  // Ctrl+R forces a live refresh (distinct from the auto TTL refresh on open). `r` alone extends the filter.
  // Ignored while a refresh is already in flight (`loading`) — so two rapid Ctrl+R can't race two refreshes whose
  // out-of-order completion would flash a stale banner over a fresher one. Stays open, unchanged.
  if (key.ctrl === true && char === 'r') {
    return state.loading ? { kind: 'state', state } : { kind: 'refresh' };
  }
  const visible = visibleModels(state);
  const arrow = foldArrow(key, state, visible.length);
  if (arrow !== undefined) return arrow;
  if (key.return === true) {
    const chosen = visible[clampSelection(state.selected, visible.length)];
    if (chosen === undefined) return { kind: 'close' }; // an empty list — Enter is a gentle cancel
    if (!chosen.available) {
      return {
        kind: 'blocked',
        displayName: chosen.displayName,
        provider: chosen.provider,
        ...(chosen.unavailableReason !== undefined ? { reason: chosen.unavailableReason } : {}),
      };
    }
    // A reasoning-capable model on a reseat surface advances to the effort sub-step (ADR-0066) instead of accepting
    // immediately; the sub-list opens on the session's bound effort (else a neutral middle tier).
    if (state.effortStep && chosen.supportsReasoning) {
      return {
        kind: 'state',
        state: {
          ...state,
          phase: 'effort',
          pending: {
            modelId: chosen.modelId,
            displayName: chosen.displayName,
            provider: chosen.provider,
          },
          effortSelected: initialEffortIndex(state.currentEffort),
          hint: undefined,
        },
      };
    }
    return {
      kind: 'accept',
      modelId: chosen.modelId,
      displayName: chosen.displayName,
      provider: chosen.provider,
    };
  }
  if (key.backspace === true || key.delete === true) {
    if (state.filter.length === 0) return { kind: 'state', state }; // nothing to trim (Esc cancels; backspace is inert)
    // Trim by whole CODE POINT so backspacing an astral char removes it whole (no lone surrogate) — same discipline
    // as the other submodes' `dropLastCodePoint`.
    return { kind: 'state', state: { ...state, filter: dropLastCodePoint(state.filter), selected: 0 } };
  }
  // A single printable code point extends the filter (a multi-char paste blob is dropped); any other key stays open.
  if ([...char].length === 1 && key.ctrl !== true && key.meta !== true) {
    return { kind: 'state', state: { ...state, filter: state.filter + char, selected: 0 } };
  }
  return { kind: 'state', state };
}

/**
 * The `'effort'` phase fold (ADR-0066): a fixed sub-list of the reasoning-effort tiers for the {@link ModelPickerState.pending}
 * model. `Esc` backs OUT to the model list (Ctrl-C, handled by the caller, is the hard cancel); `↑`/`↓` move over
 * {@link REASONING_EFFORTS}; `Enter` accepts the chosen model + the highlighted tier. There is no filter or refresh
 * here (a fixed five-item list), so every other key is inert.
 */
function foldEffortPhaseKey(
  char: string,
  key: ModelPickerKey,
  state: ModelPickerState,
): ModelPickerStep {
  if (key.escape === true) {
    return { kind: 'state', state: { ...state, phase: 'model', pending: undefined } };
  }
  if (key.upArrow === true) {
    const next = clampSelection(state.effortSelected - 1, REASONING_EFFORTS.length);
    return { kind: 'state', state: { ...state, effortSelected: next } };
  }
  if (key.downArrow === true) {
    const next = clampSelection(state.effortSelected + 1, REASONING_EFFORTS.length);
    return { kind: 'state', state: { ...state, effortSelected: next } };
  }
  if (key.return === true) {
    const pending = state.pending;
    const effort = REASONING_EFFORTS[clampSelection(state.effortSelected, REASONING_EFFORTS.length)];
    // Defensive: a missing pending model (never expected — set on the transition) or an out-of-range tier backs out
    // to the model list rather than emitting a malformed accept.
    if (pending === undefined || effort === undefined) {
      return { kind: 'state', state: { ...state, phase: 'model', pending: undefined } };
    }
    return {
      kind: 'accept',
      modelId: pending.modelId,
      displayName: pending.displayName,
      provider: pending.provider,
      reasoningEffort: effort,
    };
  }
  return { kind: 'state', state };
}

/** The effort sub-list's opening highlight: the session's bound effort, else a neutral middle tier (`'medium'`). */
function initialEffortIndex(currentEffort: ReasoningEffort | undefined): number {
  const target = currentEffort ?? 'medium';
  const index = REASONING_EFFORTS.indexOf(target);
  return index < 0 ? 0 : index;
}

/**
 * The one-line hint shown beside each reasoning-effort tier in the effort sub-list (ADR-0066). Display-only, so the
 * picker explains what each tier trades off (latency/cost vs depth) without the user consulting the docs.
 */
export const EFFORT_TIER_HINT: Record<ReasoningEffort, string> = {
  off: 'no reasoning — fastest, lowest cost',
  low: 'brief reasoning',
  medium: 'balanced reasoning',
  high: 'deep reasoning',
  max: 'maximum reasoning — slowest, highest cost',
};

/* -------------------------------------------------------------------------------------------------- *
 * Pure display formatters (unit-tested; the ink view is not render-tested, per the repo convention).
 * -------------------------------------------------------------------------------------------------- */

const MICROCENTS_PER_USD = 100_000_000; // 1 USD = 1e8 micro-cents (pricing.ts)

/** A compact USD amount from integer micro-cents-per-Mtok: whole dollars drop the decimals, else up to 2 dp
 *  (`$3`, `$0.15`, `$1.25`). No float pricing is stored; this is display-only. */
function usdPerMtok(microcents: number): string {
  const usd = microcents / MICROCENTS_PER_USD;
  const rounded = Math.round(usd * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/**
 * The per-row price label: `$in/$out per Mtok` from the effective (static/user) pricing, or the ADR-0064 §6
 * "cost cap will not apply" hint when the price is unknown (`priceKnown === false`) — the picker's honest
 * cost-governance signal that a session cap cannot bound this model.
 */
export function formatModelPrice(entry: ModelCatalogEntry): string {
  if (!entry.priceKnown || entry.pricing === undefined) return 'no price — cost cap will not apply';
  const { inputPerMtokMicrocents, outputPerMtokMicrocents } = entry.pricing;
  return `${usdPerMtok(inputPerMtokMicrocents)}/${usdPerMtok(outputPerMtokMicrocents)} per Mtok`;
}

/** A compact context-window label (`200K ctx`, `1M ctx`), or `''` when the window is unknown. */
export function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M ctx`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
  return `${tokens} ctx`;
}

/** The "last updated" freshness badge from the newest live-refresh stamp — `never refreshed` when absent, else a
 *  coarse relative age (`just now` / `5m ago` / `3h ago` / `2d ago`). Pure (the caller passes `now`). */
export function formatRefreshedBadge(refreshedAt: number | undefined, now: number): string {
  if (refreshedAt === undefined) return 'never refreshed';
  const ms = Math.max(0, now - refreshedAt);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'updated just now';
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

/**
 * Summarize a refresh report's per-provider failures into a secret-free banner, or `undefined` when every
 * considered provider refreshed/was-skipped cleanly. Names the failed providers + the count of others that
 * kept last-known rows (ADR-0064 §8: drift/failure is visible, non-fatal). The per-provider `error` strings are
 * already seam-redacted; this joins only the provider ids, never an error body.
 */
export function partialFailureBanner(
  failedProviders: readonly string[],
): string | undefined {
  if (failedProviders.length === 0) return undefined;
  const list = failedProviders.join(', ');
  return `couldn't refresh ${list} — showing last-known models`;
}
