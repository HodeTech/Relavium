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
      // Preserve an own data key such as __proto__; assignment would invoke an inherited setter.
      Object.defineProperty(out, key, {
        value: redactInlineMediaForText(item, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  } finally {
    // Only an ancestor is cyclic; a completed sibling can legitimately share this object.
    seen.delete(value);
  }
}

// One definition builds both the complete matcher and its necessary-prefix preflight. Prefixes
// have bounded width: testing their absence must never run the unbounded JWT/body alternatives.
// One alternation still preserves outer spans when credential families overlap. Bounded lookaheads
// enforce minimum lengths before simple runs; no admitted-size repeated groups use the regex stack.
const STANDALONE_CREDENTIAL_FRAGMENTS: readonly {
  readonly prefix: RegExp;
  readonly body: RegExp;
}[] = [
  { prefix: /sk-/, body: /(?=[\w-]{16})[\w-]+/ },
  { prefix: /sk_(?:live|test)_/, body: /(?=[A-Za-z0-9]{16})[A-Za-z0-9]+/ },
  { prefix: /A[KSB]IA/, body: /[0-9A-Z]{16}/ },
  { prefix: /gh[pousr]_/, body: /(?=[A-Za-z0-9]{20})[A-Za-z0-9]+/ },
  { prefix: /github_pat_/, body: /(?=\w{20})\w+/ },
  { prefix: /glpat-/, body: /(?=[\w-]{16})[\w-]+/ },
  { prefix: /xox[baprs]-/, body: /(?=[A-Za-z0-9-]{10})[A-Za-z0-9-]+/ },
  { prefix: /AIza/, body: /(?=[\w-]{30})[\w-]+/ },
  { prefix: /ya29\./, body: /(?=[\w-]{20})[\w-]+/ },
  { prefix: /hf_/, body: /(?=[A-Za-z0-9]{20})[A-Za-z0-9]+/ },
  { prefix: /npm_/, body: /(?=[A-Za-z0-9]{20})[A-Za-z0-9]+/ },
  {
    prefix: /eyJ/,
    body: /(?=[\w-]{10})[\w-]+\.(?=[\w-]{10})[\w-]+\.(?=[\w-]{6})[\w-]+/,
  },
];
const STANDALONE_CREDENTIAL = new RegExp(
  '\\b(?:' +
    STANDALONE_CREDENTIAL_FRAGMENTS.map(
      (fragment) => fragment.prefix.source + fragment.body.source,
    ).join('|') +
    ')',
  'g',
);
const STANDALONE_CREDENTIAL_PREFIX = new RegExp(
  STANDALONE_CREDENTIAL_FRAGMENTS.map((fragment) => fragment.prefix.source).join('|'),
);
// The joined probe checks its boundary in the ORIGINAL text. Removing LF/TAB must not erase
// a legitimate boundary or manufacture one inside a public word. The source uses the same fragments.
const JOINED_STANDALONE_CREDENTIAL = new RegExp(STANDALONE_CREDENTIAL.source.slice(2), 'y');

// A token is never a URL scheme: `token postgres://app:pw@db` leaves the URL to the userinfo rule.
const SCHEME_CREDENTIAL =
  /\b(b[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|b[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c|t[\n\t]*o[\n\t]*k[\n\t]*e[\n\t]*n)\s+(?=[\w.~+/-]{8})(?![\w.~+/-]*:\/\/)[\w.~+/-]+={0,2}/gi;

type SecretSpanVisitor = (start: number, end: number, replacement: string) => void;

/**
 * A failed JWT probe must not rescan an admitted-size token run at every original boundary,
 * including LF/TAB joins and raw hyphen-separated words.
 * Probe the SAME canonical matcher with at most three dot-separated runs (JWT's maximum), keeping
 * the first 64 characters of each run. The largest minimum acceptance window in the literal is
 * 34 characters (AIza + 30); all other prefixes/minima fit, including JWT's 13/10/6 and ya29's two
 * runs. Truncating a longer [\w-] run therefore preserves acceptance for every current family.
 * Only accepted probes run the full greedy matcher, whose consumed span is then skipped.
 *
 * Candidate starts increase monotonically. Cache the three lookahead run ends so many original
 * boundaries inside one joined run share one delimiter scan; no per-character index is retained.
 */
function joinedCredentialProbe(joined: string): (start: number) => string {
  const delimiter = /[^\w-]/g;
  const runs: { start: number; end: number }[] = [];
  function runEnd(start: number): number {
    const cached = runs.find((run) => run.start <= start && start < run.end);
    if (cached !== undefined) return cached.end;
    delimiter.lastIndex = start;
    const end = delimiter.exec(joined)?.index ?? joined.length;
    if (end > start) {
      runs.push({ start, end });
      if (runs.length > 3) runs.shift();
    }
    return end;
  }
  return (start) => {
    let preview = '';
    for (let index = 0; index < 3; index += 1) {
      const end = runEnd(start);
      preview += joined.slice(start, Math.min(end, start + 64));
      if (end === start || joined[end] !== '.') break;
      preview += '.';
      start = end + 1;
    }
    return preview;
  };
}

/**
 * Select valid ORIGINAL starts before matching: a rejected embedded prefix cannot consume them.
 * Every prefix in the canonical literal starts with an ASCII letter; the prefilter only omits
 * impossible starts. It does not decide which family matches or where that credential ends.
 * The views can also be the same raw text; only an actual joined view skips original LF/TAB.
 */
function visitJoinedStandaloneCredentials(
  original: string,
  joined: string,
  mask: SecretSpanVisitor,
): void {
  // Absence only: a present prefix still needs the original boundary and bounded canonical probe.
  if (!STANDALONE_CREDENTIAL_PREFIX.test(joined)) return;
  const preview = joinedCredentialProbe(joined);
  const candidates = /(^|[^\w])([A-Za-z])/g;
  const separators = /[\n\t]+/g;
  let next = original === joined ? null : separators.exec(original);
  let removed = 0;
  let matchedUntil = 0;
  for (
    let candidate = candidates.exec(original);
    candidate !== null;
    candidate = candidates.exec(original)
  ) {
    const originalStart = candidate.index + candidate[0].length - 1;
    while (next !== null && next.index < originalStart) {
      removed += next[0].length;
      next = separators.exec(original);
    }
    const start = originalStart - removed;
    if (start < matchedUntil) continue;
    JOINED_STANDALONE_CREDENTIAL.lastIndex = 0;
    if (!JOINED_STANDALONE_CREDENTIAL.test(preview(start))) continue;
    JOINED_STANDALONE_CREDENTIAL.lastIndex = start;
    const match = JOINED_STANDALONE_CREDENTIAL.exec(joined);
    if (match === null) continue;
    matchedUntil = JOINED_STANDALONE_CREDENTIAL.lastIndex;
    mask(start, matchedUntil, '[redacted]');
  }
}

function redactStandaloneCredentials(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  visitJoinedStandaloneCredentials(text, text, (start, end, replacement) => {
    parts.push(text.slice(copied, start), replacement);
    copied = end;
  });
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

/**
 * The finite header-label literal is the sole joined-header authority. Check ORIGINAL boundaries
 * before matching, so an embedded x-api-key/x-goog-api-key cannot consume an inner api-key start.
 * Labels are bounded; trailing whitespace cannot contain another label, so failed scans are linear.
 */
function visitJoinedHeaderLabels(original: string, joined: string, mask: SecretSpanVisitor): void {
  if (!joined.includes(':')) return;
  const header = /(?:authorization|(?:x-)?api-key|x-goog-api-key)["']?\s*:/iy;
  const candidates = /(^|[^A-Za-z0-9_-])([A-Za-z])/g;
  const separators = /[\n\t]+/g;
  let next = separators.exec(original);
  let removed = 0;
  let matchedUntil = 0;
  for (
    let candidate = candidates.exec(original);
    candidate !== null;
    candidate = candidates.exec(original)
  ) {
    const originalStart = candidate.index + candidate[0].length - 1;
    while (next !== null && next.index < originalStart) {
      removed += next[0].length;
      next = separators.exec(original);
    }
    const start = originalStart - removed;
    if (start < matchedUntil) continue;
    header.lastIndex = start;
    const match = header.exec(joined);
    if (match === null) continue;
    matchedUntil = header.lastIndex;
    mask(start, matchedUntil, match[0]);
  }
}

/**
 * LF/TAB may split finite credential shapes. Map recognized spans back onto the original text;
 * ordinary spaces remain boundaries and public text is never globally normalized for identity.
 * Token-character continuations after LF/TAB are intentionally part of a recognized credential.
 * The two cursors advance monotonically, with no per-character offset array or recursive matcher.
 */
function redactJoinedCredentialSpans(
  text: string,
  visit: (joined: string, mask: SecretSpanVisitor) => void,
  boundary?: RegExp,
  // URL userinfo owns a separator at either edge: one right after the scheme or before the @ splits it.
  ownsEdges = false,
): string {
  if (!/[\n\t]/.test(text)) return text;
  const joined = text.replace(/[\n\t]+/g, '');
  const parts: string[] = [];
  const separators = /[\n\t]+/g;
  let next = separators.exec(text);
  let removed = 0;
  let copied = 0;
  function advance(target: number, includeAtBoundary = false): number {
    while (
      next !== null &&
      (next.index - removed < target || (includeAtBoundary && next.index - removed === target))
    ) {
      removed += next[0].length;
      next = separators.exec(text);
    }
    return target + removed;
  }
  visit(joined, (start, end, replacement) => {
    const originalStart = advance(start, !ownsEdges);
    const originalEnd = advance(end, ownsEdges);
    if (boundary?.test(text[originalStart - 1] ?? '')) return;
    if (!/[\n\t]/.test(text.slice(originalStart, originalEnd))) return;
    parts.push(text.slice(copied, originalStart), replacement);
    copied = originalEnd;
  });
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

function redactSplitCredentials(text: string): string {
  if (!/[\n\t]/.test(text)) return text;
  const urls = redactJoinedCredentialSpans(text, visitUrlUserinfo, undefined, true);
  const keys = redactJoinedCredentialSpans(
    urls,
    (joined, mask) => {
      visitJoinedStandaloneCredentials(urls, joined, mask);
    },
    /\w/,
  );
  const schemes = keys.replace(SCHEME_CREDENTIAL, '$1 [redacted]');
  return redactJoinedCredentialSpans(
    schemes,
    (joined, mask) => {
      visitJoinedHeaderLabels(schemes, joined, mask);
    },
    /[A-Za-z0-9_-]/,
  );
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
  // One pass can change the context a later pass decides on (a masked query value can remove the
  // authority's last `@`), so the projection repeats until it is stable within three passes and
  // fails closed otherwise: its output is stable under another projection.
  const once = redactSecretShapedOnce(text);
  if (once === text) return once;
  const twice = redactSecretShapedOnce(once);
  if (twice === once) return once;
  return redactSecretShapedOnce(twice) === twice ? twice : '[redacted]';
}

function redactSecretShapedOnce(text: string): string {
  const projected = redactOpaqueQueryValues(redactUrlUserinfo(redactSplitCredentials(text)))
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
    .replace(SCHEME_CREDENTIAL, '$1 [redacted]')
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
    );
  // Well-known standalone credential shapes (OpenAI, Stripe, AWS incl. STS ASIA/ABIA, GitHub token + PAT,
  // GitLab PAT, Slack, Google API + OAuth, HuggingFace, npm, JWT). Kept as ONE alternation ON PURPOSE: a
  // single leftmost-longest scan is required so two ADJACENT / EMBEDDED credential shapes (e.g. a JWT whose
  // signature segment contains an `sk-` run, or a `xox…-glpat-…` run) are covered by the outer greedy match
  // as a single span. A per-family MULTI-PASS split is NOT equivalent — an earlier pass inserting `[redacted]`
  // (a non-word `[`) truncates a later family's greedy match and can leave a trailing secret-shaped substring
  // EXPOSED (a real redaction regression, pinned in bounding.test.ts). The canonical fragments therefore
  // construct one complete alternation, with a separate bounded prefix-absence preflight. Failed probes
  // use the bounded preview before the full greedy matcher; overlap and admitted-size tests pin that path.
  // `\w` / `[\w-]` fold only the classes that are EXACTLY `[A-Za-z0-9_]` / `[A-Za-z0-9_-]`;
  // the tighter `[A-Za-z0-9]` / `[A-Za-z0-9-]` families keep their narrower class (no `_`).
  return redactStandaloneCredentials(projected);
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

/** A host-shaped prefix: a dotted name (or IPv4), `localhost` or a bracketed IP literal, with an optional port. */
const HOST_SHAPED_AUTHORITY =
  /^(?:[a-z\d-]+(?:\.[a-z\d-]+)+\.?|localhost|\[[\da-f:.]+\])(?::\d{1,5})?$/i;

/** A DNS name has at most 253 characters (254 with a trailing dot), and a `:port` adds at most six. */
const HOST_SHAPED_MAX_LENGTH = 260;

/**
 * One whole authority, with its last `@` separating userinfo from the host. Prefix-only
 * matches can mask the first password fragment and leave another `@` plus a credential
 * tail in the durable digest. Paths and JSON delimiters stop the scan; queries/fragments
 * after an existing userinfo separator remain public. Before that separator, a raw ?/#
 * begins public query/fragment text only when the text before it is host-shaped **and** an
 * `=` assignment follows it; anything else may be a malformed username or password, and unless a
 * host-shaped name follows the last `@` such an ambiguous authority is masked through its end. This
 * is the same predicate and extent as the LLM diagnostic backstop (`packages/llm/src/scrub-secrets.ts`).
 * The projection differs from that backstop by design: its authority also ends at `"`, `'`, `,`,
 * `}` and `]`, so userinfo containing one of them (an already-masked `[REDACTED]` password among
 * them) is left as it is; it recognizes any scheme of up to 32 characters rather than a finite list;
 * and a userinfo with no password is a vanity handle below 16 characters and masked from 16 on,
 * under every scheme.
 */
function isPublicQueryContact(userinfo: string, query: number): boolean {
  // A longer prefix cannot be a hostname, and an unbounded dotted run would exhaust V8's RegExp
  // backtrack stack at admitted size; such a prefix stays userinfo, which fails closed.
  if (query > HOST_SHAPED_MAX_LENGTH) return false;
  return HOST_SHAPED_AUTHORITY.test(userinfo.slice(0, query)) && userinfo.includes('=', query + 1);
}

/** Whether an authority's text after its last `@` begins with a host, up to any query or fragment. */
function hostFollows(rest: string): boolean {
  const end = rest.search(/[?#]/);
  const host = end < 0 ? rest : rest.slice(0, end);
  // Bounded like the contact prefix, so an admitted-size run cannot exhaust the RegExp stack.
  return host.length <= HOST_SHAPED_MAX_LENGTH && HOST_SHAPED_AUTHORITY.test(host);
}

function visitUrlUserinfo(text: string, mask: SecretSpanVisitor): void {
  if (!text.includes('://')) return;
  const scheme = /[a-z][\w+.-]{0,31}:\/\//gi;
  const delimiter = /[/\s"',}\]]/g;
  // The LLM backstop's authority rest: `]` stays inside it, so a bracketed IP host stays whole.
  const restDelimiter = /[/\s"',}]/g;
  for (let match = scheme.exec(text); match !== null; match = scheme.exec(text)) {
    const start = scheme.lastIndex;
    delimiter.lastIndex = start;
    const end = delimiter.exec(text)?.index ?? text.length;
    const authority = text.slice(start, end);
    const firstQuery = authority.search(/[?#]/);
    const authorityAt = firstQuery < 0 ? -1 : authority.lastIndexOf('@', firstQuery - 1);
    const at = authorityAt >= 0 ? authorityAt : authority.lastIndexOf('@');
    if (at < 0) continue;
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(':');
    const query = userinfo.search(/[?#]/);
    // Raw ?/# can belong to a malformed username or password. A host-shaped prefix followed by
    // an assignment instead introduces a public query/fragment whose contact must not become userinfo.
    if (query >= 0 && isPublicQueryContact(userinfo, query)) continue;
    const hasPassword = colon >= 0 && colon < userinfo.length - 1;
    if (!hasPassword && userinfo.length < 16) continue;
    let maskEnd = start + at;
    if (query >= 0) {
      // A raw ?/# leaves the authority ambiguous: unless a host follows its last `@`, the text there
      // may be the rest of a query value (`https://svc?password=P@ss`), so the mask runs through it.
      restDelimiter.lastIndex = maskEnd + 1;
      const restEnd = restDelimiter.exec(text)?.index ?? text.length;
      if (!hostFollows(text.slice(maskEnd + 1, restEnd))) maskEnd = restEnd;
    }
    mask(start, maskEnd, '[redacted]');
    // Skip the recognized userinfo without hiding a later scheme in the public host/tail.
    scheme.lastIndex = Math.max(maskEnd, start + at + 1);
  }
}

function redactUrlUserinfo(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  visitUrlUserinfo(text, (start, end, replacement) => {
    parts.push(text.slice(cursor, start), replacement);
    cursor = end;
  });
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
  let redactNext: string | undefined;
  for (const item of items) {
    if (redactNext !== undefined) {
      out.push(redactCredentialArgument(redactNext, item));
      redactNext = undefined;
      continue;
    }
    if (typeof item === 'string') {
      const separator = item.indexOf('=');
      const flag = separator > 0 ? item.slice(0, separator) : '';
      if (isSecretishFlag(flag)) {
        const value = item.slice(separator + 1);
        out.push(`${flag}=${redactCredentialArgument(flag, value)}`);
        continue;
      }
      if (isSecretishFlag(item)) redactNext = item;
    }
    out.push(redactSecretShapedWalk(item, seen));
  }
  return out;
}

/** One credential-value rule for both argv spellings; only ambiguous -p may name a public port. */
function redactCredentialArgument(flag: string, value: unknown): string {
  if (flag.toLowerCase() === '-p' && typeof value === 'string' && looksLikePort(value)) {
    return value;
  }
  return '[redacted]';
}

/**
 * A CLI flag that introduces a credential — `--token`, `--password`, `-p`.
 *
 * `-p` is deliberately kept AND deliberately qualified. It really is the password flag for `mysql` and
 * `psql`, and dropping it would leak those verbatim — but it is also the port flag for `ssh` and the
 * port-mapping flag for `docker run`, and a review caught this destroying `ssh -p 2222` and
 * `docker run -p 8080:80`. A port is digits, optionally `host:container`. Only the
 * `-p` ambiguity retains that exception; explicitly named credential flags do not. Both separate and
 * `--password=…` argument spellings use the entire value, rather than a partial text-pattern match.
 * See {@link looksLikePort}.
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

/** Port-shaped values disambiguate `-p`; an explicit credential flag has no port exception. */
function looksLikePort(value: string): boolean {
  return /^(?:[\d.]{1,15}:)?\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/i.test(value);
}

/**
 * One member of an object, redacted with its KEY taken into account.
 *
 * A recognized credential key owns the WHOLE value. An inner shape match does not establish that the
 * remaining text is public. Do not traverse a credential container or carry any partially scrubbed value
 * into the journal. Only an anchored, known auth scheme may survive as a fixed diagnostic label.
 */
function redactUnderKey(key: string, item: unknown, seen: WeakSet<object>): unknown {
  if (!isSecretishKey(key) || item === null || item === undefined)
    return redactSecretShapedWalk(item, seen);
  if (typeof item === 'string') {
    // Match only the bounded label and the start of a nonempty remainder, never return that remainder.
    // Canonical labels also keep caller-controlled casing out of the credential projection.
    const scheme = /^(bearer|basic|token)[ \t]+\S/i.exec(item)?.[1]?.toLowerCase();
    switch (scheme) {
      case 'bearer':
        return 'Bearer [redacted]';
      case 'basic':
        return 'Basic [redacted]';
      case 'token':
        return 'Token [redacted]';
    }
  }
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
    // Recognized credentials deliberately share a redacted projection; raw invocation keys stay unchanged.
    for (const [key, item] of Object.entries(value)) {
      // **The key decides, whatever the value's shape.** Checked BEFORE the walk, because the walk only
      // inspects strings by shape — so a numeric PIN, a nested credential object, or a high-entropy opaque
      // token with no recognisable prefix all survive it. `null`/`undefined` are left alone so an absent
      // field does not become a phantom `[redacted]` in a diagnostic.
      Object.defineProperty(out, redactSecretShapedText(key), {
        value: redactUnderKey(key, item, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
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
  // Recognize LF/TAB-split shapes in the complete materialized text before one-line normalization. Clip only after recognition: a closing quote or URL
  // authority separator can be beyond the preview. Raw model/spill text stays unchanged.
  const oneLine = redactSecretShapedText(redactSplitCredentials(text).replace(/\s+/g, ' ').trim());
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
