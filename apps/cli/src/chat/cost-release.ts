import type { SessionStore } from '@relavium/db';

import type { SessionPersister } from './persister.js';
import type { GovernorWiring } from './session-host.js';

/**
 * Clearing the held estimates of a session ([ADR-0074](../../../../docs/decisions/0074-durable-conservative-budget-commitments.md) §1's escape hatch,
 * the user's deliberate decision): the one place the two halves of it are written, so `/cost --release` in a plain chat and the `/cost`
 * popup's confirmed step cannot differ in what they call or in which order.
 *
 * **The order is part of the contract.** The DURABLE columns first (a resumed session seeds its cap from them: clearing only the live
 * governor let a released commitment come straight back on the next `chat-resume`), then the live governor. A durable write that throws
 * leaves the governor as it was, so a failed release never lifts the cap of the running process for a record that still holds it; the
 * governor's own half is a field assignment and cannot fail.
 *
 * **The release keeps a content-free record** ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6): with a `record` source, the durable half appends a `cost_release` row naming the amount it cleared, in the SAME transaction as the
 * clearing, at the slot the session's one sequence owner (its persister) reserved, and only when that amount is above zero. A row that
 * cannot be inserted rolls the release back: the durable half throws, and the governor is not touched.
 *
 * It does not look at whether a turn is running: that is the caller's rule, and a popup asks it again at the moment of the answer (see
 * the `/cost` popup's session). What the two halves do to a turn that is in flight is written at the governor
 * (`BudgetGovernor.releaseConservativeCommitments`): the live reservation of an attempt that has not settled is a separate figure that a
 * release never touches.
 */
export interface ReleaseDeps {
  /** The durable half: the session's per-model rows and its aggregate, zeroed in one transaction. */
  readonly store: Pick<SessionStore, 'releaseSessionConservativeCommitments'>;
  readonly sessionId: string;
  /** The live half; absent when the session has no cap (nothing is held in memory then). */
  readonly governor: Pick<GovernorWiring, 'releaseConservativeCommitments'> | undefined;
  /** Wall-clock milliseconds, stamped on the rows the release touches (production: `Date.now`). */
  readonly now: () => number;
  /**
   * Where the release's record row goes: the session's persister, which owns the sequence. Absent ⇒ the release writes no record (a caller
   * with no persister); the chat's line handler, the one production caller, always passes it.
   */
  readonly record?: Pick<SessionPersister, 'withRecordSlot'>;
}

/** What a release cleared: the durable half's amount (read inside its transaction) and the live governor's (absent with no cap), in micro-cents. */
export interface ReleaseOutcome {
  readonly durable: number;
  readonly live: number | undefined;
}

/** Clear the held estimates: the durable record (with its record row), then the live governor. */
export function releaseHeldEstimates(deps: ReleaseDeps): ReleaseOutcome {
  const ts = deps.now();
  // The store inserts the record row iff it was given a slot AND it cleared more than zero, so that is exactly when the slot is adopted.
  const durable =
    deps.record === undefined
      ? deps.store.releaseSessionConservativeCommitments(deps.sessionId, ts)
      : deps.record.withRecordSlot(
          (slot) => deps.store.releaseSessionConservativeCommitments(deps.sessionId, ts, slot),
          (released) => released > 0,
        );
  const live = deps.governor?.releaseConservativeCommitments();
  return { durable, live };
}
