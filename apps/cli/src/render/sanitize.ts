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
