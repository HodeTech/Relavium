/**
 * The focus of the Home's strip ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6): which actionable row `↓` moved onto. PURE: it holds no clock, no state and no React, and it reads only the rows it is handed.
 *
 * - **The focus is the row's identity, not its index.** A run row is named by the run id and a session row by the session id, so a read
 *   that inserts a row above the focused one (a run another terminal just started, a gate that was raised) moves the row and leaves the
 *   focus on it: "a refresh never moves it". Nothing here looks a row up by its position.
 * - **A row that is gone takes the focus with it.** When the identity is no longer on the strip (the run was answered elsewhere, the
 *   session ended) the focus is dropped, back at the prompt, and no other row is moved onto: a refresh must not hand `Enter` to a row the
 *   person did not choose, which can be a different kind of row.
 * - **One list, in the order the strip draws it.** The Attention items in their urgency order (`attentionOrder`: the parked runs by their
 *   deadline, then those with none, then the failed runs, then the runs whose log cannot be read), then the recent sessions, then the recent
 *   runs. Every row of it can be opened (an unreadable run opens a read-only card that
 *   says why); the rows the strip only displays (an agent) are not in it, so `↑`/`↓` never stop on a row `Enter` has nothing to do with.
 *   The strip draws its rows from the same list (`home-view.tsx`), so what it shows and what the keys reach come from one place.
 */

import type { HomeSnapshot } from '../../home/home-store.js';
import { attentionOrder, type ParkedRunRow } from './home-attention.js';

/** What a focus names: a run (every run row of the strip) or a session. */
export type StripFocusKind = 'run' | 'session';

/**
 * What a row is on the strip, and so what `Enter` does on it: a `parked` run opens its gate or budget card, a `failed` or a `recent` run
 * opens its detail in History (the run this Home hosts opens its view instead), an `unreadable` run opens a read-only card saying which run
 * it is and why its log cannot be read, and a `session` is resumed.
 */
export type StripRole = 'parked' | 'failed' | 'unreadable' | 'recent' | 'session';

export interface StripRow {
  readonly kind: StripFocusKind;
  /** The run id or the session id: the row's identity, never its position. */
  readonly id: string;
  readonly role: StripRole;
}

/** The row `↓` moved onto: its identity, never its position. */
export interface StripFocus {
  readonly kind: StripFocusKind;
  readonly id: string;
}

/**
 * The strip's rows that can be focused, in the order the strip draws them: the Attention items in their urgency order (`attentionOrder`, the
 * one order the rows and page 1 read too), then the sessions, then the recent runs. A run is listed once, by the first role it has (a parked
 * run is not also a recent run), and a run whose log could not be read is one `unreadable` row and never also a parked, failed or recent row.
 */
export function stripRows(
  parked: readonly ParkedRunRow[],
  snapshot: HomeSnapshot,
): readonly StripRow[] {
  const attention = attentionOrder(parked, snapshot);
  const rows: StripRow[] = attention.map((item) => ({
    kind: 'run',
    id: item.runId,
    role: item.kind,
  }));
  const seen = new Set(attention.map((item) => item.runId));
  for (const session of snapshot.recentSessions)
    rows.push({ kind: 'session', id: session.sessionId, role: 'session' });
  for (const run of snapshot.recentRuns) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    rows.push({ kind: 'run', id: run.runId, role: 'recent' });
  }
  return rows;
}

/** Whether `row` is the one `focus` names: by kind and id, never by position. */
export function isFocused(
  row: { readonly kind: StripFocusKind; readonly id: string },
  focus: StripFocus | undefined,
): boolean {
  return focus?.kind === row.kind && focus.id === row.id;
}

/**
 * The index in `rows` the focus stands on now: the row the focus names, looked up by its identity wherever it moved to. `undefined` when
 * there is no focus, when there are no rows, and when the row it named is gone (the focus is then dropped, and no other row stands in).
 */
export function focusFor(
  rows: readonly StripRow[],
  focus: StripFocus | undefined,
): number | undefined {
  if (focus === undefined) return undefined;
  const found = rows.findIndex((row) => isFocused(row, focus));
  return found >= 0 ? found : undefined;
}

/** The focus on the row at `index`, or `undefined` when there is none. */
export function focusAt(rows: readonly StripRow[], index: number): StripFocus | undefined {
  const row = rows[index];
  return row === undefined ? undefined : { kind: row.kind, id: row.id };
}

/**
 * `focus` as it is on `rows` now: the very same object while its row is on the strip (wherever the row moved to), and `undefined` with no
 * focus, no rows, or when the row is gone.
 */
export function resolveFocus(
  rows: readonly StripRow[],
  focus: StripFocus | undefined,
): StripFocus | undefined {
  return focusFor(rows, focus) === undefined ? undefined : focus;
}

/**
 * What the strip's rows reach, for the room a long notice must leave them (`home-notice.ts`): whether an Attention row that `↓` can focus
 * (a parked run, a failed run, a run whose log cannot be read) is listed, and whether a recent run is. A row of either kind is drawn
 * whenever it is focused, so the notice leaves the rows it costs at the least.
 */
export function stripReach(
  parked: readonly ParkedRunRow[],
  snapshot: HomeSnapshot,
): { readonly hasAttentionRuns: boolean; readonly hasRecentRuns: boolean } {
  const rows = stripRows(parked, snapshot);
  return {
    hasAttentionRuns: rows.some(
      (row) => row.role === 'parked' || row.role === 'failed' || row.role === 'unreadable',
    ),
    hasRecentRuns: rows.some((row) => row.role === 'recent'),
  };
}
