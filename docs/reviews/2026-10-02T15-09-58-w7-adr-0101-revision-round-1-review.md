# Review: W7 ADR-0101 mechanism revision, round 1

- **Type**: Code
- **Date**: 2026-10-02 (timestamp in Europe/Istanbul)
- **Reviewer(s)**: maintainer; `/root/w7_adr0101_revised_mechanics`, `/root/w7_adr0101_revised_contracts`
- **Subject**: `development`, Proposed ADR-0101 at `68b6be4b` and its mechanism-revision diff
- **Outcome**: Changes requested; verified gaps corrected in the proposal; fresh round 2 pending

## Summary

The maintainer reviewed the proposal against ADR-0028/0071/0096/0097/0099/0100 and current code.
The parent independently verified the findings, revised the Proposed document and requested two
fresh independent reviews. Mechanics used `gpt-6-astra` at max effort; contracts used `gpt-6.1-sol`
at xhigh effort. Both found the maintainer's original gaps resolved in the revision. Contracts
accepted the draft; mechanics identified one further construction-to-attempt snapshot gap, which
the parent verified and corrected. A separate read-only mechanism preflight supplied source advice,
not acceptance of the final draft.

## Verified corrections

- **High — native cap inputs did not reach admission.** Existing `PreAttemptHook`/`PreEgressHook`
  and positional governor inputs omit `providerOptions`. The proposal now requires a copied cap
  projection, actual routing identity and a prepared plan through both chain paths, turn/host/
  durability wrappers and object-based governor inputs. Required keys, actual forwarding and
  mutation tests are landing obligations. Native tests use the existing direct request/chain seam;
  a new YAML/session options feature is not introduced.
- **High — resolved native output was clamped again during pricing.** Existing
  [budget-estimator.ts](../../packages/llm/src/budget-estimator.ts) invokes `cappedMaxTokens` on every
  output estimate. The proposal now chooses a separate rate-only resolved-token entry, used by
  governor and allowance computation, with above-ceiling monetary refusal tests. It prohibits
  falsely labelling an official endpoint custom to bypass the old clamp.
- **Medium — policy ownership and related decisions were incomplete.** The revision expands
  ADR-0096's one helper into a shared cap plan consumed by adapters, preserving mapped/native/
  reservation and thinking-control distinctions. It relates ADR-0099/0100 and names their landing
  obligations. ADR-0096's unauthored-4,096 acceptance and historical hook premise are explicitly
  qualified. Dual native-key accounting is not claimed as upstream validity or precedence, and
  custom no-clamp acceptance is identified as preservation of existing behaviour.
- **Medium — a measured cap plan was not handed to attempt preparation.** The first revision froze
  admission-to-wire data but could still replace a prior context measurement's plan after refreshed
  metadata changed. The parent verified the mutable non-shipped catalog overlay and the prescribed
  ADR-0096/0099 measurement ordering. For example, a summariser authored at 4,096 could be measured
  against a 1,024 output ceiling and later dispatched against 4,096, invalidating its earlier fit.
  The corrected proposal hands the measured plan to the matching attempt, or repeats dependent
  measurement under the existing entry-point rules before egress. A dedicated construction-to-
  attempt refresh acceptance covers the first main candidate and every required summariser fallback.
  Main-turn oversized-floor/failed-compaction policy and permitted trim outcomes remain unchanged.

## Additional source constraints incorporated

The actual factory's endpoint classification must reach direct custom adapters, not only the CLI
wrapper. The same staged cap inputs and observed catalog ceiling survive admission/key awaits.
Gemini thinking lowering consumes its canonical mapped cap/catalog fallback, never a reservation
envelope. Allowance `E` rebinds raw paused cap inputs to each eligible candidate, including cooldown
entries; it does not reuse one resolved number across different dialects. Arbitrary native options
remain ephemeral rather than becoming durable quote/event payloads.

## Limits and follow-through

This is a documentation/source review of a Proposed decision. No dependent implementation, provider
calls, network, credentials or probe artifacts were used; no future regression is claimed to have
passed. The required workspace lint/typecheck/test gate passes 23 tasks before the proposal commit.
Canonical API schemas and implementation parity tests land only after maintainer approval. Older
Accepted ADR bodies and status are unchanged; the proposal lists their future dated forward notes.

Fresh reviewers will review the complete corrected proposal in round 2. ADR-0101 remains Proposed,
step 6 implementation remains unstarted, and all six W7 register items remain open.
