/** Fixed privacy diagnostic shared by opening maintenance and session retention (ADR-0098). */
export const CHECKPOINT_DEFERRED =
  'warning: session effect WAL erasure was deferred by a database reader; it will be retried on the next open or session sweep.';
