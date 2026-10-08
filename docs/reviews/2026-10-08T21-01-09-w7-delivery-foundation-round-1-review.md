# Review: W7 delivery and receipt-lifetime foundation, round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0103_foundation_r1_lifetimes`, `/root/adr0103_foundation_r1_delivery`
- **Subject**: `7adec7fb..49d6e4df`, eight foundation paths; subsequent observer correction
- **Outcome**: Changes requested; one verified High corrected, fresh complete review required

## Finding and correction

**High — `host-work-registry.ts:87–98`: observer setup can falsely certify raw completion.**
The original catch covers both calling the factory and attaching its returned Promise's
overridable `then`. A genuine pending native Promise with a throwing constructor getter
causes species lookup to throw: the catch ends authority, releases the slot and substitutes
a rejecting Promise while the real raw operation remains pending. An overridden `then`
can instead falsely call completion synchronously. An override that attaches a genuine
observer and then throws also releases twice, leaving a negative pending count after real
settlement. This violates exact-raw lifetime and host-safe joining. Departure is not yet
integrated, so no shipping `depart()` failure is claimed.

Both fresh reviewers independently reproduce the premature completion on native pending
Promises; the lifetime reviewer also compiles a strict, cast-free custom `NodeExecutor`
returning such a Promise. Parent verifies the control flow before correction. Factory
exceptions now have their own rejection path. Observation uses a captured native intrinsic,
bypassing own `then` overrides. Constructor/species observation failure retains the exact
raw Promise, slot and authority and exposes a sticky content-free `observationFailed`
diagnosis. A failure to observe cannot certify host release; joining remains pending even
if a different observer later sees completion. No caller cause or new durable code is added.

Two permanent tests cover seven distinct observer cases: getter, premature fulfilment and
attach-then-throw overrides, plus constructor/species setup failures with real fulfilment
and rejection. Ordinary factory throw, entered work and child scopes retain their controls.
The canonical foundation documentation explicitly describes observable settlement rather
than synchronous Promise-state introspection: earlier attached reactions may enter work
before the registry's completion reaction; that entered work remains joined. Dishonest
untransferred background intent is not detectable.

## Complete independent coverage

The lifetime reviewer uses `gpt-6-astra`, xhigh; delivery uses `gpt-6.1-sol`, xhigh. Both read
all eight cumulative paths, their complete tests/surrounding code, CLAUDE.md, the repository
review procedure, relevant standards and the approved ADR-0103 amendments. They verify
registration before invocation, raw identity, parent/child/entered-work lifetimes, idle
notification rechecks, buffered/waiting delivery, sticky gaps/abandonment, passive observers,
closure and execution-local counts independent of durable sequence numbers. No additional
dependency, platform/vendor import, unsafe type escape, secret or durable-schema finding.

Lifetime verification passes 58 tests over six actual files and ten frozen-source in-memory
scenarios / fifty assertions. An initial command names a nonexistent session-test path;
the corrected follow-up covers the actual session and terminal suites. Its first virtual
type configuration incorrectly requests unavailable root Node types; `types: []` then
passes with zero diagnostics. Delivery independently passes 73 tests across seven suites,
fourteen in-memory controls and seven separate causal removals. Neither changes shared source.
Their reports review `49d6e4df`, not the subsequent correction.

Parent's restored correction passes 62 tests across seven suites under `CI=true`, scoped
ESLint, stable pinned formatting and diff checks. Initial new-test lint catches ignored
Promise-valued descriptor returns and unbound intrinsic extraction; both are corrected
before commit, without rule suppression or unsafe casts. Full CI/coverage is not claimed
for the corrected source yet; active Step 7 edits remain separate.

## Remaining acceptance

Fresh reviewers must inspect the entire foundation plus correction. This increment does
not implement departure, engine producer registration/retirement, retained ownership,
ordered late writers, final receipt disposition, checkpoint timing or CLI acknowledgement.
The existing paused-host lifecycle High, ownership integration, Steps 7–8 and Step 12
remain open. No provider call, key/private read, branch switch, merge or premature lifecycle
acceptance occurs in this round.
