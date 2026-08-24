/**
 * Resume identity — what a resumed run must prove before it continues
 * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
 * §5, §6, §8).
 *
 * **The caller's copy is VERIFIED, not trusted.** `resumeFromCheckpoint` used to take `inputs` and
 * `executionMode` from its caller and hand them straight to the rehydrated execution, on a documented
 * "invariant (caller's responsibility)" that nothing checked. A `relavium gate` in a fresh process that
 * reconstructed either one differently — or a caller that simply passed `{}` — silently continued the run
 * under a state its own `run:started` never had.
 *
 * **The authority is the durable log**, folded into `CheckpointState.admittedInputs` / `.executionMode`.
 * Not `runs.input_json`: naming one source is what makes "verify" a well-defined operation, and the ordered
 * event log is the truth ADR-0078 built. The engine reads no second copy, so there is no disagreement to
 * arbitrate.
 *
 * **Pure and synchronous**, like the admission gate it pairs with — it compares two maps and answers yes or
 * no. Every refusal it returns is one the caller must fix; the lease release is the caller's job, because
 * only `resumeFromCheckpoint` knows it holds one.
 */

import {
  isReferenceableInputName,
  MaskedSecretSchema,
  WorkflowSchema,
  type ExecutionMode,
  type Workflow,
} from '@relavium/shared';

import { deepStructuralEquals } from './deep-equal.js';
import { resolveAndValidateWorkflowInputs } from './input-admission.js';

/**
 * Why a resume was refused. Each is a PERMANENT invocation fault — the same call fails identically forever
 * (ADR-0083 §11) — and each maps 1:1 to an `EngineStateErrorCode`.
 */
export type ResumeIdentityCode =
  /** A supplied input differs from the one the run was admitted with, or names a slot the run never had. */
  | 'input_mismatch'
  /** The supplied workflow is the same slug with different CONTENT than the run started on. */
  | 'workflow_content_mismatch'
  /** The frozen definition exists but cannot be read as a workflow — nothing can be verified against it. */
  | 'admission_record_unreadable'
  /** A supplied `executionMode` differs from the one the run started under. */
  | 'execution_mode_mismatch'
  /** A `secret` input the record holds as a masked slot was not re-supplied. */
  | 'secret_input_missing'
  /** A `secret` input was supplied for a slot the record does not carry. */
  | 'secret_input_unexpected';

export interface ResumeIdentityRefusal {
  readonly code: ResumeIdentityCode;
  readonly message: string;
}

export type ResumeIdentityResult =
  | {
      readonly ok: true;
      /** What the run CONTINUES with — the record, with each masked secret slot re-filled by the caller. */
      readonly inputs: Readonly<Record<string, unknown>>;
      /** The recorded mode, always. A caller may match it; a caller cannot choose it. */
      readonly executionMode: ExecutionMode;
    }
  | { readonly ok: false; readonly refusal: ResumeIdentityRefusal };

/** A name is interpolated into a refusal only when it satisfies the grammar a declared name is parsed by. */
function named(name: string, suffix: string): string {
  return isReferenceableInputName(name) ? `input \`${name}\`: ${suffix}` : `an input: ${suffix}`;
}

function isMaskedSecret(value: unknown): boolean {
  return MaskedSecretSchema.safeParse(value).success;
}

function snapshotSupplied(
  raw: Readonly<Record<string, unknown>> | undefined,
):
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly refusal: ResumeIdentityRefusal } {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (raw === undefined) return { ok: true, value: out };
  let keys: readonly string[];
  try {
    // The LISTING is caller code too, on an exotic object — an `ownKeys` trap that throws would escape
    // `resumeFromCheckpoint` as somebody else's `Error`, past the lease release and past every caller
    // narrowing on `EngineStateError`.
    keys = Object.keys(raw);
  } catch {
    return {
      ok: false,
      refusal: { code: 'input_mismatch', message: 'the supplied inputs could not be enumerated' },
    };
  }
  for (const key of keys) {
    try {
      out[key] = raw[key];
    } catch {
      return {
        ok: false,
        refusal: {
          code: 'input_mismatch',
          message: named(key, 'reading the supplied value threw'),
        },
      };
    }
  }
  return { ok: true, value: out };
}

/**
 * Verify a caller's resume against the run's own admission record, and produce the map the run continues
 * with.
 *
 * The returned map is the RECORD — not the caller's — with one exception the ADR makes explicit: a `secret`
 * input is never persisted, so its recorded entry is the masked placeholder `{ secret: true, ref }` and the
 * caller must re-supply the value. §6 states exactly what that proves: the SLOT is verified, not the
 * credential. A rotated key resumes; this mechanism cannot see it, and pretending otherwise would be the
 * more dangerous claim.
 */
export function verifyResumeIdentity(params: {
  readonly workflow: Workflow;
  readonly recordedInputs: Readonly<Record<string, unknown>>;
  readonly recordedExecutionMode: ExecutionMode;
  readonly suppliedInputs: Readonly<Record<string, unknown>> | undefined;
  readonly suppliedExecutionMode: ExecutionMode | undefined;
}): ResumeIdentityResult {
  const { recordedInputs, recordedExecutionMode } = params;
  // **Materialised ONCE, through a guarded read.** The caller's map is an ordinary object it still owns:
  // a key may be an accessor that throws, or one that answers differently on a second read — which would
  // let the comparison below pass on one value and the run continue on another. Snapshotting removes both,
  // and gives the rest of this function a plain null-prototype map to reason about.
  const snapshot = snapshotSupplied(params.suppliedInputs);
  if (!snapshot.ok) return snapshot;
  const supplied = snapshot.value;

  const modeRefusal = executionModeRefusal(params.suppliedExecutionMode, recordedExecutionMode);
  if (modeRefusal !== undefined) return { ok: false, refusal: modeRefusal };

  const secretNames = new Set(
    (params.workflow.workflow.inputs ?? [])
      .filter((declaredInput) => declaredInput.type === 'secret')
      .map((declaredInput) => declaredInput.name),
  );

  const reconciled = reconcileRecorded(recordedInputs, supplied, secretNames);
  if (!reconciled.ok) return reconciled;
  const effective = reconciled.effective;

  const extraRefusal = unexpectedSuppliedRefusal(supplied, recordedInputs, secretNames);
  if (extraRefusal !== undefined) return { ok: false, refusal: extraRefusal };

  // The SAME contract check `start()` runs (§8), in `verify` mode: the record is the authority, so no
  // default is invented and no presence rule is re-litigated — but every value present is held to the
  // workflow's declared contract, which is what stops a record and a workflow from silently disagreeing.
  const admitted = resolveAndValidateWorkflowInputs(params.workflow, effective, 'verify');
  if (!admitted.ok) {
    return {
      ok: false,
      refusal: { code: 'input_mismatch', message: inputMismatchMessage(admitted.issues[0]) },
    };
  }

  return { ok: true, inputs: admitted.inputs, executionMode: recordedExecutionMode };
}

/**
 * The refusal text for a recorded input the supplied workflow no longer accepts.
 *
 * Three cases, and the reason each exists: no issue at all (the validator refused without naming one — the
 * message must still say something true), an issue with no field name (a whole-record problem, so there is
 * nothing to name), and the ordinary named one. Only the FIRST issue is reported, deliberately: a resume
 * refusal is a stop sign, not a validation report, and a caller who fixes the first will see the second.
 */
function inputMismatchMessage(first: { name?: string; message: string } | undefined): string {
  const base = 'the recorded inputs do not satisfy the supplied workflow';
  if (first === undefined) return base;
  if (first.name === undefined) return `${base}: ${first.message}`;
  return named(first.name, first.message);
}

/**
 * Does the supplied workflow have the same CONTENT as the one the run was frozen with (ADR-0083 §5)?
 *
 * The surrogate-id guard above this in `resumeFromCheckpoint` catches resuming the wrong workflow entirely.
 * It cannot catch the same slug with edited content — the "subtler same-slug-edited-content drift" its own
 * comment named and deferred to a content hash on `run:started`. This answers it without one:
 * [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) §4's deferred hash needed a digest
 * primitive a platform-free engine does not have, and a digest over raw YAML would report a mismatch for
 * reindented text that parses identically. Comparing the NORMALIZED parse output asks the question actually
 * being asked.
 *
 * **Each side is normalized according to how much it is trusted.** The frozen JSON is durable data of unknown
 * provenance, so it goes through `WorkflowSchema` — a value that will not parse as a workflow is
 * `admission_record_unreadable`, which is a different fact from "it differs" and has a different remedy. The
 * supplied side is already a parsed `Workflow` by type, so it only takes the JSON round trip the column
 * imposed on the other side: `JSON.stringify` drops `undefined`-valued keys, and comparing a live object
 * against a round-tripped one would report a difference the column could never have recorded.
 *
 * Returns `undefined` when the two agree.
 */
export function verifyFrozenWorkflowContent(
  frozenJson: string,
  supplied: Workflow,
): ResumeIdentityRefusal | undefined {
  const unreadable = (message: string): ResumeIdentityRefusal => ({
    code: 'admission_record_unreadable',
    message,
  });
  let frozen: unknown;
  try {
    frozen = JSON.parse(frozenJson);
  } catch {
    return unreadable('the frozen workflow definition for this run is not valid JSON');
  }
  const normalizedFrozen = WorkflowSchema.safeParse(frozen);
  if (!normalizedFrozen.success) {
    // Value-free: the reason list would carry authored content from a workflow this process did not write.
    return unreadable(
      'the frozen workflow definition for this run is not a workflow this engine can read',
    );
  }
  let normalizedSupplied: unknown;
  try {
    // **NOT `structuredClone`.** This round trip is doing two jobs a clone does not. It NORMALISES to JSON
    // shape — dropping `undefined` properties, rendering a Date as its ISO string — so two values compare
    // equal exactly when they would serialise equal, which is the property the comparison below is defined
    // on. And it THROWS on input JSON cannot represent or cannot walk, which is what the `catch` around it
    // exists for. `structuredClone` clones a Date, a Map and a cycle happily, so it would delete both.
    normalizedSupplied = JSON.parse(JSON.stringify(supplied)); // NOSONAR — a normaliser AND a guard; see above
  } catch {
    return {
      code: 'workflow_content_mismatch',
      message: 'the supplied workflow is not serialisable',
    };
  }
  // The FROZEN side takes the same guarded round trip as the supplied one — and it is the side that needed
  // it more. `WorkflowSchema` accepts a `metadata` record of `z.unknown()` without recursing into it, so a
  // snapshot carrying a deeply nested value passes validation and then blows the stack inside
  // `JSON.stringify`. A review measured that: a ~60,000-deep array under `workflow.metadata` threw a raw
  // `RangeError` out of `resumeFromCheckpoint`, past the typed seam (the CLI reported "an unexpected internal
  // error", exit 1, for a run that never started) and past the lease release — stranding the run for a full
  // TTL. This function's own docblock calls the frozen JSON "durable data of unknown provenance"; the guard
  // now matches the description.
  let normalizedFrozenValue: unknown;
  try {
    normalizedFrozenValue = JSON.parse(JSON.stringify(normalizedFrozen.data)); // NOSONAR — as above: a normaliser AND the guard this `catch` needs
  } catch {
    return unreadable('the frozen workflow definition for this run could not be normalised');
  }
  if (!deepStructuralEquals(normalizedFrozenValue, normalizedSupplied)) {
    return {
      code: 'workflow_content_mismatch',
      // VALUE-FREE, and deliberately so: naming the differing field would mean walking two authored graphs
      // and echoing whichever part diverged into an error message and every log sink.
      message:
        'the supplied workflow has the same id but different content than the one this run started on',
    };
  }
  return undefined;
}

/**
 * A caller that names an execution mode must name the recorded one.
 *
 * A caller that names NONE takes the recorded one — not the `'local'` default the previous code fell back
 * to, which turned an omission into a mode change.
 */
function executionModeRefusal(
  supplied: ExecutionMode | undefined,
  recorded: ExecutionMode,
): ResumeIdentityRefusal | undefined {
  if (supplied === undefined || supplied === recorded) return undefined;
  return {
    code: 'execution_mode_mismatch',
    // Both values are members of a closed enum, so naming them is safe and is the actionable part.
    message: `this run started in \`${recorded}\` mode; the resume supplied \`${supplied}\``,
  };
}

/**
 * Build the effective input map from the RECORD, key by key, so a caller's map can never contribute a key
 * the run did not have — refusing on the first key where the two disagree.
 */
function reconcileRecorded(
  recordedInputs: Readonly<Record<string, unknown>>,
  supplied: Readonly<Record<string, unknown>>,
  secretNames: ReadonlySet<string>,
):
  | { ok: true; effective: Record<string, unknown> }
  | { ok: false; refusal: ResumeIdentityRefusal } {
  const effective: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(recordedInputs)) {
    const recorded = recordedInputs[key];
    const isSlot = isMaskedSecret(recorded);
    if (secretNames.has(key) !== isSlot) {
      // The workflow and the record disagree about whether this input is a secret. Either the record holds
      // a raw value where a masked slot belongs — which this engine has never emitted — or it holds a slot
      // for an input the workflow no longer declares secret. Both are content divergence, and §5's
      // workflow-content check names it better; this refuses rather than guessing which side is right.
      return {
        ok: false,
        refusal: {
          code: 'input_mismatch',
          message: named(
            key,
            isSlot
              ? 'the run recorded this as a secret, but the supplied workflow no longer declares it one'
              : 'the supplied workflow declares this a secret, but the run recorded a value for it',
          ),
        },
      };
    }
    if (isSlot) {
      const resupplied = resuppliedSecret(key, supplied);
      if (resupplied.ok) effective[key] = resupplied.value;
      else return resupplied;
      continue;
    }
    if (Object.hasOwn(supplied, key) && !deepStructuralEquals(supplied[key], recorded)) {
      return {
        ok: false,
        refusal: {
          code: 'input_mismatch',
          // VALUE-FREE. The two values are the run's own data; naming them would put arbitrary caller and
          // record content into an error message and every log sink downstream of it.
          message: named(key, 'the supplied value is not the one this run was admitted with'),
        },
      };
    }
    effective[key] = recorded;
  }
  return { ok: true, effective };
}

/**
 * The re-supplied value for a masked secret slot, or the refusal (§6).
 *
 * A secret is not in the record and cannot be: the caller re-supplies it by name, or the resume is refused.
 * It is never silently substituted, defaulted, or dropped to `undefined`.
 *
 * The PLACEHOLDER is not a value. A caller that rebuilds its input map from the durable record — which is
 * exactly what `relavium gate` does, reading `runs.input_json` — holds `{ secret: true, ref }` for this key,
 * and accepting that would let the run continue with the mask as its credential: every downstream
 * `{{inputs.<name>}}` evaluating to a marker object instead of failing. The CLI's own
 * `assertNoMaskedSecretInputs` refuses it one layer up; the engine must not depend on that.
 */
function resuppliedSecret(
  key: string,
  supplied: Readonly<Record<string, unknown>>,
): { ok: true; value: unknown } | { ok: false; refusal: ResumeIdentityRefusal } {
  const resupplied = Object.hasOwn(supplied, key) ? supplied[key] : undefined;
  if (resupplied === undefined || isMaskedSecret(resupplied)) {
    return {
      ok: false,
      refusal: {
        code: 'secret_input_missing',
        message: named(key, 'this run needs its `secret` value re-supplied to resume'),
      },
    };
  }
  return { ok: true, value: resupplied };
}

/**
 * A supplied key the run never had — which admitting would let a resume INTRODUCE an input.
 *
 * An own `undefined` is an omission, exactly as it is at admission, and is skipped.
 */
function unexpectedSuppliedRefusal(
  supplied: Readonly<Record<string, unknown>>,
  recordedInputs: Readonly<Record<string, unknown>>,
  secretNames: ReadonlySet<string>,
): ResumeIdentityRefusal | undefined {
  for (const key of Object.keys(supplied)) {
    if (Object.hasOwn(recordedInputs, key) || supplied[key] === undefined) continue;
    return secretNames.has(key)
      ? {
          code: 'secret_input_unexpected',
          message: named(key, 'this run holds no `secret` slot by this name'),
        }
      : {
          code: 'input_mismatch',
          message: named(key, 'this run was not admitted with this input'),
        };
  }
  return undefined;
}
