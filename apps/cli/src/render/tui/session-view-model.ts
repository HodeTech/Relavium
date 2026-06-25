import type { SessionStreamHandleEvent } from '@relavium/core';

/**
 * The pure, framework-free view model for the `relavium chat` ink REPL (workstream **2.M**) — the session
 * counterpart of {@link reduceRunEvent} (2.E). It reduces the disjoint `session:*` stream (plus the reused
 * in-turn `agent:*` / `cost:updated` bodies) into an immutable {@link SessionViewState} the ink `ChatApp`
 * merely projects, so all the logic (the transcript, the in-flight token/tool buffers, per-turn summaries,
 * cost accumulation, `sequenceNumber` gap detection) is unit-tested here with no TTY and no React.
 *
 * The user's typed text is NOT carried by any event, so the REPL feeds it in via {@link appendUserMessage}
 * (the synthetic `user` transcript entry), exactly as it feeds it to the persister via `beginUserTurn`; the
 * assistant side is reduced from the stream. Every derived buffer is BOUNDED so a long, high-token-rate
 * session keeps the render and memory bounded — events are never dropped, only the displayed tail is capped.
 */

/** The REPL-level session status shown in the prompt/footer. */
export type SessionViewStatus = 'idle' | 'running' | 'ended';

/** A tool call annotated in the in-flight turn — `resolved` once its `agent:tool_result` is observed. */
export interface ToolCallView {
  readonly toolId: string;
  readonly resolved: boolean;
}

/** The per-turn summary shown after a completed assistant turn. */
export interface TurnSummary {
  readonly stopReason: string;
  readonly tokensUsed: { readonly input: number; readonly output: number };
  readonly durationMs?: number;
  readonly errorCode?: string;
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
  /** The completed conversation (user lines + completed assistant turns), bounded to the trailing entries. */
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
/** Trailing completed transcript entries kept in state (older ones already printed to the terminal scrollback). */
export const MAX_TRANSCRIPT_ENTRIES = 500;
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
 * Add the user's typed text as a `user` transcript entry — the REPL calls this immediately before
 * `sendMessage` (the same point it calls the persister's `beginUserTurn`), since no event carries it.
 */
export function appendUserMessage(state: SessionViewState, text: string): SessionViewState {
  return {
    ...state,
    transcript: pushBounded(state.transcript, { role: 'user', text }, MAX_TRANSCRIPT_ENTRIES),
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
          { toolId: event.toolId, resolved: false },
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
      return { ...base, status: 'ended' };

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
 * Reduce `session:turn_completed`: count the turn, drop the in-flight buffers, and — on a successful turn —
 * append the completed assistant entry (the final live text) with its summary. An error turn appends an
 * assistant entry only when it produced some text; either way the summary (incl. any `error`) is recorded.
 */
function reduceTurnCompleted(state: SessionViewState, event: TurnCompletedEvent): SessionViewState {
  const durationMs =
    state.turnStartedAtMs === undefined
      ? undefined
      : Math.max(0, Date.parse(event.timestamp) - state.turnStartedAtMs);
  const summary: TurnSummary = {
    stopReason: event.stopReason,
    tokensUsed: { input: event.tokensUsed.input, output: event.tokensUsed.output },
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(event.error === undefined
      ? {}
      : { errorCode: event.error.code, errorMessage: event.error.message }),
  };
  // Show a completed turn when it produced text, OR when it errored (so the failure is visible) — an
  // empty-text successful turn appends nothing, mirroring the engine/persister.
  const text = state.liveTokens;
  const show = text.length > 0 || event.error !== undefined;
  const transcript = show
    ? pushBounded(state.transcript, { role: 'assistant', text, summary }, MAX_TRANSCRIPT_ENTRIES)
    : state.transcript;
  return {
    ...state,
    status: 'idle',
    turnCount: state.turnCount + 1,
    liveTokens: '',
    liveToolCalls: [],
    turnStartedAtMs: undefined,
    transcript,
  };
}
