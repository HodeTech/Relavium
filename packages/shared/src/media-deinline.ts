import {
  containsInlineMediaBytes,
  decodeBase64,
  type ContentPart,
  type DurableContentPart,
  type MediaStore,
} from './content.js';

/**
 * `deInlineMedia` (1.AF, ADR-0031 §Guardrails B1 / ADR-0042 §2) — the engine-owned flight→durable
 * transform run at the ONE emit/persist choke point. It replaces every in-flight `base64` media
 * **part** with a content-addressed handle (writing the bytes through the injected host `MediaStore`)
 * and populates the durable Y3 `byteLength`, so the compiler-proven handle-only durable form is what
 * leaves the engine — no media bytes ever reach a run event, log, DB row, exported YAML, IPC frame,
 * or the derived checkpoint snapshot (I3).
 *
 * It rewrites only a **canonical in-flight media part** (`{ type:'media', mimeType, source }`) wherever
 * it appears — both a typed `ContentPart[]` and, via the `unknown` overload, an opaque event payload /
 * node output / `tool_call.args` / `tool_result.result` a Zod refine cannot recurse into. A bare loose
 * `{ kind:'base64' }` source without the media-part wrapper is deliberately NOT rewritten (it has no
 * `mimeType` to content-address and is not a legitimate media payload): it is left for the
 * `containsInlineMediaBytes` backstop to hard-fail at the durable boundary — surfacing the programming
 * error rather than silently inventing a handle.
 *
 * The walk is **non-mutating** (it returns new structures, never edits the input), **cycle-safe**, and
 * preserves `Array`/`Map`/`Set`/plain-object shape and shared references (one clone per distinct node).
 *
 * A `url` media source is NOT re-hosted here — that requires the host media-egress fetch capability and
 * is the separate engine step ([ADR-0043](../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md),
 * 1.AF/D9), which re-hosts a url to a handle *before* this transform. Encountering an un-re-hosted
 * `url` media source throws (it must never silently pass — an un-re-hosted url hard-fails the durable
 * parse anyway).
 */
export function deInlineMedia(
  parts: readonly ContentPart[],
  store: MediaStore,
): Promise<DurableContentPart[]>;
export function deInlineMedia(value: unknown, store: MediaStore): Promise<unknown>;
export async function deInlineMedia(value: unknown, store: MediaStore): Promise<unknown> {
  // No-media fast path — the dominant text/tool-only emit case pays only a cheap cycle-safe scan, no
  // store round-trip and no clone. (A `url`-only media part is not flagged by the scan; url re-host is
  // the separate D9 engine step, so a url part legitimately passes through this transform untouched.)
  if (!containsInlineMediaBytes(value)) {
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
    return node; // unknown carrier — leave it for the durable backstop to reject
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
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const cached = cache.get(value);
  if (cached !== undefined) {
    return cached; // a node already (being) rewritten — preserve cycles + shared references
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    cache.set(value, clone);
    for (const item of value) {
      clone.push(await rewrite(item, store, cache));
    }
    return clone;
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    cache.set(value, clone);
    for (const [k, v] of value) {
      clone.set(await rewrite(k, store, cache), await rewrite(v, store, cache));
    }
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    cache.set(value, clone);
    for (const item of value) {
      clone.add(await rewrite(item, store, cache));
    }
    return clone;
  }
  if (!isRecord(value)) {
    return value; // a non-plain object (Date, typed array, …) — opaque, left as-is
  }

  if (isInflightMediaPart(value)) {
    const durable = await rewriteMediaPart(value, store);
    cache.set(value, durable);
    return durable;
  }

  const clone: Record<string, unknown> = {};
  cache.set(value, clone);
  for (const [key, nested] of Object.entries(value)) {
    clone[key] = await rewrite(nested, store, cache);
  }
  return clone;
}
