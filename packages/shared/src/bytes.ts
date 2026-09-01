/**
 * UTF-8 byte length without `TextEncoder`.
 *
 * **It lives here, not beside its first caller, because the second caller could not reach it.** It was written
 * in `packages/core`'s tool-result bounding and stayed private to that package; when the MCP ingress bounds
 * needed the SAME unit ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §5.2), the
 * choices were to widen `@relavium/core`'s public surface for a string primitive or to write a second one.
 * A second one is how "8 KiB" quietly becomes three different numbers — a UTF-16 `.length`, a
 * `Buffer.byteLength`, and this — so it moved instead.
 *
 * Global-free by construction (no `TextEncoder`, no `Buffer`), which is what lets it sit in a package that
 * compiles with `types: []`.
 *
 * A lone high surrogate counts as 3 bytes (WTF-8) and does NOT consume the next unit — the case a naive
 * implementation gets wrong by pairing eagerly.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A high surrogate: only a 4-byte code point when FOLLOWED by a low surrogate. A lone high surrogate
      // is 3 bytes (WTF-8) and must not consume the next unit.
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
