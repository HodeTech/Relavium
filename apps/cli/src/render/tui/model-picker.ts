import type { ModelCatalogEntry } from '@relavium/llm';

import { dropLastCodePoint } from './chat-input.js';

/**
 * The `/models` picker submode (workstream **2.5.G S7**, [ADR-0064](../../../../../docs/decisions/0064-live-model-catalog.md) §10)
 * — a keyboard-owning overlay (like the `/` palette + the `@`-mention completion) that lists the MERGED model
 * catalog and, on selection, writes the NEXT session's default model ([ADR-0063](../../../../../docs/decisions/0063-cli-config-write-contract.md));
 * it does NOT rebind the live session (that is the Phase-2.6 `/models` reseat, ADR-0059). Home-only (`availableIn: ['home']`).
 *
 * The PURE model — state + fold + the display formatters — lives here; the ink view ({@link model-picker-view.tsx})
 * renders it and the Home controller routes keys + does the async db/refresh/write I/O (mirroring the mention submode).
 * A DIMMED (unavailable-on-your-key) or a deprecated model is still shown (ADR-0064 §6/§7: dim/flag, never hide) but
 * a dimmed model is **non-selectable** — accepting one yields a `blocked` step, not a write.
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
  | { readonly kind: 'close' } // Esc / Ctrl-C — cancel without writing a default
  | { readonly kind: 'accept'; readonly modelId: string; readonly displayName: string } // set the default
  | { readonly kind: 'blocked'; readonly displayName: string } // a dimmed/unavailable model — non-selectable (ADR §6)
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
 * Fold one keystroke into the open picker (the keyboard-owning contract, mirroring the mention submode):
 * `Esc`/`Ctrl-C` cancels (no write); `Ctrl+R` refreshes; `↑`/`↓` move; `Enter` accepts the selected model — a
 * DIMMED (unavailable) model yields `blocked` (non-selectable, ADR §6), an empty list closes; backspace trims the
 * filter; a single printable code point extends the filter (a multi-char paste blob is dropped, matching the other
 * submodes); every other key stays open.
 */
export function foldModelPickerKey(
  char: string,
  key: ModelPickerKey,
  state: ModelPickerState,
): ModelPickerStep {
  // Esc / Ctrl-C cancels the picker (nothing is written — a cancel never changes the default).
  if (key.escape === true || (key.ctrl === true && char === 'c')) {
    return { kind: 'close' };
  }
  // Ctrl+R forces a live refresh (distinct from the auto TTL refresh on open). `r` alone extends the filter.
  if (key.ctrl === true && char === 'r') {
    return { kind: 'refresh' };
  }
  const visible = visibleModels(state);
  const arrow = foldArrow(key, state, visible.length);
  if (arrow !== undefined) return arrow;
  if (key.return === true) {
    const chosen = visible[clampSelection(state.selected, visible.length)];
    if (chosen === undefined) return { kind: 'close' }; // an empty list — Enter is a gentle cancel
    if (!chosen.available) return { kind: 'blocked', displayName: chosen.displayName };
    return { kind: 'accept', modelId: chosen.modelId, displayName: chosen.displayName };
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
