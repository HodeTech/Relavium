import { scrubSecrets } from '@relavium/llm/scrub-secrets';
import { stripTerminalControls } from '@relavium/shared/terminal-safe';

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
 * Give the shared scrubber the ORIGINAL text before display normalization erases evidence.
 * `scrubSecrets` independently checks raw and terminal-normalized views, including keys joined by
 * removed controls and recognized LF/TAB continuations after a complete-looking first fragment.
 * Stripping first can erase a legitimate original word boundary; collapsing LF/TAB first can expose
 * the continuation after masking only the first fragment. Strip only after that complete projection,
 * then apply the CLI's normalized/residual query-name policy before any one-line collapse.
 *
 * `sanitizeInline`/`stripTerminalControls` deliberately do NOT redact: they run on text this codebase composed,
 * where redaction would mangle legitimate output. This is the variant for the failure paths, where the content
 * is arbitrary and the cost of a false positive is a `[redacted]` in a diagnostic rather than a leaked key.
 */
export function sanitizeUntrusted(text: string): string {
  return redactIncludingAcrossSeparators(stripTerminalControls(scrubSecrets(text)));
}

/** {@link sanitizeUntrusted}, collapsed to one row only AFTER its complete secret projection. */
export function sanitizeUntrustedInline(text: string): string {
  return sanitizeInline(sanitizeUntrusted(text));
}

/**
 * Redact the display-normalized diagnostic, INCLUDING the CLI's residual split query-name policy.
 *
 * The ordinary pass replaces a contiguous match in place, which is what almost every case is. What it cannot
 * classify universally is arbitrary opaque fragments separated by whitespace. The shared scrubber owns
 * its finite original/normalized/LF-TAB rules; this additional CLI check joins still-unmasked spans to
 * recognize split literal query names without joining through already-redacted material.
 *
 * After every in-place pass, this checks the remaining unredacted segments — is there a credential once
 * their separators are gone? — and if so redacts the WHOLE text. A successful independent redaction must
 * not bypass protection for a second split credential. Already-redacted spans separate these probes: joining
 * through them could turn a masked query value and following ordinary prose into a false new query match.
 * Coarse on purpose: a boolean cannot locate the
 * span, and this function's whole posture (see {@link sanitizeUntrusted}) is that the cost of a false
 * positive is a `[REDACTED]` in a diagnostic, while the cost of a miss is a printed key. This broader CLI
 * probe also checks split literal query names. The shared `scrubSecrets` masks its finite shapes and
 * its literal query values in one merged pass, so no mask erases another shape's context; it does not
 * join query names or ordinary query prose.
 */
function redactIncludingAcrossSeparators(normalized: string): string {
  const scrubbed = scrubSecrets(normalized);
  for (const remaining of scrubbed.split('[REDACTED]')) {
    const joined = remaining.replace(/\s+/g, '');
    if (scrubSecrets(joined) !== joined) return '[REDACTED]';
  }
  return scrubbed;
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
