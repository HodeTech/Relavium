# ADR-0101: Configured output estimates apply only when the wire is uncapped

- **Status**: Accepted — maintainer approved 2026-10-02; implementation staged in `W7`
- **Date**: 2026-10-02
- **Related**: [ADR-0028](0028-workflow-resource-governance.md) · [ADR-0071](0071-models-dev-as-the-model-metadata-source.md) · [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) · [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) · [ADR-0099](0099-compaction-has-an-idle-budget-outcome-and-an-unknown-window-policy.md) · [ADR-0100](0100-budget-authorization-is-durable-state-with-a-replay-barrier.md) · [architectural principles](../standards/architectural-principles.md)
- **Scope**: W7 step 6 output-reservation/configuration precedence and the cap-identity/resolved-token pricing seams needed to implement it. Narrows ADR-0028's configured-default promise, explicitly qualifies ADR-0096's September 18 unauthored-output acceptance and hook premise, and refines the shared reservation mechanism consumed by ADR-0099 and ADR-0097/ADR-0100. Does not change generation limits, ADR-0096's input-rate policy, compaction outcomes, allowance ownership or runtime dependencies.

## Context

ADR-0096's September 18 note explicitly chooses a shared 4,096-token reservation when an adapter
sends no cap; ADR-0028's note and the CR-98 register repeat it. That is an estimate for an uncapped
request, not authorisation to insert a generation limit. It qualifies the older literal equality
between reservation and wire cap for this case.

ADR-0028 also promises `[defaults].max_tokens_estimate` whenever the node omits `maxTokens`.
The current governor substitutes that configured number even when the adapter supplies a cap of
its own: an existing test sets the estimate to 1 for Anthropic while its adapter sends 4,096.
The same ambiguity applies to a surviving native `providerOptions` cap. ADR-0071 §10a deliberately
preserves that escape hatch when no canonical cap is authored; inserting a new common cap would
change its accepted precedence.

The related decisions and approved W7 plan do not say whether a nondefault configured estimate is
replaced, floored or preserved under the new shared resolver. Silently preserving the current
substitution under-reserves a known cap; silently ignoring every configured value makes an authored
setting ineffective; putting it on the wire turns an estimate into a generation control.

The maintainer's review of 2026-10-02 also verified two mechanical gaps in the first proposal.
`PreEgressHook` and the governor currently receive only model/canonical-cap fields, not native
`providerOptions`; a resolver cannot inspect information they discard. `estimateMaxNextCost` clamps
every output number again, so sending a resolved native cap through it still under-prices that cap.
Sharing only a reservation number would leave cap policy duplicated in adapter lowering and would
lose the raw inputs needed to quote heterogeneous fallback entries.

Source evidence lives in [the governor](../../packages/core/src/engine/budget-governor.ts),
[its configured-default test](../../packages/core/src/engine/budget-governor.test.ts),
[Anthropic lowering](../../packages/llm/src/adapters/anthropic.ts),
[OpenAI lowering](../../packages/llm/src/adapters/openai.ts),
[Gemini lowering](../../packages/llm/src/adapters/gemini.ts), and
[the existing output-cap helper](../../packages/llm/src/output-cap.ts). The transport and pricing gaps
are visible in [the chain hook](../../packages/llm/src/fallback-chain.ts),
[the turn hook](../../packages/core/src/engine/agent-turn.ts) and
[the budget estimator](../../packages/llm/src/budget-estimator.ts).

## Decision

**We resolve the effective wire cap first; use the configured estimate only when the
request remains uncapped. Preserve the existing wire behaviour.**

- The resolver **extends ADR-0096's September 18 one seam-level helper**, rather than introducing
  another output-reservation policy. One vendor-free cap plan supplies adapter lowering and the
  reservation used by context measurement, governor pricing and frozen allowance calculation.
  Its inputs include the raw canonical cap, native `providerOptions`, actual routing provider and
  endpoint; the reservation wrapper also receives the same frozen configured fallback.
- If the request carries an effective output cap, reserve that cap. Follow the adapter's existing
  lowering precedence, including its required native default and any valid surviving native
  `providerOptions` cap. Canonical-versus-native collision rules remain ADR-0071's; a native value
  the adapter does not clamp must not be silently catalog-clamped by the reservation resolver.
- Recognise native output-cap controls for the actual routing dialect: official OpenAI and custom
  OpenAI-compatible endpoints recognise `max_tokens` and `max_completion_tokens`; official DeepSeek
  recognises `max_tokens` only; Gemini recognises `maxOutputTokens`. Anthropic's mandatory mapped
  `max_tokens` overwrites its native option. A forwarded value establishes cap evidence only when
  its key is recognised and its value is finite, positive and integral. If multiple recognised
  native values survive without local precedence, reserve their greatest value as a conservative
  envelope; preserve all wire fields and claim no server precedence. Unsupported keys or invalid
  values do not establish cap evidence; with no candidate use the uncapped fallback below.
  The existing OpenAI collision rationale records that official OpenAI rejects both cap keys
  together; this envelope is an accounting precaution, not a claim that the request is valid or
  that upstream selects one of them.
- If the request remains uncapped, reserve `max_tokens_estimate` when explicitly configured,
  otherwise 4,096. Apply ADR-0096's catalog output-ceiling clamp to this fallback for an official
  endpoint; a custom endpoint or unknown model retains the fallback without a guessed ceiling.
  Neither branch inserts a wire cap.
- A configured estimate no longer substitutes for a known cap, including Anthropic's unauthored
  native default. The setting retains its estimate-only meaning for uncapped requests. Existing
  configuration parses without a migration; the canonical config documentation must disclose the
  narrower applicability. An author who wants a smaller generation limit authors `max_tokens`.
- A separately routed generative-media gate continues to reserve zero text input/output tokens;
  its existing disjoint media-unit estimate remains the authority for that route.

### One cap plan and explicit seam propagation

- **Policy ownership.** Extend [output-cap.ts](../../packages/llm/src/output-cap.ts) so its pure cap
  plan owns mapped field selection, canonical/default clamping, competing native-key reconciliation
  and surviving cap evidence. The reservation wrapper adds the configured/default estimate only
  when that plan has no valid cap evidence. All three adapters consume the same plan for their
  mapped cap and native-key handling; they do not keep an independent copy of those decisions.
- **Wire versus reservation.** Keep the adapter-mapped field/value distinct from native cap evidence
  and the final reservation. Adapter body construction and existing thinking controls consume only
  their existing mapped-cap input. In particular, Gemini's thinking budget must not receive a native
  envelope or uncapped estimate in place of its canonical mapped cap/catalog fallback. No reservation
  branch inserts a wire cap or changes a thinking control.
- **Routing authority.** The plan's endpoint classification comes from the same actual provider
  instance/factory classification used by wire lowering, not from the model's catalog provider or
  an independent governor map. The OpenAI-compatible factory exposes its existing classification
  through `customEndpoint`, including directly constructed custom adapters without a CLI wrapper.
  Hosts preserve that classification; explicitly spelling an official host remains official.
- **Attempt snapshot.** After the chain has staged the entry-specific request, copy its cap inputs
  into an immutable Relavium-owned projection and use that same copy in the request sent to the
  adapter. Resolve the catalog ceiling once into the attempt's prepared cap plan, which both
  admission and wire lowering consume; do not independently refresh it after an admission or
  credential await. A prepared plan is bound to those cap inputs and routing identity; mismatches
  refuse before egress. Direct unprepared seam calls construct their plan once at adapter entry.
  This bounds the cap snapshot of that constructed request, without redesigning catalog refresh
  or freezing later independently constructed requests.
- **Measurement handoff.** Context construction hands its prepared cap plan forward to the matching
  attempt: the first attemptable main-turn entry under ADR-0096 and every summariser candidate whose
  bound ADR-0099 requires. `LlmRequest` gains optional Relavium-owned prepared-cap metadata, which
  the chain supplies to adapter lowering and never forwards as a vendor option. The required hook
  estimate-info carries that plan with its cap projection. A deliberate rebind to another eligible
  entry creates that entry's own plan; it cannot reuse a different dialect's plan. If a plan is
  replaced before dispatch, repeat every dependent measurement under the existing entry-point
  rules before egress; no summariser request may use a stale positive fit or exceed its required
  measured bound. A failed summariser recheck installs no partial summary; callers retain
  ADR-0096/ADR-0099's skip, failure and permitted trim outcomes. Main-turn measurement still uses
  the first attemptable entry and retains its existing oversized-floor/failed-compaction policy.
  This closes the construction-to-attempt gap without adding a mid-turn compaction policy.
- **Required transport.** Extend `PreAttemptHook` on both `generate` and `stream` with the required
  cap projection (`model`, `maxTokens`, `providerOptions`) and actual provider/endpoint identity.
  The projection's keys are required even when a value is `undefined`, so discarding native options
  cannot satisfy the new signature. `PreEgressHook` forwards it with ADR-0096's required
  `inputTokensEstimate`; `BudgetGovernor.evaluatePreEgress`, `checkPreEgress` and their estimator
  take one required estimate-info object instead of reconstructing cap inputs from positional
  model/max-token arguments. Workflow, session and money/durability wrappers forward that object.
  The separately routed generative-media branch is explicit in the type and carries literal zero
  text input/output, rather than manufacturing a text request. Exact types have their single homes
  in the [LLM seam](../reference/shared-core/llm-provider-seam.md) and
  [agent-runner contract](../reference/shared-core/agent-runner.md) when implementation lands.
- **Input ownership and configuration.** This cap-only hook extension explicitly qualifies the
  September 18 premise in ADR-0096 and ADR-0028 that `PreAttemptHook` receives no per-entry request.
  It exposes no message body and does not move input estimation: the turn core still computes it
  from the current round before reasoning stripping. Hosts thread the same frozen configured
  fallback to session context measurement, governor construction and allowance computation;
  context measurement receives it even when no financial governor is installed. This does not add
  a `providerOptions` YAML/session-authoring feature: native-cap tests use the existing direct
  `LlmRequest`/`FallbackChain` escape hatch. Raw options/projections are ephemeral, never written to
  a budget event or durable quote.
- **Resolved-token pricing.** Add a separate rate-only pricing entry in
  [budget-estimator.ts](../../packages/llm/src/budget-estimator.ts), accepting the resolved output
  reservation and ADR-0096 input estimate with the actual model/pricing overlay. It uses the existing
  highest-tier non-cached input/output rates and performs no cap lookup or clamp. Governor admission
  and allowance sizing use this entry. `estimateMaxNextCost` may remain an explicit compatibility
  wrapper for canonical authored-cap callers; it is not the resolved-native pricing path. Passing
  a false `custom` endpoint to bypass its clamp is forbidden: actual routing identity stays intact.
- **Allowance and summariser consumers.** For ADR-0097's `E`, project the paused attempt's raw
  canonical/native cap inputs separately onto each eligible candidate model/provider/endpoint,
  including cooldown entries; never reuse one resolved cap across different dialects. The frozen
  amount and existing provenance remain durable under ADR-0100's authoritative protocol; this
  changes neither ownership nor authorization ordering. ADR-0099 summariser passes use the same
  helper with their authored 4,096-token cap, which a configured estimate cannot replace; every
  attemptable fallback is measured under ADR-0099's existing rule and compaction outcomes stay intact.

Considered fixing every uncapped reservation at 4,096 and retiring nondefault overrides. That is
closer to a literal reading of September's acceptance case, but would remove existing estimate
tuning and require a visible compatibility/migration policy. Considered introducing a shared
wire default or sending the configured estimate as a cap. That provides a stronger output bound
but changes generation length and native/custom-provider behaviour, beyond this narrow gap.
The chosen approach retains those behaviours while removing substitution for a known cap.

### Acceptance and landing obligations

- An uncapped official request with no configuration reserves 4,096 clamped to its catalog ceiling.
  A nondefault configured value is used only for that uncapped branch; an unknown/custom endpoint
  does not inherit a different service's ceiling. The custom-endpoint case preserves the existing
  no-clamp behaviour, rather than introducing a new output policy.
- An unauthored Anthropic request reserves its actual required default cap even with a configured
  estimate of 1 or a larger value. Authored canonical caps still win and follow existing clamping.
- A valid native cap surviving `providerOptions` keeps the same wire value and reservation; a
  colliding canonical cap keeps existing precedence. Cover every lowering dialect and both paths.
- Pin each recognised native key, reversed dual-key sizes and their maximum envelope, invalid-only
  options and official DeepSeek's modern-key-only uncapped fallback. A forwarded but unrecognised
  field must not become proof of a limit. Native caps/envelopes above an official catalog ceiling
  remain unclamped through final governor pricing and allowance sizing, not only in the resolver.
- Pin authored-above-ceiling and custom-endpoint/catalog-id-reuse cases. Removing endpoint identity
  or configured-fallback forwarding must break the corresponding test. A directly constructed
  custom adapter must pass without relying on CLI-added metadata; an explicitly spelled official
  host must retain its official lowering.
- **Plan/wire parity matrix:** capture both adapter paths across all dialects, authored/native
  collisions, reversed dual-key envelopes, invalid-only options and uncapped requests. Existing
  thinking fields are unchanged. Bypassing the shared plan in any adapter must break the matrix.
- **Every forwarding boundary:** cover both chain hooks, the turn wrapper, workflow/session host
  hooks, money/durability wrappers and the object-based governor entry. Missing required cap keys or
  input estimate fails compilation; replacing them with `undefined`, dropping endpoint/configured
  fallback, or losing a native cap fails a focused test. No invented YAML option stands in for the
  real native escape hatch.
- **Mutation during admission:** changing the caller's original cap options while admission or
  key resolution waits cannot change the staged wire cap. Refreshing the catalog output ceiling
  during either await cannot make pricing and lowering use different plans; mismatch refuses.
- **Measurement-to-attempt refresh:** change a refreshed official model's output ceiling from
  1,024 to 4,096 after a 4,096-authored-cap request was measured but before attempt preparation.
  The matching measured plan is preserved, or dependent measurement is repeated under its existing
  entry-point rules before egress; an oversized summariser replacement sends nothing. Pin the
  first main-turn candidate and each summariser fallback under ADR-0099, including a materialisation
  await. Removing handoff/rechecking must fail; main-turn skip/failure policy remains unchanged.
- **Native above-ceiling money:** set a budget between the clamped and raw-native costs. The
  official request is refused at the higher resolved amount, and allowance sizing uses that amount.
  Reintroducing a clamp or routing through the legacy wrapper must fail this test.
- **Heterogeneous allowance:** rebind the same paused native inputs to OpenAI, DeepSeek and
  Anthropic candidates, including a cooldown entry. Pin the different native/default/fallback
  reservations and their maximum `E`; persisting raw options is forbidden.
- Context measurement, governor pricing and allowance sizing use the identical resolved quantity.
  Generative-media gates retain zero text reservation. No new automatic compaction or provider
  overflow classifier is implied by this resolver landing.
- Each summariser pass retains its authored-cap precedence even under a smaller/larger configured
  estimate. Known/mixed-window checks and idle-versus-active budget outcomes remain ADR-0099's.
- Requests without a cap remain without one. No fixture may verify a newly inserted limit and
  describe it as preservation of wire behaviour.

Targeted dated notes qualify the older bodies without rewriting them:

- **ADR-0028:** narrow the configured-default promise to genuinely uncapped requests and qualify
  its historical hook premise with the new required cap-only projection and resolved-token pricing.
- **ADR-0071:** record extraction of field selection, clamping and native reconciliation into the
  shared cap plan, preserving its wire/escape-hatch and thinking-control rules.
- **ADR-0096:** explicitly qualify September 18's unauthored-`max_tokens` acceptance: the shared
  4,096 fallback applies only when no effective cap/native envelope exists and no configured estimate
  is supplied, then follows official catalog clamping. Known caps/native defaults take precedence;
  configured uncapped estimates retain their narrower role. State that this expands its one helper,
  adds cap-only `PreAttemptHook` inputs and preserves turn-core pre-strip input estimation.
- **ADR-0097 and ADR-0100:** record candidate-specific reservation/pricing in `E`, keeping the frozen
  amount/provenance, authoritative ordering and dispatch ownership unchanged.
- **ADR-0099:** state that every summariser pass consumes the refined shared rules with its authored
  cap; no configured estimate replaces it, and its window/compaction-budget outcomes are unchanged.

Update the canonical [config contract](../reference/contracts/config-spec.md), LLM seam and
agent-runner contract, plus W7's step 6/8/9 checklist alongside their implementation.
The maintainer approved this complete revised decision on 2026-10-02 after two fresh independent
review rounds. The dated notes are landed; dependent implementation is authorised and staged in W7
steps 6, 8 and 9, with runtime acceptance still required.

## Consequences

### Positive

- A known wire cap is priced consistently instead of being replaced by an unrelated configured guess.
- Existing generation defaults, native-cap precedence and custom-provider semantics remain intact.
- Configured tuning remains useful for the uncapped case it can describe, with one canonical resolver.
- Native inputs reach the actual admission boundary, and resolved reservations are priced without
  another cap decision. Shared adapter consumption prevents a second lowering-policy copy.

### Negative

- Configured estimates previously lowering Anthropic's reservation can now cause an earlier budget
  refusal. Document the narrower scope and the authored-cap remedy before landing.
- An uncapped request still has a heuristic output reservation, not a billing bound. Preserve
  ADR-0097's disclosed overrun behaviour and make no claim that this change hard-caps generation.
- Required cap transport and prepared plans change public seam/hook signatures and require host/test
  migration. Land all forwarding sites together with canonical contracts and parity/mutation tests;
  no vendor SDK type or wire error string enters the engine.
- Cap plans have a bounded snapshot/validation cost. Keep them ephemeral, resolve each attempt's
  ceiling once and refuse mismatches; do not persist arbitrary native options or freeze the catalog.

## Implementation correction — 2026-10-02, W7 step 6 first review

The accepted **forwarded value** and immutable-projection requirements apply to wire JSON, not an
opaque JavaScript object's identity. Offline actual-adapter review reproduced boxed numbers and
native cap `toJSON` values that were priced as uncapped yet serialized as a numeric cap, including
a value changed during credential resolution. Surviving opaque controls now undergo one
property-key-correct JSON capture before admission; that deeply frozen data supplies both pricing
and wire lowering. Discarded controls are not serialized. An executable outer native `toJSON`
cannot replace the whole mapped body; ordinary noncallable data retains its wire behaviour.
This enforces the existing cap authority and does not introduce a generation control.

The same review found SDK ambient endpoint/backend overrides underneath instances classified as
official. Official factories now explicitly pin their intended SDK route and backend; only the
existing validated custom-factory path can select another endpoint. Canonical details and tests
live in the [seam contract](../reference/shared-core/llm-provider-seam.md#current-request-estimates-and-bound-output-caps)
and adapter test suites. Required core hook transport has its single home in the
[agent-runner contract](../reference/shared-core/agent-runner.md#pre-egress-injection-contract).

## Implementation correction — 2026-10-02, W7 step 6 second review

The forwarded-JSON capture also covers **primitive BigInt**: JavaScript invokes
`BigInt.prototype.toJSON` for it, and a credential-await mutation must not change a cap after
admission. A valid serializer is captured under its property key once; a genuinely unserialisable
surviving value receives the existing fixed refusal before admission. Discarded BigInt remains inert.

The same review distinguished a forwarded but unsupported control from one the wire lowering
actually discards. Gemini's SDK drops OpenAI-only cap fields before JSON serialization, so their
opaque values must never be inspected through JSON or refused for a cycle. The shared reconciliation
now discards those fields as well as mapped-field collisions. DeepSeek's forwarded modern key
retains capture even though its official dialect does not recognise it for reservation. Actual
SDK HTTP tests cover both paths; the canonical mechanism remains the
[one seam contract](../reference/shared-core/llm-provider-seam.md#current-request-estimates-and-bound-output-caps).

These corrections enforce the existing transport-preservation and immutable-cap decisions; neither
changes a generation control or introduces another lowering authority.

## Implementation correction — 2026-10-02, W7 step 6 third review

Deep freezing the captured JSON does not isolate its inherited `toJSON`: parsed records and arrays
retain mutable prototypes. Actual SDK HTTP review reproduced a captured nonnumeric shape priced
with fallback 17, then serialized as numeric 200,000 after credential resolution activated an inherited
serializer. Both pre-existing and newly installed serializers reproduce the mismatch on both paths.

Every captured JSON object and array now has its prototype detached before freezing. Array identity,
own data keys and JSON shape remain intact, while later inherited serialization cannot change the
admitted cap. This is an enforcement correction to the accepted immutable projection, not a new
generation control or a claim that arbitrary host-wide mutation is sandboxed. The canonical mechanism
and staged heterogeneous-candidate obligation remain in the
[seam contract](../reference/shared-core/llm-provider-seam.md#current-request-estimates-and-bound-output-caps).

## Implementation correction — 2026-10-02, W7 step 6 fourth review

Request staging copied native options before the guarded JSON capture. A cap getter throwing
private content therefore escaped the fixed refusal, including from direct adapters before their
credential-redaction path. Checking an existing genuine plan had the same unguarded inspection.
Offline review reproduced both; an exact synthetic credential escaped on both OpenAI paths.

Factory construction, native option copying, binding/lookup and staging now share a private,
content-free error guard. Inspection exceptions become the existing `InvalidOutputCapPlanError`,
with neither the original throwable nor its cause retained. Direct adapter and chain cap inspection
refuses before transport, admission or credential resolution. This enforces the accepted safe,
immutable capture; cap precedence, native forwarding and rate-only pricing remain unchanged.
The guard covers these helpers rather than arbitrary caller-object inspection throughout the host.
The canonical contract remains the
[seam contract](../reference/shared-core/llm-provider-seam.md#current-request-estimates-and-bound-output-caps).

## Implementation foundation — 2026-10-02, W7 step 9

Frozen allowance quotes now consume the same resolved-output, rate-only kernel as final governor
pricing. The process-local quote context preserves original construction controls for heterogeneous
candidates; the paused attempt reuses its immutable captured plan. Effective native output caps remain
unclamped through E and A and no quote inserts a wire limit. A scalar basis contains quantities, selected
highest-context-tier non-cached rates, media prices/gaps and candidate/endpoint/attempt identity,
without raw options, plans or closures. Unsafe E/A carries a reject-only marker rather than a number.
The [runner contract](../reference/shared-core/agent-runner.md#dispatch-allowance-foundation) distinguishes
this calculation/debit foundation from Step 10's still-staged durable activation protocol.
