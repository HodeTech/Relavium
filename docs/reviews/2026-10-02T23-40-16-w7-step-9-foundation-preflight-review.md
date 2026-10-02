# Review: W7 step 9, price and quote foundation preflight

- **Type**: Code
- **Date**: 2026-10-02 (timestamp in Europe/Istanbul)
- **Reviewer(s)**: `/root/w7_step9_draft_quote_preflight`; parent verification `/root`
- **Subject**: four external implementation candidates against `development` at `ae292623`; subsequent parent foundation at `fa77a03c`
- **Outcome**: Changes requested; verified candidate corrections implemented, independent committed-step acceptance still pending

## Findings and correction

Targeted preflight used `gpt-6-astra` at max effort. It reviewed the accepted allowance,
output-reservation and media-rate decisions, four external candidate files and current
governor/runner/chain integration. Two mechanical findings required correction:

1. **High — unusable media prices changed the established policy.** Negative, NaN and
   infinite media rates became fatal malformed arithmetic instead of named pricing
   gaps, including at zero volume. The corrected kernel preserves known token/other-media
   costs and reports the gap; non-strict admission discloses it, strict admission
   refuses it. Explicit rate zero remains priced, as required by
   [ADR-0089](../decisions/0089-media-correctness-four-boundaries.md).
2. **Medium — unknown model lookup masked malformed media quantities.** Validation
   happened after price lookup, so invalid units on an unknown model escaped through
   ordinary unpriced policy. All finite non-negative quantities now validate and copy
   before lookup. Valid unknown pricing remains distinct from priced zero and unsafe cost.

Neither required a new decision. An inherited highest-tier sentinel edge was also closed:
finite thresholds equal to or above MAX_SAFE_INTEGER now select the highest context
threshold, while realized strict-threshold and first-equal-tier semantics remain unchanged.

## Parent verification and integration

The parent read the report and fixture/loader source, verified all 28 sealed artifacts,
and replayed the original candidates: **19 pass, exactly the two reported controls fail**.
The corrected external candidates pass **21/21**. The review's read-only proof preserves
all 1,017 tracked hashes and all four original candidate hashes. Its counterfactual
fix was evidence only; the parent owns every canonical edit.

Further parent controls closed candidate reconciliation gaps: an initially unpriced
attempt's later known actual debits its owner; the in-flight slot stays held through
the lifetime callback; consumed positive allowances close at exact depletion; media
quantities are copied before a pricing callback can mutate them. Preserved failing
runs distinguish these candidate defects from shipped Step 6 source.

Permanent tests cover one combined token/media price read and frozen finite scalar
evidence, class rounding, native caps above ceilings, heterogeneous dialects,
capability/streaming skips, cooldown inclusion, strict/non-strict pricing gaps,
zero/unpriced/unrepresentable distinctions and full quote comparison. Governor controls
cover cap-zero/under-cap debits, refunds, conservative retention, overdraw, sibling and
successor isolation, notice/settlement reentry, warning and durability waits, invalid
actuals, safe gate quotes and content-free ownership errors. Five actual AgentRunner
controls prove delegate-filtered tool lists, node retry not multiplying A and primary-only
generative sizing. These use synthetic offline providers, with actual engine/chain source.

Ten separately applied causal negatives remove one protection at a time: under-cap
debit, realized reconciliation, global-before-host settlement, warning lifetime recheck,
tool-loop factor, entry attempt factor, full basis comparison, positive exact depletion,
media snapshot and reconciliation single-flight. Each exits 1 with assertion failures
and passing controls; all four mutated sources are restored byte-for-byte. The restored
nine focused suites pass **279 tests**. Focused lint and core strict/purity typechecking
pass. This record does not claim whole-monorepo CI/coverage or independent acceptance
of the subsequently committed implementation.

## Evidence and limits

The marked parent evidence root is
`/var/folders/d2/k7c1fj3976g7_qq7113f66p00000gn/T/relavium-w7-step9-parent-d_w7x77a`;
review evidence is
`/var/folders/d2/k7c1fj3976g7_qq7113f66p00000gn/T/relavium-w7-step9-review-_whn07hw`.
Before/after JSON, strict diagnostics, fixture setup/style failures, causal logs and
restoration hashes are retained. An initial focused selection named a nonexistent old
notice suite; the actual seven-test suite is included in the restored nine-suite run.
Harness failures are not reported as product findings.

The [runner contract](../reference/shared-core/agent-runner.md#dispatch-allowance-foundation)
states the delivered boundary. This is the calculation, quote-context and governor debit
foundation. It does not activate a token from the legacy H3 boolean, persist an approval
or certify checkpoint/cross-process replay. Step 10 still supplies the authoritative
authorization and observed ownership acknowledgement; Step 11 supplies confirmation.
Shared durable Zod-inferred types must become the one canonical shape home in Step 10.
No live provider, actual billing bound, physical crash/TTY or frozen predecessor execution
is claimed. Steps 1–6 remain closed; Step 9 and all six W7 register items remain open.
