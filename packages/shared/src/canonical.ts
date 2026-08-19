/**
 * Deterministic serialization — the one canonical form two independent implementations must agree on.
 */

/**
 * Deterministic JSON — object keys sorted at every depth, no insignificant whitespace — so two logically
 * equal values always serialize to the same bytes.
 *
 * **Byte-exact, because two callers use it as a stored equality oracle.** `@relavium/db`'s effect journal
 * digests tool arguments with it ([ADR-0080](../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md)),
 * and the CLI's MCP consent gate digests a spawn declaration with it
 * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §3) — where a second,
 * non-TypeScript implementation must reproduce the same digest. So the rules are pinned rather than implied:
 *
 * - keys sorted by **UTF-16 code-unit ordinal** comparison (`<` / `>`), never `localeCompare`, which is
 *   locale-dependent and would make the same declaration digest differently on two machines;
 * - string escaping is **ECMAScript `JSON.stringify` semantics**;
 * - arrays keep their order; `undefined` inside an array serializes as `null`, matching `JSON.stringify`.
 *
 * It lives here rather than in `@relavium/db` — where it began, module-private — because a digest defined by
 * one package's internals is not a contract another package can be held to. It is pure: the HASH stays with
 * each caller, since `node:crypto` may not be imported from a package the desktop WebView loads.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
