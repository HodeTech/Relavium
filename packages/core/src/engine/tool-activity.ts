import {
  TOOL_ACTIVITY_MAX_ENTRIES,
  TOOL_ACTIVITY_TOOL_ID_PATTERN,
  TOOL_ACTIVITY_UNKNOWN_TOOL_ID,
  type ToolActivityEntry,
} from '@relavium/shared';

/**
 * The in-process, content-free tool trace of one node attempt
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §4): the engine records a call when the turn announces that it STARTS and a result when the `agent:tool_result`
 * event passes through, and attaches what it returns to the node's durable terminal (`node:completed`, or the
 * terminal `node:failed`). The bus events are streamed and never persisted; this tracker is the only thing that turns
 * them into a durable fact, and it keeps nothing but an id, an outcome and a duration — the call's arguments and the
 * result's text never enter it, so no later change can leak them through the field.
 *
 * **Start, not announcement.** A call is recorded when it starts, not when its `agent:tool_call` event is emitted
 * (after the dispatch returned, and dropped once the node is no longer live), so a call still running when the node
 * is cut is on the trace — unpaired.
 *
 * **Pairing.** The two events carry no call id, so a result pairs with the OLDEST still-unpaired call of the
 * SAME node and the SAME tool (first in, first out). Two parallel calls of one tool therefore pair in call
 * order, which is exact when they finish in order and a swap of two durations when they do not — the cost of an
 * id the events do not have, accepted in ADR-0140 §4. A result with no matching call is ignored.
 *
 * **Three outcomes.** An entry says `resultRecorded` (a result paired with the call) and `ok` (that result's
 * success; `false` while unpaired): a refusal is `resultRecorded: true, ok: false` with no duration; a dispatch that
 * ran and failed is the same with a duration; a call the node ended without a result for is
 * `resultRecorded: false, ok: false`. The tracker does not tell a refusal from a failure — it records whether the
 * result carried a measurement.
 *
 * **Duration.** The tracker has no clock. A call's duration is the one the TURN measured around the registry's
 * dispatch and put on the `agent:tool_result` event; the two events themselves are emitted back to back AFTER the
 * dispatch returned, so a difference between their arrival times would measure nothing. A result that carries no
 * measurement leaves the entry without a duration — never a guessed 0.
 *
 * **Id.** The id is the one thing in an entry that could come from a model, so it is bounded here too: anything
 * outside {@link TOOL_ACTIVITY_TOOL_ID_PATTERN} is recorded as {@link TOOL_ACTIVITY_UNKNOWN_TOOL_ID}, on the call
 * and on the result alike so they still pair. The turn already maps a name that is not a registered tool to that
 * same id at the source; this is the backstop that keeps the stored value inside the schema's bound whatever a
 * custom executor emits. (A charset-valid unregistered name is the source's to catch — only the registry knows.)
 *
 * **Bound.** Only the first {@link TOOL_ACTIVITY_MAX_ENTRIES} calls of a node are kept; every call beyond is
 * counted, so memory per node is fixed however many calls a runaway loop makes.
 *
 * Pure: no clock, no I/O, no event ordering of its own.
 */

/** What {@link ToolActivityTracker.take} hands the engine for one node: spread it onto the terminal event. */
export interface ToolActivitySnapshot {
  /** The kept entries, in call order; empty when the node made no tool call. */
  readonly toolActivity: ToolActivityEntry[];
  /** The calls beyond the kept entries; present only when there were any. */
  readonly toolActivityTruncated?: number;
}

interface TrackedCall {
  readonly toolId: string;
  /** A result has paired with this call; becomes the entry's `resultRecorded`. */
  paired: boolean;
  /** The paired result's success; `false` until (and unless) a result pairs. */
  ok: boolean;
  /** Present only for a paired call whose dispatch was measured. */
  durationMs: number | undefined;
}

interface NodeActivity {
  readonly calls: TrackedCall[];
  /** Every call recorded for the attempt, kept or not — the truncated count is `total - kept`. */
  total: number;
}

/** The id the entry may carry: the call's own when it is within the schema's bound, else the fixed unknown id. */
function boundedToolId(toolId: string): string {
  return TOOL_ACTIVITY_TOOL_ID_PATTERN.test(toolId) ? toolId : TOOL_ACTIVITY_UNKNOWN_TOOL_ID;
}

export class ToolActivityTracker {
  readonly #byNode = new Map<string, NodeActivity>();

  /** Start a node attempt afresh: whatever an earlier attempt of this node recorded is discarded. */
  reset(nodeId: string): void {
    this.#byNode.set(nodeId, { calls: [], total: 0 });
  }

  /** A tool call started. Counted always; kept only while the node is under the entry bound. */
  recordCall(nodeId: string, toolId: string): void {
    let activity = this.#byNode.get(nodeId);
    if (activity === undefined) {
      activity = { calls: [], total: 0 };
      this.#byNode.set(nodeId, activity);
    }
    activity.total += 1;
    if (activity.calls.length < TOOL_ACTIVITY_MAX_ENTRIES) {
      activity.calls.push({
        toolId: boundedToolId(toolId),
        paired: false,
        ok: false,
        durationMs: undefined,
      });
    }
  }

  /**
   * A tool returned. Pairs with the oldest unpaired call of this node and tool; with none (an unmatched result, or
   * the call fell beyond the entry bound) it is ignored. `durationMs` is the turn's measurement of the dispatch,
   * when it made one; absent (or not a finite number) it records no duration.
   */
  recordResult(nodeId: string, toolId: string, success: boolean, durationMs?: number): void {
    const bounded = boundedToolId(toolId);
    const call = this.#byNode
      .get(nodeId)
      ?.calls.find((candidate) => !candidate.paired && candidate.toolId === bounded);
    if (call === undefined) return;
    call.paired = true;
    call.ok = success;
    // A negative or non-finite reading must not put a negative or NaN number into a durable event whose schema
    // requires a non-negative integer: a negative clamps to 0 (a clock that stepped back), a non-finite is no duration.
    call.durationMs =
      durationMs === undefined || !Number.isFinite(durationMs)
        ? undefined
        : Math.max(0, Math.trunc(durationMs));
  }

  /**
   * Take the node's trace and forget it. Every entry says whether a result was recorded for its call
   * (`resultRecorded`), its `ok` (that result's success, `false` while unpaired) and a `durationMs` only when the
   * dispatch was measured — an unpaired call has none, because nothing was recorded to measure it by.
   */
  take(nodeId: string): ToolActivitySnapshot {
    const activity = this.#byNode.get(nodeId);
    this.#byNode.delete(nodeId);
    if (activity === undefined) return { toolActivity: [] };
    const toolActivity = activity.calls.map(
      (call): ToolActivityEntry => ({
        toolId: call.toolId,
        ok: call.ok,
        resultRecorded: call.paired,
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
      }),
    );
    const truncated = activity.total - activity.calls.length;
    return truncated > 0 ? { toolActivity, toolActivityTruncated: truncated } : { toolActivity };
  }
}
