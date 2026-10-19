import { stripTerminalControls } from '@relavium/shared/terminal-safe';

import { splitProbe, type SplitProbe, type SplitProbeAnchor } from './split-credential-probe.js';

/**
 * Defense-in-depth secret scrub applied at the one `makeLlmError` choke point. The CALLER (adapter) is
 * still responsible for passing an already-redacted message; this is the **structural backstop** — like
 * the engine's `deInlineMedia` pass, leak-freedom here is an active transform at one boundary, not
 * per-adapter discipline. It masks finite common secret **shapes**: prefixed keys, literal secret query
 * names, URL userinfo of a finite scheme list and finite API-key/Bearer/Basic headers. Each non-query rule probes
 * the original diagnostic independently, including terminal-normalized and LF/TAB-joined views, before any
 * other rule can erase its identifying context. A match revealed by normalization masks the whole
 * diagnostic. The finite patterns check boundaries in the original text (the URL rule has none, like the
 * pre-PR matcher, so a scheme glued to a word character is masked in place) and preserve already-masked spans;
 * this is not universal fragment discovery. Query names are excluded from the residual probe.
 * Pure and total for string input: regex replacements and a
 * finite residual check, with no parsing or external calls on the error path.
 * Asserted by `llm-error.test.ts` (the backstop) and each adapter's
 * secret-safety test (a planted secret → a secret-free surfaced `LlmError`); see security-review.md.
 * The canonical policy is error-handling.md's diagnostic secret backstop.
 */
export function scrubSecrets(text: string): string {
  return scrubQuerySecrets(scrubNonQuerySecrets(text));
}

interface SecretRule {
  readonly pattern: RegExp;
  readonly replacement: string | ((match: string) => string);
  readonly joinedPattern?: RegExp;
  readonly boundary?: RegExp;
  /** Split-scanner prefilter: a match must reach this literal within its window (see `splitProbe`). */
  readonly anchor?: SplitProbeAnchor;
}

/**
 * Deliberately NOT word-bounded: the pre-PR http(s) matcher masked `xhttps://user:pass@host`, and a `\b`
 * here would let any scheme glued to a preceding word character through unmasked. PR #95 added
 * ws/wss/ftp/ftps under the same rule, and the PR95 increment added the connection-string schemes
 * (postgres(ql), mysql, mariadb, redis(s), mongodb(+srv), amqp(s), ssh, sftp, ldap(s), smtp(s)), whose
 * colonless userinfo names a user and stays visible (see `maskUrlUserinfo`). The rule has no `\b` prefix,
 * so it supplies its own joined form (the split-credential scanner would otherwise strip two characters
 * that are not there) and its `boundary` blocks no start. Consequences, pinned by tests and fail-closed: an
 * unlisted longer scheme name ending in a listed one (`gftp://u@h`) matches by suffix, and the
 * whitespace-stripped residual probe turns a path-less URL, prose and a later `@` into a whole-diagnostic
 * `[REDACTED]` (the pre-PR matcher did so for http(s); dropping `\b` extends it to prose that stripping glues
 * to the scheme). A credential split by a plain SPACE that also holds a raw `@` remains the documented
 * opaque-fragments-across-spaces limit, as it was for the pre-PR matcher.
 */
const URL_USERINFO_PATTERN =
  /(?:https?|wss?|ftps?|postgres(?:ql)?|mysql|mariadb|rediss?|mongodb(?:\+srv)?|amqps?|ssh|sftp|ldaps?|smtps?):\/\/[^/\s]*@/gi;

/** The schemes whose colonless userinfo is masked too; every other listed scheme needs a `:` in it. */
const COLONLESS_USERINFO_SCHEME = /^(?:https?|wss?|ftps?)$/i;

/**
 * Every listed scheme ends within this many joined characters before its `://`, so the split scanner
 * tries no URL start farther away. It is generous on purpose: the longest scheme (`mongodb+srv`) has 11.
 */
const URL_SCHEME_WINDOW = 32;

/** A start boundary that never matches: no preceding character makes a start ineligible. */
const NO_BOUNDARY = /(?!)/;

/** One private authority per existing credential family, shared by probes and output masking. */
const NON_QUERY_SECRET_RULES: readonly SecretRule[] = [
  // OpenAI sk-/sk-proj-/sk-svcacct- and Anthropic sk-ant- key prefixes.
  {
    pattern: /\bsk-(?=[\w-]{16})[\w-]+/g,
    replacement: '[REDACTED]',
    boundary: /\w/,
  },
  {
    pattern: /\bAIza(?=[\w-]{20})[\w-]+/g,
    replacement: '[REDACTED]',
    boundary: /\w/,
  },
  // Finite authority schemes, not URL validation. Raw ?/# before the first @ may belong
  // to a username or password; after an existing @ they begin public query/fragment text.
  {
    pattern: URL_USERINFO_PATTERN,
    joinedPattern: URL_USERINFO_PATTERN,
    replacement: maskUrlUserinfo,
    boundary: NO_BOUNDARY,
    anchor: { text: '://', window: URL_SCHEME_WINDOW },
  },
  // Exact literal header names, also in quoted diagnostic objects. No arbitrary header discovery.
  // A value may begin with up to eight (possibly quoted, escaped or LF/TAB-split) Bearer/Basic labels,
  // as a doubled `Bearer Bearer` misconfiguration does: the labels and the token after them are masked
  // together, and the token may itself begin with (escaped) quotes, as in a JSON-encoded value. The
  // token is never another label, so a ninth label fails this rule rather than leak the token (the
  // label rules and the residual probe then mask it), and never an already-masked `[REDACTED]`, which
  // stays a fixed point. The repetition is bounded so no label run can exhaust the RegExp stack.
  {
    pattern:
      /(^|[^A-Za-z0-9_-])((?:x-)?api-key|x-goog-api-key)(["']?\s*:\s*["']?)(?:[\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)\s+){0,8}(?![\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)(?:\s|$))(?![\\"']*\[REDACTED\](?:[\s"',;}]|$))(?:\\*["'])?[^\s"',;}]+/gi,
    replacement: '$1$2$3[REDACTED]',
    joinedPattern: /(?:(?:x-)?api-key|x-goog-api-key)["']?\s*:/gi,
    boundary: /[A-Za-z0-9_-]/,
  },
  // LF/TAB may split the finite scheme LABEL. Preserve the required label/value separator and
  // ordinary following prose; opaque value fragments cannot be distinguished from that prose. A
  // label never takes another label as its token, so any number of stacked labels
  // (`Bearer Bearer <token>`) leaves the last one to mask the token, with no repetition to bound,
  // and an already-masked token stays a fixed point.
  {
    pattern:
      /\bB[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r\s+(?![\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)(?:\s|$))(?![\\"']*\[REDACTED\](?:[\s"',;}]|$))\S+/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    pattern:
      /\bB[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c\s+(?![\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)(?:\s|$))(?![\\"']*\[REDACTED\](?:[\s"',;}]|$))\S+/gi,
    replacement: 'Basic [REDACTED]',
  },
];

/**
 * Each boundary-bearing rule compiled once for the split scanner. `splitProbe` checks the scanner's
 * two invariants here, at module load, so a misconfigured rule fails fast with a typed error instead of
 * a `SyntaxError` inside `makeLlmError` on some later LF/TAB diagnostic.
 */
const SPLIT_PROBES: ReadonlyMap<SecretRule, SplitProbe> = new Map(
  NON_QUERY_SECRET_RULES.flatMap((rule) =>
    rule.boundary === undefined
      ? []
      : [[rule, splitProbe({ ...rule, boundary: rule.boundary })] as const],
  ),
);

/** Reuse the display boundary's platform-free normalization without changing benign output. */
function normalizeSecretProbe(text: string): string {
  return stripTerminalControls(text);
}

/** A host-shaped prefix: a dotted name (or IPv4), `localhost` or a bracketed IP literal, with an optional port. */
const HOST_SHAPED_AUTHORITY =
  /^(?:[a-z\d-]+(?:\.[a-z\d-]+)+\.?|localhost|\[[\da-f:.]+\])(?::\d{1,5})?$/i;

/** A DNS name has at most 253 characters (254 with a trailing dot), and a `:port` adds at most six. */
const HOST_SHAPED_MAX_LENGTH = 260;

/**
 * A raw `?`/`#` before the authority `@` begins public query or fragment text only when the text
 * before it is host-shaped **and** an `=` assignment follows it, as in
 * `https://host.example?contact=a@b.example`. Otherwise the text is userinfo: `https://us?er:TOKEN@h/`,
 * `http://#TOKEN@h`, `https://my.user:1234?TOKEN@h/` and a host fragment without an assignment
 * (`https://host.example#sec@x`, failing closed) are masked under the rest of `maskUrlUserinfo`'s policy.
 * Core's journal projection applies the same predicate (`packages/core/src/tools/bounding.ts`).
 */
function isPublicQueryContact(userinfo: string, query: number): boolean {
  // A longer prefix cannot be a hostname, and an unbounded dotted run would exhaust V8's RegExp
  // backtrack stack at admitted size; such a prefix stays userinfo, which fails closed.
  if (query > HOST_SHAPED_MAX_LENGTH) return false;
  return HOST_SHAPED_AUTHORITY.test(userinfo.slice(0, query)) && userinfo.includes('=', query + 1);
}

const MASKED = '[REDACTED]';

function maskUrlUserinfo(match: string): string {
  const start = match.indexOf('://') + 3;
  const authority = match.slice(start);
  const firstQuery = authority.search(/[?#]/);
  const authorityAt = firstQuery < 0 ? -1 : authority.lastIndexOf('@', firstQuery - 1);
  const at = authorityAt >= 0 ? authorityAt : authority.length - 1;
  const userinfo = authority.slice(0, at);
  const query = userinfo.search(/[?#]/);
  if (query >= 0 && isPublicQueryContact(userinfo, query)) return match;
  const colonless = COLONLESS_USERINFO_SCHEME.test(match.slice(0, start - 3));
  const colon = userinfo.indexOf(':');
  // A connection string's colonless userinfo names a user (`ssh://git@host`), not a credential.
  if (colon < 0 && !colonless) return match;
  // Already-masked userinfo stays as it is: an exactly masked password under a connection-string
  // scheme, whose usernames are public, or a masked or empty username beside it under any scheme.
  // The authored-content detector's projection `postgres://app:[REDACTED]@db` is a fixed point.
  const username = userinfo.slice(0, Math.max(colon, 0));
  if (
    colon >= 0 &&
    userinfo.slice(colon + 1) === MASKED &&
    (!colonless || username === '' || username === MASKED)
  )
    return match;
  return `${match.slice(0, start)}${MASKED}${authority.slice(at)}`;
}

function applyRule(text: string, rule: SecretRule): string {
  const replacement = rule.replacement;
  return typeof replacement === 'string'
    ? text.replace(rule.pattern, replacement)
    : text.replace(rule.pattern, (match) => replacement(match));
}

/**
 * Probe LF/TAB joins at eligible ORIGINAL starts before a greedy match can hide a later boundary.
 * All boundary-bearing rules use this scanner and their canonical matcher (or finite header-label
 * override), compiled once into `SPLIT_PROBES` (`splitProbe` rejects a rule with no joined form).
 * Prefixes start with ASCII letters;
 * that prefilter skips only impossible starts.
 * Keys have one token run after a bounded prefix/minimum. Header labels are bounded and their
 * trailing whitespace cannot contain another label. URL authority excludes slash, so a later URL
 * prefix delimits a failed authority scan. Successful matches advance both cursors over their span;
 * no failed candidate rescans an admitted-size run at every LF/TAB boundary.
 * Opaque Bearer/Basic values and literal query names keep their established delimiter policy.
 */
function hasSplitCredential(text: string, joined: string, rule: SecretRule): boolean {
  const probe = SPLIT_PROBES.get(rule);
  if (rule.boundary === undefined || probe === undefined) return false;
  // Absence under the same boundary-free canonical matcher proves there is no joined
  // candidate. Presence still requires the original-boundary and split checks below.
  // Native scanning avoids a JS/coverage branch for every byte of unrelated large text.
  if (!probe.preflight.test(joined)) return false;
  const pattern = probe.sticky;
  // Only a rule whose boundary rejects every ASCII word character may skip word-preceded starts;
  // `splitProbe` refused any boundary that treats some word characters differently from others.
  const wordBlocksStart = probe.wordBlocksStart;
  const anchor = probe.anchor;
  let anchorAt = -1;
  let originalOffset = 0;
  let joinedOffset = 0;
  while (originalOffset < text.length) {
    const char = text[originalOffset];
    if (char === '\n' || char === '\t') {
      originalOffset += 1;
      continue;
    }
    // An anchored rule (the URL rule's `://`) can match only within its window before the next
    // anchor. Past the last anchor no match can start, and letter-heavy text far from any anchor is
    // skipped without a RegExp attempt per character.
    if (anchor !== undefined && anchorAt < joinedOffset) {
      anchorAt = joined.indexOf(anchor.text, joinedOffset);
      if (anchorAt < 0) return false;
    }
    // The key and header boundary classes reject ASCII word characters. Skip those impossible
    // starts without allocating/testing RegExp objects for every admitted-size character;
    // the rule's own boundary and canonical matcher still decide every eligible start. The URL
    // rule blocks no start, so a glued scheme (`xhttps://`) is examined like any other.
    const code = text.charCodeAt(originalOffset);
    const previous = text.charCodeAt(originalOffset - 1);
    const letter =
      ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) &&
      (anchor === undefined || anchorAt - joinedOffset <= anchor.window);
    const previousWord =
      wordBlocksStart &&
      ((previous >= 48 && previous <= 57) ||
        (previous >= 65 && previous <= 90) ||
        (previous >= 97 && previous <= 122) ||
        previous === 95);
    if (letter && !previousWord && !rule.boundary.test(text[originalOffset - 1] ?? '')) {
      pattern.lastIndex = joinedOffset;
      const match = pattern.exec(joined);
      if (match !== null) {
        const start = originalOffset;
        const joinedStart = joinedOffset;
        while (joinedOffset < pattern.lastIndex) {
          const next = text[originalOffset++];
          if (next !== '\n' && next !== '\t') joinedOffset += 1;
        }
        if (
          originalOffset - start > joinedOffset - joinedStart &&
          // A malformed URL candidate may actually be a public contact query.
          (typeof rule.replacement !== 'function' || rule.replacement(match[0]) !== match[0])
        )
          return true;
        continue;
      }
    }
    originalOffset += 1;
    joinedOffset += 1;
  }
  return false;
}

function scrubNonQuerySecrets(text: string): string {
  const normalized = normalizeSecretProbe(text);
  const joined = /[\n\t]/.test(normalized) ? normalized.replace(/[\n\t]+/g, '') : undefined;
  for (const rule of NON_QUERY_SECRET_RULES) {
    const rawMasked = applyRule(text, rule);
    // Identical inputs have identical pure projections; unchanged raw text already has
    // its normalized view. Reuse these results rather than rescan large public diagnostics.
    const normalizedMasked = normalized === text ? rawMasked : applyRule(normalized, rule);
    if ((rawMasked === text ? normalized : normalizeSecretProbe(rawMasked)) !== normalizedMasked)
      return '[REDACTED]';
    if (joined !== undefined && hasSplitCredential(normalized, joined, rule)) return '[REDACTED]';
    // Retain the existing broader whitespace probe only within this rule's still-unmasked spans.
    // It detects incomplete prefixes separated by spaces without consuming prose after a full mask.
    for (const remaining of normalizedMasked.split('[REDACTED]')) {
      const residual = remaining.replace(/\s+/g, '');
      if (applyRule(residual, rule) !== residual) return '[REDACTED]';
    }
  }
  return NON_QUERY_SECRET_RULES.reduce((masked, rule) => applyRule(masked, rule), text);
}

/** Exact literal query names, applied last so a value cannot erase another family's evidence. */
function scrubQuerySecrets(text: string): string {
  return text.replace(
    /([?&](?:(?:x[-_])?api[-_]?key|api[-_]?secret|(?:access|secret)[-_]?key|(?:access|refresh|id|auth|session)[-_]?token|client[-_]?secret|key|token|auth|password|secret)=)[^&\s#]+/gi,
    '$1[REDACTED]',
  ); // Finite literal names; exact boundaries preserve benign suffixes. No URL-name decoding.
}
