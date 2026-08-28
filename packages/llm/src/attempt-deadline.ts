/**
 * The per-attempt provider deadline
 * ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
 * §5–§7).
 *
 * **The mechanism moved; only the LLM-specific default stayed.**
 * [ADR-0085](../../../docs/decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md) §9
 * relocated `openDeadline` to `@relavium/shared`, because the engine needs the identical primitive for a
 * node deadline and a post-abort grace window, and this package exported neither the symbol nor a subpath
 * that could reach it. What is genuinely about LLMs — how long ONE provider attempt may take — is below.
 *
 * The re-exports are not compatibility shims: `FallbackChain` is the seam's own consumer and reads them
 * from here, so the deadline vocabulary stays legible at the layer that uses it.
 */

export {
  openDeadline,
  type AbortControllerLike,
  type DeadlineOutcome,
  type DeadlineScope,
  type SetDeadlineTimer,
} from '@relavium/shared';

/**
 * The default per-attempt deadline, in milliseconds.
 *
 * Stated in code rather than only in prose because a default is part of the decision, and an append-only ADR
 * should not defer its own substance to a mutable document. Generous on purpose: a reasoning model's first
 * token can legitimately be a long way off, and a too-tight default turns a working model into an
 * unexplained failure — a worse outcome than the unbounded wait it replaces.
 *
 * It stays in this package, and that is the line ADR-0085 §9 draws: the deadline MECHANISM is generic, this
 * NUMBER is a statement about provider latency and belongs with the seam that knows about providers.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
