import type { AbortSignalLike } from '@relavium/shared';

import { mediaSupportReason } from '../capabilities.js';
import { UnsupportedCapabilityError } from '../errors.js';
import { LlmProviderError, makeLlmError } from '../llm-error.js';
import { MODEL_PRICING, isCanonicalModelId } from '../pricing.js';
import { LlmMessageSchema, ModelListingSchema } from '../types.js';
import type {
  CapabilityFlags,
  EstimateTokensInput,
  LlmError,
  LlmRequest,
  ModelListing,
  ProviderId,
} from '../types.js';

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

// --- Live model discovery (ADR-0064) — the shared listModels substrate every adapter reuses -------

/**
 * Default per-call bound for a `listModels` probe (ADR-0064 §3) — long enough for a cold, multi-page
 * list, short enough that a stalled provider can never hang a refresh. Mirrors the `validateProviderKey`
 * bounded discipline ([providers.ts](../../../../apps/cli/src/engine/providers.ts)).
 */
export const LIST_MODELS_TIMEOUT_MS = 15_000;

/** Redact every occurrence of `key` from a string — defense-in-depth on the error path (ADR-0064 §3;
 *  mirrors `validateProviderKey`). An empty key is a no-op (splitting on `''` would garble the text). */
export function redactKey(text: string, key: string): string {
  return key.length === 0 ? text : text.split(key).join('••••');
}

/** A finite positive integer, else `undefined` — the "0/absent limit means unknown, so OMIT it" rule
 *  (ADR-0064 §3). Anthropic returns `0` for an unknown `max_input_tokens`; a `null`/missing limit is
 *  likewise unknown. Never stores a `0` limit (the `ModelListing` schema is `.positive()`). */
export function positiveModelInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * True for a plain object (not `null`, not an array) — the per-row shape guard the model-list collect loops
 * apply BEFORE dereferencing a vendor row (ADR-0064 §8, C-fix). A non-object row (e.g. a `null` in the
 * vendor `data` array) is DROPPED as `droppedForShape`, never dereferenced (dereferencing it would throw a
 * `TypeError` that discards the whole provider's fresh list instead of the one bad row).
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Finalize a leniently-built candidate into a validated {@link ModelListing}, or `undefined` if it fails
 * the strict-outbound schema (ADR-0064 §3/§8) — the one boundary that drops a malformed / id-less row
 * WITHOUT throwing, so additive provider drift is absorbed and one bad row degrades a single model, never
 * the whole provider. Each adapter's mapper builds the candidate (which vendor field → which listing field
 * is per-provider) and passes it here.
 */
export function toModelListing(candidate: Record<string, unknown>): ModelListing | undefined {
  const parsed = ModelListingSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The ADR-0064 §8 systemic-drift guard, called by each adapter's `collect` AFTER it has walked every page.
 * It THROWS a classified `bad_request` {@link LlmProviderError} **iff** the vendor returned rows
 * (`rawCount > 0`) but NONE yielded a usable model id (`kept === 0`) AND **every** row was dropped for a
 * broken shape (`droppedForShape === rawCount`, i.e. none was merely content-filtered) — a breaking
 * id-removal / every-row-shape-broken change. The throw (raised INSIDE the `collect` closure so
 * {@link boundedListModels} redacts + cause-strips it) lets §5's per-provider refresh isolation show
 * "last-known", not a silently-empty picker. Non-throw cases (all return a genuine `[]`): a well-formed EMPTY
 * list (`rawCount === 0`); a list whose rows were all CONTENT-filtered but shape-valid (`droppedForShape === 0`);
 * and — the case a `droppedForShape > 0` guard would wrongly trip — a list empty because of content-filtering
 * PLUS one unrelated shape-broken row (`0 < droppedForShape < rawCount`), where the emptiness is explained by
 * the filter, not a systemic break. (When `kept === 0`, no row was deduped — dedup needs a kept row — so
 * `droppedForShape === rawCount` is exactly "no row survived content-filtering", the true drift signal.)
 */
export function assertListModelsShape(
  provider: ProviderId,
  counts: { rawCount: number; kept: number; droppedForShape: number },
): void {
  if (counts.rawCount > 0 && counts.kept === 0 && counts.droppedForShape === counts.rawCount) {
    throw new LlmProviderError(
      makeLlmError({
        provider,
        kind: 'bad_request',
        message: 'model list shape unexpected — no usable model id on any row',
      }),
    );
  }
}

/**
 * Resolve the base {@link LlmError} for a failed {@link boundedListModels} race, BEFORE the final redact +
 * `cause`-strip re-wrap. A timeout wins first; then a pre-classified error (the §8 drift throw, or any
 * adapter-side `LlmProviderError`) passes THROUGH with its own `kind` — never re-run through `classify`
 * (which would flatten a `bad_request` drift throw to `unknown`); otherwise the adapter classifier runs.
 */
function resolveListModelsError(params: {
  readonly provider: ProviderId;
  readonly err: unknown;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  readonly classify: (err: unknown) => LlmError;
}): LlmError {
  const { provider, err, timedOut, timeoutMs, classify } = params;
  if (timedOut) {
    return makeLlmError({
      provider,
      kind: 'timeout',
      message: `model list timed out after ${String(timeoutMs)}ms`,
    });
  }
  if (err instanceof LlmProviderError) {
    return err.llmError;
  }
  return classify(err);
}

/**
 * Run a `listModels` collect bounded + abortable + secret-free (ADR-0064 §3). An internal
 * `AbortController` is threaded to the SDK (so a caller `signal` OR the hard timeout actually cancels the
 * in-flight request), plus a `Promise.race` hard timeout that settles even if the SDK ignores the signal.
 * On failure it throws a classified `LlmProviderError` whose message is **key-redacted** and which carries
 * **no `cause`** (so neither the key nor the raw vendor payload can leak across the seam / into a run
 * event) — the host's per-provider refresh isolation catches it (ADR-0064 §5).
 */
export async function boundedListModels(params: {
  readonly provider: ProviderId;
  readonly key: string;
  readonly signal: AbortSignalLike | undefined;
  /** The adapter's SDK-error classifier (e.g. `anthropicErrorToLlmError`). */
  readonly classify: (err: unknown) => LlmError;
  /** Fetch + map the rows, threading the internal (timeout/abort-linked) signal to the SDK. */
  readonly collect: (signal: AbortSignal) => Promise<ModelListing[]>;
  readonly timeoutMs?: number;
}): Promise<ModelListing[]> {
  const { provider, key, signal, classify, collect, timeoutMs = LIST_MODELS_TIMEOUT_MS } = params;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('listModels timed out'));
    }, timeoutMs);
  });
  const collecting = collect(controller.signal);
  // Attach a no-op handler so a post-timeout rejection (the SDK aborting after the timeout won the race)
  // is not an unhandled rejection; the race still observes the rejection through its own handler.
  collecting.catch(() => undefined);
  try {
    return await Promise.race([collecting, timeout]);
  } catch (err) {
    // Resolve the base error (timeout wins; a pre-classified `LlmProviderError` passes through with its own
    // `kind`), then re-wrap through makeLlmError so scrubSecrets runs again AND redactKey strips the resolved
    // key; never pass `cause` (it could carry the key or the raw vendor payload — ADR-0064 §3).
    const base = resolveListModelsError({ provider, err, timedOut, timeoutMs, classify });
    throw new LlmProviderError(
      makeLlmError({
        provider,
        kind: base.kind,
        message: redactKey(base.message, key),
        ...(base.code !== undefined ? { code: redactKey(base.code, key) } : {}),
        ...(base.status !== undefined ? { status: base.status } : {}),
      }),
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
