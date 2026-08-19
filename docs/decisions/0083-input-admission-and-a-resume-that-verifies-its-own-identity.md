# ADR-0083: One input-admission gate in the engine, and a resume that verifies its own identity instead of trusting the caller

- **Status**: Proposed
- **Date**: 2026-08-19
- **Related**:
  - [ADR-0023](0023-strict-authored-yaml-validation.md) — parse-time validation, whose "an authored mistake fails loudly" rule §3 extends to a declared `default`.
  - [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) — the run loop and `run:started`. **Would be amended on acceptance**: `run:started` becomes the durable record of what the run was admitted with.
  - [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) — its §4 deferred "a content hash on `run:started`" for same-slug workflow drift. §5 here answers that without one.
  - [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) — the nearest precedent: a resume that cannot be trusted refuses.
  - [ADR-0029](0029-tool-policy-hardening.md) — its secret-interpolation half, which a `secret` input rides on; §6's re-supply contract is built from that, not around it.
  - [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) — the authored input contract this finally enforces.
  - [database-schema.md](../reference/shared-core/database-schema.md) — `runs.workflow_definition_snapshot`, `runs.input_json`, `runs.execution_mode`, which already hold most of what §5 needs.
- **Addresses**: `CR-15` and `CR-17` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md). A Proposed ADR does not close a work item; on acceptance this becomes **Closes/Decides** and the §9 obligations land with the implementation.

## Context

Two gaps that share one question: **what was this run admitted with?**

### The authored input contract is validated by nobody

`WorkflowInputSchema` carries `required`, `default`, `type` and a `validation` block with `format`,
`pattern`, `enum`, `min`, `max`, `min_length` and `max_length` — plus a per-type table saying which keys are
legal on which type. Parse time enforces the AUTHORING rules: that `min <= max`, that a `*_length` is not put
on a number. It says nothing about the VALUES a caller supplies.

And nothing else does either. `WorkflowEngine.start()` takes the caller's `inputs` object and hands it to the
run execution, which stores the reference without cloning, validating, or applying a single declared
`default`. The input node reads straight out of that map.

The CLI does what a surface can: it rejects unknown keys, rejects a missing required input, and coerces its
argv strings into declared types. Its own code then says, of an omitted value:

> `continue; // omitted — the engine applies the declared default, if any`

The engine does not. A declared default arrives as `undefined`, an out-of-enum value reaches deep execution,
and every other surface — desktop, extension, the Phase-2 API — gets whatever validation it happens to
implement. That is the "one engine, every surface" guarantee failing at its first step.

### A resume trusts identity it never verifies

`ResumeFromCheckpointInput`'s own docblock states the gap and calls the remedy "a future revision":

> `workflow`, `inputs`, `executionMode`, and `planOptions` must be the SAME values the run started with. The
> checkpoint persists the workflow identity (verified — a mismatch throws `workflow_mismatch`) but does not
> yet persist `inputs` / `executionMode`, so passing different ones would silently diverge the rehydrated
> execution from its `run:started` state.

**But the durable record is already there, and this ADR is smaller than the phase document assumes.**
Verified against the tree rather than inferred:

- `runs.workflow_definition_snapshot` holds *"the frozen graph that actually ran — for replay/resume after
  the YAML changes."*
- `runs.input_json` holds the inputs; `runs.execution_mode` holds the mode.
- `run:started` carries `inputs` and `executionMode` in the event log too, with every `secret`-typed input
  already masked to `{ secret: true, ref: 'inputs.<name>' }`.
- `relavium gate` **already** resumes from that snapshot: it loads the frozen definition, restores
  `input_json`, and calls `assertNoMaskedSecretInputs` — refusing rather than substituting when a masked
  secret comes back.

So the CLI already does most of what `CR-17` asks. What is missing is that **the engine does not require
it**. A guarantee kept by one host's convention is not a guarantee; a desktop, an extension or the Phase-2
API can resume the same run with different inputs and a different mode, and nothing errors. Writing this ADR
as though the persistence were absent would have produced a second, competing store for data that is already
durable — the mistake ADR-0082's first draft made about commitment tracking.

## Decision

**We will add one pure admission gate in the engine that resolves and validates inputs before a run exists,
and make resume RECONSTRUCT its identity from the durable record rather than accept the caller's.**

### 1. `resolveAndValidateWorkflowInputs` — pure, in core, before anything exists

A pure function in `packages/core`, taking the parsed workflow and the caller's raw inputs and returning
either the resolved input map or a typed admission error. It runs in `start()` **before the run id is
generated and before the first event is emitted**.

That ordering is the decision, not an implementation detail. An admission failure must leave **no `runId`, no
`run:started`, no row** — a rejected run is not a run, and a caller that retries with corrected inputs must
not be reasoning about a half-created one.

### 2. The surface coerces; the engine is strict

Stated normatively because the split is currently implicit and each surface guesses.

- **A surface may COERCE** — turn its transport's representation into the declared type. A CLI has only
  strings, so `--input count=3` must become the number `3` somewhere, and the surface is the only layer that
  knows its transport.
- **The engine is STRICT** about what it receives. Given a `number`-typed input it accepts a number, not
  `"3"`. It applies defaults, checks `required`, rejects unknown keys, and enforces every `validation` field.

The engine does not coerce because coercion is lossy and surface-specific — `"true"`, `"1"` and `"yes"` are a
CLI's problem, not a shared contract's — and a strict core is what makes two surfaces behave identically.

Considered and rejected: coercing in the engine (one place, but it would silently accept a desktop form's
stringly-typed payload as if it were validated, and bury each surface's quirks in shared code); validating
only at the surface (the status quo — N implementations of one contract).

### 3. A declared `default` is validated at PARSE, not at run

An authored default that violates its own `validation` block is an authoring mistake, and
[ADR-0023](0023-strict-authored-yaml-validation.md) already says those fail loudly at parse. Catching it
at run time would make a workflow that parses cleanly fail only when someone omits that input — which may be
never, until it is.

This extends `WorkflowInputSchema`'s existing `superRefine`, which already cross-checks type against
validation keys. No new mechanism.

### 4. The engine CLONES the caller's inputs

The run holds its own copy. Mutating the caller's object after `start()` returns must not change what the run
sees — today it can, because the reference is stored directly. A run's inputs are part of its identity, and
identity that a third party can edit mid-flight is not identity.

`structuredClone`, not `JSON.parse(JSON.stringify(...))`: the latter re-materializes a `__proto__` key as a
prototype, and an input name may legitimately be `__proto__` under the `[A-Za-z0-9_-]+` grammar. The engine
already null-prototypes its masked-input map for exactly this reason.

### 5. Resume reconstructs identity from the durable record; the caller's copy is VERIFIED, not trusted

On `resumeFromCheckpoint` the engine takes `inputs` and `executionMode` from the run's own durable record and
ignores the caller's — except to verify them, so a host that passes something different learns it rather than
being silently overridden. A mismatch is a typed error.

**Workflow identity is verified by CONTENT, not by slug — and without a new digest.** The frozen definition
is already persisted, so the check is a comparison against what actually ran. That answers
[ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) §4's deferred *"a content hash on
`run:started`"* without a canonical event-contract change and without asking a platform-free engine to
compute SHA-256 (the same constraint that shaped ADR-0080's host-side digest).

`planOptions` is the residue and is treated honestly: its `agents` map is host-resolved from the filesystem
and is NOT persisted, so it cannot be reconstructed. The engine verifies what it can — that the resolved
agent ids match the plan the run started on — and §8 records the rest as a known limitation rather than
implying a completeness the mechanism does not have.

### 6. A `secret` input is a reference, and resume REFUSES rather than substitutes

A `secret`-typed value is never persisted. The durable record already carries
`{ secret: true, ref: 'inputs.<name>' }`, and that is what resume reads.

The contract on resume: the caller **re-supplies** the secret by name, the engine matches it against the
recorded ref, and a missing or unexpected secret is a typed error. It is never silently substituted, never
defaulted, and never dropped to `undefined` — a run that quietly continues with a different credential than
it started with is the worst available outcome, and the CLI's existing `assertNoMaskedSecretInputs` already
takes the refusing side of this. The engine adopts that behaviour as the contract rather than leaving it as
one host's caution.

**No version field.** `CR-17` proposes "a key reference plus version"; the tree has no key-versioning
concept, and inventing one here would be a second, unused mechanism. The ref plus a re-supply requirement is
what the current keychain model can actually enforce; §8 names versioning as out of scope.

### 7. `start` and `resume` apply the SAME admission

Both go through §1. A resumed run's inputs are the durable ones, so admission is re-verification rather than
re-resolution — but running the same function means a rule cannot hold on one path and not the other, which
is how the two drifted in the first place.

### 8. What is NOT decided here

- **Key versioning for `secret` inputs** (§6). No such concept exists; adding one is its own decision.
- **`planOptions.agents` reconstruction.** Host-resolved from disk, not persisted. Verified by id, not by
  content — an agent file edited between processes is not detected, and that is a named limitation, not an
  oversight.
- **Coercion rules per surface.** Each surface owns its transport's conversions; this ADR only fixes the
  boundary.
- **Retrofitting existing rows.** A run started before this lands has no admission record beyond what is
  already in `runs`; resume verifies what is there and does not invent what is not.

### 9. Acceptance

Per the phase's "the whole authored contract, not a sample":

1. A missing `required` input fails admission.
2. An unknown input key fails admission.
3. **Every** `validation` field — `format`, `pattern`, `enum`, `min`, `max`, `min_length`, `max_length` —
   rejects a violating value and accepts a conforming one. One case each, both directions.
4. A declared `default` is applied when the input is omitted, and a default that violates its own rules fails
   at PARSE, not at run.
5. The engine is strict: a `number`-typed input rejects `"3"`. The CLI's coercion turning `"3"` into `3`
   before the engine sees it is pinned separately, so the split is proven from both sides.
6. The engine clones: mutating the caller's `inputs` object after `start()` does not change the run.
7. An admission failure produces a typed error and **no `runId`, no `run:started`, and an untouched store** —
   asserted by inspecting the store, not by the absence of a throw.
8. `start` and `resume` reject the same violating input.
9. A resume whose caller passes DIFFERENT inputs, a different `executionMode`, or a content-different
   workflow is a typed error — one test per axis, each asserting the run did not continue.
10. A resume that omits a required `secret` is a typed error; one that supplies it proceeds; and the
    persisted record still contains only the ref, never the value.
11. **No assertion that a secret's VALUE round-trips** — proving that would require persisting it.

### 10. Landing obligations

- ADR-0036: a dated amendment noting `run:started` is the admission record a resume verifies against.
- [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md): where each validation field is
  enforced, and the surface-coerces/engine-is-strict split.
- [execution-model.md](../architecture/execution-model.md): admission as a named step before run creation.
- The `ResumeFromCheckpointInput` docblock's "a future revision will…" replaced with what shipped.
- This ADR to Accepted, with the index row to match.

## Consequences

### Positive

- The authored contract is enforced once, in the layer every surface shares, instead of N times or not at all.
- A rejected run leaves nothing behind, so a caller's retry is not reasoning about a partial run.
- A resumed run is provably the run that started: same inputs, same mode, same graph content.
- No new persisted state and no event-contract change — the record already exists; this reads it.
- The secret path gets stricter without a new mechanism: refuse, never substitute.

### Negative

- **Strictness will break callers that were passing stringly-typed values.** A desktop or extension host
  sending `"3"` for a `number` input works today and stops working. That is the bug being fixed, and it will
  surface as a regression in those surfaces before it surfaces as correctness. Mitigated only by saying so
  here and in the spec.
- **Resume gains failure modes that did not exist.** A host that was quietly resuming with different inputs
  now gets a typed error. That is the point, and it will look like a new bug to whoever was relying on the
  old behaviour.
- **`planOptions.agents` stays unverified by content.** An agent file edited between processes is not
  detected. Named in §8 rather than left implied, and it is strictly better than today, where nothing is.
- **A `secret` input must be re-supplied on every resume.** More friction on an unattended resume, and the
  honest cost of never persisting a credential.
