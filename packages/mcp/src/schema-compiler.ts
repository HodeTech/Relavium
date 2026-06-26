import { z } from 'zod';

/**
 * Dependency-free JSON-Schema → Zod compiler (**[ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §4**).
 *
 * Turns a server-reported MCP tool `inputSchema` into the executable `ToolDef.parseArgs` validator that
 * gates every dispatch. The `@modelcontextprotocol/sdk` does **not** validate call arguments against the
 * server's `inputSchema`, and [tool-registry.md](../../../docs/reference/shared-core/tool-registry.md)
 * requires an **executable** validator (a Zod `parse`), not a bare JSON Schema — so this gate is ours to
 * build, with no new runtime dependency (CLAUDE.md rule 2 / ADR-0034).
 *
 * The input is **server-controlled and in-scope UNTRUSTED** (the threat model includes a
 * malicious/compromised MCP server), so the compiler is **adversarially hardened** and **fail-closed**:
 *
 * - **Bounded** nesting depth ({@link MAX_DEPTH}) and total node count ({@link MAX_NODES}) — a pathologically
 *   deep or wide schema is rejected, never stack-overflowed or used to exhaust memory.
 * - It **never compiles an untrusted `pattern`/`format` regex** — there is no ReDoS surface: a string
 *   `pattern` is accepted but **not enforced** here (the server still validates server-side), and the
 *   compiler runs no regex against the untrusted schema.
 * - An **unsupported construct** (`$ref`, `oneOf`/`anyOf`/`allOf`, `patternProperties`, `if`/`then`, …)
 *   is **rejected** (`ok: false`) — the tool is dropped at discovery, **never admitted unvalidated**.
 * - It is a rule-2 **commodity** (a schema-shape → validator transform), **not** a rule-3 security
 *   primitive (it hand-rolls no crypto/TLS/keychain); its security property is that it fails closed.
 *
 * It covers the subset MCP servers emit in practice: `object`/`array`/`string`/`number`/`integer`/
 * `boolean`/`null`, `enum`/`const`, `required`, `additionalProperties`, and nullability (a `['T', 'null']`
 * type union or the `nullable: true` flag), with nesting.
 */

/** Maximum nesting depth of the compiled schema — a deeper schema fails closed. */
export const MAX_DEPTH = 16;
/** Maximum total schema nodes visited — a larger schema fails closed (DoS guard). */
export const MAX_NODES = 2000;
/** Maximum `enum` members compiled — a larger enum fails closed. */
export const MAX_ENUM_MEMBERS = 1000;
/** Maximum `object` properties compiled — a wider object fails closed. */
export const MAX_PROPERTIES = 500;

/** The result of compiling a JSON Schema: a usable Zod validator, or a fail-closed reason. */
export type CompileResult =
  | { readonly ok: true; readonly schema: z.ZodTypeAny }
  | { readonly ok: false; readonly reason: string };

/** Internal: a JSON-Schema construct we deliberately do not support — caught and turned into `ok: false`. */
class UnsupportedSchemaError extends Error {}

/** Internal walk budget — a single counter threaded through the recursion so width *and* depth are bounded. */
interface Budget {
  nodes: number;
}

/** Constructs that are out of the supported subset; their presence fails the whole schema closed. */
const UNSUPPORTED_KEYS = [
  '$ref',
  '$dynamicRef',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
] as const;

type JsonScalar = string | number | boolean | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Compile an untrusted JSON Schema into a Zod validator. Never throws — any unsupported construct,
 * malformed shape, or budget overrun returns `{ ok: false, reason }` so the caller drops the tool at
 * discovery rather than admitting it unvalidated.
 */
export function compileJsonSchemaToZod(input: unknown): CompileResult {
  const budget: Budget = { nodes: 0 };
  try {
    return { ok: true, schema: compileNode(input, budget, 0) };
  } catch (err) {
    // Fail closed on EVERY error path — an `UnsupportedSchemaError` (a known-unsupported construct) and any
    // other unexpected throw alike map to `ok: false`, never to an admitted-but-unvalidated tool.
    const reason =
      err instanceof Error && err.message.length > 0
        ? err.message
        : 'invalid or unsupported schema';
    return { ok: false, reason };
  }
}

function compileNode(node: unknown, budget: Budget, depth: number): z.ZodTypeAny {
  if (depth > MAX_DEPTH) {
    throw new UnsupportedSchemaError(`schema nesting exceeds the maximum depth of ${MAX_DEPTH}`);
  }
  if ((budget.nodes += 1) > MAX_NODES) {
    throw new UnsupportedSchemaError(`schema exceeds the maximum of ${MAX_NODES} nodes`);
  }
  // A boolean schema (`true`/`false`) is valid JSON Schema; `true` ≡ any, `false` ≡ never.
  if (node === true) return z.unknown();
  if (node === false) return z.never();
  if (!isPlainObject(node)) {
    throw new UnsupportedSchemaError('schema node must be an object or a boolean');
  }

  for (const key of UNSUPPORTED_KEYS) {
    if (key in node) {
      throw new UnsupportedSchemaError(`unsupported JSON-Schema construct: "${key}"`);
    }
  }

  // `const`/`enum` constrain to specific values; `type` constrains the shape. When BOTH are present they
  // must BOTH hold (JSON-Schema semantics) — we INTERSECT, so a contradictory `{type:'number', enum:['a']}`
  // accepts nothing rather than admitting the type-forbidden member.
  const constOrEnum = readConstOrEnum(node, budget);
  const { types, nullable, typeDeclared } = readTypes(node);

  let base: z.ZodTypeAny;
  if (constOrEnum !== undefined) {
    base =
      types.length === 0
        ? constOrEnum
        : z.intersection(constOrEnum, buildTypeUnion(types, node, budget, depth));
  } else if (types.length > 0) {
    base = buildTypeUnion(types, node, budget, depth);
  } else if (typeDeclared && nullable) {
    // The declared type was null-only (`type: 'null'` / `['null']`) — ENFORCE null, never "accept anything".
    base = z.null();
  } else {
    // No `type`/`const`/`enum`: an unconstrained schema (`{}` / description-only) — accept any value (the
    // gate is *shape*, not exhaustive constraint; MCP servers emit `{}` for a no-arg tool).
    base = z.unknown();
  }
  return nullable ? base.nullable() : base;
}

/** `const` → a single literal; `enum` → a union of literal members (budget-charged); neither ⇒ `undefined`. */
function readConstOrEnum(node: Record<string, unknown>, budget: Budget): z.ZodTypeAny | undefined {
  if ('const' in node) return literalSchema(node['const']);
  if ('enum' in node) return enumSchema(node['enum'], budget);
  return undefined;
}

/** Compile the declared non-null `type`(s) into one schema — a single type, or a union of them. */
function buildTypeUnion(
  types: readonly string[],
  node: Record<string, unknown>,
  budget: Budget,
  depth: number,
): z.ZodTypeAny {
  const built = types.map((t) => compileTyped(t, node, budget, depth));
  return built.length === 1
    ? built[0]!
    : z.union(built as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

/**
 * Read the declared `type`(s), folding a `'null'` member or `nullable: true` into a nullability flag.
 * `typeDeclared` distinguishes a null-only declaration (`type: 'null'` ⇒ ENFORCE null) from an ABSENT type
 * (⇒ unconstrained) — without it a null-only schema would wrongly compile to "accept anything".
 */
function readTypes(node: Record<string, unknown>): {
  types: string[];
  nullable: boolean;
  typeDeclared: boolean;
} {
  const raw = node['type'];
  let nullable = node['nullable'] === true;
  if (raw === undefined) {
    return { types: [], nullable, typeDeclared: false };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const types: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') {
      throw new UnsupportedSchemaError('`type` must be a string or an array of strings');
    }
    if (entry === 'null') {
      nullable = true;
      continue;
    }
    types.push(entry);
  }
  return { types, nullable, typeDeclared: true };
}

function compileTyped(
  type: string,
  node: Record<string, unknown>,
  budget: Budget,
  depth: number,
): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return stringSchema(node);
    case 'integer':
      return numberSchema(node, true);
    case 'number':
      return numberSchema(node, false);
    case 'boolean':
      return z.boolean();
    // `'null'` never reaches here — `readTypes` strips it into the nullability flag, and a null-ONLY
    // declaration is enforced as `z.null()` in `compileNode`. A stray `'null'` would fall to `default`.
    case 'object':
      return objectSchema(node, budget, depth);
    case 'array':
      return arraySchema(node, budget, depth);
    default:
      throw new UnsupportedSchemaError(`unsupported JSON-Schema type: "${type}"`);
  }
}

/** A string. `minLength`/`maxLength` (safe integers) are honored; `pattern`/`format` are deliberately NOT
 *  compiled (no untrusted-regex ReDoS surface) — the value is accepted and the server validates it. */
function stringSchema(node: Record<string, unknown>): z.ZodTypeAny {
  let schema = z.string();
  const min = node['minLength'];
  const max = node['maxLength'];
  if (typeof min === 'number' && Number.isInteger(min) && min >= 0) schema = schema.min(min);
  if (typeof max === 'number' && Number.isInteger(max) && max >= 0) schema = schema.max(max);
  return schema;
}

/** A number/integer. `minimum`/`maximum` (finite numbers) are honored. */
function numberSchema(node: Record<string, unknown>, integer: boolean): z.ZodTypeAny {
  let schema = integer ? z.number().int() : z.number();
  const min = node['minimum'];
  const max = node['maximum'];
  if (typeof min === 'number' && Number.isFinite(min)) schema = schema.min(min);
  if (typeof max === 'number' && Number.isFinite(max)) schema = schema.max(max);
  return schema;
}

function objectSchema(node: Record<string, unknown>, budget: Budget, depth: number): z.ZodTypeAny {
  const properties = node['properties'];
  if (properties === undefined) {
    // A typed object with no declared properties: any object. `additionalProperties: false` would make it
    // empty-only, which is honored below via the same strict/passthrough switch.
    return additionalPropsMode(node) === 'strict'
      ? z.object({}).strict()
      : z.object({}).passthrough();
  }
  if (!isPlainObject(properties)) {
    throw new UnsupportedSchemaError('`properties` must be an object');
  }
  const propEntries = Object.entries(properties);
  if (propEntries.length > MAX_PROPERTIES) {
    throw new UnsupportedSchemaError(
      `object declares more than the maximum of ${MAX_PROPERTIES} properties`,
    );
  }
  const required = readRequired(node, budget);
  // A null-prototype map so a property literally named `__proto__` becomes an OWN key `z.object` can see —
  // a plain `{}` would route `shape['__proto__'] = …` to the prototype setter and silently drop the property.
  const shape: Record<string, z.ZodTypeAny> = Object.create(null) as Record<string, z.ZodTypeAny>;
  for (const [name, propSchema] of propEntries) {
    const compiled = compileNode(propSchema, budget, depth + 1);
    shape[name] = required.has(name) ? compiled : compiled.optional();
  }
  const built = z.object(shape);
  // Honor `additionalProperties`: `false` ⇒ reject unknown keys (`.strict()`); otherwise pass them through
  // (default JSON-Schema semantics) so the model may include extra keys the server's own schema permits.
  return additionalPropsMode(node) === 'strict' ? built.strict() : built.passthrough();
}

function additionalPropsMode(node: Record<string, unknown>): 'strict' | 'passthrough' {
  const additional = node['additionalProperties'];
  // A *schema* for additionalProperties (an object) is treated as "allowed" (passthrough) — we do not type
  // the extra values, but we never reject them. Only an explicit `false` strictens.
  return additional === false ? 'strict' : 'passthrough';
}

function readRequired(node: Record<string, unknown>, budget: Budget): Set<string> {
  const required = node['required'];
  if (required === undefined) return new Set();
  if (!Array.isArray(required) || !required.every((r): r is string => typeof r === 'string')) {
    throw new UnsupportedSchemaError('`required` must be an array of strings');
  }
  // Charge the list length against the shared node budget so a huge `required` array fails closed (a DoS).
  if ((budget.nodes += required.length) > MAX_NODES) {
    throw new UnsupportedSchemaError(`schema exceeds the maximum of ${MAX_NODES} nodes`);
  }
  return new Set(required);
}

function arraySchema(node: Record<string, unknown>, budget: Budget, depth: number): z.ZodTypeAny {
  const items = node['items'];
  let element: z.ZodTypeAny;
  if (items === undefined) {
    element = z.unknown();
  } else if (Array.isArray(items)) {
    // Tuple validation (`items: [A, B]`) is out of the supported subset — fail closed rather than guess.
    throw new UnsupportedSchemaError('tuple `items` (an array of schemas) is not supported');
  } else {
    element = compileNode(items, budget, depth + 1);
  }
  let schema = z.array(element);
  const min = node['minItems'];
  const max = node['maxItems'];
  if (typeof min === 'number' && Number.isInteger(min) && min >= 0) schema = schema.min(min);
  if (typeof max === 'number' && Number.isInteger(max) && max >= 0) schema = schema.max(max);
  return schema;
}

function literalSchema(value: unknown): z.ZodTypeAny {
  if (value === null) return z.null();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return z.literal(value);
  }
  // A `const` of an object/array would need structural literal matching — out of the subset, fail closed.
  throw new UnsupportedSchemaError('`const` must be a string, number, boolean, or null');
}

function enumSchema(value: unknown, budget: Budget): z.ZodTypeAny {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UnsupportedSchemaError('`enum` must be a non-empty array');
  }
  if (value.length > MAX_ENUM_MEMBERS) {
    throw new UnsupportedSchemaError(`\`enum\` exceeds the maximum of ${MAX_ENUM_MEMBERS} members`);
  }
  // Charge the members against the shared node budget so MANY enum-bearing nodes (each within the per-enum
  // cap) cannot multiply into an unbounded compile — the budget is the real TOTAL-work bound, not the cap.
  if ((budget.nodes += value.length) > MAX_NODES) {
    throw new UnsupportedSchemaError(`schema exceeds the maximum of ${MAX_NODES} nodes`);
  }
  if (!value.every(isJsonScalar)) {
    throw new UnsupportedSchemaError('`enum` members must be string/number/boolean/null scalars');
  }
  const literals = value.map((member) => literalSchema(member));
  // A single-member enum is a lone literal; multiple members are a union of literals.
  return literals.length === 1
    ? literals[0]!
    : z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}
