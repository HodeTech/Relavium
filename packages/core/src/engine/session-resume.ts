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
import {
  completedSessionTurns,
  resumableSessionMessages,
  type AgentSessionRecord,
  type SessionContentPart,
  type SessionMessage,
} from '@relavium/shared';

import { markUntrusted, type Untrusted } from '../tools/untrusted.js';

/** One proven completed turn in the text-only, unfolded transcript; end is exclusive. */
export interface CompletedTurnSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The reconstructed in-memory state {@link AgentSession.resume} preloads — its `#messages` (in-flight
 * transcript), `#turnCount` (the hard-cap counter), and `#cumulativeCostMicrocents` (the running cost).
 *
 * Build it via {@link reconstructSessionState}: `messages` must be the **text-only** `user`/`assistant`
 * projection (AgentSession's cross-turn invariant). `resume` preloads these verbatim, so a hand-built state
 * carrying `tool_call`/`tool_result`/`reasoning` parts would be replayed to the provider on the next turn —
 * risking an orphaned `tool_use`. Do not assemble one by hand.
 */
export interface SessionResumeState {
  readonly messages: readonly LlmMessage[];
  /** Legacy text remains in messages without being invented into a completed turn. */
  readonly completedTurnSpans: readonly CompletedTurnSpan[];
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
function textOf(content: readonly SessionContentPart[]): string {
  return content
    .filter((part): part is Extract<SessionContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

export {
  completedSessionTurns,
  resumableMessageSequences,
  resumableTurnBoundarySequences,
} from '@relavium/shared';
export type { CompletedSessionTurn } from '@relavium/shared';

/** Reconstruct only completed surviving turns; empty finals count, interrupted tool loops roll back. */
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
  const surviving = resumableSessionMessages(ordered);
  const turns = completedSessionTurns(ordered);
  const lengths = new Map(
    turns.map((turn) => [turn.user, textOf(turn.terminal.content).length === 0 ? 1 : 2]),
  );
  const completedTurnSpans: CompletedTurnSpan[] = [];
  for (const [index, message] of surviving.entries()) {
    const length = lengths.get(message);
    if (length !== undefined) completedTurnSpans.push({ start: index, end: index + length });
  }
  const committed: LlmMessage[] = surviving.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: textOf(m.content) }],
  }));
  return {
    messages: committed,
    completedTurnSpans,
    turnCount: turns.length,
    cumulativeCostMicrocents: record.totalCostMicrocents,
    conservativeCostMicrocents: record.totalConservativeMicrocents,
    ...(compactionSummary === undefined ? {} : { compactionSummary }),
  };
}
