import { z } from 'zod';

/**
 * Generic Zod primitives reused across the domain schemas. These are internal
 * building blocks — they are intentionally **not** re-exported from `index.ts`
 * (the public surface is the named domain schemas, not these helpers).
 */

/**
 * The kebab-case body pattern (lowercase alphanumerics in dash-separated segments).
 * Exported so the edge schema can build the `nodeId(:handle)?` form from the same
 * source of truth rather than duplicating the regex.
 */
export const KEBAB_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** A kebab-case id (`workflow.id`, `node.id`, `agent.id`, `agent_ref`). */
export const kebabIdSchema = z
  .string()
  .regex(
    new RegExp(`^${KEBAB_PATTERN}$`),
    'must be kebab-case (lowercase alphanumerics, dash-separated)',
  );

/** A non-empty string. */
export const nonEmptyString = z.string().min(1);

/**
 * An identifier referenceable from `{{inputs.<name>}}` / `{{ctx.<key>}}` (`workflow.inputs[].name`,
 * `workflow.context[].key`). It must match the interpolation lexer's head charset (the `NAMESPACED`
 * rule in `@relavium/core` `references.ts`) — otherwise a schema-valid name could never be referenced.
 * Aligning the authored contract with the lexer is an ADR-0023 fail-loud tightening.
 */
export const INTERPOLATION_NAME_PATTERN = '[A-Za-z0-9_-]+';
export const interpolationNameSchema = z
  .string()
  .regex(
    new RegExp(`^${INTERPOLATION_NAME_PATTERN}$`),
    'must be referenceable in {{ … }} (letters, digits, `_` or `-`)',
  );

/**
 * A `Record<string, unknown>` that comes back as the SAME object it went in as.
 *
 * `z.record(z.string(), z.unknown())` REBUILDS the object, and its rebuild drops an own `__proto__` key —
 * measured on the pinned Zod version:
 * `z.record(z.string(), z.unknown()).parse(JSON.parse('{"__proto__":"p","n":3}'))` yields own keys `['n']`.
 *
 * That matters for `run:started.inputs`. A workflow input name may legitimately be `__proto__` (the
 * `[A-Za-z0-9_-]+` grammar permits it), the engine builds its input map with a null prototype specifically
 * so such a name survives (ADR-0083 §7), and the bus then re-parsed the draft through the event schema and
 * lost it. The run executed with the input; the durable record did not carry it; and §5's resume
 * verification compared two maps that agreed only because both were missing it. A review measured exactly
 * that.
 *
 * Acceptance is delegated to `z.record` rather than re-implemented, so this differs from it in one respect
 * only: what it returns. Arrays, `null`, primitives and non-plain objects are rejected identically.
 */
export const preservingUnknownRecord = z.custom<Record<string, unknown>>(
  (value) => z.record(z.string(), z.unknown()).safeParse(value).success,
  { message: 'expected an object' },
);

/** A positive integer (>= 1). */
export const positiveInt = z.number().int().positive();

/** A non-negative integer (>= 0). */
export const nonNegativeInt = z.number().int().nonnegative();

/**
 * Matches a URL that embeds credentials in its authority (`scheme://user:pass@host`).
 * Secrets must never live in a git-committed URL — auth belongs in env/keychain. Linear,
 * no backtracking (the `@` must precede any `/?#`), so no ReDoS. Used by the MCP url guards.
 */
export const URL_HAS_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/**
 * A generation temperature: a finite number in the provider-agnostic `[0, 2]` envelope
 * (no NaN/Infinity/negative). Shared by `AgentSchema` and the agent node override so the
 * bound lives in one place. Per-provider limits (e.g. Anthropic's `[0, 1]`) are enforced in
 * the `@relavium/llm` adapter, not here — the contract stays provider-agnostic.
 */
export const temperatureSchema = z.number().finite().min(0).max(2);

/**
 * A permissive JSON-Schema-subset metadata map (`input_schema` / `output_schema` on agents and
 * agent/transform nodes). Centralized here so the agent-level and node-level uses stay in lock-step
 * without an agent↔node import cycle; the deep JSON-Schema-subset validation is an engine concern.
 */
export const jsonSchemaMetadataSchema = z.record(z.string(), z.unknown());

/**
 * The distinct values that appear more than once, in first-duplicate order. One O(n) Set-based
 * implementation shared by the duplicate-id `superRefine`s in `agent.ts` and `workflow.ts`
 * (each caller shapes its own issue message/path).
 */
export const findDuplicates = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
};
