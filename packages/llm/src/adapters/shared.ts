import { mediaSupportReason } from '../capabilities.js';
import { UnsupportedCapabilityError } from '../errors.js';
import { MODEL_PRICING, isCanonicalModelId } from '../pricing.js';
import { LlmMessageSchema } from '../types.js';
import type { CapabilityFlags, EstimateTokensInput, LlmRequest, ProviderId } from '../types.js';

/**
 * Shared helpers for the provider adapters — the platform-coupled zone (`src/adapters/*`) that may
 * reference host globals. Kept here so AbortSignal handling lives in one place across the adapters.
 */

/** True for a real `AbortSignal` (the host passes one; it structurally satisfies AbortSignalLike). */
export function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

// --- Context/token helpers (ADR-0062) — the shared defaults behind each adapter's contextLimit/estimateTokens.
// Kept here so all three real adapters agree; an adapter MAY override either with a native tokenizer/limit.

const CHARS_PER_TOKEN = 4; // a rough, provider-agnostic characters→tokens ratio
const MESSAGE_ENVELOPE_CHARS = 8; // per-message role/framing overhead
const NON_TEXT_PART_CHARS = 256; // nominal charge for a non-text part (media handle / tool payload)

/**
 * A provider-agnostic, character-based token estimate for a prospective request (ADR-0062) — the shared
 * default behind each adapter's `estimateTokens`. Deliberately a heuristic: it is a **fallback** the engine
 * uses only before any turn has reported real `usage` (which is authoritative), so its imprecision never
 * drives a live budget or compaction decision. Never throws — an estimate always exists.
 */
export function estimateRequestTokens(input: EstimateTokensInput): number {
  let chars = input.system.length;
  for (const message of input.messages) {
    chars += MESSAGE_ENVELOPE_CHARS;
    for (const part of message.content) {
      chars += part.type === 'text' ? part.text.length : NON_TEXT_PART_CHARS;
    }
  }
  for (const tool of input.tools ?? []) {
    chars += JSON.stringify(tool).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * The model's context window in tokens from the shared pricing catalog (ADR-0062) — the shared default behind
 * each adapter's `contextLimit`. `undefined` for an unrated / custom-base-URL model (the engine then skips
 * auto-compaction rather than guess a window). No cast: the canonical-id guard narrows the index.
 */
export function contextLimitFor(model: string): number | undefined {
  return isCanonicalModelId(model) ? MODEL_PRICING[model].contextWindowTokens : undefined;
}

/**
 * The default ADR-0062 context/token seam methods every adapter shares: `contextLimit` (the catalog window),
 * `managesOwnContext` (`false` — no current provider bounds context itself), and `estimateTokens` (the heuristic
 * fallback; real usage is authoritative). Spread `...CONTEXT_SEAM_DEFAULTS` into an adapter's provider object so
 * the trio lives in one place; an adapter that later gains a native token-count endpoint layers a specialised
 * `estimateTokens` on top (a same-key property AFTER the spread wins).
 */
export const CONTEXT_SEAM_DEFAULTS = {
  contextLimit(model: string): number | undefined {
    return contextLimitFor(model);
  },
  managesOwnContext(): boolean {
    return false;
  },
  estimateTokens(input: EstimateTokensInput): number {
    return estimateRequestTokens(input);
  },
};

/**
 * The per-modality media capability gate (1.AE/1.AF). Every adapter calls this at `generate()`/`stream()`
 * entry, AFTER `assertSupported` and `assertStreamable`. An unsupported modality is thrown as
 * `UnsupportedCapabilityError('media')` with a specific detail string — NEVER silently dropped or
 * flattened (the §1.4 bug class this guard exists to block). DeepSeek's all-false matrix causes every
 * media part to be rejected.
 *
 * Order is deliberate and load-bearing: each message is validated through `LlmMessageSchema` FIRST to
 * activate the superRefine guards (media ceiling/caps, URL gate, MIME-type validation, anti-amplification
 * caps) — so an unknown MIME or an over-ceiling inline payload is a `ZodError` (schema-level), not a
 * capability error. Only then is the per-modality / output-combination gate applied, via the ONE shared
 * {@link mediaSupportReason} predicate that the `FallbackChain` pre-skip (`supportsRequest`) also uses —
 * so the pre-skip verdict can never disagree with this adapter throw. The schema re-parse is
 * O(history-length) per call — deliberately accepted (LLM round-trips dominate; it is the sole seam-side
 * enforcement point).
 */
export function assertMediaCapabilities(
  provider: ProviderId,
  supports: CapabilityFlags,
  req: LlmRequest,
): void {
  for (const message of req.messages) {
    LlmMessageSchema.parse(message);
  }
  const reason = mediaSupportReason(supports, req);
  if (reason !== null) {
    throw new UnsupportedCapabilityError(provider, 'media', reason);
  }
}

/**
 * Reject a non-text `outputModalities` on the STREAMING path (1.AG/[ADR-0046] §4). Inline media-out is
 * delivered ONLY through `generate()` (the in-flight base64 rides `LlmResult.content`); the streaming media
 * triad (`media_start`/`media_delta`/`media_end`) is host-deferred to 1.AH, and the streaming folds drop a
 * provider's media parts — so a `stream()` that requested media output would SILENTLY lose it. Fail loud
 * here instead. The engine routes a media-output turn to `generate()`, so this never fires on the run path;
 * it is a defensive guard for a direct seam consumer. Call it at `stream()` entry, after the media gate.
 */
export function assertNoStreamingMediaOutput(provider: ProviderId, req: LlmRequest): void {
  if (req.outputModalities?.some((modality) => modality !== 'text') === true) {
    throw new UnsupportedCapabilityError(
      provider,
      'media',
      'streaming media output is unsupported — inline media-out is delivered via generate() (ADR-0046 §4)',
    );
  }
}

/**
 * The single-track reasoning-channel id used by the OpenAI/DeepSeek and Gemini streaming folds — those
 * providers emit one reasoning block per response (no concurrent tracks). A provider that interleaves
 * multiple reasoning streams must move to an index-keyed id like the Anthropic adapter (`reasoning-${index}`).
 */
export const REASONING_ID = 'reasoning-0';

/**
 * The Relavium-opaque async media-job id namespace+version, shared by every async generative adapter
 * (Sora `Video.id`, Veo operation `name`, …). The engine persists this token in the durable
 * `media_job:submitted` event and re-delivers it to `pollMediaJob` on resume (ADR-0045 §3 re-attach,
 * never re-submit). An adapter has NO durable store and is rebuilt each process, so the vendor id is
 * reversibly ENCODED into the token (base64url so any vendor id is `:`-split-safe) rather than held in an
 * in-memory `Map` — this IS the "vendor↔opaque map internal" of ADR-0045 §7, realized as a STATELESS
 * bijection. The token is adapter-minted + Relavium-namespaced (NOT the bare vendor op-name / poll-URL),
 * the engine never parses it (I1/ADR-0011), and the (non-secret) resource id is safe to persist. A future
 * format change bumps the version slot (`:2:`). The engine routes `pollMediaJob` by the BOUND provider, so
 * each adapter only ever decodes its own jobs — the shared prefix is collision-safe across providers.
 */
const MEDIA_JOB_PREFIX = 'rlv-mediajob:1:';

/** Mint the opaque media-job id from a vendor job/operation id (base64url-encoded). An empty `vendorId`
 *  is rejected at mint time — it would produce a prefix-only token that {@link decodeMediaJobId} rejects,
 *  breaking the bijection (the adapter call sites already guard, so this is a fail-fast contract assertion). */
export function encodeMediaJobId(vendorId: string): string {
  if (vendorId.length === 0) {
    throw new Error('encodeMediaJobId: vendorId must be non-empty');
  }
  return MEDIA_JOB_PREFIX + Buffer.from(vendorId, 'utf8').toString('base64url');
}

/**
 * Recover the vendor id from an opaque media-job id; `undefined` on any foreign/malformed token (never
 * throws — a throw from `pollMediaJob` is engine-classified as retryable and would loop forever on a
 * structurally-dead token). Round-trip-validated: base64url decoding is lenient (it silently drops invalid
 * chars), so a corrupted/non-canonical payload would otherwise decode to a wrong-but-non-empty vendor id;
 * re-encoding and comparing rejects every such token, so a caller never polls a junk vendor id. Every real
 * minted token round-trips exactly.
 */
export function decodeMediaJobId(jobId: string): string | undefined {
  if (!jobId.startsWith(MEDIA_JOB_PREFIX)) {
    return undefined; // a non-Relavium id or a future rlv-mediajob:2: token
  }
  const payload = jobId.slice(MEDIA_JOB_PREFIX.length);
  if (payload.length === 0) {
    return undefined;
  }
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  if (decoded.length === 0 || encodeMediaJobId(decoded) !== jobId) {
    return undefined;
  }
  return decoded;
}
