/**
 * Input admission — the gate a run passes before it exists
 * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
 * §1, §2, §7).
 *
 * **Pure and synchronous.** It reads a parsed workflow and a caller's raw inputs and answers yes or no.
 * Nothing here touches a clock, a store, a host capability or a signal — which is what lets it run BEFORE
 * the run id is generated and before the first event is emitted, and what makes "a rejected run is not a
 * run" expressible at all. An async admission would need a cancellation contract and an ordering rule
 * against the lease, for a step whose whole job is to say yes or no to a map.
 *
 * **The engine is strict; the surface coerces.** Given a `number`-typed input this accepts `3`, never
 * `"3"`. A CLI has only strings, so `--input count=3` becomes a number in the CLI, which is the only layer
 * that knows its transport. Coercing here would silently accept a form's stringly-typed payload as
 * validated and bury each surface's quirks in shared code.
 */

import {
  violatesInputContract,
  type Workflow,
  type WorkflowInput,
} from '@relavium/shared';

/** Why a run was refused admission. Structural and value-free — these reach a caller and a log. */
export interface InputAdmissionIssue {
  /** The input this is about, or `undefined` for a whole-map problem (an unknown key names itself). */
  readonly name: string;
  readonly message: string;
}

export type InputAdmissionResult =
  | { readonly ok: true; readonly inputs: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly issues: readonly InputAdmissionIssue[] };

/**
 * Resolve a caller's inputs against the authored contract.
 *
 * Returns EVERY issue, not the first: a caller correcting a five-input invocation should learn all five
 * problems in one round trip, the way the parser already reports authored mistakes.
 */
export function resolveAndValidateWorkflowInputs(
  workflow: Workflow,
  raw: Readonly<Record<string, unknown>> | undefined,
): InputAdmissionResult {
  const declared: readonly WorkflowInput[] = workflow.workflow.inputs ?? [];
  const supplied = raw ?? {};
  const issues: InputAdmissionIssue[] = [];

  // Unknown keys first — a typo'd name is the most common mistake and the least useful to report as
  // "missing required input" for the one it was meant to be.
  const declaredNames = new Set(declared.map((input) => input.name));
  for (const key of Object.keys(supplied)) {
    if (!declaredNames.has(key)) {
      issues.push({ name: key, message: 'unknown input — the workflow declares no input by this name' });
    }
  }

  // **BUILT, not cloned** (§7). A fresh null-prototype map, filled by walking the DECLARED inputs and
  // reading the caller's object through `Object.hasOwn`. The caller's object is never spread, assigned
  // from, or cloned wholesale — so mutating it after `start()` cannot change the run, and an input
  // legitimately named `__proto__` (the `[A-Za-z0-9_-]+` grammar permits it) cannot reach a prototype
  // setter on the way in. `structuredClone` would not have helped: it does not preserve a null prototype,
  // and the hazard was never the clone but the accumulator.
  const resolved: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const input of declared) {
    const provided = Object.hasOwn(supplied, input.name) ? supplied[input.name] : undefined;
    // Absent means absent: a missing key and an own `undefined` are both omissions and take the default.
    // `null` is a VALUE and falls through to validation, where it fails every declared type.
    if (provided === undefined) {
      if (input.default !== undefined) {
        // Already validated against this input's own contract at parse, so it needs no re-check — and a
        // `required` input with a default is satisfied by it.
        resolved[input.name] = input.default;
        continue;
      }
      if (input.required === true) {
        issues.push({ name: input.name, message: 'missing required input' });
      }
      continue;
    }
    const reason = violatesInputContract(provided, input.type, input.validation);
    if (reason === undefined) {
      resolved[input.name] = provided;
    } else {
      issues.push({ name: input.name, message: reason });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, inputs: resolved };
}
