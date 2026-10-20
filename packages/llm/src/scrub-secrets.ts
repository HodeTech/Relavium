import { stripTerminalControls } from '@relavium/shared/terminal-safe';

import { toFixedPoint } from './fixed-point.js';
import { splitProbe, type SplitProbe, type SplitProbeAnchor } from './split-credential-probe.js';

/** The marker every masked span becomes; a diagnostic that cannot be masked in place becomes it whole. */
const MASKED = '[REDACTED]';

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
 * this is not universal fragment discovery. Query names are excluded from the residual probe, but their
 * values are masked in the same merged pass as every other rule. One pass can glue a marker to the
 * text after another rule's token, so the scrub repeats until it reaches a fixed point within three
 * passes, failing closed otherwise: its output is stable under another scrub.
 * Pure and total for string input: regex matching, merged masking passes and a finite residual
 * check, with no parsing or external calls on the error path.
 * Asserted by `llm-error.test.ts` (the backstop) and each adapter's
 * secret-safety test (a planted secret → a secret-free surfaced `LlmError`); see security-review.md.
 * The canonical policy is error-handling.md's diagnostic secret backstop.
 */
export function scrubSecrets(text: string): string {
  return toFixedPoint(scrubOnce, text, MASKED);
}

/** A range of the original diagnostic that one rule masks with `[REDACTED]`. */
interface MaskRange {
  readonly start: number;
  readonly end: number;
}

interface SecretRule {
  readonly pattern: RegExp;
  /** The masked range of one match, relative to the match; `undefined` keeps the match. */
  readonly mask: (match: RegExpExecArray) => MaskRange | undefined;
  /** Whether a joined-view candidate is a credential; absent means every candidate is. */
  readonly credential?: (matched: string) => boolean;
  readonly joinedPattern?: RegExp;
  readonly boundary?: RegExp;
  /** Split-scanner prefilter: a match must reach this literal within its window (see `splitProbe`). */
  readonly anchor?: SplitProbeAnchor;
}

/** Mask the whole match. */
const WHOLE_MATCH = (match: RegExpExecArray): MaskRange => ({ start: 0, end: match[0].length });

/** Mask only the named `token` group of a `d`-flagged pattern, keeping its label or header around it. */
function tokenGroup(match: RegExpExecArray): MaskRange | undefined {
  const span = match.indices?.groups?.['token'];
  return span === undefined
    ? undefined
    : { start: span[0] - match.index, end: span[1] - match.index };
}

/**
 * Deliberately NOT word-bounded: the pre-PR http(s) matcher masked `xhttps://user:pass@host`, and a `\b`
 * here would let any scheme glued to a preceding word character through unmasked. PR #95 added
 * ws/wss/ftp/ftps under the same rule, and the PR95 increment added the connection-string schemes
 * (postgres(ql), mysql, mariadb, redis(s), mongodb(+srv), amqp(s), ssh, sftp, ldap(s), smtp(s)), whose
 * colonless userinfo names a user and stays visible (see `urlUserinfoRange`). Only `sftp` ends in another
 * listed scheme, the colonless `ftp`, and a word glued before it (`statusftp://`) still reads as `sftp`:
 * every whitespace-stripped probe (the residual below, the CLI's display residual) glues ordinary prose
 * to a scheme the same way, so reading it as `ftp` would blank `to sftp://user@host`. The rule has no
 * `\b` prefix, so it supplies its own joined form (the split-credential scanner would otherwise strip two
 * characters that are not there) and its `boundary` blocks no start. Consequences, pinned by tests and
 * fail-closed: an unlisted longer scheme name ending in a listed one (`gftp://u@h`) matches by suffix,
 * and the whitespace-stripped residual probe turns a path-less URL, prose and a later `@` into a
 * whole-diagnostic `[REDACTED]` (the pre-PR matcher did so for http(s); dropping `\b` extends it to
 * prose that stripping glues to the scheme). A credential split by a plain SPACE that also holds a raw `@` remains the documented
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

/**
 * One private authority per existing credential family, shared by probes and output masking. Every
 * rule finds its matches in the original diagnostic and the masked ranges of all rules are merged
 * before anything is replaced, so no rule can erase the context another rule needs, whatever their
 * order. A token rule masks only its token, so its label or header name stays visible, and masking a
 * token that is already exactly `[REDACTED]` changes nothing: every masked token is a fixed point.
 */
const NON_QUERY_SECRET_RULES: readonly SecretRule[] = [
  // OpenAI sk-/sk-proj-/sk-svcacct- and Anthropic sk-ant- key prefixes.
  {
    pattern: /\bsk-(?=[\w-]{16})[\w-]+/g,
    mask: WHOLE_MATCH,
    boundary: /\w/,
  },
  {
    pattern: /\bAIza(?=[\w-]{20})[\w-]+/g,
    mask: WHOLE_MATCH,
    boundary: /\w/,
  },
  // Finite authority schemes, not URL validation. Raw ?/# before the first @ may belong
  // to a username or password; after an existing @ they begin public query/fragment text.
  {
    pattern: URL_USERINFO_PATTERN,
    joinedPattern: URL_USERINFO_PATTERN,
    mask: (match) => urlUserinfoRange(match[0], () => authorityRest(match)),
    credential: (matched) => urlUserinfoRange(matched, () => '') !== undefined,
    boundary: NO_BOUNDARY,
    anchor: { text: '://', window: URL_SCHEME_WINDOW },
  },
  // Exact literal header names, also in quoted or JSON-escaped diagnostic objects. No arbitrary
  // header discovery. A value may begin with up to eight Bearer/Basic labels (possibly quoted,
  // escaped, glued behind punctuation, LF/TAB-split or a concatenated run of up to eight, as in
  // `BearerBearer`), as a doubled `Bearer Bearer` misconfiguration does; the token after them is
  // masked and the labels stay. The token may begin with any run of (escaped) quotes, is never a
  // label, a run of labels or another header name, and ends at a delimiter, at escapes before one or
  // before a header name glued to it, which then masks its own value. Every label repetition is
  // bounded so no label run can exhaust the RegExp stack: past eight separate labels the standalone
  // label rule masks the token after the last one, and nine concatenated labels blank the diagnostic
  // (`LABEL_RUN_PAST_BOUND`).
  {
    pattern:
      /(?<![A-Za-z0-9_-])(?:(?:x-)?api-key|x-goog-api-key)\\*["']?\s*:\s*["']?(?:[^\w\s]*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)(?:[\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)){0,7}[\\"']*\s+){0,8}(?![^\w\s]*(?:(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)[\\"']*){1,8}(?:\s|$))[\\"']*(?!(?<=[^A-Za-z0-9_-])(?:(?:x-)?api-key|x-goog-api-key)\\*["']?\s*:)(?<token>[^\s"',;}\\][^\s"',;}]*?)(?=(?<=[^A-Za-z0-9_-])(?:(?:x-)?api-key|x-goog-api-key)\\*["']?\s*:|\\{0,15}[\s"',;}]|\\{0,15}$)/dgi,
    mask: tokenGroup,
    joinedPattern: /(?:(?:x-)?api-key|x-goog-api-key)\\*["']?\s*:/gi,
    boundary: /[A-Za-z0-9_-]/,
  },
  // One standalone rule for both labels, so neither can drift from the other. LF/TAB may split the
  // finite scheme LABEL, a label may be closed by its own quote before the whitespace
  // (`"Bearer" <token>`), and a run of up to eight concatenated labels (`BearerBearer`) counts as one
  // label. Preserve the required label/value separator and ordinary following prose; opaque value
  // fragments cannot be distinguished from that prose. A label never takes another label as its
  // token, even one glued behind punctuation, quoted or concatenated, so any number of stacked labels
  // leaves the last one to mask the token, and a token ends before a label (or a concatenated run)
  // glued to it behind a non-word character, which then masks its own token. Quotes and `,;}`
  // around a token stay outside it unless it continues past them, so `[REDACTED];tail` is masked
  // whole.
  {
    pattern:
      /\b(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)(?:[\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)){0,7}[\\"']*\s+(?![^\w\s]*(?:(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)[\\"']*){1,8}(?:\s|$))[\\"']*(?<token>(?=[^\s\\"'])\S*?[^\s\\"',;}])[\\"',;}]*(?=(?<=[^\w])(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)(?:[\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)){0,7}[\\"']*(?:\s|$)|\s|$)/dgi,
    mask: tokenGroup,
  },
];

/**
 * Exact literal query names with exact boundaries, so benign suffixes stay; no URL-name decoding.
 * Their values join the merged masking pass, but no probe joins query names or ordinary query prose.
 */
const QUERY_SECRET_RULE: SecretRule = {
  pattern:
    /[?&](?:(?:x[-_])?api[-_]?key|api[-_]?secret|(?:access|secret)[-_]?key|(?:access|refresh|id|auth|session)[-_]?token|client[-_]?secret|key|token|auth|password|secret)=(?<token>[^&\s#]+)/dgi,
  mask: tokenGroup,
};

/** The merged pass masks the ranges of every rule; the probes run only over the non-query rules. */
const SECRET_RULES: readonly SecretRule[] = [...NON_QUERY_SECRET_RULES, QUERY_SECRET_RULE];

/**
 * Nine concatenated labels (`BearerBearer…`, possibly with quotes or escapes between them) exceed
 * every bounded label run above, so the token after them cannot be told from them: fail closed.
 */
const LABEL_RUN_PAST_BOUND =
  /(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)(?:[\\"']*(?:B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c)){8}/i;

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
 * (`https://host.example#sec@x`, failing closed) are masked under the rest of `urlUserinfoRange`'s policy.
 * Core's journal projection applies the same predicate (`packages/core/src/tools/bounding.ts`).
 */
function isPublicQueryContact(userinfo: string, query: number): boolean {
  // A longer prefix cannot be a hostname, and an unbounded dotted run would exhaust V8's RegExp
  // backtrack stack at admitted size; such a prefix stays userinfo, which fails closed.
  if (query > HOST_SHAPED_MAX_LENGTH) return false;
  return HOST_SHAPED_AUTHORITY.test(userinfo.slice(0, query)) && userinfo.includes('=', query + 1);
}

/** An authority's text after its last `@`, up to a path, whitespace, a quote, `,` or `}`, as in core. */
const AUTHORITY_REST = /[^/\s"',}]*/y;

function authorityRest(match: RegExpExecArray): string {
  AUTHORITY_REST.lastIndex = match.index + match[0].length;
  return AUTHORITY_REST.exec(match.input)?.[0] ?? '';
}

/** Whether an authority's text after its last `@` begins with a host, up to any query or fragment. */
function hostFollows(rest: string): boolean {
  const end = rest.search(/[?#]/);
  const host = end < 0 ? rest : rest.slice(0, end);
  // Bounded like the contact prefix, so an admitted-size run cannot exhaust the RegExp stack.
  return host.length <= HOST_SHAPED_MAX_LENGTH && HOST_SHAPED_AUTHORITY.test(host);
}

/**
 * The userinfo range of one finite-scheme URL match, or `undefined` when the policy keeps it: a
 * public query contact, a connection string's colonless user or already-masked userinfo. `rest`
 * reads the authority after the match.
 */
function urlUserinfoRange(match: string, rest: () => string): MaskRange | undefined {
  const start = match.indexOf('://') + 3;
  const authority = match.slice(start);
  const firstQuery = authority.search(/[?#]/);
  const authorityAt = firstQuery < 0 ? -1 : authority.lastIndexOf('@', firstQuery - 1);
  const at = authorityAt >= 0 ? authorityAt : authority.length - 1;
  const userinfo = authority.slice(0, at);
  const query = userinfo.search(/[?#]/);
  if (query >= 0 && isPublicQueryContact(userinfo, query)) return undefined;
  const colonless = COLONLESS_USERINFO_SCHEME.test(match.slice(0, start - 3));
  const colon = userinfo.indexOf(':');
  // A connection string's colonless userinfo names a user (`ssh://git@host`), not a credential.
  if (colon < 0 && !colonless) return undefined;
  // Already-masked userinfo stays as it is: an exactly masked password under a connection-string
  // scheme, whose usernames are public, or a masked or empty username beside it under any scheme.
  // The authored-content detector's projection `postgres://app:[REDACTED]@db` is a fixed point.
  const username = userinfo.slice(0, Math.max(colon, 0));
  if (
    colon >= 0 &&
    userinfo.slice(colon + 1) === MASKED &&
    (!colonless || username === '' || username === MASKED)
  )
    return undefined;
  if (query < 0) return { start, end: start + at };
  // A raw ?/# leaves the authority ambiguous: unless a host follows its last `@`, the text there may
  // be the rest of a query value (`https://svc?password=P@ss`), so the mask runs through it.
  const tail = rest();
  return { start, end: start + at + (hostFollows(tail) ? 0 : 1 + tail.length) };
}

/** Every masked range of one rule's matches in `text`. */
function ruleRanges(text: string, rule: SecretRule): MaskRange[] {
  const ranges: MaskRange[] = [];
  for (const match of text.matchAll(rule.pattern)) {
    const range = rule.mask(match);
    if (range !== undefined) {
      ranges.push({ start: match.index + range.start, end: match.index + range.end });
    }
  }
  return ranges;
}

/** Replace each run of overlapping ranges with one `[REDACTED]`; the rest of `text` is kept. */
function maskRanges(text: string, ranges: readonly MaskRange[]): string {
  const ordered = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let output = '';
  let cursor = 0;
  let open: { start: number; end: number } | undefined;
  for (const range of ordered) {
    if (open !== undefined && range.start < open.end) {
      open.end = Math.max(open.end, range.end);
      continue;
    }
    if (open !== undefined) {
      output += text.slice(cursor, open.start) + MASKED;
      cursor = open.end;
    }
    open = { start: range.start, end: range.end };
  }
  if (open === undefined) return text;
  return output + text.slice(cursor, open.start) + MASKED + text.slice(open.end);
}

function applyRule(text: string, rule: SecretRule): string {
  return maskRanges(text, ruleRanges(text, rule));
}

/**
 * Probe LF/TAB joins at eligible ORIGINAL starts before a greedy match can hide a later boundary.
 * All boundary-bearing rules use this scanner and their canonical matcher (or finite header-label
 * override), compiled once into `SPLIT_PROBES` (`splitProbe` rejects a rule with no joined form).
 * Prefixes start with ASCII letters;
 * that prefilter skips only impossible starts.
 * Keys have one token run after a bounded prefix/minimum. Header labels are bounded and their
 * trailing whitespace cannot contain another label. URL authority excludes slash, so a later URL
 * prefix delimits a failed authority scan. Successful matches advance both cursors over their span,
 * except a kept candidate whose first letter ends a line, which advances one start, once per start;
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
        // A candidate the policy keeps (a connection string's user, a public contact) whose first
        // letter ends a line may be a word glued across the break to a shorter listed scheme
        // (`files\nftp://` reads as `sftp://`), so the next start is tried instead of its span.
        if (
          /[\n\t]/.test(text[originalOffset + 1] ?? '') &&
          rule.credential !== undefined &&
          !rule.credential(match[0])
        ) {
          originalOffset += 1;
          joinedOffset += 1;
          continue;
        }
        const start = originalOffset;
        const joinedStart = joinedOffset;
        while (joinedOffset < pattern.lastIndex) {
          const next = text[originalOffset++];
          if (next !== '\n' && next !== '\t') joinedOffset += 1;
        }
        if (
          originalOffset - start > joinedOffset - joinedStart &&
          // A malformed URL candidate may actually be a public contact query.
          (rule.credential === undefined || rule.credential(match[0]))
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

/**
 * One merged masking pass. Every non-query rule probes the original diagnostic first; then the ranges
 * of every rule, the literal query names' included, come from the original text and are merged, so no
 * rule erases the context another rule needs.
 */
function scrubOnce(text: string): string {
  const normalized = normalizeSecretProbe(text);
  if (LABEL_RUN_PAST_BOUND.test(normalized)) return MASKED;
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
  return maskRanges(
    text,
    SECRET_RULES.flatMap((rule) => ruleRanges(text, rule)),
  );
}
