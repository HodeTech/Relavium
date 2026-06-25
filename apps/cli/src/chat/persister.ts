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

  let createdAt = '';
  let sequenceNumber = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostMicrocents = 0;
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
        // Only a COMPLETED exchange (no error) is persisted; an error turn is rolled back by the engine.
        if (event.error === undefined) {
          if (pendingUserText !== undefined) appendText('user', pendingUserText);
          if (assistantText.length > 0) appendText('assistant', assistantText);
          totalInputTokens += event.tokensUsed.input;
          totalOutputTokens += event.tokensUsed.output;
          deps.store.updateSession(record('active'));
        }
        pendingUserText = undefined;
        assistantText = '';
        return;
      case 'session:cancelled':
        // The session's sole terminal — mark it ended (still resumable from the persisted transcript).
        deps.store.updateSession(record('ended'));
        return;
      default:
        return;
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      createdAt = iso();
      deps.store.createSession(record('active'));
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
