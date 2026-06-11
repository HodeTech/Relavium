# Idea: Workflow Evaluation Harness (datasets + judge)

- **Status**: Idea — not committed, not on the roadmap
- **Phase**: Phase 2+ (after the CLI regression harness exists)
- **Related**: [roadmap/README.md](../roadmap/README.md), [reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md), [reference/shared-core/llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md), [standards/testing.md](../standards/testing.md)

The idea: run a git-committed workflow against a **committed dataset of test cases** and
score the outputs — so a team can change a prompt, a model, or a fallback chain and see
*measured* quality movement instead of eyeballing one run.

> This is an **idea note, not committed work**. Phase 1's quality story is the CLI
> regression harness (deterministic fixtures, exit codes, event-stream assertions); an
> evaluation harness is the *statistical* complement, and it only makes sense once real
> workflows and the `--json` runner exist.

## The idea

- A **dataset** is itself a git-committed artifact (rows of `inputs` + optional expected
  outputs / assertions), versioned next to the workflow it exercises — the same
  share-by-PR mechanics as the workflow file.
- An **evaluation run** executes the workflow once per row through the normal engine
  (in-process, the same `WorkflowEngine` — never an HTTP self-call) and records per-row
  outputs, per-row cost (from the existing `CostTracker` micro-cent accounting), and
  pass/fail per assertion.
- **Scoring is deterministic-first**: schema checks, exact/regex/numeric assertions, and
  diff-style comparisons are the default scorers. An **LLM-as-judge scorer is opt-in,
  per-evaluation**, with its own model/provider declared (multi-provider, like any agent)
  and its calls metered like any other run cost — never a hidden default that silently
  multiplies spend.
- Results land in the local run history (same SQLite, new tables when designed), so the
  cost dashboard and run views can show "evaluation #N: 38/40 pass, $0.42".

## Why it fits Relavium

The two differentiators do real work here: workflows are **git objects**, so dataset +
workflow + score travel together through PRs (a reviewable quality gate, not a SaaS
dashboard); and the engine is a **library**, so evaluation runs in-process in CI exactly
like the regression harness — no server, no latency tax, no second execution path.

## Open questions

- Dataset schema (one canonical shape vs per-workflow assertion plugins).
- Where the boundary with the 2.K regression harness sits (the harness asserts the
  *engine* is correct; the eval harness asserts a *workflow* is good — they must not blur).
- Judge reliability: rubric prompts, score calibration, and whether judge verdicts need
  N-vote majority before they gate anything.
- CI ergonomics: budget caps for eval runs (ADR-0028 applies per run; an eval multiplies
  runs), and a `--json` summary shape for pipelines.

## Promotion path

If taken up, this becomes a roadmap workstream plus an ADR for the dataset/score
contracts (and any new dependency). The canonical schemas would live under
[reference/](../reference/README.md); this note then links forward.
