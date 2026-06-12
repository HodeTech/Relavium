/**
 * Static, parse-time interpolation analyses (1.L2) — no values, no I/O, pure functions over an
 * already-validated `Workflow` and the structured references `collectReferences` yields.
 *
 *  - `analyzeSecretTaint` enforces ADR-0029(c): a `secret`-typed input — or anything transitively
 *    derived from one through a `context` entry *or* an `input` default — must never reach agent/human
 *    text. An input's *type* alone seeds the taint, so the whole check runs before any secret value is
 *    fetched.
 *  - `analyzeContextReferences` enforces the eager-context rule (workflow-yaml-spec.md
 *    §Context-and-interpolation): a `context` value may read `{{inputs.*}}`/`{{ctx.*}}` but not
 *    `{{run.outputs[…]}}`, because context is resolved before any node runs.
 *
 * Both name only fields, input names, and context keys — never an authored value — so their findings
 * are safe to surface and log.
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
  readonly ctx: ReadonlyMap<string, string>;
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
 * Find `context` values that reference a node output. Empty when clean; the parser turns a non-empty
 * result into a `WorkflowValidationError` (a field-named parse error).
 */
export function analyzeContextReferences(workflow: Workflow): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  for (const entry of workflow.workflow.context ?? []) {
    for (const ref of templateReferences(entry.value)) {
      if (ref.kind === 'node') {
        issues.push({
          field: `context \`${entry.key}\`.value`,
          message: `cannot reference \`run.outputs[…]\` — context is resolved before any node runs`,
        });
        break; // one issue per context entry is enough to fail the parse
      }
    }
  }
  return issues;
}

/**
 * Compute the taint sets to a fixpoint. Seeds from `secret`-typed inputs, then closes the taint over
 * both intermediates a secret can be laundered through — an `input` default and a `context` value —
 * iterating until nothing new is tainted (so order of declaration does not matter, and a multi-hop
 * chain through inputs and context resolves).
 */
function computeTaint(spec: Workflow['workflow']): TaintSets {
  const inputs = new Map<string, string | undefined>();
  const ctx = new Map<string, string>();
  for (const input of spec.inputs ?? []) {
    if (input.type === 'secret') {
      inputs.set(input.name, undefined); // a source — no deeper "via"
    }
  }

  const current: TaintSets = { inputs, ctx };
  let changed = true;
  while (changed) {
    changed = false;
    for (const input of spec.inputs ?? []) {
      if (inputs.has(input.name) || typeof input.default !== 'string') {
        continue;
      }
      const reason = firstTaintReason(input.default, current);
      if (reason !== undefined) {
        inputs.set(input.name, reason);
        changed = true;
      }
    }
    for (const entry of spec.context ?? []) {
      if (ctx.has(entry.key)) {
        continue;
      }
      const reason = firstTaintReason(entry.value, current);
      if (reason !== undefined) {
        ctx.set(entry.key, reason);
        changed = true;
      }
    }
  }
  return current;
}

/** The first tainted symbol any reference in `text` reads, or `undefined` if the text is clean. */
function firstTaintReason(text: string, taint: TaintSets): string | undefined {
  for (const ref of templateReferences(text)) {
    const reason = taintReason(ref, taint);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
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
