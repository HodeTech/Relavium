import { z } from 'zod';

import { nonEmptyString, nonNegativeInt, positiveInt } from './common.js';
import type { LlmProviderId, MediaModality } from './constants.js';

/**
 * Cross-package runtime contract types the `@relavium/llm` seam — and, later, the session
 * message schemas — build on. They live in `@relavium/shared`, the base of the dependency graph
 * (`shared → llm → core`), so the seam can re-export `ContentPart` without `@relavium/shared`
 * ever importing from `@relavium/llm` (which would invert the package dependency). See
 * [ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md).
 *
 * The multimodal media shapes (`MediaSource`, the `media` arm, the durable fork,
 * `INLINE_MEDIA_CEILING`, the `MediaStore`/`deInlineMedia` contracts) are the ADR-0031 seam-shape
 * amendment — **shape only at 1.AD; behavior lands with 1.AE–1.AH**. Their canonical write-up is
 * [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md).
 */

/* ------------------------------------------------------------------------------------------------
 * Media constants (ADR-0031). Platform-free: every media carrier below is a string.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The canonical content-addressed `MediaStore` handle form: `media://sha256-<64 lowercase hex>`.
 * The hash IS the integrity checksum (no separate `checksum` field anywhere — Y3 amendment), and
 * validating the form here keeps bytes structurally out of every `ref`/`partialRef` position.
 */
export const MEDIA_HANDLE_PATTERN = /^media:\/\/sha256-[0-9a-f]{64}$/;

/**
 * Per-modality ceiling on **decoded** bytes for the in-flight `base64` carrier (ADR-0031 §tier
 * policy). Video and document (PDF) are **never** inline — always a handle (the worst
 * leak/amplification surfaces; deliberately below even Gemini's inline-video allowance). The
 * numeric image/audio values are tunable constants, not frozen shape (design doc §11 OQ4).
 */
export const INLINE_MEDIA_CEILING = {
  image: 256 * 1024,
  audio: 256 * 1024,
  video: 0,
  document: 0,
} as const satisfies Record<MediaModality, number>;

/**
 * Per-message anti-amplification caps (ADR-0031 §Guardrails): a message may carry at most
 * `maxPartsPerMessage` media parts and at most `maxInlineBytesPerMessage` **decoded** inline
 * (base64) bytes in total — the per-part ceiling alone would admit hundreds of individually-legal
 * parts. Enforced at the seam ingestion boundary (`LlmMessageSchema` in `@relavium/llm`), so there
 * is no cap-less window between the shape landing (1.AD) and capability-gating (1.AF) — B4.
 * Values are tunable constants, not frozen shape.
 */
export const MEDIA_MESSAGE_CAPS = {
  maxPartsPerMessage: 16,
  maxInlineBytesPerMessage: 2 * 1024 * 1024,
} as const;

/**
 * The `url` media carrier landing gate (ADR-0031 §Reserved shape): the SSRF range-primitive has
 * landed (1.AE — `extractHttpsHost`, `isPrivateOrLocalHost`, `urlHasCredentials`), so URL sources
 * are now accepted at the seam boundary. The policy half (literal format + credential + range-block
 * checks) lives in `refineInFlightMediaPart`; the mechanism half (DNS resolve + connect-by-validated-IP
 * + per-hop redirect re-validation) belongs to the host-side `EgressCapability.fetch`.
 */
export const MEDIA_URL_SOURCE_ENABLED: boolean = true;

/* ------------------------------------------------------------------------------------------------
 * Media helpers (pure, platform-free)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Derive a part's modality from its MIME type (ADR-0031 decision #1: modality is the MIME prefix,
 * never a second stored field). `application/pdf` is the `document` modality (A2 — distinct from
 * `image`); anything outside the four known modalities is `undefined`, which boundary refines
 * treat as fail-closed unsupported.
 */
export function mediaModalityOf(mimeType: string): MediaModality | undefined {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) {
    return 'image';
  }
  if (lower.startsWith('audio/')) {
    return 'audio';
  }
  if (lower.startsWith('video/')) {
    return 'video';
  }
  if (lower === 'application/pdf') {
    return 'document';
  }
  return undefined;
}

/**
 * A bare RFC-2045 `type/subtype` MIME type, bounded at 255 chars. The bound is load-bearing, not
 * cosmetic: `mimeType` is interpolated into validation error messages, and an unbounded value
 * would turn the rejection MESSAGE into a bytes-smuggling channel into the very logs/events the
 * media guardrails exist to keep bytes out of (I3). Parameters (`; charset=…`) are rejected —
 * providers exchange bare types; modality derivation needs only the prefix. Exported so EVERY
 * mimeType position (the media arms here, `media_start` in `@relavium/llm`) shares the one bound.
 */
export const MediaMimeTypeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+$/, 'must be a bare type/subtype MIME type');

/** Standard base64 (RFC 4648 §4, with padding): the only inline-bytes encoding the seam admits. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The decoded byte count of a base64 string, or `undefined` when the string is not valid padded
 * base64. The ceiling/caps bound **decoded** bytes (a 256 KB ceiling is ~341 KB of base64 string),
 * so every cap comparison goes through this one accounting.
 */
export function decodedBase64ByteLength(data: string): number | undefined {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    return undefined;
  }
  let padding = 0;
  if (data.endsWith('==')) {
    padding = 2;
  } else if (data.endsWith('=')) {
    padding = 1;
  }
  return (data.length / 4) * 3 - padding;
}

/**
 * A `data:[<mediatype>][;attr=value…];base64,` URI — the other way raw media bytes hide inside an
 * opaque string. RFC 2397 makes the mediatype optional and allows any number of `;attr=value`
 * parameters before `;base64`, so the scan matches `[^,]*` (anything up to the payload comma) —
 * a narrower mediatype-only form would let `data:image/png;name=x;base64,…` evade every backstop.
 */
const DATA_URI_BASE64_PATTERN = /^data:[^,]*;base64,/i;

/**
 * Raw binary in an opaque position (a typed array, `DataView`, `ArrayBuffer`, or
 * `SharedArrayBuffer` — all ES built-ins, so the check stays platform-free) IS media bytes by
 * definition: fail closed rather than walk it (`Object.values` over a multi-MB typed array would
 * also be an OOM hazard). `SharedArrayBuffer` is typeof-guarded because hosts may hide it
 * (browser COOP/COEP gating) even though its lib type always exists.
 */
function isBinaryBuffer(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
  );
}

/** A plain string-keyed record — the cast-free narrowing the deep scan walks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical in-flight base64 carrier shape, found loose inside an opaque value. */
function isCanonicalBase64Source(record: Record<string, unknown>): boolean {
  return record['kind'] === 'base64' && typeof record['data'] === 'string';
}

/**
 * One node of the deep scan: `true` when the object itself carries inline bytes (a binary buffer
 * or a canonical base64 source), otherwise its children — array items, `Map` keys+values, `Set`
 * values, record values — are queued onto `stack` for the caller's loop. Split out of
 * `containsInlineMediaBytes` so each function stays simple (sonar S3776).
 */
function objectNodeHasInlineBytes(node: object, stack: unknown[]): boolean {
  if (isBinaryBuffer(node)) {
    return true;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      stack.push(item);
    }
    return false;
  }
  if (node instanceof Map) {
    for (const [key, item] of node) {
      stack.push(key, item);
    }
    return false;
  }
  if (node instanceof Set) {
    for (const item of node) {
      stack.push(item);
    }
    return false;
  }
  if (!isRecord(node)) {
    return false;
  }
  if (isCanonicalBase64Source(node)) {
    return true;
  }
  for (const nested of Object.values(node)) {
    stack.push(nested);
  }
  return false;
}

/**
 * Deep, cycle-safe scan of an opaque (`z.unknown()`) value for smuggled inline media bytes: a
 * canonical `{ kind: 'base64', data }` media source anywhere in the tree, a base64 `data:` URI
 * string, or a raw binary buffer. This is how the typed guard reaches the `tool_call.args` /
 * `tool_result.result` fields a Zod refine cannot recurse into (ADR-0031 decision #7) — used by
 * the durable union's backstop and the seam boundary schemas in `@relavium/llm`. Deliberately
 * limited to CANONICAL Relavium shapes plus generic binary: a vendor-native media shape (Gemini
 * `inlineData`, OpenAI `b64_json`) is an adapter-normalization obligation, never knowledge this
 * platform-free package may carry.
 */
export function containsInlineMediaBytes(value: unknown): boolean {
  try {
    const seen = new Set<object>();
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current === 'string') {
        if (DATA_URI_BASE64_PATTERN.test(current)) {
          return true;
        }
        continue;
      }
      if (typeof current !== 'object' || current === null || seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (objectNodeHasInlineBytes(current, stack)) {
        return true;
      }
    }
    return false;
  } catch {
    // Fail closed, deliberately: a value that booby-traps inspection (a throwing property getter,
    // a hostile proxy/iterator) cannot be proven byte-free, and letting the throw escape would
    // turn every mounting schema's safeParse into a throwing call. Treat it as containing bytes.
    return true;
  }
}

/**
 * The media arm's text hints must stay text: a `name`/`transcript` whose value IS a base64
 * `data:` URI would carry bytes on a TYPED media-part position — exactly where the opaque-field
 * deep scan never looks (it walks `z.unknown()` values, not parsed schema fields). Mounted by
 * both the in-flight ingestion refine and the durable refine so neither fork can smuggle.
 */
function refineMediaTextHints(
  part: { name?: string | undefined; transcript?: string | undefined },
  ctx: z.RefinementCtx,
  path: readonly (string | number)[] = [],
): void {
  for (const [field, value] of [
    ['name', part.name],
    ['transcript', part.transcript],
  ] as const) {
    if (value !== undefined && DATA_URI_BASE64_PATTERN.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must not carry a base64 data: URI — media bytes ride the source carrier only (ADR-0031 I3)`,
        path: [...path, field],
      });
    }
  }
}

/**
 * The **backstop tripwire** on typed durable media positions (ADR-0031 §Guardrails — demoted from
 * "the primary mechanism"): the durable type split already makes bytes structurally impossible;
 * this catches a programming error that bypassed `deInlineMedia` (e.g. a value cast around the
 * types) when it is run at the emit choke point. `url` is rejected too — "handle-only durable is
 * absolute" (design §11 OQ7): no provider/user URL persists.
 */
export function persistableMediaRefine(
  part: { source: { kind: string } },
  ctx: z.RefinementCtx,
): void {
  if (part.source.kind === 'base64') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'media bytes (base64) may not cross a durable/event/IPC boundary; deInlineMedia must run first',
      path: ['source'],
    });
  }
  if (part.source.kind === 'url') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'a URL may not persist — the durable media form is handle-only; materialize it to a MediaStore handle first (ADR-0031)',
      path: ['source'],
    });
  }
}

/* ------------------------------------------------------------------------------------------------
 * MediaSource — the canonical media value: three in-flight carriers, one durable carrier
 * ---------------------------------------------------------------------------------------------- */

/**
 * The tiny tier: sub-ceiling decoded bytes, **in-flight only** (a request input or a transient
 * adapter materialization). Structurally absent from `DurableMediaSource`.
 */
const base64SourceSchema = z.object({ kind: z.literal('base64'), data: nonEmptyString });

/**
 * The canonical durable form: an opaque content-addressed `MediaStore` handle. The ONLY carrier
 * that may cross a durable / run-event / IPC / DB / exported-YAML boundary (ADR-0031 I3).
 */
const handleSourceSchema = z.object({
  kind: z.literal('handle'),
  ref: z.string().regex(MEDIA_HANDLE_PATTERN, 'must be a media://sha256-<64hex> handle'),
});

/**
 * A public-HTTPS passthrough (user-supplied input URL or provider-returned output URL). Gated
 * **feature-flag-OFF** (`MEDIA_URL_SOURCE_ENABLED`) until the shared SSRF range-primitive lands;
 * fetched only by the host/engine through that primitive, never by the seam or an adapter (A7).
 */
const urlSourceSchema = z.object({ kind: z.literal('url'), url: nonEmptyString });

/** The in-flight carrier union (seam request/result content): base64 | handle | url. */
export const MediaSourceSchema = z.discriminatedUnion('kind', [
  base64SourceSchema,
  handleSourceSchema,
  urlSourceSchema,
]);
export type MediaSource = z.infer<typeof MediaSourceSchema>;

/**
 * The durable carrier union: **handle only**. `base64` (and `url` — "handle-only durable is
 * absolute", design §11 OQ7) are structurally absent, so the compiler — not a runtime refine —
 * proves no bytes reach a durable schema (ADR-0031 decision #1).
 */
export const DurableMediaSourceSchema = z.discriminatedUnion('kind', [handleSourceSchema]);
export type DurableMediaSource = z.infer<typeof DurableMediaSourceSchema>;

/* ------------------------------------------------------------------------------------------------
 * The durable media arm — handle-only by construction (ADR-0031 decision #1, Y3 metadata)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The **durable** media arm: `source` narrows to handle-only (no base64 literal in its union), so
 * a durable schema cannot carry bytes by construction. The Y3 integrity metadata lives here ONLY
 * (the in-flight arm stays lean): the host populates `byteLength` (what a Range/byte-delivery
 * request is bounded against without trusting a raw file size) and probes `durationMs`
 * (audio/video render/desync metadata) at the `deInlineMedia` boundary. No `checksum` field — the
 * content-addressed `media://sha256-<hex>` handle already IS the sha256.
 */
const durableMediaPartObjectSchema = z.object({
  type: z.literal('media'),
  mimeType: MediaMimeTypeSchema,
  source: DurableMediaSourceSchema,
  // A display/filename hint — bounded like mimeType (a hint, not a payload channel). transcript
  // stays unbounded (real transcripts are legitimately long text) but is data-URI-guarded by
  // refineMediaTextHints on both forks.
  name: z.string().max(255).optional(),
  transcript: z.string().optional(),
  byteLength: nonNegativeInt.optional(),
  durationMs: positiveInt.optional(),
});

/**
 * The Y3 cross-field rules on a durable media part: the MIME must map to a known modality
 * (fail-closed) and `durationMs` is audio/video-only. Shared by the standalone
 * `DurableMediaPartSchema` and the durable union's superRefine so the two positions cannot drift.
 */
function refineDurableMediaPart(
  part: z.infer<typeof durableMediaPartObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  refineMediaTextHints(part, ctx);
  const modality = mediaModalityOf(part.mimeType);
  if (modality === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsupported media mimeType '${part.mimeType}' — expected image/*, audio/*, video/*, or application/pdf`,
      path: ['mimeType'],
    });
    return;
  }
  if (part.durationMs !== undefined && modality !== 'audio' && modality !== 'video') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `durationMs is audio/video metadata — a ${modality} part must not carry it`,
      path: ['durationMs'],
    });
  }
}

/** The durable media part (handle-only source + Y3 metadata), with its cross-field rules mounted. */
export const DurableMediaPartSchema =
  durableMediaPartObjectSchema.superRefine(refineDurableMediaPart);
export type DurableMediaPart = z.infer<typeof DurableMediaPartSchema>;

/* ------------------------------------------------------------------------------------------------
 * The content-part arms — in-flight union (ADR-0030/0031)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The **in-flight** MIME-discriminated media arm (`LlmMessage`/`LlmResult` content). One arm
 * covers image/audio/video/`application/pdf` — modality derives from `mimeType`, so a new format
 * needs zero schema change. There is deliberately **no provider-ref field**: an ephemeral
 * provider-hosted id (Gemini `fileUri`, OpenAI `file_id`/`audio.id`) lives only in a
 * process-scoped adapter sidecar keyed by `(provider, sha256)`, never on the part — so it can
 * never be persisted or replayed by accident (ADR-0031 §Guardrails).
 *
 * A plain object schema (usable as a discriminated-union member); the ceiling / url-gate /
 * modality checks are mounted at the seam ingestion boundary via `refineInFlightMediaPart`.
 */
export const MediaPartSchema = z.object({
  type: z.literal('media'),
  mimeType: MediaMimeTypeSchema,
  source: MediaSourceSchema,
  name: z.string().max(255).optional(), // display/filename hint — bounded, like mimeType
  transcript: z.string().optional(),
});
export type MediaPart = z.infer<typeof MediaPartSchema>;

const textPartSchema = z.object({ type: z.literal('text'), text: z.string() });

const toolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  id: nonEmptyString,
  name: nonEmptyString,
  args: z.unknown(),
  // The provider ran this tool on its own side (server-side / built-in tool, e.g. web search). The
  // engine's ToolDispatcher does NOT execute it and does not apply its allowlist to it — it only
  // records/forwards. Omitted (or false) means an engine-executed call. See ADR-0030 / ADR-0029.
  providerExecuted: z.boolean().optional(),
});

const toolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: nonEmptyString,
  result: z.unknown(),
  isError: z.boolean().optional(),
  // The provider produced this result (the counterpart of a provider-executed tool_call). ADR-0030.
  providerExecuted: z.boolean().optional(),
  // Typed, handle-only media attachments (ADR-0031 decision #7): a provider-executed media result
  // reaches consumers as durable parts here — raw media bytes inside the opaque `result` are
  // forbidden (`result` carries at most a descriptor), enforced by the boundary/backstop scans.
  media: z.array(DurableMediaPartSchema).optional(),
});

// Reasoning / "thinking" content (ADR-0030). EPHEMERAL: `signature` is a same-provider, same-turn
// continuity token — it is never persisted to a session, never replayed across a provider boundary
// on fallback, and never written to a run event or log. The engine does not interpret it; only the
// originating adapter feeds it back. `redacted` marks a provider-withheld block (data, no text).
const reasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  signature: z.string().optional(),
  redacted: z.boolean().optional(),
});

/**
 * A normalized message content part — the one shape every provider's content is folded into,
 * shared by an LLM message (the seam's `LlmMessage`) and a persisted session message. `args`
 * and `result` are opaque (`unknown`): the engine and adapters own their JSON shapes, not this
 * contract. The `media` arm is the ADR-0031 amendment.
 */
export const ContentPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  toolCallPartSchema,
  toolResultPartSchema,
  reasoningPartSchema,
  MediaPartSchema,
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

/* ------------------------------------------------------------------------------------------------
 * The durable content-part union (ADR-0031 decision #1)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The durable reasoning arm drops `signature` **structurally** (not just by discipline): ADR-0030
 * pins the signature as a same-provider, same-turn continuity token that is never persisted, so
 * the persisted type simply has no field to put it in — the same compiler-proof move as the
 * handle-only `DurableMediaSource`. The reasoning text/redacted flag may persist (a session can
 * render past reasoning); the continuity token cannot.
 */
const durableReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  redacted: z.boolean().optional(),
});

/**
 * The **durable** content-part union — what a persisted / event / IPC / exported position
 * references instead of `ContentPart` (ADR-0031 decision #1). `deInlineMedia` is the typed
 * flight→durable transform between the two. The superRefine is the **backstop tripwire**
 * (`persistableMediaRefine` + the inline-bytes scan over the opaque `args`/`result` fields a
 * typed union cannot reach) — the primary guarantee is the type split plus the active emit-time
 * pass at the one choke point (wired at 1.AF).
 */
export const DurableContentPartSchema = z
  .discriminatedUnion('type', [
    textPartSchema,
    toolCallPartSchema,
    toolResultPartSchema,
    durableReasoningPartSchema,
    durableMediaPartObjectSchema,
  ])
  .superRefine((part, ctx) => {
    if (part.type === 'media') {
      // Here the structural union rejection is the ACTIVE mechanism (the durable arm's source is
      // handle-only, so a base64/url part never parses this far) — the backstop fires only on the
      // cast-around/direct-invocation path; its live mounts are the typed positions and the tests.
      persistableMediaRefine(part, ctx);
      refineDurableMediaPart(part, ctx);
      return;
    }
    if (part.type === 'tool_call' && containsInlineMediaBytes(part.args)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'media bytes (base64) may not cross a durable/event/IPC boundary; deInlineMedia must run first',
        path: ['args'],
      });
    }
    if (part.type === 'tool_result' && containsInlineMediaBytes(part.result)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'media bytes (base64) may not cross a durable/event/IPC boundary; deInlineMedia must run first',
        path: ['result'],
      });
    }
  });
export type DurableContentPart = z.infer<typeof DurableContentPartSchema>;

/* ------------------------------------------------------------------------------------------------
 * The seam ingestion-side media rules (mounted by `LlmMessageSchema` in `@relavium/llm`)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The seam **ingestion-side** rules for one in-flight media part, mounted by the boundary schemas
 * that accept authored/request content (`LlmMessageSchema` in `@relavium/llm`): the MIME must map
 * to a known modality; the `url` carrier is rejected while `MEDIA_URL_SOURCE_ENABLED` is off; a
 * `base64` source must be valid base64, is forbidden outright for video/document (ceiling 0), and
 * is bounded by `INLINE_MEDIA_CEILING` decoded bytes otherwise. Returns the part's decoded inline
 * byte count (0 for handle/url carriers) so the caller can enforce the per-message aggregate cap
 * with the same accounting.
 */
export function refineInFlightMediaPart(
  part: MediaPart,
  ctx: z.RefinementCtx,
  path: readonly (string | number)[] = [],
): number {
  refineMediaTextHints(part, ctx, path);
  const modality = mediaModalityOf(part.mimeType);
  if (modality === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsupported media mimeType '${part.mimeType}' — expected image/*, audio/*, video/*, or application/pdf`,
      path: [...path, 'mimeType'],
    });
    return 0;
  }
  if (part.source.kind === 'url' && !MEDIA_URL_SOURCE_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'the url media carrier is feature-flag-OFF until the shared SSRF range-primitive lands (ADR-0031; 1.AE)',
      path: [...path, 'source'],
    });
    return 0;
  }
  if (part.source.kind === 'url') {
    const host = extractHttpsHost(part.source.url);
    if (host === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'media url source must be a valid HTTPS URL',
        path: [...path, 'source', 'url'],
      });
      return 0;
    }
    if (host.hasCredentials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'media url source must not contain embedded credentials',
        path: [...path, 'source', 'url'],
      });
      return 0;
    }
    if (isPrivateOrLocalHost(host.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'media url source must not resolve to a private, loopback, or link-local address',
        path: [...path, 'source', 'url'],
      });
      return 0;
    }
  }
  if (part.source.kind !== 'base64') {
    return 0;
  }
  const ceiling = INLINE_MEDIA_CEILING[modality];
  if (ceiling === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${modality} media is never inline — pass a media://sha256-<hex> handle (INLINE_MEDIA_CEILING.${modality} = 0)`,
      path: [...path, 'source'],
    });
    return 0;
  }
  const decodedBytes = decodedBase64ByteLength(part.source.data);
  if (decodedBytes === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'source.data is not valid padded base64',
      path: [...path, 'source', 'data'],
    });
    return 0;
  }
  if (decodedBytes > ceiling) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `inline ${modality} media is ${decodedBytes} decoded bytes — over the ${ceiling}-byte INLINE_MEDIA_CEILING; pass a handle instead`,
      path: [...path, 'source', 'data'],
    });
    return 0;
  }
  return decodedBytes;
}

/* ------------------------------------------------------------------------------------------------
 * MediaStore + deInlineMedia — host-injected contracts, shape reserved at 1.AD (ADR-0031)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The host-injected blob store the engine references only by the handle string (ADR-0031 I2/I4 —
 * the same "one engine, injected transport" pattern as ADR-0018). Implementations: a filesystem
 * CAS on CLI/VS Code, the Rust-side CAS on desktop (ADR-0032), the user's local store in managed
 * mode. `Uint8Array` is an ES-lib built-in, so the contract stays platform-free (`types: []`).
 * **Shape only at 1.AD** — the implementations, the `media_objects` retention/GC table, and the
 * refcount surface land with 1.AF; partial-write semantics for `media_delta.partialRef` are
 * deliberately NOT specified here (A3 — reserved, host-implementation-defined).
 */
export interface MediaStore {
  /** Content-address `bytes` and return the canonical `media://sha256-<64hex>` handle. */
  put(bytes: Uint8Array, mimeType: string): Promise<string>;
  /** Resolve a handle back to its bytes (display, `save_to`, provider re-upload on failover). */
  get(handle: string): Promise<Uint8Array>;
  /**
   * Resolve a handle to the in-flight carrier a specific provider's egress needs (inline base64
   * under the ceiling, a provider-file re-upload, …). Called by the **engine** before egress —
   * adapters stay pure string→string and never hold a `MediaStore` (ADR-0031 §adapter rule).
   */
  resolveForEgress(handle: string, provider: LlmProviderId): Promise<MediaSource>;
}

/**
 * The engine-owned flight→durable transform (ADR-0031 §Guardrails B1): replaces every in-flight
 * base64 (or unresolved url) media part with a handle by writing bytes to the `MediaStore`, so
 * the compiler proves what leaves the one emit/persist choke point is handle-only. **Signature
 * reserved at 1.AD; the implementation and the choke-point wiring land with 1.AF** (the typed
 * overload covers seam content; the `unknown` overload covers event payloads / node outputs /
 * checkpoint snapshots a refine cannot reach).
 */
export interface DeInlineMedia {
  (parts: readonly ContentPart[], store: MediaStore): Promise<DurableContentPart[]>;
  (value: unknown, store: MediaStore): Promise<unknown>;
}

/* ------------------------------------------------------------------------------------------------
 * SSRF range-block — the one shared primitive (1.AE, security-review.md, ADR-0031 §Guardrails)
 *
 * The policy half of the SSRF guard: given a hostname string (post-URL-parse, lowercased,
 * bracket-stripped for IPv6), return whether it is a private, loopback, link-local, CGNAT,
 * or cloud-metadata address that must never be an egress target. The mechanism half
 * (DNS resolution + connect-by-validated-IP + per-hop redirect re-validation) lives in the
 * host-side EgressCapability.fetch implementation — see docs/standards/security-review.md.
 *
 * Every egress caller (provider baseURL, http_request, MCP server URLs, and the media url
 * carrier) reuses this one function — never a second hand-rolled parser.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Returns `true` when `host` is a private, loopback, link-local, CGNAT, cloud-metadata,
 * or otherwise non-routable address that must never be an egress target.
 *
 * Accepts an IPv4 dotted-decimal, an IPv6 literal (with or without brackets), or a
 * hostname. IPv4-mapped IPv6 forms like `::ffff:127.0.0.1` and NAT64 `64:ff9b::127.0.0.1`
 * are decoded and re-checked against the IPv4 rules so they cannot bypass the block.
 *
 * This is the **literal-hostname check** only (no DNS resolution). The host-side
 * EgressCapability.fetch resolves the hostname and re-runs this check on every resolved IP,
 * then pins the connection to a validated IP — closing the DNS-rebinding and
 * post-resolution-redirect TOCTOU windows.
 *
 * Canonical test surface: docs/standards/testing.md §Security-critical primitive tests.
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const h = host.toLowerCase();

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }

  if (h.startsWith('0.')) {
    return true;
  }

  if (h.startsWith('127.') || h === '::1' || h === '::') {
    return true;
  }

  if (h.startsWith('10.')) {
    return true;
  }

  const m172 = /^172\.(\d{1,3})\./.exec(h);
  if (m172 !== null) {
    const octet = Number(m172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }

  if (h.startsWith('192.168.')) {
    return true;
  }

  const m100 = /^100\.(\d{1,3})\./.exec(h);
  if (m100 !== null) {
    const octet = Number(m100[1]);
    if (octet >= 64 && octet <= 127) return true;
  }

  if (h.startsWith('169.254.')) {
    return true;
  }

  if (h.startsWith('fe80:') || h.startsWith('fe80:')) {
    return true;
  }

  if (h.startsWith('fc') || h.startsWith('fd')) {
    const next = h.charCodeAt(2);
    if ((next >= 0x30 && next <= 0x39) || (next >= 0x61 && next <= 0x66)) {
      return true;
    }
  }

  if (h.includes(':')) {
    const embeddedDotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
    if (embeddedDotted !== null) {
      return isPrivateOrLocalHost(embeddedDotted[1] ?? '');
    }
    const embeddedHex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
    if (embeddedHex !== null) {
      const hi = Number.parseInt(embeddedHex[1] ?? '0', 16);
      const lo = Number.parseInt(embeddedHex[2] ?? '0', 16);
      return isPrivateOrLocalHost(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
  }

  return false;
}

/**
 * Returns `true` when a URL string contains credentials (`user:pass@`) in its
 * authority component. Used by the SSRF policy to reject URLs that embed secrets
 * in the URL itself (security-review.md).
 */
export function urlHasCredentials(url: string): boolean {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url);
  if (match === null) return false;
  return match[1]?.includes('@') ?? false;
}

/**
 * Extract the lowercased host from an HTTPS URL, plus whether the URL's authority
 * contains embedded credentials. Pure string parsing (no URL global — the engine-purity
 * `lib` has no DOM). Returns `null` for a non-HTTPS URL or a malformed authority.
 *
 * This is the exact-FQDN **policy** half; the SSRF range-block is the host's job.
 * Shared by the engine's `enforceHttpEgress` and the adapter's `baseURL` validation.
 */
export function extractHttpsHost(url: string): { host: string; hasCredentials: boolean } | null {
  const match = /^https:\/\/([^/?#]+)/i.exec(url);
  if (match === null) {
    return null;
  }
  const rawAuthority = match[1] ?? '';
  if (hasSmugglingChar(rawAuthority)) {
    return null;
  }
  let authority = rawAuthority;
  let hasCredentials = false;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    hasCredentials = true;
    authority = authority.slice(at + 1);
  }
  let host: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    host = end === -1 ? authority : authority.slice(1, end);
  } else {
    const colon = authority.indexOf(':');
    host = colon === -1 ? authority : authority.slice(0, colon);
  }
  return { host: host.toLowerCase(), hasCredentials };
}

/**
 * Reject authority strings containing C0 controls, DEL, or backslash — smuggling
 * attacks that exploit URL parser differences (e.g. `\r`, `\n`, `\0`, `\\`).
 */
function hasSmugglingChar(authority: string): boolean {
  for (let i = 0; i < authority.length; i++) {
    const code = authority.codePointAt(i) ?? Number.NaN;
    if (code <= 0x20 || code === 0x7f || code === 0x5c) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------------------------------
 * Cancellation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The minimal structural cancellation handle the seam and the engine thread through. A real
 * `AbortSignal` (Node ≥15, browsers, Bun) structurally satisfies it, so the platform-free code —
 * `shared`, `core`, and the `@relavium/llm` **seam** — needs neither the DOM lib nor `@types/node`
 * (the strict base's `lib: ["ES2023"]` has no `AbortSignal`); cancellation is expressed in this type
 * instead. (`@relavium/llm`'s *adapters* import the provider SDKs and so do pull in `@types/node`,
 * but the seam types never name a Node/DOM type — enforced by tsconfig.seam.json.) The surface
 * passes a real signal; engine code only observes `aborted` and (de)registers an abort listener.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
