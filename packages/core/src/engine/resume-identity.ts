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
  for (const key of Object.keys(raw)) {
    try {
      out[key] = raw[key];
    } catch {
      return {
        ok: false,
        refusal: { code: 'input_mismatch', message: named(key, 'reading the supplied value threw') },
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

  // A caller that names a mode must name the recorded one. A caller that names none takes the recorded one
  // — NOT the `'local'` default the previous code fell back to, which turned an omission into a mode change.
  if (
    params.suppliedExecutionMode !== undefined &&
    params.suppliedExecutionMode !== recordedExecutionMode
  ) {
    return {
      ok: false,
      refusal: {
        code: 'execution_mode_mismatch',
        // Both values are members of a closed enum, so naming them is safe and is the actionable part.
        message: `this run started in \`${recordedExecutionMode}\` mode; the resume supplied \`${params.suppliedExecutionMode}\``,
      },
    };
  }

  const secretNames = new Set(
    (params.workflow.workflow.inputs ?? [])
      .filter((declaredInput) => declaredInput.type === 'secret')
      .map((declaredInput) => declaredInput.name),
  );

  // Built key by key from the RECORD, so a caller's map can never contribute a key the run did not have.
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
      // A secret is not in the record and cannot be: the caller re-supplies it by name, or the resume is
      // refused. It is never silently substituted, defaulted, or dropped to `undefined` (§6).
      const resupplied = Object.hasOwn(supplied, key) ? supplied[key] : undefined;
      if (resupplied === undefined) {
        return {
          ok: false,
          refusal: {
            code: 'secret_input_missing',
            message: named(key, 'this run needs its `secret` value re-supplied to resume'),
          },
        };
      }
      effective[key] = resupplied;
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

  for (const key of Object.keys(supplied)) {
    if (Object.hasOwn(recordedInputs, key) || supplied[key] === undefined) continue;
    // An own `undefined` is an omission, exactly as it is at admission — skipped above. Anything else is a
    // key the run never had, and admitting it would let a resume introduce an input.
    return {
      ok: false,
      refusal: secretNames.has(key)
        ? {
            code: 'secret_input_unexpected',
            message: named(key, 'this run holds no `secret` slot by this name'),
          }
        : { code: 'input_mismatch', message: named(key, 'this run was not admitted with this input') },
    };
  }

  // The SAME contract check `start()` runs (§8), in `verify` mode: the record is the authority, so no
  // default is invented and no presence rule is re-litigated — but every value present is held to the
  // workflow's declared contract, which is what stops a record and a workflow from silently disagreeing.
  const admitted = resolveAndValidateWorkflowInputs(params.workflow, effective, 'verify');
  if (!admitted.ok) {
    const first = admitted.issues[0];
    return {
      ok: false,
      refusal: {
        code: 'input_mismatch',
        message:
          first === undefined
            ? 'the recorded inputs do not satisfy the supplied workflow'
            : first.name === undefined
              ? `the recorded inputs do not satisfy the supplied workflow: ${first.message}`
              : named(first.name, first.message),
      },
    };
  }

  return { ok: true, inputs: admitted.inputs, executionMode: recordedExecutionMode };
}
