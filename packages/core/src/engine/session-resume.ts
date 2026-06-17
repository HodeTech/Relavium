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
 * Drop trailing turns that did not complete — the incomplete-turn rollback, applied to the ALREADY-PROJECTED
 * transcript. After projection the only roles are `user` and text-bearing `assistant`, so a completed exchange
 * ends in `assistant`; any trailing `user` is an unanswered turn — the process died mid-turn, whether **before
 * the assistant replied** or **mid-tool-loop** (which projects away its `tool` / text-less `assistant`
 * tool_call rows and re-exposes the originating `user`). Re-prompting it on resume is the
 * `sessionId+sequenceNumber` idempotency analog of re-running the run-side incomplete node.
 */
function trimTrailingUserTurn(messages: readonly LlmMessage[]): LlmMessage[] {
  const committed = [...messages];
  while (committed.length > 0 && committed[committed.length - 1]?.role === 'user') {
    committed.pop();
  }
  return committed;
}

/**
 * Reconstruct the {@link SessionResumeState} from a loaded session record + its transcript (any order). Sorts
 * by `sequenceNumber`, **projects first** (to the text-only in-flight transcript), then rolls back a trailing
 * unanswered turn, and re-seeds the turn count + the running cost (the record's total). Pure and
 * deterministic — the host passes the result to {@link AgentSession.resume}.
 *
 * Projecting BEFORE trimming is load-bearing: an interrupted mid-tool-loop turn leaves a `tool` / text-less
 * `assistant` tail in the durable record; the projection drops those, so the trailing-`user` rollback then
 * sees and removes the originating unanswered `user` — otherwise it would survive as a dangling turn and the
 * next `sendMessage` would emit two consecutive `user` messages (a non-alternating, provider-rejected request).
 *
 * NOTE: `turnCount` counts the **text-producing** assistant turns that survive projection — one per completed
 * logical exchange (a within-turn tool_call-only assistant row is not double-counted). A turn that engaged a
 * provider but produced no committed text leaves no exchange, so the resumed hard-cap counter is a lower bound
 * (the cap is a safety limit, not exact accounting; AgentSessionRecord carries no turn counter to make it exact).
 */
export function reconstructSessionState(
  record: AgentSessionRecord,
  messages: readonly SessionMessage[],
): SessionResumeState {
  const ordered = [...messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const committed = trimTrailingUserTurn(durableToLlmMessages(ordered));
  return {
    messages: committed,
    turnCount: committed.filter((message) => message.role === 'assistant').length,
    cumulativeCostMicrocents: record.totalCostMicrocents,
  };
}
