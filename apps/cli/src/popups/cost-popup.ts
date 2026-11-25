/**
 * The `/cost` popup's words and steps ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): pure builders from a reading of the
 * session's spend to the popup's three steps, the report, the confirmation of a release, and its result. The state machine that reads, answers
 * the keys and releases is `cost-session.ts`; neither is loaded until the person first opens a report (`report-port.ts`).
 *
 * **The report is `costNotice`'s facts and `costNotice`'s words** (`costParts`, `chat/repl-info.ts`): the total with its coverage qualifier, the
 * notes (the durability warning), the models seen only by usage and one row per model with its share, calls, tokens, the unpriced note, the
 * legacy line and the held estimate. A model id is a provider's text and a shared database's, so it is the one thing the popup does not take from
 * the notice's own sanitiser: every model passes the FULL scrub of the run cards ({@link reportText}).
 *
 * **The release is a step, not a keystroke.** `[r]` is offered only when something is held (a figure in the rows or in the live governor, or a
 * record known not to be durable), and it goes to a confirmation line answered by `Ctrl+Y` through the popup host's chord guard. The line
 * says what changes in the product's words: the amount it lifts from the session's cap, that later turns can spend that much more, and that it
 * cannot be undone. The result is a persistent step that `Enter` and `Esc` close.
 */

import { costLineText, costParts } from '../chat/repl-info.js';
import { formatUsdExact } from '../render/notation.js';
import { keyToken } from '../render/tui/legend.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import type { ChordRefusal } from './popup-host.js';
import type { PopupControl, PopupSpec } from './popup-reducer.js';
import type { CostReading, CostRelease } from './report-port.js';
import { REPORT_TEXT_COLUMNS, reportText, wrapHanging, wrapReport } from './report-text.js';

/** The popup's steps: the report, the release's confirmation line (reached from the report, or opened on by `/cost --release`) and its result. */
export const COST_STEP = { cost: 0, release: 1, done: 2 } as const;

/** The control of the report that goes to the release step, and what it says. */
export const RELEASE_CONTROL: PopupControl = { key: 'r', verb: 'release held estimates' };

/** The loading words while the session's spend is read, and while the total is read again after a release. */
export const COST_LOADING = 'Reading the session cost';

/** What the release step says when nothing is held. */
export const NOTHING_HELD = {
  what: 'Nothing is held against this session’s cap, so there is nothing to release.',
  next: `${keyToken('Esc')} goes back.`,
} as const;

/** What the release step says when an answer found a turn in flight: nothing was released. */
export const TURN_IN_FLIGHT = {
  what: 'A turn is running, so nothing was released.',
  next: 'Let it finish, then ask again.',
} as const;

/** The notification that says the same, for a person who is looking at the step. */
export const TURN_IN_FLIGHT_NOTICE = 'Nothing released: a turn is running.';

/** What the result step says when the release could not be carried out. */
export const RELEASE_FAILED = {
  what: 'The release could not be completed.',
  next: 'The held estimates may still count against the cap; open /cost to check.',
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
 * Whether the release control is offered: something is held, or the record of a hold is known not to be durable. With nothing held (and nothing
 * broken) the control is not listed and the report says nothing about releasing.
 */
export function releasable(reading: CostReading): boolean {
  return heldMicrocents(reading) > 0 || reading.governor?.durabilityBroken === true;
}

/** The controls of the report step for `reading`: the release control when something is held, none otherwise. */
export function costControls(reading: CostReading): readonly PopupControl[] {
  return releasable(reading) ? [RELEASE_CONTROL] : [];
}

/** The `costParts` of a reading, as the notice computes them (the same call, the same options). */
function partsOf(reading: CostReading, released?: number) {
  return costParts(reading.totalCostMicrocents, reading.rows, {
    ...(reading.coverage === undefined ? {} : { coverage: reading.coverage }),
    ...(reading.models === undefined ? {} : { models: reading.models }),
    ...(reading.governor === undefined
      ? {}
      : { durabilityBroken: reading.governor.durabilityBroken }),
    ...(released === undefined ? {} : { released }),
  });
}

/**
 * The report's lines: the total, its notes and one row per model, in `costNotice`'s order and words, each wrapped to the popup's width (a row
 * that is wider than it continues indented under itself, nothing is cut). A model id is scrubbed with the full floor.
 */
export function costReportLines(
  reading: CostReading,
  columns = REPORT_TEXT_COLUMNS,
): readonly string[] {
  const parts = partsOf(reading);
  return [
    ...wrapReport(parts.total, columns),
    ...[...parts.notes, ...parts.rows].flatMap((line) =>
      wrapHanging(costLineText(line, reportText), columns),
    ),
  ];
}

/** The report step's content. */
export function costReportContent(reading: CostReading): PopupContent {
  return { kind: 'report', lines: costReportLines(reading) };
}

/**
 * The release step's content: the confirmation line in the product's words, or, with nothing held, the empty state (a step that is not a
 * report takes no chord, so there is nothing to answer).
 */
export function releaseContent(reading: CostReading): PopupContent {
  const held = heldMicrocents(reading);
  if (held <= 0) return { kind: 'empty', ...NOTHING_HELD };
  return {
    kind: 'report',
    lines: [
      ...wrapReport(
        `This lifts about ${formatUsdExact(held)} of estimated-but-unconfirmed spend from this session’s cap, so later turns can spend that much more.`,
      ),
      '',
      ...wrapReport('It cannot be undone.'),
    ],
  };
}

/** What the person is told when a `Ctrl+Y` did not count (it disarmed the line): nothing was released. */
export function releaseRefusedText(reason: ChordRefusal): string {
  const why: Readonly<Record<ChordRefusal, string>> = {
    unseen: 'the line was not on screen yet',
    early: 'it came too soon after the line appeared',
    expired: 'the time to confirm had passed',
    typed: 'a key was typed after the line appeared',
  };
  return `Release not confirmed: ${why[reason]}. Nothing was released.`;
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
    ...wrapReport(
      amount > 0
        ? `Released ~${formatUsdExact(amount)} back to the cap.`
        : 'Nothing was held against the cap, so nothing was released.',
    ),
  ];
  if (after !== undefined) lines.push('', ...wrapReport(partsOf(after).total));
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
      { name: 'Cost', content: COST_LOADING_CONTENT },
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
