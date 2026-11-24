/**
 * The pure model of the Home's run view
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §5): what a hosted run's screen says,
 * from the run host's snapshot and its notice ring, with no ink and no clock. `run-screen-view.tsx` paints it, and `home-controller.ts`
 * asks it which state the run is in when `Ctrl+C` arrives, so the words on the screen and the key's meaning come from one function.
 *
 * - **A glyph and a word for every state.** Colour only reinforces them (ADR-0122 §7.2).
 * - **The state of THE VIEW'S run, not of the host.** Another run executing does not make this view's run executing; a view whose run
 *   the host no longer holds says so and closes on `Esc`, and a `Ctrl+C` there never cancels another run.
 * - **Bounded.** The newest {@link RUN_SCREEN_NOTICE_ROWS} notices, each cut to the terminal's width (and to
 *   {@link RUN_SCREEN_NOTICE_WIDTH} columns on a wide one) with the cut shown by `…`; a card
 *   of at most {@link RUN_SCREEN_CARD_ROWS} rows; and a live region that takes what is left of the terminal, so the whole screen is
 *   never more than `rows - 1` rows tall (one row spare, so the inline renderer never reaches the bottom edge).
 * - **Sanitized.** Every string a stored value or the host reached passes `sanitizeInline` here, again, whatever the caller did.
 * - **Closed vocabulary.** The words are fixed; the only interpolated values are the run id and the notice text.
 */

import type { HostedRunDisposition } from '../../home/hosted-run-terminal.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import { formatElapsed } from '../notation.js';
import { sanitizeInline } from '../sanitize.js';
import type { StatusColor } from './format.js';
import { glyph, toneOf, type StatusGlyphRole } from './glyphs.js';
import { homeFitsTerminal, tooSmallMessage } from './home-projection.js';
import { boundedNotice } from './home-notice.js';
import type { HostedLegState } from './interrupt-keymap.js';
import { exitKey, legend, type LegendItem } from './legend.js';
import { HOSTED_RUN_EXIT_GRACE_MS } from './tui-constants.js';
import { clipLine } from './sheet-frame.js';
import { wrapText } from './viewport.js';

/** How many of the newest notices the view shows. */
export const RUN_SCREEN_NOTICE_ROWS = 3;
/** The widest one notice is, in display columns (the `note: ` mark not counted), the ellipsis included. */
export const RUN_SCREEN_NOTICE_WIDTH = 160;
/** What the view draws in front of each notice row. */
export const RUN_SCREEN_NOTE_MARK = 'note: ';
/** The most rows the disposition card takes, headline, remedy and reason together. */
export const RUN_SCREEN_CARD_ROWS = 6;
/** The fewest rows the live output keeps, however much the rest asks for. */
export const RUN_SCREEN_MIN_LIVE_ROWS = 4;

const HEADLINE_MAX_ROWS = 2;
const REMEDY_MAX_ROWS = 3;
const SEPARATOR = '  ·  ';
const ELLIPSIS = '…';

/** Where the view's run is, as the run host tells it. */
export type RunScreenPhase =
  | 'running'
  /** The cooperative cancel was requested and the leg has not settled. */
  | 'cancelling'
  /** The leg ended here and the host still holds how: the disposition card is shown. */
  | 'settled'
  /** The host no longer holds this run: another run started or ended since, or it never held it. */
  | 'replaced';

/** The words and glyph role of a state, colour apart; the colour is the role's own unless the state is graver or lighter than it. */
interface Appearance {
  readonly role: StatusGlyphRole;
  readonly word: string;
  readonly tone?: StatusColor;
}

const PHASE_APPEARANCE: Readonly<Record<Exclude<RunScreenPhase, 'settled'>, Appearance>> = {
  running: { role: 'running', word: 'running' },
  cancelling: { role: 'stopping', word: 'cancelling' },
  replaced: { role: 'ended', word: 'not held' },
};

const DISPOSITION_APPEARANCE: Readonly<Record<HostedRunDisposition, Appearance>> = {
  completed: { role: 'completed', word: 'completed' },
  failed: { role: 'failed', word: 'failed' },
  cancelled: { role: 'cancelled', word: 'cancelled' },
  paused: { role: 'paused', word: 'paused' },
  uncertain: { role: 'warning', word: 'needs attention', tone: 'red' },
  taken_over: { role: 'warning', word: 'taken over' },
  settled: { role: 'completed', word: 'already settled', tone: 'gray' },
};

const toneOfAppearance = (appearance: Appearance): StatusColor =>
  appearance.tone ?? toneOf(appearance.role);

/** Where the view's run is, and (once it ended here) how. The one place "is it this run's" is decided. */
type Location =
  | { readonly phase: Exclude<RunScreenPhase, 'settled'> }
  | { readonly phase: 'settled'; readonly end: HostedLegEnd };

function locate(runId: string, snapshot: RunHostSnapshot | undefined): Location {
  if (snapshot === undefined) return { phase: 'replaced' };
  const active = snapshot.active;
  if (active?.runId === runId) return { phase: active.cancelling ? 'cancelling' : 'running' };
  // Whatever else is live is not this view's: a leg that named another run, a leg that has not named its run yet, a launch in flight. A view
  // is opened for a run that has an id, so a leg that has none is not provably its own, and a `Ctrl+C` here must never reach it (the host's
  // cancel acts on the leg that is live, whichever it is). A resume of this very run is shown as this view's as soon as the engine names it.
  if (active !== undefined || snapshot.launching) return { phase: 'replaced' };
  const last = snapshot.last;
  return last?.runId === runId ? { phase: 'settled', end: last } : { phase: 'replaced' };
}

/** The state of the view's run: what the screen says, and what a `Ctrl+C` means (see {@link runScreenLeg}). */
export function runScreenPhase(
  runId: string,
  snapshot: RunHostSnapshot | undefined,
): RunScreenPhase {
  return locate(runId, snapshot).phase;
}

/**
 * Whether `Ctrl+C` has a leg of THIS view's run to act on: `executing` while it runs, `cancelling` once the stop was asked, and `none` for a
 * card, a replaced run (another leg, one that has not named its run, a launch in flight) and a view with no host (the keymap's three rows,
 * `interrupt-keymap.ts`).
 */
export function runScreenLeg(runId: string, snapshot: RunHostSnapshot | undefined): HostedLegState {
  switch (runScreenPhase(runId, snapshot)) {
    case 'running':
      return 'executing';
    case 'cancelling':
      return 'cancelling';
    case 'settled':
    case 'replaced':
      return 'none';
  }
}

/** What the model is built from. `rows` and `columns` are the terminal's; `armed` is the interrupt keymap's armed flag. */
export interface RunScreenInput {
  readonly runId: string;
  readonly snapshot: RunHostSnapshot | undefined;
  /** The run host's notice ring, oldest first (already sanitized and bounded by it, and again here). */
  readonly notices: readonly string[];
  readonly armed: boolean;
  readonly columns: number;
  readonly rows: number;
  /**
   * A gate card can be opened from here: a run that ended parked offers `Enter` for it (ADR-0139 §4). Absent or `false` ⇒ the key line is
   * the closing one, as before.
   */
  readonly openGate?: boolean | undefined;
  /** The last `Enter` could not open the card (the run view's own note says why): the key line then says `Enter` tries it again. */
  readonly gateOpenFailed?: boolean | undefined;
}

/** The disposition card of a leg that has ended: its rows, already wrapped and cut to the width. */
export interface RunScreenCard {
  readonly disposition: HostedRunDisposition;
  readonly tone: StatusColor;
  /** The headline, then the remedy, then the reason a fault ended the leg (each only when there is one). */
  readonly rows: readonly string[];
}

export interface RunScreenModel {
  readonly phase: RunScreenPhase;
  readonly leg: HostedLegState;
  /** `false` below 80×24: only `tooSmall` and `keys` are shown, and only `Esc` and `Ctrl+C` are accepted. */
  readonly fits: boolean;
  /** The enlarge line, when the terminal is below the minimum. */
  readonly tooSmall: string | undefined;
  readonly glyph: string;
  readonly word: string;
  readonly tone: StatusColor;
  /** The title row: glyph, word, the run id and, for a resumed leg, `resumed`. */
  readonly header: string;
  /** The one line under the header (`Cancelling · …`, `…no longer held`), when the state has one. */
  readonly status: string | undefined;
  /** The newest notices, oldest first, bounded and sanitized. */
  readonly notices: readonly string[];
  /** How many notices came before the ones shown. */
  readonly earlierNotices: number;
  /** Present only once the leg has settled here. */
  readonly card: RunScreenCard | undefined;
  /** The key line. */
  readonly keys: string;
  /** The rows the live output (the `RunApp` projection) may take; `0` below the minimum terminal. */
  readonly liveRows: number;
}

/**
 * The newest `RUN_SCREEN_NOTICE_ROWS` non-blank notices, sanitized and cut to `columns` display columns less the mark the view puts in
 * front of them (and to {@link RUN_SCREEN_NOTICE_WIDTH}), the cut shown by `…`; and how many were left out before them. The cut is made
 * here, by display width, so a wide character is never counted as one column and the view's own truncation never has to cut a row.
 */
function noticeRows(
  notices: readonly string[],
  columns: number,
): {
  readonly rows: readonly string[];
  readonly earlier: number;
} {
  const room = Math.max(
    1,
    Math.min(RUN_SCREEN_NOTICE_WIDTH, Math.floor(columns) - RUN_SCREEN_NOTE_MARK.length),
  );
  const clean: string[] = [];
  for (const raw of notices) {
    // Bounded BEFORE it is sanitized and clipped: `clipLine` measures the whole line's width first, and a notice is whatever a caller
    // was handed (the same unbounded text the Home's own notice is bounded for, `MAX_HOME_NOTICE_CHARS`).
    const line = sanitizeInline(boundedNotice(raw)).trim();
    if (line !== '') clean.push(clipLine(line, room));
  }
  const rows = clean.slice(-RUN_SCREEN_NOTICE_ROWS);
  return { rows, earlier: clean.length - rows.length };
}

/** `text` wrapped to `width` and cut to `maxRows`, the last row ending in an ellipsis when something was left out. */
function wrapped(text: string, width: number, maxRows: number): readonly string[] {
  const lines = wrapText(sanitizeInline(text), width)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  if (lines.length <= maxRows) return lines;
  const kept = lines.slice(0, maxRows);
  kept[maxRows - 1] = clipLine(`${kept[maxRows - 1] ?? ''}${ELLIPSIS}`, width);
  return kept;
}

function cardOf(end: HostedLegEnd, width: number): RunScreenCard {
  const terminal = end.terminal;
  const appearance = DISPOSITION_APPEARANCE[terminal.disposition];
  const rows: string[] = [...wrapped(terminal.headline, width, HEADLINE_MAX_ROWS)];
  if (terminal.remedy !== undefined) rows.push(...wrapped(terminal.remedy, width, REMEDY_MAX_ROWS));
  if (end.fault !== undefined) rows.push(clipLine(`Reason: ${sanitizeInline(end.fault)}`, width));
  return {
    disposition: terminal.disposition,
    tone: toneOfAppearance(appearance),
    rows: rows.slice(0, RUN_SCREEN_CARD_ROWS),
  };
}

function keysFor(
  phase: RunScreenPhase,
  armed: boolean,
  offered: { readonly openGate: boolean; readonly gateOpenFailed: boolean; readonly fits: boolean },
): string {
  switch (phase) {
    case 'running':
      return legend(
        [{ keys: 'Ctrl+C', verb: `cancel the run (${armed ? 'again' : 'twice'})` }],
        exitKey.leave('leaves it running'),
      );
    case 'cancelling':
      return legend([{ text: 'Waiting for the run to stop' }], exitKey.leave('leaves the view'));
    case 'settled':
    case 'replaced': {
      // Below 80×24 only `Esc` and `Ctrl+C` are delivered (the Home's key route), so no other key is named there.
      const gate: LegendItem = {
        keys: 'Enter',
        verb: offered.gateOpenFailed ? 'try the gate again' : 'open the gate',
      };
      return legend(
        offered.openGate && offered.fits && phase === 'settled' ? [gate] : [],
        exitKey.close(['Esc', 'Ctrl+C']),
      );
    }
  }
}

function statusFor(phase: RunScreenPhase): string | undefined {
  switch (phase) {
    case 'cancelling':
      return `Cancelling · the run stops at its next safe point (up to ${formatElapsed(HOSTED_RUN_EXIT_GRACE_MS)})`;
    case 'replaced':
      return 'This run is no longer held by the Home. Its record is in the history.';
    case 'running':
    case 'settled':
      return undefined;
  }
}

/**
 * The run view for `input`. Pure: the same input is always the same model, and nothing in it is a key's effect (the controller reads
 * {@link runScreenLeg} for that, from the same {@link runScreenPhase}).
 */
export function runScreenModel(input: RunScreenInput): RunScreenModel {
  const where = locate(input.runId, input.snapshot);
  const phase = where.phase;
  const leg = runScreenLeg(input.runId, input.snapshot);
  const fits = homeFitsTerminal(input.columns, input.rows);
  const end = where.phase === 'settled' ? where.end : undefined;
  const appearance =
    where.phase === 'settled'
      ? DISPOSITION_APPEARANCE[where.end.terminal.disposition]
      : PHASE_APPEARANCE[where.phase];
  const width = Math.max(1, Math.floor(input.columns) - 2);
  const card = fits && end !== undefined ? cardOf(end, width) : undefined;
  const { rows: shown, earlier } = fits
    ? noticeRows(input.notices, input.columns)
    : { rows: [], earlier: 0 };
  const status = statusFor(phase);
  const resumed = (end?.leg ?? input.snapshot?.active?.leg) === 'resume';
  const resumedMark = resumed ? `${SEPARATOR}resumed` : '';
  const mark = glyph(appearance.role);
  const header = `${mark} ${appearance.word}${SEPARATOR}run ${sanitizeInline(input.runId)}${resumedMark}`;
  const fixed =
    1 + // the header
    (status === undefined ? 0 : 1) +
    shown.length +
    (earlier > 0 ? 1 : 0) +
    (card?.rows.length ?? 0) +
    1; // the key line
  return {
    phase,
    leg,
    fits,
    tooSmall: fits ? undefined : tooSmallMessage(input.columns, input.rows),
    glyph: mark,
    word: appearance.word,
    tone: toneOfAppearance(appearance),
    header,
    status,
    notices: shown,
    earlierNotices: earlier,
    card,
    keys: keysFor(phase, input.armed && leg === 'executing', {
      openGate: input.openGate === true && end?.terminal.disposition === 'paused',
      gateOpenFailed: input.gateOpenFailed === true,
      fits,
    }),
    liveRows: fits ? Math.max(RUN_SCREEN_MIN_LIVE_ROWS, input.rows - 1 - fixed) : 0,
  };
}
