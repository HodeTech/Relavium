import type { SessionStreamHandleEvent } from '@relavium/core';
import { contextWindowForModel } from '@relavium/llm';
import type { SessionStopReason } from '@relavium/shared';

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
  // The SESSION stop-reason superset — the five LLM `StopReason`s plus `'aborted'` (the EA7 mid-turn abort,
  // ADR-0057); a `session:turn_completed` can carry `'aborted'`, so this mirrors the event field exactly.
  readonly stopReason: SessionStopReason;
  readonly tokensUsed: { readonly input: number; readonly output: number };
  readonly durationMs?: number;
  /** The model that produced the turn's tokens (from the accurate per-attempt `cost:updated.model`, EA2). Set
   *  ONLY when it differs from the session's bound `model` — i.e. a within-turn failover attributed the output to
   *  a fallback model — so a plain turn's summary is unchanged (the footer already shows the bound model). */
  readonly model?: string;
  /** The closed error-taxonomy code (safe to display) — the projection renders this, not the message. */
  readonly errorCode?: string;
  /** The classified error message. `formatTurnSummary` renders it ONLY for the vetted secret-free approval-floor
   *  codes (`tool_denied` / `tool_unavailable`, whose message is a host-supplied label) — other codes' messages
   *  may carry prompt context, so only `errorCode` is shown for them. */
  readonly errorMessage?: string;
}

/** One rendered transcript entry — a user line, a completed assistant turn, or a command-output notice. */
export type TranscriptEntry =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly summary: TurnSummary }
  | { readonly role: 'notice'; readonly text: string };

export interface SessionViewState {
  readonly agentRef?: string;
  readonly model?: string;
  readonly status: SessionViewStatus;
  /** Whether a context compaction (`/compact` or an auto-threshold trigger) is IN FLIGHT (ADR-0062 §7) — set on
   *  `session:compacting`, cleared on every turn/compaction lifecycle terminal (started / turn_started /
   *  turn_completed / cancelled / compacted / trimmed). Drives the labeled "Summarizing…" moment. A MANUAL
   *  `/compact` that FAILS emits no terminal, so the host clears this explicitly when `compact()` settles
   *  (`ChatStoreController.clearCompacting`) — otherwise the flag would latch and a later slash command's busy
   *  render would show a stale spinner; the `turn_started` reset is a belt-and-suspenders backstop. */
  readonly compacting: boolean;
  /** The completed conversation (user lines + completed assistant turns) — append-only and UNBOUNDED by design:
   *  ink `<Static>` tracks already-printed items by the array's length delta, so trimming the head would freeze
   *  its cursor at the cap and silently stop rendering entries past it (see {@link appendTranscript}). */
  readonly transcript: readonly TranscriptEntry[];
  /** The in-flight assistant text — reset per turn AND on each tool call, so it holds the active segment.
   *  Bounded to {@link MAX_LIVE_TOKEN_CHARS} because it is what the LIVE REGION paints on every frame. */
  readonly liveTokens: string;
  /** The SAME active segment, bounded instead by {@link transcriptBound} — the text `reduceTurnCompleted` bakes into
   *  the transcript entry. Separate from {@link liveTokens} because the two answer different questions: how much text
   *  can we afford to re-wrap at 30fps (a few thousand chars), versus how much of the model's answer the user is
   *  allowed to keep (all of it, in the full-screen renderer). 2.6.F Step 6g, ADR-0068 Decision (c). */
  readonly turnText: string;
  /** Whether {@link turnText}'s head was elided to stay within {@link transcriptBound}. */
  readonly turnTextTruncated: boolean;
  /**
   * The RENDERER-INJECTED bound on the transcript bake, per ADR-0068's Decision (c): "the full-screen renderer
   * supplies an effectively-unbounded transcript that its viewport manages, while the inline fallback keeps a
   * trailing-tail bound (it has no viewport)". It lives on the state so `reduceSessionEvent` stays a pure
   * `(state, event)` function — the store sets it once, at construction.
   */
  readonly transcriptBound: number;
  /** Whether the head of `liveTokens` has been elided to stay within {@link MAX_LIVE_TOKEN_CHARS}. The render shows
   *  a leading elision marker so the scroll-out is VISIBLE, not a silent loss (2.5.H). Reset with `liveTokens`. */
  readonly liveTokensTruncated: boolean;
  /** The in-flight turn's streamed reasoning ("thinking") text (EA6, 2.5.H) — the collapsible panel's content.
   *  Unlike `liveTokens`, it is reset only per TURN (started / completed / cancelled), NOT on a tool call, so the
   *  panel accumulates the whole turn's thinking across tool rounds. `''` when the model streamed no reasoning. */
  readonly liveReasoning: string;
  /** Whether the head of `liveReasoning` has been elided to stay within {@link MAX_LIVE_TOKEN_CHARS} — the panel
   *  shows a leading elision marker (parity with `liveTokensTruncated`). Reset with `liveReasoning`. */
  readonly liveReasoningTruncated: boolean;
  /** The in-flight turn's tool calls (annotations), in first-seen order. */
  readonly liveToolCalls: readonly ToolCallView[];
  /** The session-wide running cost, authoritatively stamped onto every `cost:updated`. */
  readonly cumulativeCostMicrocents: number;
  /** The model that produced the IN-FLIGHT turn's tokens, captured from the accurate per-attempt
   *  `cost:updated.model` (EA2, 2.5.H) — the completed turn's summary is attributed to it when it differs from the
   *  bound `model` (a within-turn failover). Required-nullable (like `turnStartedAtMs`) so it resets to `undefined`
   *  between turns under exactOptionalPropertyTypes. */
  readonly activeTurnModel: string | undefined;
  /**
   * The chat-mode turn counter — incremented on **every** `session:turn_completed` (success, failure, OR
   * an EA7 `aborted` turn). This is a monotonic UI display count, distinct from the engine's hard-cap
   * `#turnCount` (which counts only provider-engaged turns); a footer counter wants every attempted turn.
   */
  readonly turnCount: number;
  /** The wall-clock (ms) of the in-flight turn's `session:turn_started`, for the completed-turn duration
   *  (required-nullable, not optional, so it can be reset to `undefined` between turns under
   *  exactOptionalPropertyTypes — mirrors run-view-model's `activeModel`). */
  readonly turnStartedAtMs: number | undefined;
  /** The LAST completed turn's input tokens (ADR-0062 §7) — the numerator of the footer context-fullness
   *  indicator. `undefined` until the first turn completes (a resumed session carries no per-turn seed). */
  readonly lastInputTokens?: number;
  /** The bound model's context window (ADR-0062 §7), looked up ONCE from the pricing catalog on `session:started`
   *  (or the resume seed's model). `undefined` for a custom base-URL model absent from the catalog ⇒ the fullness
   *  indicator is simply not shown (mirroring how a custom model degrades auto-compaction). */
  readonly contextWindowTokens?: number;
  /** The last observed `sequenceNumber`, for gap detection. */
  readonly lastSequenceNumber?: number;
  /** Set once a `sequenceNumber` gap/anomaly is observed (the live stream is no-drop, so a gap is a defect). */
  readonly gapDetected: boolean;
  readonly warnings: readonly string[];
}

/** Trailing assistant token chars kept in the live region (older text scrolls out). A RENDER budget, not a content
 *  one: this buffer is re-wrapped every frame. */
export const MAX_LIVE_TOKEN_CHARS = 4000;

/** The transcript bake bound for the INLINE renderer — the historical behaviour, kept byte-identical. It has no
 *  viewport, so a completed entry goes straight to ink `<Static>` and the terminal's own scrollback. */
export const INLINE_TRANSCRIPT_BOUND = MAX_LIVE_TOKEN_CHARS;

/**
 * The transcript bake bound for the FULL-SCREEN renderer: effectively none. Its viewport windows the transcript, so a
 * long answer costs a wrap (cached per entry) rather than a frame.
 *
 * This is the defect ADR-0068 was chartered to fix. Until 2.6.F Step 6g the bound was a CONSTANT (4000) and a 10 000-
 * character answer landed in the transcript as 4 001 characters — its first 6 000 unscrollable, unselectable, and
 * uncopyable, surviving only in SQLite. The Step-4b-3 amendment's "caps-lift" was a name collision: it delivered the
 * per-entry wrap CACHE, not this.
 */
export const FULLSCREEN_TRANSCRIPT_BOUND = Number.MAX_SAFE_INTEGER;
/** Tool-call annotations kept in the in-flight turn. */
export const MAX_LIVE_TOOL_CALLS = 16;
/** Recent warnings kept for display. */
export const MAX_WARNINGS = 6;

/**
 * Optional header seed for a RESUMED session (2.N): a resumed `AgentSession` lands directly at idle and never
 * re-emits `session:started`, so the view header (the bound agent/model) and the carried-over running totals
 * (prior cost + completed-turn count) would otherwise show empty/zero until the first new turn. The command
 * seeds them from the reconstructed state so the footer reflects the continuing session from the first frame.
 * A fresh session passes no seed and is identical to before.
 */
export interface SessionViewSeed {
  readonly agentRef?: string;
  readonly model?: string;
  readonly cumulativeCostMicrocents?: number;
  readonly turnCount?: number;
}

export function initialSessionViewState(
  seed?: SessionViewSeed,
  transcriptBound: number = INLINE_TRANSCRIPT_BOUND,
): SessionViewState {
  // A resumed session (2.N) seeds the model but never re-emits session:started, so derive the context window here
  // too (ADR-0062 §7) — else a resumed session would show no fullness indicator until the (unrelated) next start.
  const seedWindow = seed?.model === undefined ? undefined : contextWindowForModel(seed.model);
  return {
    // agentRef/model are required-optional under exactOptionalPropertyTypes: spread the key in only when set.
    ...(seed?.agentRef === undefined ? {} : { agentRef: seed.agentRef }),
    ...(seed?.model === undefined ? {} : { model: seed.model }),
    ...(seedWindow === undefined ? {} : { contextWindowTokens: seedWindow }),
    status: 'idle',
    compacting: false,
    transcript: [],
    transcriptBound,
    liveTokens: '',
    liveTokensTruncated: false,
    turnText: '',
    turnTextTruncated: false,
    liveReasoning: '',
    liveReasoningTruncated: false,
    liveToolCalls: [],
    cumulativeCostMicrocents: seed?.cumulativeCostMicrocents ?? 0,
    activeTurnModel: undefined,
    turnCount: seed?.turnCount ?? 0,
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

/**
 * Append streamed text to a bounded live buffer, keeping only the trailing `max` chars and reporting whether the
 * head was elided — so the render can show a VISIBLE elision marker instead of the old silent head-drop (2.5.H).
 * Shared by the `agent:token` (answer) and `agent:reasoning` (thinking) buffers.
 */
function appendBounded(
  buffer: string,
  text: string,
  max: number,
): { readonly text: string; readonly truncated: boolean } {
  const next = buffer + text;
  return next.length > max
    ? { text: next.slice(next.length - max), truncated: true }
    : { text: next, truncated: false };
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

/** Append a UI note to the bounded warnings channel (e.g. an MCP-skipped notice). The caller sanitizes the text. */
export function appendWarning(state: SessionViewState, message: string): SessionViewState {
  return { ...state, warnings: pushBounded(state.warnings, message, MAX_WARNINGS) };
}

/**
 * Append a command-output NOTICE (e.g. `/workflows`, `/cost`) as a transcript entry — it scrolls into the
 * conversation history via ink `<Static>` like a system line, rendered distinctly from a user/assistant turn.
 * The stored text MUST already be sanitized: {@link ChatStoreController.notice} applies `stripTerminalControls`
 * (keeping newlines for multi-line output) before delegating here; a direct caller must do the same.
 * (Unbounded + append-only, like every transcript entry — see {@link appendTranscript}.)
 */
export function appendNotice(state: SessionViewState, text: string): SessionViewState {
  return { ...state, transcript: appendTranscript(state.transcript, { role: 'notice', text }) };
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
    case 'session:started': {
      // Look up the model's context window ONCE (ADR-0062 §7) — the footer fullness denominator. `undefined` for a
      // custom base-URL model absent from the catalog ⇒ the key stays absent (exactOptionalPropertyTypes) ⇒ no indicator.
      const window = contextWindowForModel(event.model);
      return {
        ...base,
        agentRef: event.agentRef,
        model: event.model,
        compacting: false,
        ...(window === undefined ? {} : { contextWindowTokens: window }),
      };
    }

    case 'session:turn_started':
      return {
        ...base,
        status: 'running',
        // Clear any stale compaction moment (a manual `/compact` failure emits no terminal — see the field doc);
        // a new turn is never mid-compaction, so this is the belt-and-suspenders reset.
        compacting: false,
        liveTokens: '',
        liveTokensTruncated: false,
        turnText: '',
        turnTextTruncated: false,
        liveReasoning: '',
        liveReasoningTruncated: false,
        liveToolCalls: [],
        activeTurnModel: undefined,
        turnStartedAtMs: Date.parse(event.timestamp),
      };

    case 'agent:reasoning': {
      // Accumulate the turn's thinking (EA6, 2.5.H). Unlike `liveTokens`, reasoning is NOT reset on a tool call, so
      // the collapsible panel shows the whole turn's reasoning across tool rounds — reset only at the turn boundary.
      const appended = appendBounded(base.liveReasoning, event.text, MAX_LIVE_TOKEN_CHARS);
      return {
        ...base,
        liveReasoning: appended.text,
        liveReasoningTruncated: base.liveReasoningTruncated || appended.truncated,
      };
    }

    case 'agent:token': {
      // TWO accumulators over the same tokens, with different budgets. `liveTokens` is what the live region repaints
      // every frame (cheap, bounded). `turnText` is what the transcript keeps (bounded only by what the RENDERER can
      // hold — unbounded in the full-screen viewport). Before 2.6.F Step 6g there was only the first, and the
      // transcript was baked from it: a long answer lost its head permanently.
      const appended = appendBounded(base.liveTokens, event.token, MAX_LIVE_TOKEN_CHARS);
      const kept = appendBounded(base.turnText, event.token, base.transcriptBound);
      return {
        ...base,
        liveTokens: appended.text,
        // Sticky within the segment: once the head scrolled out, the elision marker stays until the buffer resets.
        liveTokensTruncated: base.liveTokensTruncated || appended.truncated,
        turnText: kept.text,
        turnTextTruncated: base.turnTextTruncated || kept.truncated,
      };
    }

    case 'agent:tool_call':
      // The final assistant text is the segment AFTER the last tool call (mirrors the engine's result.text
      // and the persister), so reset the live buffer here; the tool annotation marks the boundary.
      return {
        ...base,
        liveTokens: '',
        liveTokensTruncated: false,
        turnText: '',
        turnTextTruncated: false,
        liveToolCalls: pushBounded(
          base.liveToolCalls,
          { id: `tc-${event.sequenceNumber}`, toolId: event.toolId, resolved: false },
          MAX_LIVE_TOOL_CALLS,
        ),
      };

    case 'agent:tool_result':
      return { ...base, liveToolCalls: markResolved(base.liveToolCalls, event.toolId) };

    case 'cost:updated':
      // Capture the accurate per-attempt model (EA2). The completed-turn summary attributes to this ONLY when it
      // differs from the bound model (a within-turn failover). We keep the LAST cost:updated of the turn: it is the
      // committed model that produced the final answer — relying on the engine emitting per-attempt cost:updated in
      // order, the last just before session:turn_completed. A multi-model tool-round turn collapses to that final
      // model (an accepted one-line-summary simplification, not per-round attribution).
      return {
        ...base,
        cumulativeCostMicrocents: event.cumulativeCostMicrocents,
        activeTurnModel: event.model,
      };

    case 'session:turn_completed':
      return reduceTurnCompleted(base, event);

    case 'session:cancelled':
      // The session's sole terminal — and the primary cancellation path arrives MID-turn, so clear the
      // in-flight buffers too, else the last rendered frame would show a dangling partial token/tool stream
      // for a turn that never completed.
      return {
        ...base,
        status: 'ended',
        compacting: false,
        liveTokens: '',
        liveTokensTruncated: false,
        turnText: '',
        turnTextTruncated: false,
        liveReasoning: '',
        liveReasoningTruncated: false,
        liveToolCalls: [],
        activeTurnModel: undefined,
        turnStartedAtMs: undefined,
      };

    case 'session:compacting':
      // Context compaction STARTED (ADR-0062 §7) — enter the labeled "Summarizing…" moment. The paired terminal
      // (session:compacted / session:trimmed) clears it; a manual `/compact` failure has no terminal, so the
      // busy-gated render keeps a stale flag invisible until the next session:turn_started clears it.
      return { ...base, compacting: true };

    case 'session:compacted': {
      // The moment is over — clear `compacting`. A MANUAL /compact is noticed by the command itself (its full
      // summary + token deltas); the view surfaces only an AUTOMATIC compaction concisely, so an auto-compaction
      // mid-conversation is never a silent context swap (ADR-0062 §7). Numbers only ⇒ no sanitization needed.
      const noticed =
        event.reason === 'auto-threshold'
          ? appendNotice(
              base,
              `⟳ Context auto-compacted to fit the window — ~${grouped(event.tokensBefore)} → ` +
                `~${grouped(event.tokensAfter)} tokens (summary cost ${grouped(event.tokensUsed.input)} in / ` +
                `${grouped(event.tokensUsed.output)} out).`,
            )
          : base;
      return { ...noticed, compacting: false };
    }

    case 'session:trimmed': {
      // The moment is over — clear `compacting`. A MANUAL /trim is noticed by the command itself; the view
      // surfaces only the AUTO-FALLBACK trim (the deterministic trim the engine degrades to when an
      // auto-compaction summariser failed), so that fallback is never silent (ADR-0062 §5).
      const noticed =
        event.reason === 'auto-fallback'
          ? appendNotice(
              base,
              `✂ Auto-compaction summary failed — trimmed ${event.droppedMessageCount} older message(s) instead ` +
                `(keeping the last ${event.keptMessageCount}).`,
            )
          : base;
      return { ...noticed, compacting: false };
    }

    default:
      // session:exported and any forward-compatible additions: no view change.
      return base;
  }
}

/** Group a token count with thousands separators for a readable notice (`14200` → `14,200`). */
function grouped(n: number): string {
  return Math.round(n).toLocaleString('en-US');
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
  // Attribute the turn to the committed per-attempt model ONLY when it differs from the bound model — a within-turn
  // failover (the footer already shows the bound model, so an unchanged model would be noise). `undefined` model /
  // a zero-egress turn (no cost:updated) shows nothing.
  const attributedModel =
    base.activeTurnModel !== undefined && base.activeTurnModel !== base.model
      ? base.activeTurnModel
      : undefined;
  const summary: TurnSummary = {
    stopReason: event.stopReason,
    tokensUsed: { input: event.tokensUsed.input, output: event.tokensUsed.output },
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(attributedModel === undefined ? {} : { model: attributedModel }),
    ...(event.error === undefined
      ? {}
      : { errorCode: event.error.code, errorMessage: event.error.message }),
  };
  // Bake from `turnText`, NOT `liveTokens`: the latter is the live region's 4000-char render budget, and baking from
  // it is what clipped every long answer before 2.6.F Step 6g. `turnText` carries the renderer's own bound — none, in
  // the full-screen viewport.
  const rawText = base.turnText;
  // Preserve the elision marker into the FINALIZED entry (2.5.H). A completed turn is rendered VERBATIM (ink
  // `<Static>` inline, the viewport in full-screen), so bake the marker in here — else a truncated answer would
  // silently lose its head the instant the turn completes. The durable session record (via the persister, from the
  // raw events) always keeps the FULL text; the marker says "this echo was shortened; see the record".
  const text = base.turnTextTruncated ? `…${rawText}` : rawText;
  // Append an entry for a turn that produced text, that ERRORED, OR that was ABORTED (EA7) — so an Esc during
  // an approval prompt (before any assistant text streamed) still leaves a visible trace ("aborted · …" via the
  // summary), confirming the abort took effect rather than silently clearing the live region. Guard on the RAW
  // text (not the `…`-prefixed display text) so the marker can never fabricate a spurious empty-turn entry.
  const show = rawText.length > 0 || event.error !== undefined || event.stopReason === 'aborted';
  const transcript = show
    ? appendTranscript(base.transcript, { role: 'assistant', text, summary })
    : base.transcript;
  return {
    ...base,
    status: 'idle',
    // A completed turn is never mid-compaction (auto-compaction runs AFTER this event, re-setting `compacting`
    // via its own session:compacting); clear it so the flag never straddles a turn boundary.
    compacting: false,
    turnCount: base.turnCount + 1,
    // Record the just-completed turn's input tokens (ADR-0062 §7) — the footer fullness numerator. SKIP a
    // ZERO-input turn: a pre-egress budget/hard-cap block or an Esc-abort emits `{input:0}` (EA2 carries real
    // usage only when a provider engaged), so `...base` keeps the last FAITHFUL value instead of flashing
    // "0% ctx" (an empty window) exactly when the window is actually full. A real turn (>0) overrides it.
    ...(event.tokensUsed.input > 0 ? { lastInputTokens: event.tokensUsed.input } : {}),
    liveTokens: '',
    liveTokensTruncated: false,
    turnText: '',
    turnTextTruncated: false,
    liveReasoning: '',
    liveReasoningTruncated: false,
    liveToolCalls: [],
    activeTurnModel: undefined,
    turnStartedAtMs: undefined,
    transcript,
  };
}
