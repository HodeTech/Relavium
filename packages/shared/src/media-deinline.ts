import {
  containsDurableUnsafeMedia,
  isBase64DataUri,
  isBinaryBuffer,
  isCanonicalBase64Source,
  decodeBase64,
  mediaModalityOf,
  pushMediaWalkChildren,
  type ContentPart,
  type DurableContentPart,
  type MediaStore,
  type MediaEgressHooks,
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
 * A **`url`** media source (1.AF/D9, [ADR-0043](../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md)
 * §3): when an optional `egress` host hook is injected, a canonical `url` media part is **re-hosted** —
 * the host fetch performs the SSRF-validated, streamed, size-bounded connect, and the returned bytes are
 * content-addressed via `MediaStore.put` exactly like a base64 source. When **no** hook is wired (or the
 * url is malformed / has no mimeType to content-address against), the `url` source **hard-fails** — an
 * un-re-hosted url may never persist (I3).
 *
 * What it THROWS on (caught at the engine choke point → a single `run:failed`, or a stripped terminal):
 * a base64 `data:` URI string, a loose `{ kind:'base64' }` source not wrapped in a media part, a raw
 * binary buffer, a media part with an unknown source kind or an unknown modality, and an un-re-hostable
 * `url` (no hook / malformed / no mimeType). Error messages name the carrier kind only — never the
 * bytes/URL/handle/secret.
 *
 * The walk is **non-mutating** (returns new structures, never edits the input), **cycle-safe**, and
 * preserves `Array`/`Map`/`Set`/plain-object shape and shared references (one clone per distinct node).
 * The no-media fast path ({@link containsDurableUnsafeMedia} — which also flags a url media part, unlike
 * the byte-only scan) returns the input unchanged for the dominant text/handle-only emit case.
 */
export function deInlineMedia(
  parts: readonly ContentPart[],
  store: MediaStore,
  egress?: MediaEgressHooks,
): Promise<DurableContentPart[]>;
export function deInlineMedia(
  value: unknown,
  store: MediaStore,
  egress?: MediaEgressHooks,
): Promise<unknown>;
export async function deInlineMedia(
  value: unknown,
  store: MediaStore,
  egress?: MediaEgressHooks,
): Promise<unknown> {
  // No-unsafe-media fast path — the dominant text/handle-only emit pays only a cheap cycle-safe scan,
  // no store round-trip and no clone. This scan ALSO flags a url media part (containsDurableUnsafeMedia,
  // not the byte-only containsInlineMediaBytes), so a url-only payload is never skipped → it reaches the
  // walk and is re-hosted (with a hook) or throws (without one) — never silently persisted.
  if (!containsDurableUnsafeMedia(value)) {
    return value;
  }
  return rewrite(value, store, new Map<object, unknown>(), egress);
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

/** Whether `node` is an in-flight media part whose carrier still needs a store write to become a handle. */
function needsStoreWrite(node: object): boolean {
  if (!isRecord(node) || !isInflightMediaPart(node)) {
    return false;
  }
  const source = node['source'];
  // A part already at rest needs no write, so it does not spend the budget — the ceiling bounds WORK, not
  // the shape of the value.
  return isRecord(source) && source['kind'] !== 'handle';
}

/**
 * How many in-flight media parts in `value` would need a store write to pin — every carrier except one
 * already at rest (`{ kind: 'handle' }`). The engine's pre-flight count for `CR-54`'s re-host ceiling
 * (`ADMISSION_CEILINGS.mediaPartsPerNodeOutput`), so a bound can be REFUSED before the first fetch rather
 * than discovered as egress that already happened.
 *
 * Walks the same container shapes {@link deInlineMedia} rewrites — arrays, plain objects, `Map` keys and
 * values, `Set` values — and is cycle-safe over the same graph, with the same O(1) refusal of a raw binary
 * buffer.
 *
 * **It is a COUNT, not a validation, and the two deliberately disagree in one direction.** `deInlineMedia`
 * additionally hard-fails on a base64 `data:` URI string, a loose `{ kind: 'base64' }` record and an
 * unknown source kind; this walk skips strings outright and has no analogue for those. That is safe because
 * every one of them still throws when the pin runs — the count can only ever be an UNDER-estimate of the
 * work, never a licence for work that would not otherwise happen.
 */
export function countUnpinnedMedia(value: unknown): number {
  let count = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) {
      continue;
    }
    seen.add(node);
    if (needsStoreWrite(node)) {
      count += 1;
    }
    // The SHARED walker — the same one `collectDurableMediaHandles` uses, and the same one this function
    // had its own byte-identical copy of until a review pointed out they could drift. It also carries the
    // raw-binary-buffer short-circuit, so a `Uint8Array` is not walked one byte at a time.
    pushMediaWalkChildren(node, stack);
  }
  return count;
}

async function rewriteMediaPart(
  node: Record<string, unknown>,
  store: MediaStore,
  egress: MediaEgressHooks | undefined,
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
  // Fail-closed on an unknown modality (mirrors the seam ingestion refine) — checked BEFORE resolving
  // bytes so a bad mimeType never triggers a base64 decode or a url fetch. mimeType is bounded (≤255)
  // and not a secret/byte payload, so it is safe to name. Applies to every non-handle carrier.
  if (mediaModalityOf(mimeType) === undefined) {
    throw new Error(`deInlineMedia: unsupported media mimeType '${mimeType}'`);
  }
  const resolved = mediaPartBytes(source, kind, egress);
  const stored = await storeResolved(resolved, mimeType, store);
  // Build the durable part: handle-only source + Y3 byteLength; preserve the text hints / duration.
  const durable: Record<string, unknown> = {
    type: 'media',
    mimeType,
    source: { kind: 'handle', ref: stored.handle },
    byteLength: stored.byteLength,
  };
  if (typeof node['name'] === 'string') durable['name'] = node['name'];
  if (typeof node['transcript'] === 'string') durable['transcript'] = node['transcript'];
  if (typeof node['durationMs'] === 'number') durable['durationMs'] = node['durationMs'];
  return durable;
}

/**
 * Write a resolved media body to the store and report its handle + exact byte count.
 *
 * The two carriers take DIFFERENT store methods, and that is the point of ADR-0089 §2. A decoded `base64`
 * body is already whole and already bounded by `INLINE_MEDIA_CEILING`, so `put` is correct for it. A `url`
 * body arrives as a stream of unknown size, so it takes `putStream` — and a host without one was already
 * refused upstream, rather than being quietly routed through `put`.
 *
 * The stream is wrapped in a COUNTING pass rather than being buffered to learn its length: `byteLength` is
 * required on the durable part (ADR-0031 Y3), and materializing the body just to measure it would undo the
 * whole change. The count is exact because every chunk passes through it.
 */
async function storeResolved(
  resolved: Uint8Array | AsyncIterable<Uint8Array>,
  mimeType: string,
  store: MediaStore,
): Promise<{ handle: string; byteLength: number }> {
  if (resolved instanceof Uint8Array) {
    return { handle: await store.put(resolved, mimeType), byteLength: resolved.length };
  }
  // Bound to the store rather than pulled off it: `putStream` is a method, and an implementation is free to
  // use `this` (the filesystem one does, for its root path). Calling a detached reference would silently
  // change what `this` means.
  const putStream = store.putStream?.bind(store);
  if (putStream === undefined) {
    throw new Error(
      'deInlineMedia cannot re-host a url media source — this MediaStore implements no putStream (ADR-0089 §2)',
    );
  }
  let byteLength = 0;
  let drained = false;
  const counted = (async function* count(): AsyncIterable<Uint8Array> {
    for await (const chunk of resolved) {
      byteLength += chunk.length;
      yield chunk;
    }
    drained = true;
  })();
  const handle = await putStream(counted, mimeType);
  // A store that returned a handle without consuming the whole stream would publish a TRUNCATED object and
  // report a short `byteLength` — and that number is what ADR-0044's `Range` gate is later validated
  // against, so a short count is not cosmetic. The `putStream` contract does not spell full consumption
  // out, so this checks rather than trusts: both shipped stores drain, and a third that does not fails
  // loudly here instead of publishing a lie.
  if (!drained) {
    throw new Error(
      'deInlineMedia: the MediaStore returned a handle without consuming the whole media stream',
    );
  }
  return { handle, byteLength };
}

/**
 * Resolve a non-handle media source to its body — a decoded `Uint8Array` for `base64`, or a STREAM for a
 * `url` (ADR-0089 §2: a url is the unbounded carrier and is never materialized whole). Decode a `base64`
 * source, or **re-host** a `url`
 * source via the injected host fetch (the SSRF-validated, size-bounded connect — D9). Fail-closed on an
 * unknown source kind, a malformed source, or a `url` with no fetch hook wired (an un-re-hosted url must
 * never reach a durable position, I3).
 */
function mediaPartBytes(
  source: Record<string, unknown>,
  kind: unknown,
  egress: MediaEgressHooks | undefined,
): Uint8Array | AsyncIterable<Uint8Array> {
  if (kind === 'base64') {
    const data = source['data'];
    if (typeof data !== 'string') {
      // A `typeof` guard ⇒ TypeError, and the message names the ACTUAL fault (a non-string `data`), not a
      // misleading "unsupported kind" — base64 IS supported here. Secret-free: the data value is never
      // interpolated (I3). The sibling domain/value checks below stay plain Error.
      throw new TypeError('deInlineMedia: base64 media source.data must be a string');
    }
    const bytes = decodeBase64(data);
    if (bytes === undefined) {
      throw new Error('deInlineMedia: media source.data is not valid base64');
    }
    return bytes;
  }
  if (kind === 'url') {
    const url = source['url'];
    if (typeof url !== 'string') {
      // Same convention as the `data` guard above, which this branch was missed by: a `typeof` guard ⇒
      // TypeError, and the message names the ACTUAL fault. The old text said the media-egress step "must
      // materialize it to a handle first" — describing a url source arriving at all, which is no longer
      // refused (ADR-0089 §2 re-hosts it through the streaming pair a few lines down). So it named a
      // condition that is not this one, for a reader debugging a malformed part. Secret-free: the url is
      // never interpolated (I3) — it can carry a signed query token.
      throw new TypeError('deInlineMedia: url media source.url must be a string');
    }
    // A `url` IS the large-media path: unlike `base64` (bounded by INLINE_MEDIA_CEILING at the schema), its
    // size is unknown until it is fetched. So it takes the STREAMING pair, and a host that lacks either half
    // is refused loudly rather than quietly routed through the whole-buffer one — ADR-0089 §2: an optional
    // guarantee with a buffering fallback is not a guarantee.
    if (egress?.streamUrl === undefined) {
      throw new Error(
        'deInlineMedia cannot re-host a url media source — no streaming media-egress hook is wired (ADR-0089 §2); a url is the unbounded path and must not be whole-buffered',
      );
    }
    return egress.streamUrl(url);
  }
  // An unknown source kind on a media part cannot be made durable-safe — fail closed (never pass through).
  // `kind` is interpolated bounded (slice 64) — on the unknown `unknown`-overload walk it is only typed
  // `typeof === 'string'` (unlike the ≤255-bounded mimeType), so an opaque payload could otherwise supply
  // an arbitrarily long string; the canonical values (base64/handle/url) are all short.
  throw new Error(
    `deInlineMedia: unsupported media source kind '${String(kind).slice(0, 64)}' on a media part`,
  );
}

async function rewrite(
  value: unknown,
  store: MediaStore,
  cache: Map<object, unknown>,
  egress: MediaEgressHooks | undefined,
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

  const container = await rewriteContainer(value, store, cache, egress);
  if (container !== null) {
    return container.clone;
  }
  if (!isRecord(value)) {
    return value; // a non-plain, non-buffer object (Date, RegExp, …) — opaque, left as-is
  }

  if (isInflightMediaPart(value)) {
    const durable = await rewriteMediaPart(value, store, egress);
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
    // Distinct suffix from the mediaPartBytes url throw above: this arm is the mimeType-LESS url part
    // (no content type to content-address against), so it can never be re-hosted even with a fetch hook.
    throw new Error(
      'deInlineMedia cannot re-host a url media source with no mimeType — there is no content type to content-address against (1.AF, ADR-0043, I3)',
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
    clone[key] = await rewrite(nested, store, cache, egress);
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
  egress: MediaEgressHooks | undefined,
): Promise<{ clone: unknown } | null> {
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    cache.set(value, clone);
    for (const item of value) {
      clone.push(await rewrite(item, store, cache, egress));
    }
    return { clone };
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    cache.set(value, clone);
    for (const [k, v] of value) {
      clone.set(await rewrite(k, store, cache, egress), await rewrite(v, store, cache, egress));
    }
    return { clone };
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    cache.set(value, clone);
    for (const item of value) {
      clone.add(await rewrite(item, store, cache, egress));
    }
    return { clone };
  }
  return null;
}
