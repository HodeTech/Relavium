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
