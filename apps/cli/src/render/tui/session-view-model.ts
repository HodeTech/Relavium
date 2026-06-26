import type { SessionStreamHandleEvent } from '@relavium/core';
import type { StopReason } from '@relavium/shared';

/**
 * The pure, framework-free view model for the `relavium chat` ink REPL (workstream **2.M**) — the session
 * counterpart of {@link reduceRunEvent} (2.E). It reduces the disjoint `session:*` stream (plus the reused
 * in-turn `agent:*` / `cost:updated` bodies) into an immutable {@link SessionViewState} the ink `ChatApp`
 * merely projects, so all the logic (the transcript, the in-flight token/tool buffers, per-turn summaries,
 * cost accumulation, `sequenceNumber` gap detection) is unit-tested here with no TTY and no React.
 *
 * The user's typed text is NOT carried by any event, so the REPL feeds it in via {@link appendUserMessage}
 * (the synthetic `user` transcript entry), exactly as it feeds it to the persister via `beginUserTurn`; the
 * assistant side is reduced from the stream. The LIVE render region is BOUNDED (the token buffer + the
 * in-flight tool-call list) so a high-token-rate turn stays cheap; the completed `transcript`, by contrast, is
 * append-only and UNBOUNDED because ink `<Static>` requires it (see {@link appendTranscript}). Events are
 * never dropped.
 */

/** The REPL-level session status shown in the prompt/footer. */
export type SessionViewStatus = 'idle' | 'running' | 'ended';

/** A tool call annotated in the in-flight turn — `resolved` once its `agent:tool_result` is observed. */
export interface ToolCallView {
  /** A stable per-call render key (derived from the originating event's `sequenceNumber`); two calls to the
   *  same tool in one turn stay distinct, so the view never keys list items by their array index. */
  readonly id: string;
  readonly toolId: string;
  readonly resolved: boolean;
}

/** The per-turn summary shown after a completed assistant turn. */
export interface TurnSummary {
  readonly stopReason: StopReason;
  readonly tokensUsed: { readonly input: number; readonly output: number };
  readonly durationMs?: number;
  /** The closed error-taxonomy code (safe to display) — the projection renders this, not the message. */
  readonly errorCode?: string;
  /** The classified error message — kept for diagnostics, but NOT rendered (it may carry prompt context);
   *  `formatTurnSummary` surfaces only `errorCode`. */
  readonly errorMessage?: string;
}

/** One rendered transcript entry — a user line, or a completed assistant turn with its summary. */
export type TranscriptEntry =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly summary: TurnSummary };

export interface SessionViewState {
  readonly agentRef?: string;
  readonly model?: string;
  readonly status: SessionViewStatus;
  /** The completed conversation (user lines + completed assistant turns) — append-only and UNBOUNDED by design:
   *  ink `<Static>` tracks already-printed items by the array's length delta, so trimming the head would freeze
   *  its cursor at the cap and silently stop rendering entries past it (see {@link appendTranscript}). */
  readonly transcript: readonly TranscriptEntry[];
  /** The in-flight assistant text — reset per turn AND on each tool call, so it holds the active segment. */
  readonly liveTokens: string;
  /** The in-flight turn's tool calls (annotations), in first-seen order. */
  readonly liveToolCalls: readonly ToolCallView[];
  /** The session-wide running cost, authoritatively stamped onto every `cost:updated`. */
  readonly cumulativeCostMicrocents: number;
  /** Completed turns that engaged the provider (success or failure) — the chat-mode turn counter. */
  readonly turnCount: number;
  /** The wall-clock (ms) of the in-flight turn's `session:turn_started`, for the completed-turn duration
   *  (required-nullable, not optional, so it can be reset to `undefined` between turns under
   *  exactOptionalPropertyTypes — mirrors run-view-model's `activeModel`). */
  readonly turnStartedAtMs: number | undefined;
  /** The last observed `sequenceNumber`, for gap detection. */
  readonly lastSequenceNumber?: number;
  /** Set once a `sequenceNumber` gap/anomaly is observed (the live stream is no-drop, so a gap is a defect). */
  readonly gapDetected: boolean;
  readonly warnings: readonly string[];
}

/** Trailing assistant token chars kept in the live region (older text scrolls out). */
export const MAX_LIVE_TOKEN_CHARS = 4000;
/** Tool-call annotations kept in the in-flight turn. */
export const MAX_LIVE_TOOL_CALLS = 16;
/** Recent warnings kept for display. */
export const MAX_WARNINGS = 6;

export function initialSessionViewState(): SessionViewState {
  return {
    status: 'idle',
    transcript: [],
    liveTokens: '',
    liveToolCalls: [],
    cumulativeCostMicrocents: 0,
    turnCount: 0,
    turnStartedAtMs: undefined,
    gapDetected: false,
    warnings: [],
  };
}

/** Append `item`, keeping only the trailing `max` entries. */
function pushBounded<T>(arr: readonly T[], item: T, max: number): T[] {
  const next = [...arr, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Append streamed token text, keeping only the trailing {@link MAX_LIVE_TOKEN_CHARS}. */
function appendTokens(buffer: string, token: string): string {
  const next = buffer + token;
  return next.length > MAX_LIVE_TOKEN_CHARS ? next.slice(next.length - MAX_LIVE_TOKEN_CHARS) : next;
}

/**
 * Append a completed transcript entry. Unbounded + append-only BY DESIGN: ink `<Static>` (chat-ink.tsx) tracks
 * already-printed items by the array's length delta, so trimming the head would freeze its cursor at the cap
 * and silently stop printing every entry past it. The entries are small ({role, text, summary}); a single
 * local chat session's transcript fits comfortably in memory.
 */
function appendTranscript(
  transcript: readonly TranscriptEntry[],
  entry: TranscriptEntry,
): readonly TranscriptEntry[] {
  return [...transcript, entry];
}

/**
 * Add the user's typed text as a `user` transcript entry — the REPL calls this immediately before
 * `sendMessage` (the same point it calls the persister's `beginUserTurn`), since no event carries it.
 */
export function appendUserMessage(state: SessionViewState, text: string): SessionViewState {
  return {
    ...state,
    transcript: appendTranscript(state.transcript, { role: 'user', text }),
  };
}

interface SeqDecision {
  readonly apply: boolean;
  readonly lastSequenceNumber: number;
  readonly gapDetected: boolean;
  readonly warning?: string;
}

/**
 * Track the monotonic per-session `sequenceNumber` and flag an anomaly (mirrors 2.E's `trackSeq`): a forward
 * gap (`seq > last + 1`, missed events) applies the genuine event but warns; a backward/duplicate (`seq <=
 * last`) is a defect — warn and DON'T apply (re-applying would double a token or let a stale terminal land).
 */
function trackSeq(last: number | undefined, seq: number): SeqDecision {
  if (last !== undefined && seq > last + 1) {
    return {
      apply: true,
      lastSequenceNumber: seq,
      gapDetected: true,
      warning: `event gap: #${last} → #${seq} (some events were not observed)`,
    };
  }
  if (last !== undefined && seq <= last) {
    return {
      apply: false,
      lastSequenceNumber: last,
      gapDetected: true,
      warning: `event out of order: #${seq} after #${last} (ignored)`,
    };
  }
  return { apply: true, lastSequenceNumber: seq, gapDetected: false };
}

/**
 * Reduce one fully-stamped {@link SessionStreamHandleEvent} into the next immutable {@link SessionViewState}.
 * Pure: no I/O, no mutation. A token reduce is shallow (only the live buffer changes) so a high token rate
 * stays cheap. An out-of-order/duplicate event records a warning but is not applied.
 */
export function reduceSessionEvent(
  state: SessionViewState,
  event: SessionStreamHandleEvent,
): SessionViewState {
  const seq = trackSeq(state.lastSequenceNumber, event.sequenceNumber);
  const base: SessionViewState = {
    ...state,
    lastSequenceNumber: seq.lastSequenceNumber,
    gapDetected: state.gapDetected || seq.gapDetected,
    ...(seq.warning === undefined
      ? {}
      : { warnings: pushBounded(state.warnings, seq.warning, MAX_WARNINGS) }),
  };
  if (!seq.apply) {
    return base;
  }

  switch (event.type) {
    case 'session:started':
      return { ...base, agentRef: event.agentRef, model: event.model };

    case 'session:turn_started':
      return {
        ...base,
        status: 'running',
        liveTokens: '',
        liveToolCalls: [],
        turnStartedAtMs: Date.parse(event.timestamp),
      };

    case 'agent:token':
      return { ...base, liveTokens: appendTokens(base.liveTokens, event.token) };

    case 'agent:tool_call':
      // The final assistant text is the segment AFTER the last tool call (mirrors the engine's result.text
      // and the persister), so reset the live buffer here; the tool annotation marks the boundary.
      return {
        ...base,
        liveTokens: '',
        liveToolCalls: pushBounded(
          base.liveToolCalls,
          { id: `tc-${event.sequenceNumber}`, toolId: event.toolId, resolved: false },
          MAX_LIVE_TOOL_CALLS,
        ),
      };

    case 'agent:tool_result':
      return { ...base, liveToolCalls: markResolved(base.liveToolCalls, event.toolId) };

    case 'cost:updated':
      return { ...base, cumulativeCostMicrocents: event.cumulativeCostMicrocents };

    case 'session:turn_completed':
      return reduceTurnCompleted(base, event);

    case 'session:cancelled':
      // The session's sole terminal — and the primary cancellation path arrives MID-turn, so clear the
      // in-flight buffers too, else the last rendered frame would show a dangling partial token/tool stream
      // for a turn that never completed.
      return {
        ...base,
        status: 'ended',
        liveTokens: '',
        liveToolCalls: [],
        turnStartedAtMs: undefined,
      };

    default:
      // session:exported and any forward-compatible additions: no view change.
      return base;
  }
}

/** Mark the first unresolved tool call with `toolId` as resolved (a tool_result closes its annotation). */
function markResolved(calls: readonly ToolCallView[], toolId: string): readonly ToolCallView[] {
  let done = false;
  return calls.map((call) => {
    if (!done && call.toolId === toolId && !call.resolved) {
      done = true;
      return { ...call, resolved: true };
    }
    return call;
  });
}

type TurnCompletedEvent = Extract<SessionStreamHandleEvent, { type: 'session:turn_completed' }>;

/**
 * Reduce `session:turn_completed`: count the turn, drop the in-flight buffers, and append the completed
 * assistant entry with its summary. An **error** turn ALWAYS appends an entry (even with no streamed text)
 * so the failure is visible in the transcript; a **successful** turn appends only when it produced text (an
 * empty-text success is a silent no-op, mirroring the engine/persister). `base` already carries the
 * seq-tracking patch from {@link reduceSessionEvent}.
 */
function reduceTurnCompleted(base: SessionViewState, event: TurnCompletedEvent): SessionViewState {
  // A finite, non-negative duration only — guard against a NaN from an unparseable timestamp so a NaN can
  // never reach `durationMs` (and `formatDuration`), keeping the `durationMs?: number` contract strict.
  const rawDuration =
    base.turnStartedAtMs === undefined
      ? Number.NaN
      : Date.parse(event.timestamp) - base.turnStartedAtMs;
  const durationMs = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : undefined;
  const summary: TurnSummary = {
    stopReason: event.stopReason,
    tokensUsed: { input: event.tokensUsed.input, output: event.tokensUsed.output },
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(event.error === undefined
      ? {}
      : { errorCode: event.error.code, errorMessage: event.error.message }),
  };
  const text = base.liveTokens;
  const show = text.length > 0 || event.error !== undefined;
  const transcript = show
    ? appendTranscript(base.transcript, { role: 'assistant', text, summary })
    : base.transcript;
  return {
    ...base,
    status: 'idle',
    turnCount: base.turnCount + 1,
    liveTokens: '',
    liveToolCalls: [],
    turnStartedAtMs: undefined,
    transcript,
  };
}
