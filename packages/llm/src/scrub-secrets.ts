import { stripTerminalControls } from '@relavium/shared/terminal-safe';

/**
 * Defense-in-depth secret scrub applied at the one `makeLlmError` choke point. The CALLER (adapter) is
 * still responsible for passing an already-redacted message; this is the **structural backstop** — like
 * the engine's `deInlineMedia` pass, leak-freedom here is an active transform at one boundary, not
 * per-adapter discipline. It masks finite common secret **shapes**: prefixed keys, literal secret query
 * names, URL userinfo and finite API-key/Bearer/Basic headers. Each non-query rule probes the original diagnostic
 * independently, including terminal-normalized and whitespace-joined residual views, before any
 * other rule can erase its identifying context. A match revealed by normalization masks the whole
 * diagnostic. The finite patterns retain their word boundaries and already-masked-span limits;
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
  readonly replacement: string;
  readonly joinMaskedLines?: boolean;
}

/** One private authority per existing credential family, shared by probes and output masking. */
const NON_QUERY_SECRET_RULES: readonly SecretRule[] = [
  // OpenAI sk-/sk-proj-/sk-svcacct- and Anthropic sk-ant- key prefixes.
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9\-_]{16,}/g, replacement: '[REDACTED]' },
  { pattern: /\bAIza[0-9A-Za-z\-_]{20,}/g, replacement: '[REDACTED]' },
  // Finite authority schemes, not URL validation. The LAST @ before /, ? or # ends userinfo,
  // including malformed raw @/colon characters in a password; path/query @ remain public text.
  {
    pattern: /\b((?:https?|wss?|ftps?):\/\/)[^/\s?#]*@/gi,
    replacement: '$1[REDACTED]@',
    joinMaskedLines: true,
  },
  // Exact literal header names, also in quoted diagnostic objects. No arbitrary header discovery.
  {
    pattern: /(^|[^A-Za-z0-9_-])((?:x-)?api-key|x-goog-api-key)(["']?\s*:\s*["']?)[^\s"',;}]+/gi,
    replacement: '$1$2$3[REDACTED]',
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

function scrubNonQuerySecrets(text: string): string {
  const normalized = normalizeSecretProbe(text);
  for (const rule of NON_QUERY_SECRET_RULES) {
    const rawMasked = text.replace(rule.pattern, rule.replacement);
    const normalizedMasked = normalized.replace(rule.pattern, rule.replacement);
    // Keep required header whitespace: joining first would hide a newly revealed Bearer/Basic label.
    if (normalizeSecretProbe(rawMasked) !== normalizedMasked) return '[REDACTED]';
    // A raw @ before LF/TAB can create a partial URL mask while another @ still ends the actual
    // authority. Compare this rule's full views before treating its masks as complete delimiters.
    // Spaces remain boundaries here so separate same-line diagnostics cannot merge authorities.
    if (rule.joinMaskedLines) {
      const joined = normalized.replace(/[\n\t]+/g, '');
      if (
        joined.replace(rule.pattern, rule.replacement) !== normalizedMasked.replace(/[\n\t]+/g, '')
      ) {
        return '[REDACTED]';
      }
    }
    // Other families must not destroy this rule's prefix; only its own complete masks delimit spans.
    for (const remaining of normalizedMasked.split('[REDACTED]')) {
      const joined = remaining.replace(/\s+/g, '');
      if (joined.replace(rule.pattern, rule.replacement) !== joined) return '[REDACTED]';
    }
  }
  return NON_QUERY_SECRET_RULES.reduce(
    (masked, rule) => masked.replace(rule.pattern, rule.replacement),
    text,
  );
}

/** Exact literal query names, applied last so a value cannot erase another family's evidence. */
function scrubQuerySecrets(text: string): string {
  return text.replace(
    /([?&](?:(?:x[-_])?api[-_]?key|api[-_]?secret|(?:access|secret)[-_]?key|(?:access|refresh|id|auth|session)[-_]?token|client[-_]?secret|key|token|auth|password|secret)=)[^&\s#]+/gi,
    '$1[REDACTED]',
  ); // Finite literal names; exact boundaries preserve benign suffixes. No URL-name decoding.
}
