# Review: W7 systematic group 6, round 1 — tooling and contract corrections

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_group6_contracts_r1`, `/root/w7_group6_runtime_r1`; Parent `/root`
- **Subject**: `c6c55b3b..bbe01091`, twelve paths / 21 textual hunks
- **Outcome**: Changes requested; verified narrow corrections implemented, fresh round 2 required

## Findings and corrections

Both independent reviewers use gpt-6.1-sol at xhigh effort and cover all twelve paths / 21 hunks.

1. **Medium, introduced documentation discrepancy:** the CLI reference incorrectly promises that every rejected gate avoids MCP startup. Production human rejection retains workflow execution and MCP consent. Independent real-SQLite caller controls verify consent/start/close once on approval and refusal before startup or decision writing on declined consent. The canonical paragraph now limits the exemption to `budget abort`; human-gate execution is unchanged.
2. **Pre-existing tooling failure:** the overflow smoke helper creates a rejecting close promise before polling, leaving native spawn errors temporarily unobserved. A real ENOENT spawn reproduces one unhandled rejection. The correction attaches error observation immediately, records the error and throws it after a non-rejecting native close join.
3. **Pre-existing tooling failure:** early assertion or filesystem failure kills a child without waiting for its close. Native controls observe the function settling while its child remains alive. The correction puts stream setup, stdin writing and timer creation inside the protected block, then kills and joins close in `finally`. Original failures remain primary. Runtime rates these tooling findings Medium; the static lane rates them High. Neither lane attributes them to provider capture product code or to the new finite-poll edit.

The demonstrated correction also handles an injected synchronous stream-setup failure. That robustness control uses native ignored stdio; it does not establish reachability under the committed pipe options. A separate escaped-key local removes nested template formatting while preserving the synthetic duplicate-secret bytes.

## Independent evidence

Runtime passes five package builds, 128 changed-boundary tests, four native budget/SIGINT/abort controls, three human-consent controls, 83 hostile ownership tests, explicit strict/checkJs inclusion of the signal fixture, and the actual offline overflow and replay smokes. Twelve independent generated-loader cases are byte-identical and parse with native Node. Five actual producer origins yield twenty captures, ninety exact durable-handoff line comparisons and twenty frozen initial-line comparisons. Two deliberately incorrect pre-parser streaming filters fail their corruption controls; exact restoration passes.

Four native overflow counterfactual controls discriminate spawn, readiness, filesystem and synchronous setup failures. The corrected helper closes its child before settlement with zero unhandled rejections and preserves each primary error category. All causal edits are restored to the exact committed source before sealing. These are independent Own results, not a new full Root CI run.

Static independently assesses every one of the 180 historical `ab8c5138` Sonar keys and the two reported current additions. Parent authenticates all 57 analyzed source files against actual Git, all 180 key/source/context rows, the complete deduplicated rationale and proof-limit mappings, and the actual current 170-key delta. Complexity, sequencing and readability advice is distinguished from a demonstrated product defect. Three security-labelled sites have inspected trusted local harness callers; arbitrary callers and malicious same-UID manipulation remain outside that conclusion. No remote disposition or suppression is applied. The current gate remains red only on its security rating.

## Complete Parent audit and limits

Both full reports are read before Root changes: static **15,964 bytes**, SHA-256 `8b56e78fb77fdf0cc7d8b3f86e28784f09c2bd68355a82b67ca62a8e9738d293`; runtime **22,603 bytes**, SHA-256 `75829748848f93cc10a5148bbe5ace8271309adf588272fdbc76405e542717c5`.

Parent audits every static **3,241 entries / 2,835 regular files / 406 directories / zero links** and runtime **38,601 entries / 33,344 regular files / 4,568 directories / 689 links**, both complete regular unions and all external self-bindings. Every available nineteen numeric field is checked; atime is observation-only, with no actual difference or allocation drift. Both copies preserve 1,175 exact source pins and 1,570 physical Git objects. Runtime includes two distinct native-copy identities and 461 declared manifest roots / 710 concrete issuer edges / 186 unresolved declared optional/peer edges. Owns are permanently retired and never executed, edited, resealed or cleaned by Parent.

Parent verifies 158 static command-metadata rows, 5,316 inert read spans, actual old/new blobs and every hunk. One metadata row contains a JavaScript callback instead of the executed Python body, so only 157 bodies are authenticated as Python. First four commands lack the later durable journal. Read-span hashes do not establish that every entire source document was displayed. Oversized displays, failed helper/audit preparations, corrected bounded rereads and exact nanosecond bindings remain recorded.

Runtime records 35 invocations, 135 read-ledger rows and 120 intercepted source workers with before-source proof ordering. Parent authenticates 132 read rows, including five preserved versions; three intermediate helper versions were not preserved and cannot be byte-attested. Of 233 fresh proof instances, 227 include the later outside-Own read probe; six earlier instances contain the eleven Original-read/write, network and credential checks. Instrumentation is not OS isolation, and the source-hook denominator excludes some frozen/tmp/native-loader activity. The runtime report says five streaming types once; actual unchanged source has four, independently verified at both readers. These limits are retained rather than normalised into blanket assurance.

## Root verification and continuation

After both complete physical and semantic audits, Root applies the two-file correction. The actual offline overflow smoke, tools lint and configured tools typecheck pass. The typecheck programme does not include every MJS helper. The earlier leaf candidate's forced Root CI remains separately recorded as 373 files / 8,397 passing tests / twelve existing skips; this narrow correction does not claim a repeated full CI run.

Fresh independent round 2 must challenge the committed correction and its unchanged callers. Group 6 is not accepted by this record. ADR-0102 and ADR-0103 remain Proposed, live provider evidence still gates Steps 7–8, and Step 12/final W7/PR acceptance remain open.
