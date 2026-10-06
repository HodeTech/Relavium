# ADR-0102: A measured request owns its inert data through egress

- **Status**: Proposed — maintainer approval required before dependent implementation
- **Date**: 2026-10-04
- **Related**: [ADR-0011](0011-internal-llm-abstraction.md) · [ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md) · [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) · [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) · [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) · [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) · [ADR-0099](0099-compaction-has-an-idle-budget-outcome-and-an-unknown-window-policy.md) · [ADR-0100](0100-budget-authorization-is-durable-state-with-a-replay-barrier.md) · [ADR-0101](0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md) · [architectural principles](../standards/architectural-principles.md)
- **Scope**: W7's post-PR measured-request ownership correction for `LlmRequest` generate/stream, including inline media and request-media resolution. Refines the construction handoff in ADR-0096/0101 and explicitly narrows opaque non-cap seam inputs. Separate-endpoint `MediaGenRequest`/`generateMedia` and `pollMediaJob` are outside this ownership guarantee; their ADR-0031/0045 contracts remain unchanged. Leaves output-cap precedence, input pricing, allowance authority, compaction outcomes, media charges and durable payload schemas unchanged.

## Context

PR 90's systematic review demonstrates that a shallow cap snapshot leaves message arrays and nested
tool schemas mutable. The [independent intake probe](../reviews/2026-10-04T10-35-00-w7-systematic-review-intake-review.md)
measures 37 tokens at admission while the actual installed OpenAI SDK sends a later-mutated
construction measuring 50,035. Independent owned-tree controls also reproduce
mutation through response schemas, tool arguments/results and provider options. This breaks the
existing requirement to measure the construction actually sent.

The turn core independently calls `buildRequest` for dispatch and again after an awaited money join
inside `preAttempt`. The first prepared request used for context measurement/allowance quotation is
not itself the first request dispatched. Copying only within an adapter leaves both gaps open.
The relevant homes are the [LLM seam](../reference/shared-core/llm-provider-seam.md),
[agent-runner contract](../reference/shared-core/agent-runner.md) and
[request estimator](../../packages/llm/src/request-estimator.ts).

Some opaque inputs are executable rather than data. A custom `toJSON` can depend on mutable captured
state and on the provider's eventual property key. Gemini's installed SDK can asynchronously preprocess
native callable tools, mutate schemas and discard unknown options before serializing. It exposes no
public pure preparation API for this complete operation. A generic JSON stringify/parse before admission
would change serializer keys and reject values the current SDK discards. A second SDK field/filter list
would create another lowering authority. SDK versions remain recorded in [tech-stack.md](../tech-stack.md).

## Decision

**We own one inert canonical request construction before its first asynchronous handoff, measure that
owned construction and derive actual transmission only from it. Native output-cap handling keeps its
existing, separately governed serialization exception.**

Considered shallow copying and freezing caller objects: they leave aliases or mutate caller state.
Considered full opaque compatibility through a new provider preparation interface and reviewed SDK
patches exposing their actual converter/prepared send: this requires additional transport authority,
SDK maintenance and policy for native asynchronous callbacks. We choose inert non-cap ownership
because it would close the demonstrated gap with pure TypeScript and the existing lowering authorities.
No SDK patch, provider preparation method or runtime dependency is introduced. This choice deliberately
narrows previously accepted or ignored JavaScript objects; it is a new compatibility decision.

### Supported data and explicit compatibility changes

- Request data accepts primitive strings, booleans, numbers, null and undefined; dense ordinary arrays;
  and ordinary records with `Object.prototype` or null prototype containing own enumerable string-keyed
  data properties. Numbers retain their values, including non-finite values; the existing lowerer/SDK
  still decides their native JSON encoding or validation. Present undefined is preserved, including
  undefined tool arguments/results and array members. Optional typed fields keep their existing
  absence semantics. Capture does not normalize a result into a JSON string or insert a field.
- Reject functions, symbols and BigInt outside the cap exception; cycles; custom-class, Date or boxed
  instances; accessors; callable own/inherited `toJSON`; sparse arrays; array properties other than
  dense indices/ordinary length; and additional non-enumerable or symbol-keyed record properties.
  A noncallable enumerable data field named `toJSON` remains ordinary data. Inspect descriptors without
  invoking getters. Guard inspection/proxy failures with a fixed typed refusal. This is an ownership
  guarantee after inspection, not a JavaScript sandbox or a guarantee that reflection traps terminate.
- Ordinary Map/Set values with standard prototypes and inert own enumerable properties become records
  of those properties, preserving their existing native JSON representation. Internal entries are
  ignored, including cycles confined to those entries. Subclasses, serializer hooks, accessors and
  other unsupported properties are refused. Preserve repeated acyclic container aliases across the
  whole supported request-data graph, including aliases across canonical payload and non-cap options.
  Use an iterative, memoized traversal: distinguish active ancestor cycles from completed shared
  nodes. Do not recursively expand each occurrence or add an unapproved depth/size limit. Traversal
  and capture storage scale with distinct supported containers and their properties; this does not
  bound the existing SDK's eventual JSON expansion of a recognized shared graph. Cap serialization
  remains separately governed and must not be collapsed into this memoization rule.
- Capture owns and freezes Relavium containers without freezing any caller object. Preserve literal
  `__proto__` as a data key. Owned records have null prototypes; graph-preserving mutable working
  copies of those records also have null prototypes, without restoring caller or `Object.prototype`
  inheritance. Arrays in both graphs keep only trusted intrinsic array
  behaviour and shadow inherited `toJSON` with an own non-enumerable undefined data property before
  freezing; distinguish this helper-generated property from caller-supplied unsupported metadata.
  Later request preparation must not invoke a caller serializer through a retained prototype.
  Frozen inert caller containers are accepted as data; SDK mutation operates on private mutable
  copies. This can make a construction work where the SDK previously tried to mutate a frozen caller
  schema and failed; the guarantee is retained data/wire semantics, not preservation of that failure.
- The common boundary intentionally refuses unsupported non-cap inputs even if a selected provider
  previously ignored them: examples include a cyclic DeepSeek schema, an unknown cyclic Gemini option,
  a Date, custom serializer or native callable tool in provider options. Convert such inputs to inert
  data before calling the seam; use Relavium's existing host tools for executable tool behaviour.
  Unsupported data refuses before admission/key resolution, so refusal may precede a capability skip.
  Standalone `estimateRequestTokens` retains its serialized-length floor and conservative fallback;
  it does not acquire this new admission policy.

### One ownership helper, existing cap authority

- A pure helper in `@relavium/llm` owns the request once. Except for live `signal` and genuine
  `preparedOutputCaps`, every `LlmRequest` field is owned and traversed: `model`, `system`, `messages`,
  `tools`, `toolChoice`, `responseFormat`, `outputModalities`, `temperature`, `maxTokens`,
  `reasoningEffort`, `stopSequences` and non-cap `providerOptions`. This rule covers future request
  fields too; it is not an allowlist that silently drops a new field. Native cap controls inside
  `providerOptions` are descriptor-separated and captured by the existing cap authority below,
  rather than generic data traversal. The canonical seam
  documents the helper and supported-data contract when implementation lands. `LLMProvider` keeps
  its existing generate/stream signatures; `PreAttemptInfo`/`PreAttemptHook` remain cap-only.
- [output-cap.ts](../../packages/llm/src/output-cap.ts) remains the one authority for identifying,
  capturing and discarding native cap controls, including its existing outer-option serializer
  discard. It must descriptor-separate cap controls from non-cap data before generic option spreads
  or traversal can invoke an unsupported non-cap getter. Existing cap inspection/serializer rules,
  including the outer-option discard, remain the delegated authority rather than a second field list.
  The ownership helper delegates that work before traversing non-cap options. Surviving
  object/function/BigInt cap serializers keep their real property keys and captured native values;
  discarded opaque controls are not generically traversed. No new limit or catalog clamp is inserted.
- Before the first await, validate any incoming genuine prepared plan against the original request's
  canonical/native controls, own-presence and actual model/provider/endpoint identity, or validate an
  existing factory-owned association against its accepted captured view. Do this before replacing
  controls with a plan's projection. Reuse that exact matching measured plan, captured serializer
  values and ceiling without rerunning serializers or refreshing catalog authority; prepare a new
  eligible candidate plan only where none exists. Associate each validated plan with the same owned
  canonical payload and its captured projection using a Relavium factory-owned association. Select
  that projection and retain the existing post-selection binding check. A primary projection cannot
  be authority for another dialect; a genuine but mismatched plan, forged metadata or borrowed
  association cannot manufacture a match. Original cap identities remain private binding evidence
  and never reach a vendor payload or durable quote.
- A candidate-local cap capture failure is retained as a content-free outcome and surfaced only if
  that candidate is applicable under the existing attempt policy; an unused/skipped candidate does
  not abort a valid primary. Existing quote applicability, representability and exclusion rules
  remain fail-closed: a cap-capture failure on an otherwise quote-relevant candidate is not a new
  exclusion reason, and cooldown state does not silently shrink the frozen allowance construction.
  Eager candidate cap capture can run a stateful cap serializer earlier or in a different order than
  today's deferred fallback. This timing change is explicit: accepted cap serializers must tolerate
  construction-time capture; their captured results cannot change across admission/key waits.
  Do not claim preservation of their side-effect count/order.

### Round, stream and media handoffs

- The turn core owns a round once and closes `preAttempt` over that exact pre-reasoning-strip request.
  Money joins, budget checks, inline generate and text stream use it; `preAttempt` does not reconstruct
  a request after an await. The first context-measured/quoted owned request is reused for execution
  with only the live execution signal overlaid. A later real tool result creates a new owned round
  with a new estimate. Node retries and allowance debit/release keep their existing authority.
  Main-turn and summariser measurement hand the same owned construction to their applicable candidate
  attempts, preserving ADR-0096/0099's different measured-window and failed-compaction rules.
- A direct chain call captures at invocation. Since an async generator otherwise starts on first
  consumption, `stream` becomes a synchronous capture wrapper returning a private async generator.
  Capture failure still produces the existing normalized terminal error through that iterator;
  callers do not receive a new unexpected synchronous exception. Direct adapter generate/stream
  entry points apply the same ownership boundary; a genuine matching owned construction can be
  reused without recapturing executable cap controls.
- Immediately after a media resolver returns, copy its discriminant/scalar source fields before
  cache insertion or another await. A candidate's materialized copy changes only the typed media
  slots. Ordinary payload/options/schema data already belong to the round. Keep existing unsupported
  source refusals, media accounting and provider/handle cache scope; do not newly send tool-result
  media that existing lowering ignores. Cancellation remains a live host signal.
- Adapters and SDKs retain their actual lowering/filtering authorities. Where an SDK mutates working
  schemas/envelopes, create each fresh mutable working envelope as one graph-preserving copy backed
  solely by owned inert data, with one memo across all fields. Per-field or per-occurrence cloning
  must not break aliases which that same SDK converter observes. Working copies for separate attempts
  are isolated from each other, the owned graph and the caller. Do not
  pass a frozen vendor envelope or reread the caller during learned-parameter retry. Foreign provider
  implementations invoked through Relavium receive the same owned canonical data; they must treat it
  as read-only and create their own working copies. Independently implemented providers called
  outside Relavium's controlled entry points are outside this ownership guarantee.
- Local unsupported-data inspection uses `UnsupportedRequestDataError`, a fixed, content-free typed
  error distinct from `InvalidOutputCapPlanError`, normalized to fatal `bad_request` at the chain and
  `validation` in core. Its name and normalization are part of the canonical seam acceptance tests.
  Caller messages, property names, causes and private paths are not exposed. No new shared ErrorCode,
  durable request body, budget-quote payload or provider-native type crosses the seam.

### Acceptance and landing

Before closing the HIGH, actual installed SDK HTTP captures in an offline owned harness must prove:

1. Both generate and stream preserve measured text, tool/schema/response-schema data, arguments,
   results and non-cap options when the original is mutated during money join, preAttempt, key
   resolution and media resolution; mutation between `stream()` and first `next()` is also covered.
   The mutation matrix covers every data field listed above, including `toolChoice`,
   `stopSequences`, `outputModalities`, `temperature` and `reasoningEffort`; missing ownership of one
   field must break its corresponding control. Live signal and genuine prepared-plan behavior are
   tested separately rather than traversed as data.
2. First context measurement/allowance quotation and execution share the same payload; heterogeneous
   fallback cap plans bind correctly through primary retries/failover; unused candidate-local failure
   does not stop a valid primary. Matching incoming raw/captured plans retain serializer-once and
   measured-ceiling authority after catalog refresh. Stale plans, changed native/canonical controls,
   own-presence, routes and borrowed/forged associations refuse before projection can mask a mismatch.
   Native caps above catalog ceilings retain reservation and wire parity.
3. Caller objects stay mutable; later tool rounds receive fresh estimates; resolver-owned media can
   mutate after resolution without changing the request; live abort signals still cancel dispatch.
4. Retained primitives, undefined results, ordinary Map/Set and inert schemas/options preserve the
   existing provider/SDK wire bodies. Every newly refused input has a fixed typed error and zero
   admission/key/egress. Existing discarded opaque cap controls and surviving key-sensitive cap
   serializers preserve their independently tested semantics and causal negative controls.
   Actual installed OpenAI (including the DeepSeek-compatible route), Anthropic and Gemini SDK
   generate and stream HTTP paths must accept null-prototype records throughout supported messages,
   tool definitions/arguments/results, response formats and non-cap options, including mutable
   working copies, with baseline-equivalent wire bodies. Test array serializer shadowing and literal
   `__proto__` too. Small cap-JSON tests do not establish this full-payload obligation. Containers
   created by the existing adapter/SDK lowerers remain those lowerers' authority; no caller prototype
   may return through a working copy. If an installed path needs different prototype handling,
   revise this decision before claiming acceptance rather than silently restoring inheritance.
5. Both installed-SDK Gemini paths preserve the existing converter body when one inert declaration
   is shared between native `tools[].functionDeclarations[]` and `responseJsonSchema`. Capture and
   mutable working copies preserve that alias while SDK mutation leaves the caller/owned graph and
   other attempt copies unchanged. Deep acyclic and shared ignored graphs capture without recursive
   stack failure or duplicate-container amplification; real ancestor cycles still refuse. Frozen
   inert schemas and repeated Map/Set aliases have explicit controls. Removing either capture or
   working-copy memoization must break its corresponding control.
6. Removing ownership, owned-round reuse, call-time stream capture or media-source copying independently
   breaks the corresponding regression. Fresh strict types, vendor-seam/engine-purity checks, full CI
   and coverage pass after exact restoration; no live provider call is needed for this correction.

Land the supported-input and ownership contract once in the
[LLM seam](../reference/shared-core/llm-provider-seam.md), with links from the
[agent runner](../reference/shared-core/agent-runner.md) and
[agent-session contract](../reference/contracts/agent-session-spec.md).
Add dated ADR-0011/0031 compatibility and ADR-0096/0101 handoff notes without rewriting historical
bodies. These forward references land with the approved implementation, not as an assertion that
this Proposed decision is already in force. Update the
W7 correction register/review records and PR description. Proposed status authorizes drafting and
review only; no dependent ownership implementation is authorized before maintainer approval.

## Consequences

### Positive

- Admission, context measurement and transmission refer to the same owned round rather than mutable
  aliases or independently reconstructed requests.
- Existing cap/lowering authorities, vendor boundary, live cancellation and durable privacy remain
  intact without another provider interface or runtime dependency.
- Deterministic local data refusals are safe and actionable; real SDK controls demonstrate wire parity
  for the retained domain and reproduce each removed protection.

### Negative

- Opaque executable and some previously ignored non-cap inputs become unsupported. Document the exact
  boundary and migration to inert data; require maintainer approval before implementing this change.
- Copying data and candidate projections costs memory/CPU. Reuse genuine owned rounds across handoffs,
  keep candidate payload data shared, and measure representative large requests without relaxing
  ownership or adding limits not already authorized.
- Cap serializer timing changes and SDK working-copy requirements are subtle. Keep cap capture in its
  existing authority and pin multi-dialect, unused-fallback, SDK mutation and cancellation regressions.
- Arbitrary hostile host code can still modify global built-ins or execute proxy traps. This seam
  owns data within the existing trusted host process; it does not add a JavaScript security sandbox.
