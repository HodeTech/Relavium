# Review: W7 invocation-local producer Sonar dispositions

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`provider_invocation_sonar_triage`, GPT-6.1 Sol, high),
  independent runtime reviewers and Parent's individual source/receipt/readback audit.
- Subject: seven new labels at PR #90 source commit `da10cd1258de0761cff3f7010360cdc46b76f07d`.
- Outcome: six individual false positives are applied and read back; one genuine weak-test
  finding is corrected in source. No global suppression or blanket disposition occurs.

| Exact key | Rule / source | Individual assessment |
| --- | --- | --- |
| `AaEfC-puchGL3MC0n_7m` | S4822 / CLI `egress-work.ts:69` | Synchronous factory-entry catch; captured native Promise observer handles both settlements and returns exact raw identity. Awaiting changes the contract. |
| `AaEfC9lHchGL3MC0n_7g` | S4822 / Core `agent-runner.ts:1337` | Inner synchronous origin marker; the outer raw operation is awaited/raced separately. Awaiting would misclassify asynchronous media rejection as entry failure. |
| `AaEfC95mchGL3MC0n_7i` | S4822 / LLM `invocation-work.ts:91` | Registers before producer entry, observes both native settlements separately, preserves raw identity; observation failure keeps work owed. |
| `AaEfC95mchGL3MC0n_7j` | S7059 / LLM `invocation-work.ts:152` | Initialized lifetime is synchronously transferred before iterator exposure; the constructor does not assume asynchronous readiness. |
| `AaEfC95mchGL3MC0n_7k` | S4822 / LLM `invocation-work.ts:177` | Synchronous return-entry cleanup guard; separately retained actual return cannot replace or delay the original read fault. |
| `AaEfC95mchGL3MC0n_7l` | S4822 / LLM `invocation-work.ts:205` | Synchronous iterator factory-entry catch; native observer handles asynchronous settlement, preserving exact raw Promise identity. |
| `AaEfC92VchGL3MC0n_7h` | S2699 / LLM `invocation-work.test.ts:110` | Genuine weak test: already-settled Promise, no assertion. Corrected to prove pending retention, exact identity and positive native settlement. |

Parent reads all seven implementations and their consumers, audits all 1,425 triage artifacts,
and confirms source hashes against the frozen commit. Static triage does not by itself prove
runtime behavior. The [first-round runtime controls](2026-10-09T05-43-00-w7-provider-invocation-round-1-review.md)
and separately rebuilt test-removal controls support the actual contracts. The newly confirmed
method-receiver defect is corrected independently; an entry-marker false positive does not
certify the rest of its containing file.

Each authenticated UI action changes only its named issue and records a specific rationale.
Analyser-sharing remains unchecked. Four lost punctuation separators in comment line numbers
are corrected and all final ASCII ranges are read back. An address-entry typo briefly opens
a public search page before correction. No scanner rule, source suppression, access grant,
branch requirement or provider setting changes.

The final public PR-scoped API readback returns `RESOLVED` / `FALSE-POSITIVE` for precisely
those six source labels, and keeps S2699 `OPEN` pending analysis of the code correction. Its
SHA-256 is `c3874e08f69442102ea617b3a7d9ab13866657a6de99510b56eb5035afc10474`.
The exact `da10cd12` pull-analysis receipt and gate API return `OK`; new reliability/security/
maintainability ratings are 1, duplication is 0.2% and reviewed hotspots 100%. The coverage
condition has no actual value; no percentage is inferred. Required PR/push tests and coverage,
Node 22, Windows, peers and CodeRabbit pass at that head; Sourcery is skipped. The gate receipt
SHA-256 is `cf33bb069fa3fba10db0f97c8b27b331450082b2ee50fa81d12e6bbfba7972a8`.
Future source needs its own analysis.

The remaining 202 code-smell labels include the one corrected weak test and 201 older labels.
One hundred older source-quality candidates remain genuine maintainability work for final
validation; they are not 100 reproduced runtime failures. The other qualified proposals still
need individual audit and receive no blanket false-positive action. Sonar green is neither
provider-increment acceptance nor Step 8/12, whole W7 or merge approval. No paid provider call
or credential access supplies these dispositions.
