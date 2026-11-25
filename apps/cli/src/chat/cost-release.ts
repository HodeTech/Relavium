import type { SessionStore } from '@relavium/db';

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
}

/** What a release cleared: the durable half's amount (read inside its transaction) and the live governor's (absent with no cap), in micro-cents. */
export interface ReleaseOutcome {
  readonly durable: number;
  readonly live: number | undefined;
}

/** Clear the held estimates: the durable record, then the live governor. */
export function releaseHeldEstimates(deps: ReleaseDeps): ReleaseOutcome {
  const durable = deps.store.releaseSessionConservativeCommitments(deps.sessionId, deps.now());
  const live = deps.governor?.releaseConservativeCommitments();
  return { durable, live };
}
