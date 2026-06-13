/**
 * The untrusted-content brand (1.T) — the compile-time technique
 * [security-review.md §Prompt-injection](../../../../docs/standards/security-review.md#prompt-injection-posture)
 * mandates: a tool result is untrusted DATA the model's caller did not author, never a trusted
 * instruction. The registry wraps every tool result in {@link Untrusted}; the message-assembly layer
 * (1.O) must {@link unwrapUntrusted} it to place it in a `user`/`tool` position — **never** `system` and
 * never string-concatenated into an instruction template. The brand makes the unsafe path
 * unrepresentable rather than relying on per-call-site discipline (the reason it is structural: with N
 * tool call-sites, "remember to wrap it" fails open at the one forgotten site). 1.T owns the marking;
 * 1.O owns the placement.
 */

const UNTRUSTED: unique symbol = Symbol('relavium.untrusted');

/** A value flagged untrusted. Consumers cannot read the payload without {@link unwrapUntrusted}. */
export interface Untrusted<T> {
  readonly [UNTRUSTED]: true;
  readonly value: T;
}

/** Wrap a value as untrusted. */
export function markUntrusted<T>(value: T): Untrusted<T> {
  return { [UNTRUSTED]: true, value };
}

/**
 * Unwrap an untrusted value — an explicit acknowledgement that the caller is placing it in a data
 * position (`user`/`tool`), never `system`.
 */
export function unwrapUntrusted<T>(wrapped: Untrusted<T>): T {
  return wrapped.value;
}

/** Type guard for an untrusted wrapper. */
export function isUntrusted(value: unknown): value is Untrusted<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[UNTRUSTED] === true
  );
}
