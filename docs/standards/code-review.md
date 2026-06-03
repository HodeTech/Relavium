# Code Review

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [code-style-typescript.md](code-style-typescript.md), [security-review.md](security-review.md), [testing.md](testing.md), [commit-style.md](commit-style.md), [architectural-principles.md](architectural-principles.md)

Every change merges through review. Review is where the
[build-in-house](architectural-principles.md#9-build-in-house-minimize-third-party-dependencies)
and [no-vendor-lock-in](architectural-principles.md#2-one-language--typescript) principles
are actually enforced — automation catches format and types; a human catches the rest.

## Ground rules

- Nothing merges to the default branch without a review approval and green required CI
  (typecheck, lint, unit tests, fixture-mode conformance — see [testing.md](testing.md)).
- The author runs lint, format, and tests **before** requesting review; review is not a
  substitute for the toolchain.
- Keep PRs small and scoped to one concern; a reviewable diff gets a real review. Large
  mechanical changes are split from behavioral ones.
- The reviewer reviews the **diff and its intent**, links the relevant
  [ADR](../decisions/README.md) when the change implements a decision, and leaves
  actionable comments. Disagreements escalate to an ADR, not a comment thread.

## Review checklist

**Correctness**
- Does the change do what the PR/commit message claims, and only that?
- Edge cases and failure paths handled: empty/large inputs, cancellation
  (`AbortSignal`), partial streams, fallback-chain failover, resume-from-checkpoint.
- Errors are typed and classified per [error-handling.md](error-handling.md); no silent
  catches, no floating promises.
- Tests exist and actually exercise the change: a bug fix has a regression test that
  fails without the fix; engine logic is tested in `packages/core` / `packages/llm`, not
  only at a surface (see [testing.md](testing.md)).

**Security**
- Run the [security-review checklist](security-review.md) on any change that touches keys,
  the keychain, IPC, network calls, custom base URLs, the `run_command` sandbox, or
  prompt construction. No secret reaches the frontend or the logs.

**Performance**
- No obvious hot-path regression: no per-token allocation in the streaming loop, no O(n)
  re-render on canvas updates (Zustand selectors, see
  [ADR-0010](../decisions/0010-zustand-direct-subscriptions-for-reactflow.md)), no
  blocking IO on the run path. Performance claims are measured, not asserted.

**No new third-party dependency without an ADR**
- A new runtime dependency — especially in `packages/core` / `packages/llm` or a new
  provider SDK — requires an [ADR](../decisions/README.md). The reviewer checks
  `package.json` diffs and rejects a casual `npm install` that adds a framework or
  re-introduces a banned one (Vercel AI SDK, LangChain, a Python sidecar). Dev-only tools
  are lower bar but still justified.
- The **LLM seam holds**: no vendor SDK type imported outside `packages/llm/src/adapters/*`
  (see [code-style-typescript.md](code-style-typescript.md#module-boundaries--no-vendor-type-across-the-llm-seam)).
  This is a blocking check, not a nit.

**Canonical-home docs**
- Code changes that alter a spec (YAML schema, SSE events, IPC contract, DB DDL, node
  types, tools, routes) update the **one canonical `reference/` home** and do not paste a
  copy elsewhere (see [documentation-style.md](documentation-style.md#6-one-canonical-home-per-artifact)).
- Run-event names match the canonical colon-namespaced schema and `sequenceNumber`; the
  legacy dotted names are rejected on sight.
- New docs are born compliant with [documentation-style.md](documentation-style.md); there
  is no "fix the docs later" approval.

## What blocks a merge

A failing required check, a security finding, a leaked vendor type across the LLM seam, an
undocumented new dependency, a drifted/duplicated spec, or missing tests for new behavior.
Style nits are suggestions; the items above are blockers.
