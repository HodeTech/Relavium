import { randomUUID } from 'node:crypto';

/**
 * The shared UNTRUSTED-context injection framing (2.5.D, [ADR-0061](../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))
 * used by both the `@`-mention file injection ([mention.ts](mention.ts)) and the `!`-shell output injection
 * ([shell.ts](shell.ts)). Both move data across a trust boundary — a file's bytes / a command's output — into the
 * user message as data the model must NOT treat as instructions. Two invariants make the frame unforgeable and
 * bounded: (1) every attribute VALUE is stripped of control + bidi + framing chars, so a crafted name/command
 * cannot break out of the attribute nor forge a tag; (2) the content is fenced with a per-injection random `nonce`
 * on BOTH the open and close tags (`<tag id="NONCE" …>…</tag:NONCE>`), so content bytes containing a literal
 * `</tag>` cannot close/forge the frame, and it is head+tail bounded (byte AND line count) so a large payload
 * cannot freeze the multiline editor or blow the model context.
 */

/** A fresh, unguessable per-injection fence nonce (128 bits, dash-free). */
export function injectionNonce(): string {
  return randomUUID().replace(/-/g, '');
}

/** The HARD byte cap (code-unit proxy) on injected content — a larger payload is head+tail truncated. 128 KiB keeps
 *  a normal file/command usable while removing the many-MB TUI-freeze + context-blowout footgun. */
export const INJECT_MAX_CHARS = 128 * 1024;
/** The HARD line cap — each `\n` is a `PromptEditor` row rendered on every keystroke, so a many-short-line payload
 *  (bytes under the byte cap) would still flood the editor; cap the row count independently. */
export const INJECT_MAX_LINES = 400;

/** Snap a head length DOWN so the slice never ends on a lone HIGH surrogate (its low half would be lost → U+FFFD). */
function snapHead(s: string, n: number): number {
  if (n <= 0 || n >= s.length) return Math.max(0, Math.min(n, s.length));
  const code = s.charCodeAt(n - 1);
  return code >= 0xd800 && code <= 0xdbff ? n - 1 : n;
}
/** Snap a tail START index DOWN so the tail never begins on a lone LOW surrogate (its high half is elided). */
function snapTail(s: string, i: number): number {
  if (i <= 0 || i >= s.length) return Math.max(0, Math.min(i, s.length));
  const code = s.charCodeAt(i);
  return code >= 0xdc00 && code <= 0xdfff ? i - 1 : i;
}

/** Bound injected content by BOTH byte size and line count, each with a head + tail + explicit truncation marker
 *  (mirrors the process arm's `applyOutputBounding`). The byte cut is code-point-safe; the byte bound runs first so
 *  the line split then operates on an already-bounded (≤ cap) string. */
export function boundInjection(content: string): string {
  let out = content;
  if (out.length > INJECT_MAX_CHARS) {
    const headLen = snapHead(out, Math.floor(INJECT_MAX_CHARS * 0.75));
    const tailStart = snapTail(
      out,
      out.length - (INJECT_MAX_CHARS - Math.floor(INJECT_MAX_CHARS * 0.75)),
    );
    const elided = tailStart - headLen;
    out = `${out.slice(0, headLen)}\n… [truncated ${elided} of ${content.length} chars] …\n${out.slice(tailStart)}`;
  }
  const lines = out.split('\n');
  if (lines.length > INJECT_MAX_LINES) {
    const headLines = Math.floor(INJECT_MAX_LINES * 0.75);
    const tailLines = INJECT_MAX_LINES - headLines;
    const elidedLines = lines.length - headLines - tailLines;
    out = [
      ...lines.slice(0, headLines),
      `… [truncated ${elidedLines} lines] …`,
      ...lines.slice(lines.length - tailLines),
    ].join('\n');
  }
  return out;
}

/** Strip an attribute value of every char that could break the `attr="…"` framing or misrepresent it: C0 control
 *  (incl. newline/CR/tab), DEL, C1 (`0x80–0x9f`), the Unicode bidi/format controls (RLO etc.), and `<` `>` `"`. */
export function sanitizeInjectionAttr(value: string): string {
  return [...value]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false; // C0 / DEL / C1
      if (code === 0x200e || code === 0x200f || code === 0x061c) return false; // LRM / RLM / ALM
      if (code >= 0x202a && code <= 0x202e) return false; // LRE / RLE / PDF / LRO / RLO
      if (code >= 0x2066 && code <= 0x2069) return false; // LRI / RLI / FSI / PDI
      return true;
    })
    .join('')
    .replace(/[<>"]/g, '');
}

/**
 * Frame `content` as UNTRUSTED, user-position context inside `<tag id="NONCE" …attrs>…</tag:NONCE>`. `attrs`
 * VALUES are sanitized (unforgeable attribute); the content is bounded (byte + line) and fenced by the nonce so its
 * bytes cannot forge/close the frame. Leading `\n\n` separates it from any preceding prose.
 */
export function frameUntrusted(
  tag: string,
  attrs: Readonly<Record<string, string>>,
  content: string,
  nonce: string,
): string {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${sanitizeInjectionAttr(v)}"`)
    .join('');
  return `\n\n<${tag} id="${nonce}"${attrStr}>\n${boundInjection(content)}\n</${tag}:${nonce}>`;
}
