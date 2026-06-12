/**
 * Static, parse-time interpolation analyses (1.L2) — no values, no I/O, pure functions over an
 * already-validated `Workflow` and the structured references `collectReferences` yields.
 *
 *  - `analyzeSecretTaint` enforces ADR-0029(c): a `secret`-typed input — or anything transitively
 *    derived from one through a `context` entry *or* an `input` default — must never reach agent/human
 *    text. An input's *type* alone seeds the taint, so the whole check runs before any secret value is
 *    fetched.
 *  - `analyzePreRunReferences` enforces the eager-resolution rule (workflow-yaml-spec.md
 *    §Context-and-interpolation): a value resolved **before any node runs** — a `context` value or an
 *    `input` default — may read `{{inputs.*}}`/`{{ctx.*}}` but not `{{run.outputs[…]}}`.
 *
 * Both name only fields, input names, and context keys — never an authored value — so their findings
 * are safe to surface and log.
 *
 * Scope: this analysis covers the `{{ … }}` template graph only. Secret flow through the JS expression
 * fields (`condition`/`transform`/`merge_fn`) and through `run.outputs` is the responsibility of the
 * expression sandbox (1.AB) and the run loop (1.M/1.O) — a `transform` that returns a secret cannot be
 * caught here because it is not a template. ADR-0029(c)'s "any derived value" spans those layers too.
 */

import type { Workflow } from '@relavium/shared';

import type { SecretLeak, WorkflowIssue } from '../errors.js';

import { collectReferences } from './collect.js';
import { templateReferences, type InterpolationReference } from './references.js';

/**
 * The transitive taint sets — which input names and context keys carry (or launder) a secret. An
 * input is tainted if it is `secret`-typed or its default reads a tainted symbol; a context key is
 * tainted if its value reads one. The stored string is the deeper tainted symbol (the "via"), kept
 * for a precise, value-free error message; a source secret input has `undefined` (no deeper hop).
 */
interface TaintSets {
  readonly inputs: ReadonlyMap<string, string | undefined>;
  readonly ctx: ReadonlyMap<string, string | undefined>;
}

/**
 * Find every place a secret reaches agent/human text. Empty when the workflow is clean; the parser
 * turns a non-empty result into a `WorkflowSecretLeakError` (rejected at parse).
 */
export function analyzeSecretTaint(workflow: Workflow): readonly SecretLeak[] {
  const taint = computeTaint(workflow.workflow);

  const leaks: SecretLeak[] = [];
  for (const site of collectReferences(workflow)) {
    // Only model/human-visible text is a leak; context values and input defaults are where taint
    // legitimately propagates (closed over by `computeTaint`), never themselves a model-bound site.
    if (site.category === 'context-value' || site.category === 'input-default') {
      continue;
    }
    for (const ref of site.references) {
      const reason = taintReason(ref, taint);
      if (reason !== undefined) {
        leaks.push(toLeak(site.location, reason, taint));
      }
    }
  }
  return leaks;
}

/**
 * Find a value resolved before any node runs that references a node output. Empty when clean; the
 * parser turns a non-empty result into a `WorkflowValidationError` (a field-named parse error).
 */
export function analyzePreRunReferences(workflow: Workflow): readonly WorkflowIssue[] {
  const spec = workflow.workflow;
  const issues: WorkflowIssue[] = [];
  const checkNoNodeOutput = (field: string, text: string): void => {
    for (const ref of templateReferences(text)) {
      if (ref.kind === 'node') {
        issues.push({
          field,
          message: `cannot reference \`run.outputs[…]\` — this is resolved before any node runs`,
        });
        return; // one issue per site is enough to fail the parse
      }
    }
  };
  for (const entry of spec.context ?? []) {
    checkNoNodeOutput(`context \`${entry.key}\`.value`, entry.value);
  }
  for (const input of spec.inputs ?? []) {
    // Only a string default is a template. A `{{ … }}` nested in a STRUCTURED default
    // (`default: { token: '{{secrets.x}}' }`) is not scanned — it is never re-interpolated either
    // (`resolveTemplate` is single-pass, so `| json` emits the literal `{{…}}`, not a resolved value),
    // so this is a deferral to the 1.M typed-input layer, not a gap that leaks.
    if (typeof input.default === 'string') {
      checkNoNodeOutput(`input \`${input.name}\`.default`, input.default);
    }
  }
  return issues;
}

/** Mutable graph state for the linear taint pass: tainted symbols, reverse edges, and the worklist. */
interface TaintGraph {
  readonly tainted: Map<string, string | undefined>; // symbol id (`inputs.<n>`/`ctx.<k>`) → deeper "via"
  readonly dependents: Map<string, string[]>; // target symbol → the fields that read it
  readonly queue: string[];
}

/** Mark a symbol tainted (idempotent) and enqueue it for propagation. */
function seedTaint(graph: TaintGraph, id: string, via: string | undefined): void {
  if (!graph.tainted.has(id)) {
    graph.tainted.set(id, via);
    graph.queue.push(id);
  }
}

/** Record that `dependent` reads `target`, so tainting `target` later taints `dependent`. */
function addEdge(graph: TaintGraph, target: string, dependent: string): void {
  const list = graph.dependents.get(target);
  if (list === undefined) {
    graph.dependents.set(target, [dependent]);
  } else {
    list.push(dependent);
  }
}

/** Scan one pre-run field's references: a `secrets.*` read seeds it; an inputs/ctx read adds an edge. */
function scanField(graph: TaintGraph, id: string, text: string | undefined): void {
  if (text === undefined) {
    return;
  }
  for (const ref of templateReferences(text)) {
    if (ref.kind === 'secrets') {
      seedTaint(graph, id, `secrets.${ref.identifier}`); // reads a secret store directly → a source
    } else if (ref.kind === 'inputs') {
      addEdge(graph, `inputs.${ref.identifier}`, id);
    } else if (ref.kind === 'ctx') {
      addEdge(graph, `ctx.${ref.identifier}`, id);
    }
  }
}

/** Drain the worklist: tainting a target taints every field that reads it (via = the target). */
function propagateTaint(graph: TaintGraph): void {
  while (graph.queue.length > 0) {
    const target = graph.queue.pop();
    if (target === undefined) {
      break;
    }
    for (const dependent of graph.dependents.get(target) ?? []) {
      seedTaint(graph, dependent, target);
    }
  }
}

/** Split the flat `symbol → via` map back into the per-namespace taint sets the leak check reads. */
function projectTaint(tainted: ReadonlyMap<string, string | undefined>): TaintSets {
  const inputs = new Map<string, string | undefined>();
  const ctx = new Map<string, string | undefined>();
  for (const [id, via] of tainted) {
    if (id.startsWith('inputs.')) {
      inputs.set(id.slice('inputs.'.length), via);
    } else if (id.startsWith('ctx.')) {
      ctx.set(id.slice('ctx.'.length), via);
    }
  }
  return { inputs, ctx };
}

/**
 * Compute the taint sets in **linear** time. Each pre-run field (an `input` default or a `context`
 * value) is parsed for its references exactly once; a secret source (a `secret`-typed input, or a
 * field reading `{{secrets.*}}`) seeds a worklist, and taint propagates along reverse-dependency edges
 * until the queue drains — O(symbols + references), with no per-round re-parsing. Deliberately not a
 * rescan-to-fixpoint loop: that was O(N²) over the entry count and let a small reversed-laundering
 * chain YAML stall the synchronous parse gate.
 */
function computeTaint(spec: Workflow['workflow']): TaintSets {
  const graph: TaintGraph = { tainted: new Map(), dependents: new Map(), queue: [] };
  for (const input of spec.inputs ?? []) {
    if (input.type === 'secret') {
      seedTaint(graph, `inputs.${input.name}`, undefined); // a source secret — no deeper "via"
    }
    // Only a string default carries a template; a `{{ … }}` inside a STRUCTURED default is not scanned
    // (and never re-interpolated), so it cannot launder a secret — deferred to the 1.M typed-input layer.
    const fallback = typeof input.default === 'string' ? input.default : undefined;
    scanField(graph, `inputs.${input.name}`, fallback);
  }
  for (const entry of spec.context ?? []) {
    scanField(graph, `ctx.${entry.key}`, entry.value);
  }
  propagateTaint(graph);
  return projectTaint(graph.tainted);
}

/** The tainted symbol a reference reads, or `undefined` if it is clean. Names only — never a value. */
function taintReason(ref: InterpolationReference, taint: TaintSets): string | undefined {
  if (ref.kind === 'inputs' && taint.inputs.has(ref.identifier)) {
    return `inputs.${ref.identifier}`;
  }
  if (ref.kind === 'ctx' && taint.ctx.has(ref.identifier)) {
    return `ctx.${ref.identifier}`;
  }
  if (ref.kind === 'secrets') {
    return `secrets.${ref.identifier}`;
  }
  return undefined;
}

/** Build a leak finding, attaching the deeper "via" symbol when the taint was laundered. */
function toLeak(location: string, secret: string, taint: TaintSets): SecretLeak {
  const via = viaOf(secret, taint);
  return { location, secret, ...(via === undefined ? {} : { via }) };
}

/** The deeper tainted symbol a laundered input/ctx symbol came from (a source secret has none). */
function viaOf(secret: string, taint: TaintSets): string | undefined {
  if (secret.startsWith('ctx.')) {
    return taint.ctx.get(secret.slice('ctx.'.length));
  }
  if (secret.startsWith('inputs.')) {
    return taint.inputs.get(secret.slice('inputs.'.length));
  }
  return undefined; // a direct `secrets.*` reference
}
