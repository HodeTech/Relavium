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
  // 400 bad request · 404 not found · 409 conflict · 413 too large · 422 unprocessable — all fatal.
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 422) {
    return 'bad_request';
  }
  return 'unknown';
}

/**
 * The `Error` a provider's `generate` rejects with, carrying the normalized `LlmError`. The
 * `FallbackChain` (1.K) catches this and narrows on `.llmError` for its retry/fatal decision. A
 * `stream` surfaces the same `LlmError` in an `error` `StreamChunk` instead of throwing.
 */
export class LlmProviderError extends Error {
  readonly llmError: LlmError;

  constructor(llmError: LlmError) {
    super(llmError.message);
    this.name = 'LlmProviderError';
    this.llmError = llmError;
  }
}

interface MakeLlmErrorArgs {
  readonly provider: ProviderId;
  readonly kind: LlmErrorKind;
  /** Human-readable, **redacted of secret material by the caller** (a key, a full prompt). `makeLlmError`
   *  additionally scrubs common secret shapes as a backstop at this one choke point (see `scrubSecrets`). */
  readonly message: string;
  /** Normalized provider/transport code, e.g. 'rate_limit'. */
  readonly code?: string;
  /** Upstream HTTP status, when there was one. */
  readonly status?: number;
  /** Original error, for debugging only — never re-thrown across the seam. */
  readonly cause?: unknown;
}

/**
 * Defense-in-depth secret scrub applied at the one `makeLlmError` choke point. The CALLER (adapter) is
 * still responsible for passing an already-redacted message; this is the **structural backstop** — like
 * the engine's `deInlineMedia` pass, leak-freedom here is an active transform at one boundary, not
 * per-adapter discipline — so a forgotten adapter redaction cannot leak a key / token / credentialed URL
 * across the seam, into a run event, or into a log. It masks the common secret **shapes** seen in
 * practice (a key in the message, a token in a URL query string, credentials in a URL userinfo, a Bearer
 * header); it never alters benign error text. Pure and total: regex replacement only, never throws (the
 * error path must not throw). Asserted by `llm-error.test.ts` (the backstop) and each adapter's
 * secret-safety test (a planted secret → a secret-free surfaced `LlmError`); see security-review.md.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@') // URL userinfo  user:pass@
    .replace(
      /([?&](?:api[-_]?key|key|token|access[-_]?token|auth|password|secret)=)[^&\s#]+/gi,
      '$1[REDACTED]',
    ) // secret in a URL query string
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]') // Authorization: Bearer <token>
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9\-_]{16,}/g, '[REDACTED]') // OpenAI sk-/sk-proj-/sk-svcacct- + Anthropic sk-ant- key prefixes
    .replace(/\bAIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED]'); // Google API key prefix
}

/**
 * Build a normalized `LlmError`, deriving `retryable` from `kind` so a miswired adapter can't
 * produce an inconsistent pair. Constructs directly (no Zod parse) so it never throws on the error
 * path — the TS types already pin the shape. `message`/`code` pass through `scrubSecrets` (the backstop).
 */
export function makeLlmError(args: MakeLlmErrorArgs): LlmError {
  const error: LlmError = {
    kind: args.kind,
    retryable: isRetryable(args.kind),
    provider: args.provider,
    message: scrubSecrets(args.message),
  };
  if (args.code !== undefined) {
    error.code = scrubSecrets(args.code);
  }
  if (args.status !== undefined) {
    error.status = args.status;
  }
  if (args.cause !== undefined) {
    error.cause = args.cause;
  }
  return error;
}
