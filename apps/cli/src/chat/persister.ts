import {
  resumableMessageSequences,
  type AgentDefinition,
  type SessionHandle,
  type SessionStreamHandleEvent,
} from '@relavium/core';
import type { SessionStore } from '@relavium/db';
import type { AgentSessionRecord, SessionContext, SessionStatus } from '@relavium/shared';

import { deriveSessionTitle } from './session-title.js';

/**
 * Write-side session persistence for `relavium chat` (2.M) — the CLI counterpart of the run-history writer.
 * `AgentSession` (the engine class, 1.V) keeps its transcript **in memory** and persists nothing; this
 * persister durably records the session + its transcript to `history.db` so a later `relavium chat-resume`
 * (2.N) can reload it via {@link reconstructSessionState}. It is **surface-driven**: it subscribes the
 * {@link SessionHandle} stream for the assistant's reply and totals, and the REPL feeds the user's text via
 * {@link SessionPersister.beginUserTurn} (the user message is the one thing the event stream does not carry).
 *
 * Persistence mirrors `AgentSession`'s own `#messages` exactly so a reconstructed transcript is faithful:
 * each **completed** turn persists the user message + the **text-only** assistant reply (the final
 * `result.text`, captured by accumulating `agent:token` and resetting on each `agent:tool_call` so a
 * pre-tool preamble is dropped, never the mid-turn `tool_use`/`tool_result` pairs); an **error** turn AND a
 * mid-turn **aborted** turn (EA7, `stopReason:'aborted'`, ADR-0057) persist **no messages** (the engine rolls
 * the user message back, keeping the transcript to completed exchanges) — though the real session COST is
 * still flushed for both. No secret value ever reaches a row (keys ride the keychain; `secret`-typed args
 * are never interpolated).
 */

export interface SessionPersisterDeps {
  readonly store: SessionStore;
  readonly handle: SessionHandle;
  readonly sessionId: string;
  /** The bound agent — frozen into `agent_snapshot` for reproducible resume/export; its `id` is the slug. */
  readonly agent: AgentDefinition;
  /** The session context (working dir + fs-scope tier), frozen into the row. */
  readonly context: SessionContext;
  /** Wall-clock in ms (injectable for tests; `Date.now` in production). */
  readonly now: () => number;
  /** Process-unique id source for each persisted message (injectable; `randomUUID` in production). */
  readonly uuid: () => string;
  /**
   * The first `sequenceNumber` this persister assigns (default `0`). A fresh session starts at 0; the 2.N
   * resume path seeds it past the persisted `MAX(sequence_number)` so a continued session does not collide
   * on the `(session_id, sequence_number)` UNIQUE index. This is caller-provided because the next sequence
   * number lives in the messages, not on the session row — unlike the running totals, which {@link
   * SessionPersister.start} hydrates automatically from the adopted row.
   */
  readonly initialSequenceNumber?: number;
}

export interface SessionPersister {
  /** Insert the session row and subscribe the stream. Call once, before the first turn. Idempotent-guarded. */
  start(): void;
  /** Record the user's text for the in-flight turn — the REPL calls this immediately before `sendMessage`. */
  beginUserTurn(text: string): void;
  /** Unsubscribe from the stream (REPL teardown). The persisted session remains resumable. */
  close(): void;
}

export function createSessionPersister(deps: SessionPersisterDeps): SessionPersister {
  const iso = (): string => new Date(deps.now()).toISOString();

  // Frozen at persister construction (≈ session start) — the row's creation time never changes, so it is a
  // const and never the `''` sentinel a pre-start record() would otherwise carry into the schema.
  const createdAt = iso();
  let sequenceNumber = deps.initialSequenceNumber ?? 0;
  // Seeded from 0 for a fresh session; on resume start() hydrates these from the adopted row (see start()).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostMicrocents = 0;
  let pendingUserText: string | undefined;
  let assistantText = '';
  let unsubscribe: (() => void) | undefined;
  let started = false;
  // ADR-0062: the ascending `sequenceNumber`s of the REAL (`user`/`assistant`) transcript rows — used to map a
  // compaction/trim event's `keptMessageCount` (an in-memory count) to the durable `droppedThroughSequence`
  // boundary. It EXCLUDES `system` boundary-marker rows (a naive "last N durable rows" would miscount once a
  // prior marker is interleaved — the step-1-review trap). Seeded from the durable transcript on resume.
  const realMessageSeqs: number[] = [];

  /** Append a REAL transcript row + record its sequence for the boundary mapping. (Per-message `modelId`
   *  attribution — ADR-0059 — is DEFERRED to Phase 2.6.C: `session_messages.model_id` is a FK to
   *  `model_catalog.id` (a UUID), so it needs a model-string→catalog-id resolution the cost breakdown will own.) */
  const appendText = (role: 'user' | 'assistant', text: string): void => {
    const seq = sequenceNumber++;
    realMessageSeqs.push(seq);
    deps.store.appendMessage({
      id: deps.uuid(),
      sessionId: deps.sessionId,
      sequenceNumber: seq,
      role,
      content: [{ type: 'text', text }],
      timestamp: iso(),
    });
  };

  /**
   * Append an append-only compaction/trim boundary MARKER row (ADR-0062): `role:'system'`, the summary text
   * (empty for a `/trim`), and the durable `droppedThroughSequence` mapped from `keptMessageCount` over the
   * ROLE-FILTERED real-message sequences (never the raw row count). Returns `false` when there is nothing to
   * drop (fewer real rows than kept — no marker written). The marker's own seq is NOT a real-message seq.
   */
  const appendMarker = (summary: string, keptMessageCount: number): boolean => {
    if (keptMessageCount >= realMessageSeqs.length) return false; // nothing older to supersede
    const droppedThroughSequence = realMessageSeqs[realMessageSeqs.length - keptMessageCount - 1];
    if (droppedThroughSequence === undefined) return false;
    deps.store.appendMessage({
      id: deps.uuid(),
      sessionId: deps.sessionId,
      sequenceNumber: sequenceNumber++,
      role: 'system',
      content: summary.length > 0 ? [{ type: 'text', text: summary }] : [],
      compaction: { droppedThroughSequence },
      timestamp: iso(),
    });
    return true;
  };
  // Derived from the FIRST user message so the Home list shows a readable label (2.5.B). Set once; a resumed
  // session hydrates the existing title in start() so a later message never overwrites it.
  let title: string | undefined;

  const record = (status: SessionStatus): AgentSessionRecord => ({
    id: deps.sessionId,
    agentSlug: deps.agent.id,
    agentSnapshot: deps.agent,
    context: deps.context,
    status,
    totalInputTokens,
    totalOutputTokens,
    totalCostMicrocents,
    createdAt,
    updatedAt: iso(),
    ...(title === undefined ? {} : { title }),
    // NOTE: the session-level `modelId` (ADR-0059) is DEFERRED with the per-message attribution (see `appendText`):
    // `agent_sessions.model_id` is a FK to `model_catalog.id` (a UUID), not the raw model string, so populating it
    // needs the same catalog resolution the 2.6.C cost breakdown will own. Left NULL until then (like run history).
  });

  const onEvent = (event: SessionStreamHandleEvent): void => {
    switch (event.type) {
      case 'agent:token':
        assistantText += event.token;
        return;
      case 'agent:tool_call':
        // The final assistant message is the text AFTER the last tool round-trip (mirrors what the engine
        // stores as result.text), so a pre-tool preamble is discarded on each tool call.
        assistantText = '';
        return;
      case 'cost:updated':
        // The sink stamps the session-wide running total here; the latest value is the session's cost.
        totalCostMicrocents = event.cumulativeCostMicrocents;
        return;
      case 'session:turn_completed':
        // Only a COMPLETED exchange writes MESSAGES — both an ERROR turn AND an ABORTED turn (EA7,
        // `stopReason:'aborted'`, ADR-0057) are rolled back by the engine (`#messages.pop()`), so persisting
        // their rows would orphan a user message with no in-memory counterpart on chat-resume. Gating on
        // BOTH (`error === undefined && stopReason !== 'aborted'`) keeps the durable transcript to completed
        // exchanges, matching the engine. But the session COST (the cumulative from cost:updated) is real
        // even for a failed/aborted turn — the engine never decrements it — so flush the row UNCONDITIONALLY
        // so a resumed budget governor seeds from the true spend (ADR-0028), not an understated one. The
        // token COLUMNS, by contrast, are NOT accumulated on a non-persisted turn (gated with the messages).
        // (EA2/ADR-0055 delivers a real, non-zero `tokensUsed` on a failed/aborted turn, but those tokens
        // belong to a rolled-back exchange and must not inflate the session-wide token totals; only the cost,
        // from `cost:updated`, is kept.) A completed exchange always has a user message (the REPL calls
        // beginUserTurn before sendMessage); gating the whole exchange on it prevents an orphaned assistant
        // row with no preceding user row.
        if (
          event.error === undefined &&
          event.stopReason !== 'aborted' &&
          pendingUserText !== undefined
        ) {
          // Derive the title HERE (not in beginUserTurn) — from the FIRST user message of a COMPLETED exchange of
          // a titleless session, so an aborted/errored earlier turn never labels the row. A blank message yields
          // undefined, so the next non-blank completed message becomes the title; a resumed session keeps its own.
          title ??= deriveSessionTitle(pendingUserText);
          appendText('user', pendingUserText);
          if (assistantText.length > 0) appendText('assistant', assistantText);
          totalInputTokens += event.tokensUsed.input;
          totalOutputTokens += event.tokensUsed.output;
        }
        deps.store.updateSession(record('active'));
        pendingUserText = undefined;
        assistantText = '';
        return;
      case 'session:compacted':
        // ADR-0062: write the append-only boundary marker (summary + role-filtered droppedThroughSequence) and
        // add the summariser's REAL token usage to the totals (the cost microcents already flowed via
        // cost:updated → totalCostMicrocents; flush the row to persist both). Nothing durable is deleted.
        appendMarker(event.summary, event.keptMessageCount);
        totalInputTokens += event.tokensUsed.input;
        totalOutputTokens += event.tokensUsed.output;
        deps.store.updateSession(record('active'));
        return;
      case 'session:trimmed':
        // A deterministic /trim — a summary-less boundary marker, no cost. Flush the row (updatedAt) after.
        appendMarker('', event.keptMessageCount);
        deps.store.updateSession(record('active'));
        return;
      case 'session:cancelled':
        // The session's sole terminal — mark it ended (still resumable from the persisted transcript), then
        // self-detach so the bus listener does not leak if the REPL's close() is skipped on an early exit.
        deps.store.updateSession(record('ended'));
        unsubscribe?.();
        unsubscribe = undefined;
        return;
      default:
        return;
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      // A resumed session's row already exists (the prior process inserted it); re-INSERTing would hit the
      // UNIQUE primary key and crash on start. Insert only when the row is absent. When it exists (resume),
      // ADOPT it and hydrate the running totals from it BEFORE any turn flushes — otherwise the first resumed
      // `turn_completed` would write `record('active')` with only the new turn's delta, silently discarding the
      // persisted totals (cost too: a zero-egress resumed turn emits no `cost:updated`, so without the seed the
      // flush would reset the row's cost to 0).
      const existing = deps.store.loadSession(deps.sessionId);
      if (existing === undefined) {
        deps.store.createSession(record('active'));
      } else {
        totalInputTokens = existing.totalInputTokens;
        totalOutputTokens = existing.totalOutputTokens;
        totalCostMicrocents = existing.totalCostMicrocents;
        title = existing.title; // a resumed session keeps its original title — never re-derived from a new message
        // ADR-0062: seed the real-message sequences from the SAME projection the engine resumes from
        // (`resumableMessageSequences` — past the compaction boundary, empty-row-dropped, trailing-unanswered-
        // `user` rolled back), NOT a bare role filter. A role-only seed would include a rolled-back trailing
        // `user` the engine dropped, making the next compaction's boundary off-by-one → a silent kept-message
        // loss (the step-3 review data-loss trap). One shared projection ⇒ the host + engine can never drift.
        realMessageSeqs.push(...resumableMessageSequences(deps.store.loadMessages(deps.sessionId)));
      }
      unsubscribe = deps.handle.subscribe(onEvent);
    },
    beginUserTurn(text: string): void {
      // Only STAGE the user text; the title is derived when (and if) the exchange COMPLETES + persists (see
      // `session:turn_completed`). Deriving it here would stamp the session row with a title from an ABORTED /
      // errored first turn whose message rows are rolled back — a label with no transcript behind it.
      pendingUserText = text;
      assistantText = '';
    },
    close(): void {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
