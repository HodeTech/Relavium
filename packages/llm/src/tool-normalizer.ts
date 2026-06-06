import type { JSONSchema7 } from 'json-schema';

import type { ContentPart } from '@relavium/shared';

import { ToolSchemaError } from './errors.js';
import type { ProviderId, ToolDef } from './types.js';

/**
 * The `ToolNormalizer` — one canonical `ToolDef` in, three native wire shapes out, and a provider
 * tool-call response folded back into one canonical `tool_call` `ContentPart` (1.E). It lives on
 * the **Relavium side** of the seam: `toWire` builds the plain object each SDK expects without ever
 * importing a vendor type (the fence forbids that outside `src/adapters/*`), so the adapters stay
 * dumb. See [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md).
 */

// --- Wire shapes (Relavium-defined; no vendor type) ------------------------------------------

/** OpenAI / DeepSeek: `{ type: 'function', function: { name, description?, parameters } }`. */
export interface OpenAiToolWire {
  type: 'function';
  function: { name: string; description?: string; parameters: JSONSchema7 };
}

/** Anthropic: `{ name, description?, input_schema }`. */
export interface AnthropicToolWire {
  name: string;
  description?: string;
  input_schema: JSONSchema7;
}

/** Gemini: `{ functionDeclarations: [{ name, description?, parameters }] }` (OpenAPI-subset schema). */
export interface GeminiToolWire {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
}

export type ToolWire = OpenAiToolWire | AnthropicToolWire | GeminiToolWire;

/** Build the native wire tool definition for a provider. `gemini` applies the OpenAPI-subset reshape. */
export function toWire(toolDef: ToolDef, providerId: ProviderId): ToolWire {
  const { name, description, parameters } = toolDef;
  const desc = description === undefined ? {} : { description };
  switch (providerId) {
    case 'anthropic':
      return { name, input_schema: parameters, ...desc };
    case 'openai':
    case 'deepseek':
      return { type: 'function', function: { name, parameters, ...desc } };
    case 'gemini':
      return {
        functionDeclarations: [{ name, parameters: reshapeForGemini(parameters, name), ...desc }],
      };
    default: {
      const unreachable: never = providerId;
      throw new Error(`unhandled provider id: ${String(unreachable)}`);
    }
  }
}

// --- Gemini OpenAPI-subset reshape -----------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Keywords Gemini's `functionDeclarations` schema (the OpenAPI-3.0 subset) accepts; everything
 * else is stripped. Includes `anyOf` (the union idiom — dropping it would destroy the constraint)
 * and the numeric/string bounds Gemini honors. `oneOf` / `allOf` are deliberately omitted (Gemini's
 * support is unreliable) and so are stripped.
 */
const GEMINI_ALLOWED_KEYWORDS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'items',
  'anyOf',
  'nullable',
  'format',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'default',
]);

/** `format` values Gemini accepts; an unsupported format is dropped, not sent. */
const GEMINI_SAFE_FORMATS = new Set(['date-time', 'int32', 'int64', 'float', 'double']);

/** Keep a `format` only if Gemini accepts it; an unsupported format is dropped. */
function reshapeFormat(value: unknown): Record<string, unknown> {
  return typeof value === 'string' && GEMINI_SAFE_FORMATS.has(value) ? { format: value } : {};
}

/**
 * Lower a JSON-Schema `type` array to Gemini's scalar `type` plus the separate `nullable` flag:
 * `['string', 'null']` → `{ type: 'string', nullable: true }`. An inexpressible union (zero or two+
 * non-null members) throws, mirroring the strip-or-throw contract of the rest of the reshape.
 */
function reshapeTypeArray(value: unknown[], toolName: string): Record<string, unknown> {
  const nonNull = value.filter((member) => member !== 'null');
  if (nonNull.length !== 1) {
    throw new ToolSchemaError(
      'gemini',
      toolName,
      `type union ${JSON.stringify(value)} is not expressible (need exactly one non-null type)`,
    );
  }
  return value.includes('null') ? { type: nonNull[0], nullable: true } : { type: nonNull[0] };
}

/**
 * Cap on JSON-Schema nesting depth — far above any real tool schema. Bounds the recursion so an
 * adversarial deeply-nested schema raises a typed `ToolSchemaError` instead of overflowing the
 * call stack (the `parameters` reshape walks untrusted, possibly agent-authored, input).
 */
const MAX_SCHEMA_DEPTH = 100;

/**
 * Reshape every member schema under a `properties` map. Members are written with `defineProperty`,
 * not bracket assignment, so a property literally named `__proto__` becomes an own key rather than
 * invoking the prototype setter (which would silently drop it and mutate the node's prototype).
 */
function reshapeProperties(
  value: Record<string, unknown>,
  toolName: string,
  depth: number,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [propName, propSchema] of Object.entries(value)) {
    Object.defineProperty(properties, propName, {
      value: reshapeNode(propSchema, toolName, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return properties;
}

/** Reshape one allow-listed keyword into the fragment to merge onto the output node. */
function reshapeKeyword(
  key: string,
  value: unknown,
  toolName: string,
  depth: number,
): Record<string, unknown> {
  if (key === 'format') {
    return reshapeFormat(value);
  }
  if (key === 'type' && Array.isArray(value)) {
    return reshapeTypeArray(value, toolName);
  }
  if (key === 'properties' && isRecord(value)) {
    return { properties: reshapeProperties(value, toolName, depth) };
  }
  if (key === 'items' || key === 'anyOf') {
    // `items` is a schema; `anyOf` an array of schemas — reshapeNode handles both (a `$ref` inside a
    // branch still throws), so member schemas are reshaped too.
    return { [key]: reshapeNode(value, toolName, depth + 1) };
  }
  return { [key]: value }; // enum / required / nullable / min|max(Items|Length) / pattern / default — verbatim
}

function reshapeNode(node: unknown, toolName: string, depth: number): unknown {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new ToolSchemaError(
      'gemini',
      toolName,
      `schema nesting exceeds the maximum supported depth (${MAX_SCHEMA_DEPTH})`,
    );
  }
  if (Array.isArray(node)) {
    return node.map((entry) => reshapeNode(entry, toolName, depth + 1));
  }
  if (!isRecord(node)) {
    return node; // a primitive (string type, enum value, etc.) — keep as-is
  }
  if ('$ref' in node) {
    // A reference can't be expressed without resolution — the normalizer doesn't inline refs.
    throw new ToolSchemaError(
      'gemini',
      toolName,
      '`$ref` is not expressible in the Gemini schema subset',
    );
  }
  const out: Record<string, unknown> = {};
  let nullableFromTypeUnion = false;
  for (const [key, value] of Object.entries(node)) {
    // Strip an unsupported keyword (additionalProperties, patternProperties, …); reshape the rest.
    if (!GEMINI_ALLOWED_KEYWORDS.has(key)) {
      continue;
    }
    const fragment = reshapeKeyword(key, value, toolName, depth);
    if (key === 'type' && 'nullable' in fragment) {
      nullableFromTypeUnion = true;
    }
    Object.assign(out, fragment);
  }
  // A `null` in a `type` union is authoritative — don't let a verbatim sibling `nullable` clobber it.
  if (nullableFromTypeUnion) {
    out['nullable'] = true;
  }
  return out;
}

/**
 * Validate + strip a canonical JSON-Schema down to Gemini's OpenAPI subset. Throws
 * `ToolSchemaError` when the schema can't be expressed (a `$ref`, a non-object root, or nesting past
 * `MAX_SCHEMA_DEPTH`). A typeless object root (e.g. a no-argument tool's `parameters: {}`) is
 * defaulted to `type: 'object'` — valid for the other providers, and Gemini requires the explicit type.
 */
export function reshapeForGemini(schema: JSONSchema7, toolName: string): Record<string, unknown> {
  const reshaped = reshapeNode(schema, toolName, 0);
  if (!isRecord(reshaped)) {
    throw new ToolSchemaError('gemini', toolName, 'tool parameters must be an object schema');
  }
  const type = reshaped['type'];
  if (type === undefined) {
    return { ...reshaped, type: 'object' };
  }
  if (type !== 'object') {
    throw new ToolSchemaError('gemini', toolName, 'tool parameters must be an object schema');
  }
  return reshaped;
}

// --- Tool-call response → canonical ContentPart ----------------------------------------------

type ToolCallPart = Extract<ContentPart, { type: 'tool_call' }>;

/**
 * Synthesizes and tracks tool-call ids for Gemini, which exposes **no native tool-call id**. An id
 * is minted by call order on the `functionCall`, then matched back (FIFO per name) when the
 * `functionResponse` — which references by name only — arrives. So callers always see stable ids.
 *
 * **Lifetime:** construct one instance per Gemini request/stream; never reuse or share it across
 * requests — a shared instance would interleave the per-name queues and mis-pair ids.
 */
export class GeminiToolCallIds {
  #counter = 0;
  readonly #pendingByName = new Map<string, string[]>();

  /** Mint a stable id for a Gemini `functionCall` and remember it for the matching response. */
  synthesize(name: string): string {
    const id = `gemini-tool-${this.#counter}-${name}`;
    this.#counter += 1;
    const queue = this.#pendingByName.get(name) ?? [];
    queue.push(id);
    this.#pendingByName.set(name, queue);
    return id;
  }

  /** Resolve the id for a `functionResponse` (referenced by name) — FIFO per name. */
  resolveResponse(name: string): string {
    const id = this.#pendingByName.get(name)?.shift();
    if (id === undefined) {
      throw new ToolSchemaError(
        'gemini',
        name,
        'functionResponse has no matching synthesized tool-call id',
      );
    }
    return id;
  }
}

/**
 * Fold a provider's tool-call response into one canonical `tool_call` `ContentPart`. The adapter
 * extracts `{ id, name, args }` from its SDK's shape first (for Gemini, minting `id` via
 * `GeminiToolCallIds`), so every caller sees a normal id. `id` and `name` come from the (untrusted)
 * provider SDK shape, so an empty one is rejected here with a typed error rather than left to fail
 * the downstream `ContentPartSchema` (which requires non-empty ids/names).
 */
export function normalizeToolCall(
  provider: ProviderId,
  extracted: { id: string; name: string; args: unknown },
): ToolCallPart {
  if (extracted.id.length === 0 || extracted.name.length === 0) {
    throw new ToolSchemaError(
      provider,
      extracted.name.length === 0 ? '(unnamed)' : extracted.name,
      'a tool call must carry a non-empty id and name',
    );
  }
  return { type: 'tool_call', id: extracted.id, name: extracted.name, args: extracted.args };
}
