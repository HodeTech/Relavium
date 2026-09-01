import { scrubSecrets } from '@relavium/llm';
import { stripTerminalControls } from '@relavium/shared';

// Re-exported so every existing consumer keeps this import path while the IMPLEMENTATION lives in
// `@relavium/shared` — see its header for why it moved (ADR-0088 §7.1).
export { stripTerminalControls };

/**
 * Terminal-output sanitization primitives — the CLI's Trojan-Source / ANSI-injection floor.
 *
 * Pure string functions with NO render/TUI dependency, so every surface can share them without importing the
 * ink projection layer: the TUI projections, the record/list commands, and — the reason this lives OUTSIDE
 * `render/tui/` — the engine hosts (`build-engine.ts`, `session-host.ts`) that report a withheld reasoning tier
 * through `chat/effort-notice.ts`. `render/tui/chat-projection.ts` re-exports both, so its own consumers are
 * unaffected. SECURITY-SENSITIVE: keep behavior exact (covered by the strip tests).
 */

/**
 * Sanitize a single-line dynamic identifier (a tool id, the bound model name, a persisted session title) for
 * terminal display: strip the ANSI/OSC/control bytes {@link stripTerminalControls} removes, then collapse any
 * surviving tab/newline to a single space so the value cannot spoof extra terminal lines or columns inside a
 * one-line annotation/footer/list row.
 */
export function sanitizeInline(text: string): string {
  return stripTerminalControls(text).replace(/[\t\n]+/g, ' ');
}

/**
 * The sanitizer for text this process did NOT author — a rejection message, a provider response body, an MCP
 * error, a tool result, a stack trace.
 *
 * Two passes, and the ORDER is load-bearing: **normalize first, redact second.**
 *
 * This was the other way round, on the theory that a credential split by a control byte would rejoin once that
 * byte was removed — and the docblock admitted it could not construct a case where the order mattered. There
 * is one, and it is a real leak: a key split by a byte `stripTerminalControls` REMOVES (say `U+0001`) defeats
 * the pattern while the byte is still there, and then the strip rejoins the halves — printing the whole key.
 * Redacting after the strip sees the contiguous key and replaces it.
 *
 * The near-miss worth recording, because it is the case that made the old order look safe: a split by a
 * NEWLINE does not leak either way, since `sanitizeInline` collapses it to a SPACE rather than removing it, so
 * the halves never become contiguous. Only the REMOVED bytes rejoin — which is exactly why normalization has
 * to run first, and why "I could not construct a case" was not evidence.
 *
 * `scrubSecrets` rather than the tool-input detector `redactSecretShapedText`: the two catch different things,
 * and this path needs the KEY-PREFIX patterns (`sk-*`, `AIza*`, `Bearer`/`Basic` headers, URL userinfo, secret
 * query params) that an error message actually carries. The tool detector is tuned for authored paths and
 * commands and does not match a bare API key.
 *
 * `sanitizeInline`/`stripTerminalControls` deliberately do NOT redact: they run on text this codebase composed,
 * where redaction would mangle legitimate output. This is the variant for the failure paths, where the content
 * is arbitrary and the cost of a false positive is a `[redacted]` in a diagnostic rather than a leaked key.
 */
export function sanitizeUntrusted(text: string): string {
  return redactIncludingAcrossSeparators(stripTerminalControls(text));
}

/** {@link sanitizeUntrusted}, collapsed to one row — for a one-line notice. Same normalize-then-redact order:
 *  `sanitizeInline` is the normalization (strip + collapse), so the scrub sees the final text. */
export function sanitizeUntrustedInline(text: string): string {
  return redactIncludingAcrossSeparators(sanitizeInline(text));
}

/**
 * Redact `normalized`, INCLUDING a credential split across whitespace.
 *
 * The ordinary pass replaces a contiguous match in place, which is what almost every case is. What it cannot
 * see is a key broken by a newline or a tab: unlike the control bytes {@link stripTerminalControls} removes,
 * those are display-significant, so normalization COLLAPSES them to a space rather than deleting them — and
 * the halves never become contiguous for the matcher. The prefix (`sk-ant-…`) is public, so what leaked was
 * the part that matters: the secret suffix.
 *
 * So when the in-place pass finds nothing, this asks a second question — is there a credential once the
 * separators are gone? — and if so redacts the WHOLE text. Coarse on purpose: a boolean cannot locate the
 * span, and this function's whole posture (see {@link sanitizeUntrusted}) is that the cost of a false
 * positive is a `[REDACTED]` in a diagnostic, while the cost of a miss is a printed key. It stays out of the
 * shared `scrubSecrets`, which every surface depends on and where the same broadening would put ordinary
 * output at risk.
 */
function redactIncludingAcrossSeparators(normalized: string): string {
  const scrubbed = scrubSecrets(normalized);
  if (scrubbed !== normalized) return scrubbed; // located and replaced in place — the common case
  const joined = normalized.replace(/\s+/g, '');
  return scrubSecrets(joined) === joined ? normalized : '[REDACTED]';
}

/**
 * The code points `JSON.stringify` emits **raw** even though a terminal acts on them. Verified empirically, not
 * assumed: it escapes `U+0000`-`U+001F` (a 7-bit `ESC` becomes the six characters `\u001b`), the quote, the
 * backslash and lone surrogates — and nothing above that. Two families survive:
 *
 * - **`U+007F`-`U+009F`** — DEL plus the C1 controls. `U+009B` is the 8-bit CSI: a terminal with C1 support
 *   reads `U+009B` `2` `J` as "clear the screen", with no `ESC` anywhere for the JSON escaper to have caught.
 * - **The bidi family** {@link BIDI_CONTROLS} covers — Trojan Source (CVE-2021-42574), which reorders how a
 *   line renders without changing its bytes.
 *
 * In sync with the human path by construction: this is exactly the part of {@link BARE_CONTROLS} +
 * {@link BIDI_CONTROLS} that `JSON.stringify` does not already handle. Written with `\u` escapes (never
 * literal bidi bytes), like {@link BIDI_CONTROLS}, so the source itself carries no Trojan-Source hazard.
 */
const JSON_DISPLAY_UNSAFE = /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Serialize one `--json` record as a display-safe JSON line
 * ([ADR-0049](../../../../docs/decisions/0049-cli-machine-output-contract.md)).
 *
 * `--json` is machine output that lands on a **terminal** anyway — a developer runs `relavium status --json`
 * and reads it, or pipes it through a pager. Those records carry model- and provider-controlled text (a
 * human-gate message, a node id, an error code), so the Trojan-Source floor the human renderers apply is owed
 * here too; lane (c) hardened the human path and left this branch alone.
 *
 * It **escapes** rather than strips, and that distinction is the whole point: `\u202e` is standard JSON and
 * any parser decodes it back to the identical string, so `jq` sees exactly what it saw before — while a
 * terminal renders an inert six-character escape instead of acting on the control. Stripping would have
 * silently mutated the data a machine contract promises to reproduce.
 */
export function stringifyJsonLine(value: unknown): string {
  const json = JSON.stringify(value);
  // `JSON.stringify` returns `undefined` for `undefined`/a function/a symbol. The call sites accept `unknown`,
  // so preserve the pre-existing template-literal behaviour (`undefined`) rather than throwing on `.replace`.
  return json === undefined ? String(json) : json.replace(JSON_DISPLAY_UNSAFE, escapeAsJsonUnicode);
}

/** One BMP code point as its `\uXXXX` JSON escape. Every member of {@link JSON_DISPLAY_UNSAFE} is a
 *  non-surrogate BMP code point, so one UTF-16 unit is the whole character. */
function escapeAsJsonUnicode(char: string): string {
  // `codePointAt` over `charCodeAt`: every member of the class is a non-surrogate BMP code point so the two
  // agree, but the former is the one that stays correct if the class ever gains an astral member.
  return String.raw`\u` + (char.codePointAt(0) ?? 0).toString(16).padStart(4, '0');
}
