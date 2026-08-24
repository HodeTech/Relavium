/**
 * Structural equality for parsed, normalized data
 * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
 * §5).
 *
 * **Why this exists rather than a digest.** §5 verifies a resumed run's identity by comparing the caller's
 * parsed workflow against the frozen definition, and its input map against the admitted record. A SHA-256
 * content hash would be the obvious answer and is the wrong one here: the engine is platform-free, so it has
 * no hash primitive to reach for, and a digest over raw YAML would report a mismatch for reindented text that
 * parses identically. Comparing the NORMALIZED parse output answers the question actually being asked —
 * "is this the same graph" — and answers it without a dependency.
 *
 * **What "structural" covers, stated exactly.** Primitives by `Object.is`; arrays element-wise and
 * order-sensitive; plain objects by their own enumerable STRING keys, order-insensitive. Everything else —
 * a `Date`, a `Map`, a class instance, a function, a symbol-keyed property — compares by `Object.is`, which
 * for two separately-parsed values means NOT equal. That is the fail-closed direction and it is the right
 * one for an identity check: parsed YAML and a validated input map contain none of those shapes, so an
 * occurrence is a caller handing the engine something it did not produce.
 */

/**
 * A ceiling on nesting, so a pathological structure cannot exhaust the stack.
 *
 * Generous relative to what it guards: the deepest path in a parsed workflow is roughly
 * `workflow.nodes[].config.<field>[]`, well inside single digits. A structure deeper than this is not a
 * workflow, and treating it as unequal refuses a resume rather than crashing the process.
 */
const MAX_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  // `null` too: the engine BUILDS its input maps with a null prototype (§7), so the admitted record and a
  // freshly resolved map are both prototype-less. Requiring `Object.prototype` would make every comparison
  // between them false — which would refuse every resume, silently and for the wrong reason.
  return proto === Object.prototype || proto === null;
}

/**
 * Are these two values structurally equal?
 *
 * Cycle-safe by pair: a self-referential structure compared against itself terminates instead of recursing
 * forever. Tracked as PAIRS rather than as a set of seen nodes, because "I have seen `a` before" says
 * nothing about whether it was being compared against this `b`.
 */
export function deepStructuralEquals(a: unknown, b: unknown): boolean {
  return equals(a, b, 0, new Map<unknown, Set<unknown>>());
}

function equals(a: unknown, b: unknown, depth: number, seen: Map<unknown, Set<unknown>>): boolean {
  if (Object.is(a, b)) return true;
  if (depth > MAX_DEPTH) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (alreadyComparing(a, b, seen)) return true;

  if (Array.isArray(a) || Array.isArray(b)) return arraysEqual(a, b, depth, seen);
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  return objectsEqual(a, b, depth, seen);
}

/**
 * Whether this exact PAIR is already being compared further up the stack — the cycle guard.
 *
 * Records the pair as a side effect, which is why it reads as a question and is called for its answer: two
 * cyclic structures are equal exactly when assuming they are leads to no contradiction.
 */
function alreadyComparing(a: unknown, b: unknown, seen: Map<unknown, Set<unknown>>): boolean {
  const partners = seen.get(a);
  if (partners?.has(b) === true) return true;
  if (partners === undefined) seen.set(a, new Set([b]));
  else partners.add(b);
  return false;
}

function arraysEqual(
  a: unknown,
  b: unknown,
  depth: number,
  seen: Map<unknown, Set<unknown>>,
): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  // An INDEX loop, not `every`: `Array.prototype.every` SKIPS holes, so a sparse array compared equal to a
  // dense one in one direction and unequal in the other — an equality relation that is not symmetric,
  // measured. Harmless while the only caller compared scalar inputs; the workflow-content comparison walks
  // `nodes`, `edges` and `enum`, where a false positive means accepting a different graph.
  for (let index = 0; index < a.length; index += 1) {
    if (!equals(a[index], b[index], depth + 1, seen)) return false;
  }
  return true;
}

function objectsEqual(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  depth: number,
  seen: Map<unknown, Set<unknown>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  // `Object.hasOwn` rather than `key in b`: an inherited property is not a value `b` carries, and the
  // length check above would otherwise be satisfied by a prototype the two objects merely share.
  return aKeys.every((key) => Object.hasOwn(b, key) && equals(a[key], b[key], depth + 1, seen));
}
