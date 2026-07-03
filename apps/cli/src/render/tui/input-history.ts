/**
 * In-memory, per-session command history for the chat prompt (2.5.D step 3) — Up/Down recall past submissions,
 * `Ctrl+R` reverse-searches them. Pure model (no ink), so the navigation contract is unit-tested; the chat
 * surfaces (ChatApp + the in-Home chat) each hold one {@link InputHistory} and apply the recalled text to their
 * editor. NOT persisted across sessions — a `chat-resume` starts fresh (cross-session history is a deferred
 * follow-up, see docs/roadmap/deferred-tasks.md).
 */

export interface InputHistory {
  /** Submitted lines, oldest first. */
  readonly entries: readonly string[];
  /** The navigation index into `entries` while recalling (`null` ⇒ not navigating — on the live draft). */
  readonly navIndex: number | null;
  /** The live buffer saved when navigation began; restored when the user pages back down past the newest entry. */
  readonly draft: string;
}

export const EMPTY_HISTORY: InputHistory = { entries: [], navIndex: null, draft: '' };

/** Record a submitted line (skips an empty line and a consecutive duplicate); resets any active navigation. */
export function recordHistory(history: InputHistory, line: string): InputHistory {
  if (line.length === 0) return resetHistoryNav(history);
  const last = history.entries[history.entries.length - 1];
  const entries = last === line ? history.entries : [...history.entries, line];
  return { entries, navIndex: null, draft: '' };
}

/**
 * Recall the PREVIOUS (older) entry — `Up` at the top line of the buffer. `currentText` is the live buffer, saved
 * as the draft when navigation begins. Returns the new history + the text to load, or `null` when there is
 * nothing older (empty history, or already at the oldest entry).
 */
export function historyPrev(
  history: InputHistory,
  currentText: string,
): { readonly history: InputHistory; readonly text: string } | null {
  if (history.entries.length === 0) return null;
  const index = history.navIndex === null ? history.entries.length - 1 : history.navIndex - 1;
  if (index < 0) return null; // already at the oldest entry
  const text = history.entries[index];
  if (text === undefined) return null;
  const draft = history.navIndex === null ? currentText : history.draft;
  return { history: { ...history, navIndex: index, draft }, text };
}

/**
 * Recall the NEXT (newer) entry — `Down`. At (past) the newest entry, restore the saved draft and EXIT
 * navigation. Returns `null` when not navigating (so the caller can fall through to a vertical cursor move).
 */
export function historyNext(
  history: InputHistory,
): { readonly history: InputHistory; readonly text: string } | null {
  if (history.navIndex === null) return null;
  const index = history.navIndex + 1;
  if (index >= history.entries.length) {
    return { history: { ...history, navIndex: null }, text: history.draft }; // back to the live draft
  }
  const text = history.entries[index];
  if (text === undefined) return null;
  return { history: { ...history, navIndex: index }, text };
}

/** Reset navigation — called when the user EDITS the buffer (the recalled entry becomes their new live draft). */
export function resetHistoryNav(history: InputHistory): InputHistory {
  return history.navIndex === null ? history : { ...history, navIndex: null, draft: '' };
}

/* -------------------------------------------------------------------------------------------------- *
 * Ctrl+R reverse-incremental search — a keyboard-owning submode (like the `/` palette). The state is
 * pure; the ink view renders the query line + the current match, and the caller loads the match on accept.
 * -------------------------------------------------------------------------------------------------- */

export interface ReverseSearchState {
  readonly query: string;
  /** The index in `entries` of the current match (`null` ⇒ no match for the query). */
  readonly matchIndex: number | null;
}

export const INITIAL_REVERSE_SEARCH: ReverseSearchState = { query: '', matchIndex: null };

/** The newest entry at or before `fromIndex` that CONTAINS `query` (case-insensitive); `null` ⇒ none. */
function findMatch(entries: readonly string[], query: string, fromIndex: number): number | null {
  const needle = query.toLowerCase();
  for (let i = Math.min(fromIndex, entries.length - 1); i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && entry.toLowerCase().includes(needle)) return i;
  }
  return null;
}

/** Set the search query and re-search from the newest entry (an empty query has no match). */
export function reverseSearchSetQuery(
  entries: readonly string[],
  query: string,
): ReverseSearchState {
  const matchIndex = query.length === 0 ? null : findMatch(entries, query, entries.length - 1);
  return { query, matchIndex };
}

/** `Ctrl+R` again — step to the NEXT older match for the same query (a no-op at the oldest match / no match). */
export function reverseSearchOlder(
  entries: readonly string[],
  state: ReverseSearchState,
): ReverseSearchState {
  if (state.matchIndex === null || state.matchIndex === 0) return state;
  const matchIndex = findMatch(entries, state.query, state.matchIndex - 1);
  return matchIndex === null ? state : { ...state, matchIndex };
}

/** The matched entry's text, or `undefined` when there is no current match. */
export function reverseSearchMatchText(
  entries: readonly string[],
  state: ReverseSearchState,
): string | undefined {
  return state.matchIndex === null ? undefined : entries[state.matchIndex];
}

/** The minimal key fields the reverse-search fold reads (a structural subset of ink's `Key`). */
export interface ReverseSearchKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly escape?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

/** What a keystroke does to the open reverse-search submode. */
export type ReverseSearchStep =
  | { readonly kind: 'close' } // Esc / Ctrl-C — cancel, keep the buffer as-is
  | { readonly kind: 'accept'; readonly text: string } // Enter on a match — load it into the buffer + close
  | { readonly kind: 'state'; readonly state: ReverseSearchState };

/**
 * Fold one keystroke into the open reverse-search submode (the keyboard-owning contract, mirroring the `/`
 * palette): `Esc`/`Ctrl-C` cancels; `Enter` accepts the current match (or cancels if there is none); `Ctrl+R`
 * again steps to the next older match; backspace trims the query; a printable char extends it; every other key is
 * ignored (stays open).
 */
export function foldReverseSearchKey(
  char: string,
  key: ReverseSearchKey,
  state: ReverseSearchState,
  entries: readonly string[],
): ReverseSearchStep {
  if (key.escape === true || (key.ctrl === true && char === 'c')) return { kind: 'close' };
  if (key.return === true) {
    const text = reverseSearchMatchText(entries, state);
    return text === undefined ? { kind: 'close' } : { kind: 'accept', text };
  }
  if (key.ctrl === true && char === 'r') {
    return { kind: 'state', state: reverseSearchOlder(entries, state) };
  }
  if (key.backspace === true || key.delete === true) {
    return { kind: 'state', state: reverseSearchSetQuery(entries, state.query.slice(0, -1)) };
  }
  if (char.length > 0 && key.ctrl !== true && key.meta !== true) {
    return { kind: 'state', state: reverseSearchSetQuery(entries, state.query + char) };
  }
  return { kind: 'state', state }; // ignore other keys, stay open
}
