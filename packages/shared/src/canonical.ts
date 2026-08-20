/**
 * Deterministic serialization — the one canonical form two independent implementations must agree on.
 */

/**
 * A value that has no canonical form — refused rather than silently flattened into one that collides.
 *
 * The alternative was measured and is worse: a `Date` and a `Map` both served as `{}`, a non-finite number
 * and an `undefined` property both as `null`. Each of those merges two distinguishable values into one
 * digest, in a function whose only job is to tell values apart.
 */
export class NonCanonicalValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonCanonicalValueError';
  }
}

/**
 * The nesting ceiling. Beyond it the form refuses rather than recursing — matching the caps this project
 * already applies for the same reason in the engine's structural comparison, the expression sandbox, the
 * workflow default walk and the MCP schema compiler. A cross-language contract with no stated bound would
 * make a second implementation's own recursion limit an undocumented part of it.
 */
const MAX_CANONICAL_DEPTH = 64;

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
 * - arrays keep their order; `undefined` inside an array serializes as `null`, matching `JSON.stringify`,
 *   and a HOLE serializes the same way rather than as nothing;
 * - a shape with no faithful JSON form — a non-finite number, an `undefined` object property, a `Date`, a
 *   `Map`, a class instance — is REFUSED. `JSON.stringify` would flatten each into `{}` or `null`, which
 *   collides with a real `{}` or `null`, and a form built to distinguish values must not merge them.
 *
 * It lives here rather than in `@relavium/db` — where it began, module-private — because a digest defined by
 * one package's internals is not a contract another package can be held to. It is pure: the HASH stays with
 * each caller, since `node:crypto` may not be imported from a package the desktop WebView loads.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new NonCanonicalValueError('the value is nested deeper than the canonical form allows');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // `JSON.stringify` renders these as `null`, which COLLIDES with a real `null` — two different values,
    // one digest. A form whose whole job is to distinguish values must not merge them silently.
    throw new NonCanonicalValueError('a non-finite number has no canonical form');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    // `Array.from`, not `.map` — `map` SKIPS holes, and `join(',')` renders a hole as an empty string, so a
    // sparse array serialized to `[,1]`, which is not JSON at all. A byte contract a second implementation
    // must reproduce cannot emit something that implementation could not parse.
    return `[${Array.from(value, (item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // A `Date`, a `Map`, a `Set`, a class instance: `Object.entries` reports no own enumerable keys for any
    // of them, so every one serialized to `{}` — two different Dates digesting identically, and colliding
    // with an empty object. Refused rather than silently flattened.
    throw new NonCanonicalValueError('only a plain object has a canonical form');
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([k, v]) => {
      if (v === undefined) {
        // `JSON.stringify` DROPS such a key; this used to render it as `null`, colliding with an explicit
        // `null`. Neither is safe to guess at, so it is refused.
        throw new NonCanonicalValueError('an `undefined` property has no canonical form');
      }
      return `${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`;
    })
    .join(',')}}`;
}
