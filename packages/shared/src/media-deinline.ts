import {
  containsDurableUnsafeMedia,
  isBase64DataUri,
  isBinaryBuffer,
  isCanonicalBase64Source,
  decodeBase64,
  mediaModalityOf,
  type ContentPart,
  type DurableContentPart,
  type MediaStore,
} from './content.js';

/**
 * `deInlineMedia` (1.AF, ADR-0031 §Guardrails B1 / ADR-0042 §2) — the engine-owned flight→durable
 * transform run at the ONE emit/persist choke point. Its CONTRACT: the returned value is
 * **durable-safe** — it contains only handles + text + plain data, never inline media bytes or an
 * un-re-hosted url (I3). It achieves this by rewriting every in-flight **canonical media part**
 * (`{ type:'media', mimeType, source }`) with a base64 source into a content-addressed handle (writing
 * the bytes through the injected host `MediaStore`, populating the durable Y3 `byteLength`), and by
 * **hard-failing (throwing) on anything else that carries bytes or an un-re-hosted url** — so nothing
 * can leak by passing silently through. It walks a typed `ContentPart[]` and, via the `unknown`
 * overload, an opaque event payload / node output / `tool_call.args` / `tool_result.result` a Zod
 * refine cannot recurse into.
 *
 * What it THROWS on (caught at the engine choke point → a single `run:failed`, or a stripped terminal):
 * a base64 `data:` URI string, a loose `{ kind:'base64' }` source not wrapped in a media part, a raw
 * binary buffer, a media part with an unknown source kind or an unknown modality, and a **`url`** media
 * source (re-hosting a url to a handle needs the host media-egress fetch and is the separate engine step
 * — [ADR-0043](../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md), 1.AF/D9 —
 * which re-hosts *before* this transform; until then an un-re-hosted url must never pass). Error
 * messages name the carrier kind only — never the bytes/URL/handle/secret.
 *
 * The walk is **non-mutating** (returns new structures, never edits the input), **cycle-safe**, and
 * preserves `Array`/`Map`/`Set`/plain-object shape and shared references (one clone per distinct node).
 * The no-media fast path ({@link containsDurableUnsafeMedia} — which also flags a url media part, unlike
 * the byte-only scan) returns the input unchanged for the dominant text/handle-only emit case.
 */
export function deInlineMedia(
  parts: readonly ContentPart[],
  store: MediaStore,
): Promise<DurableContentPart[]>;
export function deInlineMedia(value: unknown, store: MediaStore): Promise<unknown>;
export async function deInlineMedia(value: unknown, store: MediaStore): Promise<unknown> {
  // No-unsafe-media fast path — the dominant text/handle-only emit pays only a cheap cycle-safe scan,
  // no store round-trip and no clone. This scan ALSO flags a url media part (containsDurableUnsafeMedia,
  // not the byte-only containsInlineMediaBytes), so a url-only payload is never skipped → it reaches the
  // walk and throws (it must not silently persist an un-re-hosted url).
  if (!containsDurableUnsafeMedia(value)) {
    return value;
  }
  return rewrite(value, store, new Map<object, unknown>());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `node` is a canonical in-flight media part shape (`{ type:'media', mimeType, source }`). */
function isInflightMediaPart(node: Record<string, unknown>): boolean {
  const source = node['source'];
  return (
    node['type'] === 'media' &&
    typeof node['mimeType'] === 'string' &&
    isRecord(source) &&
    typeof source['kind'] === 'string'
  );
}

async function rewriteMediaPart(
  node: Record<string, unknown>,
  store: MediaStore,
): Promise<Record<string, unknown>> {
  const source = node['source'];
  const mimeType = node['mimeType'];
  if (!isRecord(source) || typeof mimeType !== 'string') {
    return node; // not a canonical media part after all — leave it untouched
  }
  const kind = source['kind'];
  if (kind === 'handle') {
    return node; // already durable — nothing to do
  }
  if (kind === 'url') {
    throw new Error(
      'deInlineMedia cannot re-host a url media source — the engine media-egress step (1.AF, ADR-0043) must materialize it to a handle first',
    );
  }
  const data = source['data'];
  if (kind !== 'base64' || typeof data !== 'string') {
    // An unknown source kind on a media part cannot be made durable-safe — fail closed (never pass through).
    throw new Error(
      `deInlineMedia: unsupported media source kind '${String(kind)}' on a media part`,
    );
  }
  // Fail-closed on an unknown modality (mirrors the seam ingestion refine) — mimeType is bounded (≤255)
  // and not a secret/byte payload, so it is safe to name.
  if (mediaModalityOf(mimeType) === undefined) {
    throw new Error(`deInlineMedia: unsupported media mimeType '${mimeType}'`);
  }
  const bytes = decodeBase64(data);
  if (bytes === undefined) {
    throw new Error('deInlineMedia: media source.data is not valid base64');
  }
  const handle = await store.put(bytes, mimeType);
  // Build the durable part: handle-only source + Y3 byteLength; preserve the text hints / duration.
  const durable: Record<string, unknown> = {
    type: 'media',
    mimeType,
    source: { kind: 'handle', ref: handle },
    byteLength: bytes.length,
  };
  if (typeof node['name'] === 'string') durable['name'] = node['name'];
  if (typeof node['transcript'] === 'string') durable['transcript'] = node['transcript'];
  if (typeof node['durationMs'] === 'number') durable['durationMs'] = node['durationMs'];
  return durable;
}

async function rewrite(
  value: unknown,
  store: MediaStore,
  cache: Map<object, unknown>,
): Promise<unknown> {
  if (typeof value === 'string') {
    if (isBase64DataUri(value)) {
      throw new Error(
        'deInlineMedia: a base64 data: URI may not cross the durable boundary — emit a media part (it becomes a handle) instead',
      );
    }
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const cached = cache.get(value);
  if (cached !== undefined) {
    return cached; // a node already (being) rewritten — preserve cycles + shared references
  }
  // A raw binary buffer is media bytes by definition and can never be durable-safe — fail closed BEFORE
  // the record branch (which would otherwise mangle a typed array into a numeric-indexed object and leak
  // the byte values verbatim).
  if (isBinaryBuffer(value)) {
    throw new Error('deInlineMedia: a raw binary buffer may not cross the durable boundary');
  }

  const container = await rewriteContainer(value, store, cache);
  if (container !== null) {
    return container.clone;
  }
  if (!isRecord(value)) {
    return value; // a non-plain, non-buffer object (Date, RegExp, …) — opaque, left as-is
  }

  if (isInflightMediaPart(value)) {
    const durable = await rewriteMediaPart(value, store);
    cache.set(value, durable);
    return durable;
  }
  // A url media part with NO mimeType slips past isInflightMediaPart (which requires a string mimeType) yet
  // is still flagged by containsDurableUnsafeMedia (its isUrlMediaPart requires no mimeType) — so close that
  // scan/rewrite asymmetry here: throw on a `{ type:'media', source:{ kind:'url' } }` regardless of mimeType,
  // exactly mirroring the scan, so an un-re-hosted url can NEVER silently clone through to a durable position
  // (I3). A url part WITH a mimeType already throws inside rewriteMediaPart above; this is the opaque case.
  const urlSource = value['source'];
  if (value['type'] === 'media' && isRecord(urlSource) && urlSource['kind'] === 'url') {
    throw new Error(
      'deInlineMedia cannot re-host a url media source — the engine media-egress step (1.AF, ADR-0043) must materialize it to a handle first',
    );
  }
  // A loose base64 source NOT wrapped in a media part has no mimeType to content-address — it cannot be
  // made durable-safe, so fail closed rather than recurse-and-pass-through (the prior leak path).
  if (isCanonicalBase64Source(value)) {
    throw new Error(
      'deInlineMedia: a loose base64 media source may not cross the durable boundary — wrap it in a media part',
    );
  }

  const clone: Record<string, unknown> = {};
  cache.set(value, clone);
  for (const [key, nested] of Object.entries(value)) {
    clone[key] = await rewrite(nested, store, cache);
  }
  return clone;
}

/**
 * Rewrite an `Array` / `Map` / `Set` container (returns `{ clone }`), or `null` when `value` is not one
 * (so {@link rewrite} falls through to the record/leaf cases). The clone is registered in `cache` BEFORE
 * recursing into children, so a cycle through the container resolves to the same clone. Split out of
 * `rewrite` to keep its cognitive complexity in check (sonar S3776).
 */
async function rewriteContainer(
  value: object,
  store: MediaStore,
  cache: Map<object, unknown>,
): Promise<{ clone: unknown } | null> {
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    cache.set(value, clone);
    for (const item of value) {
      clone.push(await rewrite(item, store, cache));
    }
    return { clone };
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    cache.set(value, clone);
    for (const [k, v] of value) {
      clone.set(await rewrite(k, store, cache), await rewrite(v, store, cache));
    }
    return { clone };
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    cache.set(value, clone);
    for (const item of value) {
      clone.add(await rewrite(item, store, cache));
    }
    return { clone };
  }
  return null;
}
