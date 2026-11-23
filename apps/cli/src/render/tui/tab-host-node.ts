import type { NodeDetailModel } from '../../history/node-detail-model.js';
import type {
  NodeDetailLoad,
  NodeDetailRead,
  NodeDetailRequest,
  NodePosition,
} from '../../history/node-detail-source.js';
import { absenceText, scrubbedBounded, type NodeRow } from '../../history/run-detail-model.js';
import { EMPTY_OUTPUT, NOT_RECORDED, NO_OUTPUT, SKIPPED, UNAVAILABLE } from '../absence.js';
import { sanitizeInline } from '../sanitize.js';
import type { ChatKey } from './chat-input.js';
import { formatDuration } from './format.js';
import type { LegendItem } from './legend.js';
import {
  clipLine,
  flushRow,
  windowBody,
  type SheetLine,
  type SheetLineKind,
} from './sheet-frame.js';
import { displayWidth } from './viewport.js';

/**
 * The node page of the Home's History tab ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, §4, MVP-8 step 4): one node of one run, opened from the run detail with `Enter`. PURE, like `tab-host-history.ts` it is drawn into: no clock,
 * no React, no store. It reads only through the {@link NodeLoader} it is handed, and it draws only what `buildNodeDetailModel` already bounded and
 * masked, so the page has no way of its own to show a value raw.
 *
 * - **What it shows.** The node's place and type in the frozen workflow (`Order in the workflow: 2 of 5`), what the workflow authored and what the
 *   node actually ran on, its tokens, cost and time, every attempt (one row each, the last row of an attempt number), the inspected attempt's tool
 *   activity (content-free), its error and its output (the output through the masking seam: forty lines, 4,000 code points a value, nothing over
 *   1 MiB read at all), and the node's own events. A node's INPUT is not shown: no value of it is recorded.
 * - **Which attempt.** The node's last. `n` shows the first attempt that failed, but only for a node whose LAST attempt failed: a node that was
 *   retried and then ended well has no failed attempt to look at, and `n` says so ({@link firstFailedAttempt}).
 * - **A node with no attempt row** (skipped, or not reached) is a short page that says why in the run detail's own words; a node whose record cannot be
 *   read says `unavailable` and guesses nothing.
 * - **Every absent thing says why,** in the fixed sentences of `render/absence.ts` (the reference's "Words for what is absent"); this module writes none
 *   of its own.
 * - **Every string passes the sanitize floor** at the one place a line is drawn, and a long line is wrapped at {@link NODE_WRAP_COLUMNS} columns, not
 *   cut: the page's own bounds (the output's, the error's) decide how much there is, and the width only decides where a line breaks.
 */

/** The reads the node page needs from its host: synchronous, like the run detail's list reads. */
export type NodeLoader = (request: NodeDetailRequest) => NodeDetailLoad;

/** The keys the node page's legend names that are its own. The test presses every one of them. */
export const NODE_KEYS = {
  scroll: { keys: '↑/↓', verb: 'scroll' },
  firstFailed: { keys: '[n]', verb: 'first failed' },
  back: { keys: 'Esc', verb: 'back' },
} as const satisfies Readonly<Record<string, LegendItem>>;

/** How far `PgUp` and `PgDn` move. */
export const NODE_PAGE_STEP = 8;
/** The display columns a wrapped line of the error or the output holds before it breaks: the 80-column floor less the margins and the indent. */
export const NODE_WRAP_COLUMNS = 72;

export const NODE_NOT_HERE = 'The node page is not available in this session.';
export const NODE_FAULT = 'The node could not be loaded just now.';
export const NODE_NO_FAILED = 'No attempt of this node failed.';
export const NODE_NO_ATTEMPT = 'This node has no attempt to show.';
export const NODE_RETRIED_OK =
  'This node was retried and then ended well: no attempt of it is left failed.';
export const NODE_CHANGES_NO_RUN = 'No run is changed here; p only marks it.';
export const NODE_NOT_A_NODE = 'Enter opens a node: move to one of the node rows.';
export const NODE_LOG_PARTIAL =
  'Only the first events of the run were read: the figures here may be partial.';

/** `Showing attempt 1, the first that failed.` */
export function nodeShowingFirstFailed(attempt: number): string {
  return `Showing attempt ${String(attempt)}, the first that failed.`;
}

/** One line of the page before it is clipped to a width: a role, its text, and the figures that flush right. */
export interface NodeLine {
  readonly kind: SheetLineKind;
  readonly left: string;
  readonly right?: string;
}

/** The node page as it stands: the run detail's row it came from, what was read, the page's lines (built once) and the selected one. */
export interface NodeTabState {
  readonly runId: string;
  /** The run detail's row: the raw id, the status and the figures the page falls back on when the node has no attempt row. */
  readonly row: NodeRow;
  readonly load: NodeDetailLoad;
  readonly lines: readonly NodeLine[];
  readonly cursor: number;
  /** One sentence the last key left; the next key drops it. */
  readonly message?: string | undefined;
}

/** What a key does on the node page: become another state, or leave for the run detail. */
export type NodeStep =
  | { readonly kind: 'state'; readonly state: NodeTabState }
  | { readonly kind: 'back' };

/** What the node page needs beyond its own state to handle a key. */
export interface NodeContext {
  /** Absent in a session that cannot read a node: `n` then says so. */
  readonly loadNode: NodeLoader | undefined;
  /** The run's end is held in the outbox, as the run detail read it. */
  readonly terminalHeld: boolean;
}

// ---- Which attempt `n` shows ------------------------------------------------------------------------------------------------

/**
 * The attempt `n` shows: the first attempt that failed, for a node whose LAST attempt failed; `undefined` for every other node. A node that failed
 * on its first attempt and ended well on its second was retried and recovered, and a failure the node got over is not what `n` is for; so is a node
 * with no failed attempt at all. The attempts are the node's rows, one per attempt number.
 */
export function firstFailedAttempt(
  attempts: readonly { readonly attempt: number; readonly status: string }[],
): number | undefined {
  const last = attempts.at(-1);
  if (last?.status !== 'failed') return undefined;
  return attempts.find((attempt) => attempt.status === 'failed')?.attempt;
}

// ---- The lines --------------------------------------------------------------------------------------------------------------

const WORD_WIDTH = 10;
const INDENT = '  ';
const POINTER = '› ';

/** `text` broken into rows of at most `width` display columns, at a code point, never in the middle of one. */
function wrapText(text: string, width: number): readonly string[] {
  if (displayWidth(text) <= width) return [text];
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const point of text) {
    const columns = displayWidth(point);
    if (used + columns > width && row !== '') {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += point;
    used += columns;
  }
  rows.push(row);
  return rows;
}

/** Each line of `text` (split at its line breaks, tabs spread) as indented rows, wrapped. */
function textRows(text: string, indent: string): readonly NodeLine[] {
  return text
    .split('\n')
    .flatMap((line) => wrapText(line.replaceAll('\t', '  '), NODE_WRAP_COLUMNS))
    .map((left): NodeLine => ({ kind: 'text', left: `${indent}${left}` }));
}

function positionText(position: NodePosition | undefined): string {
  return position === undefined
    ? `Order in the workflow: ${UNAVAILABLE}`
    : `Order in the workflow: ${String(position.index)} of ${String(position.of)}`;
}

function typeText(read: NodeDetailRead): string {
  return read.authoredType === undefined ? read.model.nodeType : scrubbedBounded(read.authoredType);
}

/** The output section's rows: the bounded, masked preview, or the sentence that says why there is none. */
function outputLines(model: NodeDetailModel): readonly NodeLine[] {
  const heading: NodeLine = {
    kind: 'heading',
    left: `Output (attempt ${String(model.attemptNumber)})`,
  };
  const preview = model.outputPreview;
  if (preview === undefined) {
    // A failed attempt produced no output; every other status says why by the row's own state.
    const absence = model.status === 'failed' ? NO_OUTPUT : absenceText(model.status, true);
    return [heading, { kind: 'text', left: `${INDENT}${absence}` }];
  }
  const notes = [
    preview.masked ? 'masked' : '',
    preview.truncated ? 'shortened: relavium logs <run> --json holds the whole record' : '',
  ].filter((note) => note !== '');
  const empty: NodeLine = { kind: 'text', left: `${INDENT}${EMPTY_OUTPUT}` };
  // The notes are a row of their own under the heading, not its right-hand side: the heading's room is what a narrow terminal drops first,
  // and `masked` and `shortened` are what the person most needs to read beside an output.
  const noted: readonly NodeLine[] =
    notes.length === 0 ? [] : [{ kind: 'notice', left: `${INDENT}${notes.join(' · ')}` }];
  return [heading, ...noted, ...(preview.text === '' ? [empty] : textRows(preview.text, INDENT))];
}

function errorLines(model: NodeDetailModel): readonly NodeLine[] {
  const heading: NodeLine = {
    kind: 'heading',
    left: `Error (attempt ${String(model.attemptNumber)})`,
  };
  const error = model.error;
  if (error === undefined) {
    return model.status === 'failed'
      ? [heading, { kind: 'text', left: `${INDENT}${NOT_RECORDED}` }]
      : [];
  }
  const code: readonly NodeLine[] =
    error.code === undefined ? [] : [{ kind: 'failed', left: `${INDENT}${error.code}` }];
  const where: readonly NodeLine[] =
    error.nodeId === undefined ? [] : [{ kind: 'text', left: `${INDENT}node ${error.nodeId}` }];
  return [
    heading,
    ...code,
    ...(error.message === undefined ? [] : textRows(error.message, INDENT)),
    ...where,
  ];
}

function toolLines(model: NodeDetailModel): readonly NodeLine[] {
  const heading: NodeLine = {
    kind: 'heading',
    left: `Tool activity (attempt ${String(model.attemptNumber)})`,
  };
  const trace = model.toolActivity;
  if (!trace.recorded) return [heading, { kind: 'text', left: `${INDENT}${trace.text}` }];
  const rest: readonly NodeLine[] =
    trace.truncated > 0
      ? [{ kind: 'marker', left: `${INDENT}… ${String(trace.truncated)} more, not stored` }]
      : [];
  return [
    heading,
    { kind: 'text', left: `${INDENT}${trace.text}` },
    ...trace.entries.map(
      (entry): NodeLine => ({ kind: 'row', left: `${INDENT}${entry.toolId}`, right: entry.text }),
    ),
    ...rest,
  ];
}

function attemptLines(model: NodeDetailModel): readonly NodeLine[] {
  return [
    { kind: 'heading', left: `Attempts (${String(model.attempts.length)})` },
    ...model.attempts.map((attempt): NodeLine => {
      const right = [
        attempt.attempt === model.attemptNumber ? 'shown below' : '',
        attempt.durationMs === undefined ? '' : formatDuration(attempt.durationMs),
        attempt.tokens.text,
        attempt.cost.text,
      ]
        .filter((part) => part !== '')
        .join('  ');
      return {
        kind: 'row',
        left: `${INDENT}${attempt.glyph} attempt ${String(attempt.attempt)}  ${attempt.status.padEnd(WORD_WIDTH)}`,
        right,
      };
    }),
  ];
}

function timelineLines(model: NodeDetailModel): readonly NodeLine[] {
  if (model.timeline.length === 0) return [];
  const more = model.timelineOmitted > 0 ? `+${String(model.timelineOmitted)}` : '';
  return [
    { kind: 'heading', left: `Timeline (${String(model.timeline.length)}${more})` },
    ...model.timeline.map(
      (row): NodeLine => ({
        kind: 'row',
        left: `${INDENT}#${String(row.sequenceNumber)}  ${row.label}`,
        ...(row.detail === undefined ? {} : { right: row.detail }),
      }),
    ),
  ];
}

function readyLines(read: NodeDetailRead): readonly NodeLine[] {
  const { model } = read;
  const authored = [
    model.authored.agent === undefined ? '' : `agent ${model.authored.agent}`,
    model.authored.model === undefined ? '' : `model ${model.authored.model}`,
  ].filter((part) => part !== '');
  const took = model.durationText === undefined ? '' : `  ·  took ${model.durationText}`;
  const authoredLine: readonly NodeLine[] =
    authored.length === 0 ? [] : [{ kind: 'text', left: `Authored: ${authored.join('  ·  ')}` }];
  const ranOn: readonly NodeLine[] =
    model.modelsUsed.length === 0
      ? []
      : [{ kind: 'text', left: `Ran on: ${model.modelsUsed.join(', ')}` }];
  const partial: readonly NodeLine[] = read.eventsComplete
    ? []
    : [{ kind: 'notice', left: NODE_LOG_PARTIAL }];
  return [
    { kind: 'heading', left: `${model.glyph} ${model.status}  ${model.label}` },
    { kind: 'text', left: `${positionText(read.position)}  ·  type ${typeText(read)}` },
    ...authoredLine,
    ...ranOn,
    { kind: 'text', left: `Tokens ${model.tokens.text}  ·  cost ${model.cost.text}${took}` },
    ...partial,
    ...attemptLines(model),
    ...toolLines(model),
    ...errorLines(model),
    ...outputLines(model),
    ...timelineLines(model),
  ];
}

/**
 * The page of a node with no attempt row: the run detail's row says why, in its own words. Every figure line is the row's (its absence sentence
 * when it has nothing), and the output says what the row's figures say when they have nothing to show.
 */
function noAttemptLines(
  row: NodeRow,
  load: Extract<NodeDetailLoad, { kind: 'no-attempts' }>,
): readonly NodeLine[] {
  const type =
    load.authoredType === undefined
      ? (row.nodeType ?? UNAVAILABLE)
      : scrubbedBounded(load.authoredType);
  const absence = row.tokens.source === 'none' ? row.tokens.text : NOT_RECORDED;
  const why =
    row.status === 'skipped'
      ? `${SKIPPED}${row.skippedReason === undefined ? '' : `: ${row.skippedReason}`}`
      : absence;
  return [
    { kind: 'heading', left: `${row.glyph} ${row.status}  ${row.label}` },
    { kind: 'text', left: `${positionText(load.position)}  ·  type ${type}` },
    { kind: 'text', left: why },
    { kind: 'text', left: `Tokens ${row.tokens.text}  ·  cost ${row.cost.text}` },
    { kind: 'text', left: `Tool activity: ${row.toolActivity.text}` },
    { kind: 'text', left: `Output: ${absence}` },
  ];
}

function unavailableLines(row: NodeRow): readonly NodeLine[] {
  return [
    { kind: 'heading', left: `? ${UNAVAILABLE}  ${row.label}` },
    // Two rows, not one: the reason is a row of its own, so a narrow terminal cannot clip it away.
    { kind: 'failed', left: `The record of this node is ${UNAVAILABLE}.` },
    { kind: 'failed', left: "Its attempt, or the run's event log, could not be read." },
  ];
}

function linesOf(row: NodeRow, load: NodeDetailLoad): readonly NodeLine[] {
  if (load.kind === 'ready') return readyLines(load.detail);
  if (load.kind === 'no-attempts') return noAttemptLines(row, load);
  return unavailableLines(row);
}

// ---- Opening and keys -------------------------------------------------------------------------------------------------------

/** The node page opened over what the host read, on its first line. */
export function openNodeTab(runId: string, row: NodeRow, load: NodeDetailLoad): NodeTabState {
  return { runId, row, load, lines: linesOf(row, load), cursor: 0 };
}

/** `state` with a sentence the next key drops. */
export function withNodeMessage(state: NodeTabState, message: string): NodeTabState {
  return { ...state, message };
}

const clamp = (value: number, last: number): number => Math.max(0, Math.min(value, last));

/** `n`: show the first failed attempt of a node whose last attempt failed; say why when there is none. */
function foldFirstFailed(state: NodeTabState, context: NodeContext): NodeStep {
  const { load } = state;
  if (load.kind !== 'ready')
    return { kind: 'state', state: withNodeMessage(state, NODE_NO_ATTEMPT) };
  const { model } = load.detail;
  const attempt = firstFailedAttempt(model.attempts);
  if (attempt === undefined) {
    const recovered = model.attempts.some((candidate) => candidate.status === 'failed');
    return {
      kind: 'state',
      state: withNodeMessage(state, recovered ? NODE_RETRIED_OK : NODE_NO_FAILED),
    };
  }
  if (attempt === model.attemptNumber)
    return {
      kind: 'state',
      state: { ...state, cursor: 0, message: nodeShowingFirstFailed(attempt) },
    };
  if (context.loadNode === undefined)
    return { kind: 'state', state: withNodeMessage(state, NODE_NOT_HERE) };
  let next: NodeDetailLoad;
  try {
    next = context.loadNode({
      runId: state.runId,
      nodeId: state.row.nodeId,
      attemptNumber: attempt,
      terminalHeld: context.terminalHeld,
    });
  } catch {
    return { kind: 'state', state: withNodeMessage(state, NODE_FAULT) };
  }
  // An attempt that cannot be read leaves the page as it was: nothing is shown in its place.
  if (next.kind !== 'ready') return { kind: 'state', state: withNodeMessage(state, NODE_FAULT) };
  return {
    kind: 'state',
    state: {
      ...openNodeTab(state.runId, state.row, next),
      message: nodeShowingFirstFailed(attempt),
    },
  };
}

/** Fold one key into the node page (already past the tab host's own tab keys and its `Ctrl+C`). */
export function foldNodeKey(
  state: NodeTabState,
  input: string,
  key: ChatKey,
  context: NodeContext,
): NodeStep {
  if (key.ctrl === true || key.meta === true) return { kind: 'state', state };
  if (key.escape === true || key.backspace === true) return { kind: 'back' };
  const cleared: NodeTabState =
    state.message === undefined ? state : { ...state, message: undefined };
  // A bare letter is the same key with Caps Lock on.
  if (input.toLowerCase() === 'n') return foldFirstFailed(cleared, context);
  const last = state.lines.length - 1;
  let to = state.cursor;
  if (key.upArrow === true) to -= 1;
  else if (key.downArrow === true) to += 1;
  else if (key.pageUp === true) to -= NODE_PAGE_STEP;
  else if (key.pageDown === true) to += NODE_PAGE_STEP;
  else if (key.home === true) to = 0;
  else if (key.end === true) to = last;
  else return { kind: 'state', state: cleared };
  return { kind: 'state', state: { ...cleared, cursor: clamp(to, last) } };
}

// ---- What is drawn ----------------------------------------------------------------------------------------------------------

/**
 * The page's lines between the strip and the legend, at most `room` of them: the lines windowed around the cursor (a `▲`/`▼` marker standing
 * for the lines it hides), and the message row, which keeps its line whether or not it has anything to say.
 */
export function nodeBody(state: NodeTabState, width: number, room: number): readonly SheetLine[] {
  const total = state.lines.length;
  const height = Math.max(3, room - 1);
  const { start, end } = windowBody(total, state.cursor, height);
  const shown: SheetLine[] = [];
  for (let index = start; index < end; index += 1) {
    const line = state.lines[index];
    if (line === undefined) continue;
    const selected = index === state.cursor;
    const left = `${selected ? POINTER : INDENT}${sanitizeInline(line.left)}`;
    shown.push({
      kind: selected ? 'selected' : line.kind,
      text: flushRow(left, sanitizeInline(line.right ?? ''), width),
    });
  }
  if (start > 0 && shown.length > 0)
    shown[0] = { kind: 'marker', text: `▲ ${String(start + 1)} more` };
  if (end < total && shown.length > 0)
    shown[shown.length - 1] = { kind: 'marker', text: `▼ ${String(total - end + 1)} more` };
  const footer: SheetLine =
    state.message === undefined
      ? { kind: 'hint', text: clipLine(NODE_CHANGES_NO_RUN, width) }
      : { kind: 'notice', text: clipLine(sanitizeInline(state.message), width) };
  return [...shown, footer];
}

/** The legend's items on the node page: the tab host's tab item, the page's own keys, and the way back last. */
export function nodeLegendItems(state: NodeTabState, tabItem: LegendItem): readonly LegendItem[] {
  return state.load.kind === 'ready'
    ? [tabItem, NODE_KEYS.scroll, NODE_KEYS.firstFailed, NODE_KEYS.back]
    : [tabItem, NODE_KEYS.scroll, NODE_KEYS.back];
}
