# W7 post-closure Step 1 — cumulative round 1

- **Type**: Code + Security
- **Date**: 2026-10-10
- **Reviewer(s)**: `/root/postclosure_step1_r1_a` (gpt-6-astra, xhigh), `/root/postclosure_step1_r1_b` (gpt-6.1-sol, xhigh); Parent `/root`
- **Subject**: all fourteen cumulative paths, `b7fe32d8` → `6e92b4e9`
- **Outcome**: two independently reproduced failure schedules; corrected in `11453744`; two fresh clean complete rounds required

Both NEW reviewers read the complete cumulative change and relevant continuations, independently
ran ten focused suites (307/307 each), and verified the exact frozen HEAD, clean state, every
path/hash, patch hash and logical index hash. A counted 42 zero-context hunks and B counted 26
ordinary contextual hunks: these are different diff presentations of the same fourteen paths.
Neither reviewer edited the repository or ran broad CI, a provider or a key operation.

## Confirmed findings and corrections

1. **High: returned media refusal loses to deadline cleanup.** The first correction preserved a
   thrown primary, but a fulfilled `MediaJobStatus.state = failed` was also a primary. A secondary
   disarm fault turned auth/context refusals into retryable `provider_unavailable`. Independent paired
   source probes reproduced the difference. The corrected poll retains a failed status; pending/done
   cleanup-only faults stay observable. Four permanent auth/context × cleanup controls pin the result.
2. **High: terminal preparation escapes the scheduler backstop.** The immediate settled latch correctly
   stops admission, but a one-shot elapsed-clock, terminal timestamp or ID fault could strand publication
   and the primary stream. Resetting that latch would replay settlement/accounting. Terminal data now has
   a guarded construction phase and a fixed minimal failed/cancelled fallback retaining an earlier cause.
   Event stamping retries only an **unstamped** terminal, before sequence advancement, persistence or
   delivery. Ten permanent controls cover successful/failed/cancelled outcomes, elapsed/stamp faults and
   a failed-terminal ID fault; they require one gap-free terminal, primary closure and acknowledged release.

First-party timer cleanup uses the ordinary native port; throwing cleanup is an injected/custom-host
fault schedule. Neither result claims a live provider defect. Recovery is bounded to the demonstrated
one-shot host faults. A permanently unavailable clock cannot certify a timestamp; this change does not
invent one, retry a persisted terminal, add a terminal-free disposition or mislabel a host fault as fencing.
The fallback correlation identity reuses the run ID and does not claim a fresh host-generated ID.

The reviewers found no further material issue in compaction rollback/moment balancing, monotonic
realized money, generation cleanup precedence, retained exact-fence ordering or the scoped intake.
Full-history validation and empty checkpoint retries remain intentional safety guarantees. CLI/DB and
tooling/document corrections remain separate increments, not accepted by this record.

## Parent verification and evidence limits

Parent read both complete reports and their probe receipts, confirmed both source mechanisms, and
applied the corrections after both reviewers released the freeze. The correction adds fourteen cases,
bringing this increment to twenty-six permanent additions. The first author focused attempt omitted
required fields in a new test's `makeLlmError` call; its four failures are fixture errors, not product
findings. Corrected controls pass. Six focused suites pass 66/66; the restored ten-suite run passes
321/321. `pnpm run ci` exits 0, including required source gates, build/format and offline smokes.

Three separate bounded interventions remove only terminal-data recovery, only unstamped retry, or
only returned-status precedence. They fail four, three and two intended assertions respectively;
restoration matches the original engine SHA-256 and the ten-suite positive run passes. These are
current-source interventions, not historical whole-source builds. Negative filtered runs report skipped
unselected tests; they do not introduce permanent suite skips.

External evidence is under `~/.codex/relavium-evidence/w7-new-review-20261010/`: reviewer
`step1-round1/agent-{a,b}/report.md`, independent run/probe/freeze receipts, author
`step1-review-ci.json`, `step1-review-restored.json` and `step1-review-causal.json` with logs.
Parent gates/controls are attributed to Parent; reviewers' original 307-case runs precede the correction
and do not accept it. Two NEW complete clean cumulative rounds must review the corrected composition.
