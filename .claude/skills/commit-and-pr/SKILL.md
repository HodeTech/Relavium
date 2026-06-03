---
name: commit-and-pr
description: >
  Format Conventional Commits with a per-package scope, reference the ADR/task in the body, end with the Co-Authored-By trailer, and write a PR description with a conformance checklist. USE FOR: committing finished work and opening a PR. DO NOT USE FOR: authoring a decision (use ../write-adr/SKILL.md), scoping work (use ../start-task/SKILL.md), or the pre-commit conformance screen (use ../standards-check/SKILL.md first).
---
# Commit and PR

## Purpose
Turn finished work into a clean, auditable commit history and a reviewable PR. Relavium treats commits as part of the durable record (the same value placed on git-native workflow YAML), so each commit explains *what changed and why*, scoped to the one package it touched, and links back to the ADR/workstream it implements. This skill mirrors `commit-style.md`; it does not restate the full spec.

## When to use
- Work is finished and ../standards-check/SKILL.md passes.
- You are about to commit and open a PR for review.

## When not to use
- The work is still being scoped — use ../start-task/SKILL.md.
- You are recording a decision — use ../write-adr/SKILL.md (then commit it with this skill).

## Inputs
| Input | Description |
|-------|-------------|
| Change set | The staged diff, ideally one package's worth. |
| Scope | Short workspace name: `llm`, `core`, `shared`, `db`, `ui`, `cli`, `desktop`, `vscode`, `api`, `portal`, `docs`, `repo`. |
| ADR / workstream | The ADR (`Refs: ADR-NNNN`) and/or phase workstream the change implements. |

## Workflow
1. **Gate first.** Run ../standards-check/SKILL.md and `pnpm turbo run lint typecheck test`. Do not commit red.
2. **Branch if on the default branch.** Never commit straight to `main`.
   ```bash
   git -C /Users/dev/Documents/Projects/Agent-Organizer rev-parse --abbrev-ref HEAD
   # if main: git switch -c feat/<scope>-<short-topic>
   ```
3. **One scope per commit.** Stage only one package's changes. A change spanning packages is usually two commits; if genuinely atomic, pick the primary scope and name the rest in the body. Do not bundle generated/formatting churn with logic.
4. **Write the message** in Conventional Commits form. Summary is imperative, lower-case, no trailing period, ≤ ~72 chars. Body (expected for anything non-obvious) explains the *why*, not a restatement of the diff. Reference the ADR in a trailer; end with the required co-author trailer.
   ```
   feat(llm): add anthropic streaming adapter behind the seam

   First adapter over @anthropic-ai/sdk proving the LLMProvider seam:
   folds the typed event stream into StreamChunks and maps stop reasons
   to the 5-value enum. No vendor type crosses the @relavium/llm seam.

   Refs: ADR-0011

   Co-Authored-By: Claude <noreply@anthropic.com>
   ```
   - Types: `feat fix refactor perf test docs chore build ci`. Breaking change appends `!` (`feat(core)!: …`) and explains under a `BREAKING CHANGE:` line.
   - Adapter work names the layer in the summary, not a vendor scope (`feat(llm): add anthropic …`, not `feat(anthropic)`).
   - Use canonical vocabulary in messages too (`cost:updated`, `sequenceNumber`), never legacy dotted names.
5. **Checkpoint — verify the trailer.** Every commit ends with exactly `Co-Authored-By: Claude <noreply@anthropic.com>`.
   ```bash
   git -C /Users/dev/Documents/Projects/Agent-Organizer log -1 --pretty=%B | grep 'Co-Authored-By: Claude <noreply@anthropic.com>'
   ```
6. **Push and open the PR** with `gh`. Title is the Conventional-Commit summary of the headline change.
   ```bash
   gh pr create --title 'feat(llm): add anthropic streaming adapter' --body "$(cat <<'EOF'
   ## What
   <one-paragraph what + why>

   ## Scope
   Package(s): @relavium/llm. Phase/workstream: Phase 1 · 1.C.

   ## Checklist
   - [ ] Conventional Commits, one scope per commit, Refs: ADR-NNNN
   - [ ] standards-check passes (no-any, seam, engine zero-platform-imports)
   - [ ] pnpm turbo run lint typecheck test green
   - [ ] No vendor SDK type crosses the @relavium/llm seam
   - [ ] No secret in logs/events/IPC/exported YAML
   - [ ] Specs cited from docs/reference/, not restated
   - [ ] Security-sensitive paths (keys, base URL, sandbox, IPC) flagged for review

   Refs: ADR-NNNN

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```
7. **Request review** from the relavium-reviewer agent / a maintainer. Only commit or push when the user has asked for it.

## Outputs
- One or more Conventional Commits (per-package scope, ADR trailer, Co-Authored-By).
- A PR with a what/why summary, scope, and a conformance checklist.

## Done criteria
- [ ] On a non-default branch.
- [ ] Each commit is `type(scope): summary`, imperative, ≤ ~72 chars, valid scope.
- [ ] Body explains why; ADR referenced via `Refs: ADR-NNNN` where applicable.
- [ ] Every commit ends with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- [ ] One scope per commit; no bundled formatting/generated churn.
- [ ] PR body has the conformance checklist and the Claude Code footer.

## Common pitfalls
- Capitalized or past-tense summary, or a trailing period.
- A vendor scope (`feat(anthropic)`) instead of the package scope (`feat(llm)`).
- Bundling two packages' changes into one commit.
- Forgetting the `Refs: ADR-NNNN` trailer when implementing a decision.
- Missing or malformed Co-Authored-By trailer.
- Committing on `main` or before the lint/typecheck/test gate is green.

## Related
- Commit spec: ../../../docs/standards/commit-style.md
- Project-structure (scopes): ../../../docs/project-structure.md
- Review: ../../../docs/standards/code-review.md
- Sibling skills: ../standards-check/SKILL.md, ../start-task/SKILL.md, ../write-adr/SKILL.md
