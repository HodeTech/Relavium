import { z } from 'zod';

import { utf8ByteLength } from './bytes.js';

/**
 * Dependency-free JSON-Schema → Zod compiler (**[ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §4**,
 * promoted to `@relavium/shared` by **[ADR-0092](../../../docs/decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md) §1**).
 *
 * Turns a JSON Schema into an executable Zod validator. It has two callers with opposite threat models, and
 * it lives here because neither can reach the other: `@relavium/mcp` depends on `@relavium/core`, so core
 * cannot import from mcp, and this is the package both already depend on. No new runtime dependency —
 * `@relavium/shared` already carries zod, and its allowlist is unchanged (CLAUDE.md rule 2 / ADR-0034).
 *
 * **The bounds are a PARAMETER, not a constant.** They were `INGRESS_BOUNDS` from `@relavium/mcp`, sized for
 * a hostile server's ingress. An authored `output_schema` is a different input with different limits, and
 * baking one caller's numbers into a shared module would have made the other caller's limits invisible.
 * `@relavium/mcp` passes its own and its behaviour is unchanged.
 *
 * The MCP caller's input is **server-controlled and in-scope UNTRUSTED** (the threat model includes a
 * malicious/compromised MCP server), so the compiler is **adversarially hardened** and **fail-closed**:
 *
 * - **Bounded** nesting depth and total node count — a pathologically deep or wide schema is rejected,
 *   never stack-overflowed or used to exhaust memory.
 * - In its default mode it **never compiles an untrusted `pattern`/`format` regex** — there is no ReDoS
 *   surface: a string `pattern` is accepted but **not enforced** (the server still validates server-side),
 *   and the compiler runs no regex against the untrusted schema.
 * - An **unsupported construct** (`$ref`, `oneOf`/`anyOf`/`allOf`, `patternProperties`, `if`/`then`, …)
 *   is **rejected** (`ok: false`) — the tool is dropped at discovery, **never admitted unvalidated**.
 * - It is a rule-2 **commodity** (a schema-shape → validator transform), **not** a rule-3 security
 *   primitive (it hand-rolls no crypto/TLS/keychain); its security property is that it fails closed.
 *
 * It covers the subset MCP servers emit in practice: `object`/`array`/`string`/`number`/`integer`/
 * `boolean`/`null`, `enum`/`const`, `required`, `additionalProperties`, and nullability (a `['T', 'null']`
 * type union or the `nullable: true` flag), with nesting. The written contract for the supported subset is
 * [json-schema-subset.md](../../../docs/reference/shared-core/json-schema-subset.md).
 */

/**
 * The limits a caller imposes on a schema it is about to compile. Every one fails the whole schema CLOSED
 * when exceeded — none truncates, because a truncated constraint is a validator that silently accepts the
 * wrong value.
 */
export interface SchemaBounds {
  /** Maximum nesting depth — a deeper schema fails closed. */
  readonly maxDepth: number;
  /** Maximum total schema nodes visited — the real total-work bound (width *and* depth). */
  readonly maxNodes: number;
  /** Maximum `enum` members compiled. */
  readonly maxEnumMembers: number;
  /** Maximum `object` properties compiled. */
  readonly maxProperties: number;
  /** Maximum UTF-8 bytes of a `const`/`enum` string literal. */
  readonly maxStringBytes: number;
  /** Maximum UTF-8 bytes of a property name — bounded far tighter than a value: a name is a word. */
  readonly maxPropertyNameBytes: number;
}

/**
 * Refuse a string that is over its byte bound, naming what it was.
 *
 * Fail-closed like every sibling guard in this file: an over-bound literal drops the whole TOOL at discovery
 * rather than being truncated, because a truncated `const` is a validator that silently accepts the wrong
 * value — the same reason ADR-0087 §2 rejects rather than truncates a node output.
 */
function rejectOverSizedString(value: string, what: string, limit: number): void {
  const bytes = utf8ByteLength(value);
  if (bytes > limit) {
    throw new UnsupportedSchemaError(`${what} is ${bytes} bytes, above the limit of ${limit}`);
  }
}

/**
 * Which contract the schema is compiled under.
 *
 * - `lenient` — the **denylist** the MCP boundary has always used. A construct on {@link UNSUPPORTED_KEYS}
 *   fails the schema closed; anything else unrecognised is ignored, and `pattern`/`format` are accepted but
 *   **not enforced** (no untrusted regex is ever compiled — the ReDoS surface stays zero, and the server
 *   validates server-side anyway).
 * - `strict` — the **allowlist** for AUTHORED schemas
 *   ([ADR-0092](../../../docs/decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md) §2).
 *   Every validation-affecting keyword is either genuinely enforced or refused at parse, so a construct
 *   nobody implemented can never be silently ignored again. A malformed value for a supported keyword is
 *   refused too: `minLength: "5"` fails rather than passing unenforced.
 *
 * The difference is not a strictness dial, it is *whose* schema it is. `lenient` describes something a
 * hostile stranger sent us and we are gating; `strict` describes something the author wrote and expects to
 * mean what it says. Calling `output_schema` "validated" while quietly ignoring its `pattern` was false for
 * exactly the schemas an author writes to be precise.
 */
export type CompileMode = 'lenient' | 'strict';

/**
 * Keywords `strict` mode accepts. Anything outside this list is REFUSED — that is the whole point of the
 * mode, and the reason it is a list rather than a set of `if`s scattered through the walk.
 *
 * The annotation group carries no validation semantics and is accepted-and-ignored; every other entry is
 * genuinely enforced somewhere below. Adding a keyword here without implementing it would silently
 * reintroduce the defect this mode exists to remove.
 */
const STRICT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // Annotations — no validation semantics.
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  // Shape and value constraints, all enforced.
  'type',
  'nullable',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

/**
 * Every keyword the JSON-Schema vocabulary defines that this compiler might meet — the set it is SAFE to
 * name in a refusal, because it is published and fixed rather than authored. A key outside it is text the
 * author typed and is never echoed.
 */
const JSON_SCHEMA_VOCABULARY: ReadonlySet<string> = new Set([
  ...STRICT_ALLOWED_KEYS,
  '$ref',
  '$defs',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$vocabulary',
  'definitions',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'unevaluatedItems',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
]);

/**
 * The `format` values `strict` mode enforces. An UNKNOWN format is refused rather than ignored: silently
 * accepting `format: "ipv6"` and not checking it is precisely the accepted-but-not-enforced shape ADR-0092
 * exists to remove, and it would be invisible to the author.
 */
const STRICT_FORMATS: ReadonlySet<string> = new Set([
  'email',
  'uuid',
  'uri',
  'url',
  'date-time',
  'date',
  'time',
  'duration',
  'ipv4',
  'ipv6',
]);

/** The result of compiling a JSON Schema: a usable Zod validator, or a fail-closed reason. */
export type CompileResult =
  | { readonly ok: true; readonly schema: z.ZodTypeAny }
  | { readonly ok: false; readonly reason: string };

/** Internal: a JSON-Schema construct we deliberately do not support — caught and turned into `ok: false`. */
class UnsupportedSchemaError extends Error {}

/**
 * Internal walk budget — a single counter threaded through the recursion so width *and* depth are bounded,
 * carrying the caller's {@link SchemaBounds} alongside it. The bounds ride the budget rather than a second
 * parameter because the budget already reaches every function that needs to enforce one.
 */
interface Budget {
  nodes: number;
  readonly bounds: SchemaBounds;
  readonly mode: CompileMode;
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
    // Reject NaN/Infinity — not valid JSON, and `z.literal(NaN)` would build a permanently-dead validator.
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}

/**
 * Compile an untrusted JSON Schema into a Zod validator. Never throws — any unsupported construct,
 * malformed shape, or budget overrun returns `{ ok: false, reason }` so the caller drops the tool at
 * discovery rather than admitting it unvalidated.
 */
export function compileJsonSchemaToZod(
  input: unknown,
  bounds: SchemaBounds,
  mode: CompileMode = 'lenient',
): CompileResult {
  const budget: Budget = { nodes: 0, bounds, mode };
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
  if (depth > budget.bounds.maxDepth) {
    throw new UnsupportedSchemaError(
      `schema nesting exceeds the maximum depth of ${budget.bounds.maxDepth}`,
    );
  }
  if ((budget.nodes += 1) > budget.bounds.maxNodes) {
    throw new UnsupportedSchemaError(
      `schema exceeds the maximum of ${budget.bounds.maxNodes} nodes`,
    );
  }
  // A boolean schema (`true`/`false`) is valid JSON Schema; `true` ≡ any, `false` ≡ never.
  if (node === true) return z.unknown();
  if (node === false) return z.never();
  if (!isPlainObject(node)) {
    throw new UnsupportedSchemaError('schema node must be an object or a boolean');
  }

  admitKeywords(node, budget);

  // `const`/`enum` constrain to specific VALUES; `type` constrains the shape — with `'null'` carried as a
  // first-class type member, so `type:'null'` enforces null and `type:['string','null']` is a real union.
  // When BOTH a value-constraint and a type are present they must BOTH hold (JSON-Schema semantics) — we
  // INTERSECT, so `{type:'number', enum:['a']}` AND `{type:'null', enum:['a']}` both accept nothing rather
  // than admitting the type-forbidden member. The OpenAPI `nullable: true` MODIFIER (distinct from a `'null'`
  // type member) adds null on top.
  const constOrEnum = readConstOrEnum(node, budget);
  const { types, nullableFlag } = readTypes(node, budget);

  // The SHAPE half: the declared type(s), or — with no `type` — whatever loose constraints the node
  // carries, which JSON Schema applies to values of the kind each belongs to.
  const shape =
    types.length > 0
      ? buildTypeUnion(types, node, budget, depth)
      : loosenedShape(node, budget, depth);

  let base: z.ZodTypeAny;
  if (constOrEnum !== undefined) {
    // A value-constraint and a shape-constraint must BOTH hold, so they intersect. With no `type`, the
    // shape half is whatever the loose constraints describe — and it was dropped: `{ enum: ['aa'],
    // minLength: 5 }` accepted `'aa'`, which is two characters, because only the enum arm was built. The
    // same hole `typelessConstrained` exists to close, one branch over.
    base = shape === undefined ? constOrEnum : z.intersection(constOrEnum, shape);
  } else if (shape !== undefined) {
    base = shape;
  } else {
    // No `type`/`const`/`enum`. In `lenient` that is an unconstrained schema (`{}` / description-only) —
    // accept any value; the gate is *shape*, not exhaustive constraint, and MCP servers emit `{}` for a
    // no-arg tool. In `strict` the node may still carry constraints, which JSON Schema applies to values
    // of the kind each belongs to, so they are enforced rather than dropped.
    base = z.unknown();
  }
  return nullableFlag ? base.nullable() : base;
}

/**
 * Refuse what this mode does not admit: the denylisted constructs in both modes, plus — in `strict` — a
 * keyword-shape pass and the allowlist. Extracted from {@link compileNode} so the ADMISSION rules read as
 * one unit rather than as the first third of a long function.
 */
function admitKeywords(node: Record<string, unknown>, budget: Budget): void {
  for (const key of UNSUPPORTED_KEYS) {
    if (key in node) {
      throw new UnsupportedSchemaError(`unsupported JSON-Schema construct: "${key}"`);
    }
  }
  if (budget.mode !== 'strict') {
    return;
  }
  validateKeywordShapes(node);
  for (const key of Object.keys(node)) {
    if (STRICT_ALLOWED_KEYS.has(key)) {
      continue;
    }
    // **Named only when it is a real JSON-Schema keyword.** A refusal that will not say which keyword is
    // nearly useless, but an unrecognised key is AUTHORED TEXT — an author can write anything there,
    // including something secret-shaped, and a message never carries an authored value. The vocabulary is
    // a fixed, published list, so naming a member of it leaks nothing; anything else stays positional and
    // the author finds it by removing what the subset does not list.
    throw new UnsupportedSchemaError(
      JSON_SCHEMA_VOCABULARY.has(key)
        ? `unsupported keyword "${key}" — an authored schema may only use the documented subset (json-schema-subset.md)`
        : 'the schema declares a key outside the documented subset (json-schema-subset.md)',
    );
  }
}

/** The shape a node with NO `type` still constrains — `strict` only; `lenient` leaves such a node open. */
function loosenedShape(
  node: Record<string, unknown>,
  budget: Budget,
  depth: number,
): z.ZodTypeAny | undefined {
  return budget.mode === 'strict' ? typelessConstrained(node, budget, depth) : undefined;
}

/** `const` → a single literal; `enum` → a union of literal members (budget-charged); BOTH ⇒ their INTERSECTION
 *  (JSON-Schema semantics: both value-constraints must hold, so a contradictory pair accepts nothing); neither ⇒
 *  `undefined`. */
function readConstOrEnum(node: Record<string, unknown>, budget: Budget): z.ZodTypeAny | undefined {
  const hasConst = 'const' in node;
  const hasEnum = 'enum' in node;
  if (hasConst && hasEnum) {
    return z.intersection(
      literalSchema(node['const'], budget.bounds),
      enumSchema(node['enum'], budget),
    );
  }
  if (hasConst) return literalSchema(node['const'], budget.bounds);
  if (hasEnum) return enumSchema(node['enum'], budget);
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
 * Read the declared `type`(s) — each kept as a type, INCLUDING `'null'` (so a null-only or `[…, 'null']`
 * declaration is enforced/unioned, not silently widened) — plus the OpenAPI `nullable: true` MODIFIER flag
 * (a separate concept). The list length is charged against the node budget so a huge `type` array (a DoS)
 * fails closed, consistent with `enumSchema`/`readRequired`.
 */
function readTypes(
  node: Record<string, unknown>,
  budget: Budget,
): { types: string[]; nullableFlag: boolean } {
  const raw = node['type'];
  const nullable = node['nullable'];
  if (budget.mode === 'strict' && nullable !== undefined && typeof nullable !== 'boolean') {
    // `strict` promises that a malformed value for a supported keyword is refused, and `nullable` was the
    // one keyword that quietly dropped it — `=== true` treats `'yes'` as absent, so an author who wrote a
    // string got a non-nullable schema and no indication their modifier had been ignored.
    throw new UnsupportedSchemaError('`nullable` must be a boolean');
  }
  const nullableFlag = nullable === true;
  if (raw === undefined) {
    return { types: [], nullableFlag };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if ((budget.nodes += list.length) > budget.bounds.maxNodes) {
    throw new UnsupportedSchemaError(
      `schema exceeds the maximum of ${budget.bounds.maxNodes} nodes`,
    );
  }
  const types: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') {
      throw new UnsupportedSchemaError('`type` must be a string or an array of strings');
    }
    types.push(entry);
  }
  return { types, nullableFlag };
}

/**
 * Check the SHAPE of every supported keyword present on a node, before any type branch is chosen.
 *
 * `strict` promises that a malformed value for a supported keyword is refused. It kept that promise only for
 * the keywords the CHOSEN type reads: a sibling belonging to another type was never looked at, so
 * `{ type: 'string', required: 'bad' }`, `{ type: 'number', properties: [] }` and `{ type: 'object',
 * pattern: 42 }` all compiled clean. The author's mistake is the same whichever type sits next to it.
 *
 * Shape only — whether a keyword APPLIES to the declared type is a separate question, and JSON Schema's
 * answer there is "it is vacuously satisfied", not "it is an error".
 */
function validateKeywordShapes(node: Record<string, unknown>): void {
  const isPlainObj = (v: unknown): boolean => isPlainObject(v);
  const rules: ReadonlyArray<readonly [string, (v: unknown) => boolean, string]> = [
    ['properties', isPlainObj, 'an object'],
    ['items', (v) => isPlainObj(v) || typeof v === 'boolean', 'a schema or a boolean'],
    [
      'additionalProperties',
      (v) => isPlainObj(v) || typeof v === 'boolean',
      'a schema or a boolean',
    ],
    ['pattern', (v) => typeof v === 'string', 'a string'],
    ['format', (v) => typeof v === 'string', 'a string'],
    ['uniqueItems', (v) => typeof v === 'boolean', 'a boolean'],
    ['nullable', (v) => typeof v === 'boolean', 'a boolean'],
    ['enum', (v) => Array.isArray(v) && v.length > 0, 'a non-empty array'],
    [
      'required',
      (v) =>
        Array.isArray(v) && v.every((n) => typeof n === 'string') && new Set(v).size === v.length,
      'an array of unique strings',
    ],
    [
      'type',
      (v) =>
        typeof v === 'string' ||
        (Array.isArray(v) &&
          v.length > 0 &&
          v.every((t) => typeof t === 'string') &&
          new Set(v).size === v.length),
      'a string or a non-empty array of unique strings',
    ],
  ];
  for (const [key, ok, expected] of rules) {
    if (key in node && !ok(node[key])) {
      // The keyword is named (published vocabulary); the VALUE never is.
      throw new UnsupportedSchemaError(`\`${key}\` must be ${expected}`);
    }
  }
}

/** The constraint keywords each JSON-Schema type owns — used to decide what a TYPELESS schema constrains. */
const STRING_CONSTRAINTS = ['minLength', 'maxLength', 'pattern', 'format'] as const;
const NUMBER_CONSTRAINTS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
] as const;
const ARRAY_CONSTRAINTS = ['items', 'minItems', 'maxItems', 'uniqueItems'] as const;
const OBJECT_CONSTRAINTS = [
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
] as const;

/**
 * Which JSON kind a value is, for choosing the constraints that apply to it.
 *
 * `typeof` alone is not that answer: `null` and an array are both `'object'`, so a naive dispatch reports a
 * missing property on a `null` and object constraints on an array.
 */
type JsonKind = 'string' | 'number' | 'array' | 'object' | 'other';

function jsonKindOf(value: unknown): JsonKind {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return 'other';
}

/**
 * A schema with **no `type`** but with constraints on it.
 *
 * JSON Schema applies a constraint to values of the kind it belongs to and leaves every other kind
 * unconstrained: `{ "pattern": "^a+$" }` says nothing about a number and everything about a string. The
 * compiler used to return `z.unknown()` for any typeless node, so ALL of it was dropped — measured, every
 * one of the eleven constraint keywords was silently unenforced without a `type` beside it. That is the
 * defect ADR-0092 exists to remove, re-entering through the allowlist: the keyword was on the allowlist,
 * so it was "accepted", and nothing checked it.
 *
 * `strict` only. `lenient` is the MCP boundary's contract and keeps its behaviour exactly.
 */
function typelessConstrained(
  node: Record<string, unknown>,
  budget: Budget,
  depth: number,
): z.ZodTypeAny | undefined {
  const has = (keys: readonly string[]): boolean => keys.some((k) => k in node);
  // **Charged per KIND, before the work.** `compileNode` charges one node for this node, but this builds up
  // to FOUR sub-schemas from it — the same multi-schema work a `type: [a, b, c, d]` array does, and
  // `readTypes` charges `list.length` for that. Leaving it at one made the two paths disagree about the
  // same schema: at `maxNodes: 3`, `{ type: ['string','number','array','object'], minLength, minimum,
  // minItems, minProperties }` was refused while the typeless form expressing the identical constraint set
  // compiled. Bounded (a flat ≤4×, since nested `items`/`properties` still recurse through `compileNode`
  // and are charged there) — but a budget that two paths compute differently is not a budget.
  const kinds = [
    has(STRING_CONSTRAINTS),
    has(NUMBER_CONSTRAINTS),
    has(ARRAY_CONSTRAINTS),
    has(OBJECT_CONSTRAINTS),
  ].filter(Boolean).length;
  if (kinds === 0) {
    return undefined;
  }
  if ((budget.nodes += kinds) > budget.bounds.maxNodes) {
    throw new UnsupportedSchemaError(
      `schema exceeds the maximum of ${budget.bounds.maxNodes} nodes`,
    );
  }
  const str = has(STRING_CONSTRAINTS) ? stringSchema(node, budget) : undefined;
  const num = has(NUMBER_CONSTRAINTS) ? numberSchema(node, false, budget) : undefined;
  const arr = has(ARRAY_CONSTRAINTS) ? arraySchema(node, budget, depth) : undefined;
  const obj = has(OBJECT_CONSTRAINTS) ? objectSchema(node, budget, depth) : undefined;
  // Dispatched on the VALUE's kind rather than compiled as a union: a union would accept the value on any
  // arm that passes, and a catch-all arm for the unconstrained kinds would then swallow a real violation.
  const byKind: Record<JsonKind, z.ZodTypeAny | undefined> = {
    string: str,
    number: num,
    array: arr,
    object: obj,
    other: undefined,
  };
  return z.unknown().superRefine((value, ctx) => {
    const applicable = byKind[jsonKindOf(value)];
    if (applicable === undefined) {
      return; // this kind carries no constraint here — unconstrained, per JSON Schema
    }
    const result = applicable.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue(issue);
      }
    }
  });
}

function compileTyped(
  type: string,
  node: Record<string, unknown>,
  budget: Budget,
  depth: number,
): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return stringSchema(node, budget);
    case 'integer':
      return numberSchema(node, true, budget);
    case 'number':
      return numberSchema(node, false, budget);
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'object':
      return objectSchema(node, budget, depth);
    case 'array':
      return arraySchema(node, budget, depth);
    default:
      // The VALUE is not echoed — `type` is authored text and can be anything, including something
      // secret-shaped. The valid set is published and short, so listing it is both safe and more
      // actionable than quoting back what the author typed.
      throw new UnsupportedSchemaError(
        'unsupported JSON-Schema type — must be one of object, array, string, number, integer, boolean, null',
      );
  }
}

/**
 * A string. `minLength`/`maxLength` are honored in both modes.
 *
 * `pattern`/`format` split on the mode, and the split is the threat model rather than a preference. In
 * `lenient` they are accepted and NOT compiled — the schema came from a possibly-hostile server, so
 * compiling its regex would hand it a ReDoS lever, and the server validates its own input anyway. In
 * `strict` they are ENFORCED: an authored pattern is the author's own, and accepting it while quietly not
 * checking it made "validated" false for exactly the schemas someone writes to be precise.
 */
function stringSchema(node: Record<string, unknown>, budget: Budget): z.ZodTypeAny {
  let schema = z.string();
  const min = readBound(node, 'minLength', budget, { integer: true, nonNegative: true });
  const max = readBound(node, 'maxLength', budget, { integer: true, nonNegative: true });
  // **Code POINTS, not UTF-16 code units.** JSON Schema counts characters; Zod's `.min()`/`.max()` count
  // `String.length`. An emoji is one character and two code units, so `maxLength: 1` rejected "😀" and
  // `minLength: 2` accepted it — both the exact inverse of the spec.
  if (min !== undefined || max !== undefined) {
    schema = schema.superRefine((value, ctx) => {
      const length = [...value].length;
      if (min !== undefined && length < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_small,
          minimum: min,
          type: 'string',
          inclusive: true,
          message: `string has ${length} characters, below the minimum of ${min}`,
        });
      }
      if (max !== undefined && length > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: max,
          type: 'string',
          inclusive: true,
          message: `string has ${length} characters, above the maximum of ${max}`,
        });
      }
    }) as unknown as z.ZodString;
  }
  if (budget.mode !== 'strict') {
    return schema;
  }
  // `format` first: it returns a `ZodString`, and the `pattern` branch below ends the chain with a pipe.
  const format = node['format'];
  if (format !== undefined) {
    if (typeof format !== 'string') {
      throw new UnsupportedSchemaError('`format` must be a string');
    }
    if (!STRICT_FORMATS.has(format)) {
      // Refused, not ignored. Accepting `format: "ipv6"` and never checking it is the accepted-but-not-
      // enforced shape this mode exists to remove, and the author would never see that it did nothing.
      // The VALUE is not echoed — it is authored text — so the allowed set is listed instead, which is
      // more actionable than quoting back what they typed.
      throw new UnsupportedSchemaError(
        `unsupported \`format\` — must be one of ${[...STRICT_FORMATS].join(', ')}`,
      );
    }
    schema = applyFormat(schema, format);
  }
  const pattern = node['pattern'];
  if (pattern !== undefined) {
    if (typeof pattern !== 'string') {
      throw new UnsupportedSchemaError('`pattern` must be a string');
    }
    rejectOverSizedString(pattern, 'a `pattern`', budget.bounds.maxStringBytes);
    const compiled = compilePattern(pattern);
    // **`.pipe`, not `.regex`** — the ordering is the only ReDoS mitigation this contract honestly offers,
    // and chaining does not provide it. Zod runs every string check and COLLECTS issues: `.max(8)` does not
    // stop the `.regex` after it, so a 29-character input still reaches the backtracking engine. Measured
    // on `^(a+)+$` with `maxLength: 8` — 8010 ms chained, 0.1 ms piped, because a pipeline returns INVALID
    // without running its second schema. `packages/shared/src/workflow.ts` already orders length before
    // pattern for exactly this reason; this path did not inherit it.
    //
    // It only helps when the author declared a `maxLength`. That is why json-schema-subset.md tells them
    // to, and why the advice had to become true rather than be deleted.
    return schema.pipe(z.string().regex(compiled));
  }
  return schema;
}

/**
 * Compile an authored `pattern`. JSON Schema 2020-12 defines it as an **ECMA-262** regex, and the two
 * dialects genuinely differ: `\p{L}` needs the `u` flag, while an identity escape like `a\-b` outside a
 * character class is legal ECMA-262 but a syntax error UNDER `u`. Compiling with `u` only therefore
 * refused ordinary valid patterns while telling the author theirs "is not a valid regular expression",
 * which was both wrong and unactionable.
 *
 * Unicode mode is preferred when it compiles — better semantics for anything non-ASCII — and the plain
 * form is the fallback, so the accepted surface is the union rather than one dialect's half.
 */
function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      // Neither dialect accepts it. The pattern text is NOT echoed — it is an authored value.
      throw new UnsupportedSchemaError('`pattern` is not a valid regular expression');
    }
  }
}

/** Apply one of {@link STRICT_FORMATS}. Every member is handled; the `never` arm makes that a compile error
 *  if a value is added to the set without an implementation here. */
function applyFormat(schema: z.ZodString, format: string): z.ZodString {
  switch (format) {
    case 'email':
      return schema.email();
    case 'uuid':
      return schema.uuid();
    case 'uri':
    case 'url':
      return schema.url();
    case 'date-time':
      return schema.datetime({ offset: true });
    case 'date':
      return schema.date();
    case 'time':
      // RFC 3339 `full-time` REQUIRES an offset, which is what JSON Schema's `time` means. Zod's `.time()`
      // is the opposite: it accepts a bare `12:34:56` and rejects `12:34:56Z` and `12:34:56+03:00`.
      return schema.regex(
        /^(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
      );
    case 'duration':
      return schema.duration();
    case 'ipv4':
      return schema.ip({ version: 'v4' });
    case 'ipv6':
      return schema.ip({ version: 'v6' });
    default:
      throw new UnsupportedSchemaError(
        `unsupported \`format\` — must be one of ${[...STRICT_FORMATS].join(', ')}`,
      );
  }
}

/**
 * Read a numeric keyword, honoring the mode's contract about a MALFORMED value.
 *
 * In `lenient` a wrong-typed bound is ignored, which is what the MCP boundary has always done — the schema
 * is a stranger's and the constraint is theirs to enforce. In `strict` it is REFUSED: `minLength: "5"` was
 * silently unenforced, so an author who mistyped a bound got a validator that did not check it and no
 * indication anywhere that their constraint had been dropped.
 */
function readBound(
  node: Record<string, unknown>,
  key: string,
  budget: Budget,
  rules: { integer?: boolean; nonNegative?: boolean; positive?: boolean } = {},
): number | undefined {
  const raw = node[key];
  if (raw === undefined) return undefined;
  const bad =
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    (rules.integer === true && !Number.isInteger(raw)) ||
    (rules.nonNegative === true && raw < 0) ||
    (rules.positive === true && raw <= 0);
  if (!bad) return raw;
  if (budget.mode === 'strict') {
    throw new UnsupportedSchemaError(
      `\`${key}\` must be a ${rules.integer === true ? 'non-negative integer' : 'finite number'}`,
    );
  }
  return undefined;
}

/**
 * A number/integer. `minimum`/`maximum` are honored in both modes; `exclusiveMinimum`/`exclusiveMaximum`
 * and `multipleOf` are enforced in `strict` only. In `lenient` they are IGNORED OUTRIGHT — not read as
 * their inclusive cousins, which an earlier version of this comment claimed: a `lenient` schema declaring
 * `exclusiveMinimum: 5` accepts `4`, where an inclusive bound would have rejected it. The real behaviour
 * is the worse one, which is the more useful thing to write down.
 */
function numberSchema(
  node: Record<string, unknown>,
  integer: boolean,
  budget: Budget,
): z.ZodTypeAny {
  let schema = integer ? z.number().int() : z.number();
  const min = readBound(node, 'minimum', budget);
  const max = readBound(node, 'maximum', budget);
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  if (budget.mode !== 'strict') {
    return schema;
  }
  const exclusiveMin = readBound(node, 'exclusiveMinimum', budget);
  const exclusiveMax = readBound(node, 'exclusiveMaximum', budget);
  if (exclusiveMin !== undefined) schema = schema.gt(exclusiveMin);
  if (exclusiveMax !== undefined) schema = schema.lt(exclusiveMax);
  const multipleOf = readBound(node, 'multipleOf', budget, { positive: true });
  if (multipleOf !== undefined) schema = schema.multipleOf(multipleOf);
  return schema;
}

/**
 * Reject a `__proto__` property/required name (a prototype-pollution guard) — never a legitimate tool
 * parameter; `shape['__proto__'] = …` would corrupt the shape via the prototype setter, and zod special-cases
 * `__proto__` on input, so admitting it yields a poisoned/dead validator. Fail closed.
 */
function rejectProtoKey(name: string): void {
  if (name === '__proto__') {
    throw new UnsupportedSchemaError('a property named "__proto__" is not allowed');
  }
}

/**
 * Add each `required` name NOT already in `shape` as an untyped (`z.unknown()`) key — so
 * `additionalProperties: false`/strict still ADMITS the key. It returns nothing: presence is enforced by the
 * caller for EVERY `required` name, because `z.unknown()` is optional inside a `z.object` and so is any other
 * unconstrained property schema — which is the bug that made this function's old return value look sufficient.
 * Fails closed on a `__proto__` required name.
 */
function addUntypedRequired(
  shape: Record<string, z.ZodTypeAny>,
  required: ReadonlySet<string>,
  additional: AdditionalProps,
  budget: Budget,
): void {
  for (const name of required) {
    if (Object.hasOwn(shape, name)) continue;
    rejectProtoKey(name);
    // **What `additionalProperties` says about this name.** Adding it to the shape promotes it to a
    // DECLARED property, which is how it used to escape both forms: `.strict()` then admitted it as known,
    // and `.catchall(schema)` never applied the authored schema to it. Only `strict` mode changes here —
    // `lenient` is the MCP boundary's contract.
    if (budget.mode === 'strict' && additional.kind === 'strict') {
      // JSON Schema makes this unsatisfiable: the name must be present, and `additionalProperties: false`
      // forbids any property `properties` does not declare. Refused at parse rather than compiled into a
      // validator no value can pass. The NAME is not echoed — it is authored text.
      throw new UnsupportedSchemaError(
        'a `required` name is not declared in `properties`, and `additionalProperties: false` forbids it — no value can satisfy this schema',
      );
    }
    shape[name] =
      budget.mode === 'strict' && additional.kind === 'schema' ? additional.schema : z.unknown();
  }
}

function objectSchema(node: Record<string, unknown>, budget: Budget, depth: number): z.ZodTypeAny {
  const properties = node['properties'];
  if (properties !== undefined && !isPlainObject(properties)) {
    throw new UnsupportedSchemaError('`properties` must be an object');
  }
  // An omitted `properties` is a valid object schema (possibly with a bare `required`) — treat it as no
  // declared properties rather than short-circuiting, so a `required` name is still presence-enforced below.
  const propEntries = properties === undefined ? [] : Object.entries(properties);
  if (propEntries.length > budget.bounds.maxProperties) {
    throw new UnsupportedSchemaError(
      `object declares more than the maximum of ${budget.bounds.maxProperties} properties`,
    );
  }
  const required = readRequired(node, budget);
  // Resolved BEFORE the shape is filled: a `required` name with no `properties` entry has to know what
  // `additionalProperties` says about it, and deciding that afterwards is why it used to escape both forms.
  const additional = additionalPropsMode(node, budget, depth);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, propSchema] of propEntries) {
    rejectProtoKey(name);
    // A property NAME is attacker-controlled text that reaches the model in the tool spec, and it is bounded
    // far tighter than a value: a real parameter name is a word, not a paragraph.
    rejectOverSizedString(name, 'a property name', budget.bounds.maxPropertyNameBytes);
    const compiled = compileNode(propSchema, budget, depth + 1);
    shape[name] = required.has(name) ? compiled : compiled.optional();
  }
  // A `required` name not declared in `properties` (or any `required` when `properties` is omitted) is still
  // present-enforced per the JSON-Schema spec — added to the shape as `z.unknown()` here, presence enforced below.
  addUntypedRequired(shape, required, additional, budget);
  // Honor `additionalProperties`: `false` ⇒ reject unknown keys (`.strict()`); otherwise pass them through
  // (default JSON-Schema semantics) so the model may include extra keys the server's own schema permits.
  let built: z.ZodTypeAny;
  if (additional.kind === 'strict') {
    built = z.object(shape).strict();
  } else if (additional.kind === 'schema') {
    // `additionalProperties: <schema>` TYPES the extra values. In `lenient` this was treated as merely
    // "allowed" and passed through untyped — accepted, not enforced — so a schema that constrained its
    // extra values got no constraint at all.
    built = z.object(shape).catchall(additional.schema);
  } else {
    built = z.object(shape).passthrough();
  }
  const checks: Array<(value: Record<string, unknown>, ctx: z.RefinementCtx) => void> = [];
  // **Every `required` name, not only the ones absent from `properties`.** `required` means the key must be
  // PRESENT, whatever its schema says about the value — but presence was left to the compiled property
  // schema, and an unconstrained one cannot enforce it: `{}`, `true`, an annotation-only object and a bare
  // `nullable` all compile to `z.unknown()`, which is OPTIONAL inside a `z.object`, so a missing key passed.
  // Measured: `{ properties: { status: {} }, required: ['status'] }` accepted `{}` — the headline guarantee
  // of deep validation, defeated by the most ordinary way to say "this field exists".
  //
  // Redundant for a typed property (Zod already reports a missing key there) and deliberately so: the
  // guarantee should not depend on whether a property's compiled schema happens to reject `undefined`.
  for (const name of required) {
    checks.push((value, ctx) => {
      if (!Object.hasOwn(value, name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing required property "${name}"`,
          path: [name],
        });
      }
    });
  }
  checks.push(...propertyCountChecks(node, budget));
  if (checks.length === 0) {
    return built;
  }
  return built.superRefine((value: Record<string, unknown>, ctx) => {
    for (const check of checks) {
      check(value, ctx);
    }
  });
}

/**
 * How `additionalProperties` is realised. `false` ⇒ reject unknown keys; a SCHEMA ⇒ type the extra values
 * (`strict` mode only — `lenient` deliberately never compiles a stranger's sub-schema for keys it is not
 * gating); anything else ⇒ pass them through, the default JSON-Schema semantics.
 */
type AdditionalProps =
  | { kind: 'strict' }
  | { kind: 'passthrough' }
  | { kind: 'schema'; schema: z.ZodTypeAny };

/** `minProperties` / `maxProperties` as refinements — `strict` only; `lenient` ignores both. */
function propertyCountChecks(
  node: Record<string, unknown>,
  budget: Budget,
): ReadonlyArray<(value: Record<string, unknown>, ctx: z.RefinementCtx) => void> {
  const min = readBound(node, 'minProperties', budget, { integer: true, nonNegative: true });
  const max = readBound(node, 'maxProperties', budget, { integer: true, nonNegative: true });
  if (budget.mode !== 'strict') {
    return [];
  }
  const checks: Array<(value: Record<string, unknown>, ctx: z.RefinementCtx) => void> = [];
  if (min !== undefined) {
    checks.push((value, ctx) => {
      const count = Object.keys(value).length;
      if (count < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `object has ${count} properties, below the minimum of ${min}`,
        });
      }
    });
  }
  if (max !== undefined) {
    checks.push((value, ctx) => {
      const count = Object.keys(value).length;
      if (count > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `object has ${count} properties, above the maximum of ${max}`,
        });
      }
    });
  }
  return checks;
}

function additionalPropsMode(
  node: Record<string, unknown>,
  budget: Budget,
  depth: number,
): AdditionalProps {
  const additional = node['additionalProperties'];
  if (additional === false) return { kind: 'strict' };
  if (budget.mode === 'strict' && isPlainObject(additional)) {
    return { kind: 'schema', schema: compileNode(additional, budget, depth + 1) };
  }
  if (budget.mode === 'strict' && additional !== undefined && additional !== true) {
    throw new UnsupportedSchemaError('`additionalProperties` must be a boolean or a schema object');
  }
  return { kind: 'passthrough' };
}

function readRequired(node: Record<string, unknown>, budget: Budget): Set<string> {
  const required = node['required'];
  if (required === undefined) return new Set();
  if (!Array.isArray(required) || !required.every((r): r is string => typeof r === 'string')) {
    throw new UnsupportedSchemaError('`required` must be an array of strings');
  }
  // Charge the list length against the shared node budget so a huge `required` array fails closed (a DoS).
  if ((budget.nodes += required.length) > budget.bounds.maxNodes) {
    throw new UnsupportedSchemaError(
      `schema exceeds the maximum of ${budget.bounds.maxNodes} nodes`,
    );
  }
  // **A `required` entry IS a property name, and it was the one that escaped the bound.** The bound was
  // applied where `properties` is walked, so a name declared ONLY in `required` — the legal JSON-Schema shape
  // where `properties` is omitted entirely — reached the shape as a `z.unknown()` key, the presence refine's
  // message, and the `llmVisibleParams` a provider receives, at any size the aggregate discovery budget
  // happened to allow. The same text was refused at 257 bytes through one door and admitted at 200 KiB
  // through the other. Charged here, the single place every `required` entry passes through.
  for (const name of required) {
    rejectOverSizedString(name, 'a property name', budget.bounds.maxPropertyNameBytes);
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
  const min = readBound(node, 'minItems', budget, { integer: true, nonNegative: true });
  const max = readBound(node, 'maxItems', budget, { integer: true, nonNegative: true });
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  if (budget.mode !== 'strict') {
    return schema;
  }
  const unique = node['uniqueItems'];
  if (unique !== undefined && typeof unique !== 'boolean') {
    throw new UnsupportedSchemaError('`uniqueItems` must be a boolean');
  }
  if (unique !== true) {
    return schema;
  }
  // Structural equality by canonical JSON: JSON-Schema uniqueness is by VALUE, so `[{a:1},{a:1}]` is a
  // duplicate while a `Set` of references would call it unique. Object key order is normalised so
  // `{a:1,b:2}` and `{b:2,a:1}` are the same member, which is what the spec means by equal.
  const maxValueDepth = budget.bounds.maxDepth;
  return schema.superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      // **Bounded, because this walks MODEL OUTPUT, not the schema.** Every other recursion in this file
      // descends an authored schema under `maxDepth`; this one descends the VALUE being validated, which
      // is the least trusted thing in a run. `[[[[…]]]]` nested ten thousand deep is a few kilobytes and
      // would have overflowed the stack inside a `safeParse`, turning a validation into a crash.
      let key: string;
      try {
        key = canonicalJson(item, 0, maxValueDepth);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `item at index ${index} nests deeper than ${maxValueDepth}, so \`uniqueItems\` cannot be decided`,
          path: [index],
        });
        return;
      }
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate item at index ${index} — \`uniqueItems\` is true`,
          path: [index],
        });
        return;
      }
      seen.add(key);
    });
  });
}

/**
 * A value's canonical JSON form — object keys sorted — so structural equality is a string comparison.
 * Depth-bounded: the input is model output, and an unbounded descent over it is a stack overflow waiting
 * for a nested-enough array. Throws past the bound; the caller turns that into a validation issue.
 */
function canonicalJson(value: unknown, depth: number, max: number): string {
  if (depth > max) {
    throw new UnsupportedSchemaError('value nests too deeply to compare');
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1, max)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1, max)}`)
    .join(',')}}`;
}

function literalSchema(value: unknown, bounds: SchemaBounds): z.ZodTypeAny {
  if (value === null) return z.null();
  if (typeof value === 'string' || typeof value === 'boolean') {
    // **The dimension every other budget here missed** (`#209`). `MAX_DEPTH`/`MAX_NODES`/`MAX_PROPERTIES`/
    // `MAX_ENUM_MEMBERS` bound the schema's SHAPE thoroughly, and a single `{ const: '<megabytes>' }` costs
    // exactly one node against all of them. Up to `MAX_NODES` such strings could pass every existing check.
    if (typeof value === 'string')
      rejectOverSizedString(value, 'a `const`/`enum` string', bounds.maxStringBytes);
    return z.literal(value);
  }
  // Accept only a FINITE number — NaN/Infinity are not valid JSON and `z.literal(NaN)` is a permanently-dead
  // gate; an object/array `const` would need structural matching. Anything else fails closed at discovery.
  if (typeof value === 'number' && Number.isFinite(value)) {
    return z.literal(value);
  }
  throw new UnsupportedSchemaError('`const` must be a finite number, string, boolean, or null');
}

function enumSchema(value: unknown, budget: Budget): z.ZodTypeAny {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UnsupportedSchemaError('`enum` must be a non-empty array');
  }
  if (value.length > budget.bounds.maxEnumMembers) {
    throw new UnsupportedSchemaError(
      `\`enum\` exceeds the maximum of ${budget.bounds.maxEnumMembers} members`,
    );
  }
  // Charge the members against the shared node budget so MANY enum-bearing nodes (each within the per-enum
  // cap) cannot multiply into an unbounded compile — the budget is the real TOTAL-work bound, not the cap.
  if ((budget.nodes += value.length) > budget.bounds.maxNodes) {
    throw new UnsupportedSchemaError(
      `schema exceeds the maximum of ${budget.bounds.maxNodes} nodes`,
    );
  }
  if (!value.every(isJsonScalar)) {
    throw new UnsupportedSchemaError('`enum` members must be string/number/boolean/null scalars');
  }
  const literals = value.map((member) => literalSchema(member, budget.bounds));
  // A single-member enum is a lone literal; multiple members are a union of literals.
  return literals.length === 1
    ? literals[0]!
    : z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}
