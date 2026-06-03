# Relavium skills

Recurring agent procedures for the Relavium repo. Each skill is a directory with a
`SKILL.md` (YAML frontmatter + a step-by-step procedure). When the maintainer names
a recurring task, read the matching `SKILL.md` **in full** and check its done-criteria
before finishing. Skills cite the [standards](../../docs/standards/) and
[decisions](../../docs/decisions/) — they never duplicate them.

See [CLAUDE.md](../../CLAUDE.md) for the non-negotiable rules every skill assumes.

## Process & governance

| Skill | Use it to |
|-------|-----------|
| [write-adr](write-adr/SKILL.md) | Record a non-trivial decision as a new condensed-MADR ADR in `docs/decisions/`. |
| [supersede-adr](supersede-adr/SKILL.md) | Reverse a decision: write a new ADR and mark the old one `Superseded` (never rewrite it). |
| [start-task](start-task/SKILL.md) | Scope a roadmap workstream into in/out scope, affected packages, deps, and acceptance criteria — then stop at the plan. |
| [standards-check](standards-check/SKILL.md) | Fast grep-based conformance gate against the non-negotiables before deeper review. |
| [commit-and-pr](commit-and-pr/SKILL.md) | Format Conventional Commits (per-package scope, ADR/task ref, `Co-Authored-By`) and PR descriptions. |
| [write-architecture-doc](write-architecture-doc/SKILL.md) | Add/update a Mermaid-first `docs/architecture/` doc that cites the reference specs. |

## Implementation & review

| Skill | Use it to |
|-------|-----------|
| [implement-task](implement-task/SKILL.md) | **Primary entry point.** End-to-end discipline for any non-trivial change: scope → inspect → plan → implement → test → docs → commit → review prompt. |
| [code-review](code-review/SKILL.md) | Review a diff/PR against the standards + ADRs; report severity-sorted `file:line` findings. May delegate to the reviewer agent. |
| [security-review](security-review/SKILL.md) | Security pass: key handling, SSRF, the JS sandbox, prompt injection, dependency provenance. |

## Scaffolding (Relavium-specific)

| Skill | Use it to |
|-------|-----------|
| [add-package](add-package/SKILL.md) | Scaffold a new `packages/*` or `apps/*` workspace with tsconfig/eslint/vitest, correct boundaries, and Turborepo wiring. |
| [add-llm-adapter](add-llm-adapter/SKILL.md) | Add a provider adapter behind the `@relavium/llm` `LLMProvider` seam (normalization + pricing + conformance test). |

## Discovery

| Skill | Use it to |
|-------|-----------|
| [grill-me](grill-me/SKILL.md) | Stress-test a plan or design — relentless one-question-at-a-time interview until shared understanding. |

## Reviewer subagent

The project-aware reviewer lives at
[../agents/relavium-reviewer.md](../agents/relavium-reviewer.md) — invoke it (or the
[code-review](code-review/SKILL.md) skill) to audit a diff against the Relavium
non-negotiables.
