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
 *
 * **`charCodeAt`, deliberately, and a linter will keep asking for `codePointAt`.** This walks UTF-16 code
 * UNITS and pairs surrogates explicitly, because the lone-surrogate rule above is a property of the units,
 * not of code points. `codePointAt` at a high surrogate returns the PAIR's code point, which would either
 * change that documented behaviour or force the same surrogate arithmetic back in while making the loop
 * variable mean something it no longer does. The rule is a good default for extracting a character and the
 * wrong one for this algorithm; it is a won't-fix rather than an oversight, and
 * `bounding.test.ts`'s `L-1` case is what would catch a "cleanup" that changed it.
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
