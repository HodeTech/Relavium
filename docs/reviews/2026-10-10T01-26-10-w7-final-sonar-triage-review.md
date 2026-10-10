# W7 current Sonar triage

- **Type**: Code + Performance
- **Date**: 2026-10-10
- **Reviewer(s)**: `/root/w7_final_sonar_triage` (gpt-6.1-sol, high); Parent `/root`
- **Subject**: 214 unresolved PR #90 labels at historical `777c9ddd`, mapped to `29432176`
- **Outcome**: Individually justified narrow corrections/dispositions; final-head remote analysis still required

The independent reviewer maps every issue's exact source line; all flagged lines are textually
unchanged at the reviewed head, although enclosing code can differ. All 16 reliability-impacting
labels receive individual source/caller/test analysis; the remaining 198 receive grouped
rule/context triage, not 198 full-function correctness proofs. Parent reads the complete report
and its evidence/limits. No additional shipping correctness defect is established by these labels.

| Labels | Disposition and concrete action |
| --- | --- |
| Nine S4822 | Synchronous entry catches deliberately return/retain exact raw Promises. Asynchronous outcomes already have separate two-arm observers, catches or later awaits. Add only issue-line `NOSONAR` comments explaining each current boundary; retain all runtime control flow. |
| One S7059 | RequestLane starts synchronously inside retained work before exposure; send joins startup and partial entry owns cleanup. Document this exact accepted design at the flagged statement. Do not defer startup merely to change analyzer syntax. |
| Four S7503 | Keep the async Promise boundary and synchronous guard/client construction, use explicit `return await` on the same delegated operation. No scheduling equivalence is claimed. |
| One S7773 | Use `Number.NaN`, preserving the exact invalid numeric sentinel and existing capture admission tests. |
| One S8786 | A smoke-only ps regex has overlapping whitespace matching. Require nonwhitespace at the command group's start (`\S.*`); valid PID captures are unchanged. Synthetic malformed rows reproduce quadratic rejection in the old form. No shipping remote exploit or actual malformed ps output is established. |

The nine S4822 sites are `deadlines.ts` (race entry), `work-scope.ts` (factory retention), and
`sdk-work.ts` (lane close, handler entry, native start, invocation frame, base send, control send,
connection close). Each source comment explains the actual asynchronous observer and why an
inline await would change ownership/failure precedence. The S7059 comment addresses only the
retained lane start. These are ten exact-line dispositions, not file/rule/global exclusions.
The existing Sonar UI session is unavailable in this runtime, so no remote issue status or
analyzer configuration is changed. Future source edits still require fresh review and analysis.

Other reports include valid readability/complexity preferences, deliberate ordered awaits,
real assertion helpers, hostile-value-safe matchers and required JSON wire normalization.
TypeScript 5.9.3 independently resolves S6571's projection intersection as non-never. Replacing
wire normalization with structuredClone, parallelizing ordered work or adding arbitrary awaits
would change accepted behavior. No verified product defect is deferred on these grounds.

Independent executions pass 200 focused SDK/ownership/capture cases plus one actual CLI/SQLite
refusal case. Synthetic regex and compiler probes are separate qualified evidence. Root CI,
coverage and a fresh remote Sonar analysis must verify the final source; old gate/readback
results do not establish the new gate. This record does not accept Step 8, Step 12 or W7.
