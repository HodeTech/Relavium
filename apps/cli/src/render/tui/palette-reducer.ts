import type { ReplCommand } from '../../commands/repl-commands.js';
import { dropLastCodePoint } from './chat-input.js';
import {
  bestMatchIndex,
  filterPaletteEntries,
  firstEnabledIndex,
  lastEnabledIndex,
  type PaletteEntry,
} from './palette-entries.js';

/**
 * The pure keystroke reducer for the interactive `/` command palette (2.5.C S3b,
 * [ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md) amendment; the rows, the layout and the
 * dim-row rules are MVP-11 Step 2.2, [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7). Like
 * {@link reduceChatKey} / {@link reduceHomeKey} it is a PURE `(char, key) → action` mapping plus a pure
 * `(state, action, list) → step` fold, so the palette's filter/navigate/select contract is unit-tested
 * without mounting ink. BOTH palette surfaces — the single-tree `HomeController` and the standalone `ChatApp` —
 * drive the SAME reducer; each owns only the {@link OpenPalette} `| undefined` storage and renders {@link PaletteView}.
 *
 * Ctrl-C is deliberately NOT handled here — it is the always-escapes hatch the outer key router owns (it closes
 * the palette AND breaks any paste latch), so the palette can never trap the user.
 */

/** The `ink` `Key` fields the palette reads (a structural subset, so a test needs no ink import). */
export interface PaletteKey {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

/** The palette overlay's transient state — the filter query and the highlighted index into the EFFECTIVE rows ({@link PaletteList.rows}). */
export interface PaletteState {
  readonly query: string;
  readonly index: number;
}

/**
 * Which way the list runs away from the prompt (ADR-0145 §7.1): the FIRST row touches the prompt on every surface. On the Home the list opens
 * UNDER the prompt (`down`: the first row is the top one); in a chat it opens ABOVE the prompt (`up`: the first row is the bottom one, so it
 * renders bottom-up and the arrow keys follow the screen).
 */
export type PaletteLayout = 'down' | 'up';

/**
 * What a host stores beside the {@link PaletteState}: the entries as they were built (declared order), the effective rows for the current
 * query and the layout. **Built once per change** and read by BOTH the key fold and the view, so they cannot disagree on the highlighted row.
 */
export interface PaletteList {
  readonly entries: readonly PaletteEntry[];
  readonly rows: readonly PaletteEntry[];
  readonly layout: PaletteLayout;
}

/**
 * An open palette: the state AND the rows it reads, as ONE value. The highlighted index is an index into THESE rows, so the two are never
 * stored apart: a host keeps an `OpenPalette | undefined`, and a state without its rows (or rows without their state) is not a value the
 * types admit.
 */
export interface OpenPalette {
  readonly state: PaletteState;
  readonly list: PaletteList;
}

/**
 * Open a palette over `entries`: an empty query and the highlight on the FIRST ENABLED row, never row 0 by default (so `/` then `Enter` can
 * never leave the application or run a command that is dim).
 */
export function openPalette(entries: readonly PaletteEntry[], layout: PaletteLayout): OpenPalette {
  return {
    state: { query: '', index: firstEnabledIndex(entries) },
    list: { entries, rows: entries, layout },
  };
}

/** What one palette keystroke maps to. The caller folds it with {@link stepPalette}. */
export type PaletteKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'append'; readonly char: string }
  | { readonly kind: 'backspace' }
  // `delta` is in the LIST's order (+1 is the next entry, whichever way the screen draws it).
  | { readonly kind: 'move'; readonly delta: number }
  | { readonly kind: 'jump'; readonly to: 'first' | 'last' }
  | { readonly kind: 'select' }
  | { readonly kind: 'cancel' };

/**
 * Map one keystroke to a palette action. Escape cancels; Return selects the highlighted row; ↑/↓ move **along the screen** (`down`: ↓ is the
 * next entry; `up`: ↑ is the next entry, because the list is drawn bottom-up); Home/End jump to the first/last entry in LIST order (the
 * first row is the one beside the prompt, `/exit` the farthest); a printable char (no ctrl/meta chord) extends the query; backspace/delete
 * shortens it; everything else is `none`.
 */
export function reducePaletteKey(
  char: string,
  key: PaletteKey,
  layout: PaletteLayout = 'down',
): PaletteKeyAction {
  if (key.escape === true) return { kind: 'cancel' };
  if (key.return === true) return { kind: 'select' };
  const next = layout === 'down' ? 1 : -1;
  if (key.upArrow === true) return { kind: 'move', delta: -next };
  if (key.downArrow === true) return { kind: 'move', delta: next };
  if (key.home === true) return { kind: 'jump', to: 'first' };
  if (key.end === true) return { kind: 'jump', to: 'last' };
  if (key.backspace === true || key.delete === true) return { kind: 'backspace' };
  if (char.length > 0 && key.ctrl !== true && key.meta !== true) return { kind: 'append', char };
  return { kind: 'none' };
}

/** Whether a keystroke should OPEN the palette: a literal `/` at an idle, EMPTY prompt (not a chord). Shared by
 *  both surfaces so the open trigger is identical and tested once. */
export function shouldOpenPalette(
  char: string,
  key: PaletteKey,
  running: boolean,
  bufferLength: number,
): boolean {
  return !running && bufferLength === 0 && char === '/' && key.ctrl !== true && key.meta !== true;
}

/** Clamp an index into `[0, count - 1]` (or `0` when the filtered list is empty). */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * The result of folding one keystroke: keep the palette open with new state (and the rows that state reads), run the highlighted command,
 * say why the highlighted one cannot run (the palette stays open), or close.
 */
export type PaletteStep =
  // `run` carries only the command — the palette submits its bare `/<name>` line today (every curated command is
  // zero-arg). S4 (arg-taking commands like `/doctor --deep`) must extend this + the dispatch — see ReplCommand.
  | { readonly kind: 'state'; readonly palette: OpenPalette }
  | { readonly kind: 'run'; readonly command: ReplCommand | undefined }
  // `Enter` on a dim row (a typed exact name that is dim included): the host shows `reason` and keeps the palette open. Never "unknown
  // command", never run.
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'close' };

/**
 * The complete fold both palette surfaces share: map a keystroke to a step against the open palette. Ctrl-C is the
 * always-escapes hatch (it `close`s the palette so the user is never trapped); everything else delegates to
 * {@link reducePaletteKey} + {@link stepPalette}. Both the single-tree `HomeController` and the standalone
 * `ChatApp` call THIS, so the open-palette key contract is tested once and can never diverge.
 */
export function foldPaletteKey(char: string, key: PaletteKey, palette: OpenPalette): PaletteStep {
  if (key.ctrl === true && char === 'c') return { kind: 'close' };
  return stepPalette(palette, reducePaletteKey(char, key, palette.list.layout));
}

/** The next row from `from` in `direction` that can act, or `from` itself when there is none (no wrap-around). */
function nextEnabled(rows: readonly PaletteEntry[], from: number, direction: 1 | -1): number {
  for (let at = from + direction; at >= 0 && at < rows.length; at += direction) {
    if (rows[at]?.enabled === true) return at;
  }
  return from;
}

/**
 * Fold one {@link PaletteKeyAction} against the open palette (its state and the rows the host built). An edit re-filters and puts the highlight on the
 * first row that can act; a move skips dim rows and clamps at both ends (no wrap-around); `select` reads the highlighted row: a row that can
 * act runs, a dim one answers with its reason (and the palette stays open), and an empty filter is `undefined` — the caller treats that as a
 * no-op close or, at the landing, as a typed line of the person's own.
 */
export function stepPalette(palette: OpenPalette, action: PaletteKeyAction): PaletteStep {
  const { state, list } = palette;
  switch (action.kind) {
    case 'cancel':
      return { kind: 'close' };
    case 'select': {
      const row = list.rows[state.index];
      if (row === undefined) return { kind: 'run', command: undefined };
      if (!row.enabled) return { kind: 'unavailable', reason: row.reason ?? 'unavailable' };
      return { kind: 'run', command: row.command };
    }
    case 'append':
      return edited(list, state.query + action.char);
    case 'backspace':
      return edited(list, dropLastCodePoint(state.query));
    case 'move': {
      const index = nextEnabled(list.rows, state.index, action.delta > 0 ? 1 : -1);
      return { kind: 'state', palette: { state: { query: state.query, index }, list } };
    }
    case 'jump': {
      const index =
        action.to === 'first' ? firstEnabledIndex(list.rows) : lastEnabledIndex(list.rows);
      return { kind: 'state', palette: { state: { query: state.query, index }, list } };
    }
    case 'none':
      return { kind: 'state', palette };
  }
}

/** A step to a new query: the rows are built ONCE here, from the entries the palette opened over, and the highlight follows them. */
function edited(list: PaletteList, query: string): PaletteStep {
  const rows = filterPaletteEntries(list.entries, query);
  return {
    kind: 'state',
    palette: { state: { query, index: bestMatchIndex(rows, query) }, list: { ...list, rows } },
  };
}
