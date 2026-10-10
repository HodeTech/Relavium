# W7 ADR-0102/0103 maintainer follow-up — round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_maintainer_followup_r1`, `/root/adr0103_maintainer_followup_r1`; parent `/root`
- **Subject**: complete Proposed ADR-0102/0103 and `080b002d..64d5889c`
- **Outcome**: Changes requested — one verified SDK feasibility High; corrected proposal requires fresh review and maintainer approval

## Summary

The maintainer's eight-item review is checked against both complete proposals and relevant code.
The dated clarifications separate ownership from measurement, correct serializer compatibility
claims, specify real primary delivery/gap observation and explicitly qualify terminal-free local
detachment. Neither proposal is accepted or implemented by this work.

Two independent static reviewers inspect the complete decisions. The lifecycle reviewer reports
no material finding. The ownership reviewer traces one High: the newly required literal-key
preservation would reach an unsafe merge in the installed Gemini SDK. Parent reads both complete
reports and independently verifies the adapter/SDK source path. This is a proposal-feasibility
finding, not an executed exploit or evidence of a runtime ownership fix.

## Findings and maintainer-item disposition

| Item | Verified disposition |
| --- | --- |
| Actual primary cursor | The shipping handle exposes buffer depth, not delivery. ADR-0103 now requires private publication/delivery observations at the buffered and direct waiting-pull paths, with separate gap/abandonment refusal and unpublished-actor checks. |
| Terminal-free detach | The proposal explicitly qualifies ADR-0036's terminal-driven local iterable, following ADR-0079 §5. Local execution departure does not terminate the resumable logical run. Accepted forward notes remain landing obligations. |
| Owned versus measured fields | ADR-0102 explicitly keeps the existing four-field EstimateTokensInput subset and separate output reservation; ownership does not add other request fields to input pricing. |
| Date/custom serializer history | Formerly serialized inputs are distinguished from SDK-discarded inputs; refusal is an intentional compatibility narrowing. |
| Literal prototype key | Missing downstream proof is confirmed; the independent SDK trace reveals the High below. |
| Cap serializer asymmetry | The existing cap authority captures native values once at their actual keys; generic payload serialization stays forbidden. No second cap field list or serializer privilege is introduced. |
| Editorial spacing | The compressed acceptance-code spacing is corrected without changing priorities. Existing presentation wrapping passes the repository formatter; it introduces no semantic change. |
| Canonical diagnostic owner | The proposal explicitly distinguishes decision-review detail from an active schema and assigns the future normative stderr/exit/remedy contract once to CLI commands. No new schema copy or live contract is introduced here. |

**High — ADR-0102's literal-key promise conflicts with the installed SDK merge.**
The adapter's native-option projection preserves an own `__proto__`. Its current
[transport-key copy](../../packages/llm/src/adapters/gemini.ts) uses setter-based assignment.
Fixing that copy to preserve the key as data would pass it through the config spread, alongside
ordinary canonical tools, to the actual SDK transport. The installed SDK's
`processParamsMaybeAddMcpUsage` then uses `Object.assign` into an ordinary destination before
converter filtering. Generate, disabled-AFC stream and normal streaming all reach that operation.
An inert object value changes the destination's prototype through its inherited setter; a
null-prototype source alone cannot prevent it.

Parent independently reads the adapter's copy/config/transport paths and the installed SDK's
generate/stream/preparation paths. No SDK code is executed and no HTTP body is captured. SDK versions
retain their home in [tech-stack.md](../tech-stack.md).

Correction `6254a6fa` appends a narrower **Proposed** supported-key policy to
[ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md): reject an own
string `__proto__` key anywhere in traversed non-cap data with the same content-free error, before
admission/key/SDK entry. Do not silently drop or rename it. Preserve the separately governed cap
exception, require migration and causal refusal controls, and retain all other supported-domain
wire/prototype obligations. This explicitly qualifies the earlier preservation promise without
introducing an SDK patch or new preparation interface. It is an additional compatibility decision
requiring maintainer approval; this round does not certify the correction.

## Coverage and limits

| Reviewer | Model / effort | Coverage |
| --- | --- | --- |
| Ownership | `gpt-6.1-sol` / `high` | Complete ADR-0102/0103 and cumulative diff; types, estimator/cap contracts, Gemini adapter and reachable installed SDK merges. |
| Lifecycle | `gpt-6-astra` / `high` | Complete ADR-0103/0102 and cumulative diff; handle/queue, engine resume/ownership/writer/receipt paths and relevant accepted decisions/contracts. |

The background ADR/spec/source reads are selective, not a new exhaustive historical corpus review.
Reviewers are read-only; no tests, credentials/keychain access or provider requests occur. They do
not read local private settings. There is no sealed-Own or physical inventory attestation in this
static round. Parent source verification and full report reads are separate from the reviewers'
claims.

Parent Prettier and diff checks pass; both Proposed ADRs have one H1 and all 37 relative links/anchors
resolve. The required pre-commit lint/typecheck/test command passes **23 cached tasks**. Those results
do not execute proposed ownership, delivery, receipt-lifetime or native CLI acceptance controls.
No runtime source, dependency, shared error code or durable schema changes.

## Follow-ups

Fresh independent review must inspect the corrected complete proposals. Explicit maintainer approval
must precede dependent code. The request-ownership and Group-3 lifecycle Highs remain open at the
implementation level. Missing Gemini/Anthropic provider evidence, Steps 7–8/12, Sonar and W7/PR merge
acceptance remain open. The exhausted capture authorization is unchanged; no additional paid call
or billing change is made.
