/**
 * Model-facing result bounding (1.T — the deferred tool-output-gate). Bounds the result that re-enters
 * the next `LlmRequest` so one oversized `read_file` / `http_request` / MCP result cannot blow the next
 * request's context window (a cost/DoS surface the pre-egress governor — ADR-0028 — cannot see). The
 * bound is **model-facing only**: the registry applies `output_mapping` to the FULL result first, so
 * workflow state keeps the real value; only the model-facing copy is bounded here. The ceiling is a
 * **byte/line** bound (no token count — that needs a provider tokenizer, breaking engine purity). Over
 * the ceiling, the full text is spilled to the host's run-scoped output store (reclaimed at the run's
 * terminal event) and the model gets a bounded preview + an explicit truncation marker + the spill path.
 * See [tool-registry.md](../../../../docs/reference/shared-core/tool-registry.md#result-bounding-and-spill-to-file).
 */

import {
  isBase64DataUri,
  isBinaryBuffer,
  isCanonicalBase64Source,
  type AbortSignalLike,
} from '@relavium/shared';

import { utf8ByteLength } from '@relavium/shared';

// Re-exported so this module's existing consumers (`engine/size-bounds.ts`, the tests) keep one import path
// while the IMPLEMENTATION lives in `@relavium/shared` — see its header for why it moved.
export { utf8ByteLength };

import type { ToolHost, ToolResultLimits } from './types.js';

export interface BoundedResult {
  /** The model-facing value: the original result when within limits, else a preview string + marker. */
  readonly value: unknown;
  readonly truncated: boolean;
  /** A short, single-line display summary for the event `outputSummary` (always bounded). */
  readonly summary: string;
}

/** Display cap (chars) for the event `outputSummary` — distinct from the model-facing ceiling. */
const SUMMARY_MAX = 500;

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.codePointAt(i) === 0x0a) {
      lines++;
    }
  }
  return lines;
}

/**
 * Replace inline media BYTES with a byte-free marker for the text/summary/spill path (1.AF — closes the
 * I3 gap where a `read_media` (or any) tool result carrying a `{ kind:'base64', data }` source would be
 * JSON-stringified into the `agent:tool_result.outputSummary` event / the spill / the over-cap preview —
 * a durable/event boundary the emit-time `deInlineMedia` choke point cannot catch, since it sees only the
 * resulting flat string, not a structured media source). The MODEL-facing result value is left intact
 * (the model still receives the bytes via the seam); only this text projection is redacted. Cycle-safe.
 */
/** A PLAIN object (Object/null prototype) — NOT a Date/RegExp/Map/Set/class instance, which JSON.stringify
 *  renders natively and the walk must leave untouched (else a Date would collapse to `{}`). Narrows without an `as`. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Byte-free projection of an arbitrary value for an **observability event field** (I3) — strips inline
 * media base64 (canonical `{ kind:'base64', data }` sources, base64 `data:` URIs) and raw binary buffers
 * at any nesting, leaving the surrounding structure intact. The symmetric twin of the `outputSummary`
 * redaction in {@link toText}, exposed for the `agent:tool_call.toolInput` field: a model can emit a
 * base64 `data:` URI (or a `{ kind:'base64', data }` object) as a tool argument, and that field rides the
 * event/IPC/log stream (an I3 boundary the emit-time `deInlineMedia` choke point cannot catch, since it
 * sees only a flat string). Display-only — the dispatch already ran on the real args. Cycle-safe.
 */
export function redactInlineMedia(value: unknown): unknown {
  return redactInlineMediaForText(value, new WeakSet<object>());
}

function redactInlineMediaForText(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return isBase64DataUri(value) ? '[base64 data URI omitted]' : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return '[cyclic]';
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactInlineMediaForText(item, seen));
    }
    if (isBinaryBuffer(value)) {
      return '[binary buffer omitted]'; // a raw Uint8Array/ArrayBuffer — never JSON the decimal byte values
    }
    if (!isPlainObject(value)) {
      return value; // Date/RegExp/Map/Set/class instance — leave for JSON.stringify's native handling
    }
    if (isCanonicalBase64Source(value)) {
      const data = value['data'];
      // Report the base64 CHARACTER length (≈1.33× the byte count), not "bytes" — observability only.
      return { kind: 'base64', base64Length: typeof data === 'string' ? data.length : 0 };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactInlineMediaForText(item, seen);
    }
    return out;
  } finally {
    // Only an ancestor is cyclic; a completed sibling can legitimately share this object.
    seen.delete(value);
  }
}

/**
 * Redact secret-SHAPED substrings from observability and journal projections — NOT the model-facing value
 * (the model must still see the real tool result
 * and its own args). A model can put a live credential in an `http_request` header/body, and a tool result can
 * carry one (a `read_clipboard`, an egress response body, a `.env` read); either would otherwise ride the
 * `--json` machine stream (ADR-0049) / a log verbatim. High-recall and deliberately conservative (a false
 * positive changes the projection, never the model/dispatch copy). Journal consumers deliberately treat
 * recognized credential projections as equal; see effect-journal.md §11. It targets `Authorization`
 * schemes, `…secret…=value` pairs, and well-known token shapes (OpenAI/AWS/GitHub/Slack/Google/JWT). Every
 * pattern uses bounded context or disjoint character runs, with no ambiguous nested repetition — per the engine's
 * no-backtracking-RegExp / no-ReDoS posture.
 */
export function redactSecretShapedText(text: string): string {
  return (
    redactOpaqueQueryValues(redactUrlUserinfo(text))
      // A PEM private-key block (multi-line, space-separated markers the `private_key` key-pattern can't see).
      // The body span is bounded (`{0,20000}?`, lazy) so an unterminated block can't drive an unbounded scan.
      .replace(
        /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
        '[redacted]',
      )
      // An `Authorization`-style scheme + its token: `Bearer <t>` / `Basic <t>` / `Token <t>`. The token class
      // `[\w.~+/-]` is base64url + padding (`\w` folds `[A-Za-z0-9_]`).
      // For every open-ended token minimum below, a bounded lookahead enforces the same floor before
      // one simple greedy run. V8 can exhaust its RegExp stack on an admitted-scale `{N,}` run; the
      // equivalent `(?=class{N})class+` form keeps the whole value instead of clipping a credential.
      .replace(/\b(bearer|basic|token)\s+(?=[\w.~+/-]{8})[\w.~+/-]+={0,2}/gi, '$1 [redacted]')
      // A secret-ish key (bounded wrappers keep this ReDoS-safe) + `=`/`:` + its value. The optional `["']?`
      // BEFORE the separator catches the JSON `"access_token":"…"` shape (an OAuth/egress response body). The
      // value has QUOTED and UNQUOTED branches. A quoted value ends at the first UNESCAPED matching quote,
      // including JSON's escaped quotes/backslashes; otherwise a valid password such as `a\"secret-tail`
      // left its tail exposed. The two alternatives inside each repetition are disjoint: a backslash
      // consumes exactly the following non-newline character, while the ordinary class excludes it.
      // No ambiguous nested repetition/backref is needed. Unquoted values retain their delimiter and
      // minimum-length policy. Kept a single analyzable LITERAL (not composed via `new RegExp`) so Sonar's static
      // super-linear-runtime (S5852) check still covers this security-critical pattern; its keyword-alternation
      // breadth is deliberate (and `apikey` is dropped — `api[_-]?key` already subsumes it).
      .replace(
        /\b[\w-]{0,32}(?:password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key|private[_-]?key|client[_-]?secret)[\w-]{0,16}["']?\s*[=:]\s*(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*'|(?=[^\s"',;&]{6})[^\s"',;&]+)/gi,
        '[redacted]',
      )
      // Well-known standalone credential shapes (OpenAI, Stripe, AWS incl. STS ASIA/ABIA, GitHub token + PAT,
      // GitLab PAT, Slack, Google API + OAuth, HuggingFace, npm, JWT). Kept as ONE alternation ON PURPOSE: a
      // single leftmost-longest scan is required so two ADJACENT / EMBEDDED credential shapes (e.g. a JWT whose
      // signature segment contains an `sk-` run, or a `xox…-glpat-…` run) are covered by the outer greedy match
      // as a single span. A per-family MULTI-PASS split is NOT equivalent — an earlier pass inserting `[redacted]`
      // (a non-word `[`) truncates a later family's greedy match and can leave a trailing secret-shaped substring
      // EXPOSED (a real redaction regression, pinned in bounding.test.ts). So this stays a single analyzable
      // LITERAL and its Sonar per-regex complexity is a deliberate, documented exception — the same trade-off as
      // the key=value pattern above: correctness of a security redactor + Sonar's static ReDoS (S5852) coverage
      // outrank the metric. `\w` / `[\w-]` fold only the classes that are EXACTLY `[A-Za-z0-9_]` / `[A-Za-z0-9_-]`;
      // the tighter `[A-Za-z0-9]` / `[A-Za-z0-9-]` families keep their narrower class (no `_`).
      .replace(
        // NOSONAR — the per-regex complexity is the deliberate, documented exception explained above
        /\b(?:sk-(?=[A-Za-z0-9]{16})[A-Za-z0-9]+|sk_(?:live|test)_(?=[A-Za-z0-9]{16})[A-Za-z0-9]+|A[KSB]IA[0-9A-Z]{16}|gh[pousr]_(?=[A-Za-z0-9]{20})[A-Za-z0-9]+|github_pat_(?=\w{20})\w+|glpat-(?=[\w-]{16})[\w-]+|xox[baprs]-(?=[A-Za-z0-9-]{10})[A-Za-z0-9-]+|AIza(?=[\w-]{30})[\w-]+|ya29\.(?=[\w-]{20})[\w-]+|hf_(?=[A-Za-z0-9]{20})[A-Za-z0-9]+|npm_(?=[A-Za-z0-9]{20})[A-Za-z0-9]+|eyJ(?=[\w-]{10})[\w-]+\.(?=[\w-]{10})[\w-]+\.(?=[\w-]{6})[\w-]+)/g,
        '[redacted]',
      )
  );
}

/**
 * Signed-URL/webhook values can be opaque credentials under an unrecognised query key.
 * Preserve short values, parameter names and public delimiters/fragments. Once recognized,
 * mask the whole value: a fixed-length prefix leaves a permanent credential equality oracle.
 * Scan delimiters separately instead of matching a multi-megabyte repeated value in V8's
 * RegExp stack. Both cursors advance; short unrecognized values add only bounded overlap.
 */
function redactOpaqueQueryValues(text: string): string {
  if (!text.includes('?') && !text.includes('&')) return text;
  const prefix = /[?&][\w.-]{1,64}=/g;
  const delimiter = /[\s&#"',}\]]/g;
  const parts: string[] = [];
  let cursor = 0;
  for (let match = prefix.exec(text); match !== null; match = prefix.exec(text)) {
    const valueStart = prefix.lastIndex;
    delimiter.lastIndex = valueStart;
    const valueEnd = delimiter.exec(text)?.index ?? text.length;
    if (valueEnd - valueStart < 24) continue;
    parts.push(text.slice(cursor, valueStart), '[redacted]');
    cursor = valueEnd;
    prefix.lastIndex = valueEnd;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * One whole authority, with its last `@` separating userinfo from the host. Prefix-only
 * matches can mask the first password fragment and leave another `@` plus a credential
 * tail in the durable digest. Delimiters stop before paths, queries, fragments or adjacent
 * JSON fields; a short colonless vanity handle retains the existing non-secret policy.
 */
function redactUrlUserinfo(text: string): string {
  // This necessary delimiter also avoids retrying a scheme prefix across large non-URL values.
  if (!text.includes('://')) return text;
  const scheme = /[a-z][\w+.-]{0,31}:\/\//gi;
  const delimiter = /[/\s?#"',}\]]/g;
  const parts: string[] = [];
  let cursor = 0;
  for (let match = scheme.exec(text); match !== null; match = scheme.exec(text)) {
    const authorityStart = scheme.lastIndex;
    delimiter.lastIndex = authorityStart;
    const end = delimiter.exec(text)?.index ?? text.length;
    const authority = text.slice(authorityStart, end);
    const at = authority.lastIndexOf('@');
    if (at < 0) continue;
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(':');
    const hasPassword = colon >= 0 && colon < userinfo.length - 1;
    if (!hasPassword && userinfo.length < 16) continue;
    parts.push(text.slice(cursor, authorityStart), '[redacted]');
    cursor = authorityStart + at;
    // Do not consume the host while examining it: `host;other://...` must leave the next
    // scheme available to this scanner, rather than swallowing `other:` at its first slash.
    scheme.lastIndex = cursor + 1;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * Walk an arbitrary value applying {@link redactSecretShapedText} to every string, leaving structure intact —
 * the toolInput twin of the summary scrub. Applied to the `agent:tool_call.toolInput` event field so a
 * model-set credential in a header VALUE / body / url-query never rides the observability stream. Object KEYS
 * are scrubbed with the SAME detector as values (a normal header name — `Authorization`, `X-Trace` — is not
 * secret-SHAPED, so it passes through unchanged; only a model that placed a live-token-shaped string in a KEY
 * position is redacted, closing that leak path too). Cycle-safe; model/dispatch values stay unchanged.
 */
export function redactSecretShapedValue(value: unknown): unknown {
  return redactSecretShapedWalk(value, new WeakSet<object>());
}

/**
 * Does this OBJECT KEY name a secret? The same keyword alternation the `key=value` text rule uses, anchored
 * as a whole-name test rather than an inline one.
 *
 * **Why a key rule exists at all.** Tool args are STRUCTURED: `{"headers":{"X-Api-Key":"hunter2"}}` puts the
 * key and its value in separate JSON members, so the text rule's `key=value` pattern — which needs them
 * adjacent in one string — can never see it. A review enumerated what got through: a nested `api_key`, an
 * `X-Api-Key` header, a top-level `password`, an array of `--token` arguments, and a NUMERIC `pin`. Every
 * one of those was hashed into `run_effects.args_digest`, which is permanent and never swept.
 *
 * MCP is the worst case and the reason this is not optional: the repo controls neither those tools' schemas
 * nor their argument names, and `{"auth":{"token": …}}` is their ordinary shape.
 */
function isSecretishKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  // A `key` that is qualified by what KIND of key it is. `key` alone is far too common to redact — it is
  // the name of half the map entries in this codebase — so it counts only next to a qualifier.
  return words.some(
    (word, index) =>
      word === 'key' &&
      (KEY_QUALIFIERS.has(words[index - 1] ?? '') || KEY_QUALIFIERS.has(words[index + 1] ?? '')),
  );
}

/**
 * Split an argument name into lowercase WORDS, across the three conventions a tool argument actually uses:
 * `snake_case`, `kebab-case`/header case, and `camelCase`.
 *
 * **Whole words, not substrings, and that is the entire point.** The first version of this test reused the
 * text rule's `[\w-]{0,32}<keyword>[\w-]{0,16}` wrapper, which matches a keyword ANYWHERE inside a name —
 * so `author` (contains `auth`), `pinned` and `opinion` (contain `pin`), `spinner`, `tokenizer` and
 * `authors` were all redacted. That is worse than cosmetic: the digest is computed over this projection, so
 * two calls differing ONLY in a falsely-redacted field become byte-identical inputs, and §4's replay then
 * answers one with the other's recorded result — the exact failure the digest exists to prevent.
 */
function keyWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase())
    .map((word) => (word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word));
}

/** Names that mean "this is a credential" on their own. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'pin',
  'jwt',
]);

/** What has to sit next to a bare `key` before it counts as a credential. */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  'api',
  'access',
  'private',
  'secret',
  'signing',
  'encryption',
  'session',
]);

/**
 * An array, walked — plus the ARGUMENT-VECTOR shape a plain walk cannot see.
 *
 * `["--token", "hunter2"]` puts the flag and its value in adjacent, independent elements. Neither is
 * secret-SHAPED on its own and there is no key naming either, so every other rule here misses it — and it is
 * exactly how a shell command carries a credential, which makes it the `run_command` case. The element
 * FOLLOWING a secret-ish flag is redacted; the flag itself is kept, because which flag was passed is
 * diagnostic and is not the secret.
 */
function redactArgVector(items: readonly unknown[], seen: WeakSet<object>): unknown[] {
  const out: unknown[] = [];
  let redactNext = false;
  for (const item of items) {
    if (redactNext && typeof item === 'string') {
      // A port is not a credential, however password-shaped its flag was.
      out.push(looksLikePort(item) ? redactSecretShapedWalk(item, seen) : '[redacted]');
      redactNext = false;
      continue;
    }
    redactNext = typeof item === 'string' && isSecretishFlag(item);
    out.push(redactSecretShapedWalk(item, seen));
  }
  return out;
}

/**
 * A CLI flag that introduces a credential — `--token`, `--password`, `-p`. (`--password=…` is the text
 * rule's job, since flag and value are one string there.)
 *
 * `-p` is deliberately kept AND deliberately qualified. It really is the password flag for `mysql` and
 * `psql`, and dropping it would leak those verbatim — but it is also the port flag for `ssh` and the
 * port-mapping flag for `docker run`, and a review caught this destroying `ssh -p 2222` and
 * `docker run -p 8080:80`. The value shape settles it: a port is digits, optionally `host:container`, and a
 * password never is. See {@link looksLikePort}.
 */
/**
 * The flag names, as one anchored alternation.
 *
 * Its "complexity" is the LENGTH OF THE NAME LIST, not structure: no nesting, no backtracking to speak of.
 * A Set lookup would trade that for hand-expanding `api[_-]?key` into three members apiece, which is exactly
 * where a real omission would hide.
 */
const SECRETISH_FLAG =
  /^-{1,2}(?:p|pw|password|passwd|secret|token|api[_-]?key|auth|access[_-]?key|private[_-]?key|client[_-]?secret|credential|passphrase|pin)$/i; // NOSONAR — the metric is counting NAMES; see above

function isSecretishFlag(item: string): boolean {
  return SECRETISH_FLAG.test(item);
}

/** `2222`, `8080:80`, `127.0.0.1:8080:80` — a port or a port mapping, never a credential. */
function looksLikePort(value: string): boolean {
  return /^(?:[\d.]{1,15}:)?\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/i.test(value);
}

/**
 * One member of an object, redacted with its KEY taken into account.
 *
 * The shape scrub runs first and WINS when it fires, so `{"Authorization": "Bearer tok…"}` keeps its
 * diagnostic scheme (`Bearer [redacted]`) rather than collapsing to a bare `[redacted]` — the scheme is not
 * the secret, and knowing which auth scheme a call used is exactly the sort of thing a stored row is for.
 * The wholesale redaction is the FALLBACK, for the case the shape scrub structurally cannot see: an opaque
 * value with no recognisable prefix, a nested object, an array, or a number.
 */
function redactUnderKey(key: string, item: unknown, seen: WeakSet<object>): unknown {
  const walked = redactSecretShapedWalk(item, seen);
  if (!isSecretishKey(key) || item === null || item === undefined) return walked;
  // The shape scrub already fired on this string — keep its more informative output.
  if (typeof item === 'string' && walked !== item) return walked;
  return '[redacted]';
}

function redactSecretShapedWalk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecretShapedText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[cyclic]'; // break the cycle (mirrors redactInlineMedia) — never re-emit the ref
  seen.add(value);
  try {
    if (Array.isArray(value)) return redactArgVector(value, seen);
    if (!isPlainObject(value)) return value; // Date/RegExp/Map/… — leave for native handling
    const out: Record<string, unknown> = {};
    // Scrub the KEY too (a secret-shaped key is redacted; a normal name is unchanged — see the doc above). A
    // display-only field, so a rare collision of two keys both redacting to `[redacted]` losing one is acceptable.
    for (const [key, item] of Object.entries(value)) {
      // **The key decides, whatever the value's shape.** Checked BEFORE the walk, because the walk only
      // inspects strings by shape — so a numeric PIN, a nested credential object, or a high-entropy opaque
      // token with no recognisable prefix all survive it. `null`/`undefined` are left alone so an absent
      // field does not become a phantom `[redacted]` in a diagnostic.
      out[redactSecretShapedText(key)] = redactUnderKey(key, item, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Render any result to the text the model would see (a string is itself; else compact JSON). Inline
 *  media bytes are redacted first so the summary/spill/preview can never carry base64 (I3). */
function toText(result: unknown): string {
  if (typeof result === 'string') {
    return isBase64DataUri(result) ? '[base64 data URI omitted]' : result;
  }
  if (result === undefined) {
    return '';
  }
  try {
    // Always run the redaction walk for a non-string result (inside the try so a throwing getter/proxy
    // degrades to '[unserializable]' rather than escaping): it strips inline base64 sources, base64 data:
    // URIs, AND raw binary buffers at any nesting before JSON-serialisation, so no media bytes (base64 or
    // decimal) can ride the summary/spill/preview (I3). A non-media object is returned as a structural clone
    // (same JSON). JSON.stringify returns undefined for a value with no JSON form (a bare function/symbol);
    // the `??` keeps a string without an `[object Object]`.
    const safe = redactInlineMediaForText(result, new WeakSet<object>());
    return JSON.stringify(safe) ?? '[unserializable]';
  } catch {
    return '[unserializable]'; // circular reference / throwing toJSON / throwing getter during redaction
  }
}

function makeSummary(text: string): string {
  // Cap the scanned input so the whitespace-collapse never runs over an oversized result (the summary
  // is bounded to SUMMARY_MAX regardless). Scrub secret-shaped substrings BEFORE the length cap so a
  // credential in the result (a read_clipboard, an egress body, a `.env` read) never rides `outputSummary`
  // to the `--json` stream / a log (the model-facing value is untouched — this is the observability copy).
  const slice = text.length > SUMMARY_MAX * 8 ? text.slice(0, SUMMARY_MAX * 8) : text;
  const oneLine = redactSecretShapedText(slice.replace(/\s+/g, ' ').trim());
  return oneLine.length <= SUMMARY_MAX ? oneLine : `${oneLine.slice(0, SUMMARY_MAX)}…`;
}

/** UTF-8 byte width of one code point. */
function codePointBytes(cp: number): number {
  if (cp < 0x80) {
    return 1;
  }
  if (cp < 0x800) {
    return 2;
  }
  if (cp < 0x10000) {
    return 3;
  }
  return 4;
}

/** Head-anchored slice: scan forward, never exceeding `maxBytes`, never splitting a code point. */
function sliceHeadToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    if (cp === undefined) {
      break;
    }
    const width = codePointBytes(cp);
    if (bytes + width > maxBytes) {
      break;
    }
    bytes += width;
    i += cp > 0xffff ? 2 : 1;
  }
  return text.slice(0, i);
}

/**
 * Index of the code point that ends at `end` (exclusive). Backs up to the leading high surrogate ONLY
 * for a real pair; a LONE low surrogate is its own 3-byte (WTF-8) unit (`codePointAt` returns the
 * surrogate value → codePointBytes = 3).
 */
function codePointStartBefore(text: string, end: number): number {
  const start = end - 1;
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
    const prev = text.charCodeAt(start - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      return start - 1;
    }
  }
  return start;
}

/** Tail-anchored slice: scan backward, never exceeding `maxBytes`, never splitting a code point. */
function sliceTailToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let i = text.length;
  while (i > 0) {
    const start = codePointStartBefore(text, i);
    const cp = text.codePointAt(start);
    if (cp === undefined) {
      break;
    }
    const width = codePointBytes(cp);
    if (bytes + width > maxBytes) {
      break;
    }
    bytes += width;
    i = start;
  }
  return text.slice(i);
}

/** Slice up to `maxBytes` UTF-8 bytes from the head (or, when `fromEnd`, the tail), never splitting a code point. */
function sliceToBytes(text: string, maxBytes: number, fromEnd: boolean): string {
  if (maxBytes <= 0) {
    return '';
  }
  return fromEnd ? sliceTailToBytes(text, maxBytes) : sliceHeadToBytes(text, maxBytes);
}

/**
 * A bounded preview honoring BOTH the line ceiling and the byte ceiling. Over the line ceiling → a
 * head+tail LINE window; otherwise (byte-only truncation) a head+tail of the whole text. Each part is
 * then byte-bounded (code-point-safe) against the byte budget, so the preview never exceeds ~maxBytes
 * and never emits a lone surrogate.
 */
function makePreview(text: string, limits: ToolResultLimits): string {
  let headSrc: string;
  let tailSrc: string;
  const lines = text.split('\n');
  if (lines.length > limits.maxLines) {
    // Reserve one line for the inserted `…` marker so head + tail + ellipsis never exceeds maxLines.
    const headLines = Math.max(1, Math.floor((limits.maxLines - 1) * 0.7));
    const tailLines = Math.max(1, limits.maxLines - 1 - headLines);
    headSrc = lines.slice(0, headLines).join('\n');
    tailSrc = lines.slice(lines.length - tailLines).join('\n');
  } else {
    headSrc = text;
    tailSrc = text;
  }
  const byteBudget = Math.max(0, limits.maxBytes);
  // The `head\n…\ntail` shape spends 3 lines; below that ceiling there's no room for a separate tail
  // line, so emit head-only to keep the preview within maxLines.
  if (limits.maxLines < 3) {
    return sliceToBytes(headSrc, byteBudget, false);
  }
  const head = sliceToBytes(headSrc, Math.floor(byteBudget * 0.7), false);
  const tail = sliceToBytes(tailSrc, Math.floor(byteBudget * 0.3), true);
  return tail === '' ? head : `${head}\n…\n${tail}`;
}

/**
 * Bound the model-facing result. Within the ceiling → the original result, untouched. Over the ceiling
 * → a preview + marker; the full text is spilled to `host.outputStore` (its own capability, so bounding
 * works even on a host with no filesystem). The full result for `output_mapping` is handled by the
 * registry, never here.
 *
 * Note: a genuinely streamed huge source is bounded by its host capability at the boundary (it returns
 * an already-bounded payload); this helper bounds the in-memory result a `dispatch` returns.
 */
export async function boundForModel(
  result: unknown,
  limits: ToolResultLimits,
  host: ToolHost,
  signal?: AbortSignalLike,
): Promise<BoundedResult> {
  const text = toText(result);
  const summary = makeSummary(text);
  const bytes = utf8ByteLength(text);
  const lines = countLines(text);

  if (bytes <= limits.maxBytes && lines <= limits.maxLines) {
    return { value: result, truncated: false, summary };
  }

  let ref: string | undefined;
  let unavailableNote = 'no output store';
  if (host.outputStore) {
    try {
      const spilled = await host.outputStore.spill(text, limits, signal);
      ref = spilled.ref;
    } catch (cause) {
      // An abort DURING spill must surface on the cancellation path (ADR-0036 precedence); any other
      // spill failure degrades to a preview-only result rather than failing a tool that already SUCCEEDED
      // (re-running a non-idempotent tool to retry a spill would double its side effects).
      if (signal?.aborted === true || (cause instanceof Error && cause.name === 'AbortError')) {
        throw cause;
      }
      unavailableNote = 'spill failed';
    }
  }
  const marker =
    ref === undefined
      ? `\n\n[… truncated: ${bytes} bytes / ${lines} lines; full output unavailable (${unavailableNote}) …]`
      : `\n\n[… truncated: ${bytes} bytes / ${lines} lines; full output at ${ref} …]`;
  return { value: makePreview(text, limits) + marker, truncated: true, summary };
}
