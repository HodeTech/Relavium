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
preparation field had no VM consumer. Both mechanisms are replaced below; the
same silent comparison exists for direct secret-input markers. The revised
proposal applies denied-value access uniformly to both expression namespaces;
display/input-node masking remains unchanged.

All decisions remain Proposed. Exact interfaces and error behaviour belong in
[expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md#proposed-wave-3-secret-context-boundary)
and its linked runner/tool contracts. No new dependency, engine ErrorCode,
credential sink or tool-mapping feature is authorized.

## Decision

### Qualify once at the engine boundary

Reuse the existing linear declared-source taint graph for input/default/context
relationships. One pure authority computes provenance; no value scanning, second
expression scanner or argument-name heuristic is introduced. Derive immutable
arrays and a real immutable secret-input membership view once from the same
admitted workflow. Copy the backing data; freezing a Set does not prevent mutation.
Share this one authority through fresh/resume/preparation paths, not caller-owned
live Sets or separately derived lists.

Keep the exported trusted resolver's raw result contract. Immediately qualify its
result inside the engine, before storing or handing context to execution or
budget preparation. The one owned projection contains only clean context strings
and denied-key metadata plus the original full key order, never raw tainted
strings. Preserve existing context/input key enumeration rather than introducing
a lexical reorder or changing absent-input presence. Replace the low-level context
field with this required projection and migrate every actual producer/double.
Missing projection refuses with a fixed typed validation failure; there is no
implicit clean default. Trusted hosts remain responsible for honest admitted
workflow/input provenance; shape validation cannot detect a deliberate lie.

Execution and preparation consume the **same** projection. Preparation uses a
public-template resolver which rejects denied references before filters/defaults;
this is a real template consumer, not a fictitious preparation sandbox. It also
refuses direct secret-input references using that owned membership view, including
hand-constructed workflows that bypass parser checks. Clean templates work
unchanged. Fresh, same-process resume and cross-process budget
preparation cannot reconstruct raw unqualified context. Trusted raw resolution
stays local to the resolver/projection cut rather than a second executor authority.

### Remove denied values; report observed denied access

Expression scopes contain clean context/input values and explicit denied-name
metadata, never raw secret-input or tainted-context values. Direct secret inputs
now use the same denied accessors as context. This deliberately replaces the
expression-input marker rule in ADR-0027/0083; run-start/input-node/display markers
remain data under their existing contract. No universal rejection of marker-shaped
objects or arbitrary secret-looking user/model text is claimed.

Inside QuickJS create frozen denied accessors with a private sticky latch. Evaluate
authored code in a separate strict lexical environment receiving only the frozen
public pack with const bindings; capture trusted intrinsics first. Serialize the
authored result once to a primitive payload string **before** the final latch
check. The outer null-prototype control envelope contains only trusted primitive
metadata and that string; no authored object/getter/toJSON executes during its
later serialization. Host typeof/getString/parse/strict validation replaces
prototype-sensitive object dump. Preserve current result semantics through the
canonical tagged transport rather than indiscriminate JSON normalization.

When a denied accessor body executes, denial wins even if author code catches its
exception or triggers it during result serialization. Use the existing
sandbox_error code with fixed non-retryable secret_context reason, not a new
engine ErrorCode or an authored error-name test. No raw denied value/detail enters
the VM. Clean reads and key-only enumeration remain available.

**Finite semantic guarantee:** resource failure before the accessor body can be
caught without setting the latch; the installed QuickJS intake reproduces this.
Do not promise detection of every attempted access or universal fail-loud behaviour.
Raw-value exclusion still protects confidentiality in that case. An uncaught
resource failure keeps its existing classification. Latch purpose is preventing
silent false branching after an actually observed denied read, not supplying the
privacy boundary. Required tests pin the documented limitation and ordinary
caught-read denial; neither is disguised as full attempted-access detection.

ADR-0093 considered VM accessors for out-of-closure reads but preferred parse-time
refusal to retain before-money-spent ordering. This decision addresses runtime
secret-value exclusion and semantic diagnosis, not that scheduling guarantee; its
existing literal dependency scan remains. No host function is introduced.

The original ordinary-object wrapper allowed inherited-toJSON envelope forgery.
Primitive transport closes that path, but is not itself proof of complete latch
coverage or integrated result compatibility. Product engine/store acceptance
below remains required. Existing ordinary sandbox error classification is retained;
only the private secret-denial arm is independent of authored name/message.

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
New denied-value errors contain fixed diagnostics without source/value text.
Previously persisted event/step/run output or error detail can still contain
sensitive content: this change does not rewrite history, value-scan replayed
outputs or certify legacy resume data secret-free. Document that at-rest/recovery
limit with ADR-0050; never auto-render private error detail.

Considered handler-only marker projection: rejected for silent branching/schema
changes and repeating the second-gate defect. Considered qualifying once at engine
construction: selected for raw-value removal, with actual VM/template consumers
for loud refusal. Considered rejecting all expressions when any input/context is tainted:
rejected because unrelated clean expressions must work. Static literal scanning
alone cannot close computed/whole-context access. Full dynamic output taint and
fabricated empty tool metadata add unsupported claims without repairing the sink.
Considered keeping direct-input markers: rejected because they reproduce silent
false branching. Considered a host-function latch: rejected to preserve ADR-0027’s
zero-host-function boundary. Considered static literals plus throwing accessors:
insufficient for computed/caught reads. Considered no latch: simpler privacy, but
loses ordinary caught-read diagnosis. The private latch is chosen for that bounded
semantic benefit; revisit if its implementation cost exceeds the demonstrated
benefit, without weakening raw-value exclusion.

### Acceptance and landing

1. Actual WorkflowEngine + createStandardNodeExecutor + QuickJS controls cover
   direct/computed/serialized/transitive/nested/custom merge, caught access,
   condition oracle, returned ctx/getters/toJSON, final-envelope prototype poisoning,
   const reassignment and intrinsic/latch tampering.
   For executed accessors assert typed denial and no branch/output-schema success;
   separately pin caught pre-accessor resource failure without claiming a denial.
   Verify no raw newly projected value in VM input/error detail. Pin single
   result serialization, stateful toJSON, exact current primitive/result parity and
   context/input key order/presence. Independently successful clean workflows must
   complete with exact expected outputs; no vacuous negative-only test.
2. Actual SQLite hosts scan `run_events.payload_json`,
   `step_executions.output_json` and `runs.output_json`, plus public events and
   downstream human gate messages. Clean positive rows prove persistence occurred;
   leak fixtures prove the baseline fails the confidentiality assertion.
3. Every fresh/resume/preparation producer supplies the owned projection.
   Missing metadata and mutation controls (including attempted live-Set clear)
   exercise actual VM and public-template consumers. Removing engine qualification, template refusal or VM latch breaks
   its corresponding regression with exact restoration.
4. Direct/transitive parser model/human refusal, trusted raw resolver, display/
   input-node markers and external tool guard remain preservation controls. New
   direct-input VM/template refusals include hand-constructed workflows with
   successful clean positives. No nonexistent mapping producer is certified.
5. Dedicated secret-flow security sitting, required gates and two new independent
   complete cumulative clean rounds precede implementation acceptance. At ADR
   acceptance append ADR-0027/0029/0037/0083/0093 forward notes before dependent
   code. Reconcile expression-input marker compatibility and ADR-0093 rationale.
   Land canonical workflow, runner, expression, both tool passages, stale scope/
   error comments and at-rest/recovery notices; register actual #92 tool-mapping
   limitation separately from repaired exposure and finite latch semantics.

## Consequences

### Positive

- Raw derived context no longer reaches executor/preparation or expression scopes.
- Executed denied reads fail explicitly, including ordinary computed/caught reads;
  privacy does not depend on a universal attempted-access detector.

### Negative

- Expressions previously reading leaked context now fail deliberately. This is
  an explicit compatibility change, including direct secret-input expression reads.
  Clean behaviour and display masking stay pinned; resource-before-accessor
  detection and legacy persisted data are explicitly outside the new guarantee.
- Low-level embeddings migrate to a required owned projection and template/VM
  consumers. A trusted host's fabricated provenance remains outside the guarantee.
