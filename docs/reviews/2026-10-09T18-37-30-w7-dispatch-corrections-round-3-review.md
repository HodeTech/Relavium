# Review: W7 dispatch terminal idempotence, round 3

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`dispatch_r3_authority`, GPT-6.1 Sol, xhigh;
  `dispatch_r3_lifecycle`, GPT-6 Astra, xhigh), plus Parent's source, artifact and freeze audits.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through
  `1934df663888a352a5642863b993b38d34b2d409`: thirteen paths / twenty-seven literal hunks.
- Outcome: changes required for one confirmed High. The later correction requires fresh
  complete cumulative review; this round does not accept its private implementation.

## Confirmed finding and correction

Lifecycle independently identifies a same-node deadline winning while retry attempt 2's
`node:started` append is held. The deadline synchronously marks the vertex failed and
queues its `node:failed(run_timeout)`. Releasing the start while that failure write is held
lets retry refusal queue another `node:failed(cancelled)` for attempt 2. The executor is
correctly refused and the run retains `run_timeout`, yet the node history has two terminals.
Authority corroborates the source after disclosure; it is not a second independent discovery.

Parent confirms the exact frozen source: executor entries `[1]`, timeout terminal sequence 4
and cancelled terminal sequence 5, both attempt 2. The injected clock reaches the captured
conforming 5,000 ms deadline before its callback fires. This is a controlled reference-host
reproduction, not native/provider or public-departure proof.

The correction gives the shared refusal/diagnostic helper the existing completed/failed/skipped
node-status guard, retaining scheduler reevaluation. A terminal already owns the vertex even
while its append is pending. The canonical mechanics remain in the
[engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103).

One permanent regression holds both append boundaries and asserts exactly one attempt-2
timeout terminal, no second executor entry, unchanged root cause and lease/timer cleanup.
The final eleven-case causal matrix uses identical strict-typed, formatted test bytes:
original and terminal-guard-removed fail one/pass ten; fixed and restored pass eleven.
All four original logs are read completely and 5,024 copied inputs physically verified.
Final private strict types, scoped lint and the complete core suite pass: 115 files /
2,879 cases, no skips or unhandled errors. These results do not substitute for fresh review.

## Complete review and evidence custody

Each new reviewer inspects the entire cumulative scope and relevant continuations, with no
partition or inherited acceptance. Each passes seven prescribed originals: sequential cold
shared/LLM/core builds, strict types, platform purity, scoped lint and the complete offline
core suite: 114 files / 2,878 cases, no skips or unhandled errors. Those are frozen-head
results, not acceptance of the correction.

Parent reads both complete reports and both complete JSON/Markdown maps, including all
26 path and 54 hunk rationales. Exact Git/archive/head/hunk identities, fourteen original
captures / 17,598 copied eligible inputs, 1,290 archived files per reviewer and 99 dependency
links each (eleven private workspace remaps) are physically verified. Protected inventories
contain 11,438 Authority / 11,437 Lifecycle regular files, 916 directories and 99 links each;
each original temporary inventory contains 981 files / nineteen directories. Bytes, link
targets and 0444/0555 protection are checked without traversing dependency targets; the
owner can reverse that protection.

| Reviewer | Report SHA-256 | Parent seal SHA-256 |
| --- | --- | --- |
| Authority | `e6e8bdfd2fb7692aaa17393d698a694bee076fadad59975d8a2da951b2c5d3f9` | `3884f283c8f19046f9be0b5b3e060ba0832f6e3bccedbd62d12367fe37e500e2` |
| Lifecycle | `ab0611d4b277aed6d2ccc703dbd7e11ee9765539d7bf209433d8c6c0b2c03fe4` | `c6906076d16f4f5ed41b0518425035023e301cc7ad625cd847a3a2854ed4ea91` |

Evidence is under `/Users/cemililik/.codex/relavium-evidence/`, round root
`w7-dispatch-corrections-r3-20261009T181527Z`; Parent controls are under
`w7-scheduler-readiness-r2-20261009T154612Z/parent-dispatch`, in
`retry-deadline-control-summary.json` and `retry-deadline-parent-audit.json`.

Reviewer administrative read/validator errors and their corrections remain explicit in
original reports. Parent's combined oversized read was recovered with complete separate
reads. A copied sealing template initially referenced a prior task filename; it stopped
before chmod, and the original script/qualification are retained. The corrected audit binds
the actual original assignment. An unexecuted landing-script generator then failed parsing
nested quotes before writing anything; it receives no proof credit. No runtime original
or reviewer report/map is rewritten, and no retrospective command receipt is invented.

The 647,441-entry whole shared-tree audit has zero file/link/mode changes and one qualified
`.git` directory mtime change; clean HEAD is unchanged. After-audit SHA-256:
`c7362d3f670f10a6598a491f8f24b85b6cdfee973131ab3b28bfd08956e5c73c`.
Explicit freeze release: `2026-10-09T18:37:30.779581+00:00`, before main-source correction.

## Required remaining work

Fresh complete cumulative reviews must assess the correction and all prior dispatch changes,
seventeen permanent cases and relevant continuations/documents. Full actor roots must still
integrate with shipping host departure; the broader prototype's original 38 CLI failures
remain unaccepted. MCP startup/custom-provider descendants, final receipt health, parked
clocks, primary/input/host ACK and CLI teardown, Step 8 and final Step 12 remain required.
All six W7 items stay OPEN (41/51); draft PR #90 is unmerged. No paid call, credential,
maintainer decision or ADR approval is pending; no W7 work is deferred by this correction.
