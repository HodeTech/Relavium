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

import { markUntrusted, type Untrusted } from '../tools/untrusted.js';

/**
 * The reconstructed in-memory state {@link AgentSession.resume} preloads — its `#messages` (in-flight
 * transcript), `#turnCount` (the hard-cap counter), and `#cumulativeCostMicrocents` (the running cost).
 *
 * Build it via {@link reconstructSessionState}: `messages` must be the **text-only** `user`/`assistant`
 * projection (AgentSession's cross-turn invariant). `resume` preloads these verbatim, so a hand-built state
 * carrying `tool_call`/`tool_result`/`reasoning` parts would be replayed to the provider on the next turn —
 * risking an orphaned `tool_use` or a non-alternating request. Do not assemble one by hand.
 */
export interface SessionResumeState {
  readonly messages: readonly LlmMessage[];
  readonly turnCount: number;
  readonly cumulativeCostMicrocents: number;
  /**
   * The session's durable CONSERVATIVE total ([ADR-0074](../../../../docs/decisions/0074-durable-conservative-budget-commitments.md) §1/§4)
   * — money a provider may already have billed for an attempt that returned no trustworthy usage.
   *
   * Restored ALONGSIDE {@link cumulativeCostMicrocents}, never instead of it: §2 requires both totals back
   * before any resumed work is scheduled, because a cap that has forgotten this figure hands already-owed money
   * back as headroom on the very first turn. It is an ESTIMATE and stays apart from the realized total —
   * `SUM(session_costs.cost_microcents) == total_cost_microcents` is unaffected.
   *
   * `0` for a session written before §4, which is the truth for it: nothing was ever committed.
   */
  readonly conservativeCostMicrocents: number;
  /**
   * The context-compaction **preamble** ([ADR-0062](../../../../docs/decisions/0062-context-compaction-and-cli-history-commands.md))
   * to restore into the resumed session — the summary text of the **newest boundary marker that carries a
   * summary** (a `/compact` marker; a summary-less `/trim` marker never provides one). Absent when the session
   * has never been compacted. `AgentSession.resume` re-injects it into the per-turn system prompt, so a
   * compacted session stays compacted across resume **and** a model reseat (which reuses this same path).
   */
  /**
   * The compaction summary carried across a resume or a reseat, **re-marked untrusted at this boundary**
   * ([ADR-0081](../../../../docs/decisions/0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md) §2).
   *
   * Persistence stores the raw string — the durable row shape is unchanged — and a value does not become
   * trustworthy by having been stored. It was `contextPreamble?: string`; the rename is deliberate, because
   * "preamble" names the system-prompt placement ADR-0081 removes.
   */
  readonly compactionSummary?: Untrusted<string>;
}

/** The concatenated `text` parts of a durable content array (non-text parts are dropped). */
function textOf(content: readonly DurableContentPart[]): string {
  return content
    .filter((part): part is Extract<DurableContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/** The compaction/trim DROP BOUNDARY (ADR-0062): messages at/below the max `droppedThroughSequence` across all
 *  boundary markers are superseded (a later summary-less `/trim` advances it). `-1` ⇒ never compacted. */
function dropBoundaryOf(ordered: readonly SessionMessage[]): number {
  return ordered.reduce(
    (max, m) =>
      m.compaction === undefined ? max : Math.max(max, m.compaction.droppedThroughSequence),
    -1,
  );
}

/**
 * Project the persisted transcript into the SURVIVING real `user`/`assistant` durable ROWS `AgentSession`
 * continues from — the ONE projection both the engine (→ `#messages`) and the host persister (→ the ADR-0062
 * boundary-mapping seed) derive from, so they can never drift (the step-3-review data-loss trap). It: sorts by
 * `sequenceNumber`; keeps only text-bearing `user`/`assistant` rows PAST the compaction boundary (`system`
 * markers + empty-text rows drop — the same `length > 0` guard the assistant-append uses); then rolls back a
 * trailing run of unanswered `user` rows (the process died mid-turn — the `sessionId+sequenceNumber` idempotency
 * analog of re-running the run-side incomplete node). Dropping empty rows BEFORE the trailing-user rollback is
 * load-bearing: an interrupted mid-tool-loop turn projects away its `tool`/text-less rows, re-exposing the
 * originating `user` so the rollback removes it (else the next `sendMessage` would emit two consecutive `user`s).
 */
function projectResumableRows(messages: readonly SessionMessage[]): SessionMessage[] {
  const ordered = [...messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const boundary = dropBoundaryOf(ordered);
  const surviving = ordered.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      m.sequenceNumber > boundary &&
      textOf(m.content).length > 0,
  );
  while (surviving.at(-1)?.role === 'user') surviving.pop();
  return surviving;
}

/**
 * The durable `sequenceNumber`s of the rows a resumed session continues from (ADR-0062) — the SAME projection
 * {@link reconstructSessionState} resumes from, exposed so the host persister seeds its compaction/trim
 * boundary-mapping from an identical view (mirroring the engine's trailing-unanswered-`user` rollback + empty-row
 * drop, not just a role filter — the step-3-review fix that prevents a silent kept-message loss on resume→compact).
 */
export function resumableMessageSequences(messages: readonly SessionMessage[]): number[] {
  return projectResumableRows(messages).map((m) => m.sequenceNumber);
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
  // ADR-0062: honor context-compaction boundary markers (role:'system' rows carrying `compaction`). The DROP
  // BOUNDARY (in `projectResumableRows`) and the PREAMBLE are computed SEPARATELY (never "last-marker-wins" for
  // both): the boundary is the max droppedThroughSequence across ALL markers (a later summary-less `/trim`
  // advances it), while the preamble is the summary of the NEWEST marker that HAS summary text (a `/compact`) —
  // so a later `/trim` advances the boundary but must NOT blank a prior compact's summary.
  const markers = ordered.filter((m) => m.compaction !== undefined);
  let compactionSummary: Untrusted<string> | undefined;
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const summary = textOf(markers[i]?.content ?? []);
    if (summary.length > 0) {
      // Re-marked HERE: this is the reconstruction boundary, and it is the last place the value is a bare
      // string. Everything downstream carries the brand.
      compactionSummary = markUntrusted(summary);
      break;
    }
  }
  // The ONE projection the host persister also seeds from (`resumableMessageSequences`) — no drift.
  const surviving = projectResumableRows(ordered);
  const committed: LlmMessage[] = surviving.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: textOf(m.content) }],
  }));
  return {
    messages: committed,
    turnCount: committed.filter((message) => message.role === 'assistant').length,
    cumulativeCostMicrocents: record.totalCostMicrocents,
    conservativeCostMicrocents: record.totalConservativeMicrocents,
    ...(compactionSummary === undefined ? {} : { compactionSummary }),
  };
}
