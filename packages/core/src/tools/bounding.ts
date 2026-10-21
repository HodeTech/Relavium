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

import { fixedPointOf, toFixedPoint } from './fixed-point.js';
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

const SCHEME_CREDENTIAL =
  /\b(b[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|b[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c|t[\n\t]*o[\n\t]*k[\n\t]*e[\n\t]*n)\s+(?=[\w.~+/-]{8})[\w.~+/-]+={0,2}/gi;

// A secret-ish key (bounded wrappers keep this ReDoS-safe) + `=`/`:`. The optional quote BEFORE the
// separator catches the JSON `"access_token":"…"` shape (an OAuth/egress response body), and its
// optional backslash the same shape one JSON string down (`\"access_token\":\"…\"`). Kept an
// analyzable LITERAL (not composed via `new RegExp`) so Sonar's static super-linear-runtime (S5852)
// check still covers this security-critical pattern; its keyword-alternation breadth is deliberate
// (and `apikey` is dropped — `api[_-]?key` already subsumes it). The value is read after it, in
// `visitSecretKeyValues`.
const SECRET_KEY =
  /\b[\w-]{0,32}(?:password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key|private[_-]?key|client[_-]?secret)[\w-]{0,16}(?:\\?["'])?\s*[=:]\s*/gi;

/**
 * One recognized span of the projection's input and the text that replaces it. Every rule reports
 * its spans on the same text, and overlapping spans merge before anything is replaced
 * ({@link replaceRanges}), so no rule's mask can erase the key name, scheme label, PEM marker or URL
 * scheme another rule reads.
 */
interface SecretRange {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * A URL userinfo's context. `schemeStart` is where its identifying prefix starts: a removed LF/TAB
 * anywhere from there on splits the credential, so a separator inside `scheme://` counts even though
 * only the userinfo is replaced. Up to `ownsUntil` the userinfo owns its text: a key or query
 * parameter there names the user, not a credential of its own.
 */
interface UrlUserinfo {
  readonly schemeStart: number;
  readonly ownsUntil: number;
}

/** Reports one recognized span; `url` is set for a URL's userinfo. */
type SecretSpanVisitor = (
  start: number,
  end: number,
  replacement: string,
  url?: UrlUserinfo,
) => void;

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
 * LF/TAB may split finite credential shapes. Map the spans recognized in the joined view back onto
 * the original text and report the ones a removed separator actually splits; ordinary spaces remain
 * boundaries and public text is never globally normalized for identity. Token-character
 * continuations after LF/TAB are intentionally part of a recognized credential. The two cursors
 * advance monotonically, with no per-character offset array or recursive matcher.
 */
function visitSplitSpans(
  text: string,
  visit: (joined: string, mask: SecretSpanVisitor) => void,
  report: SecretSpanVisitor,
  boundary?: RegExp,
  // URL userinfo owns a separator at either edge: one right after the scheme or before the @ splits it.
  ownsEdges = false,
): void {
  if (!/[\n\t]/.test(text)) return;
  const joined = text.replace(/[\n\t]+/g, '');
  const separators = /[\n\t]+/g;
  let next = separators.exec(text);
  let removed = 0;
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
  visit(joined, (start, end, replacement, url) => {
    // A separator right before a URL's scheme is outside the URL, so it splits nothing.
    const schemeStart = url === undefined ? undefined : advance(url.schemeStart, true);
    const originalStart = advance(start, !ownsEdges);
    const ownsUntil = url === undefined ? undefined : advance(url.ownsUntil, ownsEdges);
    const originalEnd = advance(end, ownsEdges);
    if (boundary?.test(text[originalStart - 1] ?? '')) return;
    if (!/[\n\t]/.test(text.slice(schemeStart ?? originalStart, originalEnd))) return;
    // A split userinfo owns nothing past its first removed separator: the next line may hold a key
    // of its own (`https://\nDB_PASSWORD=P@ss`).
    const split =
      ownsUntil === undefined ? -1 : text.slice(originalStart, ownsUntil).search(/[\n\t]/);
    report(
      originalStart,
      originalEnd,
      replacement,
      schemeStart === undefined || ownsUntil === undefined
        ? undefined
        : { schemeStart, ownsUntil: split < 0 ? ownsUntil : originalStart + split },
    );
  });
}

/** LF/TAB-split URL userinfo and standalone credentials (`visitSplitSpans`). */
function visitSplitCredentials(text: string, report: SecretSpanVisitor): void {
  visitSplitSpans(text, visitUrlUserinfo, report, undefined, true);
  visitSplitSpans(
    text,
    (joined, mask) => {
      visitJoinedStandaloneCredentials(text, joined, mask);
    },
    report,
    /\w/,
  );
}

/**
 * The text as a rule reads it right after the given credentials: each one is filled like an applied
 * mask, so a label or credential glued to its end still starts at a word boundary.
 */
function afterMasks(text: string, ranges: readonly SecretRange[]): string {
  return fillRanges(text, ranges);
}

/**
 * Join every LF/TAB-split header label, so the key=value rule reads it like an unsplit one. A label
 * starts at a word boundary, and a credential or a PEM block right before it is one (`afterMasks`).
 */
function joinSplitHeaderLabels(text: string): string {
  // A label ends in ':' (visitJoinedHeaderLabels) and no fill adds one, so a text without one has none.
  if (!/[\n\t]/.test(text) || !text.includes(':')) return text;
  const masks: SecretRange[] = [];
  const firstLines: SecretRange[] = [];
  const mask: SecretSpanVisitor = (start, end, replacement) => {
    masks.push({ start, end, replacement });
    firstLines.push({ start, end, replacement });
  };
  // A split credential's LF/TAB continuation can take in a label at the start of the next line
  // (`sk-…\napi-k\tey: <v>`), so labels are read a second time with each split credential filled only
  // up to its first removed separator. The credentials' own masks are unchanged.
  visitSplitCredentials(text, (start, end, replacement) => {
    masks.push({ start, end, replacement });
    const split = text.slice(start, end).search(/[\n\t]/);
    firstLines.push({ start, end: split < 0 ? end : start + split, replacement });
  });
  visitPemBlocks(text, mask);
  visitJoinedStandaloneCredentials(text, text, mask);
  const labels: SecretRange[] = [];
  for (const boundaries of new Set([afterMasks(text, masks), afterMasks(text, firstLines)])) {
    visitSplitSpans(
      boundaries,
      (joined, label) => {
        visitJoinedHeaderLabels(boundaries, joined, label);
      },
      (start, end, replacement) => {
        labels.push({ start, end, replacement });
      },
      /[A-Za-z0-9_-]/,
    );
  }
  return replaceRanges(text, labels);
}

/**
 * Replace each run of overlapping ranges once, with the replacement of the range that starts it.
 * Ranges that only touch stay separate runs, so a key=value mask and the scheme label's token after
 * it read `[redacted] [redacted]`.
 */
function replaceRanges(text: string, ranges: readonly SecretRange[]): string {
  if (ranges.length === 0) return text;
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let copied = 0;
  let run: { start: number; end: number; replacement: string } | undefined;
  for (const range of ordered) {
    if (run !== undefined && range.start < run.end) {
      run.end = Math.max(run.end, range.end);
      continue;
    }
    if (run !== undefined) {
      parts.push(text.slice(copied, run.start), run.replacement);
      copied = run.end;
    }
    run = { start: range.start, end: range.end, replacement: range.replacement };
  }
  if (run === undefined) return text;
  parts.push(text.slice(copied, run.start), run.replacement, text.slice(run.end));
  return parts.join('');
}

/**
 * The same text with each run of overlapping ranges replaced by a run of the same length that reads
 * like a mask (`[xx…x]`): no line break, quote, delimiter or key inside, and a word boundary at either
 * end. Offsets stay valid, so a rule that reads it reports ranges of the original text.
 */
function fillRanges(text: string, ranges: readonly SecretRange[]): string {
  if (ranges.length === 0) return text;
  const runs: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    if (range.end <= range.start) continue;
    const last = runs.at(-1);
    if (last !== undefined && range.start < last.end) last.end = Math.max(last.end, range.end);
    else runs.push({ start: range.start, end: range.end });
  }
  if (runs.length === 0) return text;
  const parts: string[] = [];
  let copied = 0;
  for (const run of runs) {
    const length = run.end - run.start;
    parts.push(text.slice(copied, run.start), length < 2 ? '[' : `[${'x'.repeat(length - 2)}]`);
    copied = run.end;
  }
  parts.push(text.slice(copied));
  return parts.join('');
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
  // One pass can change the context a later pass decides on, so the projection repeats until it is
  // stable and fails closed otherwise: its output is stable under another projection.
  return toFixedPoint(redactSecretShapedOnce, text, '[redacted]');
}

/**
 * The summary's projection (`makeSummary`). A summary is shown, never compared, so it differs in one decision
 * (`visitSecretKeyValues`): a quoted value that stops at a line break is masked through a later quote that
 * could close it, else to the end of its line, and one that reaches the end of its string or of the text
 * without closing is masked to that end. Left to the one-line pass, such a value lost its key to a mask
 * before it (`token='a password="first\nsecond" done`), and JSON escaping hid it in a structured result.
 */
function redactSecretShapedSummaryText(text: string): string {
  return toFixedPoint((value) => redactSecretShapedOnce(value, true), text, '[redacted]');
}

function redactSecretShapedOnce(text: string, throughCloser = false): string {
  const source = joinSplitHeaderLabels(text);
  return replaceRanges(source, secretRanges(source, throughCloser));
}

/**
 * Every span the projection masks in `text`; each rule is described at its visitor. `throughCloser` selects
 * the summary's decisions (`redactSecretShapedSummaryText`).
 */
function secretRanges(text: string, throughCloser: boolean): readonly SecretRange[] {
  const ranges: SecretRange[] = [];
  // Ranges merge instead of erasing context, yet some reads see the text as already masked: a key or
  // parameter in a URL userinfo's own text (`UrlUserinfo.ownsUntil`) is that userinfo's, a key's
  // value runs through every span an earlier rule masks, line breaks included, and a scheme label
  // may start right after a credential, as each would with the masks applied.
  const owned: SecretRange[] = [];
  const masked: SecretRange[] = [];
  const report: SecretSpanVisitor = (start, end, replacement, url) => {
    const range = { start, end, replacement };
    ranges.push(range);
    masked.push(range);
    if (url !== undefined) owned.push({ start, end: url.ownsUntil, replacement });
  };
  const record: SecretSpanVisitor = (start, end, replacement) => {
    ranges.push({ start, end, replacement });
  };
  visitSplitCredentials(text, report);
  visitUrlUserinfo(text, report);
  const names = fillRanges(text, owned);
  visitOpaqueQueryValues(names, text, report);
  visitPemBlocks(text, report);
  // No value runs through a scheme label's token: `authorization: Bearer <t>` keeps both masks.
  visitSchemeCredentials(text, record);
  const values = fillRanges(text, masked);
  // The same masks with the backslashes each ends with kept, for a quote's second reading (`laterClosing`).
  const kept = keepingEscapes(text, masked);
  const escapes = kept === masked ? values : fillRanges(text, kept);
  const unclosed = visitSecretKeyValues(names, values, escapes, record, throughCloser);
  // Well-known standalone credential shapes (OpenAI, Stripe, AWS incl. STS ASIA/ABIA, GitHub token + PAT,
  // GitLab PAT, Slack, Google API + OAuth, HuggingFace, npm, JWT). Kept as ONE alternation ON PURPOSE: a
  // single leftmost-longest scan covers two ADJACENT / EMBEDDED credential shapes (e.g. a JWT whose
  // signature segment contains an `sk-` run, or a `xox…-glpat-…` run) with the outer greedy match as a
  // single span (pinned in bounding.test.ts). The canonical fragments therefore construct one complete
  // alternation, with a separate bounded prefix-absence preflight. Failed probes use the bounded
  // preview before the full greedy matcher; overlap and admitted-size tests pin that path.
  // `\w` / `[\w-]` fold only the classes that are EXACTLY `[A-Za-z0-9_]` / `[A-Za-z0-9_-]`;
  // the tighter `[A-Za-z0-9]` / `[A-Za-z0-9-]` families keep their narrower class (no `_`).
  const standalone: SecretRange[] = [];
  visitJoinedStandaloneCredentials(text, text, (start, end, replacement) => {
    record(start, end, replacement);
    standalone.push({ start, end, replacement });
  });
  // A scheme label glued to the end of another credential starts one of its own, even where a key's
  // value runs on over it: labels are read again with every mask filled but key values and scheme
  // tokens (`afterMasks`). Anything else glued to a mask is read by the projection's next pass. With no
  // mask, that view is the text the labels were already read in.
  if (masked.length > 0 || standalone.length > 0) {
    visitSchemeCredentials(afterMasks(text, [...masked, ...standalone]), record);
  }
  // A key's quoted value that does not close on its line is decided last, when every other range of the
  // pass is known (`visitUnclosedValues`).
  if (unclosed.length > 0) visitUnclosedValues(text, values, ranges, unclosed, record);
  // A summary also reads the line breaks and tabs that JSON escaping hides (`visitEscapedSeparators`).
  if (throughCloser) visitEscapedSeparators(text, record);
  return ranges;
}

/**
 * The ranges without the run of backslashes each ends with in `text`, or `ranges` itself when none ends
 * with one. Filled, they leave a quote right after a mask the escape it has in the text (`laterClosing`).
 */
function keepingEscapes(text: string, ranges: readonly SecretRange[]): readonly SecretRange[] {
  let changed = false;
  const kept = ranges.map((range) => {
    let end = range.end;
    while (end > range.start && text[end - 1] === '\\') end -= 1;
    if (end === range.end) return range;
    changed = true;
    return { ...range, end };
  });
  return changed ? kept : ranges;
}

/** Where a quoted value ends (`quotedValueEnd`). */
type QuotedValueEnd = ReturnType<typeof quotedValueEnd>;

/**
 * Of a quoted value's two readings, the one that closes it later: one where the masks before or inside it
 * are filled, as the next pass reads them, and one where each mask keeps the backslashes it ends with, as
 * the text has them. A mask can take the backslash that escapes a later quote, which then closes the value
 * early in the first reading (`password="Bearer\nabcdefgh token=xyz\"tail" more`), or the backslash before
 * a quote that is the value's only closer (`password="say \"…?sig=<24 or more>\"`), which closes it in the
 * first reading alone; the later closing of the two masks both. A reading that closes beats one that does
 * not.
 */
function laterClosing(first: QuotedValueEnd, second: QuotedValueEnd): QuotedValueEnd {
  return second.closed && (!first.closed || second.end > first.end) ? second : first;
}

/**
 * A summary's second reading, for the line breaks and tabs that JSON escaping hides: a structured result's
 * JSON writes each as two characters, so a credential or a scheme label right after one has no boundary,
 * and a credential split by one is not joined. The rules that a separator decides read a view of the
 * same length in which each such escape is its separator twice (`escapedSeparatorView`); their ranges
 * merge with those of the JSON reading, which reads a quoted value or a PEM block across the escapes.
 */
function visitEscapedSeparators(text: string, report: SecretSpanVisitor): void {
  const view = escapedSeparatorView(text);
  if (view === text) return;
  visitSplitCredentials(view, report);
  visitJoinedStandaloneCredentials(view, view, report);
  visitSchemeCredentials(view, report);
}

/**
 * `text` with each escaped line feed, carriage return or tab (`\n`, `\r`, `\t`) replaced by that separator
 * twice, so offsets stay valid. The backslash before the letter may end a longer run, as in a JSON text
 * inside a member (`\\n`) or a path (`C:\new`): the view only adds masks, and a mask needs a credential
 * after the separator. Each run of backslashes is read once.
 */
function escapedSeparatorView(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  for (let index = text.indexOf('\\'); index >= 0; index = text.indexOf('\\', index)) {
    let end = index;
    while (text[end] === '\\') end += 1;
    const letter = text[end];
    const separator =
      letter === 'n' ? '\n' : letter === 'r' ? '\r' : letter === 't' ? '\t' : undefined;
    if (separator !== undefined) {
      parts.push(text.slice(copied, end - 1), separator, separator);
      copied = end + 1;
    }
    index = end;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

/**
 * Signed-URL/webhook values can be opaque credentials under an unrecognised query key.
 * Preserve short values, parameter names and public delimiters/fragments. Once recognized,
 * mask the whole value: a fixed-length prefix leaves a permanent credential equality oracle.
 * Scan delimiters separately instead of matching a multi-megabyte repeated value in V8's
 * RegExp stack. Both cursors advance; short unrecognized values add only bounded overlap.
 * Parameters are read in `names`, which hides each URL userinfo's username (`UrlUserinfo.ownsUntil`);
 * a value is measured in `text`, so a mask inside it neither ends nor extends it.
 */
function visitOpaqueQueryValues(names: string, text: string, mask: SecretSpanVisitor): void {
  if (!names.includes('?') && !names.includes('&')) return;
  const prefix = /[?&][\w.-]{1,64}=/g;
  const delimiter = /[\s&#"',}\]]/g;
  for (let match = prefix.exec(names); match !== null; match = prefix.exec(names)) {
    const valueStart = prefix.lastIndex;
    delimiter.lastIndex = valueStart;
    const valueEnd = delimiter.exec(text)?.index ?? text.length;
    if (valueEnd - valueStart < 24) continue;
    mask(valueStart, valueEnd, '[redacted]');
    prefix.lastIndex = valueEnd;
  }
}

/** A PEM block's body is bounded, so an unterminated block cannot drive an unbounded scan. */
const PEM_BODY_MAX = 20_000;

/**
 * A PEM private-key block (multi-line, space-separated markers the `private_key` key-pattern can't see):
 * a BEGIN marker and the first END marker that starts at most PEM_BODY_MAX characters after it, which
 * is what one regex with a lazy bounded body finds. That regex rescanned the whole bounded body after
 * every unterminated BEGIN marker; here one END search serves every BEGIN marker before the END it
 * found, so the scan stays linear.
 */
function visitPemBlocks(text: string, mask: SecretSpanVisitor): void {
  if (!text.includes('-----BEGIN ')) return;
  const begin = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
  const end = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
  let found: RegExpExecArray | null | undefined;
  for (let marker = begin.exec(text); marker !== null; marker = begin.exec(text)) {
    const body = begin.lastIndex;
    if (found === undefined || (found !== null && found.index < body)) {
      end.lastIndex = body;
      found = end.exec(text);
    }
    if (found === null) return;
    if (found.index - body > PEM_BODY_MAX) {
      // Like the regex, try the next start: a later BEGIN marker may be close enough to this END.
      begin.lastIndex = marker.index + 1;
      continue;
    }
    const blockEnd = found.index + found[0].length;
    mask(marker.index, blockEnd, '[redacted]');
    begin.lastIndex = blockEnd;
  }
}

/**
 * An `Authorization`-style scheme + its token: `Bearer <t>` / `Basic <t>` / `Token <t>`. The token class
 * `[\w.~+/-]` is base64url + padding (`\w` folds `[A-Za-z0-9_]`). The range starts after the label, so
 * the label stays and one space separates it from the mask: `Bearer [redacted]`. The scan resumes
 * after the label rather than after the token: a label inside the token (`Bearer a/Bearer <t>`) starts
 * a credential that reaches past this one.
 * For every open-ended token minimum below, a bounded lookahead enforces the same floor before
 * one simple greedy run. V8 can exhaust its RegExp stack on an admitted-scale `{N,}` run; the
 * equivalent `(?=class{N})class+` form keeps the whole value instead of clipping a credential.
 */
function visitSchemeCredentials(text: string, mask: SecretSpanVisitor): void {
  // Whitespace follows every label, so a text without any has no scheme credential.
  if (!/\s/.test(text)) return;
  const scheme = new RegExp(SCHEME_CREDENTIAL);
  for (let match = scheme.exec(text); match !== null; match = scheme.exec(text)) {
    const labelEnd = match.index + (match[1]?.length ?? 0);
    mask(labelEnd, scheme.lastIndex, ' [redacted]');
    scheme.lastIndex = labelEnd;
  }
}

/**
 * Where the quoted value that opens at `start` ends: just past its closing quote on its line (`closed`),
 * at a `lineBreak` it does not cross (it may still close on a later line), or, without closing, at the
 * end of the string around it or of the text. A value opened by a plain quote (`"…"`, `'…'`) closes at
 * the first UNESCAPED matching quote: a backslash consumes exactly the next character, as in JSON's
 * escaped quotes and backslashes (otherwise `a\"secret-tail` left its tail exposed). A value opened by an
 * escaped quote (`\"…\"`, as JSON inside a JSON string writes it) is read one decoding level down: each
 * backslash pair is one character, an escaped backslash escapes the next one, an escaped `\n`/`\r` is a
 * line break, and only its escaped quote closes it. The raw quote of its kind or the raw line break,
 * behind a backslash or not, ends the string around it, which the value cannot cross. A raw quote of the
 * other kind does not end it: an apostrophe is ordinary text in a JSON string. A plain scan, because a
 * RegExp repeat over the value keeps backtracking state per character and exhausts V8's stack on an
 * admitted-size value.
 */
function quotedValueEnd(
  text: string,
  start: number,
): { readonly end: number; readonly closed: boolean; readonly lineBreak: boolean } {
  const escaped = text[start] === '\\';
  const quote = text[escaped ? start + 1 : start];
  // A raw line break stops a plain value; one JSON string down it ends the string around the value.
  const stop = (end: number): { end: number; closed: boolean; lineBreak: boolean } => ({
    end,
    closed: false,
    lineBreak: !escaped,
  });
  let escapeNext = false;
  for (let index = escaped ? start + 2 : start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\r' || char === '\n') return stop(index);
    if (char === quote)
      return escaped ? stop(index) : { end: index + 1, closed: true, lineBreak: false };
    if (char !== '\\') {
      escapeNext = false;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) break;
    if (next === '\n' || next === '\r') return stop(index + 1);
    if (escaped && (next === 'n' || next === 'r')) {
      return { end: index, closed: false, lineBreak: true };
    }
    index += 1;
    if (!escaped) continue;
    if (escapeNext) escapeNext = false;
    else if (next === quote) return { end: index + 1, closed: true, lineBreak: false };
    else escapeNext = next === '\\';
  }
  return { end: text.length, closed: false, lineBreak: false };
}

/** Where an unquoted value, and the run of a quoted one that does not close, ends: whitespace, a quote, `,`, `;`, `&`. */
function valueDelimiter(): RegExp {
  return /[\s"',;&]/g;
}

/**
 * A secret-ish key (`SECRET_KEY`) and its value: a whole quoted string (`quotedValueEnd`, also one JSON
 * string down), or an unquoted run of at least six characters up to whitespace, a quote, `,`, `;` or
 * `&`. A quoted value that does not close on its line, or one JSON string down before the end of the
 * string around it, is returned for the journal projection to decide once the pass's other ranges are
 * known (`visitUnclosedValues`). The summary's projection (`throughCloser`) masks such a value through a
 * later quote instead (`throughNearestCloser`). Keys are read in `keys`, which hides each URL
 * userinfo's username (`UrlUserinfo.ownsUntil`): a key there names the user
 * (`https://x-access-token:<t>@github.com/o/r`), and its value would run on through the public host and
 * path. Values are read in `values`, where every earlier mask is one run, as an applied mask would be,
 * and a quoted value also in `escapes`, where each such mask keeps the backslashes it ends with; it closes
 * at the later of the two (`laterClosing`). The key scan resumes at each value rather than after it, so a
 * key inside a value is read too: `token=a>password: <secret>` has a second value past the first one's
 * end. One delimiter scan serves every unquoted value, and a quoted value is scanned no further than its
 * line: a nested quoted value can only open at the closing quote of the one around it, and one that does
 * not close leaves no quote of its kind on its line, so the scan stays linear.
 */
function visitSecretKeyValues(
  keys: string,
  values: string,
  escapes: string,
  report: SecretSpanVisitor,
  throughCloser: boolean,
): readonly UnclosedValue[] {
  // Every key ends in `=` or `:`, so names without either have no value to read.
  if (!keys.includes('=') && !keys.includes(':')) return [];
  const key = new RegExp(SECRET_KEY);
  const delimiter = valueDelimiter();
  let delimiterAt = -1;
  const masked: SecretRange[] = [];
  const open: OpenValue[] = [];
  const unclosed: UnclosedValue[] = [];
  const mask = (start: number, end: number): void => {
    masked.push({ start, end, replacement: '[redacted]' });
    report(start, end, '[redacted]');
  };
  for (let match = key.exec(keys); match !== null; match = key.exec(keys)) {
    const valueStart = escapedValueStart(values, key.lastIndex);
    const escaped = values[valueStart] === '\\';
    const opening = escaped ? values[valueStart + 1] : values[valueStart];
    if (opening === '"' || opening === "'") {
      const value = quotedValueEnd(values, valueStart);
      const read =
        escapes === values ? value : laterClosing(value, quotedValueEnd(escapes, valueStart));
      const kind = escaped ? `\\${opening}` : opening;
      if (read.closed) mask(match.index, read.end);
      else if (!throughCloser)
        unclosed.push({ start: match.index, quote: valueStart, end: read.end });
      else if (read.lineBreak) open.push({ start: match.index, end: read.end, quote: kind });
      else mask(match.index, read.end);
      continue;
    }
    if (delimiterAt < valueStart) {
      delimiter.lastIndex = valueStart;
      delimiterAt = delimiter.exec(values)?.index ?? values.length;
    }
    if (delimiterAt - valueStart >= 6) mask(match.index, delimiterAt);
  }
  for (const range of throughNearestCloser(values, escapes, masked, open)) {
    report(range.start, range.end, '[redacted]');
  }
  return unclosed;
}

/** A key's quoted value that does not close on its line: from its key, where its quote opens, where it stops. */
interface UnclosedValue {
  readonly start: number;
  readonly quote: number;
  readonly end: number;
}

/**
 * The journal projection's masks for key values that do not close on their line (`visitSecretKeyValues`).
 * Each is read again in `closing`, where every other range of the pass is filled: a mask that takes its
 * line break (a scheme label's token, a nested key's value) joins its lines as the next pass would read
 * them, so a value that then closes is masked whole, as it was before this rule; it closes at the later of
 * that reading and the one where each range keeps the backslashes it ends with (`laterClosing`).
 * Otherwise it is read as an unquoted run from after its quote, in `values`, no further than where it
 * stopped: its quote may instead close a string the key sits in (`"token=" in prose`), and masking on
 * past the run would give calls that differ only in that later text one projection. A run starts right
 * after a quote, where the delimiter scan of every earlier run stops, so no two runs share a scan; a
 * reading in `closing` stops at the next quote that could close it, so the readings of one kind of quote
 * share none either.
 */
function visitUnclosedValues(
  text: string,
  values: string,
  ranges: readonly SecretRange[],
  unclosed: readonly UnclosedValue[],
  report: SecretSpanVisitor,
): void {
  const closing = fillRanges(text, ranges);
  const kept = keepingEscapes(text, ranges);
  const escapes = kept === ranges ? closing : fillRanges(text, kept);
  const delimiter = valueDelimiter();
  for (const value of unclosed) {
    const from = value.quote + (values[value.quote] === '\\' ? 2 : 1);
    // The quote itself may be inside another range, which then decides it.
    if (closing.slice(value.quote, from) === values.slice(value.quote, from)) {
      const first = quotedValueEnd(closing, value.quote);
      const reread =
        escapes === closing ? first : laterClosing(first, quotedValueEnd(escapes, value.quote));
      if (reread.closed) {
        report(value.start, reread.end, '[redacted]');
        continue;
      }
    }
    delimiter.lastIndex = from;
    const end = Math.min(delimiter.exec(values)?.index ?? values.length, value.end);
    if (end - from >= 6) report(value.start, end, '[redacted]');
  }
}

/**
 * Where a key's value starts: right after its separator, or one JSON string down behind escaped tabs and
 * line breaks (`password:\t\"…\"`, `password:\n  '…'`) when they end at an escaped quote or at an
 * apostrophe, which JSON leaves unescaped; that quote then opens the value. A plain scan over the run,
 * like `quotedValueEnd`'s.
 */
function escapedValueStart(text: string, start: number): number {
  let index = start;
  for (;;) {
    const char = text[index];
    const next = text[index + 1];
    if (char === ' ' || char === '\t') index += 1;
    else if (char === '\\' && (next === 't' || next === 'n' || next === 'r')) index += 2;
    else break;
  }
  const char = text[index];
  const opening = text[index + 1];
  const quoted = char === "'" || (char === '\\' && (opening === '"' || opening === "'"));
  return index > start && quoted ? index : start;
}

/** A key's quoted value that stops at a line break, from its key; its quote is `\"` one JSON string down. */
interface OpenValue {
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

/**
 * The kind of open value the quote at `index` could close, as `quotedValueEnd` decodes it: after an even
 * run of backslashes the quote is unescaped and may close a plain value; after a run of 4k+1 it closes a
 * value one JSON string down. Each run is read once, before the quote it escapes.
 */
function closingKind(text: string, index: number): string | undefined {
  const char = text[index];
  if (char !== '"' && char !== "'") return undefined;
  let backslashes = 0;
  while (text[index - 1 - backslashes] === '\\') backslashes += 1;
  if (backslashes % 2 === 0) return char;
  return backslashes % 4 === 1 ? `\\${char}` : undefined;
}

/**
 * The summary's masks for the `open` values (`redactSecretShapedSummaryText`). A summary is shown, never
 * compared, so each value is masked through the nearest later quote that could close it outside the
 * `masked` values, or, when every such quote is inside one, through the last of those, in its string or
 * not, and only else to the end of its line. Masked values that take every later quote leave what lies
 * between them uncertain (`token='\ntoken=''<secret>'`), so the summary masks through all of it. Like a
 * value that closes, it is read twice, with every mask filled and with each mask keeping the backslashes
 * it ends with (`escapes`), and masked through the later of the two (`laterClosing`). One backward scan,
 * from the end of the text to the earliest end of an open value; each run of backslashes is read once,
 * before the quote it escapes.
 */
function throughNearestCloser(
  values: string,
  escapes: string,
  masked: readonly SecretRange[],
  open: readonly OpenValue[],
): readonly { readonly start: number; readonly end: number }[] {
  if (open.length === 0) return [];
  const byEnd = open.toSorted((left, right) => right.end - left.end);
  const filled = fillRanges(values, masked);
  const kept = keepingEscapes(escapes, masked);
  const keptFilled = kept === masked && escapes === values ? filled : fillRanges(escapes, kept);
  // Where the nearest quote of each kind outside the masked values ends, and where the last one does, in
  // each reading.
  const outside = new Map<string, number>();
  const last = new Map<string, number>();
  const keptOutside = new Map<string, number>();
  const keptLast = new Map<string, number>();
  const ranges: { start: number; end: number }[] = [];
  let next = 0;
  for (let index = values.length - 1; next < byEnd.length; index -= 1) {
    for (let value = byEnd[next]; value !== undefined && value.end > index; value = byEnd[next]) {
      next += 1;
      const end = outside.get(value.quote) ?? last.get(value.quote) ?? value.end;
      const keptEnd = keptOutside.get(value.quote) ?? keptLast.get(value.quote) ?? value.end;
      ranges.push({ start: value.start, end: Math.max(end, keptEnd) });
    }
    const kind = closingKind(filled, index);
    if (kind !== undefined) outside.set(kind, index + 1);
    const raw = closingKind(values, index);
    if (raw !== undefined && !last.has(raw)) last.set(raw, index + 1);
    if (keptFilled === filled) continue;
    const keptKind = closingKind(keptFilled, index);
    if (keptKind !== undefined) keptOutside.set(keptKind, index + 1);
    const keptRaw = closingKind(escapes, index);
    if (keptRaw !== undefined && !keptLast.has(keptRaw)) keptLast.set(keptRaw, index + 1);
  }
  return ranges;
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
 * `=` assignment follows it; anything else may be a malformed username or password. This is the
 * same predicate as the LLM diagnostic backstop (`packages/llm/src/scrub-secrets.ts`). For such an
 * ambiguous userinfo the backstop masks through the authority's end unless a host-shaped name follows
 * its last `@`. This projection masks the userinfo and reads every key and parameter in it but its
 * username's; their values keep their own extent and the rules' ranges merge
 * (`https://gateway?password=P@ss.word1` projects to `https://[redacted]`).
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

function visitUrlUserinfo(text: string, mask: SecretSpanVisitor): void {
  if (!text.includes('://')) return;
  const scheme = /[a-z][\w+.-]{0,31}:\/\//gi;
  const delimiter = /[/\s"',}\]]/g;
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
    // Only a username owns its text: the part before the first ':' when no raw ?/# comes first. A key
    // there names the user (`https://x-access-token:<t>@github.com/o/r` keeps its host). A key in the
    // password, after a raw ?/# or in a userinfo with no username is read by the key/value and
    // opaque-query rules, which mask its value to its own end (`jdbc:…;password=P@ss;…`).
    const ownsUntil = colon >= 0 && (query < 0 || colon < query) ? colon : 0;
    mask(start, start + at, '[redacted]', {
      schemeStart: match.index,
      ownsUntil: start + ownsUntil,
    });
    // Skip the recognized userinfo without hiding a later scheme in the public host/tail.
    scheme.lastIndex = start + at + 1;
  }
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
  return redactSecretShapedWalk(value, new WeakSet<object>(), redactSecretShapedText);
}

/**
 * The journal projection of a tool's arguments (`redactSecretShapedValue`) and whether it settled. A string
 * whose projection still changes on its third pass becomes `[redacted]`, and two member names of one object
 * that project alike leave one member, either of which would give different calls one journal identity, so
 * the registry refuses such an effect before it is prepared
 * ([effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §11).
 */
export function projectSecretShapedValue(value: unknown): {
  readonly value: unknown;
  readonly settled: boolean;
} {
  let settled = true;
  const projected = redactSecretShapedWalk(
    value,
    new WeakSet<object>(),
    (text) => {
      const fixed = fixedPointOf(redactSecretShapedOnce, text);
      if (fixed !== undefined) return fixed;
      settled = false;
      return '[redacted]';
    },
    () => {
      settled = false;
    },
  );
  return { value: projected, settled };
}

/** How the walk projects each string: the display projection, or the journal's settle-checking one. */
type TextProjection = (text: string) => string;

/** What the walk puts in place of a value it masks whole: a credential member or a credential flag's argument. */
type WholeMask = (value: unknown) => string;

/** The journal's and the display's whole mask. */
const maskWhole: WholeMask = () => '[redacted]';

/**
 * The summary walk's whole mask (`toText`). It keeps a private-key END marker that may close a block opened
 * before the value and a BEGIN marker that may open one continuing after it, so the summary's text rules
 * still pair each with a marker in another member and mask the key's body there. A marker names a key
 * type, not key material; a block whose markers are both inside the value is masked with it.
 */
function maskWholeKeepingPemMarkers(value: unknown): string {
  if (typeof value !== 'string' || !value.includes('-----')) return '[redacted]';
  const begin = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
  const end = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
  let firstBegin: RegExpExecArray | undefined;
  let lastBegin: RegExpExecArray | undefined;
  for (let marker = begin.exec(value); marker !== null; marker = begin.exec(value)) {
    firstBegin ??= marker;
    lastBegin = marker;
  }
  let firstEnd: RegExpExecArray | undefined;
  let lastEnd: RegExpExecArray | undefined;
  for (let marker = end.exec(value); marker !== null; marker = end.exec(value)) {
    firstEnd ??= marker;
    lastEnd = marker;
  }
  const closing =
    firstEnd !== undefined && (firstBegin === undefined || firstBegin.index > firstEnd.index)
      ? firstEnd[0]
      : '';
  const opening =
    lastBegin !== undefined && (lastEnd === undefined || lastEnd.index < lastBegin.index)
      ? lastBegin[0]
      : '';
  return `${closing}[redacted]${opening}`;
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
function redactArgVector(
  items: readonly unknown[],
  seen: WeakSet<object>,
  project: TextProjection,
  collide: (() => void) | undefined,
  whole: WholeMask,
): unknown[] {
  const out: unknown[] = [];
  let redactNext: string | undefined;
  for (const item of items) {
    if (redactNext !== undefined) {
      out.push(redactCredentialArgument(redactNext, item, whole));
      redactNext = undefined;
      continue;
    }
    if (typeof item === 'string') {
      const separator = item.indexOf('=');
      const flag = separator > 0 ? item.slice(0, separator) : '';
      if (isSecretishFlag(flag)) {
        const value = item.slice(separator + 1);
        out.push(`${flag}=${redactCredentialArgument(flag, value, whole)}`);
        continue;
      }
      if (isSecretishFlag(item)) redactNext = item;
    }
    out.push(redactSecretShapedWalk(item, seen, project, collide, whole));
  }
  return out;
}

/** One credential-value rule for both argv spellings; only ambiguous -p may name a public port. */
function redactCredentialArgument(flag: string, value: unknown, whole: WholeMask): string {
  if (flag.toLowerCase() === '-p' && typeof value === 'string' && looksLikePort(value)) {
    return value;
  }
  return whole(value);
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
function redactUnderKey(
  key: string,
  item: unknown,
  seen: WeakSet<object>,
  project: TextProjection,
  collide: (() => void) | undefined,
  whole: WholeMask,
): unknown {
  if (!isSecretishKey(key) || item === null || item === undefined)
    return redactSecretShapedWalk(item, seen, project, collide, whole);
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
  return whole(item);
}

function redactSecretShapedWalk(
  value: unknown,
  seen: WeakSet<object>,
  project: TextProjection,
  // Reports two member names of one object that project alike, which leaves only the later member.
  collide?: () => void,
  whole: WholeMask = maskWhole,
): unknown {
  if (typeof value === 'string') return project(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[cyclic]'; // break the cycle (mirrors redactInlineMedia) — never re-emit the ref
  seen.add(value);
  try {
    if (Array.isArray(value)) return redactArgVector(value, seen, project, collide, whole);
    if (!isPlainObject(value)) return value; // Date/RegExp/Map/… — leave for native handling
    const out: Record<string, unknown> = {};
    // Scrub the KEY too (a secret-shaped key is redacted; a normal name is unchanged — see the doc above). A
    // Recognized credentials deliberately share a redacted projection; raw invocation keys stay unchanged.
    for (const [key, item] of Object.entries(value)) {
      // **The key decides, whatever the value's shape.** Checked BEFORE the walk, because the walk only
      // inspects strings by shape — so a numeric PIN, a nested credential object, or a high-entropy opaque
      // token with no recognisable prefix all survive it. `null`/`undefined` are left alone so an absent
      // field does not become a phantom `[redacted]` in a diagnostic.
      const name = project(key);
      if (Object.hasOwn(out, name)) collide?.();
      Object.defineProperty(out, name, {
        value: redactUnderKey(key, item, seen, project, collide, whole),
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

/**
 * Render any result to the text the model would see (a string is itself; else compact JSON) and to the text
 * its summary is made from. Inline media bytes are redacted first so the summary/spill/preview can never
 * carry base64 (I3). A non-string result's summary text is its JSON once the walk has masked every member
 * under a credential-named key and every argument after a credential flag whole (`redactSecretShapedWalk`),
 * which no text rule reads. The text rules then read the JSON as one text (`makeSummary`), a value one JSON
 * string down included, so a PEM block or a quoted value that runs across members keeps the context it is
 * read in; projecting each string alone would mask a key or a PEM marker that a later member's text needs.
 */
function toText(result: unknown): { readonly text: string; readonly summaryText: string } {
  if (typeof result === 'string') {
    const text = isBase64DataUri(result) ? '[base64 data URI omitted]' : result;
    return { text, summaryText: text };
  }
  if (result === undefined) {
    return { text: '', summaryText: '' };
  }
  let safe: unknown;
  try {
    // Always run the redaction walk for a non-string result (inside the try so a throwing getter/proxy
    // degrades to '[unserializable]' rather than escaping): it strips inline base64 sources, base64 data:
    // URIs, AND raw binary buffers at any nesting before JSON-serialisation, so no media bytes (base64 or
    // decimal) can ride the summary/spill/preview (I3). A non-media object is returned as a structural clone
    // (same JSON). Both texts are made from this one walk.
    safe = redactInlineMediaForText(result, new WeakSet<object>());
  } catch {
    return { text: '[unserializable]', summaryText: '[unserializable]' }; // throwing getter during redaction
  }
  return {
    text: jsonText(() => safe),
    summaryText: jsonText(() =>
      redactSecretShapedWalk(
        safe,
        new WeakSet<object>(),
        (text) => text,
        undefined,
        maskWholeKeepingPemMarkers,
      ),
    ),
  };
}

/**
 * JSON of a value, or `[unserializable]` for one that has no JSON form (JSON.stringify returns undefined for
 * a bare function/symbol; the `??` keeps a string without an `[object Object]`) or whose serialization throws
 * (a circular reference, a throwing toJSON).
 */
function jsonText(value: () => unknown): string {
  try {
    return JSON.stringify(value()) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

function makeSummary(text: string): string {
  // Recognize LF/TAB-split shapes in the complete materialized text before one-line normalization. Clip only after recognition: a closing quote or URL
  // authority separator can be beyond the preview. Raw model/spill text stays unchanged.
  const recognized = /[\n\t]/.test(text) ? redactSecretShapedSummaryText(text) : text;
  const oneLine = redactSecretShapedSummaryText(recognized.replace(/\s+/g, ' ').trim());
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
  const { text, summaryText } = toText(result);
  const summary = makeSummary(summaryText);
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
