# Reviews

This folder holds **review records** — the written output of a business, code, security,
or performance review of a specific change, milestone, or release. It is intentionally
**empty until the first review is written**: this index exists to define the convention
so that the first record is born compliant.

A review record is a *point-in-time* artifact: it captures what was reviewed, by whom, on
what date, and what was found. Unlike a [standard](../standards/README.md) (a binding
rule) or an [ADR](../decisions/README.md) (a settled decision), a review is a dated
observation that is never rewritten — if a follow-up review is needed, a new record is
added.

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

Examples (illustrative — none exist yet):

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
- **Reviewer(s)**: @handle
- **Subject**: <PR / milestone / release / file under review>
- **Outcome**: Approved | Changes requested | Blocked

## Summary
## Findings
## Follow-ups
```

Keep findings concrete and actionable. Link to the code, ADR, or runbook each finding
touches rather than restating it.

## Conventions

- **Append-only.** A review record is a snapshot; never rewrite an old one. A new review
  is a new file.
- **One review per file**, named with the ISO timestamp it was conducted.
- Records are in English and follow
  [documentation-style.md](../standards/documentation-style.md) like every other file.
