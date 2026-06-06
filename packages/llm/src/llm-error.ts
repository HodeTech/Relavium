import type { LlmError, LlmErrorKind, ProviderId } from './types.js';

/**
 * `LlmError` classification — the contract the `FallbackChain` (1.K) narrows on (1.I). Every adapter
 * normalizes its SDK's failures into this one shape *before* crossing the seam, so the engine never
 * sees a vendor error. The classification (retryable vs fatal) is a pure function of `kind`, so the
 * two fields can never disagree. See [error-handling.md](../../../docs/standards/error-handling.md).
 */

/**
 * The four retryable kinds — the fallback chain advances to the next provider on these (with
 * backoff) and records the failed attempt's usage so cost stays accurate. Every other kind is fatal:
 * it stops the chain rather than silently masking a real problem.
 */
export const RETRYABLE_KINDS: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>([
  'rate_limit',
  'overloaded',
  'timeout',
  'transport',
]);

/** Whether a kind is retryable. The single source of truth for `LlmError.retryable`. */
export const isRetryable = (kind: LlmErrorKind): boolean => RETRYABLE_KINDS.has(kind);

/**
 * Map an upstream HTTP status to a kind — the shared baseline every adapter reuses. An adapter
 * refines it with provider-specific nuance (a typed SDK error class, a body error code) before
 * falling back to this.
 */
export function kindFromHttpStatus(status: number): LlmErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'overloaded'; // 5xx — a transient server/overload condition
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  return 'unknown';
}

interface MakeLlmErrorArgs {
  readonly provider: ProviderId;
  readonly kind: LlmErrorKind;
  /** Human-readable and **already redacted** of any secret material (a key, a full prompt). */
  readonly message: string;
  /** Normalized provider/transport code, e.g. 'rate_limit'. */
  readonly code?: string;
  /** Upstream HTTP status, when there was one. */
  readonly status?: number;
  /** Original error, for debugging only — never re-thrown across the seam. */
  readonly cause?: unknown;
}

/**
 * Build a normalized `LlmError`, deriving `retryable` from `kind` so a miswired adapter can't
 * produce an inconsistent pair. Constructs directly (no Zod parse) so it never throws on the error
 * path — the TS types already pin the shape.
 */
export function makeLlmError(args: MakeLlmErrorArgs): LlmError {
  const error: LlmError = {
    kind: args.kind,
    retryable: isRetryable(args.kind),
    provider: args.provider,
    message: args.message,
  };
  if (args.code !== undefined) {
    error.code = args.code;
  }
  if (args.status !== undefined) {
    error.status = args.status;
  }
  if (args.cause !== undefined) {
    error.cause = args.cause;
  }
  return error;
}
