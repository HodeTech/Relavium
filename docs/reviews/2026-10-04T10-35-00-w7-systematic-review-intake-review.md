# W7 PR 90 systematic review intake

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: maintainer-supplied systematic reviews; `/root/w7_systematic_request_triage`; parent `/root`
- **Subject**: two PR 90 reports against `95137c34`, independently targeted at current `578c14a5`
- **Outcome**: Changes requested; no whole-PR acceptance

## Findings and qualifications

The parent registers 35 deduplicated submitted findings. Their severity, proposed repair and reachability
are evaluated individually; a suggested skip-on-corruption policy is not automatically adopted. No finding
is deferred at intake. The newer head's ten GitHub CI checks pass, whereas SonarCloud still reports seven
bug/vulnerability annotations requiring separate adjudication. This does not clear the reviewed defects.

A fresh `gpt-6-astra` / xhigh agent independently verifies four financial/runtime subjects:

- **High:** admitted input of 37 tokens becomes 50,035 tokens in actual OpenAI SDK dispatch under a
  1,000-microcent cap. Both chain paths also forward mutated message, tool/schema, response schema and native
  option values. Cap immutability alone does not own the independently reconstructed admission request.
- **Low:** a local invalid cap plan remains the typed cause but becomes `unknown`/`internal` through the
  chain/turn. It should use the existing fatal `bad_request`/`validation` path, without credentials or egress.
- **Low:** BigInt, cyclic and throwing-serializer tool results dispatch once, then emit duplicate call events
  and flatten the existing nonretryable `tool_failed` error to `internal`. The claimed durable raw-ID leak
  is not reproduced: ADR-0095 explicitly permits raw names in public failure events. Map/Set compatibility
  controls succeed and are not JSON failures.
- **Low:** the combined approved-default-primary-twice/fallback-success acceptance lacks a permanent runtime
  control. A new real-engine control succeeds with one pause, allowance 60, three attempts and two retained
  conservative commitments. This is a coverage gap, not a reproduced failover-loop defect.

An additional **Low** portability issue is reproduced: a deep-JSON test assumes a fixed recursion limit,
but native JSON serialization succeeds with 30,004 bytes in the reviewer worker. Runtime rejection of valid
JSON would be the wrong repair. The selected existing run is **145 passed / 1 failed**, and the isolated
JSON suite is **9 passed / 1 failed**; those failures are preserved. Fifteen final targeted controls, strict
fixture types and five fresh package builds pass.

The parent also refutes the submitted terminal-budget-map claim by tracing normal and fenced settlement:
both call the cleanup helper, which clears approvals and dispatch state. A historical review statement is
not converted into a code change when the current implementation already satisfies it.

## Execution and review order

1. Published-notice visibility and CI route/ownership consistency.
2. Owned measured request, typed cap refusal, invalid tool-result handling and combined failover proof.
3. Budget-gate lifecycle and operator feedback, including excluded candidates and stale decisions.
4. Corrupt-history isolation and durable bookkeeping, preserving reservation and replay safety.
5. Required replay CI, predecessor evidence/provenance and a dependency version meeting the cooling rule.
6. Canonical document corrections, individual finding disposition and final whole-wave checks.

Every implementation group is committed, reviewed by fresh agents, corrected and reviewed again. A repair
that requires a new architecture decision is drafted for maintainer approval before dependent code. Existing
[ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md) and
[ADR-0101](../decisions/0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md)
already require measuring the request that is sent; owning that request does not authorise changing native
wire serialization, output limits or opaque escape-hatch compatibility.

## Evidence integrity and limits

The triage uses a fresh physical owned source tree, 79 individual dependency links, clean child environments,
main/worker network and native-keyring denial, and exact fake-keyring resolution. Eleven internal links and
173 declaration resolutions remain inside its own freshly built packages. All setup/test/type failures
remain in its complete logs. The reviewer releases every runtime handle and all future tree access.

Before any Original source edit, the parent fully reads its 21,699-byte report, verifies every **1,705 physical
entry** (1,463 files, 163 directories, 79 literal links), and checks all 1,085 unchanged original/source pins.
Report SHA256: `0bf8a4801d0dbc563e5ae6921cdb70f4a447e39adc52679592c22828a395b739`.
Inventory: 418,103 bytes, SHA256 `1fa49da225615ec979141ab2c27c93f77d447d68fd845eeade31feac9d535479`.
Inventory-format differences are handled in the parent verifier, including the directory's serialized-name
byte count; every recorded field is compared. The sealed root is never executed or mutated after release.

This is targeted triage, not either final corrective review round and not a review of all 342 changed paths.
Steps 7–8, whole Step 12 and all six W7 items remain open. Three genuine overflow artifacts exist; missing
Gemini overflow and Anthropic context-stop evidence is not invented or replaced with diagnostic responses.
