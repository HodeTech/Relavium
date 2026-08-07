import { scrubSecrets } from '@relavium/llm';

/**
 * Terminal-output sanitization primitives — the CLI's Trojan-Source / ANSI-injection floor.
 *
 * Pure string functions with NO render/TUI dependency, so every surface can share them without importing the
 * ink projection layer: the TUI projections, the record/list commands, and — the reason this lives OUTSIDE
 * `render/tui/` — the engine hosts (`build-engine.ts`, `session-host.ts`) that report a withheld reasoning tier
 * through `chat/effort-notice.ts`. `render/tui/chat-projection.ts` re-exports both, so its own consumers are
 * unaffected. SECURITY-SENSITIVE: keep behavior exact (covered by the strip tests).
 */

/* eslint-disable no-control-regex */
// The terminal-sanitizer matcher, composed from one named source fragment per ESC-introduced escape family so a
// future edit touches a single, clearly-scoped family rather than one dense expression. SECURITY-SENSITIVE: the
// alternation below is byte-for-byte the prior single literal — keep behavior exact (covered by the strip tests).
/** OSC (`ESC ]`) + DCS/PM/APC/SOS (`ESC P`/`^`/`_`/`X`) string sequences, sharing one body. The terminator (BEL
 *  or ST) is REQUIRED, so an UNterminated introducer does NOT match here — it falls through to {@link ESC_2BYTE}
 *  (only its 2-byte form stripped), leaving the following text visible. An optional terminator would instead
 *  swallow the whole remainder of the string, silently erasing legitimate model output. */
const ESC_STRING_SEQ = String.raw`\x1b[\]P^_X][^\x07\x1b]*(?:\x07|\x1b\\)`;
/** CSI (`ESC [` colors/cursor) — the parameter / intermediate / final-byte form. */
const ESC_CSI = String.raw`\x1b\[[0-?]*[ -/]*[@-~]`;
/** Any remaining 2-byte `ESC <0x40–0x5f>` escape (incl. an unterminated OSC/DCS/PM/APC introducer). */
const ESC_2BYTE = String.raw`\x1b[@-Z\\-_]`;
/** Every ESC-introduced sequence, composed from the named families above. */
const ESC_SEQUENCES = new RegExp(`${ESC_STRING_SEQ}|${ESC_CSI}|${ESC_2BYTE}`, 'g');
/** Remaining C0/C1 control bytes — keep only TAB (\x09) and LINE FEED (\x0a). */
const BARE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/**
 * Unicode bidirectional / directional FORMAT controls — the Trojan-Source floor (CVE-2021-42574; 2.5-close
 * Step 14). These code points live ABOVE the C0/C1 range {@link BARE_CONTROLS} strips, so they survive it — yet
 * they REORDER how a terminal visually renders a line, letting streamed model output or pasted input display in
 * an order that differs from its logical bytes (a spoofed path/command in an approval prompt, a hidden argument,
 * a reversed URL). The set is the standard Trojan-Source family: the embeddings/overrides U+202A–202E
 * (LRE/RLE/PDF/LRO/RLO), the isolates U+2066–2069 (LRI/RLI/FSI/PDI), and the marks LRM (U+200E) / RLM (U+200F) /
 * ALM (U+061C). ZWJ/ZWNJ (U+200D/U+200C) are deliberately NOT stripped — they are legitimate in emoji sequences
 * and in Indic/Arabic/Persian shaping. Not in `no-control-regex`'s C0/C1 range, so no eslint-disable is needed.
 * Written with `\u` escapes (never literal bidi bytes) so the source itself carries no Trojan-Source hazard.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Strip terminal control sequences from text that will be written to a terminal — so model output (or pasted
 * input) cannot inject ANSI/OSC escapes (colors, a cursor jump, a window-title/clipboard/hyperlink write, a
 * `\r` line-overwrite) NOR spoof the visual line order with Unicode bidi controls (the Trojan-Source floor).
 * Applied at the **display** boundary only; the PERSISTED transcript keeps the raw text (it is user/model data,
 * not displayed back through a shell). Keeps printable text plus tabs and newlines.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(ESC_SEQUENCES, '').replace(BARE_CONTROLS, '').replace(BIDI_CONTROLS, '');
}

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
 * Two passes: redact secrets, then strip terminal controls. Redaction runs first on the theory that a credential
 * split by a control byte would rejoin once that byte is removed — but I could NOT construct a case where the
 * order changes the outcome (`scrubSecrets` matches the surviving prefix either way), so treat that as the
 * reason it is written this way, not as a proven property. What IS proven is that both passes run.
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
  return stripTerminalControls(scrubSecrets(text));
}

/** {@link sanitizeUntrusted}, collapsed to one row — for a one-line notice. */
export function sanitizeUntrustedInline(text: string): string {
  return sanitizeInline(scrubSecrets(text));
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
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}
