import {
  collectDurableMediaHandles,
  type AgentTokenEvent,
  type DurableMediaMeta,
  type RunEvent,
} from '@relavium/shared';

/**
 * The pure, framework-free view model for the `ink` streaming TUI (workstream **2.E**). It reduces the
 * canonical {@link RunEvent} stream into an immutable {@link RunViewState} the React/`ink` component
 * (`RunApp.tsx`) merely projects — so all the logic (per-node status, the active node's token buffer,
 * cost accumulation, `sequenceNumber` gap detection, the terminal summary) is unit-tested here with no
 * TTY and no React. Mirrors ADR-0047's "framework-free cores": the reducer is the tested core, the ink
 * view is a thin projection.
 *
 * Every derived buffer is BOUNDED (token text, tool lines, warnings) so a long, high-token-rate run keeps
 * the render and memory bounded — events are never dropped (each is reduced), only the *displayed* tail is
 * capped.
 */

/** A per-node lifecycle status shown as a glyph/spinner in the node list. */
export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'retrying';

export interface NodeView {
  readonly nodeId: string;
  readonly status: NodeStatus;
  /** The engine node type (`agent`, `condition`, …), when known from `node:started`. */
  readonly nodeType?: string;
  /** Wall-clock duration from `node:completed`. */
  readonly durationMs?: number;
  /** The closed error code from `node:failed`. */
  readonly errorCode?: string;
  /** The 1-based node-retry dispatch attempt (present once a retry has occurred). */
  readonly attempt?: number;
}

/**
 * A produced media DELIVERABLE surfaced on a `node:completed` (2.S/D-series, ADR-0042) — the durable
 * `media://sha256-<hex>` HANDLE (never inline bytes), its modality + MIME, and the node that emitted it.
 * The CLI's leaf of the cross-surface "each surface renders a produced media handle" acceptance.
 */
export interface ProducedMediaView {
  readonly nodeId: string;
  readonly handle: string;
  readonly mimeType: string;
  readonly modality: DurableMediaMeta['modality'];
}

export interface RunSummary {
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'paused';
  readonly totalCostMicrocents?: number;
  readonly totalTokens?: { readonly input: number; readonly output: number };
  readonly durationMs?: number;
  /** Present on a failed run — the root-cause error. */
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Present on a paused run — the gate ids the run is parked on. */
  readonly pausedGateIds?: readonly string[];
}

export interface RunViewState {
  readonly runId?: string;
  /** Node ids in first-seen order (stable list ordering for the render). */
  readonly nodeOrder: readonly string[];
  readonly nodes: Readonly<Record<string, NodeView>>;
  /** The node whose token stream is currently shown in the live output region. */
  readonly activeNodeId?: string;
  /** The model producing the active node's tokens (from `agent:token`); reset to `undefined` per node. */
  readonly activeModel: string | undefined;
  /** The active node's streamed token text — bounded to the trailing {@link MAX_TOKEN_CHARS}. */
  readonly activeTokens: string;
  /** Recent compact, secret-free tool-call / tool-result lines — bounded to {@link MAX_TOOL_LINES}. */
  readonly toolLines: readonly string[];
  /** The run-wide cost running total (integer micro-cents — 1e-8 USD; database-schema.md). */
  readonly cumulativeCostMicrocents: number;
  /** The last observed `sequenceNumber`, for gap detection. */
  readonly lastSequenceNumber?: number;
  /** Set once a `sequenceNumber` gap is observed (the live stream is no-drop, so a gap signals a defect). */
  readonly gapDetected: boolean;
  /** Bounded, user-facing warnings (gap, budget, timeout, gate). */
  readonly warnings: readonly string[];
  /** Produced media handles surfaced as nodes complete (2.S) — the run's media deliverables, bounded to the
   *  trailing {@link MAX_PRODUCED_MEDIA}. Handle-only by construction (the engine de-inlines bytes upstream). */
  readonly producedMedia: readonly ProducedMediaView[];
  /** Set once the run reaches a terminal/parked event — drives the final summary panel. */
  readonly summary?: RunSummary;
}

/** Trailing token text kept for display (chars) — older text scrolls out of the active region. */
export const MAX_TOKEN_CHARS = 4000;
/** Recent tool lines kept for display. */
export const MAX_TOOL_LINES = 8;
/** Recent warnings kept for display. */
export const MAX_WARNINGS = 6;
/** Produced media deliverables kept for display — generous (a real run emits a handful) but bounded so a
 *  pathological media-spewing run can't grow the view state without limit; the trailing entries are kept. */
export const MAX_PRODUCED_MEDIA = 50;
/** Trailing logical lines of the active node's token stream shown in the live region (RunApp). */
export const MAX_ACTIVE_TOKEN_LINES = 6;

export function initialRunViewState(): RunViewState {
  return {
    nodeOrder: [],
    nodes: {},
    activeModel: undefined,
    activeTokens: '',
    toolLines: [],
    cumulativeCostMicrocents: 0,
    gapDetected: false,
    warnings: [],
    producedMedia: [],
  };
}

/** Append `line`, keeping only the trailing `max` entries. */
function pushBounded(arr: readonly string[], line: string, max: number): string[] {
  const next = [...arr, line];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Append produced media deliverables, keeping only the trailing {@link MAX_PRODUCED_MEDIA}. */
function appendProducedMedia(
  current: readonly ProducedMediaView[],
  added: readonly ProducedMediaView[],
): ProducedMediaView[] {
  const next = [...current, ...added];
  return next.length > MAX_PRODUCED_MEDIA ? next.slice(next.length - MAX_PRODUCED_MEDIA) : next;
}

/** Append streamed token text, keeping only the trailing {@link MAX_TOKEN_CHARS}. */
function appendTokens(buffer: string, token: string): string {
  const next = buffer + token;
  return next.length > MAX_TOKEN_CHARS ? next.slice(next.length - MAX_TOKEN_CHARS) : next;
}

/** The optional `attempt` field patch — present only when a (1-based) attempt number is known. */
function attemptPatch(attemptNumber: number | undefined): { attempt?: number } {
  return attemptNumber === undefined ? {} : { attempt: attemptNumber };
}

/** Upsert a node (append to `nodeOrder` on first sight), merging `patch` over any existing fields. */
function withNode(
  state: RunViewState,
  nodeId: string,
  patch: Partial<NodeView> & { status: NodeStatus },
): Pick<RunViewState, 'nodeOrder' | 'nodes'> {
  const existing = state.nodes[nodeId];
  const merged: NodeView = { ...existing, nodeId, ...patch };
  return {
    nodes: { ...state.nodes, [nodeId]: merged },
    nodeOrder: existing === undefined ? [...state.nodeOrder, nodeId] : state.nodeOrder,
  };
}

/**
 * Track the monotonic `sequenceNumber` and flag an anomaly. The in-process live stream is a no-drop bounded
 * queue with a strictly increasing `sequenceNumber`, so EITHER a forward gap (`seq > last + 1`, missing
 * events) OR a backward/duplicate step (`seq <= last`, a replay / out-of-order delivery) indicates a defect
 * — both detect + warn (a durable-state resync is deferred; the read side lands with 2.I).
 */
interface SeqTracking {
  /** The seq/gap/warning fields to fold into the next state regardless of whether the event is applied. */
  readonly patch: Pick<RunViewState, 'lastSequenceNumber' | 'gapDetected' | 'warnings'>;
  /** `false` for a backward/duplicate event — record the warning but do NOT apply the (stale) event. */
  readonly apply: boolean;
}

function trackSeq(state: RunViewState, event: RunEvent): SeqTracking {
  const seq = event.sequenceNumber;
  const last = state.lastSequenceNumber;
  if (last !== undefined && seq > last + 1) {
    // A forward gap: events were missed before this one, but THIS event is genuine — apply it.
    return {
      apply: true,
      patch: {
        lastSequenceNumber: seq,
        gapDetected: true,
        warnings: pushBounded(
          state.warnings,
          `event gap: #${last} → #${seq} (some events were not observed)`,
          MAX_WARNINGS,
        ),
      },
    };
  }
  if (last !== undefined && seq <= last) {
    // Backward / duplicate on a monotonic stream — a defect. Keep the high-water mark as `lastSequenceNumber`
    // (advancing to the lower `seq` would mask a later genuine gap), and DON'T apply: re-applying would
    // double a token or let a stale terminal event overwrite the summary.
    return {
      apply: false,
      patch: {
        lastSequenceNumber: last,
        gapDetected: true,
        warnings: pushBounded(
          state.warnings,
          `event out of order: #${seq} after #${last} (ignored)`,
          MAX_WARNINGS,
        ),
      },
    };
  }
  return {
    apply: true,
    patch: { lastSequenceNumber: seq, gapDetected: state.gapDetected, warnings: state.warnings },
  };
}

/** Truncate a single-line summary to keep tool lines compact. Unicode-safe (splits on code points). */
function clip(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = [...oneLine]; // code-point array — never split a surrogate pair mid-character
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : oneLine;
}

/**
 * Reduce an `agent:token` event: append to the active node's buffer (resetting it when the active node
 * switches, e.g. a parallel branch), and defensively ensure the streaming node exists in the list even if a
 * token somehow precedes its `node:started` — otherwise RunApp's `nodes[activeNodeId]` is undefined and the
 * live region hides the tokens. Only upserts when the node is absent, so a real status is never clobbered.
 */
function reduceAgentToken(base: RunViewState, event: AgentTokenEvent): RunViewState {
  const switching = event.nodeId !== base.activeNodeId;
  const ensureNode =
    base.nodes[event.nodeId] === undefined
      ? withNode(base, event.nodeId, { status: 'running' })
      : {};
  return {
    ...base,
    ...ensureNode,
    activeNodeId: event.nodeId,
    activeModel: event.model,
    activeTokens: appendTokens(switching ? '' : base.activeTokens, event.token),
  };
}

/**
 * Reduce one canonical {@link RunEvent} into the next immutable {@link RunViewState}. Pure: no I/O, no
 * mutation of `state`. A token reduce is shallow (only the active buffer changes) so a high token rate
 * stays cheap. Unknown/forward event types fall through (the run-event union is intentionally lenient).
 */
export function reduceRunEvent(state: RunViewState, event: RunEvent): RunViewState {
  const seq = trackSeq(state, event);
  const base: RunViewState = { ...state, ...seq.patch };
  // An out-of-order / duplicate event recorded a warning above but is NOT applied — re-applying a stale
  // event would double a token or let it overwrite a fresher summary.
  if (!seq.apply) {
    return base;
  }

  switch (event.type) {
    case 'run:started':
      return { ...base, runId: event.runId };

    case 'node:started':
      return {
        ...base,
        ...withNode(base, event.nodeId, {
          status: 'running',
          nodeType: event.nodeType,
          ...attemptPatch(event.attemptNumber),
        }),
        activeNodeId: event.nodeId,
        activeModel: undefined,
        activeTokens: '', // a new node's output region starts clean
      };

    case 'agent:token':
      return reduceAgentToken(base, event);

    case 'agent:tool_call':
      return {
        ...base,
        toolLines: pushBounded(base.toolLines, `→ ${event.toolId}`, MAX_TOOL_LINES),
      };

    case 'agent:tool_result': {
      const mark = event.success ? '✓' : '✗';
      const summary = clip(event.outputSummary);
      // Omit the `: <summary>` suffix for an empty summary (no dangling "✓ toolId: ").
      const line =
        summary === '' ? `${mark} ${event.toolId}` : `${mark} ${event.toolId}: ${summary}`;
      return { ...base, toolLines: pushBounded(base.toolLines, line, MAX_TOOL_LINES) };
    }

    case 'agent:file_patch_proposed':
      return {
        ...base,
        toolLines: pushBounded(
          base.toolLines,
          `✎ patch proposed (${event.patches.length} file${event.patches.length === 1 ? '' : 's'})`,
          MAX_TOOL_LINES,
        ),
      };

    case 'cost:updated':
      return { ...base, cumulativeCostMicrocents: event.cumulativeCostMicrocents };

    case 'node:completed': {
      // A media-producing node's output carries durable `media://` handles (the engine de-inlined any bytes at
      // the emit choke point, ADR-0042). Surface each as a deliverable — handle-only, never bytes. `output` is
      // `unknown`; `collectDurableMediaHandles` walks it cycle-safe + deduped, so a text-only node yields [].
      const produced = collectDurableMediaHandles(event.output).map(
        (meta): ProducedMediaView => ({
          nodeId: event.nodeId,
          handle: meta.handle,
          mimeType: meta.mimeType,
          modality: meta.modality,
        }),
      );
      return {
        ...base,
        ...withNode(base, event.nodeId, { status: 'completed', durationMs: event.durationMs }),
        ...(event.cumulativeCostMicrocents === undefined
          ? {}
          : { cumulativeCostMicrocents: event.cumulativeCostMicrocents }),
        ...(produced.length === 0
          ? {}
          : { producedMedia: appendProducedMedia(base.producedMedia, produced) }),
      };
    }

    case 'node:failed':
      return {
        ...base,
        ...withNode(base, event.nodeId, {
          status: 'failed',
          errorCode: event.error.code,
          ...attemptPatch(event.attemptNumber),
        }),
      };

    case 'node:skipped':
      return { ...base, ...withNode(base, event.nodeId, { status: 'skipped' }) };

    case 'node:retrying':
      return {
        ...base,
        // `attemptNumber` is required on node:retrying (positiveInt, not optional) — no guard needed, unlike
        // node:started / node:failed where it is optional.
        ...withNode(base, event.nodeId, { status: 'retrying', attempt: event.attemptNumber }),
        warnings: pushBounded(
          base.warnings,
          `${event.nodeId} retrying after attempt ${event.attemptNumber} (${event.error.code})`,
          MAX_WARNINGS,
        ),
      };

    case 'media_job:submitted':
      return {
        ...base,
        toolLines: pushBounded(
          base.toolLines,
          `⧗ media job (${event.modality}) submitted`,
          MAX_TOOL_LINES,
        ),
      };

    case 'human_gate:paused':
      return {
        ...base,
        warnings: pushBounded(
          base.warnings,
          `gate "${event.gateId}" (${event.gateType}) awaiting input`,
          MAX_WARNINGS,
        ),
      };

    case 'human_gate:resumed':
      return {
        ...base,
        warnings: pushBounded(base.warnings, `gate resumed: ${event.decision}`, MAX_WARNINGS),
      };

    case 'budget:warning':
      return {
        ...base,
        warnings: pushBounded(base.warnings, `budget ${event.thresholdPct}% spent`, MAX_WARNINGS),
      };

    case 'budget:paused':
      return {
        ...base,
        warnings: pushBounded(
          base.warnings,
          `budget cap reached at ${event.nodeId} — run paused`,
          MAX_WARNINGS,
        ),
      };

    case 'run:completed':
      return {
        ...base,
        summary: {
          outcome: 'completed',
          totalCostMicrocents: event.totalCostMicrocents,
          totalTokens: event.totalTokensUsed,
          durationMs: event.durationMs,
        },
        cumulativeCostMicrocents: event.totalCostMicrocents,
      };

    case 'run:failed':
      return {
        ...base,
        summary: {
          outcome: 'failed',
          errorCode: event.error.code,
          errorMessage: event.error.message,
        },
      };

    case 'run:cancelled':
      return { ...base, summary: { outcome: 'cancelled' } };

    case 'run:paused':
      return { ...base, summary: { outcome: 'paused', pausedGateIds: event.gateIds } };

    case 'run:timeout':
      // The engine emits run:timeout then settles the run with a terminal run:failed (run_timeout), which
      // refines this summary with the closed error code. This descriptive summary is the FALLBACK that stands
      // if (only) the timeout event is observed; the warning persists regardless of which arrives.
      return {
        ...base,
        summary: {
          outcome: 'failed',
          errorMessage: `run timed out after ${event.elapsedMs}ms (limit ${event.timeoutMs}ms)`,
        },
        warnings: pushBounded(base.warnings, `run timed out (${event.elapsedMs}ms)`, MAX_WARNINGS),
      };

    default:
      // Forward-compatible: a future RunEvent variant is reflected only in the seq/gap tracking above.
      return base;
  }
}
