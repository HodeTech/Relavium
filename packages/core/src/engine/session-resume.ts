/**
 * Session resume (1.Y) — reconstruct an `AgentSession`'s in-flight state from its persisted transcript so a
 * conversation continues after a process restart. Sessions are **directly stored** (ADR-0003 governs *runs*,
 * not sessions), so resume RELOADS rows ({@link SessionStore.loadFull}, 1.X) rather than replaying an event
 * log, and it reuses the run-side idempotency **principle** (1.R): an interrupted, never-completed turn is
 * rolled back — the `sessionId+sequenceNumber` analog of "re-run the incomplete node" — so resume yields only
 * **completed exchanges** and the next turn re-prompts rather than replaying a half turn.
 *
 * Platform-free: it operates only on `@relavium/shared` types (the host loads via `@relavium/db`; the engine
 * never imports it). The projection mirrors `AgentSession`'s cross-turn invariant — the in-flight transcript
 * is **text-only** (the turn core keeps within-turn `tool_use`/`tool_result` internal, and a reasoning
 * `signature` must not span turns, ADR-0030/0039) — so a resumed next turn stays protocol-valid (no orphaned
 * `tool_use`). Full-fidelity history lives durably (1.X) and in an export (1.Z); this is what the model sees next.
 */

import type { LlmMessage } from '@relavium/llm';
import type { AgentSessionRecord, DurableContentPart, SessionMessage } from '@relavium/shared';

/**
 * The reconstructed in-memory state {@link AgentSession.resume} preloads — its `#messages` (in-flight
 * transcript), `#turnCount` (the hard-cap counter), and `#cumulativeCostMicrocents` (the running cost).
 */
export interface SessionResumeState {
  readonly messages: readonly LlmMessage[];
  readonly turnCount: number;
  readonly cumulativeCostMicrocents: number;
}

/** The concatenated `text` parts of a durable content array (non-text parts are dropped). */
function textOf(content: readonly DurableContentPart[]): string {
  return content
    .filter((part): part is Extract<DurableContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/**
 * Project the persisted transcript into the in-flight cross-turn form `AgentSession` continues from:
 * **text-only** `user`/`assistant` messages (mirroring how `AgentSession` builds `#messages` — `system` is
 * the agent prompt, not a turn; `tool` results stay within a turn). An empty-text message is dropped (the
 * same `length > 0` guard the assistant-append uses).
 */
function durableToLlmMessages(messages: readonly SessionMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    const text = textOf(message.content);
    if (text.length === 0) {
      continue;
    }
    out.push({ role: message.role, content: [{ type: 'text', text }] });
  }
  return out;
}

/**
 * Drop a trailing, never-answered `user` turn — the incomplete-turn rollback. A completed exchange ends in
 * an `assistant` message; a transcript ending in `user` means the process died mid-turn, so that turn is not
 * a committed exchange and is re-prompted on resume (the idempotency analog of re-running the incomplete node).
 */
function trimIncompleteTurn(ordered: readonly SessionMessage[]): SessionMessage[] {
  const committed = [...ordered];
  while (committed.length > 0 && committed[committed.length - 1]?.role === 'user') {
    committed.pop();
  }
  return committed;
}

/**
 * Reconstruct the {@link SessionResumeState} from a loaded session record + its transcript (any order). Sorts
 * by `sequenceNumber`, rolls back an incomplete trailing turn, projects to the in-flight transcript, and
 * re-seeds the turn count (completed assistant turns) + the running cost (the record's total). Pure and
 * deterministic — the host passes the result to {@link AgentSession.resume}.
 *
 * NOTE: `turnCount` is the count of **completed** assistant turns; a turn that engaged a provider but failed
 * leaves no committed exchange, so the resumed hard-cap counter is a lower bound (the cap is a safety limit,
 * not exact accounting; AgentSessionRecord carries no turn counter to make it exact).
 */
export function reconstructSessionState(
  record: AgentSessionRecord,
  messages: readonly SessionMessage[],
): SessionResumeState {
  const ordered = [...messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const committed = trimIncompleteTurn(ordered);
  return {
    messages: durableToLlmMessages(committed),
    turnCount: committed.filter((message) => message.role === 'assistant').length,
    cumulativeCostMicrocents: record.totalCostMicrocents,
  };
}
