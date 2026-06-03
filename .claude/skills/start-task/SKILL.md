---
name: start-task
description: >
  Open a scoped unit of work from a roadmap phase workstream — define in/out scope, affected packages, dependencies, and concrete acceptance criteria, then stop at the plan. USE FOR: turning a phase workstream (e.g. Phase 1 "1.K FallbackChain runner") into an actionable, bounded plan before writing code. DO NOT USE FOR: implementing the work, recording a decision (use ../write-adr/SKILL.md), or committing (use ../commit-and-pr/SKILL.md).
---
# Start a Task

## Purpose
Convert a roadmap phase workstream into a tightly scoped plan an engineer (human or agent) can execute without re-deriving context. Relavium has **no `docs/tasks/` directory and no task-ticket scheme** — a "task" is the workstream id already defined in a phase file (e.g. Phase 1's `1.K`). This skill makes scope, package boundaries, dependencies, and acceptance explicit, then **stops at the plan**. It assumes you have read `CLAUDE.md`, `docs/roadmap/current.md`, and the phase file.

## When to use
- You are about to start a workstream from a `docs/roadmap/phases/phase-N-*.md` file.
- A change will span more than two or three files (CLAUDE.md requires proposing a plan first).
- You need to pin acceptance criteria before touching code so "done" is unambiguous.

## When not to use
- The work is a settled decision to record — use ../write-adr/SKILL.md.
- You are ready to commit finished work — use ../commit-and-pr/SKILL.md.
- The change is a trivial one-file fix that needs no plan.

## Inputs
| Input | Description |
|-------|-------------|
| Phase + workstream id | e.g. `phase-1-engine-and-llm.md` · `1.K`. |
| Phase acceptance | The workstream's own Acceptance line — the seed of your criteria. |
| Build-order position | Where it sits in shared → llm → core → cli → desktop → vscode. |

## Workflow
1. **Locate the workstream.** Read `docs/roadmap/current.md` for what is active, then open the phase file and find the workstream by id. Copy its Tasks + Acceptance as the starting point.
   ```bash
   grep -rn "FallbackChain\|1\.K" /Users/dev/Documents/Projects/Agent-Organizer/docs/roadmap/phases/
   ```
2. **Check dependencies and build order.** Confirm the workstreams it depends on (per the phase's Mermaid graph) are done, and that you are not building a surface before its engine (architectural-principles §1, engine-first: `shared → llm → core → cli → desktop → vscode`).
3. **Define scope explicitly — in and out.** Write a short scope block:
   - **In:** what this task delivers.
   - **Out:** what it deliberately defers, mirroring the phase's "Explicitly out of scope" (e.g. real SQLite persistence, HTTP SSE, surfaces — all later phases).
4. **List affected packages and respect the seams.** Name each `@relavium/*` package / `apps/*` touched and the rule each must honor:
   - `@relavium/core` — **zero platform imports**.
   - `@relavium/llm` — **no vendor SDK type crosses the seam**; provider SDKs only in `packages/llm/src/adapters/*`.
   - Specs (events, YAML, DDL) — cite the `docs/reference/` home; do not invent shapes.
   Flag a cross-package change as likely two commits (commit-style: one scope per commit).
5. **Flag decisions and security.** If the task needs a new runtime dependency or changes a settled decision → it needs an ADR first (../write-adr/SKILL.md). If it touches keys/keychain, custom base URLs, the JS sandbox, IPC, or crypto → mark it for explicit security review (security-review.md).
6. **Write concrete acceptance criteria.** Refine the phase's Acceptance into a checkbox list that is testable and names the standards gates: strict TS / no-any, the relevant coverage bar from testing.md (engine is ≥90% line + branch), seam/import-zone lint green, canonical event names + `sequenceNumber`, secrets never in logs/events.
7. **Checkpoint — get the plan reviewed; do NOT implement.** Output the plan (scope, packages, deps, risks, acceptance) and stop. Implementation, commits, and PRs are separate steps under ../commit-and-pr/SKILL.md.

## Outputs
- A written task plan: workstream id, in/out scope, affected packages with their seam rules, dependencies, decision/security flags, and a concrete acceptance checklist. No code yet.

## Done criteria
- [ ] Workstream id and phase identified; its Acceptance copied as the seed.
- [ ] Dependencies satisfied and engine-first build order respected.
- [ ] In-scope and out-of-scope both written.
- [ ] Affected packages listed with the seam rule each must honor.
- [ ] New-dependency / settled-decision changes routed to an ADR; security-sensitive paths flagged.
- [ ] Acceptance criteria are concrete, testable, and name the standards gates.
- [ ] Plan presented; implementation NOT started.

## Common pitfalls
- Starting to code before the plan is agreed (CLAUDE.md: plan first for multi-file work).
- Pulling scope from a later phase into this task (scope creep across the build order).
- Inventing an event/YAML/DDL shape instead of citing its `reference/` home.
- Missing that a "small" addition is actually a new dependency or a decision change (needs an ADR).
- Skipping the security flag on a key/base-URL/sandbox/IPC touch.

## Related
- Roadmap + phases: ../../../docs/roadmap/README.md, ../../../docs/roadmap/current.md, ../../../docs/roadmap/phases/
- Engine-first / seam rules: ../../../docs/standards/architectural-principles.md
- Gates: ../../../docs/standards/testing.md, ../../../docs/standards/security-review.md
- Sibling skills: ../write-adr/SKILL.md, ../standards-check/SKILL.md, ../commit-and-pr/SKILL.md
