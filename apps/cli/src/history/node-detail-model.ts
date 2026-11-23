import type { StepDetailRecord, StepSummaryRecord } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';

import { maskText, maskThenCut, maskedAsMember, type MaskedCut } from '../render/output-masking.js';
import { stripTerminalControls } from '../render/sanitize.js';
import { formatCostUsd, formatDuration } from '../render/tui/format.js';
import {
  NODE_ROW_GLYPH,
  absenceText,
  allSettled,
  boundedIdentifier,
  buildNodeCost,
  buildNodeTokens,
  buildToolActivityForAttempt,
  clipCodePoints,
  collapseAttemptRows,
  completedStepTokens,
  foldUsageFacts,
  indexNodeEvents,
  lastAttemptRow,
  readStoredError,
  resolveNodeStatus,
  scrubbedBounded,
  type NodeCost,
  type NodeRowStatus,
  type NodeTokens,
  type StoredErrorView,
  type ToolActivityView,
} from './run-detail-model.js';

/**
 * The pure view model of ONE node's detail page (ADR-0140 §2, "Node detail"; MVP-8 step 1). Built once when the
 * page opens, from rows the caller already read — no I/O, no clock, no ink. The model does NOT read the frozen
 * workflow snapshot: the authored agent and model arrive in `authored`, and the page labels them as authored,
 * distinct from the models the run actually used (read from the node's `cost:attempt_settled` rows).
 *
 * A node's INPUT is deliberately absent. `step_executions.input_json` is never written, and the rendered input
 * can be secret-derived (ADR-0113): the page shows the authored template, which is the caller's to supply.
 *
 * **The output is a bounded projection, and its cost is a bound.** {@link boundText} is the one function that
 * caps it (40 lines, 4,000 code points — the final summary's bounds). A stored document above
 * {@link MAX_STORED_OUTPUT_BYTES} is refused with a fixed sentence before it is parsed. Below that, the document
 * is rendered as indented JSON by a walk that STOPS once it holds more than the bound can show, so the work is
 * proportional to the preview and not to the document. What the walk does emit is masked: every string leaf and
 * every key goes through the shared secret scrubber on its own, WHOLE and only then cut (a leaf to
 * {@link MAX_LEAF_SCRUB_CHARS}, a key to {@link MAX_KEY_SCRUB_CHARS}), because a cut made first can leave a prefix
 * of a secret that the scrubber no longer recognizes; the document's own size gate is what bounds the scrub. One
 * field's text never joins its neighbour's. Every object member is also read by the final summary's own rule
 * (`maskedAsMember`): a member whose NAME labels a credential has its value masked whole before the value is
 * walked. The emitted text is scrubbed once more as a whole, and terminal controls are stripped. Every one of
 * those masks is the seam's (`render/output-masking.ts`), the same functions the final summary masks through, so the
 * page and the summary cannot disagree about what a value is (a test masks a seeded set through both); the walk
 * and its bounds are this page's own. The engine already masked secrets at the write boundary (ADR-0050).
 *
 * **Tokens follow the cost, and carry no cached count.** A node's tokens are the sum of the `inputTokens` and
 * `outputTokens` of its `cost:attempt_settled` rows (the same rows that give its cost), else the step row's tokens
 * for a completed node, else the row's absence sentence — `not recorded` for a finished node, `did not finish` for
 * one left stopped, `in progress` for one still running (see `buildNodeTokens` and `absenceText`); an attempt row
 * follows the same rule over the rows of its own attempt, and the whole node is as far along as its LAST attempt
 * row says, whichever attempt the page inspects. `step_executions.cached_tokens` is never written (it is always `0`), so a page that
 * drew it would state "0 cached" as a fact. The column stays in the db type and is not read here.
 *
 * **The tool trace belongs to one attempt.** A node's terminal event records the attempt that produced it, so the
 * page shows it only for that attempt; any other attempt's trace is `not recorded for this attempt`.
 */

/** Lines of a node's output a page shows (the final summary's bound). */
export const OUTPUT_PREVIEW_MAX_LINES = 40;
/** Code points of a node's output a page shows (the final summary's bound). */
export const OUTPUT_PREVIEW_MAX_CHARS = 4000;
/** Timeline rows a page keeps; the rest are counted, not kept. */
export const MAX_TIMELINE_ROWS = 100;
/**
 * The largest stored output document the preview will parse: 1 MiB. The engine bounds one node's serialized
 * output at 256 KiB at the durable boundary (`size-bounds.ts`, `nodeOutputBytes`), so a larger document was not
 * written by this binary — it is a damaged or foreign row, and parsing it would cost time (and freeze the Home)
 * for text a 40-line page cannot show. Four times the engine's bound leaves room for a bound raised later.
 */
export const MAX_STORED_OUTPUT_BYTES = 1_048_576;
/** A string leaf is cut to this many code units AFTER the scrubber has read it whole. */
const MAX_LEAF_SCRUB_CHARS = 32_768;
/** An object key is cut to this many code points AFTER the scrubber has read it whole; a cut key ends in `…`. */
export const MAX_KEY_SCRUB_CHARS = 256;
/** The model names a node's rows may carry, so a runaway log cannot grow the page without bound. */
const MAX_MODELS_LISTED = 20;

export interface BoundedText {
  readonly text: string;
  /** Anything was cut — by the line bound or the character bound. */
  readonly truncated: boolean;
  /** Lines kept. */
  readonly lines: number;
  /** Code points kept. */
  readonly chars: number;
}

/**
 * Cap `text` at `maxLines` lines and `maxChars` code points; the single bounding function of the node page.
 * Final newlines are not content (they neither count as a line nor cause a cut). A line break counts as one
 * code point. The cut is at a code-point boundary, mid-line when the character bound hits first, and `truncated`
 * says so — nothing is appended to the text. It walks only as far as the bound, so a very large value costs a
 * bound, not its length.
 */
export function boundText(
  text: string,
  maxLines: number = OUTPUT_PREVIEW_MAX_LINES,
  maxChars: number = OUTPUT_PREVIEW_MAX_CHARS,
): BoundedText {
  let limit = text.length;
  while (limit > 0 && text.codePointAt(limit - 1) === 0x0a) limit -= 1;
  const body = text.slice(0, limit);
  let end = 0;
  let chars = 0;
  let lines = body.length === 0 ? 0 : 1;
  for (const point of body) {
    if (chars === maxChars) return { text: body.slice(0, end), truncated: true, lines, chars };
    if (point === '\n') {
      if (lines === maxLines) return { text: body.slice(0, end), truncated: true, lines, chars };
      lines += 1;
    }
    end += point.length;
    chars += 1;
  }
  return { text: body, truncated: false, lines, chars };
}

/** The bounded, masked projection of a node's stored output. */
export interface OutputPreview extends BoundedText {
  /** The scrubber changed something before the bound was applied. */
  readonly masked: boolean;
}

/**
 * A string leaf, masked on its own WHOLE and only then cut to {@link MAX_LEAF_SCRUB_CHARS} (the seam's
 * {@link maskThenCut}). A cut made first can split a secret (a URL's userinfo, say), and the prefix left in the shown
 * text is no longer a shape the scrubber recognizes. `onMask` fires when the scrubber changed it.
 */
function scrubLeaf(value: string, onMask: () => void): MaskedCut {
  return maskThenCut(value, MAX_LEAF_SCRUB_CHARS, onMask);
}

/** An object key, scrubbed on its own WHOLE, then cut to {@link MAX_KEY_SCRUB_CHARS} code points and ended with `…` if it was cut. */
function scrubKey(key: string, onMask: () => void): string {
  const out = maskText(key, onMask);
  const clipped = clipCodePoints(out, MAX_KEY_SCRUB_CHARS);
  return clipped.truncated ? `${clipped.text}…` : clipped.text;
}

/**
 * The text the walk has emitted so far, and whether it already holds more than the bound can show. Past that
 * point the walk is over: {@link PreviewSink.push} drops what it is given and says (through `dropped`) that the
 * document was not shown to its end.
 */
class PreviewSink {
  private readonly parts: string[] = [];
  private codePoints = 0;
  private newlines = 0;
  /** More than the bound can show has been emitted. */
  full = false;
  /** Something was refused after the sink was full. */
  dropped = false;

  push(text: string): void {
    if (this.full) {
      this.dropped = true;
      return;
    }
    this.parts.push(text);
    for (const point of text) {
      this.codePoints += 1;
      if (point === '\n') this.newlines += 1;
    }
    // One past the bound on either axis, so the bounding function sees the cut and says so.
    if (this.codePoints > OUTPUT_PREVIEW_MAX_CHARS || this.newlines > OUTPUT_PREVIEW_MAX_LINES) {
      this.full = true;
    }
  }

  text(): string {
    return this.parts.join('');
  }
}

/**
 * Write a parsed JSON value into `sink` exactly as `JSON.stringify(value, null, 2)` would — with every string and
 * every key scrubbed on its own — and stop as soon as the sink is full. The input came from `JSON.parse`, so it
 * holds no cycle, no `toJSON` and no `undefined`. Every nesting level and every member starts a line, so the
 * recursion is bounded by the line bound too.
 */
function writePretty(value: unknown, depth: number, sink: PreviewSink, onMask: () => void): void {
  if (sink.full) {
    sink.dropped = true;
    return;
  }
  if (typeof value === 'string') {
    sink.push(JSON.stringify(scrubLeaf(value, onMask).text));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    sink.push(JSON.stringify(value));
    return;
  }
  const closing = `\n${'  '.repeat(depth)}`;
  const inner = `\n${'  '.repeat(depth + 1)}`;
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    if (items.length === 0) {
      sink.push('[]');
      return;
    }
    sink.push('[');
    for (const [index, item] of items.entries()) {
      if (sink.full) {
        sink.dropped = true;
        return;
      }
      sink.push(index === 0 ? inner : `,${inner}`);
      writePretty(item, depth + 1, sink, onMask);
    }
    sink.push(`${closing}]`);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    sink.push('{}');
    return;
  }
  sink.push('{');
  for (const [index, [key, item]] of entries.entries()) {
    if (sink.full) {
      sink.dropped = true;
      return;
    }
    sink.push(`${index === 0 ? '' : ','}${inner}${JSON.stringify(scrubKey(key, onMask))}: `);
    // The final summary's own rule: a member whose NAME labels a credential has its value masked whole.
    writePretty(maskedAsMember(key, item, onMask), depth + 1, sink, onMask);
  }
  sink.push(`${closing}}`);
}

/** The fixed sentence for a stored output that is too large to read: only its size is said, never its content. */
function oversizedOutputPreview(bytes: number): OutputPreview {
  return { ...boundText(`output too large to preview (${bytes} bytes)`), masked: false };
}

/**
 * A node's stored `output_json` as the bounded, masked preview. A string value is shown as itself (it is the
 * common case and keeps its own line breaks); anything else is shown as indented JSON, written only as far as
 * the bound can show. A document above {@link MAX_STORED_OUTPUT_BYTES} is not parsed at all, and an unreadable
 * one yields a fixed sentence, never a throw.
 */
export function buildOutputPreview(outputJson: string): OutputPreview {
  const size = Buffer.byteLength(outputJson, 'utf8');
  if (size > MAX_STORED_OUTPUT_BYTES) return oversizedOutputPreview(size);
  let masked = false;
  const onMask = (): void => {
    masked = true;
  };
  let shown: string;
  let dropped = false;
  try {
    const value: unknown = JSON.parse(outputJson);
    if (typeof value === 'string') {
      const leaf = scrubLeaf(value, onMask);
      shown = leaf.text;
      dropped = leaf.cut;
    } else {
      const sink = new PreviewSink();
      writePretty(value, 0, sink, onMask);
      shown = sink.text();
      dropped = sink.dropped;
    }
  } catch {
    return { ...boundText('[the stored output could not be read]'), masked: false };
  }
  const whole = maskText(shown, onMask);
  const bounded = boundText(stripTerminalControls(whole));
  // A walk that stopped early cut the document even if masking left the emitted text under the bound.
  return { ...bounded, truncated: bounded.truncated || dropped, masked };
}

/** One attempt of the node, with the cost of the model calls that its `node:started` bounds. */
export interface AttemptRowView {
  /** `step_executions.attempt_number` (the node-retry dispatch index). */
  readonly attempt: number;
  readonly status: NodeRowStatus;
  readonly glyph: string;
  readonly durationMs?: number;
  /** The attempt's own tokens: its settled calls, else its step row when it completed, else the attempt's absence sentence. */
  readonly tokens: NodeTokens;
  /** The attempt's own settled model calls; the attempt's absence sentence (`not recorded` for a finished one) when the log holds none for it. */
  readonly cost: NodeCost;
}

/** One line of the node's event timeline. */
export interface TimelineRowView {
  readonly sequenceNumber: number;
  readonly timestamp: string;
  readonly label: string;
  readonly detail?: string;
}

export interface NodeDetailInput {
  /** The inspected attempt, with its output and error (`loadStepDetail`). */
  readonly detail: StepDetailRecord;
  /** Every attempt row of the node (`listStepSummaries`, one node). Empty means the inspected attempt only. */
  readonly attempts: readonly StepSummaryRecord[];
  /** The run's event log; only this node's events are read. */
  readonly events: readonly RunEvent[];
  /** What the workflow authored for this node, from the frozen snapshot — never what ran. */
  readonly authored?: { readonly agentSlug?: string; readonly model?: string };
  /** The run is finished, so an attempt row still `running` is `stopped`. Defaults to `false`. */
  readonly runFinished?: boolean;
}

export interface NodeDetailModel {
  /** The raw identity; draw {@link label}. */
  readonly nodeId: string;
  readonly label: string;
  readonly nodeType: string;
  /** The inspected attempt's status. */
  readonly status: NodeRowStatus;
  readonly glyph: string;
  readonly attemptNumber: number;
  readonly durationMs?: number;
  readonly durationText?: string;
  /**
   * The whole node's tokens, beside the whole node's cost: every attempt's settled calls, else the step rows when the
   * node completed, else the node's absence sentence. One attempt's own figure is on its {@link AttemptRowView}.
   * There is no cached count: the column is never written (see the module note).
   */
  readonly tokens: NodeTokens;
  /** The whole node: every attempt's settled calls, else the boundary cost, else the node's absence sentence. */
  readonly cost: NodeCost;
  readonly attempts: readonly AttemptRowView[];
  /** The distinct models the node's settled calls actually ran on, in first-use order, scrubbed, one-line and cut to 128 characters, at most 20. */
  readonly modelsUsed: readonly string[];
  /** What the workflow authored, one-line and cut to 128 characters; absent fields are simply not shown. */
  readonly authored: { readonly agent?: string; readonly model?: string };
  readonly error?: StoredErrorView;
  readonly outputPreview?: OutputPreview;
  readonly timeline: readonly TimelineRowView[];
  /** Timeline rows beyond {@link MAX_TIMELINE_ROWS}. */
  readonly timelineOmitted: number;
  /**
   * The inspected attempt's trace: its terminal's; `not recorded for this attempt` when the terminal closed another;
   * and with no terminal the attempt's absence sentence (`did not finish`, `in progress`, or `not recorded`).
   */
  readonly toolActivity: ToolActivityView;
}

/**
 * One timeline row before its text is built: the cheap part (its place, its time, its label) and, when the row has
 * one, a `detail` that is built ONLY when the row is shown. A stored text a row's detail carries is scrubbed there, so
 * the page scrubs the rows it shows (at most {@link MAX_TIMELINE_ROWS}) and never the rest of a long log.
 */
interface TimelineDraft {
  readonly sequenceNumber: number;
  readonly timestamp: string;
  readonly label: string;
  readonly detail?: () => string;
}

/** The durable lifecycle events a node's timeline shows; streamed events (tokens, tool calls) are not durable. */
function timelineDraft(event: RunEvent, nodeId: string): TimelineDraft | undefined {
  if (!('nodeId' in event) || event.nodeId !== nodeId) return undefined;
  const base = { sequenceNumber: event.sequenceNumber, timestamp: event.timestamp };
  switch (event.type) {
    case 'node:started': {
      const attempt = event.attemptNumber ?? 1;
      return { ...base, label: 'Started', detail: () => `attempt ${attempt}` };
    }
    case 'node:retrying': {
      const { attemptNumber, error, delayMs } = event;
      return {
        ...base,
        label: 'Retrying',
        detail: () =>
          `attempt ${attemptNumber} failed (${scrubbedBounded(error.code)}); next in ${formatDuration(delayMs)}`,
      };
    }
    case 'node:completed': {
      const { durationMs } = event;
      return { ...base, label: 'Completed', detail: () => formatDuration(durationMs) };
    }
    case 'node:failed': {
      const { error } = event;
      return { ...base, label: 'Failed', detail: () => scrubbedBounded(error.code) };
    }
    case 'node:skipped': {
      const { reason } = event;
      return { ...base, label: 'Skipped', detail: () => scrubbedBounded(reason) };
    }
    case 'cost:attempt_settled': {
      const { model, priced, costMicrocents } = event;
      return {
        ...base,
        label: 'Model call settled',
        detail: () =>
          `${scrubbedBounded(model)} · ${priced ? formatCostUsd(costMicrocents) : 'price unknown'}`,
      };
    }
    case 'human_gate:paused': {
      const { gateType } = event;
      return { ...base, label: 'Gate opened', detail: () => scrubbedBounded(gateType) };
    }
    case 'human_gate:resumed': {
      const { decision } = event;
      return { ...base, label: 'Gate decided', detail: () => scrubbedBounded(decision) };
    }
    case 'media_job:submitted': {
      const { modality } = event;
      return { ...base, label: 'Media job submitted', detail: () => scrubbedBounded(modality) };
    }
    case 'budget:paused':
      return { ...base, label: 'Budget paused' };
    case 'budget:authorization':
      return { ...base, label: 'Budget authorization' };
    default:
      return undefined;
  }
}

/** A timeline row with its text built: the only place a draft's `detail` runs. */
function timelineRow(draft: TimelineDraft): TimelineRowView {
  const { detail, ...rest } = draft;
  return detail === undefined ? rest : { ...rest, detail: detail() };
}

/**
 * The preview of the inspected attempt's stored output. The detail read size-gates the document in SQL: an over-bound
 * output arrives as `null` text with its byte length and is refused with the fixed sentence without being read; `null`
 * text with no byte length is an attempt that recorded no output, which has no preview.
 */
function storedOutputPreview(detail: StepDetailRecord): OutputPreview | undefined {
  if (detail.outputJson !== null) return buildOutputPreview(detail.outputJson);
  return detail.outputByteLength === null
    ? undefined
    : oversizedOutputPreview(detail.outputByteLength);
}

/** Build the node detail page's model. See the module note. */
export function buildNodeDetailModel(input: NodeDetailInput): NodeDetailModel {
  const { detail, events } = input;
  const nodeId = detail.nodeId;
  const storedRows = input.attempts.length === 0 ? [detail] : input.attempts;
  // One row per attempt number before any per-attempt or fallback use: a re-dispatched node (a budget-approved
  // redispatch, a resume of a node left running) can hold two rows under one number, and the attempts list would
  // show that attempt twice while the tokens fallback added its tokens to themselves.
  const attemptRows = collapseAttemptRows(storedRows);
  const logs = indexNodeEvents(events);
  const log = logs.get(nodeId);
  const facts = foldUsageFacts(events);
  const coverage = facts.nodes.get(nodeId) ?? facts.run;
  const runFinished = input.runFinished ?? false;

  const status = resolveNodeStatus({ step: detail, log, runFinished });
  const settled = allSettled(log);
  // The node-wide boundary cost is a maximum, not a per-attempt figure: it is read over every stored row.
  const boundaryMicrocents = storedRows.reduce((max, row) => Math.max(max, row.costMicrocents), 0);

  // The partition of the module note applied per attempt: a group belongs to the attempt whose number it was
  // dispatched under. Two groups with one number (a re-dispatch after a resume) share that attempt's row.
  const attempts = [...attemptRows]
    .sort((a, b) => a.attemptNumber - b.attemptNumber)
    .map((row): AttemptRowView => {
      const attemptStatus = resolveNodeStatus({ step: row, log, runFinished });
      const attemptSettled =
        log?.groups
          .filter((group) => group.attemptNumber === row.attemptNumber)
          .flatMap((group) => group.settled) ?? [];
      return {
        attempt: row.attemptNumber,
        status: attemptStatus,
        glyph: NODE_ROW_GLYPH[attemptStatus],
        ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
        tokens: buildNodeTokens({
          settled: attemptSettled,
          completedStep: completedStepTokens([row], attemptStatus),
          absence: absenceText(attemptStatus, runFinished),
        }),
        cost: buildNodeCost({
          settled: attemptSettled,
          boundaryMicrocents: 0,
          coverage,
          absence: absenceText(attemptStatus, runFinished),
        }),
      };
    });

  // The cap comes BEFORE the scrub: only the first MAX_MODELS_LISTED distinct stored names are scrubbed, so a log of
  // thousands of settled rows with thousands of names costs a bound, not its size. Two stored names that scrub to one
  // line are listed once.
  const storedModels = new Set<string>();
  for (const row of settled) {
    if (storedModels.size === MAX_MODELS_LISTED) break;
    storedModels.add(row.model);
  }
  const models = [...new Set([...storedModels].map((model) => scrubbedBounded(model)))];

  // The node's own rows first, in sequence order; the cap comes BEFORE the text is built, so only the rows the page
  // shows are scrubbed, and the rest are counted.
  const timelineAll = [...events]
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .flatMap((event) => timelineDraft(event, nodeId) ?? []);
  const error = readStoredError(detail.errorJson, detail.errorByteLength);
  const outputPreview = storedOutputPreview(detail);
  const lastKnown = lastAttemptRow(attemptRows) ?? detail;
  // The node as a whole is as far along as its LAST attempt row says, whichever attempt the page inspects: this is
  // what its whole-node tokens and cost say when they have nothing to show.
  const nodeStatus = resolveNodeStatus({ step: lastKnown, log, runFinished });
  const nodeAbsence = absenceText(nodeStatus, runFinished);

  return {
    nodeId,
    label: scrubbedBounded(nodeId),
    nodeType: scrubbedBounded(lastKnown.nodeType),
    status,
    glyph: NODE_ROW_GLYPH[status],
    attemptNumber: detail.attemptNumber,
    ...(detail.durationMs === undefined
      ? {}
      : { durationMs: detail.durationMs, durationText: formatDuration(detail.durationMs) }),
    tokens: buildNodeTokens({
      settled,
      completedStep: completedStepTokens(attemptRows, nodeStatus),
      absence: nodeAbsence,
    }),
    cost: buildNodeCost({ settled, boundaryMicrocents, coverage, absence: nodeAbsence }),
    attempts,
    modelsUsed: models,
    authored: {
      ...(input.authored?.agentSlug === undefined
        ? {}
        : { agent: boundedIdentifier(input.authored.agentSlug) }),
      ...(input.authored?.model === undefined
        ? {}
        : { model: boundedIdentifier(input.authored.model) }),
    },
    ...(error === undefined ? {} : { error }),
    ...(outputPreview === undefined ? {} : { outputPreview }),
    timeline: timelineAll.slice(0, MAX_TIMELINE_ROWS).map(timelineRow),
    timelineOmitted: Math.max(0, timelineAll.length - MAX_TIMELINE_ROWS),
    toolActivity: buildToolActivityForAttempt(
      log?.lastTerminal,
      detail.attemptNumber,
      absenceText(status, runFinished),
    ),
  };
}
