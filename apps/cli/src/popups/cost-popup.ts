/**
 * The `/cost` popup's words and steps ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): pure builders from a reading of the
 * session's spend to the popup's three steps, the report, the confirmation of a release, and its result. The state machine that reads, answers
 * the keys and releases is `cost-session.ts`; neither is loaded until the person first opens a report (`report-port.ts`).
 *
 * **The report is `costNotice`'s facts and `costNotice`'s words** (`costParts`, `chat/repl-info.ts`): the total with its coverage qualifier, the
 * notes (the durability warning), the models seen only by usage and one row per model with its share, calls, tokens, the unpriced note, the
 * legacy line and the held estimate. A model id is a provider's text and a shared database's, so it is the one thing the popup does not take from
 * the notice's own sanitiser: every model passes the FULL scrub of the run cards ({@link scrubPopupText}).
 *
 * **The release is a step, not a keystroke.** `[r]` is offered only when something is held (a figure in the rows or in the live governor), and
 * it goes to a confirmation line answered by `Ctrl+Y` through the popup host's chord guard. The line says what changes in the product's words:
 * the amount it lifts from the session's cap, that later turns can spend that much more, and that it cannot be undone. The result is a
 * persistent step that `Enter` and `Esc` close.
 */

import { costLineText, costParts } from '../chat/repl-info.js';
import { formatUsdExact } from '../render/notation.js';
import { keyToken } from '../render/tui/legend.js';
import { CHORD_REFUSAL_PHRASE } from './chord-refusal.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import { COPY_CONTROL } from './popup-copy.js';
import type { ChordRefusal } from './popup-host.js';
import type { PopupControl, PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, scrubPopupText, wrapHanging, wrapPopupText } from './popup-text.js';
import type { CostReading, CostRelease } from './report-port.js';

/** The popup's steps: the report, the release's confirmation line (reached from the report, or opened on by `/cost --release`) and its result. */
export const COST_STEP = { cost: 0, release: 1, done: 2 } as const;

/** The control of the report that goes to the release step, and what it says. */
const RELEASE_CONTROL: PopupControl = { key: 'r', verb: 'release held estimates' };

/** The loading words while the session's spend is read, and while the total is read again after a release. */
const COST_LOADING = 'Reading the session cost';

/**
 * What the release step says when nothing is held: one sentence that says why there is nothing to release (it wraps in the popup, nothing is cut),
 * and what a release would lift. The legend names the way back.
 */
export const NOTHING_HELD = {
  what: 'Nothing is held against this session’s cap, so there is nothing to release.',
  next: 'A release lifts estimated spend that no turn has confirmed.',
} as const;

/** What the release step says when an answer found a turn in flight: nothing was released. */
export const TURN_IN_FLIGHT = {
  what: 'A turn is running, so nothing was released.',
  next: 'Let it finish, then ask again.',
} as const;

/** The notification that says the same, for a person who is looking at the step. */
export const TURN_IN_FLIGHT_NOTICE = 'Nothing released: a turn is running.';

/**
 * What the person is told when the answer found the held amount different from the figure the line named: nothing was released (the amount is
 * what they confirmed), the report behind the line shows what is held now, and `[r]` asks about THAT figure. Short, because the popup draws it
 * in its legend row beside the way back (`POPUP_NOTICE_MAX_COLUMNS`).
 */
export const HELD_CHANGED_NOTICE = `Nothing released: the amount changed. ${keyToken('r')} asks again.`;

/** What the result step says when the release could not be carried out. */
export const RELEASE_FAILED = {
  what: 'The release could not be completed.',
  next: 'Open /cost to see whether the estimates are still held.',
} as const;

/** The sum of what the rows hold against the cap, in micro-cents. */
function rowsHeld(reading: CostReading): number {
  return reading.rows.reduce((sum, row) => sum + row.conservativeMicrocents, 0);
}

/**
 * What the cap is holding against this session, in micro-cents: the larger of what the durable rows say and what the live governor holds. The
 * governor's figure is what the running process enforces, the rows' what a resume restores; a record that could not be written is the case
 * where the first is larger.
 */
export function heldMicrocents(reading: CostReading): number {
  return Math.max(rowsHeld(reading), reading.governor?.microcents ?? 0);
}

/**
 * Whether the release control is offered: something is held against the cap. With nothing held the control is not listed, even where the record
 * of a hold is known not to be durable: that warning stays a fact of the report's text, but a release then has nothing to clear and `[r]` would
 * only lead to "nothing to release". A typed `/cost --release` still opens the release step, which says so.
 */
export function releasable(reading: CostReading): boolean {
  return heldMicrocents(reading) > 0;
}

/**
 * The controls of the report step once `reading` has landed: the release control when something is held, and `[c] copy` always (the report is
 * there to copy). While the step loads or says the read failed it has neither: the session sets `[]` for those.
 */
export function costControls(reading: CostReading): readonly PopupControl[] {
  return releasable(reading) ? [RELEASE_CONTROL, COPY_CONTROL] : [COPY_CONTROL];
}

/** The `costParts` of a reading, as the notice computes them (the same call, the same options). */
function partsOf(reading: CostReading) {
  return costParts(reading.totalCostMicrocents, reading.rows, {
    ...(reading.coverage === undefined ? {} : { coverage: reading.coverage }),
    ...(reading.models === undefined ? {} : { models: reading.models }),
    ...(reading.governor === undefined
      ? {}
      : { durabilityBroken: reading.governor.durabilityBroken }),
  });
}

/**
 * The report's lines: the total, its notes and one row per model, in `costNotice`'s order and words, each wrapped to the popup's width (a row
 * that is wider than it continues indented under itself, nothing is cut). A model id is scrubbed with the full floor.
 */
export function costReportLines(
  reading: CostReading,
  columns = POPUP_TEXT_COLUMNS,
): readonly string[] {
  const parts = partsOf(reading);
  return [
    ...wrapPopupText(parts.total, columns),
    ...[...parts.notes, ...parts.rows].flatMap((line) =>
      wrapHanging(costLineText(line, scrubPopupText), columns),
    ),
  ];
}

/** The report step's content. */
export function costReportContent(reading: CostReading): PopupContent {
  return { kind: 'report', page: true, lines: costReportLines(reading) };
}

/**
 * The release step's content: the confirmation line in the product's words, or, with nothing held, the empty state (a step that is not a
 * report takes no chord, so there is nothing to answer).
 */
export function releaseContent(reading: CostReading): PopupContent {
  // The same predicate that decides whether `[r]` is offered, so the line exists exactly where a release does: a figure that is not a positive
  // number (a NaN would pass `held <= 0` and draw a line whose answer could only ever say "the amount changed") is "nothing held".
  if (!releasable(reading)) return { kind: 'empty', ...NOTHING_HELD };
  const held = heldMicrocents(reading);
  return {
    kind: 'report',
    lines: [
      ...wrapPopupText(
        `This lifts about ${formatUsdExact(held)} of estimated-but-unconfirmed spend from this session’s cap, so later turns can spend that much more.`,
      ),
      '',
      ...wrapPopupText('It cannot be undone.'),
    ],
  };
}

/**
 * What the person is told when a `Ctrl+Y` did not count (it disarmed the line): nothing was released, why, and what asks again (like the
 * doctor's, in the same shape and the same words of the cause). Short, because the popup draws it in its legend row beside the way back
 * (`POPUP_NOTICE_MAX_COLUMNS`).
 */
export function releaseRefusedText(reason: ChordRefusal): string {
  return `Nothing released: ${CHORD_REFUSAL_PHRASE[reason]}. ${keyToken('r')} asks again.`;
}

/** The release step after an answer found a turn in flight: an empty state, so the line cannot be answered again from stale evidence. */
export function turnInFlightContent(): PopupContent {
  return { kind: 'empty', ...TURN_IN_FLIGHT };
}

/** What a release cleared, in micro-cents: the larger of the two halves (the live governor's is the larger when the record could not be written). */
export function releasedAmount(outcome: CostRelease): number {
  return Math.max(outcome.durable, outcome.live ?? 0);
}

/**
 * The result step: what was released, and the session's total read again (`after`, absent until that read lands or when it failed). Nothing is
 * written into the conversation: this step is the whole of the answer.
 */
export function releaseDoneContent(
  outcome: CostRelease,
  after: CostReading | undefined,
): PopupContent {
  const amount = releasedAmount(outcome);
  const lines = [
    ...wrapPopupText(
      amount > 0
        ? `Released ~${formatUsdExact(amount)} back to the cap.`
        : 'Nothing was held against the cap, so nothing was released.',
    ),
  ];
  if (after !== undefined) lines.push('', ...wrapPopupText(partsOf(after).total));
  return { kind: 'report', lines };
}

/** The result step when the release threw: an error state, by words and never by the fault's message. */
export function releaseFailedContent(): PopupContent {
  return { kind: 'error', ...RELEASE_FAILED };
}

/** The loading content of a step before the reading lands. */
export const COST_LOADING_CONTENT: PopupContent = { kind: 'loading', what: COST_LOADING };

/**
 * The popup's spec: three steps, the later two reached from the report (`rail: 'path'`), opened on the release step by `/cost --release`. The
 * report starts with no control (it is not known that something is held until the reading lands, which then offers `[r]` or not), the release
 * step is a confirmation line answered by `Ctrl+Y`, and the result is final: `Enter` and `Esc` close it, there is nothing to go back to.
 */
export function costSpec(origin: PopupOrigin, onRelease: boolean): PopupSpec {
  return {
    id: 'cost',
    title: '/cost',
    origin,
    rail: 'path',
    initialStep: onRelease ? COST_STEP.release : COST_STEP.cost,
    steps: [
      // The copy stays on the legend row ahead of the release and the scroll hint when the row is short: it is the one control every report has.
      { name: 'Cost', content: COST_LOADING_CONTENT, legendKeep: ['c', 'r'] },
      {
        name: 'Release',
        content: COST_LOADING_CONTENT,
        back: COST_STEP.cost,
        holds: 'chord',
        chord: { verb: 'release' },
      },
      {
        name: 'Done',
        content: { kind: 'report', lines: [] },
        back: COST_STEP.release,
        final: true,
        enter: 'close',
      },
    ],
  };
}
