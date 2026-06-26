import type { AgentDefinition, SessionHandle, SessionStreamHandleEvent } from '@relavium/core';
import type { SessionStore } from '@relavium/db';
import type {
  AgentSessionRecord,
  SessionContext,
  SessionMessage,
  SessionStatus,
} from '@relavium/shared';

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
 * pre-tool preamble is dropped, never the mid-turn `tool_use`/`tool_result` pairs); an **error** turn
 * persists nothing (the engine rolls its user message back, keeping the transcript to completed exchanges).
 * No secret value ever reaches a row (keys ride the keychain; `secret`-typed args are never interpolated).
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
   * on the `(session_id, sequence_number)` UNIQUE index. (Resume also reloads the row rather than inserting,
   * which is the 2.N concern; this is the write-side injection point it needs.)
   */
  readonly initialSequenceNumber?: number;
  /**
   * Running totals to seed the in-memory accumulators from on resume (default `0` for a fresh session). On
   * a 2.N resume the row already carries prior-turn totals; without these seeds the first resumed
   * `turn_completed` flush would write `record('active')` with only the new turn's delta — silently
   * discarding the persisted totals. `totalCostMicrocents` needs seeding too: a zero-cost resumed turn emits
   * no `cost:updated`, so the flush would otherwise reset the row's cost to 0. The 2.N command loads the
   * record via `store.loadFull` and passes its totals here alongside {@link initialSequenceNumber}.
   */
  readonly initialTotalInputTokens?: number;
  readonly initialTotalOutputTokens?: number;
  readonly initialTotalCostMicrocents?: number;
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
  let totalInputTokens = deps.initialTotalInputTokens ?? 0;
  let totalOutputTokens = deps.initialTotalOutputTokens ?? 0;
  let totalCostMicrocents = deps.initialTotalCostMicrocents ?? 0;
  let pendingUserText: string | undefined;
  let assistantText = '';
  let unsubscribe: (() => void) | undefined;
  let started = false;

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
  });

  const appendText = (role: 'user' | 'assistant', text: string): void => {
    const message: SessionMessage = {
      id: deps.uuid(),
      sessionId: deps.sessionId,
      sequenceNumber: sequenceNumber++,
      role,
      content: [{ type: 'text', text }],
      timestamp: iso(),
    };
    deps.store.appendMessage(message);
  };

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
        // Only a COMPLETED exchange (no error) writes MESSAGES — an error turn is rolled back by the engine,
        // keeping the transcript to completed exchanges. But the session COST (the cumulative from
        // cost:updated) is real even for a failed turn — the engine never decrements it — so flush the row
        // UNCONDITIONALLY so a resumed budget governor seeds from the true spend (ADR-0028), not an
        // understated one. (Failed-turn token usage is 0, mirroring the engine, so the token columns are
        // unaffected.)
        // A completed exchange always has a user message (the REPL calls beginUserTurn before sendMessage);
        // gating the whole exchange on it prevents an orphaned assistant row with no preceding user row.
        if (event.error === undefined && pendingUserText !== undefined) {
          appendText('user', pendingUserText);
          if (assistantText.length > 0) appendText('assistant', assistantText);
          totalInputTokens += event.tokensUsed.input;
          totalOutputTokens += event.tokensUsed.output;
        }
        deps.store.updateSession(record('active'));
        pendingUserText = undefined;
        assistantText = '';
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
      // UNIQUE primary key and crash on start. Insert only when the row is absent — an existing row is adopted
      // in place and refreshed by the per-turn updateSession. (chat-resume / 2.N passes the loaded record's
      // running totals via initialTotal* so the first resumed flush carries prior+new, never just the delta.)
      if (deps.store.loadSession(deps.sessionId) === undefined) {
        deps.store.createSession(record('active'));
      }
      unsubscribe = deps.handle.subscribe(onEvent);
    },
    beginUserTurn(text: string): void {
      pendingUserText = text;
      assistantText = '';
    },
    close(): void {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
