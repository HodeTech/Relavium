/**
 * `output_schema` — compiled once at parse, enforced at run time
 * ([ADR-0092](../../../docs/decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md)
 * §3, §4).
 *
 * [ADR-0038](../../../docs/decisions/0038-agent-node-output-contract.md) required an agent's declared
 * `output_schema` to be validated against the response, because no adapter validates it. What shipped was
 * parse-as-JSON: a response that parsed but did not CONFORM was accepted, so a schema declaring
 * `{ required: ['status'] }` admitted `{}` and the next node read `undefined` from a field the author had
 * marked required. A `transform`'s `output_schema` was not checked at all, and its handler said so in a
 * comment citing a deferral this closes.
 *
 * Two obligations, and the split matters:
 *
 * - **At PARSE**, the schema is compiled in `strict` mode. An unsupported keyword, or a malformed value for
 *   a supported one, is an authoring error refused before a run id exists — the discipline
 *   [ADR-0023](../../../docs/decisions/0023-strict-authored-yaml-validation.md) applies to every other
 *   authored value.
 * - **At RUN TIME**, the compiled validator checks the parsed output and a miss is a `validation` failure
 *   with `retryable: false`, which is what ADR-0038 specified.
 *
 * The validator is **derived, never persisted**. A plan and a checkpoint stay plain serializable data, and
 * a resumed run recompiles from the same authored text — so the check cannot drift from the schema across a
 * replay. The memo below is keyed on the authored schema OBJECT, which the parser produces once per load,
 * so a caller reaching the runner directly (no plan) compiles on first use and pays nothing after.
 */

import { compileJsonSchemaToZod, type CompileResult, type SchemaBounds } from '@relavium/shared';

import { AUTHORED_SCHEMA_BOUNDS } from './limits.js';

/**
 * Compiled validators, keyed on the authored schema object.
 *
 * A `WeakMap` rather than a `Map`: the key is a node's own parsed schema, so the entry dies with the
 * workflow that owns it and a long-lived engine cannot accumulate validators for workflows it has finished
 * — the retention shape [ADR-0087](../../../docs/decisions/0087-consumed-streams-size-bounds-and-run-retention.md)
 * exists to prevent.
 */
const COMPILED = new WeakMap<object, CompileResult>();

/** Compile an authored `output_schema` in `strict` mode under {@link AUTHORED_SCHEMA_BOUNDS}, memoized. */
export function compileOutputSchema(schema: object): CompileResult {
  const cached = COMPILED.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = compileJsonSchemaToZod(
    schema,
    AUTHORED_SCHEMA_BOUNDS satisfies SchemaBounds,
    'strict',
  );
  COMPILED.set(schema, compiled);
  return compiled;
}

/**
 * Does `value` conform to the authored `output_schema`? Returns `undefined` when it does.
 *
 * **The message names nothing** — not the failing property, not any part of the value (ADR-0092 §5). A
 * property name is authored and a value is model output, which is the least trusted thing in the run; a
 * conformance message that quoted either would be the one place a secret could ride out of a node failure
 * into an event payload and a log. The cost is a terse failure, and it is the deliberate trade.
 *
 * A schema that fails to COMPILE fails the node too, as `internal` rather than `validation`. Parse refuses
 * every such schema, so reaching here with an uncompilable one means the node was dispatched without going
 * through the builder — a wiring mistake. An earlier version returned `undefined` (= conforms) so as not to
 * blame the model for it, and that was the wrong trade: it completed the node with an output nothing had
 * checked, which is the silent-acceptance this whole change exists to remove. The distinct code is what
 * keeps it from looking like the model's fault.
 */
export function outputSchemaMiss(
  schema: object,
  value: unknown,
): { readonly code: 'validation' | 'internal'; readonly message: string } | undefined {
  const compiled = compileOutputSchema(schema);
  if (!compiled.ok) {
    return {
      code: 'internal',
      message:
        'the output_schema could not be compiled — the node was dispatched without a built plan',
    };
  }
  return compiled.schema.safeParse(value).success
    ? undefined
    : { code: 'validation', message: 'the output did not conform to output_schema' };
}
