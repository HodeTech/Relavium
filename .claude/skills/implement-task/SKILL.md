---
name: implement-task
description: The primary end-to-end flow for implementing any non-trivial change in Relavium — scope, plan, build against the standards, self-check the seam rule, run the toolchain, update docs, commit, and hand off to review. USE FOR: features, fixes, refactors, or new adapters/nodes that touch real code in packages/* or apps/*. DO NOT USE FOR: a one-line typo, a pure docs edit (use documentation-style directly), reviewing someone else's diff (use code-review), or a security-only pass (use security-review).
---

## Purpose

Make every non-trivial change land the same disciplined way: aligned with the
[CLAUDE.md non-negotiables](../../../CLAUDE.md), built against the
[standards](../../../docs/standards/), respecting package boundaries and the
`@relavium/llm` seam, proven green by `pnpm turbo`, documented in its one canonical
home, and handed to the reviewer with a copy-paste prompt. This skill is the spine; it
cites the standards and delegates committing — it does not restate either.

## When to use

- Implementing a roadmap workstream task (e.g. a Phase 0/1 item from
  [docs/roadmap/current.md](../../../docs/roadmap/current.md)).
- A feature, bug fix, refactor, or perf change in `packages/*` or `apps/*`.
- Adding a provider adapter, a node type, a CLI command, or a schema.

## When not to use

- Trivial edits (typo, comment, formatting) — just make them and run `pnpm turbo run lint`.
- Pure documentation work — follow [documentation-style.md](../../../docs/standards/documentation-style.md).
- Reviewing a diff you did not write — use [../code-review/SKILL.md](../code-review/SKILL.md).
- A dedicated security pass — use [../security-review/SKILL.md](../security-review/SKILL.md).

## Inputs

- The task / issue / roadmap item, with its acceptance criteria.
- The package or app it lives in, and the relevant ADRs and standards.
- Whether it touches a package public API, an Accepted ADR, the `@relavium/llm` seam,
  the keychain/secrets path, or introduces a new surface (these gate the plan step).

## Workflow

1. **Scope and align.** Read [CLAUDE.md](../../../CLAUDE.md) and locate the task in
   [docs/roadmap/current.md](../../../docs/roadmap/current.md). Read the ADRs it touches
   in [docs/decisions/](../../../docs/decisions/) and the relevant
   [docs/standards/](../../../docs/standards/) — at minimum
   [code-style-typescript.md](../../../docs/standards/code-style-typescript.md),
   [error-handling.md](../../../docs/standards/error-handling.md), and
   [testing.md](../../../docs/standards/testing.md). Confirm which package owns the work
   and that the change stays within scope (engine logic in `packages/core`, never a
   surface; desktop is agent-management, not an IDE).

2. **Inspect before editing.** Find the existing patterns and mirror them — do not invent
   a new shape next to an established one. `Grep`/`Glob` for the nearest analogue (an
   existing adapter under `packages/llm/src/adapters/*`, a sibling node type, a Zod schema
   in `packages/shared`). Note the error types, the test layout (`*.test.ts` beside the
   code), the export surface (`index.ts`), and the seam types it depends on.

3. **Plan — confirm only when it matters.** Write a short plan (files to touch, the
   approach, the tests). **Stop and confirm the plan with the maintainer** if the change
   touches any of: a package's public API / exported `index.ts`, an Accepted ADR's
   decision, the `@relavium/llm` seam ([llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md)),
   the keychain/secrets path, or introduces a new surface or runtime dependency.
   Otherwise proceed. A new runtime dependency is not a plan item — it needs an
   [ADR](../../../docs/decisions/README.md) first (see step 5).

4. **Implement against the standards.** Write strict TypeScript: no `any` (use `unknown` +
   a Zod guard at boundaries), no unsafe `as`, no `@ts-ignore`. Typed, discriminated errors
   per [error-handling.md](../../../docs/standards/error-handling.md) — never `throw "string"`,
   no silent catches, no floating promises, thread the `AbortSignal`. Validate untrusted
   input (YAML, IPC, provider responses) with Zod at the boundary. Keep side effects at the
   edges so the engine stays pure. Add tests as you go — engine logic in
   `packages/core`/`packages/llm`, not only at a surface; a bug fix gets a regression test
   that fails before the fix.

5. **Self-check vs the standards and the seam rule.** Before running the toolchain, walk
   your own diff against the [code-review checklist](../../../docs/standards/code-review.md)
   and verify the non-negotiables hold:
   - **The seam holds:** no vendor SDK type (`@anthropic-ai/sdk`, `openai`, `@google/genai`)
     imported outside `packages/llm/src/adapters/*`; the engine pattern-matches only on
     Relavium/Zod types ([ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md)).
     `grep -rn "@anthropic-ai/sdk\|from 'openai'\|@google/genai" packages/core packages/shared`
     should be empty.
   - **Engine purity:** `packages/core` has zero platform-specific imports (no `node:*`,
     no Tauri, no DOM) — it runs in Node, the Tauri WebView, and the extension host alike.
   - **No new dependency without an ADR:** check the `package.json` diff.
   - **Secrets:** no key in a log, an error message, an IPC payload to the WebView, a
     Zustand store, or a `node:error`/`run:error` event.
   - **Canonical names:** colon-namespaced run events and `sequenceNumber`, never the
     legacy dotted names.

6. **Run the toolchain.** `pnpm turbo run lint typecheck test`, then `pnpm turbo run build`.
   Fix every failure — a red lint, type error, or test is a blocker, not a warning. The
   author runs this *before* asking for review; review is not a substitute for the toolchain.

7. **Update adjacent docs.** If the change alters a spec (workflow/agent YAML, the SSE/run
   event schema, the IPC contract, DB DDL, node types, tools, CLI commands), update its
   **one canonical home** under [docs/reference/](../../../docs/reference/) — never paste a
   copy elsewhere. A non-trivial decision gets a new append-only
   [ADR](../../../docs/decisions/README.md) from
   [adr-template.md](../../../docs/standards/adr-template.md). Touch the
   [architecture/](../../../docs/architecture/) page or
   [glossary.md](../../../docs/glossary.md) if the change introduces or shifts a concept.

8. **Commit.** Use [../commit-and-pr/SKILL.md](../commit-and-pr/SKILL.md) — Conventional
   Commits, one scope per package, `Refs: ADR-XXXX` when the change implements a decision,
   body ending with `Co-Authored-By: Claude <noreply@anthropic.com>`. See
   [commit-style.md](../../../docs/standards/commit-style.md).

9. **Summary.** State what changed and why, which files moved, which standards/ADRs apply,
   the toolchain result (lint/typecheck/test/build all green), and any docs updated. Call
   out anything you deferred or any rule you had to flag.

10. **Produce a review prompt.** Emit a copy-paste block the maintainer can hand to the
    `relavium-reviewer` agent (see [../../agents/relavium-reviewer.md](../../agents/relavium-reviewer.md)),
    naming the branch/diff, the package scope, the ADRs it implements, and any area you
    want scrutinized (e.g. "verify the seam holds in the new adapter").

## Outputs

- The implemented change with tests, mirroring existing patterns.
- A green `pnpm turbo run lint typecheck test` and `pnpm turbo run build`.
- Updated canonical docs / a new ADR where the change warrants it.
- A Conventional Commit (and PR if asked).
- A plain-language summary and a copy-paste `relavium-reviewer` prompt.

## Done criteria

- [ ] Read CLAUDE.md, the relevant ADRs, the relevant standards, and located the task in the roadmap.
- [ ] Inspected and mirrored the nearest existing pattern before editing.
- [ ] Wrote a plan; confirmed it with the maintainer if it touched a public API, an Accepted ADR, the `@relavium/llm` seam, the keychain path, or a new surface/dependency.
- [ ] Implemented in strict TypeScript with typed errors, Zod-validated boundaries, and tests (engine logic tested in core/llm).
- [ ] Self-checked the diff: seam holds, engine purity, no undocumented dependency, no secret leak, canonical event names.
- [ ] `pnpm turbo run lint typecheck test` and `pnpm turbo run build` are green.
- [ ] Updated the one canonical doc home / wrote a new append-only ADR where the change altered a spec or decision.
- [ ] Committed via the commit-and-pr skill with a Conventional Commit and the Co-Authored-By trailer.
- [ ] Wrote a plain-language summary of what changed and why.
- [ ] Produced a copy-paste review prompt for the relavium-reviewer agent.

## Common pitfalls

- **Leaking a vendor type across the seam.** Re-exporting a vendor enum or typing a `raw`
  payload as a vendor shape above the adapter — both are blockers, not nits.
- **Platform import creeping into `packages/core`.** A `node:fs` or Tauri import in the
  engine breaks portability across every surface.
- **Adding a runtime dependency to get unblocked.** A new dependency in the core path needs
  an ADR first; reaching for the Vercel AI SDK or LangChain is forbidden outright.
- **Testing only at the surface.** Engine/LLM logic belongs in `packages/core`/`packages/llm`
  unit tests, not just a desktop e2e.
- **Duplicating a spec.** Restating a schema in prose drifts; update the one `reference/` home.
- **Legacy dotted event names** or `seqNo` instead of `sequenceNumber`.
- **Skipping the toolchain and leaning on review** to catch what lint/typecheck/test would.

## Related

- [../code-review/SKILL.md](../code-review/SKILL.md) — review a diff against the standards.
- [../security-review/SKILL.md](../security-review/SKILL.md) — the security pass.
- [../commit-and-pr/SKILL.md](../commit-and-pr/SKILL.md) — committing and opening a PR.
- [../../agents/relavium-reviewer.md](../../agents/relavium-reviewer.md) — the reviewer subagent.
- [../../../docs/standards/code-style-typescript.md](../../../docs/standards/code-style-typescript.md)
- [../../../docs/standards/error-handling.md](../../../docs/standards/error-handling.md)
- [../../../docs/standards/testing.md](../../../docs/standards/testing.md)
- [../../../docs/decisions/0011-internal-llm-abstraction.md](../../../docs/decisions/0011-internal-llm-abstraction.md)
- [../../../docs/reference/shared-core/llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md)
