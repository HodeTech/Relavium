import { mediaModalityOf } from '@relavium/shared';

import { modelAccepts } from './catalog/lookup.js';
import { UnsupportedCapabilityError } from './errors.js';
import type { CapabilityFlags, LlmRequest, ProviderId } from './types.js';

/**
 * Capability gating (1.D, per-modality at 1.AF) — keeps the common path narrow and honest. A request
 * that needs a feature the provider can't do **fails fast with a typed error rather than being silently
 * dropped**. Provider-specific features with no cross-provider shape (prompt-cache control, thinking
 * budgets, parallel-tool-call toggles) travel through `LlmRequest.providerOptions`, not these flags; the
 * reasoning and media channels are canonical seam shape (ADR-0030/0031). See ADR-0011.
 */

/** One capability flag name. */
export type Capability = keyof CapabilityFlags;

/**
 * The NON-MEDIA capabilities a request requires, given the current request surface. Media is gated
 * per-modality by {@link mediaSupportReason} (it cannot be expressed as a flat `keyof CapabilityFlags`),
 * so it is intentionally absent here — `requiredCapabilities` covers only the flat-flag features
 * (today: `tools`). Streaming is checked separately at `stream()` entry ({@link assertStreamable}).
 */
export function requiredCapabilities(req: LlmRequest): Capability[] {
  const required: Capability[] = [];
  if (req.tools !== undefined && req.tools.length > 0) {
    required.push('tools');
  }
  return required;
}

/**
 * The per-modality media gate (1.AF, ADR-0031/0044) — the ONE shared predicate behind BOTH the
 * `FallbackChain` pre-skip ({@link supportsRequest}) and the adapter-entry `assertMediaCapabilities`,
 * so the pre-skip verdict can never disagree with the adapter throw (no admit-then-hard-fail). Pure,
 * no schema parse. Returns a specific reason string, or `null` if the provider can serve every media
 * part + the requested output combination.
 *
 * An UNKNOWN MIME type returns `null` (not a reason): an unknown MIME is a *schema* concern that
 * `LlmMessageSchema`/`MediaMimeTypeSchema` rejects as a `ZodError` at the adapter entry — so the
 * capability predicate judges only known modalities against the flags and never preempts that schema
 * error (it would also pass the pre-skip, where the un-rehosted request fails the adapter's schema gate).
 */
export function mediaSupportReason(supports: CapabilityFlags, req: LlmRequest): string | null {
  const inputCaps = supports.media.input;
  for (const message of req.messages) {
    const reason = messageMediaReason(inputCaps, message);
    if (reason !== null) return reason;
  }
  return outputCombinationReason(supports, req.outputModalities);
}

/** The first unsupported-modality reason in one message's content (its media + tool_result media), or null. */
function messageMediaReason(
  inputCaps: CapabilityFlags['media']['input'],
  message: LlmRequest['messages'][number],
): string | null {
  for (const part of message.content) {
    const reason = partMediaReason(inputCaps, part);
    if (reason !== null) return reason;
  }
  return null;
}

/** The unsupported-modality reason for ONE content part — its own media, or a tool_result's media. */
function partMediaReason(
  inputCaps: CapabilityFlags['media']['input'],
  part: LlmRequest['messages'][number]['content'][number],
): string | null {
  if (part.type === 'media') {
    return mediaInputReason(inputCaps, part.mimeType);
  }
  // Array.isArray (not `!== undefined`): a null `media` from parsed JSON would otherwise throw on iterate.
  if (part.type === 'tool_result' && Array.isArray(part.media)) {
    return toolResultMediaReason(inputCaps, part.media);
  }
  return null;
}

/** The first unsupported-modality reason among a `tool_result`'s attached media parts, or null. */
function toolResultMediaReason(
  inputCaps: CapabilityFlags['media']['input'],
  media: readonly { readonly mimeType: string }[],
): string | null {
  for (const mediaPart of media) {
    const reason = mediaInputReason(inputCaps, mediaPart.mimeType, ' in tool_result');
    if (reason !== null) return reason;
  }
  return null;
}

/** A single media input part's modality vs the provider's input flags. Unknown MIME ⇒ `null` (schema's job). */
function mediaInputReason(
  inputCaps: CapabilityFlags['media']['input'],
  mimeType: string,
  suffix: string = '',
): string | null {
  const modality = mediaModalityOf(mimeType);
  if (modality === undefined) return null;
  if (!inputCaps[modality]) {
    return `input modality '${modality}' (${mimeType})${suffix} not supported`;
  }
  return null;
}

/**
 * Is the requested output-modality set supported by a model's declared `outputCombinations` (ADR-0031
 * decision #3)? Output capability is a per-model **combination** constraint: the requested set must
 * EXACTLY equal one declared combination — a *closed set*, **not** a subset of the union (a subset would
 * admit the wire-invalid combinations — e.g. Gemini image+audio — the closed set exists to reject). One
 * exception: **`text` is always emittable**, so a request carrying no non-`text` modality is supported by
 * any model (the no-media `[]`-combo models — Anthropic/DeepSeek — declare no combination to match, yet
 * still emit text). This is the **single source of truth** for BOTH the runtime `FallbackChain` pre-skip
 * ({@link outputCombinationReason} / {@link supportsRequest}) and the engine's load-time
 * `validateWorkflowWithCatalog` — so the load-time and runtime verdicts can never diverge (1.AF review H2).
 */
export function isOutputCombinationSupported(
  outputCombinations: readonly (readonly string[])[],
  requested: readonly string[],
): boolean {
  if (!requested.some((modality) => modality !== 'text')) return true; // text-only is always emittable
  // Bidirectional membership at equal length ⇒ the two sets are exactly equal. The reverse inclusion is
  // NOT redundant: a request with a DUPLICATE modality (e.g. ['image','image']) has the same length as a
  // clean combo (['text','image']) and passes forward inclusion alone — the reverse direction rejects it.
  return outputCombinations.some(
    (combo) =>
      combo.length === requested.length &&
      requested.every((modality) => combo.includes(modality)) &&
      combo.every((modality) => requested.includes(modality)),
  );
}

/** Requested `outputModalities` vs exact MEMBERSHIP in `media.outputCombinations` (ADR-0031 decision #3). */
function outputCombinationReason(
  supports: CapabilityFlags,
  outputModalities: LlmRequest['outputModalities'],
): string | null {
  if (outputModalities === undefined) return null;
  return isOutputCombinationSupported(supports.media.outputCombinations, outputModalities)
    ? null
    : `output modalities [${outputModalities.join(', ')}] not a supported output combination`;
}

/**
 * Whether the shipped catalog's per-model verdicts govern this provider's models. `catalogAuthoritative:
 * false` for a custom `base_url` — see `LlmProvider.customEndpoint`.
 */
export interface CatalogAuthority {
  readonly catalogAuthoritative?: boolean;
}

/**
 * Does this MODEL accept tool definitions (`CR-51`)? The catalog's `requestCapabilities.toolCall`, asked only
 * when the request actually carries tools.
 *
 * **Why `toolCall`/`attachment` gate where `temperature`/`structuredOutput` are merely withheld.** The latter
 * two are knobs: a model that rejects them is served correctly by dropping the field — a lost preference, not
 * a changed answer, which is what the adapters already do. These two are not knobs. Withholding tools from a
 * turn that needs them, or dropping the image the question is about, buys a confidently wrong answer at full
 * price; sending them buys a 400. So they gate.
 *
 * `modelAccepts` degrades to *accepted* for a model the catalog cannot describe (a custom `base_url`, a
 * brand-new id), so missing metadata never withholds a capability a model actually has.
 */
function toolCallReason(req: LlmRequest, catalog: CatalogAuthority): string | null {
  if (req.tools === undefined || req.tools.length === 0) return null;
  return modelAccepts(req.model, 'toolCall', catalog)
    ? null
    : `model '${req.model}' does not accept tool definitions`;
}

/**
 * Does this MODEL accept non-text input attachments (`CR-51`)? Asked only when the request actually carries
 * one.
 *
 * **Both media-bearing positions are scanned**, not just the top-level arm: `tool_result.media` is the other
 * one, and the sibling {@link mediaSupportReason} already walks it. Checking only `part.type === 'media'` left
 * the two predicates disagreeing about the same request — the model gate admitting what the provider gate
 * would refuse — which is a paid 400 on exactly the shape this exists to skip.
 */
function attachmentReason(req: LlmRequest, catalog: CatalogAuthority): string | null {
  const carriesMedia = req.messages.some((message) =>
    message.content.some(
      (part) =>
        part.type === 'media' ||
        (part.type === 'tool_result' && Array.isArray(part.media) && part.media.length > 0),
    ),
  );
  if (!carriesMedia) return null;
  return modelAccepts(req.model, 'attachment', catalog)
    ? null
    : `model '${req.model}' does not accept non-text input attachments`;
}

/**
 * The unified pre-skip reason — the flat provider-wide flags, the per-MODEL catalog gate, and the per-modality
 * media gate. `null` ⇒ this provider/model pair can serve the request. Used by the `FallbackChain` skip
 * ({@link supportsRequest}) and, through {@link assertSupported}, by the adapter entry — so the two verdicts
 * cannot disagree, which is the same no-admit-then-hard-fail property `mediaSupportReason` already carries.
 */
export function requestSupportReason(
  supports: CapabilityFlags,
  req: LlmRequest,
  /** Absent ⇒ the official endpoint, where the shipped catalog IS authoritative. */
  catalog: CatalogAuthority = {},
): string | null {
  for (const capability of requiredCapabilities(req)) {
    if (!supports[capability]) return `'${capability}' capability not supported`;
  }
  const toolReason = toolCallReason(req, catalog);
  if (toolReason !== null) return toolReason;
  const attachment = attachmentReason(req, catalog);
  if (attachment !== null) return attachment;
  return mediaSupportReason(supports, req);
}

/**
 * Whether this provider AND this model can serve the request (the `FallbackChain` skip check).
 *
 * No longer a pure function of `CapabilityFlags`: since `CR-51` it also consults the catalog for the
 * request's model id, so its verdict depends on module-global catalog state (the shipped snapshot plus any
 * installed refresh) as well as its arguments.
 */
export function supportsRequest(
  supports: CapabilityFlags,
  req: LlmRequest,
  catalog: CatalogAuthority = {},
): boolean {
  return requestSupportReason(supports, req, catalog) === null;
}

/**
 * Throw `UnsupportedCapabilityError` if the request needs a flat-flag capability the provider lacks, or tool
 * definitions this MODEL rejects (`CR-51`).
 *
 * MEDIA gating is deliberately NOT here — neither the per-modality provider gate nor the per-model attachment
 * gate. Both are performed by `assertMediaCapabilities` at the adapter entry, which runs the seam schema parse
 * FIRST (so an unknown MIME / over-ceiling inline media stays a `ZodError`, not a capability error). The
 * pre-skip's equivalents live in {@link supportsRequest}.
 */
export function assertSupported(
  providerId: ProviderId,
  supports: CapabilityFlags,
  req: LlmRequest,
  catalog: CatalogAuthority = {},
): void {
  for (const capability of requiredCapabilities(req)) {
    if (!supports[capability]) {
      throw new UnsupportedCapabilityError(providerId, capability);
    }
  }
  // The per-MODEL TOOL half (`CR-51`) — a direct seam consumer must get a typed refusal rather than a provider
  // 400, and it reads the same `toolCallReason` the chain pre-skip does, so the two can never disagree.
  //
  // The ATTACHMENT half is deliberately NOT here: it inspects message CONTENT, and the order below this
  // function is load-bearing — `assertMediaCapabilities` runs the seam schema parse FIRST so an unknown MIME
  // or an over-ceiling inline payload stays a `ZodError`. Scanning content here would preempt that and
  // reclassify a schema fault as a capability refusal. It lives in `assertMediaCapabilities` instead, after
  // the parse, which is also where the sibling per-modality gate already is.
  const toolReason = toolCallReason(req, catalog);
  if (toolReason !== null) {
    throw new UnsupportedCapabilityError(providerId, 'tools', toolReason, req.model);
  }
}

/**
 * The per-MODEL ATTACHMENT gate, thrown AFTER the seam schema parse (`CR-51`).
 *
 * Exported for `assertMediaCapabilities` to call at the one place the parse has already run. Kept out of
 * {@link assertSupported} so the documented `ZodError`-first order survives — see that function's comment.
 */
export function assertModelAcceptsAttachments(
  providerId: ProviderId,
  req: LlmRequest,
  catalog: CatalogAuthority = {},
): void {
  const reason = attachmentReason(req, catalog);
  if (reason !== null) {
    throw new UnsupportedCapabilityError(providerId, 'media', reason, req.model);
  }
}

/** Throw if the provider cannot stream — called at `stream()` entry (streaming isn't in the request). */
export function assertStreamable(providerId: ProviderId, supports: CapabilityFlags): void {
  if (!supports.streaming) {
    throw new UnsupportedCapabilityError(providerId, 'streaming');
  }
}
