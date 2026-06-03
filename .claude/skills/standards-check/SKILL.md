---
name: standards-check
description: >
  Fast, mostly-grep conformance gate over a diff before deeper review — strict TS/no-any, no new dep without an ADR, no vendor type across the @relavium/llm seam, engine zero platform imports, secrets never plaintext/in logs, one-canonical-home docs, conventional commits. USE FOR: a quick pass/fail screen before requesting review or committing. DO NOT USE FOR: a full code review (use the relavium-reviewer agent / code-review.md) or a deep security audit (use security-review.md).
---
# Standards Check

## Purpose
A fast, repeatable screen that catches the project's load-bearing rule violations *before* a human or the reviewer agent spends attention on logic. It is grep-first and pass/fail; it does not judge design. Run it on a diff before committing or opening a PR. It assumes you have read `CLAUDE.md` and the standards it cites.

## When to use
- Before committing or opening a PR, as a self-gate.
- After generating code, to confirm it is "born compliant" (architectural-principles §8).

## When not to use
- For a thorough correctness/design review — that is `code-review.md` and the relavium-reviewer agent.
- For a deep security review of key/sandbox/crypto changes — that is ../../../docs/standards/security-review.md.

## Inputs
| Input | Description |
|-------|-------------|
| Diff / changed files | `git diff` against the base, or the staged set. |
| Repo root | `$(git rev-parse --show-toplevel)` (bound to `R` below). |

## Workflow
Run each check against the changed files. Treat any hit as a fail to resolve or justify. `R=$(git rev-parse --show-toplevel)`.

1. **TS strict / no-`any` / no `@ts-ignore`.** `any` is banned; use `unknown` at boundaries. `@ts-expect-error` needs a one-line justification; `@ts-ignore` is forbidden.
   ```bash
   git -C "$R" diff --name-only | grep -E '\.tsx?$' | xargs -r grep -nE '(:|<)\s*any\b|\bas any\b|@ts-ignore' 
   ```
2. **No vendor SDK type across the `@relavium/llm` seam.** Provider SDKs import **only** under `packages/llm/src/adapters/*`. Any such import elsewhere is a fail.
   ```bash
   git -C "$R" grep -nE "from '(@anthropic-ai/sdk|openai|@google/genai)'" -- 'packages/**' 'apps/**' \
     | grep -v 'packages/llm/src/adapters/'
   ```
3. **Engine has zero platform-specific imports.** `@relavium/core` must run in Node, the Tauri WebView, the extension host, and (later) Bun — so no `node:*`, `fs`, `tauri`, `vscode`, `electron`.
   ```bash
   git -C "$R" grep -nE "from '(node:|fs|path|os|child_process|@tauri-apps|vscode|electron)'" -- 'packages/core/**'
   ```
4. **No new runtime dependency without an ADR.** Flag any `dependencies` addition in a `package.json` in the diff and confirm an ADR justifies it.
   ```bash
   git -C "$R" diff -- '**/package.json' | grep -E '^\+' | grep -vE 'devDependencies|^\+\+\+' 
   ```
5. **Secrets never plaintext or in logs/events.** Scan for keys headed into logs, events, IPC payloads, stores, or config. Keys live only in the OS keychain.
   ```bash
   git -C "$R" grep -niE "(api[_-]?key|secret|token).*(console\.(log|info)|logger|emit|event|ipc|localStorage)" -- 'packages/**' 'apps/**'
   ```
   Manually confirm no key is interpolated into a `node:failed`/`run:failed` message or a `--json`/SSE payload.
6. **One canonical home — no duplicated specs.** A changed doc must *cite* a `reference/` spec, not paste a YAML schema / SSE event / DDL body.
   ```bash
   git -C "$R" diff -- 'docs/**' | grep -E '^\+' | grep -iE 'sequenceNumber|cost:updated|input_schema|CREATE TABLE'
   ```
   Any spec body in a non-`reference/` doc is a fail — replace with a relative link.
7. **Conventional Commits, per-package scope.** Last commit must be `type(scope): summary` with a valid scope (`llm|core|shared|db|ui|cli|desktop|vscode|api|portal|docs|repo`) and the canonical Co-Authored-By trailer (the bare `Claude` or the model-versioned `Claude Opus 4.x` form — see [commit-style.md](../../../docs/standards/commit-style.md)).
   ```bash
   git -C "$R" log -1 --pretty=%B | grep -nE '^(feat|fix|refactor|perf|test|docs|chore|build|ci)(\([a-z]+\))?!?: '
   git -C "$R" log -1 --pretty=%B | grep -nE 'Co-Authored-By: Claude.*<noreply@anthropic.com>'
   ```
8. **Docs hygiene.** New/changed docs: one H1, no YAML front-matter, relative links only, ISO dates, Phase-2 content explicitly marked. Spot-check the changed `.md` files.
9. **Checkpoint — summarize pass/fail.** List each check as pass or a concrete fail with file:line. A single unresolved fail blocks deeper review until fixed or explicitly justified (e.g. a dep with its ADR linked).

## Outputs
- A pass/fail line per check, with file:line for each fail and the fix or justification.

## Done criteria
- [ ] No `any` / `@ts-ignore`; `@ts-expect-error` justified.
- [ ] No provider SDK import outside `packages/llm/src/adapters/*`.
- [ ] No platform import in `packages/core`.
- [ ] Any new runtime dependency has an ADR.
- [ ] No secret in a log/event/IPC/store/config path.
- [ ] No spec body duplicated outside its `reference/` home.
- [ ] HEAD commit is a valid Conventional Commit with scope + Co-Authored-By trailer.
- [ ] Docs hygiene holds (one H1, no front-matter, relative links, ISO dates, Phase-2 marked).

## Common pitfalls
- Treating grep hits as the whole truth — read the flagged lines; a `// raw: unknown` debug carry-through is fine, a typed vendor shape is not.
- Letting a devDependency trip the dep check (only runtime `dependencies` need an ADR).
- Missing a secret that reaches an event payload indirectly (check the event construction, not just `console.log`).
- Passing a doc that pastes an event/DDL shape instead of linking it.

## Related
- Standards screened: ../../../docs/standards/code-style-typescript.md, ../../../docs/standards/security-review.md, ../../../docs/standards/logging-and-observability.md, ../../../docs/standards/commit-style.md, ../../../docs/standards/documentation-style.md
- Principles: ../../../docs/standards/architectural-principles.md, ../../../docs/decisions/0011-internal-llm-abstraction.md
- Deeper passes: ../../../docs/standards/code-review.md (and the relavium-reviewer agent)
- Sibling skills: ../commit-and-pr/SKILL.md, ../start-task/SKILL.md
