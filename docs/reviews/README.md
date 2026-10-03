# Reviews

This folder holds **review records** — the written output of a business, code, security,
or performance review of a specific change, milestone, or release.

A review record is a *point-in-time* artifact: it captures what was reviewed, by whom, on
what date, and what was found. Unlike a [standard](../standards/README.md) (a binding
rule) or an [ADR](../decisions/README.md) (a settled decision), a review is a dated
observation that is never rewritten — if a follow-up review is needed, a new record is
added.

## Records

- [2026-10-02 — W7 documentation and implementation preflight](2026-10-02T01-14-15-w7-preflight-review.md):
  existing contract review, supplemental Proposed decisions and execution-plan approval gate.
- [2026-10-02 — W7 step 1, round 1](2026-10-02T03-04-05-w7-step-1-round-1-review.md):
  capture secrecy and destination ownership, probe ownership/concurrency and CI parity; seven verified findings corrected.
- [2026-10-02 — W7 step 1, round 2](2026-10-02T03-22-32-w7-step-1-round-2-review.md):
  one verified concurrent cleanup race corrected and optional whole-artifact assurance adopted; fresh corrective review pending.

- [2026-10-02 — W7 step 1, round 3](2026-10-02T03-35-41-w7-step-1-round-3-review.md):
  one verified passing/starting guard race corrected by retaining shared parents; fresh review pending.

- [2026-10-02 — W7 step 1, round 4](2026-10-02T03-43-31-w7-step-1-round-4-review.md):
  collection and probe ownership clear; one verified capture pathname-cleanup race corrected.

- [2026-10-02 — W7 step 1, round 5](2026-10-02T03-50-35-w7-step-1-round-5-review.md):
  clean corrective review; final wording qualifications adopted and step 1 closed.

- [2026-10-02 — W7 step 2, round 1](2026-10-02T04-29-12-w7-step-2-round-1-review.md):
  nested-transaction key reuse and unsafe session media metadata verified and corrected; fresh round 2 pending.

- [2026-10-02 — W7 step 2, round 2](2026-10-02T04-41-54-w7-step-2-round-2-review.md):
  both corrections and complete step cleared; strict persistence and durable key allocation closed.

- [2026-10-02 — W7 step 3, round 1](2026-10-02T05-34-44-w7-step-3-round-1-review.md):
  deep JSON metadata interrupted correction and policy-denial outcome lost its classification;
  both verified and corrected, fresh round 2 pending.

- [2026-10-02 — W7 step 3, round 2](2026-10-02T05-48-54-w7-step-3-round-2-review.md):
  cached command identity bypassed the durability latch and filesystem denials lost their tool name;
  both verified and corrected, fresh corrective review pending.

- [2026-10-02 — W7 step 3, round 3](2026-10-02T06-10-38-w7-step-3-round-3-review.md):
  unjournaled tools bypassed the live durability guard and the export introduction was stale;
  both independently verified and corrected, fresh corrective review pending.

- [2026-10-02 — W7 step 3, round 4](2026-10-02T06-34-39-w7-step-3-round-4-review.md):
  nontrailing pre-W7 empty-final user text lost from resumed context and exported prompts;
  compatibility and boundary seeds corrected, fresh corrective review pending.

- [2026-10-02 — W7 step 3, round 5](2026-10-02T06-48-45-w7-step-3-round-5-review.md):
  complete step and earlier corrections cleared; structural persistence and host identity wiring closed.

- [2026-10-02 — W7 step 4, round 1](2026-10-02T08-05-02-w7-step-4-round-1-review.md):
  pre-mount Ink resume/reseat deletion independently reproduced and corrected; fresh acceptance pending.

- [2026-10-02 — W7 step 4, round 2](2026-10-02T08-48-12-w7-step-4-round-2-review.md):
  usable Ink setup and displayed-disclosure ordering independently reproduced and corrected; fresh acceptance pending.

- [2026-10-02 — W7 step 4, round 3](2026-10-02T09-24-27-w7-step-4-round-3-review.md):
  incomplete-turn attribution and unwritable Ink output independently reproduced and corrected; fresh acceptance pending.

- [2026-10-02 — W7 step 4, round 4](2026-10-02T10-04-04-w7-step-4-round-4-review.md):
  native headless delivery and inline Ctrl-Z disclosure independently reproduced and corrected; fresh acceptance pending.

- [2026-10-02 — W7 step 4, round 5](2026-10-02T10-36-22-w7-step-4-round-5-review.md):
  native backpressure interrupt and canceled Home teardown ownership independently reproduced and corrected; fresh acceptance pending.

- [2026-10-02 — W7 step 4, round 6](2026-10-02T10-57-58-w7-step-4-round-6-review.md):
  complete step and five correction rounds accepted; inherited native stdio exit qualification verified; step 4 closed.

- [2026-10-02 — W7 step 5, round 1](2026-10-02T12-00-17-w7-step-5-round-1-review.md):
  memory implementation accepted with independent lifecycle/SQLite/CLI controls; adjacent context/archive wording clarified; fresh round 2 pending.

- [2026-10-02 — W7 step 5, round 2](2026-10-02T12-21-33-w7-step-5-round-2-review.md):
  complete memory implementation and prior clarification accepted; independent state/CLI/SQLite and exact-source controls reproduced; step 5 closed.

- [2026-10-02 — W7 ADR-0101 mechanism revision, round 1](2026-10-02T15-09-58-w7-adr-0101-revision-round-1-review.md):
  maintainer transport/pricing and consistency findings resolved; construction-to-attempt cap-plan handoff corrected; fresh draft round 2 pending.

- [2026-10-02 — W7 ADR-0101 mechanism revision, round 2](2026-10-02T15-18-01-w7-adr-0101-revision-round-2-review.md):
  complete revised proposal and handoff correction accepted by fresh reviewers; maintainer approval remains required before implementation.

- [2026-10-02 — W7 step 6, round 1](2026-10-02T17-16-04-w7-step-6-round-1-review.md):
  five runtime protections, canonical hook/budget contracts and missing forwarding/wire coverage corrected;
  24 causal negative controls and full restored CI pass; fresh round 2 pending.

- [2026-10-02 — W7 step 6, round 2](2026-10-02T17-54-28-w7-step-6-round-2-review.md):
  primitive BigInt cap mutation, Gemini discarded-control refusal and omitted output-schema input
  independently reproduced and corrected; full CI/coverage and four causal negatives pass; fresh round 3 pending.

- [2026-10-02 — W7 step 6, round 3](2026-10-02T18-23-45-w7-step-6-round-3-review.md):
  inherited serializers on frozen JSON caps independently reproduced and isolated; full CI/coverage
  and causal negatives pass, intermittent growth measurement repaired without weakening its threshold; fresh round 4 pending.

- [2026-10-02 — W7 step 6, round 4](2026-10-02T19-42-38-w7-step-6-round-4-review.md):
  throwing cap accessors exposed private errors before safe normalization; fixed helper inspection
  guards, full CI/coverage and five causal negatives pass; fresh round 5 pending.

- [2026-10-02 — W7 step 6, round 5](2026-10-02T20-36-23-w7-step-6-round-5-review.md):
  pre-existing reentrant notice overbooking independently reproduced and corrected; known CR-82
  usage limitation qualified; full restored CI and coverage pass, fresh round 6 pending.

- [2026-10-02 — W7 step 6, round 6](2026-10-02T21-16-26-w7-step-6-round-6-review.md):
  budgetless cancellation during a shared ledger wait still resolved credentials; parent-verified
  correction and six permanent B1 controls pass causal negatives and full CI/coverage; fresh round 7 pending.

- [2026-10-02 — W7 step 6, round 7](2026-10-02T22-01-46-w7-step-6-round-7-review.md):
  inherited realized/conservative tail freshness independently reproduced and corrected; 36 permanent
  controls, causal negatives and full CI/coverage pass; fresh round 8 pending.

- [2026-10-02 — W7 step 6, round 8](2026-10-02T22-44-01-w7-step-6-round-8-review.md):
  clean independent financial/contract acceptance and parent replays; Step 6 closed.

- [2026-10-02 — W7 step 9, foundation preflight](2026-10-02T23-40-16-w7-step-9-foundation-preflight-review.md):
  two verified candidate corrections, complete quote/debit foundation and parent causal controls; committed-step acceptance pending.

- [2026-10-03 — W7 step 9, round 1](2026-10-03T00-25-08-w7-step-9-round-1-review.md):
  unsafe actual text settlement and post-provider generative refunds reproduced and corrected; fresh round 2 pending.

- [2026-10-03 — W7 step 9, round 2](2026-10-03T01-10-45-w7-step-9-round-2-review.md):
  async pricing gaps/orphaned admissions and cancellation teardown reproduced and corrected; fresh round 3 pending.

- [2026-10-03 — W7 step 9, round 3](2026-10-03T01-57-14-w7-step-9-round-3-review.md):
  park/poll host admission loss and stale reentrant terminal total corrected; fresh round 4 pending.

- [2026-10-03 — W7 step 9, round 4](2026-10-03T02-40-53-w7-step-9-round-4-review.md):
  complete foundation accepted after independent native-loader controls, verified sealed evidence
  and parent replay; harness isolation exception recorded; Step 9 closed.

- [2026-10-03 — W7 step 10, round 1](2026-10-03T08-35-49-w7-step-10-round-1-review.md):
  passive-resume lease expiry and unbound predecessor CJS/peer/optional edges reproduced and corrected;
  causal controls, full CI and coverage pass; fresh round 2 pending.

- [2026-10-03 — W7 step 10, round 2](2026-10-03T11-47-48-w7-step-10-round-2-review.md):
  terminal conservative-money ordering, historical input decisions, companion amount symmetry
  and pinned runtime edges independently reproduced and corrected; full CI/coverage pass, fresh round 3 pending.

- [2026-10-03 — W7 step 10, round 3](2026-10-03T12-39-00-w7-step-10-round-3-review.md):
  authority-witnessed optional-amount duplicates corrected with strict money controls; stale comments and terminal cleanup assertion corrected; fresh round 4 pending.

## File naming convention

Review records use a **full ISO-8601 timestamp slug**, so they sort chronologically and
never collide:

```text
YYYY-MM-DDTHH-MM-SS-<slug>-review.md
```

- The timestamp uses `-` instead of `:` in the time part so the name is filesystem-safe
  across platforms.
- `<slug>` is a short kebab-case description of what was reviewed
  (e.g. `engine-checkpoint`, `phase-1-release`, `keychain-secrets`).

Illustrative filenames:

```text
2026-06-10T14-30-00-engine-checkpoint-review.md
2026-07-01T09-00-00-phase-1-release-review.md
```

This mirrors the dated-artifact convention used elsewhere in the tree (see
[documentation-style.md](../standards/documentation-style.md) §3) and matches the house
style across the author's other repositories.

## What goes in a review record

Each record starts with a single H1 and a bold metadata block, then the findings:

```markdown
# Review: <what was reviewed>

- **Type**: Business | Code | Security | Performance
- **Date**: YYYY-MM-DD
- **Reviewer(s)**: <@handle or stable agent identity>
- **Subject**: <PR / milestone / release / file under review>
- **Outcome**: Approved | Changes requested | Blocked

## Summary
## Findings
## Follow-ups
```

Keep findings concrete and actionable. Link to the code, ADR, or runbook each finding
touches rather than restating it.

An automated reviewer uses its stable task identity rather than an invented account handle.
Record its model, effort and review scope in the coverage section where available.

## Conventions

- **Append-only.** A review record is a snapshot; never rewrite an old one. A new review
  is a new file.
- **One review per file**, named with the ISO timestamp it was conducted.
- Records are in English and follow
  [documentation-style.md](../standards/documentation-style.md) like every other file.
