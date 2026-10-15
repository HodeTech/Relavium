# ADR-0113: Secret-derived context keeps provenance at public sinks

- **Status**: Proposed
- **Date**: 2026-10-15
- **Related**: [ADR-0027](0027-expression-sandbox.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0038](0038-agentrunner-llm-call-boundary.md), [ADR-0050](0050-cli-history-db-at-rest-posture.md), [ADR-0083](0083-input-admission-and-a-resume-that-verifies-its-own-identity.md), [ADR-0093](0093-an-expression-sees-only-what-it-is-ordered-after.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

At `702cdc9c`, actual WorkflowEngine + standard executor + QuickJS accepts secret
input → context alias → JavaScript transform. Direct, computed, serialized,
transitive/nested and custom-merge reads expose the canary in node/run completion.
A condition can select a branch using its raw value. Actual SQLite history stores
the leak in run events, step outputs and run outputs. A downstream human gate can
display the escaped transform output. Direct model/human templates already refuse
tainted context at parse; these are preservation controls, not absent defences.
SandboxError's private detail can also contain the canary although its public
message and JSON do not.

The public trusted `resolveContext` contract allows raw intermediate secret
resolution. That does not require passing raw derived strings into every executor:
there is no shipping workflow tool-mapping consumer needing them. Node inputs
still have the existing trusted-host raw contract and must remain masked before
sandbox/public output. Qualifying context does not make arbitrary executors
a secret-free trust domain.

The earlier proposal to inject markers would silently turn a secret comparison
into a false branch or let a marker satisfy an output schema. Its additional
preparation field had no VM consumer. Both mechanisms are replaced below, while
the existing direct-input marker contract stays unchanged.

All decisions remain Proposed. Exact interfaces and error behaviour belong in
[expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md#proposed-wave-3-secret-context-boundary)
and its linked runner/tool contracts. No new dependency, engine ErrorCode,
credential sink or tool-mapping feature is authorized.

## Decision

### Qualify once at the engine boundary

Reuse the existing linear declared-source taint graph for input/default/context
relationships. One pure authority computes provenance; no value scanning, second
expression scanner or argument-name heuristic is introduced. Derive immutable
arrays once from the same admitted workflow, copying before freezing; freezing a
Set would not prevent mutation.

Keep the exported trusted resolver's raw result contract. Immediately qualify its
result inside the engine, before storing or handing context to execution or
budget preparation. The one owned projection contains only clean context strings
and denied-key metadata, never raw tainted strings. Replace the low-level context
field with this required projection and migrate every actual producer/double.
Missing projection refuses with a fixed typed validation failure; there is no
implicit clean default. Trusted hosts remain responsible for honest admitted
workflow/input provenance; shape validation cannot detect a deliberate lie.

Execution and preparation consume the **same** projection. Preparation uses a
public-template resolver which rejects denied references before filters/defaults;
this is a real template consumer, not a fictitious preparation sandbox. Clean
templates work unchanged. Fresh, same-process resume and cross-process budget
preparation cannot reconstruct raw unqualified context. Trusted raw resolution
stays local to the resolver/projection cut rather than a second executor authority.

### Denied access fails loudly

Expression scopes serialize only clean context and denied-key metadata. Inside
QuickJS, create frozen context accessors for denied keys with an inaccessible
sticky denial latch. Evaluate authored code in a separate lexical environment
receiving only the public bindings; a guessed wrapper-local name or eval cannot
reset the latch. Capture required intrinsic operations before author execution.
After evaluation **and result serialization**, check the latch before accepting a
condition, transform or custom merge. This covers caught access, returned ctx,
nested outputs, getters and toJSON, not just literal property reads.

Any denied value access produces the fixed non-retryable secret-context sandbox
failure specified in the canonical contract, even if authored code catches the
accessor's exception. It cannot become a false condition, generic TypeError,
successful marker or output-schema success. No raw value enters the VM or its
error detail. Clean context reads and key-only enumeration remain usable. Preserve
existing condition/output serialization rules; prototype/intrinsic mutation cannot
replace the trusted result check. This mechanism requires real VM causal controls,
not only a host Proxy or wrapper mock.

A synthetic probe on the installed QuickJS supports private lexical latch,
caught-read and serialization feasibility; it is not product implementation.
Permanent actual-engine/store tests below must establish the final mechanism.
Existing direct-input markers remain their Accepted contract; extending this
fail-loud rule to them is not silently included.

### Tool provenance scope

Retain the external `secretArgKeys` guard without inventing a tool-mapping producer.
Current agent/session dispatches supply empty config and model JSON has no
declared-input provenance. Absence is a documented **unverified** external
provenance state, not proof of clean arguments; the compatibility interface remains
optional and is not a universal secrecy guarantee. A mapped path must refuse
missing provenance before approval/effect dispatch. This wave neither enables such
a path nor falsely certifies it. The nonempty external guard's current refusal
remains a preservation/causal control.

Explicitly reconcile both contradictory passages in
[tool-registry.md](../reference/shared-core/tool-registry.md#proposed-wave-3-http-authority-and-secret-provenance):
the dispatch-context secret-args comment and Guardrail enforcement's claimed
1.O/1.V nested-path producer. Record no current producer and the future mandatory
final-argument obligation once in that canonical home. #92 receives an honest
documented limitation; the actual context leak is repaired separately.

This does not mask arbitrary user/model text or encrypt history. ADR-0050/0095
retain their precise scopes. Existing historical SandboxError.detail may contain
sensitive authored text; do not call it universally secret-free or render it.
New denied-context errors contain fixed diagnostics without source/value text.

Considered handler-only marker projection: rejected for silent branching/schema
changes and repeating the second-gate defect. Considered qualifying once at engine
construction: selected for raw-value removal, with actual VM/template consumers
for loud refusal. Considered rejecting all expressions when any context is tainted:
rejected because unrelated clean expressions must work. Static literal scanning
alone cannot close computed/whole-context access. Full dynamic output taint and
fabricated empty tool metadata add unsupported claims without repairing the sink.

### Acceptance and landing

1. Actual WorkflowEngine + createStandardNodeExecutor + QuickJS controls cover
   direct/computed/serialized/transitive/nested/custom merge, caught access,
   condition oracle, returned ctx/getters/toJSON and intrinsic/latch tampering.
   Assert the expected typed failed outcome, no branch/output-schema success and
   no raw VM input/error detail. Independently successful clean workflows must
   complete with exact expected outputs; no vacuous negative-only test.
2. Actual SQLite hosts scan `run_events.payload_json`,
   `step_executions.output_json` and `runs.output_json`, plus public events and
   downstream human gate messages. Clean positive rows prove persistence occurred;
   leak fixtures prove the baseline fails the confidentiality assertion.
3. Every fresh/resume/preparation producer supplies the owned projection.
   Missing metadata and mutation controls exercise actual VM and public-template
   consumers. Removing engine qualification, template refusal or VM latch breaks
   its corresponding regression with exact restoration.
4. Direct/transitive parser model/human refusal, trusted raw resolver, direct-input
   markers and external tool guard retain their existing behaviour. Label already
   passing controls as preservation; no nonexistent mapping producer is certified.
5. Dedicated secret-flow security sitting, required gates and two new independent
   complete cumulative clean rounds precede implementation acceptance. At ADR
   acceptance append ADR-0027/0029/0037/0083/0093 forward notes before dependent
   code. Land canonical workflow, runner, expression and both tool passages and
   register actual #92 limitation separately from repaired exposure.

## Consequences

### Positive

- Raw derived context no longer reaches executor/preparation or expression scopes.
- Denied expressions fail explicitly, including computed and caught accesses.

### Negative

- Expressions previously reading leaked context now fail deliberately. This is
  an explicit security compatibility change; clean and direct-input behaviour stays pinned.
- Low-level embeddings migrate to a required owned projection and template/VM
  consumers. A trusted host's fabricated provenance remains outside the guarantee.
