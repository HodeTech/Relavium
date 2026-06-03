---
name: grill-me
description: >
  Interview the user relentlessly — one question at a time — to stress-test a plan or design until you reach shared understanding, resolving each branch of the decision tree and offering your own recommendation with every question. USE FOR: pressure-testing a design/plan before building, "grill me", "poke holes in this", "review my plan", interrogating a proposal for Relavium-specific risks. DO NOT USE FOR: recording the settled decision (use ../write-adr/SKILL.md), scaffolding the work (use ../add-package/SKILL.md or ../add-llm-adapter/SKILL.md), or reviewing an existing diff.
---
# Grill me

## Purpose
Interrogate a plan or design until you and the user share a precise understanding of it — surfacing the unstated assumptions, the unresolved branches, and the Relavium guarantees it might quietly break, *before* anyone writes code or an ADR. The output is not a document; it is a hardened plan and a clear list of what is decided versus still open. Match the spirit of pressure-testing: be relentless but useful, and always bring your own recommendation so the user is reacting to a position, not staring at a blank prompt.

## When to use
- The user asks to be grilled, to have a plan poked at, or to stress-test a design before building.
- A proposal touches the engine, the LLM seam, security, scope/phasing, or anything that might need an ADR — and you want to find the holes first.
- A plan spans several files or several decisions and the dependencies between those decisions are not yet resolved.

## When not to use
- The decision is already settled and you are recording it — that is ../write-adr/SKILL.md.
- The work is scaffolding, not deciding — ../add-package/SKILL.md or ../add-llm-adapter/SKILL.md.
- You are reviewing concrete code that already exists — that is a code review, not a grilling.

## Inputs
| Input | Description |
|-------|-------------|
| The plan / design | Whatever the user wants stress-tested — a feature, an architecture, a refactor, a scope. |
| Constraints | The non-negotiables it must respect (CLAUDE.md rules, the relevant ADRs and standards). |
| Decision tree | The branch points and their dependencies — the thing the interview will walk and resolve. |

## Workflow
1. **Ground yourself first, silently.** Skim the plan and the docs that frame it (`CLAUDE.md`, the relevant ADRs, the cited `docs/reference/` specs). Do not narrate the reading; come to the interview informed.
2. **Inspect before you ask.** If a question can be answered by reading the code or the docs, **inspect instead of asking.** Spend the user's attention only on judgment calls and genuine ambiguities — never on facts you can look up. An interview that asks what the repo already states is a wasted interview.
3. **Map the decision tree.** Privately list the branch points and their dependencies — which decisions are downstream of which. You will walk this tree; resolving a parent before its children keeps the interview coherent.
4. **Ask one question at a time.** Strictly one — never a batch or a numbered list. Each question must be the single most decision-relevant unknown given everything resolved so far. Wait for the answer before forming the next question; let the answer reshape the tree.
5. **Recommend with every question.** Each question carries *your* recommended answer and a one-line why. The user should always be reacting to a concrete position, not generating an answer from nothing. Disagreement is the most valuable signal you can get.
6. **Resolve each branch before moving on.** Do not leave a fork half-open. When a branch is settled, restate the resolution in one sentence so the shared understanding is explicit, then descend to its children.
7. **Grill the Relavium-specific concerns hard.** When the plan touches any of these, drive on it until it is resolved — these are where Relavium plans most often hide a defect:
   - **The `@relavium/llm` seam.** Does anything leak a vendor SDK type across the seam (message shape, content block, streaming event, tool-call rep, usage field, an enum, a `raw` typed as a vendor shape)? Is a provider-specific feature being smuggled into the common path instead of through `providerOptions` + the `supports` capability flags? Is capability gating honest? (See ../../../docs/reference/shared-core/llm-provider-seam.md, ../../../docs/decisions/0011-internal-llm-abstraction.md.)
   - **Engine zero-platform-imports.** Does this put a `node:*`, `fs`, DOM, Tauri, or vendor-SDK import into `packages/core` — or into a package the engine consumes? The engine must run identically in Node, the Tauri WebView, the VS Code host, and the Phase-2 Bun API.
   - **Local-first & key security.** Does an API key risk reaching the frontend, a log line, a checkpoint, or a job payload? Does the plan keep Phase 1 working with zero cloud dependency? (ADR-0006, ADR-0008.)
   - **ADR governance.** Does this need an ADR (new runtime dependency, new seam, cross-surface or scope decision)? Does it *supersede* an existing Accepted ADR — in which case it is a new superseding ADR, never a rewrite?
   - **One canonical home for specs.** Is the plan about to restate a spec (YAML schema, SSE event, IPC, DDL, node types) instead of citing its single `docs/reference/` home? Duplicated specs drift.
   - **Phase 1 vs Phase 2 scope.** Is Phase-2 cloud work (`apps/api`, `apps/portal`, Postgres/Redis/BullMQ, Better Auth) creeping into the Phase-1 build? Is the desktop app staying an agent-management center and not drifting into an IDE? (ADR-0007, ADR-0008.)
   - **Build-in-house / no new dependency.** Is a new third-party dependency being reached for where an owned implementation belongs — or, conversely, is the plan hand-rolling a security-critical primitive (crypto, TLS, keychain) that must be a vetted library? Both are red flags. (architectural-principles §9.)
8. **Name the remaining risk.** When the tree is walked, state plainly what is now decided, what is still open, and the single biggest risk left in the plan. Do not declare consensus that does not exist.
9. **Hand off.** If the grilling surfaced a decision worth recording, point to ../write-adr/SKILL.md; if it surfaced scaffolding, point to ../add-package/SKILL.md or ../add-llm-adapter/SKILL.md. The grilling produces the understanding; another skill produces the artifact.

## Outputs
- A hardened plan with each decision-tree branch explicitly resolved.
- A short, honest ledger of what is decided, what is still open, and the largest remaining risk.
- A pointer to the right follow-up skill (ADR / scaffold) when one is owed.

## Done criteria
- [ ] Every branch of the decision tree is resolved or explicitly flagged as open.
- [ ] Questions were asked **one at a time**, each with your own recommendation and a one-line why.
- [ ] Anything answerable from the code/docs was inspected, not asked.
- [ ] Each Relavium-specific concern the plan touches (seam, engine purity, key security, ADR governance, canonical-home, phase scope, build-in-house) was grilled until resolved.
- [ ] The closing summary states decided vs. open vs. biggest-remaining-risk without manufacturing consensus.

## Common pitfalls
- Dumping a batch of questions instead of one — it collapses the decision tree and the user answers shallowly.
- Asking a question the repo already answers, instead of inspecting.
- Asking without recommending, leaving the user to do all the thinking.
- Going easy on the load-bearing Relavium concerns (seam leakage, engine purity, key handling) because they are uncomfortable to push on.
- Declaring agreement to wrap up, when a branch is actually still unresolved.
- Letting the grilling silently become the ADR — record the decision through ../write-adr/SKILL.md, do not bury it in chat.

## Related
- Non-negotiable rules to grill against: ../../../CLAUDE.md
- The seam contract & its immovability: ../../../docs/reference/shared-core/llm-provider-seam.md, ../../../docs/decisions/0011-internal-llm-abstraction.md
- Engineering principles (build-in-house, canonical home, phasing): ../../../docs/standards/architectural-principles.md
- Key security & local-first: ../../../docs/decisions/0006-os-keychain-for-api-keys.md, ../../../docs/decisions/0008-local-first-phase-1-cloud-phase-2.md
- Desktop-is-not-an-IDE: ../../../docs/decisions/0007-desktop-is-not-an-ide.md
- Follow-up skills: ../write-adr/SKILL.md, ../add-package/SKILL.md, ../add-llm-adapter/SKILL.md
