import { formatTimeUntil } from '../notation.js';

/**
 * A deadline's words, in ONE place: the work page's rows, page 1's head and a gate's card all say `expires in 5m` and `expired` by these two
 * functions, so a deadline reads the same wherever it is drawn. A leaf module (it imports only `notation.ts`), so the run card
 * (`run-card-model.ts`), which `home-projection.ts` reaches through `flow-text.ts`, can use it without a cycle.
 */

/**
 * Whether a deadline text names a moment the clock has reached: a deadline AT `nowMs` has passed. The ONE rule behind a deadline's words
 * ({@link expiryLabel}'s `expired`), the red of an overdue row and the overdue mark of the Attention order (`attentionOrder`), so the three
 * cannot disagree at the boundary. No text, or text that is no date, has no deadline to pass.
 */
export function deadlinePassed(expiresAt: string | undefined, nowMs: number): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= nowMs;
}

/** A gate's deadline as urgency text: "expired" once past (the Phase-1 in-process-timer caveat), else "expires …". */
export function expiryLabel(expiresAt: string | undefined, nowMs: number): string | undefined {
  if (expiresAt === undefined) return undefined;
  const deadlineMs = Date.parse(expiresAt);
  if (Number.isNaN(deadlineMs)) return undefined;
  if (deadlinePassed(expiresAt, nowMs)) return 'expired';
  return `expires ${formatTimeUntil(deadlineMs - nowMs)}`;
}
