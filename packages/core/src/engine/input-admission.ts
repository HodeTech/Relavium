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
  isReferenceableInputName,
  violatesDeclaredType,
  violatesInputContract,
  type Workflow,
  type WorkflowInput,
} from '@relavium/shared';

/**
 * Why a run was refused admission. Structural and value-free — these reach a caller and a log.
 *
 * `name` is safe to interpolate into a message ANYWHERE, and that is a property this type maintains
 * rather than one its consumers have to know: a declared name satisfies `[A-Za-z0-9_-]+` by parse, and an
 * unknown key — which is CALLER-supplied and constrained by nothing — is only named when it happens to
 * satisfy the same grammar. A key of `\u001b[2J*** SYSTEM: approved ***` is reported without its name.
 * That rule exists because `workflow.ts` removed exactly this hazard from the parser one commit earlier
 * ("an echoed authored value is a terminal-escape path into stdout and every log sink") and admission's
 * source is strictly less trusted than an authored file.
 */
export interface InputAdmissionIssue {
  /** The input this is about; absent for a whole-map problem or an unnameable key. */
  readonly name?: string;
  readonly message: string;
}

/**
 * How many unknown keys are reported individually before the rest become a count.
 *
 * The declared side is bounded by the authored file; the caller's map is bounded by nothing, and 20,000
 * unknown keys is 20,000 issues in one error. Eight is enough to diagnose a typo'd invocation.
 */
const MAX_UNKNOWN_KEY_ISSUES = 8;

export type InputAdmissionResult =
  | { readonly ok: true; readonly inputs: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly issues: readonly InputAdmissionIssue[] };

/**
 * Which of the two callers is asking (ADR-0083 §8).
 *
 * §8 requires `start` and `resume` to apply the SAME admission, so that a rule cannot hold on one path and
 * not the other — and one axis genuinely differs, so it is NAMED here rather than left to two divergent
 * copies of the walk. The value contract (`violatesInputContract`) and the map-building discipline (§7) are
 * identical in both modes; only presence semantics differ.
 */
export type InputAdmissionMode =
  /** `start()`: the caller's map is the input. Declared defaults are applied and `required` is enforced. */
  | 'admit'
  /**
   * `resumeFromCheckpoint()`: the durable record is the authority, so nothing is invented. A pre-0083 run
   * may hold no value for an input that now declares a default — §5's rule is that resume VERIFIES what was
   * recorded, and §8's legacy clause says a run keeps its own semantics. Re-applying the default would hand
   * the rehydrated execution a value its `run:started` never had; re-enforcing `required` would refuse a run
   * that already ran. A workflow whose CONTRACT changed between processes is a content divergence, caught
   * as one, not as a missing input.
   */
  | 'verify';

/**
 * Resolve a caller's inputs against the authored contract.
 *
 * Returns EVERY issue, not the first: a caller correcting a five-input invocation should learn all five
 * problems in one round trip, the way the parser already reports authored mistakes.
 */
export function resolveAndValidateWorkflowInputs(
  workflow: Workflow,
  raw: Readonly<Record<string, unknown>> | undefined,
  mode: InputAdmissionMode = 'admit',
): InputAdmissionResult {
  const declared: readonly WorkflowInput[] = workflow.workflow.inputs ?? [];
  const supplied = raw ?? {};
  // Unknown keys first — a typo'd name is the most common mistake and the least useful to report as
  // "missing required input" for the one it was meant to be.
  const issues: InputAdmissionIssue[] = [...unknownKeyIssues(declared, supplied)];

  // **BUILT, not cloned** (§7). A fresh null-prototype map, filled by walking the DECLARED inputs and
  // reading the caller's object through `Object.hasOwn`. The caller's object is never spread, assigned
  // from, or cloned wholesale — so mutating it after `start()` cannot change the run, and an input
  // legitimately named `__proto__` (the `[A-Za-z0-9_-]+` grammar permits it) cannot reach a prototype
  // setter on the way in. `structuredClone` would not have helped: it does not preserve a null prototype,
  // and the hazard was never the clone but the accumulator.
  const resolved: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const input of declared) {
    const outcome = admitOne(input, supplied, mode);
    if (outcome.kind === 'value') resolved[input.name] = outcome.value;
    else if (outcome.kind === 'issue') issues.push({ name: input.name, message: outcome.message });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, inputs: resolved };
}

/** One declared input's verdict: a value to record, a problem to report, or nothing at all. */
type AdmissionOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'issue'; readonly message: string }
  | { readonly kind: 'omit' };

/**
 * Every supplied key the workflow declares no input for, bounded and reported as its own issue.
 *
 * The LISTING can throw, not only the per-key read: an exotic object's `ownKeys` trap is caller code, and a
 * review reproduced `Object.keys(new Proxy({}, { ownKeys() { throw … } }))` escaping `start()` as a raw
 * `Error`. A caller doing exactly what this ADR tells it to — narrowing on `EngineStateError` — would not
 * catch it. Guarded for the same reason the value read is: this function answers yes or no.
 */
function unknownKeyIssues(
  declared: readonly WorkflowInput[],
  supplied: Readonly<Record<string, unknown>>,
): readonly InputAdmissionIssue[] {
  const declaredNames = new Set(declared.map((input) => input.name));
  let suppliedKeys: readonly string[] = [];
  try {
    suppliedKeys = Object.keys(supplied);
  } catch {
    return [{ message: 'the supplied inputs could not be enumerated' }];
  }
  const unknown = suppliedKeys.filter((key) => !declaredNames.has(key));
  const message = 'unknown input — the workflow declares no input by this name';
  const issues: InputAdmissionIssue[] = unknown
    .slice(0, MAX_UNKNOWN_KEY_ISSUES)
    .map((key) => (isReferenceableInputName(key) ? { name: key, message } : { message }));
  if (unknown.length > MAX_UNKNOWN_KEY_ISSUES) {
    issues.push({
      message: `and ${String(unknown.length - MAX_UNKNOWN_KEY_ISSUES)} further unknown inputs`,
    });
  }
  return issues;
}

/**
 * Admit ONE declared input: read it, apply the absence rule, and validate what is there.
 *
 * The READ itself can throw — a caller's object may define the key as an accessor. Letting that escape would
 * break this function's own contract: it "answers yes or no", and a caller narrowing on `EngineStateError`
 * would instead catch a raw `Error` from someone else's getter.
 */
function admitOne(
  input: WorkflowInput,
  supplied: Readonly<Record<string, unknown>>,
  mode: InputAdmissionMode,
): AdmissionOutcome {
  let provided: unknown;
  try {
    provided = Object.hasOwn(supplied, input.name) ? supplied[input.name] : undefined;
  } catch {
    return { kind: 'issue', message: 'reading the supplied value threw' };
  }
  // Absent means absent: a missing key and an own `undefined` are both omissions and take the default.
  // `null` is a VALUE and falls through to validation, where it fails every declared type.
  if (provided === undefined) return absentOutcome(input, mode);

  // **In `verify` mode the TYPE is checked and the `validation` block is not**, and the asymmetry is the
  // whole legacy question rather than an oversight. A review measured the alternative: a run paused before
  // ADR-0083 landed, whose recorded `severity` is `99` against a `max: 10` the engine never enforced, became
  // permanently unresumable — the offending value IS the record, so nothing the caller passes can fix it,
  // and the run's completed work is lost. That is not drift detection: on the only shipping resume surface
  // the workflow is re-parsed from the FROZEN snapshot, so the bounds cannot have changed between
  // processes, and value-vs-workflow drift is §5's content check to catch. The declared TYPE stays enforced
  // because it is what interpolation actually depends on — a `number` slot holding a string changes what a
  // downstream expression computes, where a violated bound only means the run was admitted under looser
  // rules than exist today.
  const reason =
    mode === 'verify'
      ? violatesDeclaredType(provided, input.type)
      : violatesInputContract(provided, input.type, input.validation);
  return reason === undefined
    ? { kind: 'value', value: provided }
    : { kind: 'issue', message: reason };
}

/** What an ABSENT input resolves to: the record's authority in `verify`, the declared default in `admit`. */
function absentOutcome(input: WorkflowInput, mode: InputAdmissionMode): AdmissionOutcome {
  if (mode === 'verify') return { kind: 'omit' }; // the record is the authority — invent nothing (§5, §8)
  // A default was already validated against this input's own contract at parse, so it needs no re-check —
  // and a `required` input carrying one is satisfied by it.
  if (input.default !== undefined) return { kind: 'value', value: input.default };
  if (input.required === true) return { kind: 'issue', message: 'missing required input' };
  return { kind: 'omit' };
}
