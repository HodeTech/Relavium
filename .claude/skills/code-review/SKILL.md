---
name: code-review
description: Review a Relavium diff, PR, or branch against docs/standards/, the ADRs, and the CLAUDE.md non-negotiables, then report findings as file:line — severity — issue — impact — fix, sorted by severity. USE FOR: reviewing a proposed change before merge, walking a PR, or self-reviewing your own branch before requesting review. DO NOT USE FOR: implementing the change (use implement-task), a secrets/SSRF/sandbox deep-dive (use security-review), or general code questions unrelated to a diff.
---

## Purpose

Catch what the toolchain cannot: correctness on the failure paths, the `@relavium/llm`
seam, engine purity, undocumented dependencies, drifted specs, and missing tests. Lint and
typecheck catch format and types; this review catches the rest. It applies the binding
[code-review.md](../../../docs/standards/code-review.md) checklist and the
[CLAUDE.md](../../../CLAUDE.md) non-negotiables — it does not restate them, it enforces them.

## When to use

- A PR or branch diff is ready for review (yours or someone else's).
- Before requesting review, as a self-review pass at the end of [../implement-task/SKILL.md](../implement-task/SKILL.md).
- Auditing a specific commit range for standards compliance.

## When not to use

- You are still implementing — use [../implement-task/SKILL.md](../implement-task/SKILL.md).
- The change touches keys, the keychain, custom base URLs, the `run_command` sandbox, or
  prompt construction — run [../security-review/SKILL.md](../security-review/SKILL.md)
  (this skill defers the security verdict there).

## Inputs

- The diff: a PR number, a branch (`git diff main...HEAD`), or a commit range.
- The PR/commit message stating intent — review the diff *and* whether it does what it claims.
- The ADRs and standards the change touches.

## Workflow

1. **Establish the diff and intent.** Get the changes (`git diff main...HEAD`,
   `git diff <range>`, or `gh pr diff <n>`) and read the PR/commit message. Note the package
   scope(s) and which ADRs the change implements or touches.

2. **Read what the change touches.** Open the relevant
   [docs/standards/](../../../docs/standards/) and [docs/decisions/](../../../docs/decisions/),
   and the surrounding code — review against the established pattern, not in a vacuum.

3. **Walk the [code-review.md](../../../docs/standards/code-review.md) checklist:**
   - **Correctness** — does it do what the message claims, and only that? Are the failure
     paths handled (empty/large input, `AbortSignal` cancellation, partial streams,
     fallback-chain failover, resume-from-checkpoint)?
   - **Error handling** — typed, discriminated, classified per
     [error-handling.md](../../../docs/standards/error-handling.md); no silent catches, no
     floating promises, `LlmError` retryable/fatal classification intact.
   - **Tests** — present and actually exercising the change; a bug fix has a regression test
     that fails without the fix; engine logic tested in `packages/core`/`packages/llm`, not
     only at a surface ([testing.md](../../../docs/standards/testing.md)).
   - **Performance** — no per-token allocation in the streaming loop, no O(n) re-render on
     canvas updates, no blocking IO on the run path.

4. **Run the non-negotiable grep checks** (these are blockers, not nits):
   - Seam: `grep -rn "@anthropic-ai/sdk\|from 'openai'\|@google/genai" packages apps | grep -v 'packages/llm/src/adapters/'` — any remaining hit is a leaked vendor type ([ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md)); same scope as the standards-check skill.
   - Engine purity: `grep -rn "node:\|from 'fs'\|@tauri-apps\|window\.\|document\." packages/core/src` — a platform import in the engine breaks portability.
   - `any` / unsafe escape hatches: `grep -rn ": any\|as any\|@ts-ignore" $changed_files`.
   - New dependency: inspect the `package.json` diff — a new runtime dependency needs an ADR.
   - Secrets: scan for a key in a log, an error string, an IPC payload, a store, or a `node:failed`/`run:failed` event.
   - Canonical names: legacy dotted run-event names or `seqNo` instead of `sequenceNumber`.

5. **Canonical-home docs.** A change that alters a spec (YAML schema, SSE events, IPC, DB
   DDL, node types, tools, routes) must update its one
   [reference/](../../../docs/reference/) home and not paste a copy elsewhere.

6. **Delegate the deep pass if warranted.** For a large or unfamiliar diff, hand the branch
   to the [relavium-reviewer agent](../../agents/relavium-reviewer.md) for a project-aware
   sweep, then fold its findings into your report (deduplicated, re-severitized).

7. **Report findings** in the output format below, sorted by severity. End with what you
   verified as clean so the author sees the coverage.

8. **File a durable note if substantial.** For a review with structural findings or a
   judgment that informs future work, drop a short note for the maintainer (the PR thread or
   a review note) so the reasoning is not lost — disagreements escalate to an
   [ADR](../../../docs/decisions/README.md), not a buried comment.

## Outputs

- A severity-sorted findings report (`file:line — severity — issue — impact — fix`).
- A short list of what was checked and found clean.
- A merge verdict: what blocks (a security finding, a leaked vendor type, an undocumented
  dependency, a drifted/duplicated spec, missing tests for new behavior, a red required
  check) vs. what is a suggestion.

## Done criteria

- [ ] Obtained the diff and read the stated intent.
- [ ] Reviewed against the code-review.md checklist (correctness, errors, tests, performance).
- [ ] Ran the non-negotiable grep checks (seam, engine purity, `any`, new dependency, secrets, event names).
- [ ] Verified canonical-home docs were updated for any spec change.
- [ ] Delegated to the relavium-reviewer agent for large/unfamiliar diffs and folded in its findings.
- [ ] Reported findings as file:line — severity — issue — impact — fix, severity-sorted.
- [ ] Listed what was checked and clean, and stated the merge verdict (blockers vs. suggestions).
- [ ] Filed a durable review note if the review was substantial.

## Output format

```
Relavium Code Review — N findings (Blocker: B, High: H, Medium: M, Low: L)

[BLOCKER] packages/core/src/runner/agent-runner.ts:88
  Issue: imports `Anthropic` from '@anthropic-ai/sdk' inside the engine.
  Impact: leaks a vendor type across the @relavium/llm seam (ADR-0011) — makes the
          implementation swap expensive and couples the engine to a provider.
  Fix: depend on the LlmProvider seam type only; move any SDK use into
       packages/llm/src/adapters/anthropic-adapter.ts.

[HIGH] packages/llm/src/adapters/openai-adapter.ts:142
  Issue: a provider 500 is rethrown as a bare Error, not a classified LlmError.
  Impact: the fallback runner can't tell retryable from fatal, so it won't fail over.
  Fix: normalize to LlmError { kind: 'retryable' } per error-handling.md.

[MEDIUM] packages/shared/src/schemas/run-event.ts:30
  Issue: event named 'node.started' (legacy dotted form).
  Fix: use the canonical 'node:started'.

[LOW] packages/core/src/parse/yaml.ts:12
  Issue: only the happy path is tested; the malformed-YAML reject case is missing.
  Fix: add a Vitest reject case asserting a typed validation error names the field.

Clean:
  - Engine purity: no platform import in packages/core/src.
  - No new runtime dependency in the package.json diff.
  - No secret in any log line, error message, or IPC payload.
  - cost:updated payload matches the canonical SSE schema.
```

Severity rubric:
- **Blocker** — merge-stopping per code-review.md: leaked vendor type, secret leak, undocumented dependency, drifted/duplicated spec, missing tests for new behavior, broken seam/engine-purity invariant, red required check.
- **High** — correctness or failure-path bug, broken error classification, test coverage gap on a critical path.
- **Medium** — code quality, canonical-name drift, missing edge-case handling.
- **Low** — style, a thin test, minor simplification.

## Common pitfalls

- **Over-rating severity.** A style nit is not a blocker; reserve Blocker for the code-review.md merge-stoppers.
- **Reviewing the code, not the intent.** Confirm it does what the message claims, and only that.
- **Missing the `package.json` diff** — a quiet new dependency is a blocker.
- **Trusting green CI to mean "seam holds"** — grep the imports yourself.
- **Skipping the security verdict** — defer key/SSRF/sandbox findings to [../security-review/SKILL.md](../security-review/SKILL.md).

## Related

- [../implement-task/SKILL.md](../implement-task/SKILL.md) — the build flow this reviews.
- [../security-review/SKILL.md](../security-review/SKILL.md) — the security pass.
- [../../agents/relavium-reviewer.md](../../agents/relavium-reviewer.md) — the reviewer subagent.
- [../../../docs/standards/code-review.md](../../../docs/standards/code-review.md)
- [../../../docs/standards/code-style-typescript.md](../../../docs/standards/code-style-typescript.md)
- [../../../docs/standards/error-handling.md](../../../docs/standards/error-handling.md)
- [../../../docs/standards/testing.md](../../../docs/standards/testing.md)
- [../../../docs/decisions/0011-internal-llm-abstraction.md](../../../docs/decisions/0011-internal-llm-abstraction.md)
- [../../../docs/reference/shared-core/llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md)
