import type { StepDetailRecord, StepSummaryRecord } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { scrubSecrets } from '@relavium/llm/scrub-secrets';

import { sanitizeInline, stripTerminalControls } from '../render/sanitize.js';
import { formatCostUsd, formatDuration } from '../render/tui/format.js';
import {
  NODE_ROW_GLYPH,
  allSettled,
  buildNodeCost,
  buildToolActivity,
  foldUsageFacts,
  indexNodeEvents,
  lastAttemptRow,
  readStoredError,
  resolveNodeStatus,
  type NodeCost,
  type NodeRowStatus,
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
 * **The output is a bounded projection.** {@link boundText} is the one function that caps it (40 lines, 4,000
 * code points — the final summary's bounds). Before it is bounded the stored document is masked: every string
 * leaf and key goes through the shared secret scrubber on its own, so one field's text never joins its
 * neighbour's, the pretty-printed whole is scrubbed once more, and terminal controls are stripped. That is a
 * FLOOR, not the final summary's whole renderer (which also masks a member whose NAME labels a credential and is
 * not exported): the engine already masked secrets at the write boundary (ADR-0050), and MVP-8 step 3 should
 * replace this floor with that renderer's exported core when it builds the screen.
 */

/** Lines of a node's output a page shows (the final summary's bound). */
export const OUTPUT_PREVIEW_MAX_LINES = 40;
/** Code points of a node's output a page shows (the final summary's bound). */
export const OUTPUT_PREVIEW_MAX_CHARS = 4000;
/** Timeline rows a page keeps; the rest are counted, not kept. */
export const MAX_TIMELINE_ROWS = 100;
/** A string leaf is cut to this many code points before the scrubber reads it, so one value costs a bound. */
const MAX_LEAF_SCRUB_CHARS = 32_768;
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
 * A copy of a parsed JSON value with every string — and every object key — scrubbed on its own. The input came
 * from `JSON.parse`, so it holds no cycle, no `toJSON` and no `undefined`. An own `__proto__` member is kept with
 * `defineProperty` (assignment would hit the prototype setter and drop it).
 */
function scrubLeaves(value: unknown, onMask: () => void): unknown {
  if (typeof value === 'string') {
    const clipped =
      value.length > MAX_LEAF_SCRUB_CHARS ? value.slice(0, MAX_LEAF_SCRUB_CHARS) : value;
    const out = scrubSecrets(clipped);
    if (out !== clipped) onMask();
    return out;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item): unknown => scrubLeaves(item, onMask));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const maskedKey = scrubSecrets(key);
    if (maskedKey !== key) onMask();
    Object.defineProperty(copy, maskedKey, {
      value: scrubLeaves(item, onMask),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

/**
 * A node's stored `output_json` as the bounded, masked preview. A string value is shown as itself (it is the
 * common case and keeps its own line breaks); anything else is shown as indented JSON. An unreadable document
 * yields a fixed sentence, never a throw.
 */
export function buildOutputPreview(outputJson: string): OutputPreview {
  let masked = false;
  const onMask = (): void => {
    masked = true;
  };
  let shown: string;
  try {
    const value = scrubLeaves(JSON.parse(outputJson), onMask);
    shown = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
  } catch {
    return { ...boundText('[the stored output could not be read]'), masked: false };
  }
  const whole = scrubSecrets(shown);
  if (whole !== shown) masked = true;
  return { ...boundText(stripTerminalControls(whole)), masked };
}

/** One attempt of the node, with the cost of the model calls that its `node:started` bounds. */
export interface AttemptRowView {
  /** `step_executions.attempt_number` (the node-retry dispatch index). */
  readonly attempt: number;
  readonly status: NodeRowStatus;
  readonly glyph: string;
  readonly durationMs?: number;
  readonly tokens: { readonly input: number; readonly output: number };
  /** The attempt's own settled model calls; `not recorded` when the log holds none for it. */
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
  readonly tokens: { readonly input: number; readonly output: number; readonly cached: number };
  /** The whole node: every attempt's settled calls, else the boundary cost, else `not recorded`. */
  readonly cost: NodeCost;
  readonly attempts: readonly AttemptRowView[];
  /** The distinct models the node's settled calls actually ran on, in first-use order, sanitized. */
  readonly modelsUsed: readonly string[];
  /** What the workflow authored, sanitized; absent fields are simply not shown. */
  readonly authored: { readonly agent?: string; readonly model?: string };
  readonly error?: StoredErrorView;
  readonly outputPreview?: OutputPreview;
  readonly timeline: readonly TimelineRowView[];
  /** Timeline rows beyond {@link MAX_TIMELINE_ROWS}. */
  readonly timelineOmitted: number;
  readonly toolActivity: ToolActivityView;
}

/** The durable lifecycle events a node's timeline shows; streamed events (tokens, tool calls) are not durable. */
function timelineRow(event: RunEvent, nodeId: string): TimelineRowView | undefined {
  if (!('nodeId' in event) || event.nodeId !== nodeId) return undefined;
  const base = { sequenceNumber: event.sequenceNumber, timestamp: event.timestamp };
  switch (event.type) {
    case 'node:started':
      return { ...base, label: 'Started', detail: `attempt ${event.attemptNumber ?? 1}` };
    case 'node:retrying':
      return {
        ...base,
        label: 'Retrying',
        detail: `attempt ${event.attemptNumber} failed (${sanitizeInline(event.error.code)}); next in ${formatDuration(event.delayMs)}`,
      };
    case 'node:completed':
      return { ...base, label: 'Completed', detail: formatDuration(event.durationMs) };
    case 'node:failed':
      return { ...base, label: 'Failed', detail: sanitizeInline(event.error.code) };
    case 'node:skipped':
      return { ...base, label: 'Skipped', detail: sanitizeInline(event.reason) };
    case 'cost:attempt_settled':
      return {
        ...base,
        label: 'Model call settled',
        detail: `${sanitizeInline(event.model)} · ${event.priced ? formatCostUsd(event.costMicrocents) : 'price unknown'}`,
      };
    case 'human_gate:paused':
      return { ...base, label: 'Gate opened', detail: sanitizeInline(event.gateType) };
    case 'human_gate:resumed':
      return { ...base, label: 'Gate decided', detail: sanitizeInline(event.decision) };
    case 'media_job:submitted':
      return { ...base, label: 'Media job submitted', detail: sanitizeInline(event.modality) };
    case 'budget:paused':
      return { ...base, label: 'Budget paused' };
    case 'budget:authorization':
      return { ...base, label: 'Budget authorization' };
    default:
      return undefined;
  }
}

/** Build the node detail page's model. See the module note. */
export function buildNodeDetailModel(input: NodeDetailInput): NodeDetailModel {
  const { detail, events } = input;
  const nodeId = detail.nodeId;
  const attemptRows = input.attempts.length === 0 ? [detail] : input.attempts;
  const logs = indexNodeEvents(events);
  const log = logs.get(nodeId);
  const facts = foldUsageFacts(events);
  const coverage = facts.nodes.get(nodeId) ?? facts.run;
  const runFinished = input.runFinished ?? false;

  const status = resolveNodeStatus({ step: detail, log, runFinished });
  const settled = allSettled(log);
  const boundaryMicrocents = attemptRows.reduce((max, row) => Math.max(max, row.costMicrocents), 0);

  // The partition of the module note applied per attempt: a group belongs to the attempt whose number it was
  // dispatched under. Two groups with one number (a re-dispatch after a resume) share that attempt's row.
  const attempts = [...attemptRows]
    .sort((a, b) => a.attemptNumber - b.attemptNumber)
    .map((row): AttemptRowView => {
      const attemptStatus = resolveNodeStatus({ step: row, log, runFinished });
      return {
        attempt: row.attemptNumber,
        status: attemptStatus,
        glyph: NODE_ROW_GLYPH[attemptStatus],
        ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
        tokens: { input: row.inputTokens, output: row.outputTokens },
        cost: buildNodeCost({
          settled:
            log?.groups
              .filter((group) => group.attemptNumber === row.attemptNumber)
              .flatMap((group) => group.settled) ?? [],
          boundaryMicrocents: 0,
          coverage,
        }),
      };
    });

  const models: string[] = [];
  for (const row of settled) {
    const model = sanitizeInline(row.model);
    if (!models.includes(model) && models.length < MAX_MODELS_LISTED) models.push(model);
  }

  const timelineAll = [...events]
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .flatMap((event) => timelineRow(event, nodeId) ?? []);
  const error = readStoredError(detail.errorJson);
  const lastKnown = lastAttemptRow(attemptRows) ?? detail;

  return {
    nodeId,
    label: sanitizeInline(nodeId),
    nodeType: sanitizeInline(lastKnown.nodeType),
    status,
    glyph: NODE_ROW_GLYPH[status],
    attemptNumber: detail.attemptNumber,
    ...(detail.durationMs === undefined
      ? {}
      : { durationMs: detail.durationMs, durationText: formatDuration(detail.durationMs) }),
    tokens: { input: detail.inputTokens, output: detail.outputTokens, cached: detail.cachedTokens },
    cost: buildNodeCost({ settled, boundaryMicrocents, coverage }),
    attempts,
    modelsUsed: models,
    authored: {
      ...(input.authored?.agentSlug === undefined
        ? {}
        : { agent: sanitizeInline(input.authored.agentSlug) }),
      ...(input.authored?.model === undefined
        ? {}
        : { model: sanitizeInline(input.authored.model) }),
    },
    ...(error === undefined ? {} : { error }),
    ...(detail.outputJson === undefined
      ? {}
      : { outputPreview: buildOutputPreview(detail.outputJson) }),
    timeline: timelineAll.slice(0, MAX_TIMELINE_ROWS),
    timelineOmitted: Math.max(0, timelineAll.length - MAX_TIMELINE_ROWS),
    toolActivity: buildToolActivity(log?.lastTerminal),
  };
}
