# Deferred tasks — confirmed review findings not yet actioned

> Status: Living

> Last updated: 2026-06-04

- **Related**: [current.md](current.md), [README.md](README.md), [phases/phase-0-foundations.md](phases/phase-0-foundations.md)

A holding pen so confirmed-but-deferred findings don't get lost. Every item here was
**adversarially confirmed** by the Phase-0 comprehensive review (97-agent workflow) but
was deliberately **not** fixed in that pass — either because it needs a maintainer decision,
is below the Phase-0 bar, or is an optimization whose risk/benefit favors waiting. None
block any Phase-0 exit criterion. Pick them up opportunistically (most fit naturally into
the Phase-1 work that first touches the file) or in a dedicated hardening pass.

Severity is the review's verified rating. Check an item off in the PR that resolves it.

## Decisions needed (maintainer call)

- [ ] **Workflow `agents:` `$ref` support** — workflow-yaml-spec.md (line 37) says
  `agents: AgentRef[]  # inline agents, or $ref to .agent.yaml files`, but
  `WorkflowSpecSchema.agents` is `z.array(AgentSchema)` (inline only); a `{ $ref: … }` entry
  is rejected (and `.strict()` makes that definite). Resolve the spec↔schema gap: either (a)
  accept `z.union([AgentSchema, z.object({ $ref: nonEmptyString }).strict()])` and handle the
  `$ref` form in the duplicate-id `superRefine` (ref-resolution stays the engine's job), or
  (b) amend the spec to drop `$ref` and resolve external agents only via a node's `agent_ref`
  + the workspace registry. A product/contract decision. *(major→decision · workflow.ts:103,
  workflow-yaml-spec.md:37)*
- [ ] **Branded id types** — `runId`/`nodeId`/`gateId`/`workflowId`/`agentId` are all plain
  `string`, mutually assignable across the platform. Introduce `z.string().brand<'RunId'>()`
  etc. for ids that cross APIs, or record an ADR/code-style note that plain strings are a
  deliberate choice. *(minor · packages/shared/src/run.ts, node.ts)*
- [ ] **`LICENSE` file + root `license` field** — the public repo has neither. Add a
  `LICENSE` matching HodeTech's intent (proprietary `UNLICENSED` or an OSS license) and set
  the root `package.json` `"license"`. *(nit · package.json, repo root)*
- [ ] **`node:started.nodeType` enum vs free string** — currently an unconstrained
  `nonEmptyString`. Decide whether the SSE event should carry the engine node-type enum
  (add `ENGINE_NODE_TYPES` to constants and `z.enum(...)`) or stay free-string for
  forward-compat, and record the choice. *(nit · packages/shared/src/run-event.ts:47)*
- [ ] **`MaskedSecret` named contract** — `run:started.inputs` documents secret masking only
  in a comment. Export a `MaskedSecret` type/schema (`{ secret: true; ref: string }`) so the
  masked shape is a named contract every surface renders. *(nit · run-event.ts:39)*
- [ ] **`composite`/project references (reconcile 0.B)** — phase-0-foundations.md 0.B calls
  for `composite`/project-reference tsconfig fields that were not implemented. Either add a
  `packages/*` library base with `composite: true` + `references` (db → shared) and build via
  `tsc -b`, or record that turbo `^build`-ordering is the deliberate final design and update
  the 0.B callout. *(minor · tsconfig.base.json, packages/*/tsconfig.json)*

## Schema / validation hardening

- [ ] **`z.unknown()` payload presence** — `agent:tool_call.toolInput`, `node:completed.output`,
  `human_gate:resumed.payload` validate even when absent. Decide presence per field (force the
  key via a `.superRefine` hasOwnProperty check, or document absence is OK) and add accept/reject
  tests. *(minor · run-event.ts:64,93,124)*
- [ ] **Standalone `MergeNodeSchema` gap** — `merge_strategy:custom` without `merge_fn` only
  fails at `WorkflowSchema` level (a discriminated-union member can't carry the cross-field
  rule). Document the partial node-level validation and add a `node.test.ts` case pinning the
  gap as intentional. *(minor · node.ts:85-92, workflow.ts:104-113)*
- [ ] **O(n²) duplicate-id check in `AgentSchema`** — uses `indexOf`-in-`filter` while
  `workflow.ts` uses an O(n) `Set`. Reuse a shared `reportDuplicates` helper so both schemas
  share the single O(n) implementation. *(nit · agent.ts:109-110)*
- [ ] **Per-provider temperature ranges** — the shared `temperatureSchema` is the
  provider-agnostic `[0, 2]` envelope, but Anthropic accepts only `[0, 1]`. Enforce/clamp the
  provider's real range in the `@relavium/llm` adapter (Phase 1, where request validation
  lives) so a `provider: anthropic` + `temperature > 1` agent fails fast — without coupling the
  shared contract to a provider's current API limit. *(review · agent.ts, common.ts)*

## Test depth

- [ ] **Column-level schema fidelity** — `client.test.ts` proves only that table *names* exist.
  Add a `PRAGMA table_info(<table>)` assertion per table (name/type/notnull/dflt/pk) against an
  expected fixture, or snapshot `0000_*.sql` byte-for-byte. *(minor · packages/db/src/client.test.ts)*
- [ ] **Negative FK test** — insert a `step_executions` row with a non-existent `run_id` and
  assert `/FOREIGN KEY constraint failed/i`, proving `foreign_keys = ON` actually rejects.
  *(minor · packages/db/src/client.test.ts)*
- [ ] **dist-resolution packaging test** — the migration runner is tested only from `src/`; add
  a smoke test that imports built `dist/index.js` and runs `runMigrations` (the path consumers
  use). *(minor · packages/db/src/client.test.ts)*
- [ ] **In-memory `journal_mode` assertion** — if/when asserting the WAL no-op for `:memory:`,
  assert its `journal_mode` is `'memory'`. *(nit · client.test.ts:50-53)*
- [ ] **Edge `from`-handle grammar** — the handle is permissive (uppercase/spaces/repeated
  colons). Decide + pin the grammar (`a:` empty handle rejects; decide on `a:UPPER`/`a:a:b`) and
  tighten the regex if needed. *(minor · edge.ts:14-19, edge.test.ts)*
- [ ] **Condition/transform invariants** — add tests: reject `default:'Not Kebab'`; accept
  `when:'foo'`/`when:7`; reject empty `transform`/`expression`. *(minor · node.test.ts)*
- [ ] **`record()` non-object reject** — assert `RunSchema.safeParse({ ...run, inputs: 'x' })`
  rejects, pinning the record boundary. *(nit · run.test.ts, run-event.test.ts)*
- [ ] **Round-trip fixture verbatim** — the workflow no-drift fixture paraphrases multi-line
  prompts; transcribe them verbatim from the spec or soften the "verbatim" claim. *(nit · workflow.test.ts)*

## Tooling / CI

- [ ] **Turbo task `inputs`** — `lint`/`typecheck`/`test` declare no `inputs`, so turbo hashes
  every file (over-invalidation). Scope inputs to the files each task reads (kept as the safe
  default for now to avoid cache-staleness risk). *(minor · turbo.json:19-30)*
- [ ] **`incremental` tsconfig** — no `.tsbuildinfo` reuse; every `tsc` recompiles from scratch.
  Add `incremental: true` (gitignored `tsBuildInfoFile`, listed in turbo `outputs`). *(minor · tsconfig.base.json)*
- [ ] **Typecheck the config files** — root/package-root `*.config.ts` (drizzle/vitest) are
  neither typechecked nor linted. Add a `tsconfig.tools.json` + `typecheck:tools` step, or
  document the gap as an accepted boundary. *(minor · drizzle.config.ts, vitest.config.ts)*
- [ ] **Concurrency head-ref grouping** — `main` is now protected from cancellation, but a
  same-repo branch push and its open PR still run CI under separate groups. Consider
  `group: ci-${{ github.workflow }}-${{ github.head_ref || github.ref }}` to collapse them.
  *(minor · ci.yml:19-27)*
- [ ] **`engine-strict=true`** — `engines` is advisory; add `engine-strict=true` to `.npmrc` so
  an unsupported Node/pnpm fails install fast. (Weighed against breaking fresh checkouts on a
  slightly-off Node — decide deliberately.) *(minor · .npmrc, package.json)*
- [ ] **Local `format:check` via turbo** — CI now runs `turbo run format:check`; consider routing
  the root `format:check` npm script through turbo too so local + CI share the cache. *(minor · package.json:21)*

## Docs

- [ ] **Node-runtime row in tech-stack.md** — `runbooks/local-dev-setup.md` defers the Node
  version to tech-stack.md, which states none. Add a row (`.nvmrc` = dev/CI 22; supported floor
  20.11 per `engines`). *(minor · tech-stack.md)*
- [ ] **WAL single-writer wording** — soften database-schema.md "concurrent read performance" to
  make the single-writer constraint explicit so engine authors design `run_events` writes around
  one writer. *(minor · database-schema.md)*
- [ ] **`vitest.config.ts` include comment** — the stated rationale is inaccurate; rewrite it to
  the real reason (pin to `*.test.ts` so a stray `*.spec.ts` surfaces). *(minor · vitest.config.ts:16-18)*
- [ ] **`constants.ts` header overstatement** — clarify that providers/execution-modes are
  consumed by `z.enum`, while event names/node types are a parallel authoritative list the unions
  re-declare and tests pin. *(nit · constants.ts)*
- [ ] **`RetrySchema` cross-dep note** — note at the `node.ts` import that `RetrySchema` is owned
  by `agent.ts` and the dependency is one-way (agent.ts must never import node.ts). *(nit · node.ts:1-4)*
- [ ] **`cumulativeCostMicrocents` comment** — append the run-scope "running total for the whole
  run" note to match the spec. *(nit · run-event.ts:84)*
- [ ] **Per-variant event-type export consolidation** — 3 inline + 10 in a trailing block; either
  co-locate all inline or annotate the trailing block so it isn't read as exhaustive. *(nit · run-event.ts)*

## Packaging

- [ ] **Shipped source maps reference `../src`** — published `dist/*.map` point at `src/`, which
  isn't in `files`. Either add `"src"` to `files` or drop `declarationMap`/`sourceMap` from the
  `*.build.json`. Bounded by `private: true` for now. *(nit · tsconfig.base.json, package.json `files`)*
