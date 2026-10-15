# ADR-0113: Secret-derived context keeps provenance at public sinks

- **Status**: Proposed
- **Date**: 2026-10-15
- **Related**: [ADR-0027](0027-expression-sandbox.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0038](0038-agentrunner-llm-call-boundary.md), [ADR-0050](0050-cli-history-db-at-rest-posture.md), [ADR-0083](0083-input-admission-and-a-resume-that-verifies-its-own-identity.md), [ADR-0093](0093-an-expression-sees-only-what-it-is-ordered-after.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

Wave 3 #92 observes that `ToolDispatchContext.secretArgKeys` has no live producer.
The existing parser already computes transitive declared-source taint, but bare
JavaScript expression scopes are a separate consumer from interpolation templates.
At baseline `702cdc9c`, a synthetic workflow with a secret input, a derived context
entry and a `transform: ctx.derived` is accepted and exposes its canary in two
`node:completed` events and `run:completed`. `run:started` correctly masks the input.
The parent independently reran this source/QuickJS/in-memory-host probe. No real
credential, provider or network was used.

`resolveContext` is a public trusted resolver and intentionally retains declared
secret-input values for governed credential use. The canonical workflow contract
allows this intermediate propagation while forbidding public model/human text.
Masking all inputs before resolution would close the probe by changing that
contract. Conversely, adding an empty `secretArgKeys` set would leave the leak and
falsely claim a producer. Neither is an adequate repair.

This proposal refines enforcement of existing ADR-0027/0029 secrecy, not universal
redaction of conversational content. Approval is required before changing the
execution/preparation context or provenance interfaces. No new runtime dependency,
platform import, persisted secret, model request field or general mapping feature
is authorized.

## Decision

We will carry trusted declared-source provenance to every consuming boundary,
preserve raw values only inside their existing trusted resolution domain, and keep
secret-derived context out of expression/model/human public sinks.

Reuse the existing linear `computeTaint` dependency graph for declared secret input
names and transitive `ctx` references. Expose its provenance result through one
pure internal authority, shared by parser checks and execution/preparation. Do not
add a second scanner, scan raw secret values, or guess secrecy from argument names.
Metadata contains source/key relationships only, never credential bytes, and is
owned against mutation by the consumer's execution context.

For every `condition`, `transform` and `merge_fn`, build the sandbox context with
the existing secret marker for each tainted key, just as declared secret inputs
are masked today. No raw derived string enters QuickJS, including computed access
such as `ctx[name]`, enumeration or JSON serialization of the context. Public
outputs may carry the inert marker but never the raw value. This preserves the
trusted resolver's raw return contract and clean-context expressions. Static
model/human text checks use the same transitive provenance; preparation, resume,
branching and merge paths must not reconstruct an unqualified context.

The engine supplies provenance on all actual producer paths, computed from the
same admitted workflow used for trusted context resolution. Add a required frozen
list of secret-derived context names to both execution and preparation contexts;
empty is an explicit clean result, never the default for absent metadata. Migrate
all repository context producers and doubles together. A direct low-level caller
missing this field refuses before sandbox entry; a JavaScript caller that lies
about its inputs/provenance violates the trusted-host contract, just as lying about
existing `secretInputNames` does today. Do not claim to detect that lie by inspecting
credential bytes. Define the public embedding migration in
[agent-runner.md](../reference/shared-core/agent-runner.md) and
[expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md).
The required field is an explicitly approved low-level API change; existing
no-secret doubles migrate by supplying an owned empty list.

Keep `ToolDispatchContext.secretArgKeys` as the explicit external provenance guard.
There is no live tool-input-mapping producer: current agent/session producers pass
empty config, and JSON chosen by a model cannot retain declared-input provenance.
Record this limitation honestly, as #92's permitted ADR disposition; do not
implement an unrelated mapping feature or invent a nonempty producer from string
matching to close a checkbox. A future mapping producer must derive tainted final
top-level argument names **after** model/mapping/config precedence, with nested
taint marking its parent, before dispatch or approval persistence. It may not
launder a marker by serializing it to a normal string. Ordinary tool text never
receives raw marked values; credential references retain their separate host-only
resolution path. Existing external nonempty-set refusal controls must remain causal.

This is not a claim that user/model free text, attachments or tool results are
universally free of sensitive content, or that the CLI database is encrypted.
ADR-0050/0095 retain their exact at-rest and structural scopes. No secret-value
search, request capture or provider-key plumbing is added to core.

Considered masking every input before trusted context resolution: rejected because
it changes legitimate trusted resolution rather than qualifying the sink.
Considered static literal-expression analysis alone: rejected because computed key
access and whole-context serialization bypass it. Considered blanket name/value
heuristics or a fabricated empty metadata producer: rejected because neither proves
provenance. Considered full dynamic output taint propagation: unnecessary for this
repair when raw secret values never enter the sandbox; future sources require their
own explicit boundary, not an unverified general claim.

### Acceptance and landing

1. Permanent actual-engine/QuickJS tests reproduce the baseline canary and prove
   absence from every event/output, raw sandbox input and surfaced error after the
   fix. Cover direct/transitive/reordered context graphs and computed/enumerated
   access in condition/transform/custom merge. Clean inputs/context are positive controls.
2. Fresh/resumed/prepared executions carry owned provenance without a parallel
   mutable authority. Missing low-level metadata refuses before sandbox entry;
   mutation of a source list cannot alter the engine-owned list. Clean and tainted
   lists derive from actual admitted workflows; hostile trusted-host forgery is
   explicitly outside this boundary, not falsely certified by a shape guard.
3. Actual parser-to-model/human tests preserve transitive refusal and the trusted
   resolver's raw intermediate contract. Credential references stay opaque and are
   resolved only by the already-governed host; no new credential sink is introduced.
4. Real external tool-dispatch tests prove nonempty top-level taint refusal before
   host effects/approval persistence and preserve clean-call behaviour. Nested-parent
   projection remains the documented obligation of a future mapping producer;
   do not claim that a nonexistent producer was exercised. No test labels arbitrary
   model JSON as declared-input provenance.
5. Removing context masking, source propagation or tool refusal breaks its specific
   regression, with exact restoration. A dedicated secret-flow security sitting,
   required gates and two new independent cumulative clean reviews precede acceptance.
   Update the canonical workflow/expression/tool contracts and append dated forward
   notes to ADR-0027/0029/0037/0083/0093; register the #92 limitation and actual repaired
   leak separately, never as universal secret redaction or a completed mapping feature.

## Consequences

### Positive

- An existing accepted no-secret-sandbox guarantee covers context aliases as well
  as direct inputs, including dynamically selected keys.
- Provenance is shared with the existing parser graph and has no credential bytes.

### Negative

- Expressions that previously observed leaked secret context now observe a marker.
  This deliberate security correction needs clear compatibility tests and a dated note.
- Low-level executor embeddings must honor provenance ownership. The canonical
  interface and fail-closed migration rule must be settled before implementation.
