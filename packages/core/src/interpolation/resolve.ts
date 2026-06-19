/**
 * The `{{ … }}` runtime resolver (1.L2) — turn an authored template into concrete text by evaluating
 * each reference against a {@link RunScope} and applying its pipe filters in order. Every node's input
 * flows through here (workflow-yaml-spec.md §Context-and-interpolation).
 *
 * Pure but for the host-injected `readFile` capability: given the same scope and capabilities, a
 * template resolves identically every time — the determinism the checkpoint/resume model (1.R) needs.
 * `resolveContext` realizes the spec's **eager-once, immutable** context: every `context` entry is
 * resolved a single time, in declared order (so a later entry may read an earlier one), into a frozen
 * snapshot. Resolution never mutates the scope and never reaches the filesystem directly.
 *
 * What this module does NOT do: it never resolves a `secret` into agent/human text — the parse-time
 * taint gate (`analyzeSecretTaint`) already rejected that, and {@link RunScope} carries no `secrets`
 * namespace. The whole-string JS fields (`condition`/`transform`/`merge_fn`) are not templates; they
 * belong to the expression sandbox (1.AB), not here.
 *
 * Provenance: `resolveTemplate` returns a plain string, flattening any `read_file`- / `run.outputs`-
 * derived (untrusted) content together with literals — it carries no taint marker. The structural
 * "untrusted-content-as-data" guarantee (docs/standards/security-review.md) binds the message-assembly
 * layer (1.O/1.T/1.V): a resolved field that drew on an untrusted source must be placed only in a
 * `user`/`tool` position, never `system`. That re-tainting is a 1.O/1.O-run-loop acceptance criterion,
 * not something this pure resolver can enforce once provenance is flattened.
 */

import type { AbortSignalLike, Workflow } from '@relavium/shared';

import { InterpolationError } from '../errors.js';

import { filterFn } from './filters.js';
import { getByPath } from './path.js';
import { parseTemplate, type InterpolationReference } from './references.js';
import type { ResolverCapabilities, RunScope } from './scope.js';

/**
 * Resolve an authored template string to concrete text. A literal segment passes through verbatim; a
 * `{{ … }}` reference is evaluated against `scope` and stringified.
 * @throws {InterpolationError} on an unknown namespace/filter, a bad filter application, an
 *   unserializable object used as text, or a reference that resolves to nothing without a `default`.
 */
export async function resolveTemplate(
  text: string,
  scope: RunScope,
  caps: ResolverCapabilities = {},
  signal?: AbortSignalLike,
): Promise<string> {
  let out = '';
  for (const segment of parseTemplate(text)) {
    if (segment.kind === 'literal') {
      out += segment.text;
    } else {
      abortIfCancelled(signal);
      const value = await resolveReference(segment.reference, scope, caps, signal);
      out += stringify(value, segment.reference);
    }
  }
  return out;
}

/**
 * Eagerly resolve every `context` entry exactly once into a frozen, immutable snapshot (the spec's
 * eager-once context). Entries resolve in declared order, each seeing the inputs and the already-
 * resolved context; the result is `Object.freeze`d so the run scope cannot drift mid-run.
 * @throws {InterpolationError} when a context value cannot be resolved (e.g. `read_file` on a bad path).
 */
export async function resolveContext(
  workflow: Workflow,
  inputs: Readonly<Record<string, unknown>>,
  caps: ResolverCapabilities = {},
  signal?: AbortSignalLike,
): Promise<Readonly<Record<string, string>>> {
  // A null-prototype accumulator so a context key named `__proto__`/`constructor` is stored as a real
  // own property rather than being silently dropped (or mutating a prototype). NOTE for 1.R: this
  // null-proto guard is in-memory only — when this frozen `ctx` is persisted/transported for
  // checkpoint/resume it MUST go through `structuredClone` (which preserves the null prototype), never
  // `JSON.stringify` → `JSON.parse`, which would re-materialize a `__proto__` key as a real setter.
  const ctx = Object.create(null) as Record<string, string>;
  for (const entry of workflow.workflow.context ?? []) {
    abortIfCancelled(signal);
    // No node has run yet, so `outputs` is empty; a `{{run.outputs[…]}}` reference here is already
    // rejected at parse (`analyzePreRunReferences`), so this only ever serves `inputs`/`ctx`.
    const scope: RunScope = { inputs, ctx, outputs: {} };
    ctx[entry.key] = await resolveTemplate(entry.value, scope, caps, signal);
  }
  return Object.freeze(ctx);
}

/** Resolve a single reference: head → trailing path → pipe filters (in order). */
async function resolveReference(
  ref: InterpolationReference,
  scope: RunScope,
  caps: ResolverCapabilities,
  signal?: AbortSignalLike,
): Promise<unknown> {
  let value = getByPath(resolveHead(ref, scope), ref.path, ref.raw);
  for (const filter of ref.filters) {
    value = await filterFn(filter, ref)(value, filter.args, caps, ref, signal);
  }
  return value;
}

/** Read the reference head from the run scope; an unserved namespace is a typed error. */
function resolveHead(ref: InterpolationReference, scope: RunScope): unknown {
  switch (ref.kind) {
    case 'inputs':
      return ownValue(scope.inputs, ref.identifier);
    case 'ctx':
      return ownValue(scope.ctx, ref.identifier);
    case 'node':
      return ownValue(scope.outputs, ref.identifier);
    case 'run':
      // `run.id` only (the lexer emits identifier `'id'`); resolves against the scope's runId when present.
      // `undefined` falls through to `stringify`'s typed `unresolved_reference` (never a silent empty path).
      return scope.runId;
    case 'secrets':
      throw new InterpolationError(
        'unknown_namespace',
        `\`secrets.*\` is not a runtime namespace — a \`secret\`-typed input feeds credential fields, never resolved text`,
        { location: ref.raw },
      );
    case 'unknown':
      throw new InterpolationError(
        'unknown_namespace',
        `cannot resolve \`${ref.identifier}\` — not an inputs/ctx/run.outputs reference`,
        { location: ref.raw },
      );
  }
}

/**
 * Read an OWN property only. A scope bag is assembled by the host from external data, so a
 * prototype/polluted key (`toString`, `__proto__`, `constructor`) is treated as a missing reference
 * (→ `undefined`, then `default`/`unresolved_reference`) rather than returning an inherited member.
 */
function ownValue(bag: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(bag, key) ? bag[key] : undefined;
}

/**
 * Cooperative cancellation between resolution steps: throw a typed `aborted` error once the run's
 * signal has fired. (`AbortSignalLike` is the engine's DOM/node-free signal type, so it exposes
 * `aborted` rather than `throwIfAborted()`; the same signal also forwards to the host `readFile`.)
 */
function abortIfCancelled(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted === true) {
    throw new InterpolationError('aborted', 'interpolation was aborted');
  }
}

/** Turn a resolved value into text — primitives stringify; an object needs an explicit `| json`. */
function stringify(value: unknown, ref: InterpolationReference): string {
  if (value === undefined || value === null) {
    throw new InterpolationError(
      'unresolved_reference',
      `\`${ref.raw}\` resolved to no value — check the reference or add a \`| default(…)\` filter`,
      { location: ref.raw },
    );
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new InterpolationError(
    'unserializable',
    `\`${ref.raw}\` resolved to ${Array.isArray(value) ? 'a list' : 'an object'} — add a \`| json\` filter to embed it as text`,
    { location: ref.raw },
  );
}
