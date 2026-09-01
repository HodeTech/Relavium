/**
 * Terminal-output sanitization — the Trojan-Source / ANSI-injection floor, as a platform-free primitive.
 *
 * **It lives here because a second package needed it and the alternative was a duplicate.** It was written for
 * the CLI's render layer (`apps/cli/src/render/sanitize.ts`) and stayed there; when
 * [ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §7.1 required the same strip at the
 * MCP **discovery** boundary — so poisoned bytes in a server-supplied tool description never propagate to a
 * render, an approval prompt or a log rather than being caught at whichever surface happens to display them —
 * `packages/mcp` could not reach into an app. A second copy of a security matcher is how two copies drift and
 * one of them stops matching; [ADR-0029](../../../docs/decisions/0029-tool-policy-hardening.md) (d)'s
 * one-primitive rule says so for the SSRF block, and it holds here for the same reason.
 *
 * Pure `RegExp`/`String` — no globals — which is what lets it sit in a package compiled with `types: []`.
 * SECURITY-SENSITIVE: keep behaviour exact; the CLI's strip tests cover it and still do, through the re-export.
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
