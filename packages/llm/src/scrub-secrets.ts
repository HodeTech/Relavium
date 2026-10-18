import { stripTerminalControls } from '@relavium/shared/terminal-safe';

/**
 * Defense-in-depth secret scrub applied at the one `makeLlmError` choke point. The CALLER (adapter) is
 * still responsible for passing an already-redacted message; this is the **structural backstop** — like
 * the engine's `deInlineMedia` pass, leak-freedom here is an active transform at one boundary, not
 * per-adapter discipline. It masks finite common secret **shapes**: prefixed keys, literal secret query
 * names, URL userinfo and finite API-key/Bearer/Basic headers. Each non-query rule probes the original diagnostic
 * independently, including terminal-normalized and LF/TAB-joined views, before any
 * other rule can erase its identifying context. A match revealed by normalization masks the whole
 * diagnostic. The finite patterns check boundaries in the original text and preserve already-masked spans;
 * this is not universal fragment discovery. Query names are excluded from the residual probe.
 * Pure and total for string input: regex replacements and a
 * finite residual check, with no parsing or external calls on the error path.
 * Asserted by `llm-error.test.ts` (the backstop) and each adapter's
 * secret-safety test (a planted secret → a secret-free surfaced `LlmError`); see security-review.md.
 */
export function scrubSecrets(text: string): string {
  return scrubQuerySecrets(scrubNonQuerySecrets(text));
}

interface SecretRule {
  readonly pattern: RegExp;
  readonly replacement: string | ((match: string) => string);
  readonly joinedPattern?: RegExp;
  readonly boundary?: RegExp;
}

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
  // to a password; after an existing @ they begin public query/fragment text.
  {
    pattern: /\b(?:https?|wss?|ftps?):\/\/[^/\s]*@/gi,
    replacement: maskUrlUserinfo,
    boundary: /\w/,
  },
  // Exact literal header names, also in quoted diagnostic objects. No arbitrary header discovery.
  {
    pattern: /(^|[^A-Za-z0-9_-])((?:x-)?api-key|x-goog-api-key)(["']?\s*:\s*["']?)[^\s"',;}]+/gi,
    replacement: '$1$2$3[REDACTED]',
    joinedPattern: /(?:(?:x-)?api-key|x-goog-api-key)["']?\s*:/gi,
    boundary: /[A-Za-z0-9_-]/,
  },
  // LF/TAB may split the finite scheme LABEL. Preserve the required label/value separator and
  // ordinary following prose; opaque value fragments cannot be distinguished from that prose.
  {
    pattern: /\bB[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r\s+\S+/gi,
    replacement: 'Bearer [REDACTED]',
  },
  { pattern: /\bB[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c\s+\S+/gi, replacement: 'Basic [REDACTED]' },
];

/** Reuse the display boundary's platform-free normalization without changing benign output. */
function normalizeSecretProbe(text: string): string {
  return stripTerminalControls(text);
}

function isPublicHostPort(text: string): boolean {
  const colon = text.lastIndexOf(':');
  if (colon < 0 || !/^\d{1,5}$/.test(text.slice(colon + 1))) return false;
  const hostname = text.slice(0, colon);
  return hostname.includes('.') || hostname === 'localhost' || /^\[[\da-f:]+\]$/i.test(hostname);
}

function maskUrlUserinfo(match: string): string {
  const start = match.indexOf('://') + 3;
  const authority = match.slice(start);
  const firstQuery = authority.search(/[?#]/);
  const authorityAt = firstQuery < 0 ? -1 : authority.lastIndexOf('@', firstQuery - 1);
  const at = authorityAt >= 0 ? authorityAt : authority.length - 1;
  const userinfo = authority.slice(0, at);
  const query = userinfo.search(/[?#]/);
  const colon = userinfo.indexOf(':');
  // Raw ?/# may occur inside a malformed password. Preserve host query/fragment assignments,
  // including hosts with ports, rather than interpreting their contact values as credentials.
  if (query >= 0 && (colon < 0 || colon > query || isPublicHostPort(userinfo.slice(0, query))))
    return match;
  return `${match.slice(0, start)}[REDACTED]${authority.slice(at)}`;
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
 * override). Prefixes start with ASCII letters; that prefilter skips only impossible starts.
 * Keys have one token run after a bounded prefix/minimum. Header labels are bounded and their
 * trailing whitespace cannot contain another label. URL authority excludes slash, so a later URL
 * prefix delimits a failed authority scan. Successful matches advance both cursors over their span;
 * no failed candidate rescans an admitted-size run at every LF/TAB boundary.
 * Opaque Bearer/Basic values and literal query names keep their established delimiter policy.
 */
function hasSplitCredential(text: string, joined: string, rule: SecretRule): boolean {
  if (rule.boundary === undefined) return false;
  const canonical = rule.joinedPattern ?? rule.pattern;
  const source = rule.joinedPattern === undefined ? canonical.source.slice(2) : canonical.source;
  // Absence under the same boundary-free canonical matcher proves there is no joined
  // candidate. Presence still requires the original-boundary and split checks below.
  // Native scanning avoids a JS/coverage branch for every byte of unrelated large text.
  if (!new RegExp(source, canonical.flags).test(joined)) return false;
  const pattern = new RegExp(source, canonical.flags.replace('g', 'y'));
  let originalOffset = 0;
  let joinedOffset = 0;
  while (originalOffset < text.length) {
    const char = text[originalOffset];
    if (char === '\n' || char === '\t') {
      originalOffset += 1;
      continue;
    }
    // Both finite boundary classes reject ASCII word characters. Skip those impossible
    // starts without allocating/testing RegExp objects for every admitted-size character;
    // the rule's own boundary and canonical matcher still decide every eligible start.
    const code = text.charCodeAt(originalOffset);
    const previous = text.charCodeAt(originalOffset - 1);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const previousWord =
      (previous >= 48 && previous <= 57) ||
      (previous >= 65 && previous <= 90) ||
      (previous >= 97 && previous <= 122) ||
      previous === 95;
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
