import { TOOL_ACTIVITY_MAX_ENTRIES, type ToolActivityEntry } from '@relavium/shared';

/**
 * The in-process, content-free tool trace of one node attempt
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §4): the engine feeds it the `agent:tool_call` / `agent:tool_result` events it already passes through, and
 * attaches what it returns to the node's durable terminal (`node:completed`, or the terminal `node:failed`).
 * The two bus events are streamed and never persisted; this tracker is the only thing that turns them into a
 * durable fact, and it keeps nothing but an id, an outcome and a duration — the call's arguments and the
 * result's text never enter it, so no later change can leak them through the field.
 *
 * **Pairing.** The two events carry no call id, so a result pairs with the OLDEST still-unpaired call of the
 * SAME node and the SAME tool (first in, first out). Two parallel calls of one tool therefore pair in call
 * order, which is exact when they finish in order and a swap of two durations when they do not — the cost of an
 * id the events do not have, accepted in ADR-0140 §4. A result with no matching call is ignored.
 *
 * **Bound.** Only the first {@link TOOL_ACTIVITY_MAX_ENTRIES} calls of a node are kept; every call beyond is
 * counted, so memory per node is fixed however many calls a runaway loop makes.
 *
 * Pure: no clock (the caller passes `atMs`), no I/O, no event ordering of its own.
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
  readonly calledAtMs: number;
  paired: boolean;
  ok: boolean;
  durationMs: number | undefined;
}

interface NodeActivity {
  readonly calls: TrackedCall[];
  /** Every call recorded for the attempt, kept or not — the truncated count is `total - kept`. */
  total: number;
}

export class ToolActivityTracker {
  readonly #byNode = new Map<string, NodeActivity>();

  /** Start a node attempt afresh: whatever an earlier attempt of this node recorded is discarded. */
  reset(nodeId: string): void {
    this.#byNode.set(nodeId, { calls: [], total: 0 });
  }

  /** A tool call began at `atMs`. Counted always; kept only while the node is under the entry bound. */
  recordCall(nodeId: string, toolId: string, atMs: number): void {
    let activity = this.#byNode.get(nodeId);
    if (activity === undefined) {
      activity = { calls: [], total: 0 };
      this.#byNode.set(nodeId, activity);
    }
    activity.total += 1;
    if (activity.calls.length < TOOL_ACTIVITY_MAX_ENTRIES) {
      activity.calls.push({
        toolId,
        calledAtMs: atMs,
        paired: false,
        ok: false,
        durationMs: undefined,
      });
    }
  }

  /**
   * A tool returned at `atMs`. Pairs with the oldest unpaired call of this node and tool; with none (an
   * unmatched result, or the call fell beyond the entry bound) it is ignored.
   */
  recordResult(nodeId: string, toolId: string, success: boolean, atMs: number): void {
    const call = this.#byNode
      .get(nodeId)
      ?.calls.find((candidate) => !candidate.paired && candidate.toolId === toolId);
    if (call === undefined) return;
    call.paired = true;
    call.ok = success;
    // A clock that stepped backwards (or a non-finite reading) must not put a negative or NaN number into a
    // durable event whose schema requires a non-negative integer.
    const elapsed = atMs - call.calledAtMs;
    call.durationMs = Number.isFinite(elapsed) ? Math.max(0, Math.trunc(elapsed)) : 0;
  }

  /**
   * Take the node's trace and forget it. A call still unpaired is `ok: false` with no duration — the node
   * ended before its result was recorded; a failed result is `ok: false` WITH a duration.
   */
  take(nodeId: string): ToolActivitySnapshot {
    const activity = this.#byNode.get(nodeId);
    this.#byNode.delete(nodeId);
    if (activity === undefined) return { toolActivity: [] };
    const toolActivity = activity.calls.map(
      (call): ToolActivityEntry =>
        call.paired && call.durationMs !== undefined
          ? { toolId: call.toolId, ok: call.ok, durationMs: call.durationMs }
          : { toolId: call.toolId, ok: false },
    );
    const truncated = activity.total - activity.calls.length;
    return truncated > 0 ? { toolActivity, toolActivityTruncated: truncated } : { toolActivity };
  }
}
