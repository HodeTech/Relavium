# Review: W7 documentation and implementation preflight

- **Type**: Code
- **Date**: 2026-10-02
- **Reviewer(s)**: Codex `/root`, `/root/w7_history_docs_review`, `/root/w7_request_docs_review`, `/root/w7_budget_docs_review`; maintainer; independent supplemental-draft reviewers identified under Coverage
- **Subject**: Phase 2.6.5 `W7`, baseline `1b3f8d70`, branch `development`
- **Outcome**: Changes requested — supplemental ADRs and execution plan await maintainer approval; no W7 implementation is claimed

## Summary

The existing four Accepted ADRs and their 2026-09-18 amendments provide the main contract for the six W7 items
and the `budget resume` pull-in. Three decision gaps remain: manual compaction when no authoritative window
exists, a budget refusal after a turn has already completed, and older replay readers erasing a bounded budget
authorization's optional fields. Proposed ADR-0099 and ADR-0100 make these reviewable before code.

The review also found still-live documentation claims already withdrawn by Accepted ADRs, an additional raw
session-metadata ingress, important implementation acceptance cases, and a failing root coverage collection.
These are implementation/correction work, not new product decisions. No extra W7 item or deferral is created.

## Coverage

- README and CLAUDE rules; relevant glossary/current roadmap, phase discipline, W7 scope and per-document checklist.
- ADRs 0001–0033, 0034–0070 and 0071–0098 split among independent reviewers in numerical order; the request reviewer
  reported truncated early batches and reread its range in bounded chunks before certifying completion.
- Full ADR-0095–0098, their predecessor amendments, session/event/YAML/seam/DB/CLI contracts and relevant source.
- Implement-task, code-review, security-review and commit-and-PR procedures; TypeScript, errors, testing,
  architecture, documentation, security and commit standards.
- History/privacy: `/root/w7_history_docs_review`; request/compaction: `/root/w7_request_docs_review`
  (`gpt-6-astra`, high); budget/recovery: `/root/w7_budget_docs_review` (`gpt-6.1-sol`, xhigh).
  Independent supplemental-draft review: Claude Sonnet (high), Claude Opus (max) and
  `/root/w7_companion_protocol_review` (`gpt-6-astra`, xhigh). Draft-review results are recorded below.
  Final corrected-draft checks: `/root/w7_final_draft_contracts` (`gpt-6-astra`, xhigh) and
  `/root/w7_final_draft_docs` (`gpt-6.1-sol`, xhigh).
- Real mapper/store/parser/checkpoint probes where identified below. No provider call was made and no user key
  was read for fixture capture. The fixtures remain an explicit implementation prerequisite.

This review covers contract alignment and the cited paths, not a whole-repository runtime audit. The implementation
and its fixes still require both independent review rounds per step.

## Findings

### P1 — an older binary can replay new budget semantics as the old contract

[ADR-0097](../decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md)'s 2026-09-18 note puts allowance
and quote provenance on optional fields of existing pause/approval events. The known-event parser in
[run-event.ts](../../packages/shared/src/run-event.ts) strips them; the strict replay read in
[run-history-store.ts](../../packages/db/src/run-history-store.ts) refuses only skipped unknown rows.
[checkpoint.ts](../../packages/core/src/engine/checkpoint.ts)'s current gate fold then completes the agent with
an invented `{ decision: 'approved' }` output. The older live engine still removes its pre-egress hook for an
approved dispatch. A real parser/fold probe returned zero unknown rows and the invented completed agent.

The practical old CLI path is a resume through a sibling human gate after a durable budget decision; it does
not rely on an older `budget resume` command that never existed. [Proposed ADR-0100](../decisions/0100-budget-authorization-is-durable-state-with-a-replay-barrier.md)
adds the specific state-bearing discriminator/durability ordering that makes ADR-0075's existing replay refusal
apply, including a W7 binary's decision of a legacy gate. This mechanism needs maintainer approval.

### P1 — unknown-window manual compaction has contradictory promises

[ADR-0062](../decisions/0062-context-compaction-and-cli-history-commands.md) §5 allows manual compaction for
unknown/custom models, while [ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md) §3 invariant 4
promises fit even for that operation. Its custom-endpoint amendment skips only automatic paths. A missing or
unauthoritative window cannot support the unconditional guarantee. [Proposed ADR-0099](../decisions/0099-compaction-has-an-idle-budget-outcome-and-an-unknown-window-policy.md)
preserves the manual operation under an explicitly disclosed soft input budget and qualifies the guarantee.
The alternative is refusing manual compaction; the draft's choice and fixed soft budget need approval.

### P2 — an after-turn budget refusal cannot fail a turn that already completed

ADR-0062's 2026-09-18 note says a summariser budget refusal ends the turn `budget_exceeded` and does not trim.
[agent-session.ts](../../packages/core/src/engine/agent-session.ts) emits a successful `session:turn_completed`
before the after-turn compaction call. Manual compaction has no turn. Proposed ADR-0099 preserves the completed
terminal, returns/displays a separate typed budget outcome, forbids budget fallback trim, and closes an open
compaction moment without creating another turn terminal.

### P2 — blanket privacy and recovery claims still contradict Accepted decisions

The DB and keychain references added qualifiers in September but retained the literal "no credentials" premise;
the session architecture repeats it. A real committed **run** effect store probe retains
`{ stdout: 'Bearer TOOL_OUTPUT_SECRET' }` in `result_json`, deliberately unchanged by W7. The preflight corrected
[database-schema.md](../reference/shared-core/database-schema.md),
[keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md) and
[agent-sessions.md](../architecture/agent-sessions.md) to describe key custody separately from sensitive retained
content, under ADR-0050's existing correction. The maintainer's review found the same false premise still in
[tech-stack.md](../tech-stack.md), [local-first-and-security.md](../architecture/local-first-and-security.md),
[start-a-chat-session.md](../tutorials/cli/start-a-chat-session.md) and
[phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md). The preflight corrects these
living claims too, and adds dated correction notes to ADR-0005 and ADR-0008 without rewriting their history.

[execution-model.md](../architecture/execution-model.md) also still promised that `runId + nodeId + retryCount`
prevented double effects and that realized cost persisted only at run end. The preflight replaced those claims
with links to ADR-0080's tiered effect contract and ADR-0076/0077's per-attempt durability. This architecture page
was added to the W7 checklist. No new decision is needed for these corrections.

### P1 implementation coverage — session metadata has another content ingress

[session-store.ts](../../packages/db/src/session-store.ts)'s `SessionMessageMeta.content` reaches the
denormalized `content` column independently of canonical parts. A real mapper probe wrote a bearer-shaped raw
result into a `tool` row with empty `content_parts`. CR-71's whole-store refusal must cover this field as well as
`toolCalls`, `name` and `toolCallId`; canonical structural validation alone is insufficient. The accepted
ADR-0095 invariant already authorises this fix.

### Required prerequisite — classification needs maintainer-captured fixtures

ADR-0096 requires live captures before the classification commit for Anthropic, OpenAI, DeepSeek and Gemini,
with capture date and model id. Existing hand-authored fixtures do not meet it. Step 1 prepares a bounded capture
tool; the maintainer runs it with their own keys. Gemini replay must retain the recorded body/message. No key is
requested through this chat and no invented fixture closes this acceptance.

### Required gate — root coverage currently executes private prototypes

`pnpm run ci` exited **0**. `pnpm coverage` exited **1**, collecting two ignored private CR-94 prototype suites
whose relative imports no longer resolve. Its real suites reported **284 passed**, **6,263 tests passed** and
**11 skipped**; that is not a passing coverage run. Root and package tests share the cwd-tolerant config, so a
root-only include replacement would silently disable package tests. Step 1 adds a direct collection guard and
keeps the private files untouched; the official root gate must then be rerun and its exit code checked.

## Acceptance added to the plan

- Four-pass exhaustion by many individually fitting messages; no silent dropped tail or partial summary.
- Smaller/unknown summariser fallback window, unavailable/throwing estimator, shared conservative input estimate,
  and user/catalog pricing overlay parity on input admission and realized accounting.
- Pass-1 versus later-pass budget refusal at all four compaction entry points.
- Full historical completed-turn/effect keys seed the legacy high-water mark before any cleanup; persister
  updates do not overwrite a separately allocated mark.
- All metadata fields, empty-final turns, persisted engine IDs and MCP-export grants cross store/export/resume.
- All historical rows inform completion joins; failed disclosure reads prevent sweeping; Home and one-shot
  teardown obey the same retention rule; raw main/WAL bytes are scanned after successful checkpoint.
- Budget resume inherits secret-stdin admission and prepares MCP discovery/consent/grants/teardown before the
  frozen snapshot's identity check. Existing `gate` lacks full MCP setup and must not be copied as a complete
  template. This is accepted ADR-0083/0084/0094 work, not a new permission policy.
- Approved budget crash recovery still obeys the effect-journal preflight; approval cannot authorise repeating an
  unresolved tier-3 effect. Sibling-human-gate crash scenarios and duplicate/pre-claim refusal cases stay required.

## Supplemental-draft and maintainer review

These are corrections to **unpublished Proposed drafts**, not claims that the corresponding implementation
already exists. The maintainer's review requested changes without a merge blocker and independently verified
the parser, strict replay refusal, invented output, metadata ingress and after-turn budget/trim evidence.

| Verified finding | Draft/preflight action |
|---|---|
| Sonnet and the budget reviewer: generic engine resume acquires a lease before its strict read | ADR-0100 now promises refusal before execution registration/scheduling/dispatch/egress and release of an acquired lease, preserving ADR-0079. Opus's clean statement applied to the CLI preload path only, so it was not accepted as proof of the generic engine order |
| Budget reviewer: authoritative pause-only checkpoint is usable, but interrupted discovery needs its existing derived projection | ADR-0100 requires SQLite and reference-store classification without aggregate pause or early sibling lease surrender; actual checkpoint/engine probe confirmed resume admission from a non-terminal `running` checkpoint with a pending gate |
| Maintainer and Opus: resumed companion lacks a join key | ADR-0100 requires `(runId, nodeId, gateId)` for W7 budget companions, including W7 decisions of legacy gates; missing-key legacy rows use exactly one outstanding gate at their sequence position and its recorded budget identity |
| Codex companion review: corrupt persisted conflicts must not change duplicate API-request policy | ADR-0100 keeps repeated resolved-gate API decisions as no-ops and scopes conflict refusal to durable rows; stale `g1` duplicates cannot affect `g2` or erase real completed output |
| Opus: non-terminal `#emitDurable` absorbs faults and resolves | ADR-0100 explicitly requires acknowledgement/failure/ownership observation, not a bare await; absorbed faults, pre-existing failure, fencing and cancellation are landing tests |
| Opus: predecessor harness needs a genuinely old reader after W7's schema lands | ADR-0100 specifies an isolated frozen actual baseline source closure, manifest and digest, bound to old schemas; current-arm removal or a fabricated unknown event cannot satisfy it |
| Opus: pause-only recovery must preserve any existing absolute gate deadline | ADR-0100 freezes the existing deadline values in the authoritative pause; absent deadlines remain absent |
| Opus: internal after-turn first-pass refusal has no visible carrier | ADR-0099 proposes a standalone `session:compaction_budget_refused` side notice; later-pass refusal closes its existing moment without duplicating the notice |
| Maintainer and Opus: summariser all-fallback bounds exceed the original scope description | ADR-0099's scope and landing note explicitly qualify ADR-0096 §2 invariant 2 for summariser requests; main-turn first-attemptable measurement stays unchanged |
| Opus: soft budget rationale and mixed known/unknown chain were unstated | ADR-0099 identifies 16,384 as a proposed operational choice, explains its relationship to the existing 4,096 summary cap, and retains every known bound alongside the soft budget; it claims no unknown-provider capacity evidence |
| Maintainer: remaining false at-rest premises and review index/metadata inconsistency | All four remaining living claims are corrected, ADR-0005/0008 gain dated notes under ADR-0050's existing correction, README lists the first record and permits stable agent identities, and this record uses the `Code` type |
| Maintainer: new plan spelling and reviewer model preference | Only the new plan prose uses `behaviour`; two fresh Codex rounds retain the implementation/verified-fix/commit cycle, with model/effort chosen by complexity and criticality |
| Final Codex docs review: ADR-0095 repeats the idle budget ambiguity | ADR-0099's scope, context and after-approval landing obligations also qualify ADR-0095's "permission, not funding" note, retaining its funding refusal and no-trim rule |

Draft-review findings were checked against the actual cited paths before changing the proposed contract. The
corrected draft, including the extra notice and state-bearing event, still requires explicit maintainer approval.
The final contract reviewer reported no remaining material finding within its contract/source scope. The final
documentation reviewer confirmed its sole ADR-0095 qualification finding resolved after the correction; no
material finding remains within that review's scope. These read-only verdicts do not establish runtime correctness.
Documentation-style conventions, relative file targets and diff whitespace are checked independently of runtime CI;
Prettier deliberately excludes repository Markdown, so its no-op is not reported as document validation. Root coverage's
failed baseline is not relabelled as passing.

## Follow-ups

1. Obtain maintainer approval of the two Proposed ADRs and the
   [twelve-step execution plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-pre-implementation-review-and-proposed-execution-plan--2026-10-02).
2. Implement every step on `development` with two fresh independent Codex review rounds, verified fixes and commits;
   retain mutation/break-verification evidence instead of equating a green test with a regression proof.
3. Obtain the already-required four live fixture captures before classification; proceed with independent steps
   while capture input is pending, but do not cross that prerequisite without it.
4. Close against the complete canonical checklist, security sitting and per-item register; run `pnpm run ci` and
   `pnpm coverage` to exit 0 before the final PR handoff. No code or W7 close is claimed by this review record.
