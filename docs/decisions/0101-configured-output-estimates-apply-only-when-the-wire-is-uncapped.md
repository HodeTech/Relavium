# ADR-0101: Configured output estimates apply only when the wire is uncapped

- **Status**: Proposed — awaiting maintainer approval; no dependent implementation authorised
- **Date**: 2026-10-02
- **Related**: [ADR-0028](0028-workflow-resource-governance.md) · [ADR-0071](0071-models-dev-as-the-model-metadata-source.md) · [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) · [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) · [architectural principles](../standards/architectural-principles.md)
- **Scope**: W7 step 6 output-reservation/configuration precedence. Narrows ADR-0028's configured-default promise for requests with an effective wire cap and clarifies ADR-0096's unauthored fallback. Does not change generation limits, input pricing, compaction policy, allowance ownership or runtime dependencies.

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

Source evidence lives in [the governor](../../packages/core/src/engine/budget-governor.ts),
[its configured-default test](../../packages/core/src/engine/budget-governor.test.ts),
[Anthropic lowering](../../packages/llm/src/adapters/anthropic.ts),
[OpenAI lowering](../../packages/llm/src/adapters/openai.ts),
[Gemini lowering](../../packages/llm/src/adapters/gemini.ts), and
[the existing output-cap helper](../../packages/llm/src/output-cap.ts).

## Decision

**Proposed: resolve the effective wire cap first; use the configured estimate only when the
request remains uncapped. Preserve the existing wire behaviour.**

- One pure resolver in `@relavium/llm`, expressed in Relavium seam types, supplies the output
  reservation used by context measurement, governor pricing and frozen allowance calculation.
  All three consumers receive the same request/endpoint identity and configured fallback.
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

Considered fixing every uncapped reservation at 4,096 and retiring nondefault overrides. That is
closer to a literal reading of September's acceptance case, but would remove existing estimate
tuning and require a visible compatibility/migration policy. Considered introducing a shared
wire default or sending the configured estimate as a cap. That provides a stronger output bound
but changes generation length and native/custom-provider behaviour, beyond this narrow gap.
The proposed choice retains those behaviours while removing substitution for a known cap.

### Acceptance and landing obligations

- An uncapped official request with no configuration reserves 4,096 clamped to its catalog ceiling.
  A nondefault configured value is used only for that uncapped branch; an unknown/custom endpoint
  does not inherit a different service's ceiling.
- An unauthored Anthropic request reserves its actual required default cap even with a configured
  estimate of 1 or a larger value. Authored canonical caps still win and follow existing clamping.
- A valid native cap surviving `providerOptions` keeps the same wire value and reservation; a
  colliding canonical cap keeps existing precedence. Cover every lowering dialect and both paths.
- Pin each recognised native key, reversed dual-key sizes and their maximum envelope, invalid-only
  options and official DeepSeek's modern-key-only uncapped fallback. A forwarded but unrecognised
  field must not become proof of a limit. Native caps/envelopes above an official catalog ceiling
  remain unclamped through final governor pricing and allowance sizing, not only in the resolver.
- Pin authored-above-ceiling and custom-endpoint/catalog-id-reuse cases. Removing endpoint identity
  or configured-fallback forwarding must break the corresponding test.
- Context measurement, governor pricing and allowance sizing use the identical resolved quantity.
  Generative-media gates retain zero text reservation. No new automatic compaction or provider
  overflow classifier is implied by this resolver landing.
- Requests without a cap remain without one. No fixture may verify a newly inserted limit and
  describe it as preservation of wire behaviour.

After approval, add targeted dated notes to ADR-0028, ADR-0096 and ADR-0097 without rewriting their
bodies. Update the canonical [config contract](../reference/contracts/config-spec.md),
[LLM seam](../reference/shared-core/llm-provider-seam.md) and
[agent-runner contract](../reference/shared-core/agent-runner.md), plus W7's step 6/9 checklist.
This proposed document does not yet amend those Accepted decisions or authorise implementation.

## Consequences

### Positive

- A known wire cap is priced consistently instead of being replaced by an unrelated configured guess.
- Existing generation defaults, native-cap precedence and custom-provider semantics remain intact.
- Configured tuning remains useful for the uncapped case it can describe, with one canonical resolver.

### Negative

- Configured estimates previously lowering Anthropic's reservation can now cause an earlier budget
  refusal. Document the narrower scope and the authored-cap remedy before landing.
- An uncapped request still has a heuristic output reservation, not a billing bound. Preserve
  ADR-0097's disclosed overrun behaviour and make no claim that this change hard-caps generation.
- The resolver must track lowering precisely. Per-dialect/native-cap identity tests are required to
  prevent future divergence; the engine does not inspect vendor SDK types or wire error strings.
