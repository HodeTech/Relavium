import type { ReplCommand } from '../../commands/repl-commands.js';
import { dropLastCodePoint } from './chat-input.js';

/**
 * The pure keystroke reducer + filter for the interactive `/` command palette (2.5.C S3b,
 * [ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md) amendment). Like
 * {@link reduceChatKey} / {@link reduceHomeKey} it is a PURE `(char, key) → action` mapping plus a pure
 * `(state, action, commands) → step` fold, so the palette's filter/navigate/select contract is unit-tested
 * without mounting ink. BOTH palette surfaces — the single-tree `HomeController` and the standalone `ChatApp` —
 * drive the SAME reducer; each owns only the `PaletteState | undefined` storage and renders {@link PaletteView}.
 *
 * Ctrl-C is deliberately NOT handled here — it is the always-escapes hatch the outer key router owns (it closes
 * the palette AND breaks any paste latch), so the palette can never trap the user.
 */

/** The `ink` `Key` fields the palette reads (a structural subset, so a test needs no ink import). */
export interface PaletteKey {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

/** The palette overlay's transient state — the filter query and the highlighted index into the FILTERED list. */
export interface PaletteState {
  readonly query: string;
  readonly index: number;
}

/** The fresh palette state (empty query, first row highlighted). */
export const INITIAL_PALETTE_STATE: PaletteState = { query: '', index: 0 };

/** What one palette keystroke maps to. The caller folds it with {@link stepPalette}. */
export type PaletteKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'append'; readonly char: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'move'; readonly delta: number }
  | { readonly kind: 'select' }
  | { readonly kind: 'cancel' };

/**
 * Map one keystroke to a palette action. Escape cancels; Return selects the highlighted row; ↑/↓ move; a
 * printable char (no ctrl/meta chord) extends the query; backspace/delete shortens it; everything else is `none`.
 */
export function reducePaletteKey(char: string, key: PaletteKey): PaletteKeyAction {
  if (key.escape === true) return { kind: 'cancel' };
  if (key.return === true) return { kind: 'select' };
  if (key.upArrow === true) return { kind: 'move', delta: -1 };
  if (key.downArrow === true) return { kind: 'move', delta: 1 };
  if (key.backspace === true || key.delete === true) return { kind: 'backspace' };
  if (char.length > 0 && key.ctrl !== true && key.meta !== true) return { kind: 'append', char };
  return { kind: 'none' };
}

/** Case-insensitive substring filter on a command's name OR label (the user's query, sans the leading `/`). */
export function filterPaletteCommands(
  commands: readonly ReplCommand[],
  query: string,
): readonly ReplCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return commands;
  return commands.filter(
    (command) => command.name.toLowerCase().includes(q) || command.label.toLowerCase().includes(q),
  );
}

/** Clamp an index into `[0, count - 1]` (or `0` when the filtered list is empty). */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/** The result of folding one keystroke: keep the palette open with new state, run the highlighted command, or close. */
export type PaletteStep =
  | { readonly kind: 'state'; readonly state: PaletteState }
  | { readonly kind: 'run'; readonly command: ReplCommand | undefined }
  | { readonly kind: 'close' };

/**
 * Fold one {@link PaletteKeyAction} against the current state + the (surface-provided) command list. An edit
 * re-filters and resets the highlight to the top; a move re-clamps against the new filtered count; `select` reads
 * the highlighted command (or `undefined` when the filter is empty — the caller treats that as a no-op close).
 */
/**
 * The complete fold both palette surfaces share: map a keystroke to a step against the open palette. Ctrl-C is the
 * always-escapes hatch (it `close`s the palette so the user is never trapped); everything else delegates to
 * {@link reducePaletteKey} + {@link stepPalette}. Both the single-tree `HomeController` and the standalone
 * `ChatApp` call THIS, so the open-palette key contract is tested once and can never diverge.
 */
export function foldPaletteKey(
  char: string,
  key: PaletteKey,
  state: PaletteState,
  commands: readonly ReplCommand[],
): PaletteStep {
  if (key.ctrl === true && char === 'c') return { kind: 'close' };
  return stepPalette(state, reducePaletteKey(char, key), commands);
}

export function stepPalette(
  state: PaletteState,
  action: PaletteKeyAction,
  commands: readonly ReplCommand[],
): PaletteStep {
  switch (action.kind) {
    case 'cancel':
      return { kind: 'close' };
    case 'select': {
      const filtered = filterPaletteCommands(commands, state.query);
      return { kind: 'run', command: filtered[state.index] };
    }
    case 'append':
      return { kind: 'state', state: { query: state.query + action.char, index: 0 } };
    case 'backspace':
      return { kind: 'state', state: { query: dropLastCodePoint(state.query), index: 0 } };
    case 'move': {
      const filtered = filterPaletteCommands(commands, state.query);
      return {
        kind: 'state',
        state: {
          query: state.query,
          index: clampIndex(state.index + action.delta, filtered.length),
        },
      };
    }
    case 'none':
      return { kind: 'state', state };
  }
}
