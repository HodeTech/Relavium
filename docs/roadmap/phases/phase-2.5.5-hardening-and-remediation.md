# Phase 2.5.5 — Hardening and Remediation

> Status: 🚧 **Open — Wave 2 Steps 1–8 and review corrections merged to main as PR #94 (2026-10-15); later waves remain open.** Live progress and execution order are canonical in
> [../current.md](../current.md#execution-order--phase-255--phase-26-temporary); this banner does not
> restate them. A full-project multi-agent code review completed
> 2026-07-19 at HEAD `f88b0e8` — 377 findings, 373 surviving two-lens adversarial
> verification (one agent per finding tried to refute it against the code, a second audited
> its materiality). The toolchain was green throughout (lint, typecheck, all 226 test files
> passing), so every finding is a defect a green build cannot catch. The findings were
> triaged into a 231-item baseline, then consolidated to **205 work items** (22 merges
> absorbing 48 originals, 1 split separating a mis-bundled finding), with full 373-finding
> coverage re-verified programmatically (0 missing, 0 duplicated). This file holds the items
> that are not a natural fit for an open Phase 2.6 workstream.
>
> **Authority (until Phase 2.5.5 and Phase 2.6 close):** [`current.md`](../current.md) is canonical for
> live progress and execution order; the phase documents stay canonical for scope and acceptance. Ordering
> differences between the two are deliberate. `current.md` may override recommended ordering — it may **not**
> redefine a security boundary, a scope line, or a milestone acceptance criterion.

- **Related**: [phase-2.5-cli-consolidation.md](phase-2.5-cli-consolidation.md), [phase-2.6-conversational-authoring.md](phase-2.6-conversational-authoring.md), [../current.md](../current.md), [../deferred-tasks.md](../deferred-tasks.md), [../../standards/error-handling.md](../../standards/error-handling.md), [../../standards/security-review.md](../../standards/security-review.md), [../../standards/testing.md](../../standards/testing.md), [../../standards/logging-and-observability.md](../../standards/logging-and-observability.md), [../../standards/documentation-style.md](../../standards/documentation-style.md), [../../standards/architectural-principles.md](../../standards/architectural-principles.md), [../../decisions/README.md](../../decisions/README.md)

A remediation phase, not a feature phase: it closes out the review's 373 verified findings
against the code that already ships — Phases 0 through 2.5, plus the two Phase 2.6
workstreams already merged (2.6.C, 2.6.F). Its central finding is that the gap to
first-class is a gap in **propagation, not competence**: the correct pattern almost always
already exists in the repo and simply never reached the next site — a redaction helper not
called twenty lines away, terminal sanitization built for chat and never carried to
`relavium run`, `withBusyRetry` applied to every writer but the three oldest, cancel-wins
implemented in four node handlers and omitted in the fifth. That makes each item cheap and low-risk **individually** — the reference implementation is already in-tree
at nearly every site — while the set is collectively **high-coordination-risk**: 176 items across ~40 files
shared with an active Phase 2.6, five intra-phase file overlaps with a required landing order, and ~14
maintainer decisions — while a small number of items are genuine CRITICAL defects (a secret leaking into a
persisted approval preview, an unhandled rejection that can crash the CLI mid-turn, an
unsanitized terminal-injection hole on `relavium run`) that justify treating this as its own
phase rather than a backlog label.

## Positioning

The number **2.5.5 expresses lineage, not sequence**. This work belongs to the Phase 2.5
(CLI Consolidation) / pre-2.6 consolidation era **in subject matter** — every finding is a
defect in code that shipped in Phase 0–2.5 or in the two Phase 2.6 slices already merged
(2.6.C, 2.6.F) — not a claim that it must complete before Phase 2.6 continues. **Phase 2.6
remains ACTIVE throughout this phase**; workstreams 2.6.A/B/D/E/G/H/I/J/K/L/M/N/O/P keep
moving in parallel, and nothing in 2.5.5 blocks a 2.6 workstream unless a work item says so
explicitly. A separate branch, review cadence, and release train from Phase 2.6 is expected
— this is not a gate in front of it.

Three narrow sequencing preferences are called out inline, not as hard blocks: the
`chat.ts` and `home-controller.ts` decompositions in **2.5.5.I** recommend landing before
2.6.G and 2.6.E add substantial new code to those same two files; the authoring run-path
tool-preflight finding is filed as a **2.6.A** work item directly rather than a 2.5.5 one,
specifically so 2.6.A absorbs its own fix. Everything else in this phase is safe to land in
any order relative to Phase 2.6, including fully concurrently with it.

Of the 373 findings, **327 (176 work items)** land here. The rest went elsewhere:
**27 findings (16 work items)** turned out to be genuine, well-scoped extensions of an OPEN
Phase 2.6 workstream's own stated charter (not force-fits) and were routed there instead;
**16 findings (10 work items)** were already recorded in [../deferred-tasks.md](../deferred-tasks.md) or
[../current.md](../current.md) under a real citation and were re-confirmed rather than
duplicated; **3 findings** required no action per the finding's own argument and were consciously
declined. All three groups are recorded with their disposition in the traceability appendix
below. No sub-stream in this phase has a genuine hard code-level dependency on another
completing first — each is centred on its own subsystem (`packages/core`, `packages/llm`,
`packages/db`, `packages/mcp` + secrets, `apps/cli`'s process layer, `apps/cli`'s TUI layer,
`docs/`, cross-cutting hygiene, and the CI/tooling substrate). The sub-streams are **not**,
however, fully file-disjoint, so "any order" holds between disjoint queues rather than across
the phase as a whole. Ownership is not pairwise: `home-controller.ts` and `chat.ts` are each edited
from **four** sub-streams (E, F, G and I), `chat-ink.tsx` from three (E, G, I), and `viewport.ts` and
`client.ts` from two each. The operative rule that falls out is short — **2.5.5.I lands last on every
god-file**, because its work is decomposition and everything else is edits that decomposition would
otherwise have to re-apply. The five bullets below record the landing order for the overlaps the review
surfaced; they are not a proof of completeness, so the standing discipline is to **compare the file list
in a bullet's `(S/M/L · files · findings)` trailer against the other sub-streams before parallelizing
anything**:

- **2.5.5.C ↔ 2.5.5.E on `packages/db/src/client.ts`** — C gives `createClient` a typed error and
  corrects its PRAGMA docstring (`#104`, `#105`); E moves the wrap-and-redact logic inside
  `openLocalDb` across 8+ call sites (`#278`, `#280`). **E's item lands last**, since it rewrites the
  error path C types.
- **2.5.5.E ↔ 2.5.5.I on `apps/cli/src/render/tui/home-controller.ts` and `chat-ink.tsx`** — E adds the
  `selectGatePrompter` test (`G37`), the swallowed-rejection comment (`#281`) and the
  `const exhaustive: never` sweep (`#300`, `#301`, `G3`); I decomposes `createHomeController`
  (`#215`, `#243`) and applies the min-terminal-size guard (`#63`). **E's items land first**, so the
  decomposition moves already-guarded code.
- **2.5.5.F ↔ 2.5.5.I on `home-controller.ts`** — F wires Home's `showCost` past its no-op (`#125`),
  which edits a line *inside* the function I dissolves (`#215`, `#243`). **F lands first.**
- **2.5.5.G ↔ 2.5.5.I on `apps/cli/src/commands/chat.ts`** — G replaces the hand-rolled money helpers
  (`#236`, `#307`) and renames `swapAgentModel` (`#218`); I decomposes the file (`#220`, `#244`).
  **G lands first**, so the decomposition moves already-canonical code.
- **2.5.5.G ↔ 2.5.5.I on `apps/cli/src/render/tui/viewport.ts`** — G makes width measurement
  tab-aware (`#65`); I caches per-cluster widths and debounces resize invalidation (`#64`, `#66`).
  Both rewrite `graphemeWidth`. **G lands first**, so the cache is built over the corrected measure.

Everything else may proceed concurrently. The cross-phase file-ownership preferences are separate
and are called out under [Positioning](#positioning).

## Goal

Close the review's 373 verified findings against the code that ships today, without adding
new product surface area: every item in this phase is a correctness, safety, or hygiene fix
to already-shipped code, applying an existing in-tree pattern to the site(s) it never
reached.

## Outcomes (Definition of Done)

- All three CRITICAL findings — the unredacted secret in the persisted tool-approval preview
  (`#91`, `packages/core/src/tools/registry.ts`'s `previewFor()`), the chat persister's
  unhandled-promise-rejection crash path (`#228`, `apps/cli/src/chat/persister.ts`), and the
  unsanitized `relavium run` TUI (`#56`, `apps/cli/src/render/tui/RunApp.tsx`) — are closed and
  regression-tested. `#56` lands with 2.5.5.I rather than 2.5.5.A/C, so it certifies under M2.5.5-2.
  > **`#56`'s severity is contested and needs a maintainer ruling.** The traceability appendix below —
  > the only classification that ships in git — records it `critical`, and this file follows it. The
  > untracked review corpus's executive summary argues the corpus's real critical count is **2**, on the
  > grounds that `#56`'s verifier recommended `high` and the aggregate severity field never picked the
  > correction up. Nothing downstream changes either way: `#56` is scheduled in Wave 1 and gated by exit
  > criterion 2's security review regardless. Rule it once, then make the appendix, the exec summary and
  > this bullet agree.
- `relavium run`'s TUI, the persisted run summary, the universal error boundary, and the
  human-gate approval card all sanitize dynamic/model-controlled text the same way chat
  already does — a security review confirms the injection class is closed.
- MCP tool definitions ride the same untrusted-content boundary as MCP call results (or the
  gap is explicitly documented); every MCP transport has a real connect-phase timeout; a
  hostile MCP server cannot exhaust process memory.
- SQLite writes on the hot chat/run paths are retry-wrapped and no longer block the event
  loop synchronously; a two-process migration race no longer crashes either process.
- The three `@relavium/llm` adapters share identical error-classification, streaming, and
  schema-depth guards, proven by shared fixture tests; the vendor SDK's own retry is
  disabled so `FallbackChain` is the sole, visible retry authority.
- The CLI's outermost safety net — SIGINT/SIGTSTP teardown, the crash/error boundary,
  `--version`/`--help` startup latency — behaves the same on every command that reaches it,
  not just the ones it was first built for.
- No canonical doc names a retired data source as authoritative, claims an unbuilt surface
  is shipped, or carries a roadmap status banner that contradicts the file it summarizes.
- Every maintainer-decision item in this phase (retention policy, `--verbose`/`--quiet`
  precedence, the `default_headers` plaintext-secret design, and others named in the work
  breakdown below) has a recorded ruling before its implementation lands.
- `pnpm run ci` stays green throughout — it is `pnpm run ci`, never `pnpm ci` (pnpm reserves `ci` as a
   builtin) — and so do both required `ci.yml` checks, the `ci` job including its compiled-binary smoke and
   the `coverage` job (`pnpm coverage:enforced`); no item in this phase widens
  the `LLMProvider` seam, adds a platform import to `packages/core`, or changes the
  `--json`/CI machine-output contract ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)).

## Scope

### In scope

- The 176 work items enumerated in the nine sub-streams below (2.5.5.A–I), each a fix,
  hardening pass, test-coverage close, or documentation correction against code that
  already ships in `packages/core`, `packages/llm`, `packages/db`, `packages/mcp`, `apps/cli`,
  or `docs/`. These are the in-scope subset of the 205 triaged work items; the other 29 are
  routed to Phase 2.6, re-confirmed in [../deferred-tasks.md](../deferred-tasks.md), or
  declined — see [Explicitly out of scope](#explicitly-out-of-scope).
- The handful of maintainer-decision items each sub-stream calls out explicitly as
  **blocked** — resolving those decisions is itself in scope for this phase, even where the
  resulting implementation is small.
- Coordinated, mechanical sweeps that touch many call sites for one root cause (a redaction
  helper, an exhaustiveness guard, a sanitization boundary) — explicitly *not* treated as
  out-of-scope "large refactors," since the fix pattern in each case already exists in-tree.

### Explicitly out of scope

- **27 findings (16 work items)** that are genuine, well-scoped extensions of an already-OPEN Phase 2.6
  workstream's own stated charter — routed there instead of duplicated here. The concrete
  example: the authoring run-path tool-preflight finding is filed directly as a **2.6.A**
  work item (`packages/authoring` promotion + catalog-aware pre-flight) rather than a
  2.5.5 one. See [phase-2.6-conversational-authoring.md](phase-2.6-conversational-authoring.md)
  and the traceability appendix below for the full routing.
- **16 findings (10 work items)** already recorded in [../deferred-tasks.md](../deferred-tasks.md) or
  [../current.md](../current.md) under a real citation from an earlier triage pass — these
  were re-confirmed against the current code during this review, not duplicated into a new
  entry here.
- **3 findings** consciously declined: each required no action per the finding's own
  argument once checked against the current code (a design already correct, a residual
  already accepted elsewhere). Recorded with rationale in the traceability appendix below.
- Anything requiring code in `apps/desktop`, `apps/vscode-extension`, `packages/ui`,
  `apps/api`, or `apps/portal` — all six are empty scaffolds or non-existent directories;
  no finding in this review's near-term allocation targets them.
- **No net-new product capability** — no new tool, node type, or seam capability; every item is a fix to
  something that already ships. It does change a small, enumerated set of **public CLI contracts** as
  remediation: noun-verb aliases for `chat-resume`/`chat-list`/`chat-export` (`#309`), a confirmation /
  `--force` gate on `provider remove-key` (`#19`), a dedicated exit code for an unclassified internal
  fault (`G35`), `--help --json` (`#13`), and the `--quiet`/`--verbose` precedence (`#45`). The exact compatibility changes, including deliberate exit/consent/debug changes,
  are approved in [ADR-0110](../../decisions/0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md);
  they are not all merely additive. Each lands with its canonical CLI reference update.

## Work breakdown

### 2.5.5.A — Engine-core hardening: cancellation, backpressure, schema validation & the budget governor

`packages/core` and `packages/shared` — the propagation-gap sweep across the workflow/agent engine itself. The pattern repeats with almost mechanical regularity: a redaction call, an `AbortSignal` check, a `superRefine` invariant, or a `findDuplicates` dedup exists at one call site and was simply never carried to its structurally identical sibling a few lines or one file over. Because the fix is "do what the neighboring code already does," this is cheap, low-risk work with the reference implementation already in-tree — the risk is entirely in scope discipline, not design. The budget governor gets its own cluster below: a genuine concurrency gap (no reservation step under `max_parallel`), plus quality/consistency gaps in its warnings and error taxonomy.

**Tasks:**

- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #91 · `rawPreviewFor` keeps the classification copy, `previewFor` scrubs the display copy).** **Redact tool-approval previews like `sanitizeInput()` already does.** `previewFor()` (`packages/core/src/tools/registry.ts:436`) builds the persisted, `--json`-visible `ToolActionPreview` by echoing `target.command`/`target.path` verbatim, never calling the `redactSecretShapedValue` scrub that its sibling `sanitizeInput()` (same file, line 563) applies to `toolInput` moments later in the same dispatch. A live credential in a `run_command` arg or `write_file` path is written unredacted into the durable, persisted `agent:approval_requested` event. Call the same redaction helper in `previewFor()` before the preview is built. This is the review's canonical propagation-gap example and should land first. *(S · `packages/core/src/tools/registry.ts` · #91)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — G38 · `reservedAdmissions` ledger in `budget-governor.ts`).** **Add a reservation/admission step to `BudgetGovernor`'s pre-egress check.** `checkPreEgress` (`packages/core/src/engine/budget-governor.ts`) is a pure read against a snapshot that is only updated post-hoc after `cost:updated` lands, with no reservation/admission-control step — two or more parallel agent-node branches under `max_parallel` can each pass `checkPreEgress` against the same stale snapshot, letting the sum exceed `max_cost_microcents` even with `on_exceed:'fail'`. Add an in-flight reserved-cost ledger that is checked and updated atomically at dispatch time, and add a test combining budget + `max_parallel` (none exists today). *(L · `packages/core/src/engine/budget-governor.ts` · G38)*
- ✅ **DONE (Phase 2.6.5 `CR-22`, 2026-08-27)** — closed early, out of wave order, because `W2`'s liveness item owns the same function. **Compute the remaining timeout budget on every resume instead of re-arming a fresh timer.** `#armRunTimeout` (`packages/core/src/engine/engine.ts`) re-arms a full-duration timer on every checkpoint/gate/media-job resume instead of computing remaining budget from `#elapsedMs()`, unlike the checkpoint's own `startEpochMs` and the media-job absolute-deadline pattern it should mirror — a workflow with `timeout_ms` can run far longer than authored if it pauses and resumes repeatedly. Fix `#armRunTimeout` to compute the remaining budget from elapsed wall-clock time on every re-arm. *(M · `packages/core/src/engine/engine.ts` · #75)*
- **Thread the missing `AbortSignal` into `resolvePrompt` and recheck cancellation in `human-gate.ts`.** `resolvePrompt` (`packages/core/src/engine/agent-runner.ts:868`) omits the `AbortSignal` that every other call site passes into `resolveTemplate`, so cancellation during prompt-template resolution is not observed. Separately, `human-gate.ts` (`packages/core/src/engine/node-handlers/human-gate.ts`) is the one node handler doing real async work yet has no post-resolution `ctx.signal.aborted` recheck before returning `'paused'` — a cancelled run can emit `human_gate:paused` right before `run:cancelled`. Add the signal to `resolvePrompt` and the recheck to `human-gate.ts` in one pass. *(M · `packages/core/src/engine/agent-runner.ts`, `packages/core/src/engine/node-handlers/human-gate.ts` · #76, G9)*
- ✅ **DONE ([Wave 3 Step 2](#wave-3-step-2-acceptance--2026-10-16)).** **Extract a shared `messageFor` diagnostic helper for `parser.ts` and `agent-parser.ts`.** `parser.ts`'s `messageFor` has no case for Zod's `invalid_literal` code, so a `schema_version` mismatch reports only "invalid value" with no expected-value indication. `agent-parser.ts`'s `AgentParseError` carries only field paths, never reason text, so distinct error kinds report identically on the `.agent.yaml` authoring surface — a gap distinct from 2.6.B's visibility-wiring task. Extract `messageFor` into a schema-agnostic helper consumed by both `parser.ts` and `agent-parser.ts`. *(M · `packages/core/src/parser.ts`, `packages/core/src/agent-parser.ts` · #85, #86)*
- **Reconcile `system_prompt_append`'s documented interpolation with its verbatim-append implementation.** `workflow-yaml-spec.md` documents `system_prompt_append` as an interpolation target, but `agent-runner.ts` appends it verbatim by design (ADR-0038 anti-injection), while `packages/core/src/dag.ts` still wires it into real scheduling/taint-scan sites — an author using `{{ }}` there gets literal unresolved text sent to the model with zero error. Fix by either correcting the spec or adding a parse-time rejection of `{{ }}` syntax in that field. *(M · `packages/core/src/engine/agent-runner.ts`, `docs/reference/*/workflow-yaml-spec.md` · #87)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — G39/G47/G49 · `warningArmed` re-arm + projected `thresholdPct`).** **Re-arm `budget:warning` on continued overage and compute `thresholdPct` from the projected post-call total.** `#warningEmitted` (`packages/core/src/engine/budget-governor.ts:112`) is a one-shot lifetime boolean, so a long-lived `AgentSession`/chat process gets exactly one `budget:warning` ever and then silently proceeds no matter how far over cap spend climbs. Separately, `thresholdPct` is computed from pre-call cumulative spend rather than the projected post-call amount, so a single large call that jumps past the cap reports a near-0% warning. Fix both in the same pass: re-arm the warning on continued overage, and derive `thresholdPct` from the projected post-call total. *(M · `packages/core/src/engine/budget-governor.ts` · G39, G47, G49)*
- **Give `assertNoTaintedArgs()` an actual producer for `ctx.secretArgKeys`.** `ctx.secretArgKeys` — the runtime ADR-0029(c) taint-check input that `assertNoTaintedArgs()` (`packages/core/src/tools/registry.ts`, `packages/core/src/tools/types.ts`) correctly enforces when present — has no producer anywhere in the engine, so the check is inert everywhere, including on the `AgentSession`/chat path with no static-analysis backstop. Either wire a producer that actually populates `ctx.secretArgKeys`, or explicitly record this as a tracked, known gap in the ADR. *(M · `packages/core/src/tools/registry.ts`, `packages/core/src/engine/agent-session.ts` · #92)*
- **Cap `write_file.content`, `http_request.body`, `run_command.args`, and `git_commit.message` at a schema-level max length.** These four fields carry no length ceiling in `builtins.ts`'s Zod schemas despite heavy investment in bounding tool *output* — an oversized model-driven payload reaches dispatch and an unbounded regex redaction scan with no schema-level circuit breaker. Add a generous max-length ceiling on each field that won't break legitimate large writes. *(M · `packages/core/src/tools/builtins.ts` · #95)*
- **Rewrite `llmVisibleParams` descriptions across the built-in tool set.** No built-in tool's `llmVisibleParams` schema has per-property descriptions (byte-vs-line ranges, glob dialect, argv-vs-shell-string semantics are left to the model's guess), and several descriptions leak engineer-facing implementation vocabulary (`shell:false`) instead of actionable denial-recovery guidance. One clustered rewrite pass over `builtins.ts`'s tool descriptions, distinct from 2.6.M's new-tool scope. *(M · `packages/core/src/tools/builtins.ts` · #96, #98)*
- **Remove cycle-guard `WeakSet` entries on recursion unwind.** `redactInlineMediaForText`/`redactSecretShapedWalk` (`packages/core/src/tools/bounding.ts`) add to the shared cycle-guard `WeakSet` but never remove on the way back out of recursion, so any object referenced twice non-cyclically renders as a bogus `[cyclic]` in observability output. Remove the object from the `WeakSet` when recursion unwinds and add a regression test. *(S · `packages/core/src/tools/bounding.ts` · #94)*
- **Decide the real backpressure granularity for `RunHandle` and `SessionHandle` in one pass.** `RunHandle.whenConsumersReady()` (`packages/core/src/engine/run-handle.ts`) is only awaited once per node dispatch, never within a single node's own streaming duration, so a long token/reasoning stream against a stalled consumer buffers unboundedly. `SessionHandle.whenConsumersReady`/`whenDrained` (`packages/core/src/engine/session-handle.ts`) is implemented identically but has zero callers anywhere. Decide and implement the actual granularity needed for both handles together. *(M · `packages/core/src/engine/run-handle.ts`, `packages/core/src/engine/session-handle.ts` · #77, G48)*
- **Unescape the quoted filter-argument text `parseArg` returns.** `parseArg` (`packages/core/src/interpolation/references.ts`) returns the raw backslash-escaped text of a quoted filter argument instead of unescaping it, contradicted by its own test's comment. Fix `parseArg` to unescape the quoted argument text per its documented contract, and correct the misleading test comment. *(S · `packages/core/src/interpolation/references.ts` · #82)*
- ✅ **DONE ([Wave 3 Step 2](#wave-3-step-2-acceptance--2026-10-16)).** **Apply consistent duplicate/cross-field admission; certify existing input and session guards.** Shared leaf/full admission now enforces the approved duplicate, human-gate timeout and logical Run status matrices. Existing input defaults/enums and session compaction-role rules are certified. Historical session/workflow readers retain their former contracts; no rows are migrated or silently repaired. *(M · `packages/shared/src/{node,agent,workflow,session,run,common}.ts` · #89, #90, G18, #212, G16, G17, #210, #211)*
- **Extend `analyzeSecretTaint`'s leak-reporting loop to cover context-value sites.** `analyzeSecretTaint` (`packages/core/src/interpolation/analyze.ts`) deliberately skips context-value sites in its leak-reporting loop, so a direct `{{secrets.*}}` reference never read elsewhere is not reported at parse time — the workflow only fails later, differently-shaped, at run start. Not an actual secret leak, but a real completeness gap in the "reject before a run starts, uniformly" contract. *(S · `packages/core/src/interpolation/analyze.ts` · G22)*
- ✅ **DONE ([Wave 3 Step 4](#wave-3-step-4-acceptance--2026-10-16)).** **Retain and validate the public event envelope without stripping full payloads.** `BaseEventSchema` shares the full run family's parsed exactly-one-correlation check; `BaseEvent` and `HumanGateEvent` remain exported. Complete payload, strict accounting, lenient opposite-key and stored forward-reader contracts are preserved. *(S · `packages/shared/src/run-event.ts` · #213)*
- **Correct `ctx.fsScope`'s wiring, blocked on a maintainer call.** `ctx.fsScope` is threaded through every dispatch context in `packages/core/src/tools/{types,registry,builtins}.ts` and `packages/core/src/engine/agent-session.ts`, but `enforcePolicy()` (`packages/core/src/tools/registry.ts`) has no `fsScoped` branch and no `FsCapability` method signature accepts it. **Blocked on a maintainer decision**: is this a deliberate "one host instance = one immutable scope" design, in which case only the doc comment needs correcting, or should it be threaded into `FsCapability`'s method signatures to support future per-turn scope escalation? *(S · `packages/core/src/tools/registry.ts` · #93)*
- **Correct three stale engine doc comments to match current code.** `checkpoint.ts`'s module doc (`packages/core/src/engine/checkpoint.ts`) claims a "runId+nodeId+retryCount idempotency key" bounds resumed side effects; no such key exists. `builtins.ts`'s top comment still says egress is "not wired yet"; it shipped. `workflow-yaml-spec.md` documents `workflow.version` as Semver-format-enforced; `WorkflowSpecSchema` enforces no format. One sweep correcting each. *(S · `packages/core/src/engine/checkpoint.ts`, `packages/core/src/tools/builtins.ts`, `docs/reference/*/workflow-yaml-spec.md` · #78, #97, #214)*
- **Remove the dead `RunEventBusOptions.validate` escape hatch and replace `kahnOrder`'s full re-sort with a priority structure.** `RunEventBusOptions.validate` (`packages/core/src/engine/event-bus.ts`) is documented as a hot-path escape hatch but no caller ever sets it — dead config, negligible cost today. `kahnOrder` (`packages/core/src/dag.ts`) re-sorts the entire ready-list on every pop instead of using a priority queue, also negligible at today's node counts. Both essentially-free cleanups; batch into one pass and revisit priority-queueing only if 2.6.P's subworkflows push node counts up. *(S · `packages/core/src/engine/event-bus.ts`, `packages/core/src/dag.ts` · #274, #275)*
- ✅ **DONE ([Wave 3 Step 4](#wave-3-step-4-acceptance--2026-10-16)).** **Introduce minimal shared native error ancestry while retaining each family's contract.** The current export-scoped inventory replaces the historical 15/17 estimate: 46 roots across 37 files reach 83 module-exported production classes, with the additional unchanged private timeout descendant recorded separately. Constructors, names, discriminants, context/cause and structural/private-authority guards are preserved. *(M · `packages/shared/src/relavium-error.ts` and existing package families · #219)*
- **Chat-to-workflow export hardening: continuity caveat and non-ASCII slug fallback; certify existing tool-content exclusion.** W7/PR #90 and Accepted [ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) structurally exclude model-issued tool arguments/results from durable session rows and exported scaffolds. The earlier raw-tool-result export claim and its proposed opt-in/redaction decision are superseded by that contract; do not add a raw-content flag. Wave 2 still adds a clear continuity/review notice and deterministic ASCII title normalization with a session-identity fallback. Retained user/assistant text, `@` attachments and `!` output can remain sensitive: this is not universal transcript masking. Certify producer→SQLite→export rejection fixtures with #115; the [Wave 2 decision package](#decisions-presented-together-before-implementation) records D14/D15. *(M · `packages/core/src/export/serializer.ts` · #80, #81, #83)*
- **Give `BudgetExceededError`/`BudgetPauseError` a `.code` field, blocked on a maintainer call.** These two errors (`packages/core/src/engine/budget-governor.ts`) expose no `.code`, unlike `EngineStateError`/`RunLoopInvariantError` in the same directory that `docs/standards/error-handling.md` names as the canonical model. Not a functional bug today. **Blocked on a maintainer decision**: should these errors adopt the `.code` convention, or is `instanceof`-narrowing an accepted exception for this pair? *(S · `packages/core/src/engine/budget-governor.ts` · G50)*
- **Collapse two always-co-occurring branches in `engine.ts`'s `#dispatch` retry-sleep handling.** Purely cosmetic dead-code/maintenance-trap: two branches that always co-occur, one unreachable dead weight. No behavioral bug, but real, trivially-scheduled cleanup. *(S · `packages/core/src/engine/engine.ts` · #79)*

**Acceptance:** the CRITICAL `previewFor()`/approval-preview secret leak is closed and verified against a `run_command`/`write_file` fixture containing a fake credential; `BudgetGovernor` rejects a concurrent-branch overspend under `max_parallel` in a new test exercising the reservation ledger; `#armRunTimeout` computes remaining budget on every resume rather than re-arming full duration; cancel-signal propagation reaches `human-gate.ts` and `resolvePrompt`, and backpressure propagation reaches `SessionHandle`; `parser.ts` and `agent-parser.ts` share one `messageFor`-derived diagnostic helper; `findDuplicates`/`superRefine` are applied at every one of the seven named remaining schema sites across `node.ts`, `agent.ts`, `workflow.ts`, `session.ts`, and `run.ts`; the cycle-guard `WeakSet` leak in `bounding.ts` is fixed with a regression test; no engine-core doc comment contradicts the code it describes; the two blocked items (`BudgetExceededError`/`BudgetPauseError`'s `.code` field, and the export-serializer's redaction/warning scope for embedded `tool_result` content) have a maintainer ruling recorded before either lands.

### 2.5.5.B — LLM adapter & catalog money-safety hardening

`packages/llm` is a three-adapter seam (`anthropic.ts`/`openai.ts`/`gemini.ts` plus the shared `tool-normalizer.ts` and `fallback-chain.ts`) and an already-shipped ADR-0071 catalog money-guard apparatus (`snapshot.ts`, `snapshot-guard.ts`, `model-kind.ts`, `models-dev-schema.ts`). The dominant defect shape here is the review's central propagation gap in miniature: a correctness or safety check — an error-classification short-circuit, a streaming guard, a schema-depth DoS check, a cooldown memory — lands on one or two adapters and is never carried to the third, or a money-guard is added for one numeric field and never extended to its siblings. A second, smaller cluster is real dead weight (unreachable fallbacks, untested paths, stale comments) that costs nothing to fix and only adds risk if left to rot into a future "simplification." Because this package sits directly on the cost-tracking and provider-failover path, the highest-value bullets below are retry/backoff correctness and the adapter-parity sweep — both change what actually gets billed and how failures are surfaced.

**Tasks:**

- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #276/#279 · `maxRetries` pinned on both adapters, `retryAfterMsFromHeaders` clamped to a 60 s ceiling; NO jitter (ADR-0040 forbids it — recorded in the ADR rather than shipped)).** **Disable the vendor SDK's own retry and add jitter + `Retry-After` honoring to `FallbackChain`'s backoff.** The Anthropic/OpenAI SDK clients run with the vendor SDK's own default retry count in production, so up to 2 SDK-internal retries can happen per attempt with zero `AttemptRecord`, no `cost:updated` event, and no visibility — contradicting the documented "runner, not adapter, owns retry policy" contract and the "visible failover, never silent" guarantee (`packages/llm/src/adapters/anthropic.ts`). In the same PR, `FallbackChain`'s own backoff (`packages/llm/src/fallback-chain.ts`) has no jitter and no adapter reads the provider's `Retry-After` header. Set `maxRetries: 0` on every vendor client and add jitter + `Retry-After` honoring so `FallbackChain` becomes the sole retry authority. *(M · packages/llm/src/adapters/anthropic.ts, packages/llm/src/fallback-chain.ts · #276, #279)*
- **Sweep the three adapters for guard/classification parity — one PR, one shared fixture pattern per guard.** Seven independent gaps, all the identical propagation-gap mechanism: Gemini's and OpenAI's generic error classifiers lack Anthropic's `instanceof LlmProviderError` short-circuit, degrading a known `bad_request` to `unknown`/`internal` (#168); Anthropic's `generate()` maps content outside its own try/catch, letting a malformed `tool_use` block skip classification entirely, unlike OpenAI and Gemini (#173); `FallbackChain#exhaustedError()` synthesizes `kind:'unknown'` even when the real cause maps cleanly, losing the accurate `provider_unavailable` UX hint (#192); Anthropic's streaming path leaves empty tool-call id/name unguarded where Gemini already guards it and OpenAI only partially does (#170); Anthropic's `stream()` is missing the `assertNoStreamingMediaOutput()` guard that OpenAI and Gemini both carry (#174); Gemini's media lowering has no subtype validation, unlike Anthropic and OpenAI (#175); the tool-schema depth DoS guard against untrusted MCP schemas exists only on Gemini's `toWire` path in `tool-normalizer.ts`, not OpenAI's or Anthropic's (#186). Carry each guard to the adapter(s) missing it, with a shared fixture test per guard so a future adapter can't silently regress the same way. *(M · packages/llm/src/adapters/anthropic.ts, packages/llm/src/adapters/gemini.ts, packages/llm/src/adapters/openai.ts, packages/llm/src/tool-normalizer.ts, packages/llm/src/fallback-chain.ts · #168, #170, #173, #174, #175, #186, #192)*
- **Close four independent blind spots in the ADR-0071 money-guard apparatus.** `isNonChatModelId` (`packages/llm/src/model-kind.ts`) has zero direct unit tests and its only indirect coverage exercises 5 of 14 `NON_CHAT_SEGMENTS` tokens — a repeat of the exact `text-embedding-3-large` incident already cited in the file's own comments (#177). `moneyFingerprint`, the ADR-0071 §9 CI money guard in `snapshot-guard.ts`, omits `maxOutputTokens` even though it is a direct multiplicand of the pre-egress budget-cap estimate (#178). `CATALOG_SHA256` (`packages/llm/src/catalog/snapshot.ts`) is hand-pasted at generation time and never recomputed or asserted against the snapshot's actual content (G6). `CostTierSchema` (`packages/llm/src/catalog/models-dev-schema.ts`) validates that `tier.type` is a non-empty string but never checks it equals the literal `'tokens'` before `toPriceTiers` reads `tier.size` as a token threshold — a future models.dev tiering-axis change would be silently misinterpreted, and none of the other three numeric-diffing guards would catch it (#181). Add the missing test, the missing field, the missing recompute-and-assert, and the missing literal check in one coordinated PR. *(M · packages/llm/src/model-kind.ts, packages/llm/src/catalog/snapshot-guard.ts, packages/llm/src/catalog/snapshot.ts, packages/llm/src/catalog/models-dev-schema.ts · G6, #177, #178, #181)*
- **Fix Anthropic's and Gemini's `reasoning` capability flag and document what `CapabilityFlags` actually gates.** Both adapters (`packages/llm/src/adapters/anthropic.ts`) fully implement the reasoning content channel yet declare `reasoning: false` in `SUPPORTS` — the public seam contract lies about 2 of the 3 real providers (#171). Separately, `CapabilityFlags.reasoning`/`.promptCache` (`packages/llm/src/capabilities.ts`) are part of the frozen public seam but `requiredCapabilities()` only ever gates on `'tools'` — nothing reads either field, since reasoning gating is now done through the catalog-driven `acceptedTiers` mechanism instead. Fix the flag values and add a doc comment recording that these two fields are currently unconsumed, in the same change. *(S · packages/llm/src/adapters/anthropic.ts, packages/llm/src/capabilities.ts · #171, #189)*
- **Wire Anthropic prompt caching or drop the flag that claims it exists.** `promptCache: true` (`packages/llm/src/adapters/anthropic.ts`) is structurally never activated — no code path sets `cache_control` on system prompt, tools, or messages anywhere in the adapter, so every BYOK-local Anthropic agentic-chat turn pays full price on content Anthropic's own caching would discount roughly 90%. This is real feature work, not a one-line fix: needs an opt-in policy for when to mark `cache_control` (system prompt + tool definitions on every call is the obvious first cut). *(M · packages/llm/src/adapters/anthropic.ts · #172)*
- **Extend the shared conformance suite to cover parallel tool calls, cache-write tokens, per-adapter error classification, and cancellation.** `packages/llm/src/conformance/spec.ts` has no fixture exercising two concurrent tool calls in one turn despite `parallelToolCalls` being part of the seam contract (#187); `ConformanceExpectations` has no `cacheWriteTokens` field, so a regression that drops Anthropic's cache-write usage produces zero coverage (#188); only `rate_limit` classification is asserted centrally, with `auth`/`bad_request`/`content_filter` proven per-adapter only (#190); no scenario drives `AbortSignal` cancellation through `generate()`/`stream()` across all four providers (#191). One extension of `ConformanceFixtures`/`ConformanceExpectations` covering all four gaps. *(S · packages/llm/src/conformance/spec.ts · #187, #188, #190, #191)*
- **Extend `#afterFailure`'s cooldown-parking memory from `rate_limit` to the other outage-shaped error kinds.** `packages/llm/src/fallback-chain.ts`'s cross-call cooldown memory only covers `rate_limit` — `overloaded`, `timeout`, and `transport` get no memory at all, so a real provider outage (a 5xx or a 529) gets re-hammered on every subsequent turn instead of being parked. Extend the same memory mechanism to all three additional error kinds. *(S · packages/llm/src/fallback-chain.ts · #195)*
- **Trim the seam barrel's dead exports and extend the fence linter to cover its own plain-JS branch.** `packages/llm/src/index.ts`'s curated barrel exports provider-specific wire-shape types with zero consumers outside `packages/llm`, defeating the barrel's "curated, not `export *`" purpose (#283). Separately, `tools/lint-fixtures/assert-fence.mjs` only lints the TS-file vendor-import fence and never exercises the plain-JS fence block in `eslint.config.mjs` — a real gap in the CLAUDE.md rule-4 no-vendor-type-crosses-the-seam enforcement, not just a style nit (#284). Trim the barrel's exports and extend the fence self-test in the same change. *(S · packages/llm/src/index.ts, tools/lint-fixtures/assert-fence.mjs · #283, #284)*
- **Fix two stale doc comments before a future "simplification" reintroduces the bug they no longer describe.** `catalog-model.ts`'s `maxOutputTokens` comment still says "nothing clamps against it today" though `output-cap.ts`'s `cappedMaxTokens` now clamps it everywhere (#180, duplicate G8 folded in); `reasoning-wire.ts`'s `reasoningBudgetFor` comment claims a `maxTokens - 1` ceiling that no caller actually passes — callers pass `floor(maxTokens * 0.8)` (G7). No functional bug today; both are doc-accuracy fixes to close before they mislead a future edit. *(S · packages/llm/src/catalog/catalog-model.ts, packages/llm/src/reasoning-wire.ts · G7, G8, #180)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #194/#198 · catch narrowed to `UnknownModelError`, `assertAccountableUsage` in `CostTracker.record()`).** **Narrow `#emitSuccess`'s cost-recording catch and add a bounds check inside `CostTracker.record()`.** `packages/llm/src/fallback-chain.ts`'s `#emitSuccess` cost-recording catch is unnarrowed even though its own comment documents it as guarding only against `UnknownModelError` — any other exception on the pricing path is silently swallowed into an undiagnosable $0 cost (#194). Separately, `packages/llm/src/cost-tracker.ts`'s `CostTracker.record()` consumes `Usage` fields with no non-negative/finite check inside the file itself, risking silent downward erosion of `cumulativeCostMicrocents` from a malformed usage payload (#198). Narrow the catch to `UnknownModelError` and add the bounds check in one defensive-hardening pass. *(S · packages/llm/src/fallback-chain.ts, packages/llm/src/cost-tracker.ts · #194, #198)*
- **Delete `GeminiToolCallIds.resolveResponse` or mark it reserved.** `packages/llm/src/tool-normalizer.ts`'s `resolveResponse` is fully unit-tested but has zero callers — the actual id-resolution mechanism the Gemini adapter uses is a separate implementation, `toGeminiContents`'s `nameById` Map. Either delete the dead method and its test, or add an explicit "currently unused/reserved" comment so it doesn't read as an untested live path. *(S · packages/llm/src/tool-normalizer.ts · #176)*
- **Add direct unit tests for `providers.ts`'s adapter-selection and SSRF-validated custom-base-URL wiring.** `packages/llm/src/providers.ts` decides which adapter serves each `ProviderId` and wires the SSRF-validated fetch for custom base URLs, and has zero dedicated unit tests today — a gap on a security-relevant path that is currently only exercised indirectly. *(S · packages/llm/src/providers.ts · #182)*
- ✅ **DONE on `development` (Step 3, reviewed at `8c44e2ec`; final Wave 2 certification remains open).** **Broaden `scrubSecrets`'s URL-query-secret regex to catch common param-name variants.** The finite query-name extension and overlapping-credential corrections have independent security/CLI reviews, benign-output controls and complete mechanism-removal evidence; see the [Step 3 acceptance](#step-3-acceptance--2026-10-12). This is finite shape recognition, not universal secret discovery. *(S · packages/llm/src/llm-error.ts · #196)*
- **Decide where to parse `LlmResultSchema`/`StreamChunkSchema` against live adapter output, then wire it.** These schemas (`packages/llm/src/types.ts`) carry load-bearing invariants — the ADR-0031 raw-media `superRefine` and the reasoning-tokens refine — but are only ever parsed in tests; no adapter or `packages/core` consumer runs a live result through them, so a defective custom-base-URL endpoint can violate these invariants with no runtime gate. Needs a considered call on insertion point given the per-call perf cost before implementation. *(M · packages/llm/src/types.ts · #184)*
- **Stream `sync-models-dev`'s body-size guard instead of buffering first.** `tools/sync-models-dev/sync.mjs`'s `MAX_BODY_BYTES` cap only fires after `response.text()` has already buffered the full body when `content-length` is absent. Low real-world severity (this is a maintainer-run sync script, not exposed to untrusted input at runtime) but a cheap fix: stream with a running byte-count guard that aborts before full buffering. *(S · tools/sync-models-dev/sync.mjs · #183)*
- **Remove the unreachable `?? maxOutputTokens` fallback in `estimateMaxNextCost`.** `packages/llm/src/budget-estimator.ts`'s `estimateMaxNextCost` has a `?? maxOutputTokens` fallback branch that is provably unreachable given the function's own required-number parameter signature. Pure dead-code cleanup — remove the branch and simplify the signature to match. *(S · packages/llm/src/budget-estimator.ts · #197)*
- **Add a runtime single-flight guard to `FallbackChain`'s `#lastProviderAcrossCalls` invariant.** `packages/llm/src/fallback-chain.ts` documents "single-flight by contract" on this field but has no runtime guard enforcing it — a future concurrent call on the same `FallbackChain` instance would silently corrupt the reasoning-strip latch rather than fail loudly. Add a guard that throws on re-entrancy instead of allowing silent state corruption. *(S · packages/llm/src/fallback-chain.ts · #199)*

**Acceptance:** the vendor SDK clients run with `maxRetries: 0` in production and `FallbackChain` is the sole retry authority, with jitter and `Retry-After` honored and every retry visible as an `AttemptRecord`/`cost:updated` pair; all three adapters share identical empty-tool-call-id, streaming-media, subtype-validation, and schema-depth guards, each proven by a shared fixture test per guard, and a pre-classified `LlmProviderError` never degrades to `kind:'unknown'` at the three sites named (`gemini.ts`/`openai.ts` classifiers, `anthropic.ts`'s `generate()`, `FallbackChain#exhaustedError()`); `isNonChatModelId` has direct unit tests covering all 14 `NON_CHAT_SEGMENTS` tokens, `moneyFingerprint` includes `maxOutputTokens`, `CATALOG_SHA256` is recomputed and asserted at generation time, and `CostTierSchema` rejects a `tier.type` that isn't the literal `'tokens'`; Anthropic and Gemini declare `reasoning: true` and the doc comment on `CapabilityFlags.reasoning`/`.promptCache` states their current non-consumption; Anthropic prompt caching sets `cache_control` under a documented opt-in policy with a cost-delta test proving the discount; the conformance suite has fixtures for parallel tool calls, `cacheWriteTokens`, per-classification-kind assertions, and cancellation; cooldown-parking covers `rate_limit`/`overloaded`/`timeout`/`transport` uniformly; the seam barrel exports nothing with zero external consumers and `assert-fence.mjs` covers the plain-JS fence block; the two stale comments match the code they describe; `#emitSuccess`'s catch is narrowed to `UnknownModelError` and `CostTracker.record()` rejects non-finite/negative `Usage` fields; `resolveResponse` is either deleted or explicitly marked reserved; `providers.ts` has direct adapter-selection and SSRF-fetch-wiring tests; `scrubSecrets` redacts `client_secret` and equivalent common param names (security-reviewed); the `sync-models-dev` body cap aborts before full buffering; the dead `?? maxOutputTokens` branch is gone; and `FallbackChain` throws on concurrent re-entrant use instead of corrupting the reasoning-strip latch.

### 2.5.5.C — Data & persistence hardening: SQLite concurrency, media store & catalog/history robustness

`packages/db` and the `apps/cli` read/write paths built on it were reviewed together as one subsystem: SQLite concurrency (busy-retry, migration races, an event-loop-blocking synchronous sleep), unverified media provenance, and catalog/session-store robustness against a single corrupt row. The pattern repeats — a correct primitive exists (`withBusyRetry`, the `PerRowParseError` isolation, the enum-CHECK helper) and simply doesn't reach every writer or reader that needs it, so most of this is propagation, not new design. A handful of items are genuine retention/scope calls that need a maintainer ruling before code is written, and are called out inline.

**Tasks:**

- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #228 · atomic `writeTurn` + `process/background-failure.ts`).** **Wire a process-level safety net under the chat persister so a transient `history.db` write failure can no longer crash the CLI after the reply was already shown.** `apps/cli/src/chat/persister.ts` throws inside a `RunEventBus` subscriber; the bus has no `onListenerError` sink, so the throw becomes an unhandled-promise-rejection with no process-level handler, killing the whole process asynchronously — after the user already saw the reply, silently losing the turn. Add an `onListenerError` sink on the bus, a top-level `unhandledRejection` handler as the last-resort backstop, and wrap the persister's writes in `withBusyRetry` + `BEGIN IMMEDIATE` so the common transient-lock case never reaches either handler. *(M · `apps/cli/src/chat/persister.ts` · #228)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #99 · `packages/db/src/migrate-lock.ts` — a SQLite `BEGIN EXCLUSIVE` advisory lock, NOT the lock file ADR-0073 originally proposed (see its superseded-Decision banner)).** **Serialize (or lock) `runMigrations` so two `relavium` processes racing on a fresh `history.db` can't both issue the same `CREATE TABLE` and crash one of them.** Live, reproduced in `packages/db/src/client.ts`: first-run concurrency (two shells launched together, a CLI + a VS Code extension host) hits Drizzle's migrator with no mutual exclusion, and the loser gets a raw `DrizzleError` instead of a clean wait-and-continue. Needs a design call — an OS file lock around the migration batch vs. wrapping it in `BEGIN IMMEDIATE` — plus a two-process regression test that actually races two `runMigrations` calls against the same fresh file. *(M · `packages/db/src/client.ts` · #99)*
- **Rule on a retention policy, then ship bounded `chat-list` reads and a real delete path — right now nothing ever writes the soft-delete columns that exist on nearly every table.** `apps/cli/src/commands/chat-list.ts` has no `--limit`/`--tail` flag and falls through to an unbounded full-table read; separately, every `deleted_at` column across the schema is dead — the only way to remove a session today is deleting the entire `history.db` file, which also destroys provider registrations. Likely the single highest-value item in this workstream, but it is a genuine product-retention decision (default list bound, whether soft-delete commands ship in this pass, whether/when data is ever hard-deleted), not just an implementation task. *(L · `apps/cli/src/commands/chat-list.ts` · #116, #230)* — **blocked**: needs a maintainer ruling on the retention policy before `chat-list` pagination and any delete command can be implemented.
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #100 · `SQLITE_BUSY_SNAPSHOT` + `SQLITE_BUSY_RECOVERY` in `retry.ts`).** **Add the missing `SQLITE_BUSY_SNAPSHOT` code string to `retry.ts`'s own retry set — its docstring already promises this and the set doesn't deliver it.** `RETRYABLE_CODES` in `packages/db/src/retry.ts` lists `SQLITE_BUSY`/`SQLITE_LOCKED` only, while the module's own header comment says it exists specifically to retry the `SQLITE_BUSY_SNAPSHOT` a stale `BEGIN DEFERRED` writer can hit. Add the missing string plus a regression test asserting it's retried, landing alongside the event-loop fix below since both touch the same file. *(S · `packages/db/src/retry.ts` · #100)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #226 · `withBusyRetryAsync`).** **Replace `withBusyRetry`'s synchronous `Atomics.wait` sleep with an async backoff that yields to the event loop.** `packages/db/src/retry.ts`'s `sleepSync` genuinely blocks the main thread for up to 250ms per retry on every contended `history.db` write, freezing ink's render loop mid-stream during exactly the multi-process contention this helper exists to handle. Swap to an awaited backoff (the retry loop's callers are already async) while keeping the deterministic, no-jitter linear delay. *(M · `packages/db/src/retry.ts` · #226)*
- **Add a liveness/lock-file guard to session resume so two concurrent `chat-resume` processes on the same session get an actionable error instead of a raw UNIQUE-index crash.** `packages/db/src/session-store.ts` computes `nextSequenceNumber` from the current max and both processes compute the same value, colliding on the `(session_id, sequence_number)` UNIQUE index with no proactive check beforehand. *(M · `packages/db/src/session-store.ts` · #227)*
- **Paginate the session-message read path — `loadMessages`/`loadFull` do a full unbounded table scan on every `chat-resume`/export/reseat, and ADR-0062 compaction never prunes rows.** In `packages/db/src/session-store.ts`, a long-lived session gets progressively slower to resume with no ceiling; add windowing/pagination to the read path so resume cost stays bounded regardless of session age. *(M · `packages/db/src/session-store.ts` · #272)*
- **Add direct unit tests for the DB-open-failure-to-`CliError` wrapping in `reader.ts`/`session-open.ts` — it's completely untested today.** `apps/cli/src/history/reader.ts` and `apps/cli/src/history/session-open.ts` both map a `history.db` open failure to a typed `CliError`, but no test asserts the mapping actually happens; a regression here would surface as a raw driver error reaching the user instead of the intended diagnostic. *(S · `apps/cli/src/history/reader.ts` · #29)*
- **Add the missing enum CHECK constraints on `model_catalog.kind`/`media_surface`/`source` and correct the doc claim that justified skipping them.** `packages/db/src/schema.ts` and `database-schema.md` both assert SQLite can't add a `CHECK` via `ALTER TABLE ADD COLUMN` — verified empirically false — and use that claim to leave those columns silently coercible on a bad write, unlike every other enum column in the schema which does get the `CHECK (... IN (...))` treatment. Add a new migration carrying the missing constraints and fix the doc claim in the same PR. *(M · `packages/db/src/schema.ts` · #101)*
- **Extend DDL snapshot regression coverage through migration 0013 (ADR-0074 §4) and add a dedicated `time.ts` unit test — both currently gap out.** The DDL snapshot suite in `packages/db` stops at migration 0002, leaving 11 of 14 migrations — including the ADR-0070/ADR-0072 money-invariant tables — with zero fidelity coverage (#102); `packages/db/src/time.ts`, the package's sole ISO↔epoch boundary, has no dedicated test file at all (#103). Land both together as one test-hardening pass. *(S · `packages/db/src/time.ts` · #102, #103)*
- **Decide the disposition of the ADR-0072 enrichment fields — persisted but never read back by `ModelCatalogEntry` or the `/models` picker.** `description`/`knowledgeCutoff`/`modalities` are written per ADR-0072 but `apps/cli/src/engine/model-catalog-view.ts`'s `ModelCatalogEntry` never surfaces them; either wire them through to the picker or explicitly document the round-trip as staged dead code. *(M · `apps/cli/src/engine/model-catalog-view.ts` · #38)* — **blocked**: 2.6.Q itself is blocked on 7 maintainer decisions on ADR-0072/models.dev enrichment scope; once unblocked, fold this into 2.6.Q or retire the round-trip explicitly.
- **Harden `packages/db/src/media-store.ts`'s two reference `MediaStore` implementations in one pass — three independent completeness gaps live in the same file.** Neither `FilesystemMediaStore` nor `InMemoryMediaStore`'s `put()` enforces a write-size ceiling of its own, relying entirely on upstream callers to have checked first (#111); a crash between the temp-write and the atomic rename leaves a stray `.tmp` file that the CAS-orphan GC sweep explicitly skips by construction (`.tmp` names never match `MEDIA_HANDLE_PATTERN`), an unbounded silent disk leak on every crash or kill (#108); and both implementations silently ignore the optional `AbortSignalLike` passed to `readRange`, so a user-initiated abort during a large `read_media` call doesn't actually cancel the disk read (#112). Land as one hardening pass: add a `put()` size ceiling mirroring the read side's redundant-check discipline, extend the GC sweep to collect aged orphaned `.tmp` files, and wire the abort signal through both implementations' `readRange`. *(M · `packages/db/src/media-store.ts` · #111, #108, #112)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #104/#105 · `DbOpenError` with a stable, path-free message).** **Give `createClient` a typed error class instead of a bare `Error`, and correct its JSDoc to list all four PRAGMAs it actually applies.** `packages/db/src/client.ts`'s `createClient` throws a plain `Error` with a raw filesystem path interpolated into the message, unlike every other typed error the package exports; its JSDoc documents `journal_mode`/`foreign_keys` but omits `busy_timeout` and `synchronous`, both load-bearing for the concurrency behavior this workstream is hardening. Land a typed error class and the corrected docstring together. *(S · `packages/db/src/client.ts` · #104, #105)*
- **Either export `sessionCosts`/`modelMetadata`/`catalogMeta` from `index.ts` alongside the dozen other raw Drizzle tables it already exports, or document why they're deliberately withheld.** `packages/db/src/index.ts` has no comment explaining the asymmetry today, so the omission reads as an oversight rather than a decision. *(S · `packages/db/src/index.ts` · #106)*
- **Document that `history.db` is machine-local — it persists absolute, machine-specific paths with no portability caveat anywhere.** `agent_sessions.working_dir`, `runs.workflow_path`/`project_root`, and other source-path columns all store absolute paths tied to the machine that wrote them; `database-schema.md` should carry a one-line notice, and the degrade-on-missing-path behavior (currently silent) should be named. *(S · `packages/db/src/schema.ts` · #234)*
- **Verify a fetched or model-declared media `mimeType` against reality at both chokepoints in the pipeline, and fix the stale comment sitting in the same region.** The `mimeType` a fetch or a model declares is never checked against the actual `Content-Type` header or real bytes at ingest (#107), and `recordObject()` in `packages/db/src/media-store.ts` persists that unverified tuple with no internal cross-check between `modality` and `mimeType` (#109); a stale comment nearby still claims `mimeType` is "NOT persisted yet" (#110). Verify at fetch time, cross-check modality derivation at store time, and delete the stale comment in the same PR. *(M · `packages/db/src/media-store.ts` · #107, #109, #110)*
- **Fix `assertRelativePath`'s Windows drive-letter regex to also reject the drive-relative `C:foo\bar.png` form, not just `C:\`/`C:/`.** In `packages/db/src/media-store.ts`, the path-escape guard's safety today is coincidental — it only catches the two most common absolute forms. One-line regex fix closes the gap between the documented guarantee and the actual one. *(S · `packages/db/src/media-store.ts` · #113)*
- **Batch the N+1 upsert loops in `model-catalog-store.ts` and `metadata-store.ts` — both do one SELECT plus one write per incoming model.** Low-impact today on local SQLite with a small catalog, but relevant once a 100–300+ model catalog or the Phase-6 Postgres port arrives. Rewrite both loops to prefetch existing rows in one query, then batch the write. *(S · `packages/db/src/model-catalog-store.ts` · #119)*
- **Debounce or epoch-guard `installCatalogRefresh` so two rapid `/models refresh` calls can't silently drop one's results.** `apps/cli/src/engine/model-refresh.ts` does a last-settled-wins replace with no reentrancy guard today; fixable via an install-site epoch check, independent of 2.6.Q's blocked decisions. *(S · `apps/cli/src/engine/model-refresh.ts` · #225)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — G1 · guarded in `model-catalog-store.ts`).** **Guard the `deprecationDate` conversion in `model-catalog-view.ts` the same way the sibling `capabilities` column already is.** An unguarded `Date` conversion on a corrupted `deprecationDate` row can crash the entire `/models` catalog load; apply the same guarded-parse pattern already present for `capabilities` a few lines away. *(S · `apps/cli/src/engine/model-catalog-view.ts` · G1)*
- **Decide whether the per-row corruption isolation `model-catalog-store.ts` already has is worth propagating to `session-store.ts`/`provider-store.ts`.** `packages/db/src/model-catalog-store.ts` has a typed error specifically so one corrupt row can be isolated during a list read; `session-store.ts`/`provider-store.ts` instead let one bad row abort the entire read, surfacing as a generic "internal error." *(M · `packages/db/src/session-store.ts` · #117)* — **blocked**: maintainer call on whether per-row isolation is worth adding now, or whether a fully-aborted list read on a corrupted row is an acceptable residual matching the "DB corruption is out of scope" posture applied elsewhere.
- **Add a fixture-seeded-then-migrated test harness so `ALTER`-based migrations are actually exercised against pre-existing rows.** 9 of 13 migrations in `packages/db/drizzle` use `ALTER` and none is tested against real historic data — only against an empty schema. *(M · `packages/db/drizzle` · #291)*
- **Certify session-message tool-content rejection and document retained content (#115).** W7/PR #90 already supplies strict session-row validation and producer→SQLite→export controls under Accepted [ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) and [ADR-0098](../../decisions/0098-a-session-effect-row-holds-no-result-and-never-replays.md). Reuse and revalidate these controls for Wave 2 instead of promising masked arbitrary user/assistant text or silently stripping legacy tool content. The canonical unsafe-column inventory already identifies `session_messages`; correct any residual wording and pin the structural refusal at actual persistence/export boundaries. The [Wave D15 reconciliation](#decisions-presented-together-before-implementation) replaces the earlier upstream-masking uncertainty without creating a historical scrub policy. *(S · `packages/db/src/session-store.ts` · #115)*

**Acceptance:** a transient `history.db` write failure during chat no longer crashes the process — it retries and, on genuine exhaustion, surfaces through the `onListenerError` sink rather than an unhandled rejection; two processes racing `runMigrations` against a fresh `history.db` no longer crash either one, proven by a two-process regression test; `withBusyRetry` retries `SQLITE_BUSY_SNAPSHOT` and no longer blocks the event loop synchronously; two concurrent `chat-resume` processes on the same session fail with an actionable error instead of a raw UNIQUE-index crash; `loadMessages`/`loadFull` are bounded/paginated regardless of session age; the DB-open-failure-to-`CliError` mapping in `reader.ts`/`session-open.ts` is under direct test; `model_catalog.kind`/`media_surface`/`source` carry real DB-level CHECK constraints and the false ALTER-limitation doc claim is corrected; the DDL snapshot suite covers all 13 migrations and `time.ts` has a dedicated test; `createClient` throws a typed error and its JSDoc lists all four PRAGMAs; `index.ts`'s table-export asymmetry is resolved or documented; `history.db`'s machine-locality is documented; a fetched/declared media `mimeType` is verified against `Content-Type`/bytes at ingest and cross-checked against `modality` at store time, with the stale "not persisted" comment removed; the Windows drive-relative path form is rejected by `assertRelativePath`; the model-catalog upsert loops batch instead of running N+1; `/models refresh` is reentrancy-safe under rapid repeated calls; a corrupted `deprecationDate` row no longer crashes `/models`; `FilesystemMediaStore`/`InMemoryMediaStore` enforce a `put()` size ceiling, sweep aged orphaned `.tmp` files, and honor `AbortSignalLike` on `readRange`; `ALTER` migrations are tested against seeded pre-existing data. The three blocking items (retention policy, per-row isolation scope, session-message secret-masking-fixture necessity) are resolved by explicit maintainer ruling before their implementation lands; the ADR-0072 enrichment-field disposition is decided once 2.6.Q unblocks.

### 2.5.5.D — MCP transport, config-trust & filesystem/secret hardening

`packages/mcp` and the `apps/cli` secrets/config/keychain layer share one root cause: the codebase's own untrusted-input size-bounding and secret-handling discipline — established everywhere else (the `fs`/`process` tool-host arms, `db/open.ts`'s self-healing 0600, `packages/core/src/tools/untrusted.ts`) — never propagated into the MCP transport/discovery/result pipeline or into several CLI-side secret and credential surfaces. Two of the resulting gaps are live security holes with no existing coverage anywhere (tool-definition poisoning, a config-layer secret hijack); the rest are the same missing-propagation pattern applied to connect timeouts, resource bounds, structured errors, and permission self-heal. This workstream is one sizing/hardening pass across a small, well-bounded set of files, not new subsystem design.

**Tasks:**

- **Extend the untrusted-content boundary to MCP tool DEFINITIONS, not just call results.** `packages/core/src/tools/untrusted.ts`'s `markUntrusted` (invoked at registry step 8) tags tool CALL RESULTS as untrusted before they reach message assembly, but `buildServerToolDefs` (`packages/mcp/src/tool-mapping.ts:102`) admits a connected server's `description`/`inputSchema` verbatim with no equivalent treatment — a classic MCP tool-poisoning vector, and `docs/standards/security-review.md`'s prompt-injection posture doesn't mention it. At minimum document the gap explicitly in `mcp-integration.md`'s Security section; consider tagging/sanitizing server-supplied description/schema text the same way call results are tagged. *(M · `packages/mcp/src/tool-mapping.ts` · #202)*
- **Add a connect-phase timeout to every MCP transport.** `startMcpClientFailLoud` (`apps/cli/src/engine/mcp-servers.ts:330`) calls `start(configs)` with no timeout or `AbortSignal`, unlike every other bounded host call in the same file (#35); `connectSdkTransport` (`packages/mcp/src/sdk-stdio.ts:107`) leaves stdio's handshake bound only to the SDK's fixed 60s default, too short for a cold-start `npx` server (#205); WebSocket and SSE (`packages/mcp/src/sdk-websocket.ts:43`, `sdk-sse.ts:32`) have zero connect timeout at all, hanging CLI startup indefinitely against a firewalled server (G32, high). Fix as one change: thread a `connectTimeoutMs` option (per-transport defaults, stdio higher than network) through `connectSdkTransport` and `startMcpClientFailLoud`, wrapped in the same `Promise.race` pattern `validateProviderKey` already establishes. Independent of 2.6.I's Home-UI scope — do not wait for it. *(M · `packages/mcp/src/sdk-stdio.ts`, `apps/cli/src/engine/mcp-servers.ts` · #35, G32, #205)*
- **Extend the sensitive-credential floor to modern cloud/k8s CLI stores, in both the read-path and the env-injection guard.** `SENSITIVE_READ_DIR_SEGMENTS`/`SENSITIVE_READ_BASENAMES` (`apps/cli/src/engine/tool-host/fs.ts:499`, `:509`) — the belt-and-suspenders floor applied in every mode/tier including unjailed `full` — cover `.ssh`/`.aws`/`.docker`/git but omit `.kube`, `.azure`, gcloud's `legacy_credentials`, and `application_default_credentials.json`/`credentials.tfrc.json` (#36); `FORBIDDEN_DECLARED_ENV` (`apps/cli/src/engine/tool-host/process.ts:110`) separately misses `KUBECONFIG`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_PROFILE`, and `GOOGLE_APPLICATION_CREDENTIALS` — the same config-redirection vector already blocked for `GIT_*`. One task extending both lists plus a regression test per new entry. *(M · `apps/cli/src/engine/tool-host/fs.ts`, `apps/cli/src/engine/tool-host/process.ts` · #36, #39)*
- ✅ **DONE on `development` (Step 3, reviewed at `8c44e2ec`; final Wave 2 certification remains open).** **Add direct tests for the OS-keychain bridge — the one module touching the native binding.** Direct mocked-native tests now cover successful forwarding, null reads, constructor/method failures and private causes for get/set/delete. Actual command/diagnostic controls verify fixed errors and unchanged provider references. Real OS-lock and native-module-loading behavior remain unclaimed; see the [Step 3 acceptance](#step-3-acceptance--2026-10-12). *(M · `apps/cli/src/secrets/os-keychain.ts` · #27)*
- **Bound MCP transport/discovery/result size against a hostile server — one sizing pass across four files.** `MAX_TOOL_PAGES` (`sdk-stdio.ts`) bounds only the number of `tools/list` pages, never the total tool count or an individual `tool.description` length before `buildServerToolDefs` admits it verbatim (#201); `schema-compiler.ts:235`'s `MAX_DEPTH`/`MAX_NODES`/`MAX_PROPERTIES`/`MAX_ENUM_MEMBERS` bound schema shape but not an embedded string's byte length, so a single oversized `const`/enum literal costs 1 against budget regardless of its real size (#209); `shapeToolResult` (`packages/mcp/src/result.ts:10`) copies a server's `content[].text` through unbounded with no adversarial test proving the downstream `DEFAULT_TOOL_RESULT_LIMITS` cap actually holds at read-time (#288); and `openSseConnection` passes no bounded `fetch` override to `SSEClientTransport` while `openWebSocketConnection`'s transport has no injectable socket at all, so a hostile server can exhaust process memory over either connection (G33, high — highest-value item in this bullet). Fix together: a total-tool-count/description-length cap in `buildServerToolDefs`, a max-string-length check in `schema-compiler.ts`'s `literalSchema`/`enumSchema`, a bounded custom `fetch` for SSE reusing `safe-egress.ts`'s bounded-body-read helper, a wrapped/replaced `WebSocket` for the WS transport, and the missing adversarial test for `shapeToolResult`. *(M · `packages/mcp/src/sdk-stdio.ts`, `schema-compiler.ts`, `result.ts`, `sdk-sse.ts`, `sdk-websocket.ts` · G33, #201, #209, #288)*
- **Add realpath containment before `discoverCatalog` follows a symlink.** `discoverCatalog` (`apps/cli/src/workflows/catalog.ts:77`) explicitly admits symlinked dirents and `readEntry`'s `statSync` follows the link with only an `isFile()`/size check — no containment check that the resolved target stays inside `projectConfigDir`. Apply the same containment the media layer already uses: `fs.realpathSync` the entry and reject it (generic `valid:false`, matching the existing non-regular-file guard) unless the realpath's directory is `projectConfigDir`'s realpath or a descendant. *(M · `apps/cli/src/workflows/catalog.ts` · #1)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — #28/#33 · `db/open.ts:62` chmods the db AND its `-wal`/`-shm` siblings unconditionally; `config/load.ts:141-145` re-asserts `0600` on every load).** **Make `history.db`'s 0600 self-heal unconditional; add the equivalent re-assert-on-load for `config.toml`.** `db/open.ts:27`'s `chmodSync(path, 0o600)` runs only after `runMigrations` succeeds, so a throwing migration (disk-full, partial/interrupted run) leaves the file at the process umask default — typically 644 (#28). `config.toml`'s 0600 (`config/write.ts:216`, `fchmodSync`) is write-time-only and never re-asserted by `loadConfigFile`/`loadResolvedConfig` on read, unlike the db's self-heal (#33). Move the db chmod ahead of `runMigrations` (or wrap open+migrate in try/finally), and add a cheap best-effort `chmodSync(target, 0o600)` inside `loadConfigFile` for consistency. *(M · `apps/cli/src/db/open.ts`, `apps/cli/src/config/write.ts` · #28, #33)*
- **Warn on a project-layer MCP server name collision that can redirect a global secret.** `mergeMcpServers` (`apps/cli/src/config/resolve.ts:215`, called from `resolveConfig:129`) does `byName.set(server.name, server)` per layer in trust order global→workspace→project, so a project `[[mcp_servers]]` entry reusing an existing global `name` wins outright, wholesale-replacing `command`/`args`/`url`/`env` — and because `{{secrets.*}}` resolution is scoped only by name, an attacker-controlled `project.toml` can redirect a real provisioned secret straight into an attacker binary. Add a loud, actionable warning (or require explicit opt-in) at `resolveConfig` time when a lower-trust layer redeclares a name already present in a higher-trust layer with a different `command`/`url`/`env`. *(M · `apps/cli/src/config/resolve.ts` · G19)*
- **Reject a secret-typed `run --input` before execution instead of taking the raw argv value.** `coerce()` treats it identically to a plain string, exposing it through argv. Workflow secrets are caller-supplied, not automatically keychain-resolved (ADR-0083). The [approved Wave 2 plan](#wave-2-preflight-and-proposed-execution-plan--2026-10-12) pairs refusal with first-run bounded stdin delivery under Accepted ADR-0107; implementation is accepted in [Step 4](#step-4-acceptance--2026-10-12). *(M · `apps/cli/src/commands/inputs.ts` · #25)*
- **Extract `deepestExistingReal`, a security-critical path-jail primitive, into one shared implementation.** The realpath-ancestor-walk helper is implemented independently — near-identical doc comment and loop body — in both `packages/db/src/media-write.ts:139` (backs `save_to`'s path-jail) and `apps/cli/src/engine/tool-host/fs.ts:824` (backs the tool-host fs jail), with no shared source of truth. Extract it into `packages/shared` (both packages already depend on it) and have both call sites import it. *(S · `packages/db/src/media-write.ts`, `apps/cli/src/engine/tool-host/fs.ts` · #235)*
- ✅ **DONE on `development` (Step 3, reviewed at `8c44e2ec`; final Wave 2 certification remains open).** **Complete direct `readSecretFromStdin` coverage and cap its buffer.** Colocated reader controls and real-default-reader provider/gate tests verify byte bounds, owned chunks, Unicode/whitespace and cleanup; caller-specific trimming remains unchanged. The [command reference](../../reference/cli/commands.md#secret-stdin-limits) owns the contract and the [Step 3 acceptance](#step-3-acceptance--2026-10-12) joins evidence. First-run transport is accepted in [Step 4](#step-4-acceptance--2026-10-12). *(S · `apps/cli/src/secrets/read-secret.ts` · #31, #293)*
- **Give MCP errors structured discriminant fields instead of baking context into `.message`.** `McpConnectError`/`McpHostUnavailableError` (`packages/mcp/src/errors.ts:23`, `:34`) and the ad-hoc `McpError` throws in `manager.ts` all string-interpolate identifying context (server id, tool name) into the message with no `.serverId`/`.toolId` property, violating `docs/standards/error-handling.md` and already causing test fragility (#203). `McpConnectError` additionally collapses every distinct connect-failure mode — ENOENT, network refusal, auth 401, protocol-version mismatch, timeout — into one identical message template, with `cause` deliberately stripped from the surfaced text (#204). Add `serverId`/`toolId` fields to the error classes, and give `McpConnectError` a `reason` discriminant derived from inspecting the caught error's shape at the catch site. *(S · `packages/mcp/src/errors.ts` · #203, #204)*
- **Document and best-effort-lint the unredacted workflow snapshot written to `history.db`.** `definitionJson: JSON.stringify(workflow)` writes the full admitted, MCP-augmented workflow into `runs.workflow_definition_snapshot`, unredacted and unencrypted. Declared-input masking does not remove authored credential literals in unrelated fields. Complete the classification in [database-schema.md](../../reference/shared-core/database-schema.md#secrets-at-the-write-boundary), and add a value-free best-effort warning at `create`/`import`/`run` using the [existing finite detector policy](../../reference/cli/commands.md#relavium-import--relavium-export). Preserve faithful snapshot/resume identity; this is not a universal credential classifier. *(S · `apps/cli/src/history/open.ts` · #30)*
- **Design and gate `llm_providers.default_headers` before live header consumption.** `ProviderUpsert.defaultHeaders` round-trips free-form strings through plaintext SQLite. ADR-0065's custom base-URL factory wiring already ships; its dormant header consumption is the future gate. **Accepted in [Step 7](#step-7-acceptance--2026-10-13)** under [ADR-0108](../../decisions/0108-provider-headers-stay-gated-until-keychain-custody.md): keychain custody for activation, with an interim refusal of every new nonempty map. Historical rows remain inert/sensitive, omission preserves and `{}` explicitly clears. No live header feature or automatic legacy migration is authorized by the Wave 2 design task. *(M · `packages/db/src/provider-store.ts` · G20/D13)*
- **Fix two independent fail-loud violations in `packages/mcp` together.** `SdkConnection.callTool` (`packages/mcp/src/sdk-stdio.ts:137`) silently substitutes `undefined` for a non-object `args` payload instead of failing loud — meaningful because the schema compiler treats a bare `{}` tool schema as `z.unknown()`, so a non-object payload can slip through `parseArgs` entirely (#206); `closeAll` (`packages/mcp/src/manager.ts:126`) discards every teardown error via a bare `.catch(() => undefined)` with zero logging, unlike the rest of `manager.ts`, which carefully types and preserves failures — a real diagnosability loss when triaging orphaned-process bug reports (#207). Both are small, same-package instances of the identical defect class. Throw a typed `McpError` for the bad-args case; have `closeAll` return `PromiseSettledResult[]` (or accept an `onCloseError` callback) so a caller with a logger can surface teardown failures. *(S · `packages/mcp/src/sdk-stdio.ts`, `packages/mcp/src/manager.ts` · #206, #207)*
- **Remove or properly harden the dead `~/.relavium/tmp/` directory.** `ensureGlobalConfigDir` (`apps/cli/src/config/paths.ts:27`) unconditionally creates `~/.relavium/tmp/`, but the following `chmodSync(dir, 0o700)` only chmods the parent — the `tmp` subdirectory never inherits the hardened mode. Nothing in the CLI currently writes into or reads from it. Remove the unused directory, or chmod it 0700 and add a one-line comment stating its intended future purpose. *(S · `apps/cli/src/config/paths.ts` · G21)*
- **Add per-file error-path tests for the MCP transport adapters ADR-0053 is specifically about.** Package-level coverage aggregation for `packages/mcp` (93.7%/95.5%) is pulled up by larger, well-tested files while `sdk-http.ts`, `sdk-sse.ts`, and `sdk-websocket.ts` — the exact transport adapters ADR-0053's network-egress security discipline covers — sit far lower per-file. Add direct tests per adapter for a malformed `spec.url` throw and a transport-construction failure; consider a per-file coverage floor for this directory. *(S · `packages/mcp/src/sdk-http.ts`, `sdk-sse.ts`, `sdk-websocket.ts` · #297)*
- **Track the `dns.promises.lookup` abort-follow-up as a documented low-priority item, not a bug.** `withEgressTimeout`'s own docstring (`packages/db/src/safe-egress.ts:199`) already discloses that an abort reaches the connection phase but not the DNS-resolution phase, since `dns.promises.lookup` isn't abortable — a deliberate, reasoned, already-documented tradeoff, not a live defect. Track the finding's own recommendation (a bounded custom resolver, or a `dns.setDefaultResultOrder`/threadpool-size note) as a filed low-priority follow-up rather than leaving it comment-only. *(S · `packages/db/src/safe-egress.ts` · G31)*
- **Derive `CLIENT_INFO.version` from the real package version instead of a hand-maintained literal.** `const CLIENT_INFO = { name: 'relavium', version: '0.1.0' }` (`packages/mcp/src/sdk-stdio.ts:34`) is a static literal already stale relative to the shipped CLI version, reported to every connected MCP server's `initialize` handshake. Source it from `package.json` (or a build-time-injected constant). *(S · `packages/mcp/src/sdk-stdio.ts` · #208)*

**Acceptance:** MCP tool descriptions/schemas are covered by the same untrusted-content boundary as call results, or the gap is explicitly documented in `mcp-integration.md`; a name-collision at the MCP config layer can no longer silently redirect a global secret without a loud warning; every MCP transport (stdio/SSE/WebSocket) has a real, configurable connect-phase timeout with per-transport defaults; a hostile MCP server cannot exhaust process memory via unbounded tool count, description length, embedded schema strings, or unbounded SSE/WebSocket frames, and this is proven by an adversarial test; `discoverCatalog` rejects a symlink resolving outside `projectConfigDir`; the sensitive-credential floor covers `.kube`/`.azure`/gcloud/terraform in the host path floor and the existing shared declared-env predicate; `history.db`'s 0600 self-heal survives a throwing migration and `config.toml`'s mode is re-asserted on load; `run --input` rejects a secret-typed value before execution; `deepestExistingReal` has one shared platform-free implementation imported by both `packages/db` and `apps/cli`; `readSecretFromStdin`'s stdin-only guarantee has direct multi-branch coverage plus a byte ceiling, preserving verbatim values; MCP error classes carry structured `serverId`/`reason` fields; the unredacted workflow snapshot's risk is documented and linted at authoring time; `os-keychain.ts` has direct tests mocking native-binding failure modes; the two `packages/mcp` fail-loud gaps throw/surface instead of silently swallowing; per-file MCP transport-adapter coverage no longer hides behind package aggregation. The original repairs alone require no new ADR; the pulled-forward trust/public-API/lifecycle changes retain the standing ADR threshold. G20/D13 must settle and enforce the interim gate before calling D complete; future header consumption (unlike already shipped custom base URLs) stays prohibited pending the custody/migration prerequisites. G31's existing DNS background-resource limit must be filed explicitly, not certified as abortable.

### 2.5.5.E — CLI operator-safety net: signals, error boundaries, crash handling & startup performance

This workstream is `apps/cli`'s outermost layer — the process/runtime host every invocation passes through before and after the command itself runs. Its defects share one shape: a safety mechanism built once (SIGINT teardown, `closeQuietly()`, `displayPath` redaction, `const exhaustive: never`, the `--json` envelope) and carried to most but not all of its call sites, so the gap only surfaces under Ctrl-C, a crash, a pipe closing early, or an unhandled event kind — never under a green `pnpm turbo run lint typecheck test`. It also owns the ~400ms tax every invocation pays before `--help`/`--version` can even print, and the diagnostic-flag system (`--quiet`/`--verbose`/`RELAVIUM_DEBUG`) a user reaches for exactly when something in this layer has already gone wrong.

**Tasks:**

- **Close the five remaining gaps in the CLI's outermost crash/signal safety net.** `processIo()` (`apps/cli/src/process/io.ts`) has no EPIPE handling, so a `--json` consumer that closes its reader early dumps a raw stack trace instead of a structured envelope. `buildProgram()` in `apps/cli/src/run.ts` is the one synchronous step inside `run()` not wrapped in the standard error path, despite `run()`'s own JSDoc promising it never rejects. There is zero `process.on('unhandledRejection'|'uncaughtException', ...)` registration anywhere in production `apps/cli/src` — an async error escaping `run()`'s own promise chain falls straight to Node's default handler, and `process.on('exit')` never reaps detached `run_command` child process groups or closes DB/MCP connections on a crash. The last-resort crash message in `apps/cli/src/index.ts` unconditionally writes plain text to stderr with no `--json` check, the sole exception to the CLI's otherwise-universal structured-envelope convention. Fix all five in `index.ts`/`run.ts`/`process/io.ts` together: add EPIPE handling, wrap `buildProgram()`, register the missing global handlers with child-process reaping and DB/MCP close-on-exit, and make the last-resort message honor `--json`. *(L · apps/cli/src/index.ts, apps/cli/src/run.ts, apps/cli/src/process/io.ts · #40, #41, #42, #224, #269)* **Source correction — 2026-10-15:** the recoverable rejection net already exists and keeps alive; preserve it. Proposed ADR-0110 adds fatal/early-import/output handling through registered owners. Do not close DB/MCP from exit without actual owner ACK or claim universal descendant containment; see the revised preflight and canonical proposed teardown scope.
- ✅ **DONE — Wave 3 Step 1, 2026-10-16** ([acceptance](#wave-3-step-1-acceptance--2026-10-16)). **Carry `const exhaustive: never` from `engine.ts` to the three sibling switches it was never propagated to, two of which drop live data.** `apps/cli/src/chat/persister.ts`'s event switch — the sole writer of `agent_sessions`/`session_costs` — silently drops any unhandled event kind via a bare `default`, a real money/data risk. Four picker key-routing switches in `apps/cli/src/render/tui/chat-ink.tsx` and `apps/cli/src/render/tui/home-controller.ts` lack the same guard on the reseat surface that already caused a data-loss-class bug. `apps/cli/src/render/tui/run-view-model.ts`'s `reduceRunEvent` silently drops `agent:reasoning` with no state field to hold it, so `relavium run` never shows reasoning that `chat` already renders — the exact bug class the guard in `apps/cli/src/chat/session-host.ts`'s `engine.ts`-derived pattern was invented to prevent, recurring on a different driver. Apply `const exhaustive: never` uniformly across all six sites. *(M · apps/cli/src/chat/persister.ts · #300, #301, G3)*
- **Centralize `openLocalDb` wrap-and-redact instead of leaving it well-wrapped at only 3 of 8+ call sites.** On the `run`/`chat`/`gate` paths the well-wrapped open happens AFTER an earlier unwrapped one, making the clean `CliError` message largely unreachable in practice. Separately, `packages/db/src/client.ts` interpolates a raw absolute path into its error with no redaction backstop, unlike `packages/llm`'s `scrubSecrets`. Move the wrap-and-redact logic inside `openLocalDb` itself so every caller gets it for free instead of re-implementing it. *(M · packages/db/src/client.ts · #278, #280)*
- **Wire `agent-run.ts`'s missing SIGINT handler and make chat's existing one actually abort the session.** `apps/cli/src/commands/agent-run.ts` registers zero SIGINT handler, so Ctrl-C orphans spawned MCP child processes. `drivePlain`/`driveJson`'s SIGINT handlers (chat driver) only close readline and never call `session.abort()`, letting the billed generation run to completion. Register a handler in `agent-run.ts` mirroring `driveRun`'s teardown, and make the chat handlers call `abort()`. *(M · apps/cli/src/commands/agent-run.ts · #21, #23)*
- **Wrap `gate.ts`'s two idempotent-resume success paths in the same `--json` branch every other command uses.** Both write plain human text to stdout unconditionally, breaking the NDJSON contract for scripted callers, and neither path is tested. No dependency on the 2.6.K resume-core extraction — fix in place. *(S · apps/cli/src/commands/gate.ts · #20)*
- **Fix `/doctor`'s hardcoded probe profile, which misreports the exact thing it exists to diagnose.** `apps/cli/src/chat/doctor.ts` probes tool-host wiring with a hardcoded profile instead of the session's actual one, so it always misreports `egress`/`os` capability as unwired regardless of the real config. Probe with the session's actual profile. *(S · apps/cli/src/chat/doctor.ts · G43)*
- **Implement `--help --json`'s promised `COMMAND_MANIFEST` serialization, or correct the docs that claim it exists.** Doc comments in `apps/cli/src/commands/manifest.ts` and user-facing docs both claim `--help --json` emits `COMMAND_MANIFEST` as JSON; no code path serializes it, confirmed by a passing test that asserts help stays human text. Either implement the missing serialization or amend the docs to match reality. *(M · apps/cli/src/commands/manifest.ts · #13)*
- **Defer the CLI's eager `driveHome` import and unconditional `seedCatalog()` call behind command-need, closing the ~400ms `--help`/`--version` tax.** `apps/cli/src/run.ts`'s static import of `driveHome` pulls in its full transitive graph — ink, react, the home controller, the DB layer, the native keychain binding — on every process start, even for `--help`/`--version`. `seedCatalog()` (`apps/cli/src/engine/catalog-refresh.ts`) does an unconditional sync read/parse/validate of the cached model catalog before checking whether pricing data is even needed. Measured ~390-410ms wall time for `--version` against ~30ms bare Node startup; a separate measurement centered on `dispatch.ts` confirmed the same root cause independently. Gate both behind a dynamic import keyed on actual command need; likely requires enabling `splitting: true` in `apps/cli/tsup.config.ts`, which currently emits a single bundle file. *(L · apps/cli/src/run.ts · #43, #44, #271)*
- ✅ **DONE — Wave 3 Step 1, 2026-10-16** ([acceptance](#wave-3-step-1-acceptance--2026-10-16)). **Extend `authoring.ts`'s cwd-relative `displayPath` error-path discipline to `resolve.ts`, `catalog.ts`, and `chat/export.ts`.** `apps/cli/src/authoring/authoring.ts`'s `readAuthoredFile` already renders filesystem errors against a cwd-relative `displayPath` instead of the raw absolute path; `apps/cli/src/workflows/resolve.ts` and `apps/cli/src/workflows/catalog.ts` never adopted it, and neither did the filesystem `CliError`s in `apps/cli/src/commands/chat-export.ts`. Apply `displayPath` at all three remaining sites so no command leaks the user's absolute home-directory path into an error message. *(M · apps/cli/src/workflows/resolve.ts · #4, G11)*
- ✅ **DONE — Wave 3 Step 1, 2026-10-16** ([acceptance](#wave-3-step-1-acceptance--2026-10-16)). **Fix `resolve.ts`'s 1x UTF-8 byte multiplier, which undersizes the load cap for non-ASCII workflow files.** `apps/cli/src/workflows/resolve.ts` compares `stats.size` directly against `MAX_SOURCE_CHARS` (a 1x multiplier); `authoring.ts` and `catalog.ts` both correctly use `MAX_SOURCE_CHARS * 4` to account for UTF-8's up-to-4-bytes-per-char worst case. On the `relavium run` load path this means a dense multibyte YAML file well under the real char cap can be wrongly rejected as oversized. Apply the same `* 4` multiplier used by its two siblings. *(S · apps/cli/src/workflows/resolve.ts · #3)*
- ✅ **DONE — Wave 3 Step 1, 2026-10-16** ([acceptance](#wave-3-step-1-acceptance--2026-10-16)). **Extend `chat.ts`'s `closeQuietly()` helper to the four sibling commands still using an unguarded `.close()`.** `apps/cli/src/commands/chat.ts` wraps every store-close in `closeQuietly()` so a close-time throw can never overwrite a successful exit code; `apps/cli/src/commands/run.ts`, `apps/cli/src/commands/gate.ts`, `apps/cli/src/commands/chat-export.ts`, and `apps/cli/src/commands/chat-list.ts` all still call `.close()`/`opened.close()` unguarded. Extract the helper to a shared location and import it into all four. *(S · apps/cli/src/commands/chat.ts · #22)*
- **Close `agent run`'s two UX-parity gaps against its sibling drivers in one pass.** `apps/cli/src/commands/agent-run.ts` blocks silently on a TTY with no piped stdin and prints no banner, unlike `chat`/`create` which both print one. `makePlainPrinter` (shared with `apps/cli/src/commands/chat.ts`'s plain-printer path) has no `cost:updated` case or final cost line for `agent run`'s non-JSON output, unlike `run`'s TUI/plain renderer. Both are the same shape of gap — `agent run` is the newest, least-mature driver — so add the stdin-TTY banner `create` already has and the cost line `run` already prints in the same change. *(S · apps/cli/src/commands/agent-run.ts · #24, #26)*
- **Add a dedicated exit code for unclassified internal faults, or amend the docs that call exit code 1 "workflow failed."** Exit code 1 is documented as meaning a failed workflow but is silently reused for any unclassified internal fault from any command, so a script branching on exit code cannot distinguish "your workflow failed" from "the CLI itself broke." Add a dedicated code or correct the documented contract. *(S · apps/cli/src/index.ts · G35)*
- **Resolve `--quiet`/`--verbose`/`RELAVIUM_DEBUG` into one coherent diagnostic-flag system and point the CLI's generic error fallbacks at it.** `--quiet` has exactly one consumer, and that consumer hardcodes the value away — a complete no-op. `--verbose` only gates `err.stack` on a top-level crash and has zero effect during a live session. `RELAVIUM_DEBUG` is undocumented and is a second, inconsistently-named escape hatch alongside `--verbose`. Both of the CLI's generic "internal error" fallback messages never mention `--verbose` or `RELAVIUM_DEBUG` as a way to get more detail — the same incoherence, seen from the user's side of the same broken flag system. Wire `--quiet` to actually suppress output, extend `--verbose` to gate live-session diagnostics, fold `RELAVIUM_DEBUG` into `--verbose`'s precedence chain, and append the resulting hint to both generic fallback messages in the same change; the fallback-message fix cannot be written correctly until the flag relationship is settled. **Approved 2026-10-16 in ADR-0110:** quiet+verbose conflict, explicit flags over exact DEBUG=1, independent JSON representation and preserved requested data/safety categories. Implementation remains staged. *(M · apps/cli/src/index.ts · #45, #264, #265, #268)*
- **Certify durable-only logs (G15; source correction — 2026-10-15).** The earlier token-firehose premise is refuted: shipping token/reasoning emission is live-only and logs reads durable rows. No coalescing decision or new persistence is required. Preserve actual replay with a real engine/store/log regression and JSON sequence-gap controls; the [reopened preflight](#maintainer-review-reopened-the-proposal--2026-10-15) records the evidence. *(M · apps/cli/src/commands/logs.ts · G15)*
- **Attach `GLOBAL_OPTIONS_HELP` to every subcommand's `--help`, not just the root program's.** `apps/cli/src/program.ts` defines `GLOBAL_OPTIONS_HELP` (documenting the position-independent flags `commander` itself doesn't parse, like `--json`/`--cwd`/`--verbose`) and attaches it only to the root program; `commander` does not propagate it to subcommand help output, so `relavium run --help` never shows it. Attach the same help text to each subcommand, or add an explicit pointer to `relavium --help`. *(S · apps/cli/src/program.ts · #17)*
- **Add a `--force` gate or interactive confirmation to `provider remove-key`, the manifest's sole `effect: 'destructive'` command.** `apps/cli/src/commands/provider.ts`'s `remove-key` action has no confirmation gate at all, unlike the create/import/export family, which all require explicit confirmation for destructive effects. Add the same pattern here. *(S · apps/cli/src/commands/provider.ts · #19)*
- ✅ **DONE ([Wave 3 Step 2](#wave-3-step-2-acceptance--2026-10-16)).** **Make `formatZodError` show schema-derived numeric bounds.** `apps/cli/src/config/load.ts`'s `formatZodError` includes the schema-derived bound value in enum-mismatch messages but withholds it for out-of-range numeric errors, so a `config.toml` value outside its valid range gets a less actionable message than a bad enum choice. Include the bound consistently across both error kinds. *(S · apps/cli/src/config/load.ts · #32)*
- **Add a direct unit test for `selectGatePrompter`'s TTY/json/CI routing decision.** `apps/cli/src/render/tui/home-controller.ts`'s `selectGatePrompter` has no direct test of its own, unlike its structurally identical sibling `apps/cli/src/home/should-open-home.ts`, which is tested. Add a test mirroring the sibling's coverage. *(S · apps/cli/src/render/tui/home-controller.ts · G37)*
- **Add a test for the positive `--verbose`-without-`--json` stack-dump branch, found untested independently twice.** `apps/cli/src/index.ts`'s render-error path has a branch that prints the stack trace when `--verbose` is set without `--json`; it has zero direct test coverage, flagged by two independent review passes. Add one test asserting the branch actually prints the stack. *(S · apps/cli/src/index.ts · G36, G46)*
- **Delete the byte-identical duplicate interface declaration in `models-pricing.ts`.** `apps/cli/src/commands/models-pricing.ts` declares the same interface twice with no functional difference. One-line deletion, no behavior change. *(S · apps/cli/src/commands/models-pricing.ts · G14)*
- **Fix `config.toml`'s atomic-write path silently orphaning a symlinked dotfile.** The config writer's atomic rename-into-place silently detaches an intentional dotfiles symlink at the target path instead of writing through it or warning. Detect a pre-existing symlink before the rename and either write through it or warn explicitly. *(S · apps/cli/src/config/write.ts · #34)*
- **Correct the stale ADR-0024 "no mid-session switching" comment in the agent-source resolution path.** A code comment still claims the ADR-0024-era invariant that no mid-session model switching is possible; the shipped ADR-0059 reseat contradicts it directly. Point the comment at ADR-0059 instead. *(S · apps/cli/src/authoring/authoring.ts · #11)*
- **Make the two-process lock-contention test fail loudly instead of silently skipping under a bare `pnpm test`.** The test silently skips (not fails) inside `apps/cli` when `@relavium/db`'s dist build is missing, dropping WAL-mode coverage with no red CI signal. Make the missing-dist condition a hard failure. *(S · apps/cli/src (cross-process lock test) · #47)*
- **Add direct tests for `seedRun`'s own misuse guard-rails.** `seedRun`'s guard-rails against an empty gates array and a duplicate `gateId` have zero test coverage of their own, so a regression in either guard would silently seed the wrong fixture with no signal. Add tests asserting both throw as documented. *(S · apps/cli/src (seedRun fixture helper) · #48)*
- **Give the palette step's swallowed rejection a comment or a user-visible trace.** A command-palette step's `run()` rejection is discarded with a bare `.catch(() => undefined)`, unlike sibling `.catch` sites elsewhere in the CLI that document why the rejection is safe to drop. Add the same justification, or surface the failure. *(S · apps/cli/src/render/tui/home-controller.ts · #281)*
- **Settle `--input`'s four-way flag-namespace collision with one maintainer naming decision.** `--input` currently means a workflow input `k=v` pair on `run`, a reserved/rejected `{{ctx.*}}` session variable on `agent run`, an arbitrary JSON/string gate payload on `gate`, and a USD-per-million-token price on `models pricing` — all sharing one flat `CommandInput.options` key across `apps/cli/src/commands/dispatch.ts` and `apps/cli/src/commands/specs.ts`, found independently in both files. **Approved 2026-10-16 in ADR-0110:** canonical `--input-price`/`--output-price` with deprecated old aliases and pre-normalization conflict refusal; intentionally retain/document the other command-scoped input meanings — one decision resolves both files at once; do not patch them independently. *(S · apps/cli/src/commands/dispatch.ts · #18, #310)*
- **Convert the three remaining bare `throw new Error()` sites to the project's typed `CliError`.** `apps/cli/src/chat/fixture.ts`'s cassette provider and `apps/cli/src/engine/host.ts`'s checkpointer wiring guard both throw a bare `Error` instead of `CliError`. `apps/cli/src/onboarding/wizard.ts`'s internal choice-validation guard does the same, contradicting its own docstring's claimed propagation contract, even though `CliError` is already imported in that file for a different branch. Convert all three in one mechanical pass. *(S · apps/cli/src/onboarding/wizard.ts · G2, #12, #54)*
- **Generate and privately archive a per-release sourcemap so a `RELAVIUM_DEBUG` crash stack can be symbolicated.** `apps/cli/tsup.config.ts` correctly ships `sourcemap: false` per ADR-0051 (no original source in the published `dist/`), but no separate, privately-retained sourcemap exists anywhere in the release pipeline, so a `RELAVIUM_DEBUG` stack trace prints mangled minified names with no way to map them back. Generate a sourcemap at release-build time and archive it outside the published artifact. *(M · apps/cli/tsup.config.ts · #46)*

**Acceptance:** Ctrl-C during `agent run`/`chat` actually cancels the in-flight generation via `session.abort()` and tears down spawned MCP child processes the same way `run`'s driver already does; `gate.ts`'s two idempotent-resume success paths honor `--json`; `persister.ts`, the four picker switches, and `run-view-model.ts`'s `reduceRunEvent` all carry `const exhaustive: never` and `relavium run` renders `agent:reasoning` events; `openLocalDb` wraps and redacts at every call site, not just 3 of 8+; `/doctor` probes with the session's real profile; `--help --json` either emits a real `COMMAND_MANIFEST` or the docs no longer claim it does; `--version`/`--help` no longer pay the ~400ms `driveHome`/`seedCatalog()` tax; `resolve.ts` uses the same `* 4` UTF-8 byte multiplier as `authoring.ts`/`catalog.ts`; no command leaks an absolute filesystem path into an error message; the existing recoverable rejection net is preserved and the approved process-owner/fatal policy attempts bounded native cleanup without false DB/MCP close ACK or universal descendant-containment claims, `buildProgram()` is wrapped, EPIPE no longer dumps a raw stack, and the last-resort crash message honors `--json`; `provider remove-key` requires confirmation like its sibling destructive commands; and every closed test-coverage gap (`selectGatePrompter`, the verbose-stack branch, `seedRun`'s guard-rails, the cross-process skip) has a red-on-regression test. **Required ADRs: ADR-0110–0113, accepted 2026-10-16.** Their explicit compatibility, packaging/custody, operator policy and provenance decisions replace the old no-new-ADR assumption; implementation remains staged in the approved Wave 3 plan.

### 2.5.5.F — Documentation & roadmap accuracy

The project's own documentation conventions — cite-not-restate, status banners synced to the file they summarize, `(planned)`/not-yet-shipped hedge markers on unbuilt surfaces — are correctly applied in most of `docs/`, which is exactly what makes the gaps legible: each finding here is a site the convention was never propagated to, not a missing convention. The largest single item in this sub-stream is one root-cause fix applied at twenty independent sites by three review passes that each rediscovered the same gap from a different angle. The rest is stale cross-references, broken links, and status prose that fell behind a merge event that updated a sibling file in the same commit. None of it touches runtime code; all of it is read-file/write-file work that a single coordinated pass can close per bullet.

**Tasks:**

- **Regeneralize the not-yet-built hedge convention to all twenty sites it was never extended to.** The project already has a correct, working convention — `Reserved`/`(planned)` tags, not-yet-shipped blockquotes — used correctly in some docs, and this is the single biggest propagation gap in the whole review. Feature/API-level: ADR-0016/ADR-0017 describe `apps/api` as if scaffolded (it doesn't exist); `mcp-integration.md` (tagged Stable) documents a fabricated `createMcpAdapter` API that was never written; `agent-yaml-spec.md` documents `agent.memory` as operational though no code reads it; `desktop/routes-and-screens.md` claims retry-from-node support with no engine mechanism; `store-shapes.md`/`ipc-contract.md` are tagged Stable despite zero implementing code; `vision.md` lists retry-from-node as a Phase-1 Killer Feature with no build-phase caveat, unlike its sibling bullets. Surface-level: `README.md`/`project-structure.md` present desktop/VS Code as running the engine today with no not-built marker; `desktop-architecture.md` describes the 0%-built app in present tense; `overview.md` overclaims SQLCipher/Postgres as shipped and understates the actually-shipped CLI (four separate passages); `packages/ui`'s own doc carries no not-built marker; the key-setup runbook walks a 0%-built desktop UI and never states the stdin-not-argv rule for entering keys (a real key-leak risk); `local-dev-setup.md` gives a failing/wrong CLI dev-loop command; three more docs describe Tauri/WebView mechanics as shipped fact. Command-table-level: `commands.md`'s `budget resume` row lacks the `_(planned)_` annotation its unshipped neighbors carry — the same line was independently flagged by three different review units. Fix all twenty in one coordinated sweep, correcting the wrong dev-loop command in the same pass. *(L · docs/ (20 files, cross-cutting) · #122, #141, #142, #146, #147, G23, G24, G28, #130, #131, #150, #154, #155, #156, #159, #255, #136, #16, #144, #256)*
- **Sync five roadmap/status docs that fell behind a merge event that updated a sibling doc in the same commit.** `current.md` still says 2.6.Q is blocked on seven decisions the maintainer must answer, but ADR-0071 (Accepted 2026-07-13) and ADR-0072 (Accepted 2026-07-14) already resolved the six — not seven — open ADR questions the phase file itself cites, and the "seven" figure contradicts the phase file's own "six open ADR questions" count in the same paragraph. `AGENTS.md` fell behind `CLAUDE.md`'s mirror contract. `docs/roadmap/phases/phase-2.6-conversational-authoring.md`'s own banner never picked up 2.6.C's completion. `docs/roadmap/phases/phase-3-desktop.md`'s status line predates the 2026-07-08 rescope. Fix all five in one pass; add a note recommending banner updates land in the same commit as any merge/rescope going forward. *(M · docs/roadmap/current.md, AGENTS.md, docs/roadmap/phases/phase-2.6-conversational-authoring.md, docs/roadmap/phases/phase-3-desktop.md · #127, #132, #133, #138, #139)*
- **Refresh the flagship chat tutorial and reroute the onboarding path off 0%-built surfaces.** The chat tutorial is still marked "planned" though `chat.ts` is 2300+ lines and feature-complete; the recommended onboarding path routes a new user through desktop and VS Code, both 0%-built; the tutorials sub-index in the same folder omits the chat tutorial entirely. Rewrite the tutorial as shipped, reorder the recommended path around chat and a CI run, and fix the sub-index — one pass. *(M · docs/tutorials/ · #160, #161, #166)*
- **Fix overview.md's system-map diagram: a Core→DB edge that doesn't exist, and a misdrawn LLM→Keychain injection boundary.** The diagram draws a `Core`→`DB` edge that has no counterpart in `packages/core/package.json` and contradicts the host-injected-`Checkpointer` framing used elsewhere in the same doc. The same diagram's `LLM`→`Keychain` edge misrepresents the injection boundary — this half is contested and needs a maintainer to confirm the corrected routing (`LLM`→`Transport`(injected)→host→`Keychain`) before the diagram is redrawn. Bundle both fixes into one PR once the routing is confirmed. *(S · docs/architecture/overview.md · #148, #149 — blocked: maintainer must confirm the corrected LLM→Keychain edge routing before redraw)*
- ✅ **DONE (2026-07-29).** **Add `packages/mcp` to the five package-inventory tables it is missing from.** `packages/mcp` is a real, shipped, tested package absent from `CLAUDE.md`'s package table, `docs/project-structure.md`'s table/diagram/intro text, `docs/architecture/overview.md`'s package list/diagram, and the `.claude/agents/relavium-reviewer.md` reviewer agent's own inventory — the last of which risks an ADR-0052 boundary violation slipping past review undetected because the reviewer's checklist never looks at the package. Add it to all five sites in one pass. *(S · CLAUDE.md, docs/project-structure.md, docs/architecture/overview.md, .claude/agents/relavium-reviewer.md · #128, #129, #153, #163, #254)*
- **Rewrite four docs that still name the retired hand-typed `pricing.ts` `MODEL_PRICING` table as the pricing authority, two ADR-generations stale.** `docs/reference/cli/commands.md`'s `relavium models` intro still describes the pre-ADR-0071/ADR-0072 architecture — found independently by three review units at the exact same line — and self-contradicts its own `models pricing` subsection two paragraphs later. The same doc's `models pricing --json` section is missing the `overriddenCatalogPrice` field and the `--clear --json` output shape. `docs/architecture/multi-llm-providers.md` separately names the deleted table as canonical. The models.dev analysis doc's provider-precedence table is stale with no forward link to ADR-0071/ADR-0072. Not gated on the blocked 2.6.Q — this is one coordinated pass rewriting all four docs against the now-Accepted ADRs. *(M · docs/reference/cli/commands.md, docs/architecture/multi-llm-providers.md, models.dev analysis doc · #14, #15, G13, G25, #165, #250)*
- ~~**Fix node-types.md's overstated `merge_strategy: 'first'` claim.**~~ ✅ **DONE (2026-09-02, [ADR-0091](../../decisions/0091-first-means-first-declared-not-first-to-finish.md), `CR-60`).** The row no longer claims losing branches are cancelled; it states the first surviving branch by `branchNodeIds` declaration order, that the join waits for every branch, and that a failing loser fails the run. *(Split out of the two-bug item below on 2026-09-03 — bundling them risked a later hygiene pass "re-fixing" this half against its now-superseded description and reverting the ADR's wording. · G10)*
- ✅ **DONE (2026-09-03, verified against `HumanGateNodeSchema` while checking `CR-63`'s doc claims).** **Fix node-types.md's three fabricated `human_in_the_loop_config` fields.** All three confirmed: `prompt_template` is really `message_template`, `on_timeout` is really `timeout_action`, and `input_schema` does not exist on the gate at all. The row also omitted `gate_type` (required) and `assignee`. `HumanGateNodeSchema` is `.strict()`, so an author following the row as written got an immediate parse rejection — and the two real fields they needed were not listed. *(S · docs/reference/shared-core/node-types.md — the item previously gave the path as `docs/reference/core/`, which does not exist · G45)*
- ✅ **DONE (2026-07-29).** **Close two gaps in the review checklists themselves: the reviewer agent's security item covers only the 0%-built desktop threat model, and the security-review skill's SSRF step never requires confirming reuse of the shared primitive.** `.claude/agents/relavium-reviewer.md`'s checklist item 6 (renumbered from 5 when the `packages/mcp` item landed) covers only the unbuilt desktop threat model and omits the CLI-specific security floor that actually ships today. The `security-review` skill's SSRF step doesn't require confirming that a change reuses the shared SSRF-guard primitive rather than hand-rolling a new check. Add both missing checklist items in one pass. *(S · .claude/agents/relavium-reviewer.md, .claude/skills/security-review/SKILL.md · #164, #167)*
- ✅ **DONE (2026-07-29).** **Anchor three skills' hardcoded foreign-project paths to the repo root.** Three skills under `.claude/skills/` embed literal hardcoded paths copy-pasted from an unrelated project — a functional bug, not a style nit: the skill either fails outright or, worse, writes files outside this repo when run as-is. Anchor each on `` `$(git rev-parse --show-toplevel)` `` the way sibling skills already correctly do. *(S · .claude/skills/ (3 files) · #162)*
- **Repo-wide docs link/index hygiene sweep: four broken relative links, three missing ADR cross-reference pointers, and four stale reference-doc index tables.** Superseded ADR-0021 has no in-body amendment pointer forward to the new Node floor decision. ADR-0069's Related line 404s to a renamed file — it links `0047-cli-render-seam-and-framework-free-cores.md` but the real file is `docs/decisions/0047-cli-framework-commander-ink-clack.md`. ADR-0071's `### K7.` header gives no in-header signal that it belongs to a separate numbering track. An independent repo-wide crawl of every relative markdown link under `docs/` found four genuinely broken links — one of which duplicates the ADR-0069→ADR-0047 link above — plus a wrong-subdirectory link in ADR-0062. Separately, `docs/reference/README.md`'s shared-core table lists only 5 of 11 real files; `docs/standards/documentation-style.md` §6's canonical-artifact registry is missing 6 of 11, including the safety-critical `llm-provider-seam.md`; `docs/reference/shared-core/agent-runner.md` is orphaned from both indexes despite being cited by six other docs; the `docs/reference/cli/` index is missing `accessibility.md` and `regression-harness.md`. Regenerate all four index tables from the real file tree, fix the four broken links, and add the three missing ADR pointers in one coordinated sweep; recommend a CI link-checker afterward to prevent recurrence. *(M · docs/decisions/, docs/reference/README.md, docs/standards/documentation-style.md, docs/reference/cli/ · #123, #124, #126, #143, #151, #251, #252, #253)*
- **Trim two ADRs and one project-structure.md row that restate content already living verbatim in their own cited canonical doc.** ADR-0031 states "canonical types live in `llm-provider-seam.md`" and then spends roughly 250 lines re-deriving the exact same content that file already carries. ADR-0027's addendum states exact sandbox resource-cap numbers that already live in `expression-sandbox-spec.md`, even after the ADR's own preamble names that spec the single canonical home. `docs/project-structure.md`'s Apps table restates a hand-picked, now-stale CLI subcommand list instead of linking to `docs/reference/cli/commands.md`, which already owns it canonically, and has drifted out of sync as a direct result. All three are the identical CLAUDE.md rule-8 violation — trim each ADR to drivers/tradeoffs plus a citation, and replace the stale restated list with a link. *(M · docs/decisions/0031-*.md, docs/decisions/0027-*.md, docs/project-structure.md · #120, #121, #257)*
- **Add three missing rows/notes to `tech-stack.md`, the single source of truth for pinned choices.** `docs/tech-stack.md` omits `smol-toml` and `string-width` as ADR-backed runtime dependencies (both already shipped and in `package.json`), and is missing an MCP SDK shape-tradeoff note that should cross-reference ADR-0034. The Playwright e2e row is the one un-flagged not-yet-applicable row in an otherwise carefully phase-annotated doc. Add the two missing dependency rows, the tradeoff note, and the same Phase-3 flag every other not-yet-applicable row already carries, in one pass. *(S · docs/tech-stack.md · #246, #247, #140)*
- **Rewrite CLAUDE.md's and README.md's shared i18n-status clause: wrong on stage, wrong on language count, repeated in both files.** `CLAUDE.md`'s "What this project is" section lists "settings/theming/`en`+`tr` localization" as in-progress Phase 2.6 scope, reading as already shipping — an exhaustive grep for i18n/locale/translation scaffolding across `apps/cli` finds zero hits; the theme hasn't started at all. The language count is now settled by maintainer ruling (2026-07-26): the catalog is architected for n locales but **`en` + `tr` are what ship in Phase 2.6**, with `es`/`fr`/`de` staged — so the existing en/tr wording is correct on scope and wrong only on stage. One rewrite of the shared clause in both `CLAUDE.md` and `README.md`, adding an explicit not-started qualifier and naming the staged locales, fixes all three. *(S · CLAUDE.md, README.md · #74, #260, #134)*
- **Add the six load-bearing terms missing from the glossary and refresh its stale "Last updated" header.** `docs/glossary.md` omits `ExecutionHost`, `ToolHost`, `ActionGuard`, `MediaStore`, `WorkflowEngine`, and `BudgetGovernor` — terms that recur across the ADR corpus without a defined home — and its "Last updated" header is over a month stale relative to the file's own content. Bundle both fixes into the same edit. *(S · docs/glossary.md · #135, #137)*
- **Swap `docs/architecture/README.md`'s recommended reading order to match both target docs' own stated shipping order.** The recommended order puts `cloud-phase-2.md` before `managed-inference.md`, contradicting both documents' own stated shipping/dependency order (managed inference is Phase 5, cloud execution is Phase 6). Swap the two entries. *(S · docs/architecture/README.md · #157)*
- **Add the missing `style` commit type to `commit-style.md`'s enumerated Types list.** `docs/standards/commit-style.md` enumerates `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci` but omits `style`, which real repo history already uses (e.g. `style: prettier the ADR-0072 files`, HEAD-2). Add it to the documented list so the doc matches actual practice. *(S · docs/standards/commit-style.md · #158)*
- **Wire Home's `showCost` past its hard-coded no-op now that ADR-0070's DB-backed cost breakdown makes it free to implement.** `apps/cli/src/render/tui/home-controller.ts:968` hard-codes `showCost: () => undefined`, so `/cost` only works in chat's REPL (`chat.ts:1142` has the real implementation) and silently does nothing from Home — even though ADR-0070 §7 states the DB-backed `session_costs` table makes Home parity implementable for free. Needs a maintainer call on ownership before the (trivial) wiring lands: is this in-scope for 2.6.E (chat/input parity polish), or a standalone maintenance fix against the already-closed 2.6.C. *(S · apps/cli/src/render/tui/home-controller.ts · #125 — blocked: maintainer must decide whether this is 2.6.E scope or a standalone fix against closed 2.6.C)*
- **Rename the test-only `force-color.ts` chalk shim so it can't be mistaken for the real `NO_COLOR`/`FORCE_COLOR` runtime gate.** `apps/cli/src/render/tui/force-color.ts` is a test-only chalk-forcing shim with a name that reads as if it were the production color-capability gate, which actually lives in `options.ts`/`projection.ts`. Rename it to something test-scoped (e.g. `force-color.test-shim.ts`) and add a one-line cross-reference comment pointing at the real gate. *(S · apps/cli/src/render/tui/force-color.ts · G42)*
- **Correct the doc comment on `urlSourceSchema` that asserts the opposite of the flag's actual current state.** A doc comment attached to `urlSourceSchema` (a security-relevant media feature flag) states the flag's behavior backwards from what the code actually does today. Correct the comment to match the real, current gating. *(S · packages/shared/src/content.ts (or the file defining `urlSourceSchema`) · #238)*
- **Sync `agent-runner.md`'s documented `cost:updated` payload with the `priced` boolean field ADR-0070 added.** `docs/reference/shared-core/agent-runner.md` predates ADR-0070 and its documented `cost:updated` event payload is missing the `priced` boolean field ADR-0070 added to `CostUpdatedEventSchema`. Add the field to the documented shape and cite ADR-0070 as the source. *(S · docs/reference/shared-core/agent-runner.md · #145)*

**Acceptance:** no canonical doc names the retired `pricing.ts` `MODEL_PRICING` table as the pricing authority; every reference to an unbuilt surface (desktop, VS Code, `apps/api`/`portal`, `packages/ui`) carries the same not-yet-shipped marker convention already used correctly elsewhere in the corpus, at all twenty flagged sites; every reference-doc index (`docs/reference/README.md`, `docs/reference/shared-core/README.md`, `documentation-style.md` §6, `docs/reference/cli/` index) lists every real file in its directory with zero broken relative links, verified by a link-check pass; `packages/mcp` appears in all five package-inventory tables/diagrams including the reviewer agent's own checklist; every roadmap status banner (`current.md`, `AGENTS.md`, the phase-2.6 and phase-3 banners) matches the state recorded in the file it summarizes, with the 2.6.Q "seven decisions" figure corrected to six; the chat tutorial and onboarding path reflect that `chat.ts` ships today; `node-types.md`'s `merge_strategy`/`human_in_the_loop_config` claims match the schema and engine exactly; the three hardcoded-path skills run correctly from a fresh clone via `` `$(git rev-parse --show-toplevel)` ``; `commit-style.md` lists `style` as a valid type; the glossary defines all six missing terms and its date header is current; CLAUDE.md and README.md state the i18n theme as not-started, shipping `en` + `tr` with `es`/`fr`/`de` staged (the 2026-07-26 ruling). The two blocked items (`overview.md`'s LLM→Keychain edge, Home's `showCost` wiring) surface as explicit open questions in the phase file rather than being silently resolved by guess.

### 2.5.5.G — Codebase hygiene: naming, duplication & dead code

Cross-cutting code-quality debt with no owning subsystem, concentrated in `packages/core`, `packages/llm`, and `apps/cli`'s TUI layer. The unifying shape is the review's central pattern turned inward on the codebase itself: a canonical helper, constant, or vocabulary word already exists — `formatCostUsd`, `CHARS_PER_TOKEN`, the `reseat*` family, the `ok` discriminant, `string-width`'s control-character handling — and a nearby site reimplements it, spells it differently, or trips over its edge case instead of reusing it. None of these are functional regressions the toolchain would catch; they are the accumulated tax on the next reader's ability to grep, rename, or trust a boundary, plus one live rendering-correctness bug (tab width) and two money-display defects (raw microcents shown to users, a duplicated cost divisor) that sit just above cosmetic.

**Tasks:**

- **Expand tabs before measuring transcript width.** `stripTerminalControls` (`apps/cli/src/render/sanitize.ts`) deliberately preserves `\t` in transcript body text, but `displayWidth`/`graphemeWidth` (`apps/cli/src/render/tui/viewport.ts`) delegate to `string-width`, which measures any control character — including tab — as 0-width, while a real terminal expands a literal tab to the next 8-column stop. This breaks the viewport module's own documented invariant ("1 DisplayLine == 1 terminal row"): scroll offsets and mouse row→line mapping drift whenever a tab reaches the transcript (shell/tool output, TSV data, a tab-indented code block a model emits). Expand tabs to spaces at the same display boundary `sanitizeInline` already uses for short fields, or give `wrapLogicalLine`/`displayWidth` explicit tab-stop-aware accounting, and add a `viewport.test.ts` case pinning the chosen behavior. *(M · apps/cli/src/render/tui/viewport.ts · #65)*
- **Replace four hand-rolled money/token reimplementations with the canonical helpers they already sit next to.** `capUsd` (`apps/cli/src/chat/effort-notice.ts`) hand-rolls the same ÷1e8 microcent→USD conversion `format.ts`'s `formatCostUsd`/`formatCostShort` already canonicalize — against `format.ts`'s own explicit "never a second hand-rolled divisor" comment (#236). `TOKENS_PER_MTOK` is declared independently in both `packages/llm/src/budget-estimator.ts` and `packages/llm/src/cost-tracker.ts`, despite `budget-estimator.ts` already importing other symbols from `cost-tracker.js` (#237). `mention.ts` (`apps/cli/src/render/tui/mention.ts`) hardcodes its own `Math.ceil(bytes / 4)` for the `@`-mention token warning instead of importing `CHARS_PER_TOKEN` from `packages/llm/src/adapters/shared.ts` (#242). `budgetWarningText` (`apps/cli/src/commands/chat.ts`) interpolates raw microcents directly ("~80% of the 500000000µ¢ cap reached") instead of calling `formatCostUsd`/`formatCostShort` — the one cost-facing string in the CLI that doesn't (#307). One mechanical replace-with-import pass, no new logic, closes all four. *(S · apps/cli/src/chat/effort-notice.ts, packages/llm/src/budget-estimator.ts, apps/cli/src/render/tui/mention.ts, apps/cli/src/commands/chat.ts · #236, #237, #242, #307)*
- **Split the `Capability` vocabulary collision and unify it with `Port`.** `packages/llm/src/capabilities.ts`'s bare `Capability = keyof CapabilityFlags` (a model feature flag) collides with `packages/core/src/tools/types.ts`'s `FsCapability`/`ProcessCapability`/`EgressCapability`/`OsCapability`/`McpCapability` (host-injected ToolHost-seam implementations) — the same root word for two unrelated architectural roles, hurting greppability on exactly the seam a security review audits (#217). The identical host-injected pattern is separately spelled `Port` elsewhere (`HomeModelsPort` in `apps/cli/src/render/tui/home-controller.ts`, `SuspendPort`, `MediaWritePort`, `MediaReferencePort`), so `apps/cli` imports both spellings for one concept in sibling files (#222). Rename `packages/llm`'s bare `Capability` alias to `ModelFeature`/`FeatureFlag`, leave `core`'s `*Capability` family (already matching ADR-0037/ADR-0041's ToolHost vocabulary) as sole owner of the word, and settle on `Port` as the one name for "host-injected dependency interface," recording the convention in `docs/standards/architectural-principles.md`. *(S · packages/llm/src/capabilities.ts, packages/core/src/tools/types.ts · #217, #222)*
- **Pick one spelling each for `ok`/`success` and `model`/`modelId`.** `packages/core` uses `{ ok: true | false }` at 49 call sites across the package (`agent-runner.ts`, `agent-session.ts`), but `tools/registry.ts` and `engine/agent-turn.ts` use `success: true | false` for the identical binary-outcome shape (#216). Within `packages/llm`'s catalog/pricing layer, lookups split roughly 50/50 between `modelId` (`pricing.ts`'s `catalogPricing`, `cost-tracker.ts`) and `model` (`pricing.ts`'s `contextWindowForModel`, `output-cap.ts`, `adapters/shared.ts`) for the same lookup-key role. Rename the two `success` sites to `ok` (or document the wire-schema exception for `ToolResultEventData.success`), and standardize on `modelId` for every catalog/pricing-lookup parameter, reserving `model` for signatures that literally forward `LlmRequest.model`. *(S · packages/core/src/tools/registry.ts, packages/core/src/engine/agent-turn.ts, packages/llm/src/pricing.ts · #216, #221)*
- **Rename `swapAgentModel` to match the dominant "reseat" vocabulary.** ADR-0059 ("CLI mid-session model reseat") and the surrounding codebase use `reseat*` identifiers pervasively (100+ occurrences in `apps/cli/src/commands/chat.ts` alone: `reseatChat`, `ReseatTarget`, `createReseatRebuild`, `finalizeReseatOutcome`). Yet the actual mutation function performing the model rebind — `swapAgentModel` (`apps/cli/src/chat/session-host.ts`), whose own docstring calls it a "model SWITCH" — and the dispatcher `resolveSwapRebuild` (`chat.ts`), which branches on `outcome.kind === 'reseat'`, both use a third word for the same operation, so a grep for "reseat" against ADR-0059's implementation misses it entirely. 2.6.C is closed, so this is a maintenance rename against shipped code, not new scope: rename `swapAgentModel` → `reseatAgentModel`, keeping "swap" only as the deliberately broader umbrella term where `resolveSwapRebuild` genuinely branches on two outcome kinds. *(S · apps/cli/src/chat/session-host.ts · #218)*
- **Delete three knip-confirmed dead exports and their false justifying comments.** The `@relavium/llm/adapters` subpath export (`packages/llm/src/adapters/index.ts`) has zero real consumers — `packages/llm/src/providers.ts` imports the three adapter factories directly from their own files, bypassing the barrel entirely (#239). `isDispatchableId` (`apps/cli/src/commands/dispatch.ts`) is exported with a doc comment claiming "a surface calls this before dispatch," but no call site exists anywhere in the repo (#240). `FRAME_MS`'s re-export from `apps/cli/src/render/tui/ink-renderer.ts` carries a comment claiming "existing importers" use it, but every real consumer (`drive-home.tsx`, `chat-ink.tsx`, `synchronized-output.test.tsx`) imports it directly from `tui-constants.js` instead (#241). Delete each dead export/re-export and its stale comment, or, for the `/adapters` subpath, replace the comment with a note on which future consumer it is reserved for if kept deliberately. *(S · packages/llm/src/adapters/index.ts, apps/cli/src/commands/dispatch.ts, apps/cli/src/render/tui/ink-renderer.ts · #239, #240, #241)*
- **Pin every identifier-sorting `localeCompare` call to break the machine-locale dependency.** `models refresh --json`'s provider sort (`apps/cli/src/engine/model-refresh.ts`) calls `a.provider.localeCompare(b.provider)` with no locale argument, so the comparison resolves against the invoking machine's ambient `Intl` locale (e.g. `LANG`) rather than anything Relavium controls — breaking the ADR-0049 byte-identical `--json` promise, since e.g. Turkish collation reorders relative to `en_US` (#258). The same unpinned pattern recurs at 7+ more sites sorting closed-set ASCII identifiers: `apps/cli/src/engine/mcp-servers.ts` (env var names, tool allowlist), `apps/cli/src/workflows/catalog.ts` (workflow/agent slug order feeding both the Home browser and `relavium list`), `apps/cli/src/commands/list.ts`, `apps/cli/src/render/tui/mention.ts`, and `packages/core/src/tools/registry.ts`/`errors.ts` (`UnknownToolError`'s message, which can propagate into a `node:failed` RunEvent's `outputSummary` and thus into the NDJSON stream too) (#259). One shared `compareIdentifiers(a, b)` helper — a plain ASCII ordinal comparison, matching the one site that already gets this right (`packages/llm/src/model-catalog.ts`'s `localeCompare(y.displayName, 'en')`) — closes the whole sweep in one pass. *(M · apps/cli/src/engine/model-refresh.ts, apps/cli/src/engine/mcp-servers.ts, apps/cli/src/workflows/catalog.ts, packages/core/src/tools/registry.ts · #258, #259)*
- **Estimate attachment token warnings from injected content, not raw file size.** `fileAttachmentWarning` (`apps/cli/src/render/tui/attachments.ts`) documents its estimate as computed "from the ACTUALLY-INJECTED (bounded) length — NOT the raw file size," but the implementation always derives `injectedTokens` from the `sizeBytes` parameter, never from `content.length`. For ASCII content the two values are numerically equal, masking the bug, but for any multi-byte UTF-8 content (non-Latin scripts, emoji, i18n fixtures) `sizeBytes` exceeds `content.length`, so the non-truncated-branch warning reports an inflated token estimate against the function's own documented contract. Switch to `Math.min(content.length, INJECT_MAX_CHARS)`, and extend the existing test with a `content`/`sizeBytes` pair that diverge, since the current fixture passes identical values for both and cannot catch this. *(S · apps/cli/src/render/tui/attachments.ts · G54)*
- **Harden two structurally-checked type escapes that rely on control flow, not the compiler.** `catalog-metadata.ts` (`apps/cli/src/engine/catalog-metadata.ts`) casts Zod-validated catalog data to `CatalogPriceTier[]`/`ReasoningControls`/`RequestCapabilities` via `as X` on a money/capability-adjacent boundary feeding the ADR-0028 cost cap — TS rejects a structurally-incompatible cast, but not a future schema change that stays structurally assignable while becoming semantically wrong (#303). `schema-compiler.ts` (`packages/mcp/src/schema-compiler.ts`) uses non-null assertions (`built[0]!`, `literals[0]!`) that are correct today only because an adjacent `if` guards the invariant, not because `noUncheckedIndexedAccess` enforces it — a future reorder of that guard would silently reintroduce a runtime crash with no compiler signal (#304). Add a round-trip fixture test pinning the catalog schema-to-interface mapping for the former; destructure-and-check instead of asserting for the cheap cases of the latter, commenting the rest. *(S · apps/cli/src/engine/catalog-metadata.ts, packages/mcp/src/schema-compiler.ts · #303, #304)*
- **Bound `SGR_MOUSE`'s digit groups to match the file's own defensive posture.** `SGR_MOUSE = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/` (`apps/cli/src/render/tui/mouse.ts`) accepts an unbounded digit run in each field on the complete-report path, while the partial-fragment path in the same file caps at `MAX_PARTIAL_LENGTH` (24) specifically "so a malformed stream cannot grow a buffer." Not currently exploitable — `Number()` on an oversized digit string saturates rather than throwing, and a real terminal only ever emits 1-5 digit fields — but it is an inconsistency against the file's own stated bounding discipline. Cap each digit group to `\d{1,5}`, matching the fragment path's defensive intent. *(S · apps/cli/src/render/tui/mouse.ts · G55)*

**Acceptance:** `capUsd`, `TOKENS_PER_MTOK`, and `mention.ts`'s chars-per-token heuristic all import the canonical helper/constant instead of reimplementing it, and `budgetWarningText` renders through `formatCostUsd`/`formatCostShort`; `Capability` no longer means two different things across `packages/llm` and `packages/core`, and the host-injected-dependency pattern has one name (`Port`) repo-wide; the `ok`/`success` and `model`/`modelId` pairs each follow one documented convention within their package; `swapAgentModel` reads as `reseatAgentModel` and every ADR-0059 grep for "reseat" finds it; the three knip-confirmed dead exports (`@relavium/llm/adapters`, `isDispatchableId`, the `FRAME_MS` re-export) are removed or their justifying comments corrected; every `relavium models refresh --json` and other closed-set-identifier sort is locale-independent under a non-`en` `LANG`, proven by a test run under a pinned non-default locale; `fileAttachmentWarning` derives its estimate from `content.length`, tested against a diverging multi-byte fixture; the `catalog-metadata.ts` cast and `schema-compiler.ts` assertions are either guarded by a round-trip test or reduced to a checked destructure; `SGR_MOUSE` caps each digit group at `\d{1,5}`. No `--json` output shape changes and no runtime behavior changes except the tab-width fix and the four money-display corrections.

### 2.5.5.H — CI, build pipeline, test-infrastructure & observability foundation

This substream is the development-process substrate itself — `.github/workflows/`, `turbo.json`, `tools/`, `vitest.config.ts`, and the complete absence of the structured-logging layer `docs/standards/logging-and-observability.md` describes. None of it is product runtime code, but all of it gates what regresses silently, and the same shape repeats across every item: a real gap in what CI actually verifies, paired with a standard or doc-comment that already claims the stronger guarantee it doesn't enforce. Closing it makes the toolchain's own claims about itself true again — a required gate that runs the binary, a coverage floor that's either enforced or honestly advisory, a dependency guard that covers every package that needs it.

**Tasks:**

- ✅ **DONE (PR #80, 2026-07-29).** **The required PR gate never executes the compiled binary, and turbo's build task doesn't declare the drizzle side-effect that binary needs.** The required `ci` job in `.github/workflows/ci.yml` builds `apps/cli/dist/index.js` and checks bundle-closure metadata but never runs it — only the advisory `windows-concurrency` job and `release.yml`'s tag-gated smoke ever execute the real artifact (#294). Compounding it, the root `turbo.json` build task declares only `"outputs": ["dist/**"]`, but `apps/cli/tsup.config.ts`'s `onSuccess` hook copies `packages/db/drizzle` into `apps/cli/drizzle/` as a required runtime artifact outside `dist/` — so a cache-hit replay of `build` can leave `dist/index.js` fresh while `apps/cli/drizzle/` is missing or stale, crashing on first DB touch, invisible precisely because nothing in the required gate runs the binary (#315). Add a `node apps/cli/dist/index.js --version`/`--help`/fixture-`run --json` smoke to the required `ci` job, and declare `apps/cli/drizzle/**` as an additional turbo output for `apps/cli`'s build task. *(M · `.github/workflows/ci.yml` · #294, #315)*
- ✅ **DONE (PR #80).** **Local `pnpm run ci` and the real `ci.yml` gate have diverged in both directions.** *(Also found: `pnpm ci` never reached the script at all — pnpm reserves `ci` as a builtin.)* The root `ci` script runs `pnpm lint:tools`, which `ci.yml` never invokes anywhere; conversely `ci.yml` runs a DB-migration-sync check (`pnpm --filter @relavium/db db:generate` + a `git status --porcelain` diff) the root script never calls — so a green local `pnpm ci` is not a faithful predictor of real CI in either direction, and none of `tools/engine-deps/check.mjs`, `tools/bundle-closure/check.mjs`, or `tools/sync-models-dev/sync.mjs` is ever linted in real CI. Add the missing `lint:tools` step to `ci.yml`'s main job and add the migration-sync check to the root `ci` script — ideally have `ci.yml` invoke the root script (or a documented subset) instead of re-listing overlapping-but-different commands. *(S · `package.json` · #312)*
- ✅ **DONE (PR #77 + repo settings).** **`release.yml` publishes with an npm provenance attestation but never verifies the tagged commit is reachable from `main`.** The workflow triggers on any `v*` tag push and checks only that the tag's version string matches `apps/cli/package.json` — it never runs a `git merge-base --is-ancestor` check against `origin/main`, and no tag-protection ruleset is visible anywhere in the repo, so the `publish` job's only real gate beyond a green cross-OS smoke is possession of `NPM_TOKEN`. Add the ancestor-reachability assertion to the `pack` job. *(M · `.github/workflows/release.yml` · G26)* Blocking — full closure additionally needs a maintainer decision to configure a GitHub tag-protection ruleset restricting `v*` tag creation, a repo-settings change outside this PR's diff; the in-workflow ancestor check can land independently.
- **`tools/engine-deps/check.mjs`'s allowlist and its purity model both stop short of the packages that need them.** `ENGINE_ALLOWLISTS` covers only `packages/shared`/`packages/llm`/`packages/core` — `packages/db`'s exclusion is deliberate but undocumented for `packages/mcp`, the one other package (besides `apps/cli`) that imports `@relavium/core`, leaving both packages' dependency growth policed only by human PR review instead of the mechanical gate the other three get (the identical missing-coverage observation, found independently in two review rounds, #285 and #318). Separately, the guard only reads each allowed package's own declared dependency *names* — it never resolves what an allowed transitive dependency (`yaml`, `quickjs-emscripten-core`) actually does, so a routine patch bump introducing a `node:fs`/`node:child_process` call inside one would pass every gate silently (#313). Extend `ENGINE_ALLOWLISTS` to cover `packages/db` and `packages/mcp`, and add a periodic browser-target bundle probe (esbuild `--platform=browser`, `node:*` externals set to fail-on-resolve) to catch transitive purity breaks. *(M · `tools/engine-deps/check.mjs` · #313, #318, #285)*
- ✅ **DONE (PR #80).** Ruled, not reworded: `llm`+`mcp` are a required check; `core` is measured but not enforced (+0.83 branch margin), with Wave 3's test items as the promotion trigger. **The documented ≥90% coverage floor is advisory in CI, and the standard says otherwise.** `docs/standards/testing.md` states unconditionally that `packages/core`/`packages/llm`/`packages/mcp` carry an "enforced floor >= 90%", but `vitest.config.ts`'s own header comment and `ci.yml`'s job name (`engine coverage floor (advisory)`) both say the job stays non-required pending a stability check — so a PR that drops core/llm/mcp coverage below 90% merges cleanly today, and the standard contradicts itself between its "coverage expectations" and "CI gate" sections. Found independently in two review rounds citing the identical contradiction. One maintainer decision resolves both: promote the job to required (a checked-in run already shows 92-97% margin) or soften `testing.md`'s wording to "advisory, tracked toward required." *(S · `vitest.config.ts` · #296, #152)*
- **No automated enforcement exists for CLAUDE.md's own binding documentation rules.** One-canonical-home, relative-only links, single-H1, kebab-case filenames, and no-front-matter are declared non-negotiable, yet `.prettierignore` explicitly excludes `docs/**`/`**/*.md`, and no markdownlint, link checker, or filename check runs anywhere in `.github/` or `tools/`. Write a ~100-line checker in the project's existing `tools/` style — validate every relative Markdown link under `docs/` resolves, assert exactly one top-level `#` H1 and no front-matter per file, flag non-kebab-case new/changed filenames — and wire it into CI. *(M · `docs/standards/documentation-style.md` · #316)*
- **The binding logging standard describes an injected-logger architecture that has zero implementation anywhere in the codebase.** `docs/standards/logging-and-observability.md` says the engine "logs through an injected logger interface... so a surface... supplies its own sink"; a repo-wide grep of `packages/*/src` and `apps/cli/src` finds zero `console.*` calls, zero logger type on `ExecutionHost` (`packages/core/src/engine/execution-host.ts`), and no implementation anywhere (#266). Two live consequences: `correlationId` is stamped on every `node:failed`/`run:failed` event (`packages/core/src/engine/engine.ts:1298`) specifically so an operator can "join it to the structured internal log" — but none of the three `RunEvent` renderers nor `relavium logs`'s `detailOf()` ever print it, because there is nothing to join it to (#267); and `media-gc.ts`'s intentional bare `catch { return undefined; }` (lines 161, 194) means a persistent GC failure — a permissions problem, a locked file — has zero trace anywhere for its entire lifetime, not in a log, a `RunEvent`, or the DB (#270). *(L · `docs/standards/logging-and-observability.md` · #266, #267, #270)* Blocking — a maintainer decision gates #267/#270 closing properly: build the minimal injected-logger interface the standard describes and route the swallowed catches through it at `warn`, or formally amend the standard to name the run-event stream + persisted history as the only observability mechanism through Phase 2.6.
- ✅ **DONE (PR #80).** Wired ahead of the mutating sync, so it reads the committed snapshot. **`sync:models:check`, the documented staleness-detection mode, is implemented and unused.** `tools/sync-models-dev/sync.mjs`'s own header documents `pnpm sync:models --check` as the CI-facing mode that fails if the committed `packages/llm/src/catalog/snapshot.ts` snapshot is stale, and it is fully implemented with a matching root script (`sync:models:check`), but `models-catalog.yml`'s weekly job calls plain `sync:models` — grepping every workflow file for `sync:models:check` returns zero hits. Wire the `:check` variant into the weekly job as a non-blocking, informational lane. *(S · `tools/sync-models-dev/sync.mjs` · #317)*
- ✅ **DONE (PR #80).** **Two advisory CI jobs are missing the `(advisory)` label the other two carry.** `coverage` and `windows-concurrency` both self-label `(advisory)` in their job `name:` field in `.github/workflows/ci.yml`, which is what shows in the GitHub Actions/PR checks UI; `floor-check` and `peer-dep-gate` are equally advisory per the file's top-of-file comment but carry no such marker, so a contributor scanning the checks list can mistake them for required. Append `(advisory)` to both job names. *(S · `.github/workflows/ci.yml` · #320)*
- ✅ **DONE (PR #80).** **The bundle-closure guard trusts there is exactly one esbuild output chunk without asserting it.** `tools/bundle-closure/check.mjs` picks a single `index.js` entry from the esbuild metafile via `.find()` and reads only its `imports` array; correct today (zero dynamic imports in `apps/cli/src`), but if a future dynamic `import()` causes esbuild to split a chunk, that chunk's external imports would never be inspected. Iterate all `.js` entries in `meta.outputs`, or assert `Object.keys(meta.outputs).length === 1` and fail loudly if that ever changes. *(S · `tools/bundle-closure/check.mjs` · #314)*
- ✅ **DONE (PR #80).** **`THIRD_PARTY_EXTERNAL` is stale versus `package.json`, and its own doc-comment overstates what it enforces.** `apps/cli/tsup.config.ts`'s comment claims the array is what `tools/bundle-closure/check.mjs` diffs against to prevent drift, but `string-width` was added to `package.json` `dependencies` (ADR-0069) without being added to `THIRD_PARTY_EXTERNAL`, and `check.mjs` actually diffs the esbuild metafile against `package.json` directly, never against this array — so the comment's enforcement claim is false, harmlessly so today only because tsup auto-externalizes anything already in `dependencies`. Found independently in two review rounds at the identical lines. Add `'string-width'` to the array, or correct the comment to state plainly that the array is documentation-only. *(S · `apps/cli/tsup.config.ts` · G27, #248)*
- **A cluster of tests in the newest code races real wall-clock timeouts instead of fake timers.** `packages/core/src/expression/sandbox.test.ts:183` expects the QuickJS interrupt handler to fire within a real 50ms window; `apps/cli/src/render/tui/synchronized-output.test.tsx:51` and `apps/cli/src/render/scrollback.test.ts:188` wait real 20-100ms windows for an ink render or listener teardown to "settle" — all in the 2.6.F-era TUI renderer and the QuickJS sandbox, both actively developed, both at CI flakiness risk under runner contention. Convert to `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` wherever the code under test doesn't span a real process boundary. *(S · `packages/core/src/expression/sandbox.test.ts` · #298)*
- **No property-based or fuzz testing exists anywhere in the repo.** A repo-wide grep for `fast-check` across every `package.json` and the lockfile returns nothing; the existing example-table style is already thorough (the SSRF `isPrivateOrLocalHost` suite hand-enumerates ~15 adversarial IP forms), so this raises the bar rather than closes a live gap, but the SSRF IP-form parser, the QuickJS sandbox's structured-clone boundary (`packages/core/src/expression/sandbox.ts`), and the `{{ }}` interpolation path resolver (`packages/core/src/interpolation/`) are exactly the class of parser/normalizer property-based testing exists for. Pilot `fast-check` (dev-only, no ADR required under the dependency policy's lower bar for dev tooling) scoped to those three files. *(M · `packages/llm/src/conformance` · #299)*
- **The non-`Uint8Array` continue-branch in the catalog-refresh stream reader is untested.** `readCapped` (`apps/cli/src/engine/catalog-refresh.ts:167-195`) correctly narrows each chunk with `chunk.value instanceof Uint8Array` before accumulating bytes and `continue`s past any non-byte chunk — the right pattern given the DOM lib's `ReadableStream<any>` typing — but no test exercises that branch to confirm a non-byte chunk is dropped rather than silently truncating a real pricing-overlay payload. Add a unit test feeding `readCapped` a reader that yields a non-`Uint8Array` chunk. *(S · `apps/cli/src/engine/catalog-refresh.ts` · #302)*

**Acceptance:** the maintainer decision on the logging standard is made and #267/#270 close accordingly — either a minimal injected-logger interface ships and the swallowed catches route through it at `warn`, or the standard is amended to name the run-event stream + persisted history as the sole observability mechanism; the required `ci` job executes the compiled `apps/cli/dist/index.js` binary and `apps/cli/drizzle/**` is a declared turbo build output; `pnpm lint:tools` runs in real CI and the DB-migration-sync check runs locally, so `pnpm ci` and `ci.yml` are provably equivalent; `release.yml` asserts tag-to-`main` ancestry before publishing; `ENGINE_ALLOWLISTS` covers `packages/db` and `packages/mcp` and a periodic browser-target bundle probe catches transitive purity breaks; the coverage-floor contradiction between `testing.md` and `vitest.config.ts`/`ci.yml` is resolved one way; a documentation-style checker runs in CI over `docs/**`; `sync:models:check` runs in the weekly job; `floor-check` and `peer-dep-gate` carry the `(advisory)` label; the bundle-closure guard asserts single-chunk output explicitly; `THIRD_PARTY_EXTERNAL` lists `string-width`; the flagged timing-dependent tests use fake timers; `fast-check` is piloted on the SSRF/sandbox/interpolation parsers; and `readCapped`'s non-`Uint8Array` branch has a passing test.

### 2.5.5.I — Experience/TUI polish: terminal safety, editing primitives, rendering consistency & onboarding

`apps/cli`'s chat/Home/run rendering and interaction layer shows the review's propagation-gap pattern at its purest: a primitive built once and proven correct at most call sites — `stripTerminalControls`/`sanitizeInline`, the ADR-0069 grapheme segmenter, the exhaustive signal-teardown set, the min-terminal-size guard — that simply never reached the sibling surface (`relavium run`'s `RunApp.tsx`, the prompt editor's cursor motion, `SIGTSTP`, `chat-ink.tsx`). Layered on top are onboarding-resilience gaps and two god-file decompositions (`chat.ts`, `home-controller.ts`) that need to land before 2.6.E and 2.6.G add substantial new code to either file. None of this is exploratory work — every fix has a proven-correct reference implementation already in the same directory.

**Tasks:**

- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — G34/G44/#56/#57 · all four boundaries carry `stripTerminalControls`/`sanitizeInline`).** **Carry terminal-control sanitization to the four boundaries it never reached.** `stripTerminalControls`/`sanitizeInline` (`apps/cli/src/render/sanitize.ts`) is applied at nearly every chat display boundary but never reaches: `relavium run`'s TUI (`apps/cli/src/render/tui/RunApp.tsx:30`), which renders `event.token`/`event.toolId`/`event.outputSummary`/node ids raw — a live ANSI/OSC/Trojan-Source injection hole; the persisted post-run summary (`renderFinalSummary` in `apps/cli/src/render/tui/final-summary.ts:56`), which prints `errorMessage` and node ids straight to real scrollback; `render-error.ts:25`, the one universal error boundary every command flows through, which writes `userFacing.message` unsanitized; and the human-gate approval card (`apps/cli/src/gate/clack-prompter.ts:44`), which renders runtime/model-controlled `event.message` inside `cardBody` unsanitized. Fix all four at the shared projection/sanitization helper level in one PR and get a security review given the injection-class severity. *(M · `apps/cli/src/render/tui/RunApp.tsx` · G34, G44, #56, #57)*
- **Share the ADR-0069 grapheme segmenter with the prompt editor's cursor-motion and truncation sites.** `viewport.ts` already builds an `Intl.Segmenter(undefined, {granularity:'grapheme'})` for wrap correctness, but three sibling sites never got it: `appendBounded`'s raw UTF-16 truncation slice (`session-view-model.ts:318`) can split a surrogate pair mid-stream, corrupting live-streamed text; `dropLastCodePoint`/`stepLeft`/`stepRight` (`chat-input.ts:260`) only guard surrogate pairs, not full grapheme clusters, on the flagship prompt editor, splitting flags/ZWJ emoji/accents; and `promptRows`' cursor-width computation (`prompt-cursor.ts:39`) is per-code-point, widening the cursor cell for a surrogate pair but never a full cluster (two independently-filed duplicates of the same defect, folded together). Export the segmenter from `viewport.ts` and route all three sites through it. *(M · `apps/cli/src/render/tui/chat-input.ts` · #58, #62, G40, G51)*
- ✅ **DONE (Wave 1, PR #81, 2026-07-30 — G0/#50 · `render/run-job-control.ts`; #50 by ordering — `drive-home.tsx` subscribes signals at `:808`, before `runOnboardingWizard` at `:855`).** **Add `SIGTSTP`/`SIGCONT` to the exit-safety net and fix onboarding's signal-registration ordering.** `SIGTSTP` (Ctrl-Z) is completely absent from the otherwise-exhaustive `SIGINT`/`TERM`/`HUP`/`QUIT` handler set (`apps/cli/src/render/suspend.ts:78`), stranding the terminal in alt-screen + mouse-tracking state on an ordinary POSIX job-control suspend. Separately, `drive-home.tsx:636` doesn't register `defaultSubscribeSignals`/`defaultSubscribeProcessExit` until *after* the network-bound onboarding wizard resolves, so Ctrl-C/Ctrl-Z during the wizard's own network call hits no handler at all — the review's own reconciliation on the second finding recommended landing both together. Register `SIGTSTP`/`SIGCONT` alongside the existing set in `drive-home.tsx` and `chat.ts`, and move signal registration ahead of the `isProviderKeyless` gate, in the same change. *(M · `apps/cli/src/home/drive-home.tsx` · G0, #50)*
- **Decompose `chat.ts` before 2.6.E/2.6.K add more feature code to it.** `apps/cli/src/commands/chat.ts` is 2,364 lines mixing the REPL loop, 2.6.C's reseat-rebuild logic, alt-screen orchestration, and printer construction with no module boundaries (`#220`), and contains a single ~425-line god-function, `createChatLineHandler` (`chat.ts:1012`, `#244`). Split by responsibility into separate modules before the next two workstreams land in this file. *(M · `apps/cli/src/commands/chat.ts` · #220, #244)*
- **Decompose `createHomeController` and type the overlay-field union before 2.6.G adds new screens.** `apps/cli/src/render/tui/home-controller.ts:270`'s `createHomeController` is a single ~1,290-line function, by far the largest in the repo (`#243`); inside it, six mutually-exclusive optional overlay fields (`home-controller.ts:139`) have no type-level enforcement that at most one is set — a real API-design defect, not just a size problem (`#215`). Split into sub-controllers and convert the overlay fields to a discriminated union in the same change. *(L · `apps/cli/src/render/tui/home-controller.ts` · #215, #243)*
- **Apply the Home idle-strip's min-terminal-size guard to the chat TUI.** `homeFitsTerminal` gates Home's idle strip below 80×24 but was never applied to `chat-ink.tsx:1486`, the chat surface's root component. Apply the same guard there. *(M · `apps/cli/src/render/tui/chat-ink.tsx` · #63)*
- **Detect `TERM=dumb` before mounting the full-screen alt-screen app.** `apps/cli/src/process/output-mode.ts:20`'s `detectOutputMode` never checks for a non-ANSI-capable terminal, corrupting the display on dumb ptys. Add the check and fall back to plain mode. *(S · `apps/cli/src/process/output-mode.ts` · #69)*
- **Cap `InputHistory.entries`.** `input-history.ts:23`'s `entries` array has no upper bound, unlike the `MAX_TOKEN_CHARS`/`MAX_TOOL_LINES` siblings in the same directory. Add the same kind of bound. *(S · `apps/cli/src/render/tui/input-history.ts` · G4)*
- **Cache per-cluster widths and debounce resize wrap-cache invalidation.** `viewport.ts:56`'s `graphemeWidth` calls the full `string-width` library per already-segmented cluster, 2.5–6x slower than necessary on CJK/wide-script lines (`#64`); `chat-projection.ts:273`'s `entryWrapCache` fully invalidates on every `SIGWINCH` tick during a drag-resize instead of only the final size, compounding the cost (`#66`). Cache per-cluster widths and debounce resize invalidation. *(M · `apps/cli/src/render/tui/viewport.ts` · #64, #66)*
- **Mount the four overlay components under adversarial render tests.** `PromptEditor`/`PaletteView`/`ReverseSearchView` (`prompt-view.tsx:1`, `G41`) and `MentionView`/`EffortTierList` (`palette-view.tsx:1`, `G53`, overlapping heavily with G41's coverage) all carry explicit sanitization-safety claims in comments but are never mounted by any test in the repo. Add `ink-testing-library` render tests per component in one PR. *(M · `apps/cli/src/render/tui/prompt-view.tsx` · G41, G53)*
- **Make chat's own `git_commit` denial message satisfiable.** `packages/core/src/tools/registry.ts:292` emits a workflow-authored `human_gate` denial message into chat that asks the user to do something chat structurally cannot produce. Give chat its own denial copy. *(S · `packages/core/src/tools/registry.ts` · #308)*
- **Align `chat-resume`/`chat-list`/`chat-export` with the CLI's noun-verb convention.** These three flat subcommands (`apps/cli/src/commands/specs.ts:131`) break the `gate list`/`provider add` pattern used everywhere else. Add `chat resume`/`chat list`/`chat export` as the canonical forms, keeping the flat spellings as deprecated aliases. *(M · `apps/cli/src/commands/specs.ts` · #309)*
- **Add a persistent keyless-state indicator to the Home strip.** `apps/cli/src/home/home-store.ts:73`'s `HomeSnapshot` carries no field for "no provider key configured," so a skipped or cancelled onboarding wizard leaves no durable nudge once the wizard screen is gone. Add a keyless-state field and a persistent nudge row. *(S · `apps/cli/src/home/home-store.ts` · #51)*
- **Make onboarding's model-binding failure recoverable and regression-tested.** A `writeDefaultModel` failure inside the wizard (`apps/cli/src/onboarding/wizard.ts:241`) silently re-introduces the exact provider/default-model mismatch the wizard exists to prevent (`#49`), and there is no end-to-end test proving the chosen provider actually binds the first chat's model (`apps/cli/src/home/drive-home.test.ts:562`, `#52`). Make the write retried/recoverable and add the regression test in the same change. *(M · `apps/cli/src/onboarding/wizard.ts` · #49, #52)*
- **Enforce the single-pending-approval invariant `requestApproval` only documents.** `chat-store.ts:225`'s `requestApproval` comment states "at most ONE approval is pending at a time" but nothing enforces it — currently safe only by luck of sequential dispatch. Add an explicit runtime guard against a second concurrent call orphaning the first. *(S · `apps/cli/src/render/tui/chat-store.ts` · G5)*
- **Give the palette query the same cyan+bold treatment as its sibling overlays.** `palette-view.tsx:29` renders the live query plain-dim while the mention and reverse-search overlays use cyan+bold for the same conceptual live-input field. Apply the same treatment. *(S · `apps/cli/src/render/tui/palette-view.tsx` · G52)*
- **Add a truncation/position indicator to windowed pickers.** `model-picker-view.tsx:96`'s windowed model and mention pickers give no "N of M" or scroll indicator when the list is truncated. Add one to both pickers. *(S · `apps/cli/src/render/tui/model-picker-view.tsx` · #60)*
- **Echo the attempted command id in the dispatch fallback message.** `dispatch.ts:648`'s unknown-command fallback never echoes what was typed or offers a hint, by explicit design — contested whether that design is correct, but the message is cheap to improve either way. Echo the attempted command id. *(S · `apps/cli/src/commands/dispatch.ts` · #311)*
- **Thread `--color`/`--no-color` into the onboarding wizard.** `wizard.ts:68` never receives the CLI's own color decision, so `--no-color` is honored in the Home that mounts immediately after the wizard but not during the wizard itself. Thread the same `color` flag into the wizard's prompt library. *(S · `apps/cli/src/onboarding/wizard.ts` · #53)*
- **Persist an acknowledgment for a permanently-locked keychain.** `wizard.ts:122` re-runs the full interactive wizard on every launch when the OS keychain is locked/unavailable, with no durable acknowledgment or opt-out. Persist the acknowledgment so subsequent launches show a shorter reminder instead of the full flow. *(M · `apps/cli/src/onboarding/wizard.ts` · #55)*
- **Word-wrap the alt-screen transcript to match inline.** `viewport.ts:218`'s alt-screen transcript char-wraps while the inline transcript word-wraps — a known, already-acknowledged deliberate deferral the finding asks to keep tracked rather than let drop. Implement word-wrap in alt-screen mode to match inline. *(M · `apps/cli/src/render/tui/viewport.ts` · #61)*

**Acceptance:** `relavium run`'s `RunApp.tsx`, `final-summary.ts`, `render-error.ts`, and the human-gate approval card all route dynamic text through `stripTerminalControls`/`sanitizeInline` before it reaches the terminal, verified by a security review given the injection-class severity; the shared `Intl.Segmenter` grapheme primitive is exported from `viewport.ts` and used by `appendBounded`, `dropLastCodePoint`/`stepLeft`/`stepRight`, and `promptRows` with no remaining code-point-only cut sites; `SIGTSTP`/`SIGCONT` restore the terminal exactly like the existing `SIGINT`/`TERM`/`HUP`/`QUIT` handlers, and `drive-home.tsx` registers signal handlers before the onboarding wizard's network call; `chat.ts` and `home-controller.ts` are each split into focused modules/sub-controllers, with the overlay-field union type-checked as mutually exclusive, landing before 2.6.E/2.6.G add new code; `chat-ink.tsx` degrades below 80×24 like Home does; `TERM=dumb` falls back to plain mode; `InputHistory.entries` is bounded; the four overlay components (`PromptEditor`, `PaletteView`, `ReverseSearchView`, `MentionView`/`EffortTierList`) are mounted by `ink-testing-library` tests; viewport wrap performance improves measurably on a CJK-heavy fixture and resize-drag no longer thrashes the wrap cache every tick; `chat_resume`/`chat-list`/`chat-export` gain noun-verb aliases with the flat forms deprecated but working; onboarding's `writeDefaultModel` failure is recoverable and covered by an end-to-end test; and the Home strip shows a persistent keyless-state nudge when no provider key is configured.

## Milestones

| In-phase | Completed by | Outcome |
|----------|--------------|---------|
| ✅ M2.5.5-1 Safety-critical propagation fixes *(met 2026-07-30, PR #81 — its two CRITICALs, #91 and #228, are closed. ADR-0074 §1 was open at that date and CLOSED on 2026-08-09 with `/cost --release`; the "Wave 1.5" framing this note used was retracted — that work was PR #81's own closing list, not a later wave. See [current.md](../current.md).)* | 2.5.5.A + 2.5.5.C | Two of the three CRITICAL findings closed (`#91` the unredacted approval-preview secret leak; `#228` the chat-persister unhandled-rejection crash — the third, `#56`, lands with 2.5.5.I under M2.5.5-2); the budget governor's concurrency gap and the two-process migration race are fixed |
| M2.5.5-2 Security-surface hardening — D complete on main (PR #94), I open ([merge checkpoint](#wave-2-merge-checkpoint--2026-10-15)) | 2.5.5.D + 2.5.5.I | MCP tool-poisoning/config-secret-hijack gaps closed; the third CRITICAL (`#56`) closed as terminal-control sanitization reaches `relavium run`, the error boundary, and the approval card; `chat.ts`/`home-controller.ts` decomposed ahead of 2.6.E/2.6.G |
| M2.5.5-3 CLI operator-safety net | 2.5.5.E | The outermost crash/signal/error boundary behaves uniformly across every command; `--version`/`--help` startup tax closed |
| M2.5.5-4 Money-safety & process substrate | 2.5.5.B + 2.5.5.H | The three LLM adapters share guard/classification parity and `FallbackChain` is the sole retry authority; CI actually executes the compiled binary and the coverage/dependency/logging gates match what they claim to enforce |
| M2.5.5-5 Documentation & hygiene close-out | 2.5.5.F + 2.5.5.G | No canonical doc names a retired data source or an unbuilt surface as shipped; the naming/duplication/dead-code sweep is closed |

## Sequencing & parallelization

All nine sub-streams are independent (`dependsOn` is empty on every one) — no sub-stream must
complete before another starts. They are **not** all file-disjoint, though, so concurrency runs
between disjoint queues rather than across the phase as a whole: the five known overlaps — on
`packages/db/src/client.ts`, `home-controller.ts`/`chat-ink.tsx`, `chat.ts` and `viewport.ts` —
each carry a required landing order, recorded under [Positioning](#positioning). The order below is a value/risk recommendation, not a dependency
chain, leading with safety-critical work:

1. **2.5.5.A and 2.5.5.C first** — each contains one CRITICAL, self-contained defect (the
   approval-preview secret leak; the chat-persister crash) with a small, well-understood
   blast radius. Land these before anything else touches the same files.
2. **2.5.5.D next** — it closes CRITICAL/live security gaps with no existing coverage (MCP
   tool-definition poisoning, the config-layer secret hijack), and it shares no file with any
   other sub-stream.
3. **2.5.5.E, then 2.5.5.I** — in that order, not the reverse. E is the broadest user-facing
   surface (every command passes through it) and is best landed once the engine/data/security
   fixes above are stable under it; I's decompositions must then move already-guarded,
   already-canonical code, per the overlap rules above. Two carve-outs: I's terminal-control
   sanitization item (`#56`, `G34`, `G44`, `#57`) is a CRITICAL sharing no file with E's queue, so it is
   pulled ahead alongside step 1; and the four **step-5 items that collide with I** — F's `showCost`
   wiring (`#125`) and G's `chat.ts`/`viewport.ts` items (`#236`, `#307`, `#218`, `#65`) — are pulled
   **forward to here**, ahead of I, rather than waiting for step 5. Within I, the `chat.ts`/`home-controller.ts` decompositions
   additionally want to land **before** Phase 2.6's **2.6.G** and **2.6.E** add substantial new code
   to either file, to avoid a large, conflict-prone rebase later — a cross-phase file-ownership
   preference, not a 2.5.5-internal dependency.
4. **2.5.5.B and 2.5.5.H** — money-correctness and process-substrate hardening; neither is
   time-critical, both benefit from the same shared-fixture-per-guard discipline the security
   items above establish.
5. **2.5.5.F and 2.5.5.G** — documentation accuracy and codebase hygiene; zero runtime risk, safe to
   interleave anywhere. Minus the four items pulled forward into step 3 (F's `#125`; G's `#236`,
   `#307`, `#218`, `#65`), which must precede 2.5.5.I on the files they share.

Two constraint sets bind, and nothing else does. **Cross-phase:** the three items with an explicit
preference (the two 2.5.5.I decompositions, and the authoring run-path tool-preflight item filed
directly as a 2.6.A work item). **Intra-phase:** the five file overlaps recorded under
[Positioning](#positioning) (`client.ts`, `home-controller.ts`/`chat-ink.tsx`, `chat.ts`,
`viewport.ts`). Everything outside those two sets is scheduler's choice.

## Dependencies

- **Phase 2.5 complete** and **Phase 2.6 workstreams 2.6.C and 2.6.F merged** — this phase's
  scope is defined against the code state those milestones produced; no work item here targets
  code that doesn't exist yet.
- **The traceability appendix** (generated and appended to this file separately from this
  planning pass) — every finding ID cited in parentheses throughout the work breakdown above
  resolves against it; it is the only place the full 373-finding→work-item mapping is recorded.
- **No new runtime dependency** beyond what individual work items name as already-shipped
  (e.g. `smol-toml`, `string-width` — both already in `package.json`, only their `tech-stack.md`
  documentation is missing per 2.5.5.F). The one prospective new dependency named anywhere in
  this phase, `fast-check` (2.5.5.H), is dev-only and explicitly needs no ADR under the
  dependency policy's lower bar for dev tooling.
- **Maintainer availability** for the ~14 blocked items named across the work breakdown
  (retention policy, `--quiet`/`--verbose`/`RELAVIUM_DEBUG` precedence, the `--input`
  namespace collision, `default_headers`' plaintext-secret design, the logging-standard
  disposition, and others) — each is called out inline in its sub-stream; none blocks the
  rest of that sub-stream's independent items.

## Exit criteria

**Wave 2 disposition — 2026-10-15:** criteria 1–3 are satisfied on `main` following the merge of PR #94; the [merge checkpoint](#wave-2-merge-checkpoint--2026-10-15) joins their direct regressions, threat sittings and final corrections. Whole-phase criteria 4–8 remain open.

1. All three CRITICAL findings (`#91` the `previewFor()` secret leak; `#228` the chat-persister
   unhandled rejection; `#56` the unsanitized `relavium run` TUI) are closed and regression-tested.
2. A security review confirms terminal-control sanitization reaches `relavium run`'s TUI,
   the persisted run summary, the universal error boundary, and the human-gate approval card.
3. A security review confirms the MCP tool-definition untrusted-content gap and the MCP
   config-layer secret-hijack gap are closed or explicitly, permanently documented as accepted
   residuals.
4. `pnpm turbo run lint typecheck test` stays green throughout, with no widening of the
   `LLMProvider` seam or new platform import into `packages/core`. Machine-output
   compatibility changes are limited to the explicitly approved ADR-0110 scope
   (diagnostics/exits, JSON discovery, aliases and consent); existing run-event
   stdout and actual workflow-outcome contracts remain accepted.
5. All items in a given sub-stream's `**Tasks:**` list are either shipped or explicitly
   re-deferred with a recorded reason (routed to Phase 2.6, `deferred-tasks.md`, or declined
   with rationale in the traceability appendix).
6. Every maintainer-decision item flagged **blocked** in the work breakdown has a recorded
   ruling before its implementation lands.
7. The nine sub-streams' acceptance paragraphs (2.5.5.A–I above) each hold in full.
8. **Apply the standing ADR threshold.** The original remediation baseline expected no new ADR;
   Wave 2 uses accepted ADR-0105–ADR-0109 for its trust/API/lifecycle decisions. Any item
   that introduces a new seam or port, moves a
   trust boundary, defines a storage lifecycle, changes a public CLI / machine-output contract, or adds a
   runtime dependency mints an ADR on its own merits. Minting one is **not** a phase failure; skipping a
   genuine one is. (D33's `deleted_at` retention lifecycle and D20's flag rename are the closest calls.)

## Required ADRs

The original remediation baseline expected none: most items harden an existing
design or amend a convention. That expectation does not waive the threshold in
exit criterion 8, including for work pulled forward from Phase 2.6.

**Wave 2 — 2026-10-12:** [ADR-0105](../../decisions/0105-filesystem-roots-are-invocation-grants-not-project-authority.md),
[ADR-0106](../../decisions/0106-media-publication-requires-bounded-verified-bytes.md),
[ADR-0107](../../decisions/0107-first-run-secret-inputs-use-bounded-stdin.md) and
[ADR-0108](../../decisions/0108-provider-headers-stay-gated-until-keychain-custody.md)
are **Accepted** following maintainer approval of the corrected decision package
and execution plan on 2026-10-12. Dependent implementation is authorised.
They cover filesystem authority, bounded media admission/lifecycle, first-run secret
stdin and the provider-header custody gate. The subsequently approved [ADR-0109](../../decisions/0109-native-media-close-ownership-is-explicit-iterator-provenance.md) defines explicit native iterator ownership; its implementation is accepted in [Step 6](#step-6-acceptance--2026-10-13). The [Wave 2 decision package](#decisions-presented-together-before-implementation)
and execution plan record the scope; no new runtime dependency is proposed.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| A remediation phase competes with the active Phase 2.6 for maintainer/reviewer attention | Independent branch and release cadence from Phase 2.6 (see Positioning); the two 2.5.5.I file-ownership items are the only cross-phase sequencing constraint, keeping the rest fully decoupled |
| Large mechanical sweeps (the 20-site doc-hedge fix, the exhaustiveness-guard sweep, the adapter-parity sweep) touch many call sites in one PR, risking a regression in code with thin test coverage | Each sweep bullet pairs the fix with a shared fixture/regression test per guard or site, named explicitly in the task text; land sweeps as their own reviewed PR, not folded into an unrelated change |
| The review's 373 findings are a sample of one review pass, not a verified-complete inventory of every defect in the codebase | Treat this phase as closing the known-and-verified set, not as a claim of exhaustive coverage; a future review pass may surface more, which is expected and out of scope for this file to pre-empt |
| A blocked maintainer-decision item stalls its whole sub-stream if treated as a hard gate | Each blocked item is scoped narrowly against its own bullet, not its sub-stream's other items — the sub-stream's independent tasks proceed regardless (see the acceptance paragraphs) |
| `chat.ts`/`home-controller.ts` decomposition (2.5.5.I) lands concurrently with 2.6.E/2.6.G work on the same files, causing a large merge conflict | The Positioning section calls this out explicitly as a preferred-first sequencing item; coordinate the PR timing directly with whichever 2.6 workstream is closer to touching those files |
| A mechanical rename/hygiene sweep (2.5.5.G) silently changes a `--json` output shape | Every 2.5.5.G task's acceptance criterion is scoped to "no `--json` output shape changes," and each rename is checked against the ADR-0049 machine-output contract before merge |

## Traceability appendix — the 2026-07-19 review findings

Every verified finding from the 373-finding full-project review of 2026-07-19 (HEAD `f88b0e8`), and where it is scheduled. This table is generated from the triage data, not hand-maintained — it is the coverage proof for the phase.

The review report itself is not tracked in git (it lives under the gitignored `docs/analysis/private/`), so every entry here is written to stand alone. This appendix exists so a finding ID cited in a task bullet can always be resolved back to the concrete defect and its location.

**Severity** is the value assigned after two-lens adversarial verification. **Resolution** records what the two independent verifiers concluded: `confirmed` = both agreed as stated · `partly-true` = real but the original framing or impact was corrected · `contested` = the verifiers disagreed and the task carries a maintainer decision.

### Summary

| Destination | Findings | Work items |
|---|---:|---:|
| **2.5.5.A** — Engine-core hardening: cancellation, backpressure, schema validation & the budget governor | 41 | 23 |
| **2.5.5.B** — LLM adapter & catalog money-safety hardening | 35 | 17 |
| **2.5.5.C** — Data & persistence hardening: SQLite concurrency, media store & catalog/history robustness | 30 | 23 |
| **2.5.5.D** — MCP transport, config-trust & filesystem/secret hardening | 29 | 19 |
| **2.5.5.E** — CLI operator-safety net: signals, error boundaries, crash handling & startup performance | 48 | 29 |
| **2.5.5.F** — Documentation & roadmap accuracy | 71 | 20 |
| **2.5.5.G** — Codebase hygiene: naming, duplication & dead code | 19 | 10 |
| **2.5.5.H** — CI, build pipeline, test-infrastructure & observability foundation | 21 | 14 |
| **2.5.5.I** — Experience/TUI polish: terminal safety, editing primitives, rendering consistency & onboarding | 33 | 21 |
| **Phase 2.6** (active) — these land in that phase's own workstreams, not in this file | 27 | 16 |
| **deferred-tasks** — Recorded in deferred-tasks.md (deliberately unscheduled) | 16 | 10 |
| **no-action** — Consciously declined — see deferred-tasks.md for the reasoning | 3 | 3 |
| **Total** | **373** | **205** |

### Findings by destination

#### 2.5.5.A — Engine-core hardening: cancellation, backpressure, schema validation & the budget governor

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#91` | `critical` | `packages/core/src/tools/registry.ts:436` | Per-tool approval preview is not secret-redacted, contradicting its own "secret-free" doc contract | previewFor() builds the persisted, --json-visible ToolActionPreview by echoing command/path… |
| `#75` | `high` | `packages/core/src/engine/engine.ts:455` | Run-level timeout_ms resets to a fresh full window on every checkpoint resume | Every checkpoint/gate/media-job resume re-arms a fresh full-duration run timeout instead of… |
| `#86` | `high` | `packages/core/src/agent-parser.ts:151` | AgentParseError only carries field paths, never a reason — unlike its sibling parseWorkflow | parser.ts and agent-parser.ts each have gaps in field-named parse-error diagnostics; extract… |
| `#87` | `high` | `docs/reference/contracts/workflow-yaml-spec.md:124` | Spec claims system_prompt_append supports interpolation; it never does, no warning anywhere | workflow-yaml-spec.md documents system_prompt_append as interpolated, but agent-runner.ts… |
| `G9` | `high` | `packages/core/src/engine/node-handlers/human-gate.ts:53` | human-gate skips the post-resolution cancel-wins recheck every sibling handler enforces | resolvePrompt and human-gate.ts both fail to observe run cancellation, unlike every sibling… |
| `G38` | `high` | `packages/core/src/engine/budget-governor.ts:158` | Pre-egress budget check races under concurrent parallel branches, letting the cap be exceeded | BudgetGovernor's pre-egress check reads a stale snapshot with no reservation step, so parallel… |
| `#76` | `medium` | `packages/core/src/engine/agent-runner.ts:883` | Agent prompt_template resolution never threads the run's AbortSignal | resolvePrompt and human-gate.ts both fail to observe run cancellation, unlike every sibling… |
| `#77` | `medium` | `packages/core/src/engine/event-stream.ts:39` | No backpressure on in-node streaming events between node-dispatch boundaries | RunHandle backpressure is awaited once per node dispatch; SessionHandle's identical API is… |
| `#82` | `medium` | `packages/core/src/interpolation/references.ts:201` | Escaped quotes in a filter string argument are not unescaped | parseArg returns raw backslash-escaped text of a quoted filter argument instead of unescaping it |
| `#85` | `medium` | `packages/core/src/parser.ts:236` | messageFor has no case for invalid_literal — schema_version mismatch just says "invalid value" | parser.ts and agent-parser.ts each have gaps in field-named parse-error diagnostics; extract… |
| `#89` | `medium` | `packages/core/src/dag.ts:641` | No uniqueness check on parallel_of — a duplicated branch member duplicates a merged output silently | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `#90` | `medium` | `packages/core/src/dag.ts:449` | Duplicate when values across branches are schema/DAG-valid, silently orphaning one target | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `#92` | `medium` | `packages/core/src/engine/agent-session.ts:758` | The registry's ADR-0029(c) secret-taint gate (ctx.secretArgKeys) has no producer anywhere in the engine | ctx.secretArgKeys, the runtime taint-check input assertNoTaintedArgs() enforces, has no… |
| `#94` | `medium` | `packages/core/src/tools/bounding.ts:100` | Cycle-guard WeakSet is never cleared, so two non-cyclic refs to one object collapse to '[cyclic]' | redactInlineMediaForText/redactSecretShapedWalk add to the shared cycle-guard WeakSet but never… |
| `#95` | `medium` | `packages/core/src/tools/builtins.ts:183` | No size ceiling on content-bearing tool args (write_file.content, http_request.body, run_command.args) | write_file.content, http_request.body, run_command.args, and git_commit.message have no length… |
| `#96` | `medium` | `packages/core/src/tools/builtins.ts:166` | No built-in tool schema describes its individual parameters, only the tool as a whole | No built-in tool's llmVisibleParams schema has per-property descriptions, and several leak… |
| `#210` | `medium` | `packages/shared/src/node.ts:129` | HumanGateNodeSchema doesn't enforce timeout_action requires timeout_ms, unlike its own event-schema sibling | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `#211` | `medium` | `packages/shared/src/workflow.ts:72` | WorkflowInputSchema never checks that `default` or `validation.enum` values match the declared input `type` | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `G16` | `medium` | `packages/shared/src/session.ts:56` | SessionMessageSchema doesn't require compaction to be paired with role:'system' | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `G39` | `medium` | `packages/core/src/engine/budget-governor.ts:112` | budget:warning fires only once ever per governor, silencing a long warn-mode chat session after crossing | budget:warning fires once per process lifetime and reports a misleading pre-call percentage… |
| `G47` | `medium` | `packages/core/src/engine/budget-governor.ts:227` | budget:warning's thresholdPct reflects pre-call spend, not the projected post-call amount | budget:warning fires once per process lifetime and reports a misleading pre-call percentage… |
| `G48` | `medium` | `packages/core/src/engine/session-handle.ts:141` | SessionHandle's backpressure knob is wired but never awaited by any session producer | RunHandle backpressure is awaited once per node dispatch; SessionHandle's identical API is… |
| `#78` | `low` | `packages/core/src/engine/checkpoint.ts:12` | "idempotency key" language overstates a safety mechanism not implemented in the tool layer | Three stale doc comments in the engine assert a behavior/format the code no longer (or never… |
| `#80` | `low` | `packages/core/src/export/serializer.ts:198` | Exported multi-turn session has no cross-turn conversation memory | Chat-to-workflow export (serializer.ts) has three independent robustness/safety gaps: no… |
| `#81` | `low` | `packages/core/src/export/serializer.ts:213` | Exported YAML embeds the full transcript with no scrub of tool-result content | Chat-to-workflow export (serializer.ts) has three independent robustness/safety gaps: no… |
| `#83` | `low` | `packages/core/src/export/serializer.ts:159` | Non-ASCII session titles collapse to a generic workflow id | Chat-to-workflow export (serializer.ts) has three independent robustness/safety gaps: no… |
| `#93` | `low` | `packages/core/src/tools/types.ts:340` | ctx.fsScope is threaded through every dispatch but never read by the registry or forwarded to FsCapability | ctx.fsScope is threaded through every dispatch context but enforcePolicy() has no fsScoped… |
| `#97` | `low` | `packages/core/src/tools/builtins.ts:6` | Top-of-file comment claims the egress host capability is "not wired yet", but it now is | Three stale doc comments in the engine assert a behavior/format the code no longer (or never… |
| `#212` | `low` | `packages/shared/src/node.ts:142` | Duplicate `when` values in a condition node's branches[], and duplicate ids in parallel_of, are not rejected | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `#213` | `low` | `packages/shared/src/run-event.ts:57` | BaseEventSchema / BaseEvent and HumanGateEvent are public exports with zero consumers anywhere in the monorepo | BaseEventSchema/BaseEvent and HumanGateEvent are public exports with zero consumers anywhere in… |
| `#214` | `low` | `packages/shared/src/workflow.ts:213` | workflow.version is documented as Semver but not validated as such | Three stale doc comments in the engine assert a behavior/format the code no longer (or never… |
| `#219` | `low` | `packages/core/src/errors.ts:211` | 17 error classes, zero shared base despite identical hand-written shape | 17 independently hand-rolled error classes with no shared base across the monorepo |
| `#274` | `low` | `packages/core/src/engine/engine.ts:2225` | RunEventBus's documented hot-path validation opt-out is never actually wired by any host | RunEventBusOptions.validate is dead config, and kahnOrder re-sorts the whole ready-list on… |
| `G17` | `low` | `packages/shared/src/run.ts:43` | RunSchema checks temporal order but not status/field consistency | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `G22` | `low` | `packages/core/src/interpolation/analyze.ts:51` | A `{{secrets.*}}` reference used as an unread context value skips the parse-time secret gate entirely | analyzeSecretTaint skips context-value sites, so a direct {{secrets.*}} reference in a context… |
| `G49` | `low` | `packages/core/src/engine/budget-governor.ts:112` | warn mode emits at most one budget:warning ever, then goes silent past the cap | budget:warning fires once per process lifetime and reports a misleading pre-call percentage… |
| `#79` | `polish` | `packages/core/src/engine/engine.ts:1667` | Redundant unreachable branch in the node-retry backoff sleep handling | Two branches in engine.ts's #dispatch retry-sleep handling always co-occur — dead-code cleanup |
| `#98` | `polish` | `packages/core/src/tools/builtins.ts:248` | Tool descriptions read as engineer-facing implementation notes, not model-facing guidance | No built-in tool's llmVisibleParams schema has per-property descriptions, and several leak… |
| `#275` | `polish` | `packages/core/src/dag.ts:500` | Kahn topo sort re-sorts the whole ready-list every pop (O(n^2 log n)), not a priority queue | RunEventBusOptions.validate is dead config, and kahnOrder re-sorts the whole ready-list on… |
| `G18` | `polish` | `packages/shared/src/agent.ts:245` | FallbackChainEntrySchema has no duplicate-entry check | Two established packages/shared validation conventions (a duplicate-detection helper, and… |
| `G50` | `polish` | `packages/core/src/engine/budget-governor.ts:26` | Budget*Error carries no .code, breaking the directory's own error-taxonomy convention | BudgetExceededError/BudgetPauseError expose no .code field, unlike every other engine/ error… |

#### 2.5.5.B — LLM adapter & catalog money-safety hardening

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#168` | `high` | `packages/llm/src/adapters/gemini.ts:1183` | Gemini and OpenAI silently downgrade their own classified bad_request errors to 'unknown' | Extend adapter-parity guards and error-classification fidelity across all three LLM adapters in… |
| `#177` | `high` | `packages/llm/src/model-kind.ts:63` | isNonChatModelId untested; its regression test uses an incomplete hand-copied deny-list | Close four independent blind spots in the ADR-0071 catalog money-guard apparatus, including an… |
| `#276` | `high` | `packages/llm/src/adapters/anthropic.ts:844` | Vendor SDK's own default retry never disabled in production, pre-empts the FallbackChain | The vendor SDK's own retry is never disabled in production, pre-empting FallbackChain, and its… |
| `#170` | `medium` | `packages/llm/src/adapters/anthropic.ts:674` | Streaming tool-call id/name emptiness is unguarded in Anthropic, and only partially guarded in OpenAI | Extend adapter-parity guards and error-classification fidelity across all three LLM adapters in… |
| `#171` | `medium` | `packages/llm/src/adapters/anthropic.ts:74` | CapabilityFlags.reasoning is false for Anthropic and Gemini despite both fully emitting reasoning content | Anthropic and Gemini declare reasoning: false despite fully implementing the reasoning content… |
| `#172` | `medium` | `packages/llm/src/adapters/anthropic.ts:535` | Anthropic prompt caching is advertised (promptCache:true) but structurally never activated | Anthropic's promptCache:true capability flag is structurally never activated — no code sets… |
| `#173` | `medium` | `packages/llm/src/adapters/anthropic.ts:865` | Anthropic's generate() maps content outside its try/catch, unlike OpenAI and Gemini | Extend adapter-parity guards and error-classification fidelity across all three LLM adapters in… |
| `#178` | `medium` | `packages/llm/src/catalog/snapshot-guard.ts:30` | moneyFingerprint omits maxOutputTokens, which the cost-cap estimate directly depends on | Close four independent blind spots in the ADR-0071 catalog money-guard apparatus, including an… |
| `#187` | `medium` | `packages/llm/src/conformance/spec.ts:236` | No conformance fixture exercises a parallel/multi tool-call turn despite parallelToolCalls capability | The shared cross-provider conformance suite has no scenario for parallel tool calls… |
| `#192` | `medium` | `packages/llm/src/fallback-chain.ts:717` | Exhausted-chain error uses kind:'unknown', losing the accurate 'provider_unavailable' UX hint | Extend adapter-parity guards and error-classification fidelity across all three LLM adapters in… |
| `#195` | `medium` | `packages/llm/src/fallback-chain.ts:561` | Cooldown parking is scoped only to rate_limit; an overloaded/timing-out provider is re-hammered every call | #afterFailure's cooldown-parking memory only covers rate_limit, not overloaded/timeout/transport |
| `#279` | `medium` | `packages/llm/src/fallback-chain.ts:258` | Backoff has no jitter and never reads the provider's Retry-After header | The vendor SDK's own retry is never disabled in production, pre-empting FallbackChain, and its… |
| `#284` | `medium` | `tools/lint-fixtures/assert-fence.mjs:22` | Seam-fence self-test never exercises the plain-JS branch of the fence | The public barrel exports provider-specific wire-shape types with zero external consumers, and… |
| `G6` | `medium` | `packages/llm/src/catalog/snapshot.ts:1032` | CATALOG_SHA256 money-floor fingerprint is never verified against the snapshot's own content | Close four independent blind spots in the ADR-0071 catalog money-guard apparatus, including an… |
| `#174` | `low` | `packages/llm/src/adapters/anthropic.ts:871` | Anthropic's stream() is missing the assertNoStreamingMediaOutput guard OpenAI and Gemini both carry | Extend adapter-parity guards and error-classification fidelity across all three LLM adapters in… |
| `#175` | `low` | `packages/llm/src/adapters/gemini.ts:498` | Gemini's media lowering has no subtype validation, unlike Anthropic and OpenAI | Extend adapter-parity guards and error-classification fidelity across all three LLM adapters in… |
| `#176` | `low` | `packages/llm/src/tool-normalizer.ts:262` | GeminiToolCallIds.resolveResponse is fully unit-tested but never called by the Gemini adapter | GeminiToolCallIds.resolveResponse is fully unit-tested but has zero callers |
| `#180` | `low` | `packages/llm/src/catalog/catalog-model.ts:68` | Stale doc comment claims maxOutputTokens is unclamped; output-cap.ts now clamps it everywhere | Two stale doc comments in the catalog files assert behavior output-cap.ts has since implemented |
| `#181` | `low` | `packages/llm/src/catalog/models-dev-schema.ts:48` | CostTierSchema never validates tier.tier.type before using tier.size as a context threshold | Close four independent blind spots in the ADR-0071 catalog money-guard apparatus, including an… |
| `#182` | `low` | `packages/llm/src/providers.ts:1` | providers.ts has no dedicated unit test in packages/llm | providers.ts, which decides adapter wiring and SSRF-validated custom-base-URL fetch, has zero… |
| `#183` | `low` | `tools/sync-models-dev/sync.mjs:189` | MAX_BODY_BYTES cap is enforced only after the full response body is buffered in memory | sync-models-dev's MAX_BODY_BYTES cap only fires after response.text() has already buffered the… |
| `#184` | `low` | `packages/llm/src/types.ts:320` | LlmResultSchema/StreamChunkSchema are never parsed against real adapter output in production | LlmResultSchema/StreamChunkSchema, which carry load-bearing invariants, are only ever parsed in… |
| `#186` | `low` | `packages/llm/src/tool-normalizer.ts:43` | Tool-schema depth DoS guard exists only on the Gemini reshape path, not OpenAI/Anthropic | Extend adapter-parity guards and error-classification fidelity across all three LLM adapters in… |
| `#188` | `low` | `packages/llm/src/conformance/spec.ts:33` | ConformanceExpectations has no field for cacheWriteTokens on the prompt-cache write billing path | The shared cross-provider conformance suite has no scenario for parallel tool calls… |
| `#189` | `low` | `packages/llm/src/capabilities.ts:23` | CapabilityFlags.reasoning and .promptCache are in the frozen seam but never read by any consumer | Anthropic and Gemini declare reasoning: false despite fully implementing the reasoning content… |
| `#190` | `low` | `packages/llm/src/conformance/spec.ts:263` | Shared spec asserts only rate_limit classification; auth/bad_request/content_filter covered per-adapter only | The shared cross-provider conformance suite has no scenario for parallel tool calls… |
| `#191` | `low` | `packages/llm/src/conformance/spec.ts:1` | No conformance scenario exercises request cancellation (AbortSignal) through generate()/stream() | The shared cross-provider conformance suite has no scenario for parallel tool calls… |
| `#194` | `low` | `packages/llm/src/fallback-chain.ts:783` | `#emitSuccess`'s cost-recording catch swallows any exception, not just the one it documents guarding against | CostTracker.record's error handling and input validation both have defensive gaps that could… |
| `#196` | `low` | `packages/llm/src/llm-error.ts:91` | `scrubSecrets`'s URL-query-secret regex misses common real-world param names like `client_secret` | scrubSecrets's URL-query-secret regex requires an exact param-name match, letting client_secret… |
| `#198` | `low` | `packages/llm/src/cost-tracker.ts:123` | No bounds-check on `Usage` fields at the money-accounting call site itself | CostTracker.record's error handling and input validation both have defensive gaps that could… |
| `#283` | `low` | `packages/llm/src/index.ts:162` | Provider-specific wire-shape types exported from the curated seam barrel, zero consumers | The public barrel exports provider-specific wire-shape types with zero external consumers, and… |
| `G7` | `low` | `packages/llm/src/reasoning-wire.ts:362` | Stale comment in reasoningBudgetFor claims a 'maxTokens - 1' ceiling that no caller actually passes | Two stale doc comments in the catalog files assert behavior output-cap.ts has since implemented |
| `G8` | `low` | `packages/llm/src/catalog/catalog-model.ts:68` | Stale doc comment on maxOutputTokens says nothing clamps against it, contradicted by output-cap.ts | Two stale doc comments in the catalog files assert behavior output-cap.ts has since implemented |
| `#197` | `polish` | `packages/llm/src/budget-estimator.ts:39` | `?? maxOutputTokens` fallback in `estimateMaxNextCost` is unreachable given the function's own signature | The ?? maxOutputTokens fallback in estimateMaxNextCost is provably unreachable given the… |
| `#199` | `polish` | `packages/llm/src/fallback-chain.ts:291` | The documented "single-flight by contract" invariant on a `FallbackChain` instance has no runtime guard | FallbackChain's documented single-flight-by-contract invariant on #lastProviderAcrossCalls has… |

#### 2.5.5.C — Data & persistence hardening: SQLite concurrency, media store & catalog/history robustness

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#228` | `critical` | `apps/cli/src/chat/persister.ts:176` | Transient history.db write failure during chat silently drops the turn, then crashes the session | A transient history.db write failure during chat crashes the whole process asynchronously after… |
| `#99` | `high` | `packages/db/src/client.ts:79` | runMigrations crashes under a concurrent two-process migration race on one history.db | Two relavium processes racing on a fresh history.db can both attempt the same CREATE TABLE and… |
| `#230` | `high` | `apps/cli/src/commands/specs.ts:1` | No way anywhere to delete, prune, or remove a chat session, run, workflow, or agent from history.db | history.db has soft-delete columns everywhere and zero code path that ever writes them, plus… |
| `#29` | `medium` | `apps/cli/src/history/reader.ts:22` | The db-open failure to CliError wrapping in the two history openers is never tested | reader.ts/session-open.ts's db-open-failure-to-CliError wrapping is completely untested |
| `#38` | `medium` | `apps/cli/src/engine/catalog-metadata.ts:164` | The shipped-model enrichment round-trip has no consumer anywhere | ADR-0072 enrichment fields are persisted but never read back by ModelCatalogEntry or the… |
| `#100` | `medium` | `packages/db/src/retry.ts:30` | RETRYABLE_CODES omits SQLITE_BUSY_SNAPSHOT, the exact fault the docstring claims it retries | retry.ts's own docstring says it retries SQLITE_BUSY_SNAPSHOT, but RETRYABLE_CODES omits that… |
| `#101` | `medium` | `packages/db/src/schema.ts:143` | False claim that SQLite can't ALTER ADD a CHECK justifies skipping DB enum enforcement | schema.ts and database-schema.md repeat a factually wrong claim that SQLite can't ALTER ADD a… |
| `#102` | `medium` | `packages/db/src/client.test.ts:222` | DDL snapshot coverage stops at migration 0002 — 11 of 14 migrations have zero fidelity test | DDL snapshot regression coverage stops at migration 0002, and time.ts has no dedicated unit test |
| `#108` | `medium` | `packages/db/src/media-store.ts:95` | A crash between temp-write and rename permanently orphans a .tmp blob — no sweep ever reclaims it | Harden the reference MediaStore implementations: no write-size ceiling, ignored AbortSignal on… |
| `#116` | `medium` | `apps/cli/src/commands/chat-list.ts:32` | relavium chat-list loads and prints every session unbounded; agent_sessions/runs are never pruned | history.db has soft-delete columns everywhere and zero code path that ever writes them, plus… |
| `#226` | `medium` | `packages/db/src/retry.ts:62` | SQLITE_BUSY backoff blocks the whole Node event loop synchronously via Atomics.wait | withBusyRetry's sleepSync uses Atomics.wait, a genuinely blocking sleep on the main thread, on… |
| `#227` | `medium` | `apps/cli/src/chat/session-host.ts:559` | Two concurrent chat-resume processes collide on a DB UNIQUE index, no user-facing guard | Two concurrent chat-resume processes of the same session compute the same nextSequenceNumber… |
| `#272` | `medium` | `packages/db/src/session-store.ts:326` | loadMessages/loadFull are unbounded, against the 'resumable-forever' session promise | loadMessages/loadFull do a full unbounded table scan of session_messages on every… |
| `#103` | `low` | `packages/db/src/time.ts:1` | time.ts — the sole domain↔storage timestamp boundary — has no dedicated unit test file | DDL snapshot regression coverage stops at migration 0002, and time.ts has no dedicated unit test |
| `#104` | `low` | `packages/db/src/client.ts:44` | createClient throws bare, undiscriminated Errors unlike the rest of the package | createClient throws bare undiscriminated Errors with a raw filesystem path, and its JSDoc… |
| `#105` | `low` | `packages/db/src/client.ts:31` | createClient's JSDoc documents only 2 of the 4 PRAGMAs actually applied | createClient throws bare undiscriminated Errors with a raw filesystem path, and its JSDoc… |
| `#106` | `low` | `packages/db/src/index.ts:11` | index.ts inconsistently withholds sessionCosts/modelMetadata/catalogMeta table exports | index.ts exports raw Drizzle tables for a dozen tables but silently withholds… |
| `#107` | `low` | `packages/db/src/media-egress.ts:69` | Fetched media's declared mimeType is never checked against Content-Type or the actual bytes | A fetched/model-declared media mimeType is never checked against reality at either of two… |
| `#109` | `low` | `packages/db/src/media-reference-store.ts:141` | recordObject() persists a caller-supplied media tuple with zero internal or provenance cross-check | A fetched/model-declared media mimeType is never checked against reality at either of two… |
| `#110` | `low` | `packages/db/src/media-store.ts:78` | Comment claiming mimeType is 'NOT persisted yet' is stale | A fetched/model-declared media mimeType is never checked against reality at either of two… |
| `#111` | `low` | `packages/db/src/media-store.ts:82` | The CAS write chokepoint enforces no size ceiling of its own, asymmetric with its redundant read-side check | Harden the reference MediaStore implementations: no write-size ceiling, ignored AbortSignal on… |
| `#112` | `low` | `packages/db/src/media-store.ts:116` | readRange's abort signal is silently ignored by both Node reference implementations | Harden the reference MediaStore implementations: no write-size ceiling, ignored AbortSignal on… |
| `#113` | `low` | `packages/db/src/media-write.ts:116` | assertRelativePath misses a Windows drive-relative path; safety is coincidental, not by design | assertRelativePath's Windows drive-letter regex only rejects C:\\ forms, missing the… |
| `#117` | `low` | `packages/db/src/session-store.ts:90` | A corrupted session/provider row aborts the whole list read, unlike model-catalog's per-row isolation | A typed per-row-corruption error exists in model-catalog-store.ts but was never propagated to… |
| `#119` | `low` | `packages/db/src/model-catalog-store.ts:361` | replaceProviderModelsTxn issues one SELECT + one write per incoming model instead of a bulk upsert | replaceProviderModelsTxn and metadata-store's upsert both do one SELECT + one write per… |
| `#225` | `low` | `packages/llm/src/catalog/lookup.ts:75` | Process-wide model-catalog overlay is a wholesale-replace with no lock | Two rapid /models refresh calls can silently drop one's results due to a last-settled-wins… |
| `#234` | `low` | `packages/db/src/schema.ts:439` | Absolute machine-specific paths persisted with no documented portability caveat | history.db persists absolute, machine-specific paths with no documented caveat that it is not… |
| `#291` | `low` | `packages/db/src/client.test.ts:376` | No migration is ever tested against pre-existing data — only fresh-DB-then-full-chain | No migration test exercises an ALTER against pre-existing rows, though 9 of 13 migrations use… |
| `G1` | `low` | `apps/cli/src/engine/model-catalog-view.ts:73` | Unguarded Date conversion on a catalog row's deprecationDate can throw and abort the whole catalog projection | An unguarded Date conversion on a corrupted deprecationDate row can crash the whole /models… |
| `#115` | `polish` | `packages/db/src/session-store.ts:148` | session_messages has no secret-masking regression fixture, and the canonical unsafe-columns doc omits it | session_messages content_parts/tool_calls have no secret-masking regression fixture, unlike… |

#### 2.5.5.D — MCP transport, config-trust & filesystem/secret hardening

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#27` | `high` | `apps/cli/src/secrets/os-keychain.ts:16` | The OS-keychain bridge — the one module that touches the native binding — has zero direct tests | The one module touching the native @napi-rs/keyring binding and mapping its failures has zero… |
| `#35` | `high` | `apps/cli/src/engine/mcp-servers.ts:330` | MCP connect has no timeout/abort bound, unlike every other host call here | connectSdkTransport has no configurable/bounded connect-phase timeout across any MCP transport… |
| `#36` | `high` | `apps/cli/src/engine/tool-host/fs.ts:499` | Confidentiality read-floor omits kube/gcloud/azure/terraform credential stores | The sensitive-credential floor protects .ssh/.aws/.docker/git but omits modern cloud/k8s CLI… |
| `#202` | `high` | `packages/mcp/src/tool-mapping.ts:102` | Server tool descriptions/schemas reach the LLM with no untrusted-content treatment | The engine's untrusted-content boundary covers tool CALL RESULTS but never tool DEFINITIONS… |
| `G32` | `high` | `packages/mcp/src/sdk-websocket.ts:43` | No connect-level timeout: a hung network MCP server blocks CLI startup forever | connectSdkTransport has no configurable/bounded connect-phase timeout across any MCP transport… |
| `#1` | `medium` | `apps/cli/src/workflows/catalog.ts:77` | discoverCatalog follows symlinks out of the project directory with no realpath containment | discoverCatalog follows a symlink outside the catalog root with no containment check |
| `#25` | `medium` | `apps/cli/src/commands/inputs.ts:59` | run --input has no safe delivery path or warning for a secret-typed workflow input | run --input coerces a secret-typed workflow input identically to a plain string, taking the raw… |
| `#28` | `medium` | `apps/cli/src/db/open.ts:27` | history.db's 0600 chmod is skipped entirely if migrations fail | The ADR-0050 at-rest 0600 permission guarantee is not uniformly self-healing across history.db… |
| `#30` | `medium` | `apps/cli/src/history/open.ts:42` | The full workflow is snapshotted verbatim into history.db with no hardcoded-credential defense | Full unredacted workflow YAML is snapshotted into history.db with no hardcoded-credential lint |
| `#39` | `medium` | `apps/cli/src/engine/tool-host/process.ts:110` | FORBIDDEN_DECLARED_ENV misses KUBECONFIG/AWS/GCP config-redirection vectors | The sensitive-credential floor protects .ssh/.aws/.docker/git but omits modern cloud/k8s CLI… |
| `#201` | `medium` | `packages/mcp/src/tool-mapping.ts:99` | No cap on tool count or description size discovered from an untrusted server | The codebase's established untrusted-input size-bounding discipline never propagated into the… |
| `#203` | `medium` | `packages/mcp/src/errors.ts:23` | Error identifiers are string-interpolated into .message, not exposed as structured fields | MCP error classes bake diagnostic context into .message strings instead of structured fields… |
| `#204` | `medium` | `packages/mcp/src/errors.ts:25` | McpConnectError collapses every connect-failure mode into one message; cause is stripped | MCP error classes bake diagnostic context into .message strings instead of structured fields… |
| `#205` | `medium` | `packages/mcp/src/sdk-stdio.ts:107` | No way to raise the connect timeout for a slow-starting stdio server (npx cold-start) | connectSdkTransport has no configurable/bounded connect-phase timeout across any MCP transport… |
| `#235` | `medium` | `packages/db/src/media-write.ts:139` | Security-critical realpath-ancestor-walk jail helper duplicated verbatim across two packages | deepestExistingReal, a security-critical realpath-ancestor-walk primitive, is duplicated… |
| `#293` | `medium` | `apps/cli/src/commands/provider.test.ts:527` | readSecretFromStdin — the argv-vs-keychain security guarantee — is 90% untested | readSecretFromStdin — the argv-vs-keychain security guarantee — is 90% untested, and its stdin… |
| `G20` | `medium` | `packages/db/src/provider-store.ts:43` | defaultHeaders is unguarded plaintext, and ADR-0065 slates it to carry wire header values | llm_providers.default_headers is a free-form plaintext column on a collision course with a live… |
| `G33` | `medium` | `packages/mcp/src/sdk-sse.ts:22` | No size bound on inbound MCP traffic — a connected server can flood/OOM the CLI process | The codebase's established untrusted-input size-bounding discipline never propagated into the… |
| `#31` | `low` | `apps/cli/src/secrets/read-secret.ts:13` | readSecretFromStdin's read logic is untested and stdin is buffered with no size cap | readSecretFromStdin — the argv-vs-keychain security guarantee — is 90% untested, and its stdin… |
| `#206` | `low` | `packages/mcp/src/sdk-stdio.ts:137` | callTool silently discards non-object arguments instead of failing loud | SdkConnection.callTool silently swaps invalid args for undefined, and closeAll discards every… |
| `#207` | `low` | `packages/mcp/src/manager.ts:126` | closeAll swallows every teardown error with zero logging | SdkConnection.callTool silently swaps invalid args for undefined, and closeAll discards every… |
| `#209` | `low` | `packages/mcp/src/schema-compiler.ts:235` | Budget bounds node/depth/property/enum count but not a schema's own string byte length | The codebase's established untrusted-input size-bounding discipline never propagated into the… |
| `#288` | `low` | `packages/mcp/src/result.ts:10` | MCP tool-result text is carried unbounded before the generic size cap | The codebase's established untrusted-input size-bounding discipline never propagated into the… |
| `#297` | `low` | `packages/mcp/src/sdk-http.ts:1` | MCP transport adapters (http/sse/websocket) have thin branch coverage hidden by package aggregation | Per-file branch coverage on the MCP transport adapters, exactly the files ADR-0053's SSRF… |
| `G19` | `low` | `apps/cli/src/config/resolve.ts:215` | Project config can hijack a global MCP server's name and redirect its provisioned secret | A lower-trust project config layer can silently override a global MCP server registration by… |
| `G21` | `low` | `apps/cli/src/config/paths.ts:27` | ensureGlobalConfigDir's tmp/ subdir is unused and never inherits the 0700 parent mode | ensureGlobalConfigDir creates ~/.relavium/tmp/ that nothing uses and that never inherits the… |
| `G31` | `low` | `packages/db/src/safe-egress.ts:199` | DNS resolution outlives caller abort/timeout, can pin a threadpool slot | The dns.promises.lookup vs dns.resolve* tradeoff is a deliberate, already-documented design… |
| `#33` | `polish` | `apps/cli/src/config/write.ts:216` | config.toml's 0600 mode is only ever set on write, never re-asserted on load | The ADR-0050 at-rest 0600 permission guarantee is not uniformly self-healing across history.db… |
| `#208` | `polish` | `packages/mcp/src/sdk-stdio.ts:34` | Hardcoded MCP client version never reflects the actual shipped CLI version | CLIENT_INFO.version is a hand-maintained 0.1.0 literal disconnected from the real CLI version… |

#### 2.5.5.E — CLI operator-safety net: signals, error boundaries, crash handling & startup performance

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#13` | `high` | `docs/reference/cli/commands.md:78` | Docs claim `--help --json` emits a machine-readable manifest; code never does this | Docs and manifest.ts doc comments claim --help --json emits COMMAND_MANIFEST as JSON, but no… |
| `#20` | `high` | `apps/cli/src/commands/gate.ts:201` | gate's idempotent-resume messages write plain text to stdout even under --json | gate.ts's two idempotent-resume success paths write plain human text to stdout with no --json… |
| `#21` | `high` | `apps/cli/src/commands/agent-run.ts:145` | agent run registers no SIGINT handler, orphaning MCP children on Ctrl-C | SIGINT/cancel handling is inconsistently wired across the CLI's chat/run/agent-run drivers |
| `#40` | `high` | `apps/cli/src/process/io.ts:24` | Unhandled EPIPE on process.stdout.write crashes the whole CLI with a raw Node stack trace | The CLI's outermost error/crash safety net has five independent gaps: unhandled EPIPE, an… |
| `#278` | `high` | `apps/cli/src/commands/dispatch.ts:289` | Most commands open history.db unwrapped, so the same fault is good in one place, useless elsewhere | openLocalDb is wrapped into a clean CliError at only 3 of 8+ call sites, and no redaction… |
| `G3` | `high` | `apps/cli/src/render/tui/run-view-model.ts:278` | reduceRunEvent silently drops agent:reasoning — reasoning never renders in `relavium run` | The const exhaustive: never guard engine.ts adopted after the EA6 agent:reasoning-drop bug was… |
| `G43` | `high` | `apps/cli/src/chat/doctor-host.ts:54` | /doctor hardcodes the wrong profile — always reports egress/os unwired in a normal chat session | /doctor hardcodes profile:chat-read-only when probing tool-host wiring, always misreporting… |
| `#3` | `medium` | `apps/cli/src/workflows/resolve.ts:15` | resolve.ts's byte-size pre-check uses a 1x multiplier, not the 4x every sibling guard uses | resolve.ts uses a 1x UTF-8 byte multiplier where authoring.ts and catalog.ts correctly use 4x |
| `#4` | `medium` | `apps/cli/src/workflows/resolve.ts:125` | resolve.ts/catalog.ts embed absolute filesystem paths in user-facing error messages | authoring.ts's cwd-relative displayPath discipline never propagated to resolve.ts, catalog.ts… |
| `#22` | `medium` | `apps/cli/src/commands/run.ts:285` | Unguarded db-close in teardown finally can mask a run's real exit code | chat.ts's closeQuietly() helper was never adopted by run.ts, gate.ts, chat-export.ts, or… |
| `#23` | `medium` | `apps/cli/src/commands/chat.ts:2266` | Ctrl-C in the plain/JSON chat drivers only stops future input, not the in-flight turn | SIGINT/cancel handling is inconsistently wired across the CLI's chat/run/agent-run drivers |
| `#24` | `medium` | `apps/cli/src/commands/agent-run.ts:205` | agent run with no piped stdin blocks silently with no indication it's waiting for input | relavium agent run lacks the stdin-TTY banner and cost-line output that its sibling commands… |
| `#41` | `medium` | `apps/cli/src/run.ts:62` | buildProgram() is called outside any try/catch, silently breaking run()'s documented 'never reject' guarantee | The CLI's outermost error/crash safety net has five independent gaps: unhandled EPIPE, an… |
| `#42` | `medium` | `apps/cli/src/index.ts:8` | No process-wide unhandledRejection/uncaughtException safety net at the CLI's only entry point | The CLI's outermost error/crash safety net has five independent gaps: unhandled EPIPE, an… |
| `#43` | `medium` | `apps/cli/src/run.ts:5` | run.ts eagerly imports the entire Home/chat/DB/keychain stack for every invocation, including --help/--version | run.ts/dispatch.ts eagerly load the entire Home/chat/DB/keychain module graph on every… |
| `#224` | `medium` | `apps/cli/src/home/drive-home.tsx:700` | No global exception handler; a crash orphans a detached run_command child process group | The CLI's outermost error/crash safety net has five independent gaps: unhandled EPIPE, an… |
| `#264` | `medium` | `apps/cli/src/process/options.ts:76` | -q/--quiet is a fully dead flag — parsed, validated, never read | --quiet/--verbose/RELAVIUM_DEBUG are three loosely-coordinated, partially-dead diagnostic… |
| `#265` | `medium` | `apps/cli/src/program.ts:35` | -v/--verbose does far less than its own help text and docs promise | --quiet/--verbose/RELAVIUM_DEBUG are three loosely-coordinated, partially-dead diagnostic… |
| `#271` | `medium` | `apps/cli/src/commands/dispatch.ts:12` | Every CLI invocation eagerly loads the entire dependency graph, ~370ms fixed tax on every command | run.ts/dispatch.ts eagerly load the entire Home/chat/DB/keychain module graph on every… |
| `#280` | `medium` | `apps/cli/src/history/session-open.ts:33` | DB-open errors interpolate a raw absolute file path into user-facing text with no redaction backstop | openLocalDb is wrapped into a clean CliError at only 3 of 8+ call sites, and no redaction… |
| `#300` | `medium` | `apps/cli/src/chat/persister.ts:177` | Session-persister event switch silently drops unhandled event kinds, no exhaustiveness guard | The const exhaustive: never guard engine.ts adopted after the EA6 agent:reasoning-drop bug was… |
| `#301` | `medium` | `apps/cli/src/render/tui/chat-ink.tsx:944` | Picker key-routing switches lack exhaustiveness guard on the ADR-0059 reseat union | The const exhaustive: never guard engine.ts adopted after the EA6 agent:reasoning-drop bug was… |
| `G15` | `medium` | `apps/cli/src/commands/logs.ts:39` | relavium logs human mode floods on the token firehose, and it's untested there | relavium logs human mode replays raw per-event agent:token/agent:reasoning instead of… |
| `G35` | `medium` | `apps/cli/src/process/errors.ts:22` | Exit code 1 is documented as 'workflow failed' but reused for any unclassified internal fault | Exit code 1 is documented as workflow failed but is silently reused for any unclassified… |
| `#17` | `low` | `apps/cli/src/program.ts:63` | Global flags documented only on top-level `--help`, invisible on every subcommand's own `--help` | GLOBAL_OPTIONS_HELP is attached only to the root program; commander does not propagate it to… |
| `#19` | `low` | `apps/cli/src/commands/provider.ts:292` | The manifest's one `destructive` command has zero shell-level confirmation or force gate | provider remove-key, the manifest's sole effect:destructive command, has zero shell-level… |
| `#26` | `low` | `apps/cli/src/commands/chat.ts:2321` | One-shot agent run never shows the turn's cost in human (non-JSON) mode | relavium agent run lacks the stdin-TTY banner and cost-line output that its sibling commands… |
| `#32` | `low` | `apps/cli/src/config/load.ts:172` | formatZodError inconsistently withholds safe, schema-derived numeric bounds | formatZodError inconsistently withholds schema-derived numeric bounds for too_small/too_big… |
| `#44` | `low` | `apps/cli/src/run.ts:59` | seedCatalog() does a sync disk read/parse/validate before dispatch, even for meta-ops | run.ts/dispatch.ts eagerly load the entire Home/chat/DB/keychain module graph on every… |
| `#45` | `low` | `apps/cli/src/process/errors.ts:66` | Generic 'internal error' messages never tell the user --verbose or RELAVIUM_DEBUG exists | --quiet/--verbose/RELAVIUM_DEBUG are three loosely-coordinated, partially-dead diagnostic… |
| `#46` | `low` | `apps/cli/tsup.config.ts:53` | sourcemap:false is unconditional — even RELAVIUM_DEBUG crash stacks are unreadable to the maintainer | sourcemap:false is correct per ADR-0051, but no privately-retained sourcemap exists to… |
| `#47` | `low` | `apps/cli/src/harness/concurrency.e2e.test.ts:198` | Cross-process lock-contention test silently skips under the package's own `pnpm test` | The two-process lock-contention test silently skips (not fails) under apps/cli's own bare pnpm… |
| `#48` | `low` | `apps/cli/src/test-support.ts:208` | seedRun's own misuse guard-rails (ambiguous gates:[], duplicate gateId) are themselves untested | seedRun's own misuse guard-rails (empty gates array, duplicate gateId) have zero test coverage |
| `#54` | `low` | `apps/cli/src/onboarding/wizard.ts:302` | A bare, untyped Error contradicts the module's own documented propagation contract | Three more sites throw bare Error instead of the project's typed CliError, including the… |
| `#268` | `low` | `apps/cli/src/index.ts:11` | RELAVIUM_DEBUG, the only escape hatch for the worst crash class, is undocumented | --quiet/--verbose/RELAVIUM_DEBUG are three loosely-coordinated, partially-dead diagnostic… |
| `#269` | `low` | `apps/cli/src/index.ts:10` | The last-resort crash message ignores --json, breaking the CLI's stderr-diagnostic convention | The CLI's outermost error/crash safety net has five independent gaps: unhandled EPIPE, an… |
| `#281` | `low` | `apps/cli/src/render/tui/home-controller.ts:1035` | Command palette step-run failures are unconditionally swallowed with no user-visible trace | A command-palette step's run() rejection is discarded with a bare .catch(() => undefined) and… |
| `#310` | `low` | `apps/cli/src/commands/specs.ts:78` | --input means three unrelated things across sibling commands | --input means three-to-four semantically incompatible things across run/agent run/models… |
| `G2` | `low` | `apps/cli/src/engine/host.ts:112` | Checkpointer/store wiring guard throws a bare Error instead of a typed, discriminated error | Three more sites throw bare Error instead of the project's typed CliError, including the… |
| `G11` | `low` | `apps/cli/src/chat/export.ts:84` | chat-export leaks the absolute filesystem path in a user-facing error | authoring.ts's cwd-relative displayPath discipline never propagated to resolve.ts, catalog.ts… |
| `G14` | `low` | `apps/cli/src/commands/models-pricing.ts:87` | Byte-identical duplicate interface declaration (ModelsPricingCommandDeps) | A byte-identical duplicate interface declaration in the models-pricing command |
| `G36` | `low` | `apps/cli/src/process/render-error.ts:30` | render-error.ts's positive --verbose stack-dump branch is never directly tested, and has no unit test file | render-error.ts's positive --verbose-without-json stack-dump branch has zero direct test… |
| `G37` | `low` | `apps/cli/src/gate/select-prompter.ts:13` | selectGatePrompter's TTY/json/CI routing logic has no direct unit test, unlike sibling should-open-home.ts | selectGatePrompter's TTY/json/CI routing decision has no direct unit test, unlike its… |
| `G46` | `low` | `apps/cli/src/process/render-error.ts:14` | The highest-bar error-rendering file has no direct unit test; its verbose-stack path is untested | render-error.ts's positive --verbose-without-json stack-dump branch has zero direct test… |
| `#11` | `polish` | `apps/cli/src/chat/agent-source.ts:21` | Docstring claim 'no mid-session switching (ADR-0024)' is not cross-referenced against ADR-0059's reseat | A doc comment in the agent-source resolution path still claims no mid-session model switching… |
| `#12` | `polish` | `apps/cli/src/chat/fixture.ts:95` | Bare throw new Error(...) in the cassette replay provider violates the typed/discriminated error standard | Three more sites throw bare Error instead of the project's typed CliError, including the… |
| `#18` | `polish` | `apps/cli/src/commands/dispatch.ts:226` | `--input` means four unrelated things across sibling commands in one flat option namespace | --input means three-to-four semantically incompatible things across run/agent run/models… |
| `#34` | `polish` | `apps/cli/src/config/write.ts:220` | The atomic rename silently replaces a symlinked config.toml with no warning | The atomic config.toml rename silently orphans a user's intentional dotfiles symlink with no… |

#### 2.5.5.F — Documentation & roadmap accuracy

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#127` | `high` | `docs/roadmap/current.md:19` | current.md says 2.6.Q is 'blocked' on decisions already Accepted and implemented | Five roadmap/status docs (current.md, AGENTS.md, phase banners) fell behind a merge event that… |
| `#141` | `high` | `docs/reference/shared-core/mcp-integration.md:78` | Outbound-MCP section documents a fabricated, nonexistent API as shipped | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#142` | `high` | `docs/reference/contracts/agent-yaml-spec.md:34` | Agent memory policy (none/window/summary) is validated but has zero runtime consumer | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#148` | `high` | `docs/architecture/overview.md:50` | System-map diagram draws a Core→DB edge that doesn't exist in code | overview.md's system-map diagram draws a Core→DB edge that doesn't exist and misrepresents the… |
| `#160` | `high` | `docs/tutorials/cli/start-a-chat-session.md:3` | Flagship 'relavium chat' tutorial still marked 'planned - to be expanded' | The flagship chat tutorial is still marked planned though chat.ts is a mature, feature-complete… |
| `#162` | `high` | `.claude/skills/start-task/SKILL.md:31` | Three skills embed a hardcoded path copy-pasted from a different project ('Agent-Organizer') | Three skills embed literal hardcoded paths copy-pasted from an unrelated project that don't… |
| `G23` | `high` | `docs/runbooks/add-a-provider-key.md:29` | Detailed flow is a 0%-built desktop UI; the real CLI path gets one vague sentence | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `G24` | `high` | `docs/runbooks/local-dev-setup.md:68` | 'Run a surface' step 3 gives three commands and all three fail as written | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#14` | `medium` | `docs/reference/cli/commands.md:220` | `relavium models` doc section describes a pricing architecture ADR-0071/0072 already retired | Four docs still name the retired hand-typed pricing.ts MODEL_PRICING table as the pricing… |
| `#15` | `medium` | `docs/reference/cli/commands.md:241` | `models pricing --json` output shape is incompletely documented | Four docs still name the retired hand-typed pricing.ts MODEL_PRICING table as the pricing… |
| `#16` | `medium` | `docs/reference/cli/commands.md:127` | `relavium budget resume` table row lacks the `_(planned)_` marker its unshipped siblings get | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#128` | `medium` | `CLAUDE.md:23` | packages/mcp is entirely absent from CLAUDE.md's canonical package table | packages/mcp is a real, shipped, tested package missing from five independent package-inventory… |
| `#129` | `medium` | `docs/project-structure.md:61` | Packages table and dependency diagram also omit packages/mcp | packages/mcp is a real, shipped, tested package missing from five independent package-inventory… |
| `#130` | `medium` | `README.md:17` | 'Four surfaces, one engine' overstates Desktop/VS Code as already running the engine | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#131` | `medium` | `docs/project-structure.md:55` | Apps table gives desktop/vscode-extension unflagged detail, unlike the flagged Phase-2 rows | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#133` | `medium` | `docs/roadmap/phases/phase-2.6-conversational-authoring.md:3` | Phase 2.6's own status banner is stale relative to its own body | Five roadmap/status docs (current.md, AGENTS.md, phase banners) fell behind a merge event that… |
| `#136` | `medium` | `docs/vision.md:160` | 'Retry from node' is listed as a Phase-1 Killer Feature with no caveat, despite zero engine support | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#143` | `medium` | `docs/reference/README.md:26` | Reference hub and shared-core sub-index omit real specs; agent-runner.md is orphaned | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#146` | `medium` | `docs/reference/desktop/routes-and-screens.md:77` | Run-detail spec claims present-tense retry-from-node support; zero engine support exists | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#150` | `medium` | `docs/architecture/desktop-architecture.md:1` | Desktop/state-mgmt docs describe a 0%-built app with no not-yet-built marker | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#153` | `medium` | `docs/architecture/overview.md:111` | "The shared packages" inventory and diagram omit packages/mcp entirely | packages/mcp is a real, shipped, tested package missing from five independent package-inventory… |
| `#154` | `medium` | `docs/architecture/overview.md:142` | SQLCipher claim overstates the CLI's actual (unencrypted) at-rest posture | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#156` | `medium` | `docs/architecture/overview.md:108` | CLI's row in "The four surfaces" table describes an early-Phase-2 CLI, not the shipped product | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#161` | `medium` | `docs/tutorials/README.md:27` | Recommended onboarding path routes a new user through two 0%-built surfaces | The flagship chat tutorial is still marked planned though chat.ts is a mature, feature-complete… |
| `#163` | `medium` | `.claude/agents/relavium-reviewer.md:10` | The reviewer agent's package inventory omits @relavium/mcp entirely | packages/mcp is a real, shipped, tested package missing from five independent package-inventory… |
| `#164` | `medium` | `.claude/agents/relavium-reviewer.md:51` | Reviewer checklist is desktop-centric though apps/cli is the only shipped surface | The reviewer agent's security checklist covers only the 0%-built desktop threat model, omitting… |
| `#250` | `medium` | `docs/reference/cli/commands.md:220` | models doc says static pricing.ts registry is the pricing authority — stale by two ADR generations | Four docs still name the retired hand-typed pricing.ts MODEL_PRICING table as the pricing… |
| `#251` | `medium` | `docs/reference/shared-core/README.md:1` | agent-runner.md missing from both the shared-core and top-level reference indexes | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#254` | `medium` | `docs/project-structure.md:60` | project-structure.md omits packages/mcp entirely, understating the package count | packages/mcp is a real, shipped, tested package missing from five independent package-inventory… |
| `G10` | `medium` | `docs/reference/shared-core/node-types.md:142` | node-types.md overstates fan-in.ts's `first` behavior vs. run-plan.md's own accurate description | node-types.md overstates merge_strategy first behavior and documents three… |
| `G13` | `medium` | `docs/reference/cli/commands.md:220` | relavium models section is stale against ADR-0071/0072 and self-contradicts | Four docs still name the retired hand-typed pricing.ts MODEL_PRICING table as the pricing… |
| `G25` | `medium` | `docs/architecture/multi-llm-providers.md:149` | Doc still names the deleted `pricing.ts` hand-typed table as the canonical pricing source | Four docs still name the retired hand-typed pricing.ts MODEL_PRICING table as the pricing… |
| `G45` | `medium` | `docs/reference/shared-core/node-types.md:126` | human_in_the_loop_config's field list is stale, and cites input_schema which exists nowhere in code | node-types.md overstates merge_strategy first behavior and documents three… |
| `#120` | `low` | `docs/decisions/0031-llm-seam-shape-amendment-multimodal-io.md:69` | ADR-0031 restates the full multimodal spec instead of citing llm-provider-seam.md | Two ADRs and one project-structure.md row restate content that already lives verbatim in a… |
| `#122` | `low` | `docs/decisions/0016-api-framework-hono.md:9` | ADR-0016/0017 describe apps/api as scaffolded but the directory doesn't exist at all | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#124` | `low` | `docs/decisions/0069-string-width-for-the-cli-renderer.md:5` | Related line links to a nonexistent ADR-0047 filename — 404s on GitHub | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#132` | `low` | `AGENTS.md:25` | AGENTS.md's phase-status line has fallen behind CLAUDE.md, breaking its own 'mirror' contract | Five roadmap/status docs (current.md, AGENTS.md, phase banners) fell behind a merge event that… |
| `#134` | `low` | `CLAUDE.md:54` | CLAUDE.md/README.md's 'en/tr' localization claim undercounts the canonical five-language plan | CLAUDE.md's single Phase-2.6 status sentence about en+tr localization is wrong on three counts… |
| `#135` | `low` | `docs/glossary.md:1` | Glossary omits several load-bearing architectural terms recurring across the ADR corpus | The glossary omits several load-bearing terms recurring across the ADR corpus, and its Last… |
| `#137` | `low` | `docs/glossary.md:4` | Glossary's 'Last updated' header is stale by over a month | The glossary omits several load-bearing terms recurring across the ADR corpus, and its Last… |
| `#138` | `low` | `docs/roadmap/phases/phase-3-desktop.md:3` | Phase 3's status line still says 'Blocked on Phase 2' after 2.5/2.6 were inserted ahead of it | Five roadmap/status docs (current.md, AGENTS.md, phase banners) fell behind a merge event that… |
| `#139` | `low` | `docs/roadmap/current.md:19` | 'seven decisions' figure doesn't match the cited source, which says six | Five roadmap/status docs (current.md, AGENTS.md, phase banners) fell behind a merge event that… |
| `#144` | `low` | `docs/reference/cli/commands.md:127` | budget resume listed as a live command row while prose and code both say it's a stub | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#145` | `low` | `docs/reference/shared-core/agent-runner.md:63` | AgentRunner's cost:updated payload doc is missing the priced field added by ADR-0070 | agent-runner.md's documented cost:updated payload is missing the priced boolean field ADR-0070… |
| `#147` | `low` | `docs/reference/shared-core/store-shapes.md:3` | Desktop-only specs tagged Status: Stable despite zero implementing code | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#149` | `low` | `docs/architecture/overview.md:52` | System-map diagram draws an LLM→Keychain edge that doesn't exist in code | overview.md's system-map diagram draws a Core→DB edge that doesn't exist and misrepresents the… |
| `#151` | `low` | `docs/standards/documentation-style.md:91` | §6 canonical-artifact registry is missing 6 of 11 docs/reference/shared-core/ files | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#155` | `low` | `docs/architecture/overview.md:133` | packages/db described as targeting Postgres already; only SQLite dialect exists | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#157` | `low` | `docs/architecture/README.md:43` | Reading order contradicts cloud-phase-2.md/managed-inference.md's own stated shipping order | architecture/README.md's recommended reading order contradicts both target docs' own stated… |
| `#158` | `low` | `docs/standards/commit-style.md:31` | Enumerated commit Types list omits `style`, which real repo history uses | commit-style.md's enumerated Types list omits style, which real repo history already uses |
| `#159` | `low` | `docs/architecture/overview.md:136` | packages/ui described as an existing library with no unbuilt marker | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#165` | `low` | `docs/analysis/models-dev-dynamic-catalog-enrichment-2026-07-11.md:391` | Analysis doc's pricing-precedence table is stale and has no link to the ADRs it produced | Four docs still name the retired hand-typed pricing.ts MODEL_PRICING table as the pricing… |
| `#166` | `low` | `docs/tutorials/cli/README.md:8` | The CLI tutorials index omits the chat tutorial that lives in the same folder | The flagship chat tutorial is still marked planned though chat.ts is a mature, feature-complete… |
| `#167` | `low` | `.claude/skills/security-review/SKILL.md:72` | SSRF checklist doesn't require checking for a second/duplicate SSRF implementation | The reviewer agent's security checklist covers only the 0%-built desktop threat model, omitting… |
| `#238` | `low` | `packages/shared/src/content.ts:446` | Stale comment says media url source is feature-flag-OFF; the flag is actually ON | A doc comment on urlSourceSchema asserts the opposite of the actual, true state of a… |
| `#246` | `low` | `docs/tech-stack.md:1` | @modelcontextprotocol/sdk transitively pulls a full unused server/OAuth stack into the CLI | tech-stack.md, the single source of truth for pinned choices, omits two ADR-backed runtime… |
| `#247` | `low` | `docs/tech-stack.md:1` | tech-stack.md's pinned-choices table omits two ADR-backed CLI runtime dependencies | tech-stack.md, the single source of truth for pinned choices, omits two ADR-backed runtime… |
| `#252` | `low` | `docs/reference/cli/README.md:11` | cli reference index is missing accessibility.md and regression-harness.md | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#253` | `low` | `docs/decisions/0062-context-compaction-and-cli-history-commands.md:5` | Repo-wide sweep found four broken relative links across docs/ (ADR renames + wrong subdirectory) | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#255` | `low` | `docs/project-structure.md:65` | db package row overclaims a working Postgres dialect that doesn't exist in code | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#256` | `low` | `docs/reference/cli/commands.md:127` | budget resume table row lacks the (planned) tag its unshipped neighbors both carry | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `#260` | `low` | `CLAUDE.md:1` | Phase 2.6 status line reads as if en+tr localization already ships; it hasn't started | CLAUDE.md's single Phase-2.6 status sentence about en+tr localization is wrong on three counts… |
| `G28` | `low` | `docs/architecture/key-management.md:1` | Extends a known doc-drift pattern (unbuilt desktop shown as current) to two more files | The project's own not-yet-built hedging conventions (Reserved/planned tags, not-yet-shipped… |
| `G42` | `low` | `apps/cli/src/render/tui/force-color.ts:12` | force-color.ts is a test-only chalk shim, not the runtime NO_COLOR/FORCE_COLOR gate its name suggests | force-color.ts is a test-only chalk shim easily mistaken for the real NO_COLOR/FORCE_COLOR… |
| `#74` | `polish` | `apps/cli/src/render:1` | No localization/i18n scaffolding exists anywhere in apps/cli — confirmed absent, not merely thin | CLAUDE.md's single Phase-2.6 status sentence about en+tr localization is wrong on three counts… |
| `#121` | `polish` | `docs/decisions/0027-expression-sandbox.md:144` | ADR-0027 addendum duplicates sandbox resource-cap constants from the reference spec | Two ADRs and one project-structure.md row restate content that already lives verbatim in a… |
| `#123` | `polish` | `docs/decisions/0021-node-sqlite-driver-better-sqlite3.md:26` | Superseded ADR-0021 states a stale Node floor with no in-body amendment pointer | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#125` | `polish` | `docs/decisions/0070-durable-per-model-session-cost-attribution.md:174` | Home's showCost still inert; ADR-0070's 'implementable for free' claim not realized on that surface | Home's showCost is hard-coded to a no-op even though ADR-0070 §7 says the DB-backed cost… |
| `#126` | `polish` | `docs/decisions/0071-models-dev-as-the-model-metadata-source.md:431` | Lone '§K7' section label has no §K1-K6 predecessors, could confuse a direct-citation reader | Repo-wide docs link/index hygiene sweep: fix four broken relative links (one of which… |
| `#140` | `polish` | `docs/tech-stack.md:78` | Playwright e2e row isn't phase-flagged like the other not-yet-applicable rows | tech-stack.md, the single source of truth for pinned choices, omits two ADR-backed runtime… |
| `#257` | `polish` | `docs/project-structure.md:79` | apps/cli row restates a now-stale subcommand list instead of linking to the canonical command reference | Two ADRs and one project-structure.md row restate content that already lives verbatim in a… |

#### 2.5.5.G — Codebase hygiene: naming, duplication & dead code

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#65` | `medium` | `apps/cli/src/render/sanitize.ts:51` | Tab characters preserved through sanitization but measured as 0-width, breaking the width invariant | Tabs are preserved through sanitization but measured as 0-width by string-width, breaking the 1… |
| `#236` | `medium` | `apps/cli/src/chat/effort-notice.ts:230` | Second hand-rolled micro-cent→USD formatter contradicts the canonical formatter's own comment | Four separate call sites reimplement or bypass canonical money/token conversion helpers… |
| `#307` | `medium` | `apps/cli/src/commands/chat.ts:490` | The budget-cap warning shows raw microcents instead of USD, the only place in the codebase that does | Four separate call sites reimplement or bypass canonical money/token conversion helpers… |
| `#216` | `low` | `packages/core/src/tools/registry.ts:172` | Result discriminant field named `success` here, `ok` everywhere else in same package | success vs ok and model vs modelId are inconsistently named across packages/core and… |
| `#217` | `low` | `packages/llm/src/capabilities.ts:15` | `Capability` means two unrelated things across two packages imported together | Capability means two unrelated things across packages/llm and packages/core, and the same… |
| `#218` | `low` | `apps/cli/src/chat/session-host.ts:439` | Three different words (reseat / swap / switch) name the same ADR-0059 operation | swapAgentModel/model SWITCH naming diverges from the dominant reseat vocabulary used everywhere… |
| `#221` | `low` | `packages/llm/src/pricing.ts:114` | Model-identifier param named `model` vs `modelId` inconsistently in one subsystem | success vs ok and model vs modelId are inconsistently named across packages/core and… |
| `#237` | `low` | `packages/llm/src/budget-estimator.ts:6` | TOKENS_PER_MTOK money-conversion constant defined twice in the same package | Four separate call sites reimplement or bypass canonical money/token conversion helpers… |
| `#239` | `low` | `packages/llm/src/adapters/index.ts:1` | The documented `@relavium/llm/adapters` package entry point has zero consumers anywhere in the monorepo | Three confirmed-dead exports/re-exports found by a knip verification pass |
| `#240` | `low` | `apps/cli/src/commands/dispatch.ts:633` | isDispatchableId is exported and documented but never called anywhere | Three confirmed-dead exports/re-exports found by a knip verification pass |
| `#242` | `low` | `apps/cli/src/render/tui/mention.ts:290` | Chars-per-token heuristic (÷4) independently re-implemented for the @-mention token warning | Four separate call sites reimplement or bypass canonical money/token conversion helpers… |
| `#258` | `low` | `apps/cli/src/engine/model-refresh.ts:261` | Unpinned localeCompare makes `models refresh --json` order locale-dependent | Unpinned localeCompare calls at 9+ sites make sorted CLI --json output order… |
| `#259` | `low` | `apps/cli/src/engine/mcp-servers.ts:515` | More unpinned localeCompare sorts on identifiers, unlike the correctly-pinned catalog site | Unpinned localeCompare calls at 9+ sites make sorted CLI --json output order… |
| `G54` | `low` | `apps/cli/src/render/tui/attachments.ts:98` | fileAttachmentWarning uses raw byte size, contradicting its own 'NOT the raw file size' doc | fileAttachmentWarning estimates tokens from raw sizeBytes instead of the actually-injected… |
| `#222` | `polish` | `apps/cli/src/render/tui/home-controller.ts:195` | Same host-injected-I/O pattern named `Capability` in core, `Port` in shared/cli | Capability means two unrelated things across packages/llm and packages/core, and the same… |
| `#241` | `polish` | `apps/cli/src/render/tui/ink-renderer.ts:21` | FRAME_MS re-export's justifying comment is false — no importer uses it | Three confirmed-dead exports/re-exports found by a knip verification pass |
| `#303` | `polish` | `apps/cli/src/engine/catalog-metadata.ts:116` | Structurally-checked casts reconciling exactOptionalPropertyTypes trust assignability, not equivalence | Structurally-checked as X casts and non-null assertions rely on control flow rather than the… |
| `#304` | `polish` | `packages/mcp/src/schema-compiler.ts:175` | Non-null assertions in schema-compiler are correct but rely on control-flow, not the type system | Structurally-checked as X casts and non-null assertions rely on control flow rather than the… |
| `G55` | `polish` | `apps/cli/src/render/tui/mouse.ts:88` | Complete-report SGR regex has no digit-length bound, unlike the capped partial-fragment path | SGR_MOUSE regex has no digit-length cap unlike the bounded partial-fragment path |

#### 2.5.5.H — CI, build pipeline, test-infrastructure & observability foundation

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#152` | `medium` | `docs/standards/testing.md:116` | "enforced floor ≥90%" overstates a coverage gate that is explicitly advisory in CI | testing.md's '>=90% enforced floor' claim is contradicted by vitest.config.ts's own header… |
| `#266` | `medium` | `docs/standards/logging-and-observability.md:20` | The binding standard describes an injected-logger architecture that does not exist in the codebase | The binding logging standard describes an injected-logger architecture that has zero… |
| `#294` | `medium` | `.github/workflows/ci.yml:258` | The required PR gate never runs the actual compiled CLI binary | The required PR gate never executes the compiled dist/index.js binary, so a stale/missing… |
| `#312` | `medium` | `package.json:20` | Root `pnpm ci` and the real `.github/workflows/ci.yml` have diverged in both directions | The root pnpm ci script and the real ci.yml have diverged in both directions |
| `#313` | `medium` | `tools/engine-deps/check.mjs:62` | engine-deps only checks direct dependency names, not transitive platform-purity of what's allowed | tools/engine-deps/check.mjs covers neither packages/db nor packages/mcp, and never checks… |
| `#315` | `medium` | `turbo.json:17` | apps/cli's build task output declaration omits the `drizzle/` side-effect the bundled binary needs at runtime | The required PR gate never executes the compiled dist/index.js binary, so a stale/missing… |
| `#316` | `medium` | `docs/standards/documentation-style.md:1` | Zero automated enforcement of the binding documentation-style rules | Zero automated enforcement exists for the binding documentation-style rules despite CLAUDE.md… |
| `#318` | `medium` | `packages/db/package.json:1` | packages/db and packages/mcp dependency growth is completely unpoliced by any automated tool | tools/engine-deps/check.mjs covers neither packages/db nor packages/mcp, and never checks… |
| `G26` | `medium` | `.github/workflows/release.yml:64` | No in-workflow check that a release tag's commit is reachable from `main` before publish | release.yml never verifies a release tag's commit is reachable from main before publishing to… |
| `#248` | `low` | `apps/cli/tsup.config.ts:25` | tsup THIRD_PARTY_EXTERNAL list is stale vs its own doc-comment and package.json | THIRD_PARTY_EXTERNAL is stale versus package.json and its own doc-comment overstates what it… |
| `#267` | `low` | `packages/core/src/engine/engine.ts:1298` | correlationId is stamped on every failure but never surfaced anywhere | The binding logging standard describes an injected-logger architecture that has zero… |
| `#270` | `low` | `apps/cli/src/engine/media-gc.ts:161` | Media GC failures are permanently invisible — no warn-level surfacing | The binding logging standard describes an injected-logger architecture that has zero… |
| `#285` | `low` | `tools/engine-deps/check.mjs:26` | packages/db and packages/mcp have zero automated dependency-size policing | tools/engine-deps/check.mjs covers neither packages/db nor packages/mcp, and never checks… |
| `#296` | `low` | `vitest.config.ts:42` | The documented >=90% line+branch engine coverage floor is not actually an enforced CI gate | testing.md's '>=90% enforced floor' claim is contradicted by vitest.config.ts's own header… |
| `#298` | `low` | `packages/core/src/expression/sandbox.test.ts:183` | Several tests rely on real wall-clock timing instead of fake timers, mostly in the newest code | A cluster of tests race real wall-clock setTimeout windows instead of fake timers, risking CI… |
| `#299` | `low` | `packages/llm/src/conformance:1` | No property-based/fuzz testing anywhere in the repo | No property-based/fuzz testing exists anywhere in the repo, on files where example-table… |
| `#302` | `low` | `apps/cli/src/engine/catalog-refresh.ts:181` | Untested non-Uint8Array branch in capped stream reader | The non-Uint8Array continue-branch in the capped stream reader feeding the models.dev pricing… |
| `#314` | `low` | `tools/bundle-closure/check.mjs:42` | Bundle-closure guard silently examines only one output chunk, with no assertion that it's the only one | bundle-closure's guard silently examines only one esbuild output chunk with no assertion it's… |
| `#317` | `low` | `tools/sync-models-dev/sync.mjs:267` | The documented `--check` (staleness) mode is implemented but never invoked by any CI workflow | sync:models:check, the documented staleness-detection mode for the committed models.dev… |
| `#320` | `low` | `.github/workflows/ci.yml:134` | Advisory-job labeling is inconsistent in the GitHub Actions UI | floor-check and peer-dep-gate are advisory but don't carry the (advisory) UI marker that… |
| `G27` | `low` | `apps/cli/tsup.config.ts:24` | `THIRD_PARTY_EXTERNAL` array is out of sync with its own stated purpose | THIRD_PARTY_EXTERNAL is stale versus package.json and its own doc-comment overstates what it… |

#### 2.5.5.I — Experience/TUI polish: terminal safety, editing primitives, rendering consistency & onboarding

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#56` | `critical` | `apps/cli/src/render/tui/RunApp.tsx:30` | relavium run TUI never sanitizes terminal output — an ANSI/OSC/Trojan-Source injection hole | stripTerminalControls/sanitizeInline is applied at nearly every dynamic-text display boundary… |
| `#57` | `high` | `apps/cli/src/render/tui/final-summary.ts:56` | Persisted post-run summary prints errorMessage and node ids raw, unlike chat's vetted allowlist | stripTerminalControls/sanitizeInline is applied at nearly every dynamic-text display boundary… |
| `#62` | `high` | `apps/cli/src/render/tui/chat-input.ts:260` | Prompt editor edits by code point, not grapheme cluster — splits flags/ZWJ emoji/accents | The Intl.Segmenter grapheme-aware primitive built for ADR-0069's viewport never reached the… |
| `G0` | `high` | `apps/cli/src/render/suspend.ts:78` | SIGTSTP (Ctrl-Z) is unhandled — alt-screen/mouse state never released before the process stops | SIGTSTP/SIGCONT are completely absent from the exit-safety net, and signal handlers aren't… |
| `G34` | `high` | `apps/cli/src/process/render-error.ts:25` | Universal error boundary writes messages to the terminal with zero ANSI/bidi sanitization | stripTerminalControls/sanitizeInline is applied at nearly every dynamic-text display boundary… |
| `G44` | `high` | `apps/cli/src/gate/clack-prompter.ts:44` | Human-gate approval card renders event.message with no terminal-escape sanitization | stripTerminalControls/sanitizeInline is applied at nearly every dynamic-text display boundary… |
| `#49` | `medium` | `apps/cli/src/onboarding/wizard.ts:241` | A failed writeDefaultModel silently re-introduces the exact bug the wizard exists to fix | A writeDefaultModel failure in onboarding leaves the exact anthropic-default mismatch the… |
| `#50` | `medium` | `apps/cli/src/home/drive-home.tsx:636` | Signal handlers are not registered until after the (network-bound) onboarding wizard resolves | SIGTSTP/SIGCONT are completely absent from the exit-safety net, and signal handlers aren't… |
| `#51` | `medium` | `apps/cli/src/home/home-store.ts:73` | The Home carries no persistent signal that the user still has no provider key | HomeSnapshot has no field for keyless state so a skipped/cancelled onboarding wizard leaves no… |
| `#52` | `medium` | `apps/cli/src/home/drive-home.test.ts:562` | No end-to-end test proves the onboarding wizard's chosen provider actually binds the first chat's model | A writeDefaultModel failure in onboarding leaves the exact anthropic-default mismatch the… |
| `#58` | `medium` | `apps/cli/src/render/tui/session-view-model.ts:318` | appendBounded's truncation slice can split a surrogate pair, corrupting live streamed text | The Intl.Segmenter grapheme-aware primitive built for ADR-0069's viewport never reached the… |
| `#63` | `medium` | `apps/cli/src/render/tui/chat-ink.tsx:1486` | No minimum-terminal-size guard on the live chat surface, unlike the idle Home strip | Home's idle strip degrades gracefully below 80x24 but ChatRegion/chat-ink.tsx never applies the… |
| `#64` | `medium` | `apps/cli/src/render/tui/viewport.ts:56` | Per-cluster call into string-width makes CJK/wide-script wrapping 2.5-6x slower than necessary | graphemeWidth calls the full string-width library per already-segmented cluster, and… |
| `#69` | `medium` | `apps/cli/src/process/output-mode.ts:20` | No TERM=dumb / non-ANSI-capable check before mounting the full-screen alt-screen ink app | detectOutputMode never checks TERM=dumb before mounting the full-screen alt-screen ink app |
| `#215` | `medium` | `apps/cli/src/render/tui/home-controller.ts:139` | Six mutually-exclusive overlay fields modeled as independent optionals, not a union | Six mutually-exclusive optional overlay fields with no type-level enforcement is a real… |
| `#220` | `medium` | `apps/cli/src/commands/chat.ts:1` | chat.ts is a 2,364-line file mixing five distinct concerns with no module split | chat.ts mixes REPL loop, reseat-rebuild, alt-screen orchestration, and printer construction in… |
| `#243` | `medium` | `apps/cli/src/render/tui/home-controller.ts:270` | createHomeController is a single ~1,290-line function, by far the largest in the repo | Six mutually-exclusive optional overlay fields with no type-level enforcement is a real… |
| `#308` | `medium` | `packages/core/src/tools/registry.ts:292` | git_commit's chat denial message asks the user to do something chat structurally cannot do | The chat-side git_commit denial message asks the user to satisfy a human_gate that chat… |
| `#309` | `medium` | `apps/cli/src/commands/specs.ts:131` | chat-resume/chat-list/chat-export break the CLI's own noun-verb subcommand convention | chat-resume/chat-list/chat-export break the CLI's own noun-verb subcommand convention used… |
| `G4` | `medium` | `apps/cli/src/render/tui/input-history.ts:23` | InputHistory.entries has no upper bound, unlike every sibling buffer in this directory | InputHistory.entries has no cap, unlike every sibling buffer in the same directory |
| `G40` | `medium` | `apps/cli/src/render/tui/prompt-cursor.ts:39` | promptRows widens the cursor cell for one surrogate pair, never a full grapheme cluster | The Intl.Segmenter grapheme-aware primitive built for ADR-0069's viewport never reached the… |
| `G41` | `medium` | `apps/cli/src/render/tui/prompt-view.tsx:1` | PromptEditor, PaletteView, and ReverseSearchView are never mounted by any test in the repo | PromptEditor/PaletteView/ReverseSearchView/MentionView/EffortTierList are never mounted by any… |
| `G51` | `medium` | `apps/cli/src/render/tui/prompt-cursor.ts:39` | Cursor width is per code point, not grapheme cluster — splits flag emoji/ZWJ sequences | The Intl.Segmenter grapheme-aware primitive built for ADR-0069's viewport never reached the… |
| `#53` | `low` | `apps/cli/src/onboarding/wizard.ts:68` | The onboarding wizard never receives the CLI's own --color/--no-color decision | deps.global.color is threaded into RootApp but never into the onboarding wizard, so --no-color… |
| `#55` | `low` | `apps/cli/src/onboarding/wizard.ts:122` | A permanently-locked/unavailable OS keychain re-runs the full wizard on every single launch with no opt-out | A permanently-locked keychain re-runs the full interactive wizard on every launch with no… |
| `#60` | `low` | `apps/cli/src/render/tui/model-picker-view.tsx:96` | Windowed pickers give no indication that more entries exist beyond the visible window | Windowed model/mention pickers give no N of M or scroll indicator when truncated |
| `#66` | `low` | `apps/cli/src/render/tui/chat-projection.ts:273` | Single-slot-per-entry wrap cache is fully invalidated on every resize tick, not just the final size | graphemeWidth calls the full string-width library per already-segmented cluster, and… |
| `#244` | `low` | `apps/cli/src/commands/chat.ts:1012` | createChatLineHandler is a single ~425-line function | chat.ts mixes REPL loop, reseat-rebuild, alt-screen orchestration, and printer construction in… |
| `#311` | `low` | `apps/cli/src/commands/dispatch.ts:648` | The dispatch fallback "unknown command." never echoes the attempted command or offers a hint | The dispatch fallback never echoes the attempted command id or offers a hint, by explicit design |
| `G5` | `low` | `apps/cli/src/render/tui/chat-store.ts:225` | requestApproval has no guard against a second concurrent call orphaning the first | requestApproval documents a single-pending-approval invariant but doesn't enforce it |
| `G52` | `low` | `apps/cli/src/render/tui/palette-view.tsx:29` | Palette query renders plain-dim, unlike the cyan+bold treatment sibling overlays use | Palette query renders plain-dim while the sibling mention/reverse-search overlays use cyan+bold… |
| `G53` | `low` | `apps/cli/src/render/tui/palette-view.tsx:1` | Four overlays claim injection-safe sanitization but none is ever rendered by a test | PromptEditor/PaletteView/ReverseSearchView/MentionView/EffortTierList are never mounted by any… |
| `#61` | `polish` | `apps/cli/src/render/tui/viewport.ts:218` | Alt-screen transcript char-wraps while inline transcript word-wraps — divergent row shapes | Alt-screen char-wraps while inline word-wraps, a known deliberate deferral the finding asks to… |

#### Routed into the active Phase 2.6 — these land in that phase's own workstreams, not in this file

| Finding | Severity | Location | Issue | Lands in | Work item |
|---|---|---|---|---|---|
| `#88` | `high` | `packages/core/src/validate-catalog.ts:65` | D15 catalog load-check only fires on a node-level model override — dead for the normal pattern | `2.6.A` | nodeCatalogIssue only reads a node-level model override, never the resolved agent's own model… |
| `G29` | `high` | `apps/cli/src/engine/tool-host/assemble.ts:94` | http_request/web_search/os tools permanently unavailable in relavium run, undocumented | `2.6.A` | Add a run-path pre-flight check for tools that require the unwired egress/os host arms, and… |
| `#229` | `high` | `packages/core/src/engine/engine.ts:2407` | engine.reconcile() (settles a dead run to run:failed) is never called anywhere in apps/cli | `2.6.G` | Wire engine.reconcile() into apps/cli so a killed/crashed run settles instead of staying… |
| `#118` | `high` | `packages/db/src/run-history-store.ts:344` | A failed run's total_cost_microcents can silently undercount post-last-node spend | `2.6.H` | A failed/cancelled run's persisted total_cost_microcents silently undercounts spend incurred… |
| `#277` | `high` | `apps/cli/src/home/home-store.ts:133` | A single corrupted run_events row crashes the entire bare-invocation Home with a generic message | `2.6.H` | A single corrupted history.db event row crashes both bare-invocation Home and relavium logs via… |
| `#0` | `high` | `apps/cli/src/gate/decision.ts:77` | Gate resolution flags build a decision with no check against the pending gate's gateType | `2.6.K` | Validate --approve/--reject/--input against the pending gate's gateType before resume |
| `#68` | `high` | `apps/cli/src/render/tui/home-view.tsx:145` | `bold` ANSI styling is never gated by the `color`/NO_COLOR flag, unlike every other style prop | `2.6.L` | Close five NO_COLOR/ASCII-degrade gating gaps in the render layer: unconditional bold, missing… |
| `#305` | `high` | `packages/core/src/tools/builtins.ts:178` | write_file approval/result never shows content — blind in every mode, silent in auto | `2.6.M` | write_file's approval flow has no content diff/preview, no post-write trace, and is silent in… |
| `#2` | `medium` | `apps/cli/src/authoring/authoring.ts:75` | create/import/export validate schema only, never the catalog pre-flight relavium run enforces | `2.6.A` | Back-port validateAuthoredWorkflow (parse + catalog validation) into create/import/export |
| `#37` | `medium` | `apps/cli/src/engine/build-engine.ts:87` | No pre-flight check that a workflow's granted tools are servable on the run-path host | `2.6.A` | Add a run-path pre-flight check for tools that require the unwired egress/os host arms, and… |
| `#114` | `medium` | `packages/db/src/run-history-store.ts:220` | applyDerived's RunEvent switch has no exhaustiveness guard, unlike engine.ts's identical pattern | `2.6.H` | Add a const-exhaustive: never guard to run-history-store.ts's applyDerived RunEvent switch |
| `#232` | `medium` | `packages/db/src/run-history-store.ts:344` | A failed run's persisted total cost undercounts spend incurred after the last completed node | `2.6.H` | A failed/cancelled run's persisted total_cost_microcents silently undercounts spend incurred… |
| `#282` | `medium` | `packages/db/src/run-history-store.ts:534` | loadRunEvents (used by relavium logs) has the same unguarded parse as loadRunStateEvents | `2.6.H` | A single corrupted history.db event row crashes both bare-invocation Home and relavium logs via… |
| `G12` | `medium` | `apps/cli/src/commands/status.ts:43` | status.ts N+1s the full token-event firehose per active run | `2.6.H` | Batch loadRunEvents across gate list and status instead of one query per run |
| `G30` | `medium` | `apps/cli/src/engine/tool-host/assemble.ts:116` | http_request advertised in chat with no config path to ever succeed | `2.6.M` | http_request is advertised to chat agents with zero config path to ever populate… |
| `#6` | `low` | `apps/cli/src/authoring/authoring.ts:1` | authoring.ts's 365-line core has no direct unit test file | `2.6.A` | Add direct unit tests for detectAndParse / buildAuthored / validateAuthoredWorkflow |
| `#5` | `low` | `apps/cli/src/authoring/create-prompter.ts:85` | Wizard text answers are validated but not trimmed before being written into the scaffolded YAML | `2.6.B` | Onboarding wizard TTY prompts do not trim whitespace from typed input |
| `#273` | `low` | `apps/cli/src/commands/gate-list.ts:40` | relavium gate list N+1s loadRunEvents across every paused run instead of one batched query | `2.6.H` | Batch loadRunEvents across gate list and status instead of one query per run |
| `#9` | `low` | `apps/cli/src/chat/doctor.ts:134` | /doctor's status glyphs bypass the codebase's own NO_COLOR/ASCII-fallback contract | `2.6.L` | relavium doctor glyph constants have no ASCII fallback under NO_COLOR |
| `#59` | `low` | `apps/cli/src/render/tui/attachment-bar.tsx:21` | Attachment bar's paperclip emoji breaks the monochrome-glyph convention and ignores --no-color | `2.6.L` | Close five NO_COLOR/ASCII-degrade gating gaps in the render layer: unconditional bold, missing… |
| `#70` | `low` | `apps/cli/src/render/tui/format.ts:24` | Status/warning glyphs are Unicode-only with no NO_COLOR-driven ASCII fallback, unlike the banner | `2.6.L` | Close five NO_COLOR/ASCII-degrade gating gaps in the render layer: unconditional bold, missing… |
| `#71` | `low` | `apps/cli/src/render/tui/attachment-bar.tsx:21` | Pictographic emoji contradicts the render layer's own documented 'no pictographic emoji' rule | `2.6.L` | Close five NO_COLOR/ASCII-degrade gating gaps in the render layer: unconditional bold, missing… |
| `#72` | `low` | `apps/cli/src/process/options.ts:209` | NO_COLOR='' is treated as absent, diverging from the 'present regardless of value' contract | `2.6.L` | Close five NO_COLOR/ASCII-degrade gating gaps in the render layer: unconditional bold, missing… |
| `#73` | `low` | `apps/cli/src/render/tui/session-view-model.ts:576` | Number/date formatting is hand-rolled and locale-hardcoded instead of using the available Intl APIs | `2.6.L` | Fold three i18n-scoping findings into 2.6.L's design inputs: hand-rolled Intl formatting… |
| `#261` | `polish` | `apps/cli/src/onboarding/wizard.ts:138` | Onboarding wizard strings are 100% inline English literals with no i18n indirection point | `2.6.L` | Fold three i18n-scoping findings into 2.6.L's design inputs: hand-rolled Intl formatting… |
| `#262` | `polish` | `packages/shared/src/config.ts:173` | `preferences.language` key does not exist; only `preferences.theme` is schema-present-but-unread | `2.6.L` | Fold three i18n-scoping findings into 2.6.L's design inputs: hand-rolled Intl formatting… |
| `#263` | `polish` | `apps/cli/src/render/tui/model-picker.ts:349` | Cost formatting hardcodes `$` + period-decimal with no locale abstraction point | `2.6.L` | Fold three i18n-scoping findings into 2.6.L's design inputs: hand-rolled Intl formatting… |

#### deferred-tasks — Recorded in deferred-tasks.md (deliberately unscheduled)

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#7` | `high` | `apps/cli/src/chat/agent-source.ts:47` | relavium chat --agent <bad-file> collapses a rich AgentParseError into a useless generic message | AgentParseError invisible on chat --agent / agent run (already tracked, →2.6.B) |
| `#8` | `high` | `apps/cli/src/chat/persister.ts:80` | A hard process crash mid-turn silently loses the user's message with zero durable trace | Chat persister / session-store writes are non-atomic across… |
| `#185` | `high` | `packages/llm/src/conformance/spec.ts:221` | Conformance suite never exercises a stream that ends without a terminal `stop` chunk | Reported spend systematically under-estimates the provider's invoice when a stream ends without… |
| `#290` | `high` | `.github/workflows/ci.yml:275` | Nightly live-provider conformance never runs — no cron, no script, aspirational docs | Live-nightly LLM conformance lane is unimplemented (already tracked, CI/Tooling) |
| `#306` | `high` | `apps/cli/src/chat/agent-source.ts:26` | Malformed --agent YAML degrades to a generic exit-1 error, not the field-named parse diagnostic | AgentParseError invisible on chat --agent / agent run (already tracked, →2.6.B) |
| `#169` | `medium` | `packages/llm/src/adapters/openai.ts:1202` | A custom OpenAI-compatible endpoint that omits the usage chunk reports a fully-successful stream as $0 cost | Reported spend systematically under-estimates the provider's invoice when a stream ends without… |
| `#193` | `medium` | `packages/llm/src/fallback-chain.ts:526` | Committed mid-stream failure records zero cost for tokens the provider almost certainly billed | Reported spend systematically under-estimates the provider's invoice when a stream ends without… |
| `#200` | `medium` | `packages/mcp/src/manager.ts:109` | Cancellation signal dropped at McpCapability — Esc can't stop an in-flight tools/call | MCP mid-call abort/cancellation and per-call timeout are not wired through packages/mcp… |
| `#223` | `medium` | `packages/core/src/engine/agent-turn.ts:548` | Esc (mid-turn abort) does not actually stop an in-flight MCP tool call | MCP mid-call abort/cancellation and per-call timeout are not wired through packages/mcp… |
| `#231` | `medium` | `apps/cli/src/commands/gate.ts:176` | Gate timeout is not re-armed against a real clock after a crash-while-paused resume | Gate timeout re-arm on rehydration — ✅ closed in 2.6.5 `CR-22` (2026-08-27) |
| `#287` | `medium` | `apps/cli/src/engine/mcp-servers.ts:259` | MCP network transports lack DNS-rebind protection past pre-connect check | MCP network transports (WebSocket/SSE) are vulnerable to DNS rebinding past the one-time… |
| `#10` | `low` | `apps/cli/src/chat/chat-mode.ts:219` | An accept-edits 'always' grant is scoped to the tool id only, silently covering every future target | The chat-mode accept-edits 'always' grant is scoped to tool-id only, not target (already… |
| `#179` | `low` | `packages/llm/src/budget-estimator.ts:11` | 'Conservative' pre-egress estimate ignores input cost, which is optimistic on input-heavy turns | estimateMaxNextCost ignores input-side cost, unsafe for input-heavy turns (already tracked… |
| `#233` | `low` | `packages/db/src/session-store.ts:356` | appendMessage/createSession/updateSession lack the busy-retry wrapping recordSessionCost gets | Chat persister / session-store writes are non-atomic across… |
| `#292` | `low` | `packages/llm/src/fallback-chain.test.ts:984` | Test suite pins the known cost-under-reporting bug as the CORRECT, asserted behavior | Annotate the cost-underreporting pinning test as a KNOWN GAP, not a deliberate contract… |
| `#295` | `low` | `packages/core/src/engine/engine.test.ts:1829` | Crash-resume gate-timeout re-arming has no implementation or test — deadlines lost on restart | Gate timeout re-arm on rehydration — ✅ closed in 2.6.5 `CR-22` (2026-08-27) |

#### no-action — Consciously declined — see deferred-tasks.md for the reasoning

| Finding | Severity | Location | Issue | Work item |
|---|---|---|---|---|
| `#67` | `polish` | `apps/cli/src/render/alt-screen.ts:88` | Strength: idempotent, latch-after-success alt-screen restore is a well-designed exit-safety primitive | Alt-screen restore()'s idempotent latch-after-success design is a verified strength, not a… |
| `#84` | `polish` | `packages/core/src/expression/sandbox.ts:219` | Math.random neutralization has an over-narrow fallback re-check | Sandbox Math.random fallback narrowness is an accepted, tested defense-in-depth residual — no… |
| `#245` | `polish` | `packages/db/src/media-write.ts:1` | Static analysis (knip) inventory of low-confidence unused exports across the monorepo, for triage | The full-repo knip dead-export inventory needs no further action beyond the two items it… |

### Checked and cleared — not scheduled (4)

Raised by a reviewer, then disproved by both verifiers reading the code. Recorded so the same ground is not re-covered.

| Finding | Location | Claim that did not hold |
|---|---|---|
| `#249` | `pnpm-workspace.yaml:8` | Complete runtime-dependency to authorizing-ADR inventory (audit trail) |
| `#286` | `packages/llm/src/llm-error.ts:123` | LlmError.cause is fully specified but never populated by any shipped adapter |
| `#289` | `apps/cli/src/engine/tool-host/fs.ts:668` | Windows parent-dir swap race on write is a documented residual, sign-off unverified |
| `#319` | `eslint.config.mjs:246` | Engine-purity test exclusion doesn't match its own documented rationale for a benchmark file convention |

---

## Wave 2 preflight and proposed execution plan — 2026-10-12

> Current disposition — 2026-10-15: all eight steps and review corrections merged to `main` as PR #94; the [merge checkpoint](#wave-2-merge-checkpoint--2026-10-15) controls current completion. The dated preflight/checkpoint states below remain historical.

**Status: maintainer approved ADR-0105–0108 and the eight-step plan on 2026-10-12.
Steps 1–6 are accepted after independent cumulative reviews and required gates; Step 7 proceeds.**
Inspection baseline is `development` at `aaed7d593d72ea414b1fae42ddf20e148a5fce0f`.
This is the joint Phase 2.5.5/2.6 Wave 2, not the closed core reliability W2/W8.
All work stays on `development`. Detailed independent reports remain local/ignored;
this section records concise scope, decisions, evidence and remaining gates.

### Document and source reconciliation

Three independent preflight streams examined filesystem authority, secrets/config
and persistence/certification. Relevant ADRs were checked with their later dated
qualifications: 0003/0006/0019/0026/0027/0029/0031/0033/0037/0042–0044/0048–0050/
0055/0057/0060/0061/0063/0065/0080/0083/0084/0088/0089/0095/0098/0102.
The controlling references are the existing config, workflow, agent-session and
SSE contracts; built-in tools, provider seam, database schema and MCP integration;
CLI commands/agent fixtures and keychain/secrets. Architecture/security, TypeScript,
testing, error-handling, documentation and commit standards control the implementation.
Phase files own scope/acceptance; current.md owns ordering. This is a task-relevant
audit, not a new claim to certify every historical ADR or every filesystem import.

The following table records the preflight state before implementation. The later [Step 2 checkpoint](#step-2-implementation-checkpoint--2026-10-12) qualifies its filesystem/env/CAS rows without relabeling historical evidence.

| Queue | Current disposition and action |
|---|---|
| Wave 2 items 1–2, G19/#202 and hostile MCP queue | Already closed in W4/PR #87. Reuse its accepted register/sitting and rerun direct regressions at final head; do not rebuild consent/transports. |
| #36/#39 | Open. Cloud credential paths and overrides are missing. The env list already lives in shared under ADR-0084; expand that authority rather than the obsolete process-local list. |
| #235, 2.6.M extra roots, 2.6.N floor, G21 | Open. Share the injected ancestor algorithm; implement host-granted roots/general floor and remove dead tmp provisioning under ADR-0105. Full child/artifact lifecycle stays with 2.6.N. |
| Catalog #1 | Open. Native containment/regular-file admission must precede reading either catalog kind; preserve contained symlinks. |
| #27/#31/#293/#25 | Open/partly covered. Test native bridge failures, stop opaque native error-message leakage, retain verbatim reader semantics, cap bytes, reject secret argv and provide approved stdin delivery. |
| #30/#196 | Open. Warn on suspicious authored literals without mutating admitted snapshots; broaden query-name redaction with benign-name controls. Existing snapshot sensitivity documentation is partial, not absent. |
| #113/#111/#108/#112/#107/#109/#110 | Open. Native probes reproduce drive-relative acceptance, ignored abort and oversize puts; CAS shard symlink also escapes physically. ADR-0105/0106 own the combined correction. |
| #81/#115 and D14/D15 | W7's strict session rows and producer→SQLite→export fixtures subsume raw model-issued tool masking. No raw tool-result opt-in is permitted. Certify actual fixtures and retained user-data limits; do not invent universal masking. |
| #80/#83 | Open. Add an explicit continuity/review notice and deterministic ASCII normalization with session-identity fallback, preserving scaffold semantics and machine stdout. |
| G22 | Open. Refuse unsupported direct `secrets.*` context references at parse; retain permitted secret-input context propagation and transitive text-sink checks. Do not accept Proposed ADR-0060 as a side effect. |
| G20/D13 | Design/admission gate in Wave 2 under ADR-0108; live header activation remains outside the original phase, prohibited until keychain custody and legacy recovery are implemented. Historical sensitive rows are not silently erased. |
| G31 | File/reconcile the existing nonabortable native DNS background-work follow-up in deferred-tasks.md. Current caller cancellation/normalization and late-connect guards already ship; this task does not build a resolver or invent a new deferral. |

Preflight ran **12 focused files / 277 tests**, all passing, and four synthetic native
probes reproduced the named media/path gaps. These are baseline findings, not
fixed-code controls or whole-wave acceptance. No credentials, real user history,
provider requests, paid captures or production storage were used.

The required ordinary CI for existing docs PR #93 is red in native DB process tests;
the unchanged focused file passes **8/8** with `CI=true`. An independent actual-worker
probe confirms the readiness timer kills an already-ready child after its spawn
deadline. Separate pre-readiness CI starvation is suspected, not proved. Repair timer
ownership and measure worker scheduling before treating the baseline as green;
retries, skipped native tests and arbitrary timeout increases are not acceptance.

### Decisions presented together before implementation

| Decision | Approved ruling / authority |
|---|---|
| Root authority / D12 | [ADR-0105](../../decisions/0105-filesystem-roots-are-invocation-grants-not-project-authority.md): invocation-only `--allow-fs-root`, config selectors bounded by grants, resume reauthorization, general scratch descriptor/floor. Remove unused tmp creation; do not build child agents or a grant database. |
| Media limits / verification / lifecycle | [ADR-0106](../../decisions/0106-media-publication-requires-bounded-verified-bytes.md): inline/25 MiB write and opened-fd read bounds; finite formats including current AAC/Opus/PCM, with raw PCM's structural-only evidence disclosed; required store validation and atomic metadata admission before durable append; host-hook compatibility change; recoverable ownership-aware 24-hour temp GC and explicit legacy offline maintenance. No total progressing-download timeout or runtime dependency. |
| First-run secrets | [ADR-0107](../../decisions/0107-first-run-secret-inputs-use-bounded-stdin.md): `run --secret-inputs-stdin`, explicit TTY refusal, shared gate parser, 64 KiB aggregate byte cap, verbatim values, noninteractive approval policy after consumption. |
| Provider headers / D13 | [ADR-0108](../../decisions/0108-provider-headers-stay-gated-until-keychain-custody.md): reject all new nonempty maps, omission preserves legacy, `{}` clears, no wire consumption; keychain refs and legacy recovery are mandatory before future activation. |
| Export / D14 | Existing ADR-0095 governs: content-free model-tool structure, no `--include-tool-results`. Add continuity/review notice. Approved slug refinement: NFKD/combining-mark normalization, Turkish dotless i and German sharp-s mappings, legal ASCII title slug; otherwise `exported-session-<session-id>`. Do not promise universal transliteration or change conversational memory. |
| Missing Wave D15 / #115 | Reconcile with existing ADR-0095/0098 fixtures and explicit user/assistant/@/! retained-content limits. No new masking or historical scrub policy. This D15 is distinct from historical media decisions with the same number. |
| Snapshot lint and G22 | Value-free bounded best-effort warning at create/import/run; preserve faithful augmented snapshot and JSON stdout. G22 narrows only the unsupported namespace gap; legitimate input-secret propagation remains. |
| Review organisation / D17 | Four new security sittings by fs/path-jail, secrets-at-rest, secrets-input, config-trust; reuse W4's hostile-MCP sitting. Each implementation step has independent cumulative review cycles as below. |

No billing, provider capture, keychain credential, new runtime dependency, deferred
core-reliability feature or user-managed secret is needed for this work. Approval of
the proposals does not certify that their implementations already satisfy them.

### Execution steps after approval

| Step | Scope / primary owners | Meaningful acceptance before review |
|---|---|---|
| 1 | Clean baseline: DB worker readiness/lifetime separation and measured native-suite scheduling | Actual child survives the obsolete readiness callback after LOCKED, RELEASE exits normally; no-barrier timeout still rejects/kills/joins. Full ordinary CI and its native/causal inventories stay complete. |
| 2 | Unified fs changeset: shared helper/env policy; CLI roots/floor/catalog; DB save_to/CAS containment | Native outside-I/O controls, lexical/canonical aliases, no protected descent, actual flag/config/session/resume forwarding and platform gates; approve ADR-0105 first. Keep one cumulative security review scope across these consumers. |
| 3 | Secrets foundation: OS bridge tests/safe diagnostics, bounded reader, scrub query names | Mock native failures without real keychain, opaque-error sentinel absence, exact/+1 byte bounds and release, Unicode/whitespace preservation, broad names with benign negatives. |
| 4 | First-run secret input transport and argv refusal | Commander→dispatch→engine/native history evidence, zero preflight side effects on bad input, masked persistence, later-gate/MCP noninteractive behaviour; ADR-0107. |
| 5 | Snapshot lint/docs, narrow context analysis and export completion; G31 filing | Faithful snapshot/resume identity, value-free authoring warnings, retained credential-context positive control, strict legacy tool refusal, continuity notices and deterministic valid IDs. Correct remaining caller-supplied-input/reader-trimming/storage doc drift and reconcile the existing DNS residual. |
| 6 | Media bounds, type evidence, mandatory descriptor/metadata admission, cancellation and temp ownership/maintenance | Independent byte fixtures and actual engine→admission→append→reference controls, handle-only/same-hash conflicts, existing provider audio compatibility, old-layout read bounds, real producer/sweeper crashes and live-writer controls, bounded streaming, CLI maintenance scope/JSON output; ADR-0106. |
| 7 | Provider-header interim gate, typed refusal and dormant-wire/public projections | Real legacy-row preservation/explicit clear, zero plaintext new admission, canonical store/error contract, actual SDK request omits old header and human/JSON/diagnostic projections omit header sentinels while trusted get/list retains legacy data; ADR-0108. |
| 8 | Whole-wave security certification, canonical landing and publication | Full required CI/coverage/build, mechanism-removal evidence, all four new threat sittings, W4 revalidation, every Wave 2 ID disposition and exit criteria 1–3 / D sign-off at the exact reviewed head. |

For **each step**: implement meaningful permanent controls, run affected and required
gates, commit, then start independent cumulative reviewers (critical security paths:
Codex Astra/high; contract/tooling reviews: Codex Sol/high, adjusted to complexity).
Validate findings against actual code/evidence, fix and commit them, then use **new
reviewers**. Finish with two new clean complete cumulative rounds after the last
material correction; a failed round is evidence to address, not an acceptance round.
Proceed automatically to the next approved step. No forced review-file tracking,
unchecked findings, speculative deferral or skipped required check counts as closure.

Update canonical homes in the step that changes them; append dated ADR refinements
without rewriting old bodies. Keep this register concise. The final certificate does
not close all Phase 2.5.5 A–I, the later joint Waves 3–7 or approved CR deferrals.
Existing open docs PR #93 must be reconciled before publishing a separate Wave 2 PR
from the same `development` branch; local implementation does not require switching
branches or silently repurposing that PR.

### Proposal review checkpoint — 2026-10-12

The first independent proposal round covered filesystem authority, media lifecycle,
and secrets/config plus whole-plan traceability. Confirmed corrections are incorporated:

- ADR-0105 distinguishes early invocation-grant validation from resumed selectors
  that require an existing-history read; Windows cross-volume results use canonical
  absolute paths where a workspace-relative path cannot represent the target.
- ADR-0106 admits every handle occurrence before deduplication, separates mandatory
  byte/tuple admission from best-effort post-append retention, preserves existing
  AAC/Opus/PCM output paths with explicit PCM evidence limits, bounds legacy fd reads,
  requires positive audio/video durations and recovers dead-sweeper claims.
- G20 now distinguishes shipped custom base URLs from dormant header consumption;
  G31 is routed to the existing DNS background-resource entry. Living export/input/
  at-rest text and historical fallback-status notes are reconciled with shipped code.

These are proposal corrections, not implementation acceptance. New independent
cumulative filesystem and media/CAS rounds found no material findings in the revised
decisions. The second secrets/document round identified two documentation errors
(ADR-0095 link filenames and the old unqualified “Required ADRs: None”); both were
corrected. A further **new complete cumulative** secrets/document round found no
material findings. The revised package is ready for maintainer consideration; those
reviews do not grant approval or certify unimplemented runtime behaviour.

Checks at that proposal checkpoint covered **12 changed/new Markdown files, 699
relative links and anchors, with no findings**; `git diff --check` passed. Detailed reports stay
local/ignored; no full CI or new security sitting is claimed. The working tree
contains documentation changes only, with no Wave 2 source implementation or commit.

### Maintainer proposal review corrections — 2026-10-12

The maintainer's ten-comment review was checked against actual input masking,
provider-store writers/projections, stdin handling, shared media constants and the
planned child-session artifact owner. At that checkpoint the proposals were **Proposed**; this is a
source/document correction record, not approval or implementation acceptance.

| Comment | Disposition in the revised proposal package |
|---|---|
| 1 — argv/history | ADR-0107 names argv, shell history and CI command logs. Declared secret-input slots already persist as masked references; unrelated authored literals remain #30. |
| 2 — alleged header writers | ADR-0108 no longer assumes existing embedding callers. Current nonempty-map writers in the tree are fixtures; the exported-API tightening can affect potential external callers. |
| 3 — typed-error home | ADR-0108 names the proposed ProviderHeaderPolicyError and @relavium/db structural guard. The existing database reference's llm_providers section will own admission, discriminant and projection details in Step 7; no implemented error/spec is claimed. |
| 4 — ancestor-helper owner | ADR-0105 explicitly owns the platform-free helper in packages/shared, with Node operations in CLI/DB and the host/tool contract in the built-in-tools reference. |
| 5 — Related ADRs | ADR-0105 links ADR-0054 for bare Home and ADR-0083 for existing resume-identity context; it does not transfer workflow identity semantics to chat. |
| 6 — existing versus new media bounds | ADR-0106 distinguishes existing seam-inline/download constants from the new independent put/putStream store guards. |
| 7 — TTY stdin | ADR-0107 explicitly requires the new run flag to refuse TTY stdin before reading/composition, even when stdout is redirected, with a non-TTY positive control. Provider/gate consumers retain the shared reader's TTY refusal without prohibiting gate resume's necessary prior history lookup. |
| 8 — header-output evidence | ADR-0108 adds actual human/JSON/error/verbose projection controls with a seeded legacy sentinel and a causal unsafe-projection control; trusted store get/list preservation is separately pinned. |
| 9 — future scratch owner | ADR-0105 names Phase 2.6.N's CLI artifact-store host as the planned consumer and owner of provisioning/isolation/join/cleanup/recovery. Wave 2 implements the pulled-forward floor prerequisite only. |
| 10 — navigation | Both anchors exist: Next work is the live status entry; Wave 2 is the detailed queue. ADR-0105 and the agent guides now enter via the status heading, which explicitly links the queue. No broken anchor was found. |

Two NEW independent complete cumulative proposal reviews checked all four revised
ADRs, the eight-step plan and the ten dispositions against controlling source and
contracts; neither reported a new material finding. Final documentation checks cover
**14 changed/new Markdown files and 789 relative links and anchors, with no findings**;
`git diff --check`, Proposed/index consistency and Accepted-ADR append-only checks pass.
Detailed reports remain local. These are proposal checks, not implementation or
security acceptance. No runtime source, paid/provider call, keychain access or
implementation commit is part of this intake.

### Step 1 implementation checkpoint — 2026-10-12

The native DB worker's five-second deadline now owns **readiness only**: a real
`CUT`/`LOCKED` barrier disarms it, and an already-queued obsolete callback cannot
kill a ready child. Each test retains ownership of post-barrier release/kill/join.
Two permanent native controls cover obsolete-callback survival through `RELEASE`
and a loaded-but-unready worker's rejection, kill and joined close. Removing the
disarm or the late-callback state guard independently makes the survival regression
fail at its intended assertion; both source mutations were restored byte-for-byte.

The acceptance auditor recognises exactly one declared no-readiness control, with
the ordered `spawn → WAITING → timeout → SIGKILL close` lifecycle. Every ordinary
child still requires its real barrier and every child retains physical source/PID
witnesses. Inventory is now **429 cases / 71 joined native children**, with exactly
one timeout control; the watchdog derives from this inventory without changing the
five-second readiness or twenty-second native-case deadlines. The first full run
correctly refused the new no-barrier control under the old universal-barrier rule;
the narrowly specified auditor correction and its negative tests address that result.

Corrected `CI=true pnpm run ci` passed: ordinary suites **511 files / 11,028 passed /
12 existing skips**, lint/typecheck/build/format, isolation/fence/dependency/schema/
bundle checks, all three offline smokes, **60 tool-acceptance tests**, four wire
mutation controls, **23 usage mechanism controls** and the complete **429-case**
native/scale cohort. That instrumented cohort measured the nine DB readiness
barriers at **823–976 ms** locally. This does not establish the cause of the earlier
Ubuntu pre-readiness failures or claim a new published-head GitHub result. No retry,
skip, scheduling relaxation, provider call or real user storage was introduced.

Implementation is ready for two new independent complete cumulative review rounds;
Step 1 and whole-wave acceptance are not yet claimed. Raw reports remain local.

#### Step 1 first review correction — 2026-10-12

Two independent complete cumulative reviewers corroborated one High finding in the
new controls: their capture-only scheduler replaced the actual readiness timer.
A withheld-startup native probe survived Vitest's twenty-second timeout without
entering the test's `finally`. The initial green run did not exercise that failure.
The helper now always arms its real five-second timer; tests can only observe it
and invoke an obsolete callback, never substitute its arming/cancellation. The
no-readiness control waits for actual expiry. The same withheld-startup probe now
rejects, kills, joins and completes cleanup in approximately five seconds; focused
native tests pass **10/10**. These finding-bearing reviews do not count as clean
acceptance rounds. Required gates and new complete cumulative reviews follow.

Post-correction `CI=true pnpm run ci` passed with the same complete ordinary and
causal inventories: **60 tool tests**, four wire controls, **23 usage controls**,
**429 permanent cases / 71 joined children / one timeout control**. The complete
instrumented cohort records actual timeout at **5,001 ms** and joined SIGKILL close
at **5,016 ms**. Both mechanism-removal regressions were rerun and failed at their
intended assertions before byte-exact restoration. Documentation checks cover the
complete cumulative change, including the separate CR-81/CR-82 merge-status commit:
**16 Markdown files / 1,096 relative links and anchors / no findings**. New complete
cumulative review rounds remain the next acceptance gate.

The next complete cumulative review round found no implementation or evidence
defect and identified one Low living-status inconsistency: the G20/D13 task still
advertised ADR-0108 approval as pending. Its current task wording now records the
obtained approval and Step 7 implementation gate; the adjacent ADR-0107 task also
states its approved Step 4 gate. Fresh complete cumulative clean rounds follow
this documentation correction; neither finding-bearing round is counted as clean.

### Step 1 acceptance — 2026-10-12

Two NEW independent complete cumulative rounds, each with separate lifecycle and
auditor reviewers, found **zero findings** after the last correction. Both covered
all **21 changed paths** from inspection baseline `aaed7d59` through reviewed head
`8c13675f`, including the decision package, native worker, acceptance tools and
documentation. Finding-bearing rounds 1–2 do not count as clean; rounds 3–4 do.
Step 1 is **accepted**. Detailed reports remain local/ignored.

Required local CI passed with **511 ordinary files / 11,028 passes / 12 existing
skips**, **60 tool tests**, four wire controls, **23 usage mechanisms** and **429
permanent cases / 71 joined native children / one actual readiness timeout**.
Reviewers independently matched all **1,010 physical source files** to retained
execution evidence and rechecked the intended semantic removal failures. Focused
native tests pass **10/10**, workload controls **3/3**, and cumulative documentation
checks cover **16 Markdown files / 1,096 relative links and anchors / no findings**.

The retained full run captured `56bdba93` plus the then-working-tree source fix;
physical byte matching supports the reviewed implementation. It is not execution
at the later committed head or new published GitHub evidence. The original Ubuntu
pre-readiness starvation cause remains unproved. Native Windows gates, subsequent
steps, four new security sittings and exact-head publication remain open.

### Step 2 implementation checkpoint — 2026-10-12

The current `development` changeset implements invocation-root admission, project-over-workspace narrowing selectors, original-canonical-workspace chat resume with fresh grants/current config, and the shared immutable policy used by clear/reseat and file/discovery consumers. It adds lexical/canonical credential floors and shared declared-env overrides, the injected ancestor resolver for tool fs/native `save_to`, catalog admission and physical CAS containment.

[Canonical tool contracts](../../reference/shared-core/built-in-tools.md#filesystem-permission-tiers), [CLI options](../../reference/cli/commands.md#global-options), [selectors](../../reference/contracts/config-spec.md#chat-filesystem-root-selectors) and [session authority](../../reference/cli/chat-session.md#filesystem-authority-and-resume) describe the implementation scope and owner-controlled-path assumptions. The dated forward notes in affected ADRs retain their historical text.

G21 removes unused automatic global tmp provisioning; existing directories are not deleted. The host-only exact private scratch descriptor/factory is a prerequisite, with POSIX private-directory checks and the existing Windows profile/ACL assumption. Ordinary chat has no production allocator; full 2.6.N isolation/join/cleanup/recovery remains open. These controls do not promise a hostile same-user parent-swap jail, race-free path checks or OS subprocess isolation.

Physical CAS containment is Step 2 only. Own `put` ceiling, bounded fd delivery, cancellation, descriptor/media admission and temp-age/live-writer maintenance remain Step 6/ADR-0106. Unified independent cumulative Step 2 review, native platform evidence and required gates remain pending. This checkpoint is not acceptance or closure of any Step 2 queue item.

**Pre-review verification:** full local `pnpm run ci` passes against `4668f65c` plus
the Step 2 working-tree implementation: 516 package test files, 11,174 passing tests,
11 established LLM capability skips and one Windows-only case on this macOS host.
Lint, typechecks, build/format, dependency/seam/isolation guards and three offline
smokes pass. Acceptance-tool guards pass 78/78; the four wire and 23 usage controls,
including 429 permanent native/scale cases, remain complete. The new filesystem
matrix passes all 20 fixed/red/restored mechanisms, with 1,020 assertion executions,
39 expected named failures, identical inventories and byte-exact restoration.
It checks current copied-source execution and unchanged developer/dependency bytes;
the compact matrix complements the ordinary all-operation native suites. These are
local results, not published exact-head or Windows evidence. Cumulative document
validation covers 36 Markdown files and 2,181 relative links/anchors with no findings.

**Publication dependency:** documentation PR #93 is now merged. The earlier plan's
open-PR warning is historical; Wave 2 will receive its own PR after implementation
and acceptance, without repurposing #93 or changing branches.

**First-review and platform corrections:** independent cumulative round 1 at
`fc097b2e` found a native cooperative CAS regression: same-hash atomic republishing
replaced an inode that readers incorrectly required the pathname to retain. Read
validation now separates the current physical path floor from the owned descriptor
and verifies that descriptor's bytes against the handle; temporary/destructive
ownership remains strict. Permanent native controls exercise both publication
methods against get, range and egress readers, plus planted-link and hash failures.
The round also identified a POSIX-only glob expectation in the Windows suite.
Published Windows execution additionally exposed case-sensitive raw-prefix
membership and the ignored Windows `O_NOFOLLOW`; native membership and an explicit
stable-entry check address those without claiming hostile same-user race isolation.
Test injection and result expectations use native path semantics. Linux published
filesystem, floor and coverage jobs shared one inode-reuse fixture failure: the
replacement control now retains the old directory and proves distinct identity.
The secure-default workspace check refuses sensitive lexical/canonical chat roots
before canonical persistence can erase their floor. Benign aliases remain supported;
no historical grant provenance or legacy repair is inferred. These corrections
still require fresh gates and two NEW complete clean cumulative rounds.

**Post-correction local verification:** `pnpm run ci` passes with **519 package
files / 11,205 passing tests / 13 skips** (11 established LLM capability cases and
two Windows-only cases on macOS). The build, lint/typechecks, format, dependency,
seam/isolation guards, three offline smokes and 78 acceptance-tool guards pass.
Four wire controls, 23 usage mechanisms and 429 permanent native/scale cases retain
their complete inventories. The expanded filesystem matrix passes **22 mechanisms,
1,062 assertion executions and 52 expected semantic failures**, with identical
fixed/red/restored inventories and byte-exact restoration. Its copied-source proof
covers 1,031 physical source files and 457 dependency packages; developer sources
remain unchanged. Execution records identify `fc097b2e` plus the correction working
tree, not a later committed head. The ordinary run preceded the final assertion
markers, two added filesystem mutation declarations and Windows-only test setup
refinement; focused tests and the expanded matrix verify those deltas. Published
native Windows and two NEW clean complete cumulative review rounds remain required.

**Second-round platform discovery:** published head `9d718981` passes the wire,
usage, filesystem causal and enforced-coverage jobs, but Windows native DB execution
fails 11 cases and Node 22.13 fails one cooperative CAS case. The Windows suite
fails before subsequent CLI checks, so no result is inferred for those. Independent
macOS review slices found no issue; the audit incorporates the published failure,
therefore this cumulative round is **not clean**. Linux reproduction using the actual
unchanged store confirms regular pathname-stat snapshots with `nlink=0` during atomic
replacement, including both publication admission and reads. An instrumented native
100-round workload reports 29 refusals before correction, all with that observed
snapshot, and zero across the same 3,000 operations after correction (Node 22.23.2;
not the exact Node 22.13 floor). Windows replacement contention now requires one
independent verified winner; owned temps and destructive checks remain strict.
Permanent deterministic controls cover both cases, and the forced-rename fixtures
distinguish actual replacement from native Windows refusal while closing owned fds.
Independent Windows checks now all execute after successful build even if another
suite fails, retaining failures without `continue-on-error`. New exact-head/platform
gates and two NEW complete clean cumulative rounds follow these corrections.

**Second-correction local gates:** ordinary lint/typecheck/test and build pass with
**521 package files / 11,229 passing tests / 13 established platform/capability skips**;
the full DB suite is 39 files / 713 passing tests. Tool lint, formatting, relative
documentation links and `git diff --check` pass. The expanded filesystem matrix
passes all **24 mechanisms** with complete fixed/red/restored inventories and
byte-exact restoration across 1,033 source files and 457 dependency packages.
The initial new Windows control correctly failed its workload but Vitest's promise
rejection diagnostic omitted the named assertion marker; settled-result assertions
now make that causal witness explicit. The successful rerun retains its own source
manifest (`9d718981` plus this correction working tree); no later-head execution is
inferred. The predecessor's required CI job also passed; its two native platform
failures remain historical failures, not waived acceptance. New published platform
execution and two NEW cumulative review rounds remain required.

**Third-round platform discovery:** exact-head execution at `962c6a54` passes the
Node 22.13 floor and 24-mechanism filesystem job. Windows runs every independent
check and exposes 25 CLI failures plus two DB fixture-count failures (repeated by
the focused CAS suite). Native CAS cooperation and its new production-branch
controls pass. The fixture count included a successful follow-up read; the initial
read is now counted before that recovery, with deterministic refusal controls.
CLI root admission mixed legacy synchronous short-name resolution with native
asynchronous long-name resolution. Native canonical roots and faithful fault-fixture
anchors correct that mismatch without widening authority. These are new corrections;
the otherwise clean scoped R3 reviews do not constitute a clean complete round.

**Third-correction local gates:** lint/typecheck/test and build pass with **522
files / 11,235 passing tests / 13 established skips**. DB's 39 files / 717 tests
include four new deterministic fixture-order controls. Tool lint, formatting and
37 changed Markdown files / 2,184 relative links and anchors pass. The complete
filesystem matrix passes **25 mechanisms / 1,137 assertion executions / 63 expected
semantic failures**, with identical per-mechanism inventories, exact restoration
and unchanged developer sources. Its 1,034-file / 457-dependency manifest attributes
execution to `962c6a54` plus this correction working tree. Fresh published native
execution and two NEW clean complete cumulative rounds still gate Step 2 acceptance.

**Fourth-round credential-floor correction:** the complete cumulative review at
`5c95857d` found one High omission: Terraform's standard `.terraformrc` and Windows
`terraform.rc` files may contain access tokens but bypassed the common basename
floor. An independent synthetic native probe reproduced read, mention, discovery
and write access in all three tiers. The two names now join the existing folded
floor; ordinary Terraform source and similarly named files remain usable. Sixteen
new permanent controls failed against the original source before the fix. The
basename-removal matrix includes both names without weakening its exact inventories.
The CAS and tooling/document slices found no additional issue, but combined R4 is
**not clean**. Published `5c95857d` Windows, Node 22.13, coverage, wire and filesystem
jobs pass; usage and required aggregation remain separately pending. These results
precede this floor correction and do not certify its final head. Fresh gates and
two NEW complete clean cumulative rounds are still required.

**Fourth-correction local gates:** full `pnpm run ci` passes with **522 package
files / 11,251 passing tests / 13 established skips**, including all lint/typecheck,
build/format, isolation/seam/dependency checks, three offline smokes and 78 acceptance
tool guards. Four wire and 23 usage mechanisms pass, including 429 permanent cases,
71 joined native children and the actual readiness-timeout control. The complete
filesystem matrix passes **25 mechanisms / 1,161 assertion executions / 65 expected
semantic failures**; fixed/restored inventories match, source restoration is exact
and developer sources remain unchanged. Its 1,034-file / 457-dependency manifest
identifies `5c95857d` plus the correction working tree, not the later commit. Fresh
published platform gates and two NEW complete clean cumulative rounds remain open.

**Sixth-round cooperative-delete correction:** round 5's three new complete
cumulative scopes were clean at `b7d0997f`. Round 6 independently reproduced one
Medium maintenance regression: two stores could admit the same blob for deletion,
then the second unlink reported ENOENT after its peer had already removed it.
The actual host-GC caller consequently skipped its orphan phase. A deterministic
native unlink-entry barrier reproduces baseline success and the regression without
injecting a missing-file error or using sleeps. The CLI/shared and tooling/document
slices found no additional issue, but combined R6 is **not clean**. The correction
must preserve strict path admission and non-missing failures; two NEW complete clean
cumulative rounds and fresh current-source gates follow the final fix. Earlier
clean slices do not certify that correction or close Step 2.

**Sixth-correction local gates:** full `pnpm run ci` passes with **524 package
files / 11,263 passing tests / 13 established skips**, including lint/typecheck,
build/format, isolation/seam/dependency checks, three offline smokes and 80 acceptance
tool guards. Four wire and 23 usage mechanisms pass; the complete filesystem matrix
passes **26 mechanisms / 1,197 assertion executions / 67 expected semantic
failures**. Both deletion regressions fail when the narrow missing-unlink recovery
is removed; its other ten cases remain green. Fixed/restored inventories match and
developer sources remain unchanged. The 1,036-file / 457-dependency manifest names
`b7d0997f` plus the correction working tree, not a later commit.

**Published native gate remains open:** required Ubuntu CI at exact `b7d0997f`
fails six native session-usage readiness cases; its seven other jobs pass. These
are genuine pre-readiness expiries, distinct from Step 1's corrected obsolete
callback. The failing Node 24.21 lane and successful Node 22.13 floor have different
runtime and task schedules; their logs do not establish the historical cause.
The next correction budgets overlapping workspace test processes and retains
native startup diagnostics, preserving the five-second bound and every native
case. The local deletion gates do not clear that published failure. Fresh platform
gates and two NEW complete clean cumulative rounds still precede Step 2 acceptance.

**Native workspace scheduling correction:** the common
[`pnpm ci:workspaces` gate](../../standards/testing.md#ci-gate) finishes lint/typecheck
before running all workspace test tasks one at a time. Its task union is identical
to the previous 23-task required graph. The exact Node floor likewise retains its
18-task union, forced execution and isolated remote credentials. No native race,
case, five-second readiness bound, 20-second case budget or 15-minute job budget
is removed or extended. Required CI hashes a unique DB-task-only diagnostic path
and retains synthetic parent/child startup stages separately from cache results.
Four new guards exercise actual command ordering, failure propagation and workflow
setup. Focused native execution passes **10/10**, including nine observed barriers
and the real timeout with joined SIGKILL; this is local evidence, not Ubuntu proof.

**Scheduling-correction local gates:** full `pnpm run ci` passes with **524 package
files / 11,263 passing tests / 13 established skips**, 84 acceptance-tool guards,
all workspace checks, build/format, three offline smokes, four wire mechanisms and
23 usage mechanisms. The permanent usage cohort retains **429 cases / 71 joined
native children / one actual readiness timeout**. All **26 filesystem mechanisms /
1,197 assertion executions / 67 expected semantic failures** pass with identical
fixed/restored inventories and unchanged developer sources. The filesystem manifest
names **`cc23b1d2` plus the scheduling correction working tree**, with 1,037 physical
files and 457 dependency packages; it is not a later committed-head execution.
Published platform gates and two NEW complete clean cumulative rounds remain open.

**Post-correction rounds 7–8:** all three complete cumulative R7 scopes are clean at
`aca351af`. Both complete runtime scopes are also clean in R8; its tooling/document
scope found one Low attribution error in ADR-0105's positive consequences. A dated
qualification now distinguishes the shared tool-fs/`save_to` helper from CAS's
separate identity checks, matching the existing Decision and acceptance criteria.
No runtime, test or tooling bytes changed. Two new complete cumulative tooling/
document reviews follow this prose correction; the finding-bearing R8 scope is not
counted as clean. Current published native Windows and Node 22.13 floor jobs pass;
the required aggregation is still running. Step 2 remains open until those reviews
and published gates complete.

### Step 2 acceptance — 2026-10-12

**Accepted on `development`; Step 3 proceeds.** The complete cumulative CLI/shared
and DB/CAS scopes have two NEW clean rounds (R7–R8) at `aca351af` after the last
runtime correction. The R8 tooling/document scope found one Low consumer-attribution
error; its append-only qualification changed prose only. Two NEW complete cumulative
tooling/document rounds (R9–R10) at `d4f54619` are clean. The finding-bearing scope is
not counted as clean, and earlier clean rounds do not certify later corrections.

| Step 2 obligation | Disposition |
| --- | --- |
| #36/#39 credential paths and declared-env overrides | Closed for tool read/write/discovery and shared declaration admission across tiers, including Terraform's standard credential files. |
| #235 shared ancestor and #113 Windows drive-relative `save_to` | Closed; both actual tool/native host consumers are pinned. CAS retains separate physical identity checks. |
| Pulled-forward 2.6.M extra roots and 2.6.N floor prerequisite | Accepted: invocation-only grants, narrowing selectors, fresh resume admission and common policy consumers. Full M/N workstreams are not closed. |
| G21 unused global tmp and host-only scratch floor | Closed for removal of unused provisioning and the exact private descriptor prerequisite. Existing directories are not erased; ordinary chat has no production allocator. |
| #1 workflow/agent catalog containment | Closed with pre-enumeration and opened-file admission, contained-alias positives and bounded regular-file reads. |
| CAS physical containment | Accepted, including cooperating publication/read, native Windows winner validation and idempotent concurrent deletion through actual host GC. Step 6's media limits, descriptor admission, cancellation and temp lifecycle remain open. |

The retained full local gate passes **524 package files / 11,263 tests / 13 established
skips**, 84 tooling guards, four wire controls, 23 usage controls and the complete
**26-mechanism filesystem matrix / 1,197 assertions / 67 expected semantic failures**.
Its physical captured implementation matches the reviewed source; the manifest names
`cc23b1d2` plus the scheduling working tree, not a later committed-head execution.

[Published CI at exact code head `aca351af`](https://github.com/HodeTech/Relavium/actions/runs/38246846580)
passes all eight jobs, including required lint/typecheck/test, enforced coverage,
Node 22.13 floor, native Windows and all three causal jobs. The required and forced
floor runs each pass **524 files / 11,262 tests / 14 established platform/capability
skips**. Actual Windows DB passes **728 tests**, including all ten native readiness
cases and eleven deletion controls; its separate CLI filesystem and CAS cohorts,
shared controls, build and headless smoke also pass. These are `aca351af` executions;
`d4f54619` adds only the reviewed prose qualification.

The retained required-job diagnostic records actual Linux x64 / Node 24.21 / four
available CPUs, ten joined children, nine observed barriers at **658–945 ms**, and
one actual **5,005 ms** readiness expiry with SIGKILL joined at **5,022 ms**. Every
child has actual import/open stages. The five-second readiness, 20-second case and
15-minute job budgets remain unchanged. The earlier `b7d0997f` failures remain real;
this successful schedule and diagnostic record do not prove their historical cause.

Canonical tool/config/CLI/session contracts retain the owner-controlled/cooperating
filesystem assumptions, Windows profile/ACL limit and absence of a hostile same-user
or OS subprocess jail guarantee. No user decision, key, provider or billing action
is pending. Steps 3–8, four final security sittings, full 2.6.N lifecycle and whole-wave
publication remain open; no approved CR deferral is closed by this increment.

### Step 3 implementation checkpoint — 2026-10-12

**Implemented; required gates and independent acceptance remain open.** The CLI
native bridge now preserves private causes while publishing fixed get/set/delete
diagnostics, without inspecting foreign error messages or coercion hooks. Fifty
direct mocked-native cases and 34 actual command/render cases cover constructor
and operation faults, human/JSON output, verbose diagnostics and successful
forwarding. These mocks do not certify a real locked keychain or native-module
loading failure; no user keychain or provider was accessed.

The common secret reader now bounds incoming UTF-8 bytes at 65,536 before copying
or retaining chunks, owns admitted Buffer bytes, assembles Unicode before decoding,
preserves whitespace and joins available iterator cleanup on early refusal. Its
31 dedicated cases cover aggregate/single-chunk limits, mutable and hostile Buffer
shapes, zero-byte retention, source failures and cleanup. Actual provider dispatch
and gate/default-reader controls verify their existing consumers; their necessary
prior database opening is not a zero-history first-run claim. The reader does not
provide a deadline for a stalled source. Step 4's run transport remains open.

The pure LLM scrubber adds eight finite literal query-name families, with a 52-case
LLM-error workload and adjacent CLI diagnostic controls. Opaque-value positives and
benign near-name negatives distinguish this mechanism from prefix-based masking;
encoded parameter names and arbitrary content are not claimed to be covered.

Filesystem and secrets causal entry points share one physical-source coordinator,
with finite family/tool-root authority, complete unique inventories, named semantic
failures, target-body evaluation, source/dependency fences, exact restoration and
bounded metadata retention. The existing 26 filesystem declarations are retained;
nine secrets mechanisms are added. Dedicated required CI aggregation and local CI
include the full secrets matrix. Selected runs alone do not certify the matrix.

An initial cleanup capture correctly refused an ambiguous inventory before mutation
(31 cases but 29 unique names); concise parameter labels correct it. This refusal
is not counted as successful removal evidence. Source, tooling and installed
dependencies will remain frozen during final captures. Detailed checks and reports
remain local; no Step 3, security-sitting or whole-wave acceptance is inferred here.

#### Step 3 gates and causal-authority correction — 2026-10-12

Full `CI=true pnpm run ci` passed at `7833c08` plus the implementation working
tree: **528 package files / 11,438 passing tests / 14 established platform or
capability skips**, lint/typecheck/build/format, isolation/seam/dependency/schema/
bundle checks, three offline smokes, **106 acceptance-tool tests**, four wire and
23 usage mechanisms, and complete filesystem/secrets matrices. The usage cohort
retains all 429 permanent cases and 71 joined native children, including its actual
readiness-timeout control. This is local execution, not published-head CI.

A read-only probe then confirmed an inherited evidence gap: a plain runtime
`Error` carrying a marker could certify a removal. The shared authority now requires
an `AssertionError` carrying that marker for every required named witness. Six new
tool guards reject misleading runtime-error markers and pin the additional-witness
rule. Secrets declarations require every aggregate/single-chunk cap shape, all nine
foreign-source boundaries, and constructor plus method witnesses for each native
operation. The decoded-output limit is documented in UTF-16 code units, matching
the unchanged process implementation.

After that tooling-only correction, **112 acceptance-tool tests**, scoped tooling
lint/checkJs and the complete **26-mechanism filesystem / nine-mechanism secrets**
matrices passed. Filesystem records **1,197 assertion executions / 67 expected
semantic failures**; secrets records **1,071 / 104**. Required witnesses, identical
complete unique inventories, target-body evaluation and exact restoration were
independently checked; both scratch trees were removed. Physical manifests cover
1,054 filesystem / 1,048 secrets source files and 457 installed dependency packages,
at `7833c08` plus the correction working tree. The earlier unchanged runtime/wire/
usage gates retain their own source attribution; they are not relabelled as later
head execution. Relative-document checks cover 41 Markdown files / 2,241 links and
anchors with zero findings; `git diff --check` passes. Implementation commits and
two NEW clean complete cumulative review rounds remain the Step 3 acceptance gate.

#### Step 3 independent-review correction — 2026-10-12

The first complete cumulative round was clean. The second found one verified
secret-disclosure blocker: matching a new query name caused the CLI sanitizer to
return before checking a second credential split across whitespace. An independent
source-based reproduction exercised all eight families through human/JSON and
normal/verbose rendering. The other two assigned second-round scopes were clean;
the combined finding-bearing round is not counted as clean acceptance.

The sanitizer now checks each remaining unredacted segment after every in-place
pass. Redacted spans separate those probes, preserving ordinary prose after a
masked query instead of creating a false match by joining through its marker.
Permanent cases cover both sanitizer functions, both credential orders, whitespace
separators, all eight query families, other credential shapes and actual diagnostic
rendering, including an isolated verbose stack with a benign message. Before the
fix, **22 of 56** focused cases failed; after it, all 56 pass. The complete affected
CLI suite passes **232 files / 3,727 tests / three established skips**, with CLI
lint/typecheck/build and scoped formatting also passing.

A tenth independent secrets control restores the unsafe early return. All **21**
new named assertion witnesses are required: both helpers for eight families, four
human/JSON rendering modes and the separate verbose-stack boundary. A first capture
correctly refused a declaration whose parameterized case names omitted the quotes
Vitest actually reports; its restoration and cleanup completed, and that incomplete
capture is not acceptance evidence. Correcting those exact names preserves the
strict assertion authority and all nine earlier declarations.

The complete corrected **ten-mechanism** secrets matrix passes **1,239 assertion
executions / 126 expected semantic failures / 46 required witnesses**, with identical
complete inventories, actual target-body evaluation and exact restoration. Its
physical capture pins 1,048 source files and 457 installed dependency packages at
`75b4e562` plus this correction working tree. An independent read-only audit checks
every phase, current source hashes and scratch removal. The 112 tooling guards,
scoped lint/checkJs and formatting pass. Unchanged filesystem/wire/usage and broad
runtime gates retain their earlier attribution; they were not needlessly rerun or
relabelled as later-head execution. Two NEW clean complete cumulative rounds after
this material correction remain required before Step 3 closes.

#### Step 3 shared-prefix review correction — 2026-10-12

The next complete cumulative round found a second verified disclosure blocker.
A whitespace-split prefixed key used as a new query family's value lost its
identifying prefix during query redaction, leaving the suffix visible. The root
reproduced all eight families through both CLI sanitizers and all four actual
human/JSON rendering modes at reviewed head `70ba7f2c`. The other two assigned
review scopes were clean; this combined round is finding-bearing and cannot
supply clean acceptance.

The shared LLM scrubber now classifies whitespace-joined residual prefixed keys
before other credential replacements can erase their prefix. Contiguous key
masking and that probe share one private pattern authority; the finite query-name
regex is unchanged. Redacted spans still separate probes, preserving benign prose
after a fully masked key or opaque query. This also protects messages and codes
already passed through `makeLlmError` before they reach CLI rendering. The finite
key-pattern word boundaries and the existing ambiguity after an already completely
masked prefix remain limits; this is not universal formatted-secret discovery.

Eight new LLM family regressions failed before correction. The final source-backed
focused workload passes **139 tests**: 62 LLM-error, 61 sanitizer and 16 actual
renderer cases. It includes raw and pre-scrubbed query values, two prefix shapes,
three whitespace separators and an isolated pre-scrubbed verbose stack with a
benign primary message. The earlier CLI residual control now exercises split URL
userinfo first, retaining its independent obligation after the upstream key fix.

An eleventh secrets mechanism removes the shared prefix probe's whitespace join.
Its **29** named assertion witnesses join the earlier 46. A selected diagnostic
capture passed without claiming matrix completion. The complete **11-mechanism**
matrix then passed **1,749 assertion executions / 156 expected semantic failures /
75 required witnesses**. A separate read-only audit checks all 33 phases, identical
complete inventories, strict assertion outcomes, actual target-body evaluations,
current fixed-source hashes, exact restoration and removed scratch. Physical
manifests pin 1,048 source files and 457 installed dependency packages at
`70ba7f2c` plus this correction working tree.

After the shared runtime correction, local workspace lint/typecheck/test and
build/format gates pass. The workspace test gate accounts for **528 files / 11,499
passing tests / 14 established skips**; unchanged shared/DB test tasks replay their
valid Turbo cache, while LLM/core/MCP/CLI tests execute anew. The affected LLM and CLI
suites respectively pass 2,257 and 3,748 tests. All 112 acceptance-tool tests,
tooling checkJs, scoped lint and three offline smokes pass. Earlier filesystem,
wire/usage and full-CI executions retain their own source attribution; this is not
a new published-head CI, coverage or whole-wave security-sitting claim. No real
keychain, user history or provider was accessed. Two NEW clean complete cumulative
rounds after this material correction remain required before Step 3 closes.

#### Step 3 overlapping-credential review correction — 2026-10-12

The fourth complete cumulative round at `f2099c78` found one further disclosure
family; two reviewers independently reproduced it. Query replacement could erase
the identifying context of a control-split key, whitespace-split URL userinfo, or
Bearer/Basic value before shared or CLI classification. Raw diagnostics and
messages/codes already passed through `makeLlmError` were affected. The tooling
scope was clean, but the combined round was finding-bearing and supplies no clean
acceptance.

Each existing non-query credential rule now probes the original diagnostic
independently, using the existing shared terminal normalizer and a whitespace-joined
residual view. The unjoined normalized comparison preserves required header
whitespace. Complete masks separate only that rule's residual spans, so another
credential family's replacement cannot erase evidence first. Each rule has one
private pattern authority; the unchanged finite query replacement runs last. A
candidate that merely reordered complete replacements was rejected because a
Bearer match could still erase a nested split-key prefix. Benign coloured prose and
ordinary text after a completely masked credential retain their prior output. The
existing word-boundary and already-masked-prefix limits remain explicit; this is
not universal secret discovery and adds no public API, dependency or decision.

The source-backed focused cohort passes **259 tests**: 98 LLM-error, 125 sanitizer
and 36 actual renderer cases. The LLM suite first produced **33 completed failures
out of 98** before the runtime correction. Permanent cases cover all eight query
families, both key prefixes, the canonical normalizer's finite removed code-point
sets and representative escape sequences, three whitespace separators, URL
userinfo, Bearer/Basic, raw and pre-scrubbed messages/codes, four rendering modes
and isolated verbose stacks. A separate root probe over 86 normalizer fixtures and
4,128 synthetic key inputs finds no disclosure in either the pre-Step-3 baseline
or corrected source; its 82,560 rendered string evaluations are not additional
Vitest cases. The independent CLI residual control now begins with a split literal
query name, which the shared non-query probe deliberately does not classify.

All **13 secrets mechanisms** pass their complete fixed/mutated/restored matrix:
**4,023 assertion executions / 392 expected semantic failures / 191 required named
witnesses**. The two new removals independently disable terminal normalization and
reverse query-last composition; the existing whitespace-join removal also requires
URL-userinfo witnesses. A read-only audit checks all 39 phases, complete identical
inventories, strict named assertion outcomes, actual target-body evaluation, source
hashes, exact restoration and scratch removal. The capture pins 1,048 source files
and 457 installed dependency packages at `f2099c78` plus this correction working
tree; no source, index, dependency or commit changed during capture.

Workspace lint/typecheck/test and build/format gates pass: **528 files / 11,619
passing tests / 14 established skips**, including 2,293 LLM and 3,832 CLI tests.
Unchanged shared/DB tests retain their valid cache attribution; LLM/core/MCP/CLI
tests execute anew. All 112 acceptance-tool tests, tooling checkJs, scoped lint and
three offline smokes pass. Earlier filesystem/wire/usage and full-CI executions
retain their own attribution; no new published-head CI, coverage or whole-wave
security sitting is claimed. No real keychain, user history or provider was used.
Two NEW clean complete cumulative rounds after this material correction remain
required before Step 3 closes.

### Step 3 acceptance — 2026-10-12

**Accepted on `development`; Step 4 proceeds automatically.** After the last material
correction, two NEW complete cumulative rounds (R5 and R6) independently reviewed
`7833c083..8c44e2ec`. Each used fresh security, CLI-boundary and tooling/document
reviewers; together they cover all 42 changed paths and affected interfaces. Both
rounds have zero actionable findings. The root read all six reports, confirmed
coverage and dispositions, and retained the earlier finding-bearing rounds as
historical evidence. Review artifacts remain local and ignored.

Each round independently passes 179 reader/native/LLM tests, 334 source-backed CLI
consumer/diagnostic tests and 80 tooling/CI guards. Separate differential probes
challenge finite credential shapes without promoting unsupported fragments into a
universal discovery claim. Both tooling reviews audit the complete 13-mechanism,
39-phase secrets evidence and current source hashes; no historical execution is
relabelled as a new committed-head run. R6's initial CLI check resolved built package
interfaces and triggered an unintended scratch Corepack bootstrap. Its authoritative
rerun uses the installed Vitest directly with source aliases; a separate root audit
confirms all 457 repository dependency packages / 21,013 files remain byte-identical.
The initial run is not counted as another source certification or fully offline run.

This accepts #27, #31/#293 and #196 implementation and the shared secrets foundation.
The preceding checkpoint owns exact runtime/build/smoke/matrix provenance and
finite limits. First-run #25, later steps, the four new security sittings, exact-head
publication and whole-Wave-2 certification remain open. No real credential, provider
capture, billing setup, new architectural decision or user action is pending.

### Step 4 first-run secret inputs — implementation checkpoint, 2026-10-12

**Implemented; independent acceptance remains open.** The approved
ADR-0107 path adds `run --secret-inputs-stdin` through the actual Commander action
and shared dispatch. Every explicit declared-secret ordinary argument, including
an empty value, refuses before reading stdin or constructing credential, provider,
MCP or history services. Run-local parser errors and raw input diagnostics are
payload-free. Existing ordinary inputs, help, version and unrelated command
routing retain their behavior.

First-run and gate resupply use one CLI-local line parser and the already accepted
65,536-byte reader. Names are trimmed, values after the first equals are verbatim,
CRLF and blank lines are supported, and own prototype-like names are retained in
null-prototype maps. Unknown/non-secret/duplicate/empty/missing required values
refuse; omitted optional secrets stay absent. The public pure core input admission
checks the merged map before lazy native key/provider services and both history
open paths. Engine admission still validates at start.

Consumed stdin removes prompt authority in first-run and resume MCP consent and
later workflow gates, including stale TTY metadata and injected gate selectors.
Existing exact stdio digests remain explicit invocation authority and append no
grant. Gate resupply legitimately reads existing history to discover masked slots;
the first-run zero-history refusal claim does not apply to that lookup.

Root integration passes **10 source-aliased files / 389 tests / zero skips** at
`f4ca477b` plus the Step 4 working changes. The native file contributes **131 cases**
through real Commander/dispatch/default reader/engine and file-backed SQLite; the
new gate companion controls run actual consent, real resupply and sequential gates.
Synthetic input-only sentinels are absent from actual `runs.input_json`, input-node
`step_executions.output_json`, all recorded rows/events and reconstructed checkpoint
state. The faithful admitted workflow snapshot is preserved. This does not assert
redaction of independent authored literals, arbitrary tool/model/user content or
historical bytes. Temporary homes, stdin descriptors and mocked native key factories
isolate these controls from user keys/history and external provider/transport work.

The first complete secrets capture retained all thirteen prior controls, then
correctly refused duplicated full case names in new parameterized input tests.
Input and gate companion cases now have stable unique names without reducing
case counts or weakening the coordinator's inventory gate. That partial capture
is retained as a failed attempt, not complete Step 4 evidence. The line-parser
reference also describes its existing trailing-line carriage-return handling
precisely, without changing value parsing.

The corrected complete secrets matrix passes **24 mechanisms / 72 phases / 6,321
case executions**, with **563 failing removal cases** and all **242 required named
assertion witnesses** present. Fixed and restored phases pass with identical unique
inventories. A separate root audit checks every phase's completed outcome, target
body/source hashes, all current fixed source bytes, exact restorations and scratch
removal. Capture provenance is `f4ca477b` plus the corrected Step 4 working changes:
**1,052 source/tool files and 457 installed dependency packages**. It is not relabelled
as a later committed-head capture.

Affected gates pass: `CI=true pnpm ci:workspaces` reports **531 files / 11,824 passed /
14 existing skips**; the changed CLI executes **4,037 tests**, while unchanged engine
packages use valid existing cache entries. Build/format passes seven tasks (five
cached). All eighty causal/CI tool guards, configured tool typecheck/lint, seam and
engine-dependency fences, bundle closure and three offline smokes pass. Cumulative
document checks cover 41 Markdown files, 2,259 relative links/anchors and thirteen
pre-existing append-only ADRs without findings. No live provider or paid operation
was involved.

Two NEW independent complete cumulative review rounds remain required. This
checkpoint closes no item
or security sitting, creates no new deferral, and introduces no new decision or
runtime dependency. Subsequent steps proceed after independent Step 4 acceptance.

### Step 4 acceptance — 2026-10-12

**Accepted on `development`; Step 5 proceeds automatically.** Two NEW complete
cumulative rounds independently reviewed `f4ca477b..1757ccc5`, including all source,
test, causal and canonical-document changes. Each round used fresh security,
CLI/SQLite-boundary and tooling/document reviewers. All six reports are clean,
cover all 24 changed paths and affected interfaces, and were read and reconciled
by the root. Detailed reports remain local and ignored.

R1 independently passes 298 source-backed security/interface cases, 269 boundary
cases and fifteen additional Commander probes. R2 independently passes 251
security/native cases, 269 boundary cases and eighty tooling guards. Both tooling
reviews audit all 24 mechanisms, 72 phases and 242 required named witnesses,
current source/dependency correspondence and exact restoration. Reviewers retain
the corrected capture's actual `f4ca477b` plus working-tree provenance; they do not
relabel it as execution at the later committed head. R1's corrected exploratory
Commander probe was a mistaken probe expectation, not a production finding.

This accepts #25 and ADR-0107's first-run transport, argv refusal, noninteractive
approval policy and native masked-persistence implementation. The preceding
checkpoint owns exact gate counts, cache attribution and finite limits. Faithful
snapshots and independent sensitive authored/generated content remain distinct
from declared input-slot masking. The four final security sittings, later steps,
exact-head publication and whole-Wave-2 certification remain open. No new decision,
credential, provider capture, billing setup or user action is pending.

### Step 5 implementation checkpoint — 2026-10-12

**Implemented; independent acceptance remains open.** Snapshot notices now run at
the actual create/import/run entry points after parsing and, for run, complete
input admission. They reuse the existing finite credential detector, disclose an
incomplete bounded scan, write value-free stderr and preserve authored files,
JSON stdout and the faithful augmented execution snapshot. The
[CLI contract](../../reference/cli/commands.md#relavium-import--relavium-export) owns the finite
limits and placeholder-probe behaviour; absence of a warning is not a secrecy
certificate.

The core parser refuses unsupported direct `secrets.*` references in workflow
context even when unread. Legitimate caller-secret-input context propagation and
existing transitive text-sink checks remain intact; ADR-0060 remains Proposed.
Export IDs have deterministic ASCII title normalisation and bounded legal
session-identity fallback. Successful standalone exports emit one fixed
continuity/content-review notice on stderr, including JSON mode. Live exports use
the interactive transcript or plain/JSON stderr without introducing raw tool-content export. The
[canonical export mapping](../../reference/contracts/agent-session-spec.md#export-to-workflow)
owns the identity rules and their explicit uniqueness limit.

Permanent controls cover faithful actual authored files, augmented engine/store
identity, strict raw legacy tool-content refusal, native SQLite snapshots and
fresh-process strict resume. Existing DNS/caller-abort/late-connect tests pass
**92 cases across three files**. G31's already recorded non-abortable native DNS
background-work limit remains explicit; no resolver replacement or new waiver is
claimed. The initial ten new causal controls retain all 24 prior mechanisms and require
12 additional named assertion witnesses. The complete physical capture passes
all **34 mechanisms / 102 fixed, removal and restored phases / 254 required named
witnesses**, with 7,335 case executions and 585 expected assertion failures in
the removal phases. That capture records `f3e09db9` plus the corrected working
tree: 1,055 source/tool files and 457 installed dependency packages. The root
audit verifies complete identical case inventories, source/evaluation hashes,
current fixed-source correspondence, exact restoration and removed scratch
trees. This is not relabelled as execution at a later committed head. Two NEW
complete clean independent review rounds remain required before acceptance.

Before the R2 runtime correction, source-backed checks passed 366 cases in thirteen files, including the native
snapshot/resume test's four fresh-process child checks. The workspace gate passes
**533 files / 11,860 tests**, with fourteen existing skips: lint/typecheck has
17 successful tasks (nine cached), and tests have eleven successful tasks (eight
cached). Affected core, MCP and CLI tests execute; unchanged shared, LLM and DB
test results come from cache. The build passes seven tasks (five cached), including
the actual core build and CLI bundle. Formatting, tools lint/typecheck, DB sync,
112 tooling tests, seam/engine fences, bundle closure and offline CLI, overflow
and replay smoke checks pass. Tools typecheck covers its declared TypeScript
configuration; it is not a claim to typecheck every `.mjs` file. The cumulative
document audit passes 45 changed Markdown files, 2,423 relative links/anchors and
fifteen pre-existing append-only ADRs. Final whole-wave coverage, exact-head
published CI and the four NEW security sittings remain open.

The first full Step 5 capture correctly refused a stale 73-case declaration for
the existing default-reader control after the run-command file grew to 76 cases.
The declaration now follows the unchanged complete-file inventory. This failed
partial capture remains excluded from complete acceptance evidence; the inventory
gate and named-witness requirements are unchanged.

A subsequent capture reached the export removals and rejected declared case
names that omitted Vitest's quotes around parameter values. The assertions did
fail with their required markers; the declarations now use the exact collected
names for both standalone and live human/JSON exports. This partial capture is
also excluded. Outcome validation is unchanged, and every declared workload and
witness is checked against a fresh collected inventory before full recapture.

The first complete independent review round found two current-reference
contradictions: the catalog-export summary and source comments still promised
credential-free sharing, and the keychain table's heading contradicted its
qualified authored-content row. The root verified both against the actual
serialization path and corrected the claims without changing runtime behaviour.
The security/authoring slice was clean; the other two reports were finding-bearing
and do not count as a clean round. All three complete reports were read. The
corrected source comment has a fresh complete passing capture at `f3e09db9` plus
the corrected working tree, with the same 34/102/254 witness inventory and verified
current source correspondence. The earlier successful capture remains historical
evidence at `3f2b01af` plus its recorded working tree. Two NEW complete clean
cumulative rounds follow the correction; neither earlier capture is relabelled.

The second complete cumulative round reproduced one live interactive delivery
defect: raw stderr contained the successful export warning, but the actual Ink
frames and transcript did not. A visible transcript-notice positive control
established that the renderer was active. The root independently reran the
reproduction, read all three reports and corrected the shared chat/Home handler
to use its existing interactive-aware notice channel. Plain/JSON stderr and the
machine export event remain intact; refused writes produce no review notice.
This round is finding-bearing; neither clean sibling slice counts as acceptance.

Two permanent file-backed SQLite/actual Ink cases now exercise successful and
refused exports with owned synthetic TTY streams and joined renderer cleanup.
The successful witness failed before the correction at its named assertion.
The manifest retains all 34 prior controls and adds a separate routing removal
that restores raw stderr while keeping plain/JSON positive cases intact. Its
complete inventory is **35 mechanisms / 105 phases / 256 named witnesses**.
The fresh physical capture at `ff7d43e6` plus the corrected working tree passes
**7,707 case executions / 587 expected removal failures**. The audit independently
checks all complete inventories, actual named assertions, evaluated source hashes,
current fixed-source correspondence, exact restoration and removed scratch trees.
Its 970 metadata files total 49,951,805 bytes, within the unchanged 2,000-file/64 MiB
bound; 1,055 source/tool files and 457 installed packages remain pinned. No later
commit execution is inferred. The fresh collected inventory independently confirms
every complete-file count, unique case identity, witness name and exact mutation anchor.

Current-source checks under `CI=true` pass **368 cases in thirteen files** and the
workspace gate passes **533 files / 11,862 tests**, with fourteen existing skips.
Lint/typecheck has seventeen successful tasks (fifteen cached); tests have eleven
successful tasks (ten cached), with the affected CLI's 4,067 tests actually executed.
The seven-task build/format gate passes (five cached), as do 112 acceptance-tool
tests, tools lint/typecheck, seam/engine fences, bundle closure and compiled CLI smoke.
Earlier unchanged DB/overflow/replay/DNS evidence retains its own recorded attribution.
Two NEW complete clean cumulative review rounds remain required; the four NEW
whole-wave security sittings, final coverage and exact published-head CI stay open.

### Step 5 acceptance — 2026-10-12

**Accepted on `development`; Step 6 proceeds automatically.** After the verified R2
interactive delivery correction, two NEW complete cumulative rounds, R3 and R4,
independently reviewed all 32 changed paths from `3f2b01af` through clean code head
`1be8731d`. Each round has separate security/authoring and core/export reviewers
(Codex Astra/high), plus tooling/documentation (Codex Sol/high). Root read all six
complete reports and checked their findings, executions, provenance and limits.
All six slices are clean. Earlier R1/R2 finding-bearing rounds and their clean
sibling slices are not counted toward this acceptance.

Fresh independent evidence includes actual mounted Chat and Home/RootApp Ink
rendering over owned streams and file-backed SQLite, successful/refused exports
with visible positive controls, reopened legacy args/result/signature refusal
before output mutation, strict fresh-process snapshot/resume identity, and actual
durable MCP-augmented execution/snapshot with masked runtime secret input. R3
export ran 260 permanent cases plus five independent probes; R4 ran 260 plus seven.
Security ran 108 permanent cases plus fourteen (R3) or sixteen (R4) independent
probes; R4 additionally ran the complete 122-case chat file. Four native child
resume checks remain separately counted. These overlapping review executions do
not add tests to the workspace inventory or claim physical-terminal coverage.

The full **35-mechanism / 105-phase / 256-witness** physical record and its
**7,707 case executions / 587 expected removal failures** were independently
audited again, including the separate interactive-routing removal with plain/JSON
positives. Its source attribution remains `ff7d43e6` plus the corrected working
tree, whose fixed source bytes match the reviewed code; it is not execution at a
later commit. The preceding 368-case focused check, 533-file workspace gate,
11,862 passing tests, fourteen established skips, cache attribution and build/tool
gates retain the exact qualifications in the implementation checkpoint above.

| Queue | Accepted Step 5 disposition |
|---|---|
| #30 | Bounded value-free create/import/run warnings and canonical retained-content documentation; faithful admitted augmented snapshot/resume identity remains. Silence is not a credential safety certificate. |
| #80/#83 | Success-only continuity/review notice, visible in interactive Chat/Home and stderr in plain/JSON; deterministic bounded legal IDs with documented collision/transliteration limits. |
| #81/#115, D14/D15 | Existing W7 strict structural tool-content rejection revalidated through producer/store/export and independent corrupted legacy rows; user/model/@/!/authored content remains sensitive and faithful. No raw-result opt-in or historical scrub. |
| G22 | Unsupported direct `secrets.*` context references refused at parse, including unread values; legitimate secret-input→context propagation and text-sink checks remain. ADR-0060 stays Proposed. |
| G31 | Existing non-abortable native DNS background-work follow-up reconciled and its 92-case caller-cancellation/late-connect regressions revalidated; no resolver or new deferral, and the existing residual stays open. |

Step 6's media work, Step 7's interim provider-header gate and Step 8's whole-wave
security sittings, full coverage and exact published-head CI remain open. This
acceptance does not close Phase 2.5.5 A–I, later joint waves or approved CR limits.

### Step 6 media implementation checkpoint — 2026-10-12

**Implementation on `development`; acceptance remains open.** This increment implements
[ADR-0106](../../decisions/0106-media-publication-requires-bounded-verified-bytes.md)
on the released Step 5 base `c6921be1`. Its exact formats, qualifiers, required host
compatibility change and fixed errors have one home in the
[media seam](../../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106).
The [database reference](../../reference/shared-core/database-schema.md#media-metadata-admission)
owns immutable metadata-batch admission, while the
[physical storage contract](../../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
and [CLI command](../../reference/cli/commands.md#relavium-media-prune-temporaries)
own temporary maintenance. No new dependency, migration, paid capture or credential
is required.

| Boundary | Implemented controls; still subject to cumulative review |
| --- | --- |
| Shared publication | Own the inert graph before the first await, preflight all original occurrences, validate handle-only carriers and reconcile actual descriptors. Separate bounded recognizers consume complete bodies; raw PCM remains explicitly structural. |
| Stores and native reads | Independent inline/stream bounds, owned memory chunks, completed verification, opened-fd actual-size/cumulative bounds, fresh incremental handle validation, range cancellation and joined native reads/close. Existing physical-jail controls remain. |
| Metadata and engine | One owned BEGIN IMMEDIATE/busy-retried metadata batch before state/save, and a separate fresh barrier before durable numbering/append/outbox. Admission grants no read scope; post-ACK retention remains best effort. Terminal refusal strips its media without repeating billed execution. |
| Temporary ownership | Conservative absent-owner/24-hour reclamation, exclusive identity-bearing claims and crash recovery, live/uncertain-owner retention, producer/maintenance handshake and exact legacy offline grammars. Native children use readiness/release barriers and kill/join cleanup. |
| Providers and host | Installed SDK AAC/Opus/PCM compatibility, unsupported selector refusal before entry, normalized declared/header/body agreement, exact MIME/cap/signal forwarding and joined platform-owned HTTP closure. |

Author self-review reproduced a promise-gap defect: media-free values returned the
caller-owned graph after ownership scanning, so a caller could introduce media before
the continuation. The implementation now returns the owned snapshot for these values
too; a permanent regression covers callback and immediate promise-gap mutation through
records/Map/Set. This is a correction within the approved ownership obligation, not a
new design decision.

The author ran the complete ordinary workspace gate after migrating the existing
accounting fixtures to the required media ports: `pnpm turbo run lint typecheck test
--concurrency=1` passed all **23 tasks without cache**, with **549 complete test files,
12,122 passing cases and 13 declared skips**. These are actual executions on the
implementation working tree, not execution of a later commit. The native media
process tests retain explicit five-second IPC readiness bounds and kill/join cleanup;
their multi-process cases have a separate thirty-second aggregate test budget.
No production deadline or causal-phase limit was raised.

The whole-workspace build/format gate passed all seven tasks (five cached). A further
self-check found that two new native-test bootstraps used `registerHooks`, introduced
after the supported Node 22.13 floor. They now use the floor-compatible `register`
loader, still resolving the current checkout's TypeScript sources. An official
SHA-256-verified Node 22.13.0 runtime passes all three complete native temporary,
metadata-writer and CLI-maintenance files: **36 cases**. This evidence is specific to
that macOS runtime and does not stand in for the Windows gate.

The first extended causal capture is **incomplete**: 32 mechanisms completed before
the next removal produced a rejection-assertion shape the evidence tool correctly
refused to certify. All 33 attempted source changes were restored byte-for-byte and
the worker joined. The affected tests now use explicit settled outcomes with named
semantic assertions; this test-evidence correction does not establish whole-matrix
acceptance. Additional reachable classifier bounds and resource-close controls are
being included before the next complete capture.

Author checks are preparation, not acceptance. The extended existing filesystem
causal family, exact fixed/removal/restored inventories,
two NEW clean independent complete cumulative rounds and platform-scoped evidence
remain required. Step 6 queue items and the whole-wave security certificate stay open
until those gates are recorded.

### Step 6 evidence corrections — 2026-10-13

**Implementation remains subject to independent review; Step 6 is not yet accepted.**
The complete uncached ordinary gate subsequently passed **549 files / 12,126 cases /
13 established skips**. After the final terminal-witness correction, all 23 ordinary
tasks passed again, with twelve cached tasks; the complete CLI file inventory still
has 241 files / 4,119 passing cases and two established skips. These executions
describe the implementation working tree, not a later commit or platform.

Two further incomplete physical captures exposed evidence defects. One stopped
after 33 complete controls because its memory-store removal bypassed `finish()` but
left the earlier byte verifier active. The declaration now removes that independent
verification sequence while retaining the unrelated missing-object, hash and size
checks. The next run completed 54 controls before a terminal removal survived: two
tests used `toMatchObject({ outputs: {} })`, which accepts additional output keys.
They now require exact empty terminal outputs and positively assert the successfully
published node descriptor. The production barriers were retained. Every attempted
source change was restored; incomplete runs and a discarded built-package diagnostic
are not causal acceptance.

The repaired terminal controls and the remaining parser/resource controls pass
their separate complete-file fixed/removal/restored diagnoses. The full inventory
remains **71 mechanisms** (26 filesystem and 45 media), with no dropped workload or
raised phase, output or evidence ceiling. Selected runs do not establish the full
matrix. The failed 54-control run plus the next attempted control took 589.54 seconds;
the existing CI job now allows twenty minutes for the expanded aggregate workload,
installation and orchestration checks. The ninety-second phase bound, 8-MiB output
bound and 2,000-file / 64-MiB retained-evidence limits remain unchanged. Per-phase
source manifests use compact JSON with every path, size and digest retained.

The next full physical run will use the committed review head. Independent cumulative
review, exact source/evidence attribution and two NEW clean complete rounds remain
gates. Native Windows execution and whole-wave certification remain separate open
obligations; the Windows workflow now includes the complete shared recognizer and
CLI media lifecycle cohorts alongside its existing complete DB suite.

### Step 6 first cumulative review and lifecycle decision — 2026-10-13

**Not accepted.** Four independent complete cumulative partitions reviewed the
Step 5 base `c6921be1` through Step 6 implementation head `bf409fd9`. Their shared,
stores, integration and tooling/document scopes returned confirmed findings; they
are not clean acceptance rounds. Local review records remain outside git under the
approved review-record policy.

The full pre-fix physical inventory completed all **71 mechanisms and 213 joined
fixed/removal/restored phases**, with **3,747 case executions**, 320 unique cases
across 22 complete files and byte-exact restoration of all mutations. All declared
removal witnesses were named assertion failures. Six collateral failed cases across
four removals were not assertion failures and do not serve as causal witnesses.
Independent review also found that native fixture children lacked the same-child
source/dependency execution fences: these outcome results therefore do **not**
certify the complete required runtime provenance. The tooling repair and a new
exact-head complete capture remain required; retained evidence caps stay unchanged.

| Confirmed boundary | Action and remaining gate |
| --- | --- |
| Base64 source aliases | Count every incoming owned-graph edge against genuine media.source slots. Additional record/Map/Set aliases refuse before host entry; shared legitimate slots remain supported. Four new regressions failed before repair. |
| WebM encoding | Refuse known ContentEncodings rather than skipping them as unknown. Three codec/fragmentation regressions failed before repair; real memory/filesystem stores also exercise encrypted refusal and a plain-video positive control. |
| Branch output | Apply the same pre-state pin, metadata admission and rehost reservation as completed outcomes. Actual CAS/SQLite controls reproduced state/event divergence and excess downloads before repair, while preserving routing/tokens without media. |
| Native causal children | Require current-source/runtime/dependency receipts in the actual native worker. Lossless bounded receipt export must preserve every PID/path/hash record within existing evidence limits. Independent review and fresh full capture remain pending. |
| Foreign return versus native close | Awaiting arbitrary return can strand real-store temp cleanup; unconditional non-await can release actual HTTP resources prematurely. Proposed [ADR-0109](../../decisions/0109-native-media-close-ownership-is-explicit-iterator-provenance.md) supplies explicit trusted provenance and requires maintainer approval before dependent implementation. |

After the ordinary shared and branch repairs, the seven complete shared media/index
files pass **140 cases**, and eleven complete integration files pass **148 cases**
against current-source aliases. These focused author checks do not replace the full
workspace gate, physical inventory or two NEW clean complete cumulative review rounds
after the final material fix. Native Windows certification and the original Step 7–8
obligations remain open. No paid provider, credential or billing action is needed.

The ordinary R1 repairs are committed as `bf38fc16` (shared alias/WebM plus real-store
regressions), `323b14ff` (branch pre-state admission plus CLI integration) and
`a703fdd6` (native causal execution fences, lossless bounded receipts and controls).
The final workspace lint/typecheck/test gate passes **23/23 tasks**, with twenty
cache hits; its aggregate inventory is 549 files, **12,139 passing cases and 13
established skips**. The final CLI execution itself runs 241 complete files and
4,122 passing cases with two established skips. Unchanged other-workspace results
were executed in the preceding gate or reused from cache; this is not a claim of
one fresh uncached execution of every case. Build and format checks pass **7/7
tasks**, with five cache hits. These checks ran on `bf409fd9` plus the repaired
working tree before the three commits; no post-commit re-execution is inferred.

Acceptance-tool integration passes **130/130**. The same filesystem family now
declares **74 mechanisms**, preserving the original 71 IDs/order and enlarging
their affected complete files. Three selected physical diagnoses pass complete
fixed/named-removal/restored cohorts: alias **17/4/17**, WebM **20/3/20**, and branch
**21/2/21**. Both independent branch witnesses fail as named assertions on removal.
Parent separately checked source/dependency pins, complete inventories, every
compressed receipt byte/index and exact restoration. Each selected export has 29
files and less than 10 MB including its envelope, under the unchanged 2,000-file /
64-MiB bounds. Their source attribution is `bf409fd9` plus the frozen repaired
working tree (1,103 source files, 457 dependency packages), not a later commit.
They explicitly remain `complete: false`; no new full 74-control or lifecycle
acceptance is claimed. A fresh exact-head complete capture remains required after
the lifecycle implementation and its additional controls.

### ADR-0109 proposal clarification — 2026-10-13

The maintainer's proposal review is addressed before approval. Close initiation
now synchronously caches/returns an acknowledgement; the caller owns the later
join. An ordinary outer `streamMediaBytes` factory registers the exact public
lazy generator before escape, while counted return only initiates and the
encompassing finally joins. The established invocation/receipt callback alternative,
standalone raw-store benefit and single-module packaging cost are explicit. The
whole-buffer twin retains its existing limits. Duplicate/late registration,
already-running registration as a trusted precondition, prior direct return,
related decisions and the causal inventory are all clarified. Media-specific helper
names remain intentional; the protocol is scoped to this byte-consumer boundary.

After those clarifications, **two NEW complete cumulative proposal rounds, R5 and
R6**, each contain separate independent lifecycle and architecture/contracts
reviews. All four reports are clean on the same complete 207-line proposal,
SHA-256 `21bff0896350b4b3aed7ffd8bc3fff98b666799f459e00dbe6d474826a04bb77`.
Parent read every full report and verified its scope. These are static proposal
reviews, not implementation/native/packaging evidence or Step 6 acceptance.
ADR-0109 remains **Proposed** pending explicit maintainer approval; no dependent
lifecycle protocol has been implemented. Step 6 remains unaccepted, and Steps 7–8
remain unstarted.

### ADR-0109 approval and implementation — 2026-10-13

The maintainer explicitly approved the clarified ADR-0109 and its dependent
implementation. The decision and index are now **Accepted**; earlier Proposed
checkpoints remain historical. The shared exact-iterator ownership helper, lazy
first-party registration, counted return initiation and store-local cleanup before
native joining are implemented. Native lifecycle, built workspace and actual CLI
packaging checks, the enlarged bounded causal inventory, full workspace gates and
two NEW clean complete cumulative implementation review rounds remain gates.
Approval and focused author tests do not accept Step 6 or close Wave 2.

### ADR-0109 author validation — 2026-10-13

The approved protocol is implemented across shared de-inlining, both actual stores
and the lazy native stream constructor. The canonical seam and dated notes on
ADR-0042/0043/0089/0103/0106 record its exact identity, trusted adoption, EOF,
error precedence and loaded-module boundaries without replacing host-work ownership.

The first complete workspace lint/typecheck/test run passes **23/23 uncached tasks**.
After strengthening three diagnostic regressions, the final run passes **23/23**,
with two cache hits. The six test suites total **553 complete files, 12,170 passing
cases and 13 established skips**. Build/format passes **7/7**, with three cache hits;
tools lint/typecheck, DB sync, SDK fences, engine purity and bundle closure pass.
The actual official Node **22.13.0** binary executes all four new lifecycle files:
**31/31 passing cases** on macOS. This is not native Windows evidence.

The new required `smoke:media-packaging` runs built shared/core/db entry points and
the untouched CLI bundle. Raw-store and engine de-inline consumers share native
registration; a physical second shared copy stays foreign. The actual CLI workflow
uses isolated synthetic history, real loopback HTTP and an actual temporary-file
write failure: file/temp cleanup finishes while native destruction and command
settlement stay held, then all resources join and the original failure survives.
Its fixture transport redirection is packaging/lifetime evidence, not TLS or SSRF
certification. Missing artifacts refuse rather than skip. Local and GitHub required
CI invoke the same artifact check after build.

Acceptance tooling passes **140/140**. The existing filesystem family now declares
**89 controls**, retaining its previous 74 IDs/order and full-file workloads. The
15 additions complete **45 joined phases and 381 case executions** in selected
fixed/removal/restored diagnoses. Every required witness is a named AssertionError;
four collateral failures in this first inventory are explicitly not causal witnesses
(three foreign-diagnostic awaits and one natural-EOF error under the filesystem
return-await removal). The diagnostic tests were subsequently made finite and the
five full helper cohorts rerun: **15 phases, 195 executions, 13 AssertionErrors and
zero non-AssertionErrors**. No process timeout, signal, output overflow or unjoined
child occurred. The filesystem ordering removal's one collateral error remains
qualified rather than relabelled as causal.

Parent independently checked source/dependency hashes, complete case inventories,
all retained stdio and compressed receipt bytes, same-child native body/dependency
records, required named witnesses and byte-exact restoration. These selected runs
capture `699c8335` plus the respective frozen working trees, **1,111 source files
and 457 dependency packages**; they are **not** later-commit or full-matrix evidence.
Each export contains 26 files and at most 9,902,401 bytes including its envelope.
Per-phase stdio is losslessly packed into one length/hash-verified binary envelope;
no receipts, cases or provenance fields are dropped. The 2,000-file / 64-MiB
retention caps, 90-second phases and decoded-output bound remain unchanged.

**Step 6 remains unaccepted.** A fresh complete 89-control capture at the committed
implementation head, two NEW clean complete cumulative implementation review rounds
and remaining publication/platform checks are still required. Proposal reviews,
author gates and selected diagnoses do not substitute for them. Steps 7–8 remain
unstarted; no paid provider, keychain, credential or new user decision is needed.

### Step 6 second cumulative review and repairs — 2026-10-13

Four independent reviewers completed all **140 assigned cumulative paths** from
accepted Step 5 `c6921be1` through `fc4934fd`: shared 27, stores 27, integration
52 and tooling/docs 34. Shared and stores each returned one High finding;
tooling/docs returned one High and two Medium findings. Integration returned no
finding. This is **not a clean acceptance round**. Root independently reproduced
the ambiguous video identities and native HTTP header loss before repairing them.

| Confirmed finding | Implemented disposition |
| --- | --- |
| WebM/MP4 last-write-wins identity | Refuse repeated identity fields, owning containers and undeclared extra MP4 sample entries. Twenty-eight independently assembled ambiguous vectors run at every two-chunk split, with two unchanged late-container positive controls. Both actual stores refuse representative stream publication; the separate video inline refusal remains intact. |
| Native duplicate Content-Type disappears | Preserve original individual fields through the native transport and reject multiplicity before normalization/body iteration. Eighteen actual loopback HTTP cases cover both orders, identical fields, parameters and mixed casing through whole-buffer fetch and filesystem-store streaming, with native close barriers and no-publication assertions. |
| Nine stale case counts and five stale mutation anchors | Retain all prior 89 IDs, order and complete workloads; pin the measured 21-case admission file and relocate only the equivalent single-site removals. Preflight every selected copied-source anchor before any phase. |
| Case/hook overrides exceed the claimed 15 seconds | Normalize the selected native cohorts, enforce effective case/configured hook budgets through owned setup and check direct hook declarations through the TypeScript parser. Actual negative coordinator fixtures refuse over-budget cases/configuration; no phase/output/retention cap is raised. |
| Packaging fixtures assume POSIX URL/path syntax | Use native relative containment and file URL conversion. Extend native Windows CI to the new shared lifecycle/identity cohort and actual built-workspace/CLI packaging check. Local success does not establish native Windows execution. |

The exact-head full-89 capture at `fc4934fd` is **incomplete**. The original
26 controls completed 78 accepted phases and 1,197 case executions; the next
fixed phase stopped on **21 observed versus 19 declared cases**. Root audited
the complete failed export, including the envelope: **558 files / 23,956,427
bytes**, all retained stdio and compressed receipts. Sixty-six expected removal
failures and two collateral non-AssertionErrors are qualified; neither the prefix
nor the failure is full-matrix acceptance. Missing completion flags were not
inferred. The failed export remains historical evidence.

Four new separate removals cover WebM/MP4 uniqueness and native header
preservation/admission. The declaration now contains **93 controls**. Fresh
isolated copied-source collection reports **28 complete files / 412 cases**,
with no count, anchor or named-witness drift. This is collection rather than
physical fixed/removal/restored execution. Generic units pass **10/10** and
actual coordinator integration passes **3/3**. Official Node **22.13.0** on
macOS passes **6 complete files / 80 cases**, including the new real-native
header matrix and normalized native lifetime/temporary/metadata cohorts.

The repair working tree passes **17/17 uncached lint/typecheck tasks** and
**11/11 test/dependency tasks** (five dependency-build cache hits). All six
test suites execute: **556 files, 12,222 passing cases and 13 established skips**.
Build/format passes **7/7** with five cache hits; acceptance tooling passes
**144/144**. Tools lint/typecheck, DB sync, SDK fences, engine dependency purity,
bundle closure and actual built-workspace/CLI media packaging pass. The document
audit checks **50 changed Markdown files, 2,630 relative links and 19 existing
append-only ADRs**, without errors. These author gates do not replace the
committed-head physical controls or independent acceptance rounds below.

**Step 6 remains unaccepted.** Whole-workspace gates, committed-head physical
controls and independent export audit, two NEW clean complete cumulative review
rounds after these material repairs, and remaining publication/platform evidence
are required. No further ADR approval, paid capture, keychain or user decision
is pending. Steps 7–8 remain unstarted.

### Step 6 third cumulative review and repairs — 2026-10-13

Four independent reviewers completed all **151 cumulative paths** from accepted
Step 5 `c6921be1` through `fba63e4b`: shared 29, stores 32, integration 52 and
tooling/docs 38. Shared returned one High finding; the other three reports were
clean within their assigned complete scopes. **This is not a clean acceptance
round.** The fixed diagnostic path had still left the original genuine rejected
Promise unobserved when its own `then` was replaced. Root independently reproduced
the runtime unhandled rejection before repairing intrinsic observation. Two
isolated child regressions each exercise thirteen joined scenarios, including
cross-realm settlement and actual raw-store/de-inline consumers, without
pre-catching the original rejection. Constructor/species sabotage remains outside
the supported JavaScript boundary, as the canonical seam now makes explicit.

The required native Windows job also exposed an inconsistent temporary-claim
identity refusal. Its log contains no measured native identity values. An
independent controlled production writer/reader probe reproduced unsafe Number
encoding and radix round-trip failures. New exact-native v2 claims and conservative
v1 compatibility repair that defect; the unchanged complete nineteen-case file
now includes actual writer/interruption/recovery vectors and a distinct bigint
collision that Number would erase. These portable vectors do not certify NTFS;
a fresh native Windows run remains required.

The remote secrets gate found a stale full-file case pin; fresh copied-source
collection found one more. Both pins now match the complete fourteen- and
thirty-two-case files, retaining every one of the 35 controls and their order.
The usage gate separately found its permanent cohort had grown from 429 to 435
cases: six new live-export cases in the complete chat file, with no removed case
or other-file difference. Fresh full seventeen-file collection establishes the
new exact pin; no semantic threshold or native-child bound changes. The required
aggregate correctly refused these non-green prerequisite jobs.
The remote filesystem job completed 46 restored controls before its whole-job
twenty-minute timeout; this is an incomplete run, not a semantic-control failure
or full-matrix evidence. Its total job allowance is now sixty minutes. The
ninety-second phase, fifteen-second test/hook and output/retention bounds are
unchanged.

Nine selected physical diagnoses at **`fba63e4b`** separately passed **27 joined
phases, 591 case executions and 42 expected named AssertionErrors**, with no
collateral non-AssertionError. Root independently audited pins, complete case
inventories, stdio, compressed receipts, native child/dependency records and exact
restoration. Each export contains at most 26 files and 9,966,518 bytes, including
its envelope. This evidence belongs to that earlier head and does not certify the
new repairs or a complete matrix.

The filesystem family now declares **95 controls**, preserving its earlier 93
IDs/order and complete workloads. Fresh isolated copied-source collection checks
all 95 filesystem and 35 secrets declarations against **49 complete files and
1,345 case names**, with no count, exact-anchor or named-witness drift. It is
collection evidence only. The unchanged full filesystem retention limit projects
to exactly 2,000 files; measured-prefix byte projections remain below 64 MiB.
Only a complete actual capture can certify both bounds.

The repair working tree passes **17/17 uncached lint/typecheck tasks** and
**11/11 test/dependency tasks**, with five dependency-build cache hits. All six
test suites execute: **557 complete files, 12,224 passing cases and 13 established
skips**. Build/format passes **7/7** with five cache hits; acceptance tooling
passes **144/144**, and tools lint/typecheck pass. These author gates precede
the repair commits and do not substitute for committed-head acceptance.
DB sync, SDK fences, engine purity, bundle closure and actual built-workspace/CLI
media packaging pass. The actual official Node **22.13.0** binary passes **seven
complete files / 82 cases** on macOS. Its first run rejected only experimental
type-stripping warnings in the new diagnostic child; the fixture now disables
that warning category alone, preserving rejection diagnostics and its empty-stderr
assertion. The new diagnostic tests, DB typecheck and scoped lint/format pass again
after that launcher-only correction. The document audit checks **50 changed
Markdown files, 2,633 relative links and 19 append-only ADRs**, without errors.
The usage-cohort pin correction also passes its **3/3** workload units and tools
lint/typecheck/format; its complete physical rerun remains required.

**Step 6 remains unaccepted.** New committed-head physical diagnoses, the complete
95-control filesystem and 35-control secrets matrices with independent export
audit, two NEW clean complete cumulative review rounds after these repairs,
and remaining publication/platform gates are required. Steps 7–8 remain
unstarted. No ADR approval, provider capture, credential or user decision is
pending.

### Step 6 fourth cumulative review and repairs — 2026-10-13

Four independent reviewers completed all **158 cumulative paths** from accepted
Step 5 `c6921be1` through **`4e63344c`**: shared 29, stores 34, integration 52
and tools/docs 43. Integration returned one High finding; the other three complete
partitions were clean. **This is not a clean acceptance round.** A nested OpenAI
video format selector was checked under the audio namespace and silently omitted
from the native request. Root independently reproduced all three unsupported
fields reaching an installed-SDK synthetic video-job POST. The corrected check
uses the actual modality before any SDK entry. All three named regressions fail
before the repair; two positive controls preserve the unspecified video format
and supported native size. No paid request, credential or user history is used.

Three physical diagnoses at **`4e63344c`** separately pass **nine joined phases,
120 case executions and four expected named AssertionErrors**, with no collateral
non-AssertionError. Root and the independent tools reviewer each reconstruct all
retained stdio and compressed evaluation receipts, complete source manifests,
dependency pins, same-child native records, inventories and exact restorations.
Each selected export contains **26 files**, at most **9,989,797 bytes**, including
its envelope, and captures **1,122 source files / 457 dependency packages**.
All three explicitly remain incomplete selections; they certify neither the
later video correction nor a complete matrix.

At that same head, native Windows passes the complete DB **50-file / 844-case**
cohort, including all nineteen temporary-protocol cases. The later complete CLI
cohort fails nine cases on its default five-second budget; the identical fourteen
cases passed at the preceding head. Passing no-provider fixture cases also slow
down, but the exact expensive stage is unmeasured. Both affected integration files
now use the existing fifteen-second case/hook fence without removing a variant or
assertion or changing product/global timeouts. A fresh complete native Windows
rerun is required; local success does not certify it.

The remote filesystem capture also stops after 74 completed controls: the
foreign-return removal no longer breaks its fulfilled-Promise getter witness
after the correct intrinsic-observation repair. The retained thirteen-case report
has four ordinary AssertionErrors, including the throw/reject witnesses, with
no timeout or diagnostic leak; the third required witness passes. This is a
real causal-evidence gap, not a product regression or complete capture. The test
now holds that genuine Promise pending through the finite checkpoint, then
releases and joins its cleanup observer. All thirteen cases and required witness
markers remain; a fresh physical removal/restoration run is required.

The same remote secrets job reaches its ten-minute aggregate timeout during the
last restored cohort, without exporting a complete artifact. Its job allowance
becomes thirty minutes; per-phase, case/hook, output and retention limits stay
unchanged. The prior timeout is not full-matrix or semantic-failure evidence.

The new video removal requires a **96th filesystem control**. The previous
95-control retained-file projection exactly exhausted the unchanged 2,000-file
cap. Export-only lossless source-manifest packing preserves the original bytes,
phase/runtime hashes and inspectable pins in one bounded archive/index pair.
An independent 64-MiB raw-input/decode bound supplements the unchanged whole-export
64-MiB / 2,000-file caps. Complete96 projects **1,735 retained files**; actual
complete capture, measured bytes and independent decoding remain required.
No prior control, complete workload, provenance field or limit is removed.

The repair working tree passes **17/17 uncached lint/typecheck tasks** and
**11/11 uncached test/dependency tasks**. The six suites execute **557 complete
files, 12,229 passing cases and 13 established skips**. The final strengthened
thirteen-case shared fixture also passes focused tests, lint and ordinary/purity
typechecks. The video selector and complete OpenAI adapter cohort pass **132/132**
with package/seam typechecks and scoped lint. Build passes **6/6 uncached tasks**;
whole-repository formatting passes its one uncached task. Acceptance tooling
passes **172/172**, including three actual coordinator captures preserving both
archived failed prefixes and primary failure under forced export refusal.
All **63** retention cases also pass under the actual official Node **22.13.0**
binary on macOS. Tools lint/typecheck, DB sync, SDK fences, engine purity, bundle
closure, compiled CLI, actual built-workspace/CLI media packaging and offline
overflow smoke pass. These are author gates; no committed-head complete matrix,
native Windows rerun or independent acceptance is inferred from them.
Fresh isolated copied-source collection checks all **96 filesystem / 35 secrets**
declarations against **49 complete files / 1,350 case names**, with no count,
exact-anchor or named-witness drift. This is collection, not physical execution.

**Step 6 remains unaccepted.** The corrected committed-head physical matrices,
independent artifact audits, two NEW clean complete cumulative implementation
review rounds and remaining platform/publication gates are required. Steps 7–8
remain unstarted. No ADR approval, provider capture, credential or user decision
is pending.

### Remaining gate

The maintainer approved the revised four-ADR decision package and eight-step plan
on **2026-10-12**. ADR-0105–0108 are **Accepted** and dependent implementation is
authorised on `development`; the earlier Proposed checkpoints remain historical
records. Steps 1–5 have independent acceptance; **Step 6 proceeds automatically** with
media bounds, verification, admission, cancellation and temporary lifecycle. Subsequent runtime,
independent implementation reviews, security certification and final publication
remain gates; approval and Steps 1–5 acceptance do not certify whole-wave completion.
ADR-0109 and its dependent native ownership repair received separate explicit
maintainer approval on **2026-10-13**. Its implementation validation and Step 6
acceptance remain open; no further user approval is currently pending.

---

Part of [roadmap/](../README.md).

### Step 6 fifth cumulative review and repairs — 2026-10-13

Four NEW independent reviewers read all **158 cumulative paths** from accepted
Step 5 `c6921be1` through **`24e39c1e`**: shared 29, stores 34, integration 52
and tools/docs 43. Stores returned one High finding; the other three partitions
were clean. **This is not a clean acceptance round.** Root independently reproduced
the same finite injected-transport observation: a valid AAC Buffer was admitted,
then reused by its producer at the next pull. Subtype `slice` had retained an alias,
so whole-buffer fetch returned zeroed bytes that a fresh verifier refused. Ordinary
Uint8Array retained the original bytes. The current native Node HTTP implementation
was not observed reusing its chunks; the supported injected API still owed ownership.

Whole-buffer collection now uses an intrinsic typed-array copy and its owned length.
The new complete three-case regression retains the ordinary Uint8Array control,
Buffer reuse and an overridden typed-array subclass. Before repair, exactly the two
named Buffer/subclass assertions fail; after repair all **53** focused egress cases
pass. The checks prove source reuse occurred, exact returned bytes, independent
recognition, disposal and absence of producer slice/iterator calls. They use no socket,
provider, credential or user history. The new **97th filesystem control** removes
only the owned-copy expression and requires both named witnesses. Every earlier
control ID, order and complete workload remains. The unchanged retention limits
project **1,753 files** for a complete97 export; that arithmetic is not a capture.

At the preceding exact committed head **`24e39c1e`**, three selected physical
controls pass **nine joined phases / 159 case executions / nine expected named
AssertionErrors**, with zero collateral failures. Root and the independent tools
reviewer decode their exact packed manifests, stdio and evaluation receipts; every
export is an incomplete selection, with 25 files and at most 9,612,186 bytes.
They establish the corrected foreign acknowledgement, native chat selector and
video selector, without claiming the later whole-buffer repair or a full matrix.

The same remote head passes native Windows, official Node 22.13, strict peers,
LLM/MCP coverage, wire and usage jobs. Its complete secrets export independently
passes Root's retained-evidence audit: **35 controls / 105 phases / 7,713 case
executions**, 586 expected semantic failures (584 ordinary AssertionErrors and two
Vitest rejection-expectation assertions), zero collateral failures, **637 files /
23,166,557 bytes** including the envelope. Exact packed manifests and executed
loader receipts join 1,114 source files, 458 dependency packages and 21,013 dependency
file pins. Root rehashes local source bytes and verifies retained remote dependency
pins/loader receipts; remote installed bytes are not locally accessible or rehashed.
The filesystem capture and aggregate CI are still pending at this checkpoint.
These preceding-head successes do not certify the subsequent repair.

The repair working tree passes **17/17 uncached lint/typecheck tasks**, then
**11/11 uncached test/dependency tasks**: six suites, **558 files / 12,232 passing
cases / 13 established skips**. Build passes **6/6 uncached tasks**, whole-repository
formatting its one uncached task, and acceptance tooling **172/172**. Tools lint/types,
DB sync, SDK fences, engine purity, bundle closure, compiled CLI, actual built-workspace
and untouched CLI media packaging, offline overflow and budget replay smoke pass.
The copied-source collection checks **97 filesystem / 35 secrets declarations**
against **50 complete files / 1,353 names**, without count, anchor or witness drift.
That collection captures the repair working tree and is not physical phase execution.
The documentation audit checks 50 Markdown files, 2,636 relative links and nineteen
pre-existing append-only ADRs without errors. These author gates do not substitute
for committed-head physical evidence or new independent acceptance rounds.

**Step 6 remains unaccepted.** The whole-buffer physical removal, complete current-head
matrices, independent artifact audits, two NEW clean complete cumulative implementation
rounds after this repair and remaining publication gates are required. Steps 7–8
remain unstarted. No ADR approval, provider capture, credential or user decision
is pending.

### Step 6 sixth cumulative review and repairs — 2026-10-13

Four NEW complete cumulative reviews cover all **159 paths**, accepted Step 5 base
`c6921be1` through committed head `85e4b0c1`. Shared and integration are clean;
stores and tooling each return one independently reproduced **Medium** finding.
This is a changes-requested round, not one of the required clean rounds.

| Confirmed gap | Correction and permanent evidence |
| --- | --- |
| A genuine injected byte view with an inert own `length: 0` bypasses a lower configured response limit | Both shared host readers count intrinsic bytes before copying/yielding. Exact capacity, cumulative overflow, Buffer/Uint8Array overrides, getter non-evaluation and both public media fetch paths are pinned. The independent 25 MiB media ceiling was intact. No ordinary native HTTP shadowing is claimed. |
| An incomplete standalone evidence archive accepts restored-only/gapped phases or two unfinished controls | Completed IDs are unique and retain all three physical runtime records; incomplete captures allow one contiguous attempted phase prefix, with every predecessor's runtime/hash join. Complete captures allow no unreported tail. External cohort membership/order remains an independent acceptance audit. |

A follow-on Root probe also reproduced producer reuse changing the buffered text
reader's returned bytes. That reader now owns admitted chunks before another pull;
the streaming twin remains borrowed and retains no chunk. The initial 20-case DB
regression produces fourteen named AssertionErrors before repair. Its expanded
**28-case** permanent file and all **115** focused egress cases pass afterwards.
Two appended filesystem controls separately remove intrinsic counting and buffered
ownership, preserving all original **97 IDs, order and complete workloads**.
The **99-control** export projects **1,789 files** under unchanged retention caps;
this arithmetic is not physical acceptance evidence.

The evidence repair's six new negative regressions fail before the fix with ordinary
missing-exception assertions; seven genuine-prefix controls remain positive. All
**76 retention tests**, including the original 63, pass afterwards. Zero phases,
selected completed controls, interruption at each phase with/without final runtime,
full unreported failed tails and primary failure precedence remain supported.

The repair working tree passes **17/17 uncached lint/typecheck tasks**, **11/11
uncached test/dependency tasks**, **559 files / 12,260 passing tests / 13 established
skips**, six uncached builds and the uncached whole-repository formatting task. All
**185 acceptance-tool tests**, configured tools lint/types, isolation, DB sync, SDK
fences, engine purity, bundle closure, compiled CLI, actual workspace/untouched CLI
media packaging, offline overflow and budget replay checks pass. The copied-source
collection validates **99 filesystem / 35 secrets controls**, **51 complete files /
1,381 names**, with no anchor/count/witness drift. It captures the repair working
tree on `85e4b0c1`, not committed-head physical phase execution. The document audit
checks fifty Markdown files, 2,638 relative links and nineteen append-only ADRs.

**Step 6 remains unaccepted.** Current committed-head physical controls, complete
matrices and artifact audits, required gates, and two NEW clean complete cumulative
implementation rounds after these repairs remain required. Steps 7–8 are unstarted.
No new ADR, approval, provider capture, credential or user decision is pending.

### Step 6 acceptance — 2026-10-13

**Accepted on `development` at implementation head `0b025416`; Step 7 proceeds
automatically.** After the sixth-round corrections, two NEW complete cumulative
rounds (R7 and R8) independently review all **160 paths** from accepted Step 5 base
`c6921be1`. Each round has separate shared, stores, integration and tooling/document
reviewers; all eight reports are clean. Root reads every full report and joins the
scoped checks. Independent focused executions total 513 cases in R7 and 462 in R8;
these overlapping executions are not a unique-test or whole-suite count.

The acceptance retains the canonical [finite media profiles and ownership contract](../../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106),
[metadata admission](../../reference/shared-core/database-schema.md#media-metadata-admission),
[physical storage limits](../../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
and [offline maintenance command](../../reference/cli/commands.md#relavium-media-prune-temporaries).
It includes all confirmed R1–R6 corrections, Accepted ADR-0109 native ownership,
pre-publication admission, old-layout read bounds, borrowed-byte ownership, exact
native temporary identity and finite evidence-prefix validation. The final caller
comment distinguishes mandatory admission on a **present** reference port from
optional port absence and best-effort post-ACK retention; it changes no runtime.

At the exact reviewed head, [CI run 38330334716](https://github.com/HodeTech/Relavium/actions/runs/38330334716)
passes all **nine jobs**, including the success-only required aggregate. Its lint,
types, tests, build, formatting, tooling, isolation, DB sync, SDK/engine fences,
bundle closure and compiled CLI/media packaging/overflow/replay smoke checks pass.
Root downloads and independently decodes the actual current-head artifacts:

| Family | Complete physical evidence |
| --- | --- |
| Filesystem | **99 controls / 297 phases / 5,115 executions**, 255 removal failures: 248 ordinary AssertionErrors, four Vitest rejection-expectation assertions and three separately traced secondary removal effects. All required named semantic witnesses and full fixed/removal/restored inventories pass; 1,789 retained files / 32,500,649 bytes including envelope. |
| Secrets | **35 controls / 105 phases / 7,713 executions**, 584 ordinary AssertionErrors and two Vitest rejection-expectation assertions; no collateral failure. 637 retained files / 23,174,544 bytes including envelope. |
| Wire | **Four controls / nine phases including shared baseline / 216 executions** over the same 24-case inventory. All 36 primary semantic assertions fail as intended; fourteen secondary assertions and six normalized provider refusals are individually qualified. Exact installed SDK byte inventories match independent local capture; a different local shared build is not substituted for the remote artifact. |
| Usage | **23 mechanisms / 3,738 executions / 227 semantic failures**, plus **435 permanent cases / 71 native children / one intentional readiness-timeout control**. Complete ordered inventories and multiplicities pass. Three inherited query-title pairs remain duplicated; Step 8 must distinguish them and rerun the full final inventory. Both original bodies remain executed; no unique-label claim is made here. |

The filesystem secondary effects are a source-failed error from premature native
return in the natural-EOF regression, a rejected reverse Ogg claim after body
evidence is removed, and a recovery worker exiting
before an intentionally removed unlink stage. The last is not its post-unlink
semantic assertion and is not counted as a designated causal witness. Every control
still has its separate required named AssertionError and green complete fixed/restored
suites. These are explained removal consequences, not unrelated setup/timeout failures.

Packed manifests, exact stdio, source and dependency loader receipts, native
parent/child joins, restoration and unchanged caps are checked. Filesystem source
pins equal exact reviewed Git blobs; its 297 packed manifests join 1,124 source
files, 458 dependency packages and 21,013 dependency-file pins. Standalone production
manifest/evaluation/stdio validators also pass. Remote installed dependency bytes
are not locally accessible or rehashed; retained pins and executed receipts are
verified instead. Earlier cancelled or selected captures are not acceptance evidence.

Native Windows passes the full DB suite, concurrency, filesystem/CAS/shared-media,
publication/GC/prune, actual workspace and untouched CLI packaging, and headless
smoke. The official Node 22.13 floor passes uncached types/tests/build. Both that
Linux test run and the enforced LLM/MCP coverage run execute **559 files / 12,259
passing tests / 14 established skips**. Eleven skips are existing LLM capability
cases, two are Windows-only filesystem cases on Linux, and one is the existing
CI-only benchmark exclusion. Windows retains sixteen established POSIX-only
filesystem skips. No Step 6 test is newly skipped. Core coverage is measured here,
not claimed as formally enforced; Step 8 still requires bare and enforced coverage.

The current broad local author gates and all 185 acceptance-tool tests are green
as recorded in the preceding repair checkpoint. Acceptance is limited to the
approved structural formats, cooperating filesystem ownership and explicit native
iterator domain/EOF/adoption obligations. It does not certify decoding/playback,
hostile same-user filesystem isolation, arbitrary JavaScript containment or cross-copy
ownership. **Steps 1–6 are accepted; Steps 7–8 and whole-wave certification remain
open.** No new ADR approval, provider request, credential, billing or user decision
is pending.


### Step 7 implementation checkpoint — 2026-10-13

The approved [provider-header interim gate](../../reference/shared-core/database-schema.md#llm_providers)
is implemented, with independent cumulative review and acceptance still open. Every
new nonempty map is refused before clock, ID, retry or transaction entry. Omission
and explicit own `undefined` preserve exact legacy JSON; an explicit empty ordinary
or null-prototype map clears it transactionally. New rows use canonical empty JSON.
Trusted store reads preserve genuine legacy maps; actual provider HTTP requests and
public human/JSON projections exclude them. Read corruption remains loud through
a fixed content-free diagnostic, including verbose rendering.

The new DB regression file first ran against the ungated writer: **18 passed /
38 failed**, all intended assertion failures, before the fix. After the fix its
**56 cases**, the existing **11 store cases**, **18 actual-SDK HTTP cases** and
**47 command/mapper cases** pass. Six declared causal controls extend the existing
secrets family to **41 controls / 276 required named witnesses**, preserving the
previous 35 declarations and workloads. Declaration and focused tests are not
physical mutation acceptance; full author gates, fixed/removal/restored execution
and two NEW complete clean cumulative review rounds remain required.

No migration, automatic legacy scrub, keychain copy, new clear command or live
header feature is introduced. `remove-key` does not clear headers. Logical empty-map
clearing does not establish physical erasure from SQLite/WAL/backups. Future header
activation remains gated by ADR-0108's custody, schema, precedence and recovery
prerequisites. No new ADR approval, provider capture, credential or user decision
is pending; Step 8 whole-wave certification remains open.

**Pre-review author gates:** uncached lint/types pass all 17 tasks; ordinary tests
pass all 11 tasks (**562 files / 12,365 passes / 13 existing skips** on macOS).
All six uncached builds, formatting, tooling types/lint, DB sync, isolation, SDK
fence, engine dependency and bundle closure checks pass. Compiled CLI/media
packaging, overflow and replay smokes pass; replay retains 16 refusal prefixes,
two legacy positive controls and zero fetches. All 185 acceptance-tool tests pass.
Cumulative document checks cover 51 Markdown files and 2,695 relative links/anchors
with no findings; 20 pre-existing ADRs remain append-only. Physical matrices and
independent cumulative implementation reviews follow the committed snapshot.


#### Step 7 first review correction — 2026-10-13

Three independent complete cumulative reviewers inspect all 20 changed paths at
`01259d12`. They corroborate one living-status error: the Step 7 header progress
was attached to D12 (filesystem) rather than D13 (provider headers). D12 now links
its accepted Step 2 implementation; D13 states the implemented interim gate with
review/acceptance pending. No runtime/security defect is verified. Independent
focused executions pass 132 and 194 overlapping cases; a separate tooling reviewer
passes 114 cases and verifies all previous 35 declarations unchanged. These
finding-bearing reviews are not clean acceptance rounds.

The complete local secrets matrix passes **41 controls / 123 phases / 8,445
executions / 653 reported removal failures**, with unchanged developer bytes,
identical inventories and byte-exact restoration. The six new controls contribute
732 executions and 66 failures. This invocation did not export raw physical
artifacts; its summary is not an independent artifact audit. The current-head
GitHub run exports that evidence for separate verification. Two NEW complete clean
cumulative review rounds and published gates remain required.


### Step 7 review completion — 2026-10-13

After the D12/D13 correction, two NEW complete cumulative rounds (R2 and R3)
independently inspect all twenty paths from Step 6 acceptance metadata `e405a5dd`
through `3a6f3cc4`. Trust, consumer and tooling/document partitions are clean in
both rounds. Root reads all six full reports. The second tooling round repeats its
unchanged failed scratch-inventory test after the competing capture joins; that
isolated rerun passes, without calling the earlier full invocation green. The third
round passes all 121 then-current acceptance-tool tests in its scoped invocation.

At exact runtime/document head `01259d12`, Root and independent reviewers decode
the full exported secrets evidence from CI run 38335121918: **41 controls / 123
phases / 8,445 executions**, 650 ordinary assertion failures plus two Vitest
rejection-expectation assertions, zero collateral failures. All twenty new required
witnesses pass; the six new controls contribute 732 executions and 66 intended
assertion failures. The retained 745 files / 25,003,046 bytes include exact packed
manifests, loader receipts, stdio, native joins and restoration. Source pins match
Git; remote installed dependency bytes are verified through retained pins/receipts,
not locally rehashed. The local matrix's 653 failures are a separately attributed
platform result, not substituted for the remote 652.

`01259d12` to `3a6f3cc4` changes only two roadmap documents. Subsequent Step 8
hygiene distinguishes three inherited query-title pairs and rejects duplicate
(file, case) evidence identities, preserving every case body. Step 7 implementation
reviews are complete; its published required aggregate and final whole-wave gates
remain separately pending. No new approval, provider or credential is required.

### Step 8 certification checkpoint — 2026-10-13

Four new [security sittings](../../standards/security-review.md#wave-2-sittings--filesystem-secrets-and-config-2026-10-13)
are clean; W4's hostile-MCP sitting is reused with fresh direct regressions. Their
focused executions and unchanged-scope revalidation do not replace exact-head CI
or physical evidence. Root also revalidates critical preview/persister/TUI controls
and all four display boundaries. Existing approved residuals retain their homes.

The inherited usage-query label pairs now distinguish expanded and subquery
predicates. Before the tooling repair, three negative duplicate-identity probes
fail with missing expected exceptions; afterwards all 21 outcome controls and 21
query tests pass. Read-only collection finds 885 distinct (file, case) identities
across 31 usage files. Collection is not physical execution. The permanent evidence
checker now rejects duplicates in every phase; neither original body is removed.

Fresh full `pnpm run ci`, bare `pnpm coverage`, `pnpm coverage:enforced`, native
Windows/floor jobs, exact-head complete causal audits and two NEW independent whole-
wave cumulative review rounds remain required. Exit criteria 1–3 and the D sign-off
will be scored after those gates. Full Phase 2.5.5, M2.5.5-2's I half, Phase 2.6 M/N,
later Waves 3–7 and existing approved deferrals remain open. This checkpoint creates
no new deferral and claims neither Wave 2 acceptance nor merge.


<a id="wave-2-individual-dispositions--certification-in-progress"></a>

#### Wave 2 individual dispositions — accepted

All **forty distinct queue IDs** are accepted within their recorded limits.
The [closing register](#wave-2-closing-register--2026-10-13) joins all eight steps,
current W4 revalidation and final Step 8 review/gates to the wave/exit sign-off.
Earlier checkpoint statements of open work remain historical; this inventory
retains each implementation and residual's canonical home.

| ID | Owner / accepted implementation home | Verified disposition and limit |
| --- | --- | --- |
| G19 | D; W4 reused, S8 revalidation | Prior closed W4/PR87: same/cross-layer name collision refuses. Re-run actual resolve tests; no downgrade to warning-only. |
| #202 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: definitions sanitized including schema presentation, semantic controls refuse, model-visible provenance. tool-mapping + actual agent-session request witnesses. |
| #35 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: whole connect window, authored connect timeout, cancellation. deadlines/agent/config controls. |
| G32 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: bounded network transport startup; do not certify remote websocket support. |
| #205 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: bounded/configurable stdio startup, not SDK fixed-default-only. |
| G33 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: transport/discovery ingress bounds; mcp-fetch + ingress-bounds controls. |
| #201 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: aggregate tool/count/description bounds, paging stops, adversarial 50k catalog. |
| #209 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: schema embedded string bounds; compiler moved to shared later—exercise current consumer. |
| #288 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: result text bounded at hostile boundary; no upstream-only assertion. |
| #203 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: structured server/tool fields; actual errors/taxonomy controls. |
| #204 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: shape-derived reason covers every egress code. |
| #206 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: bad args fail loud rather than substitute undefined. |
| #207 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: actual rejecting adapter close reaches onCloseError; no swallowed error. |
| #297 | D; W4 reused, S8 revalidation | Direct per-adapter tests satisfy incidentally. W4 explicitly leaves a per-file coverage-threshold question unclaimed; do not assert a new threshold. Record actual direct coverage/tests and this qualification. |
| #208 | D; W4 reused, S8 revalidation | W4 accepted; current regressions pass: host-supplied version, real server handshake in network-adapters.test.ts. errors.test.ts was the historical incorrect attribution. |
| #36 | D; S2 shared/CLI | Accepted S2 credential read/write/discovery floor in all tiers; lexical/canonical aliases, prune before descent, Terraform standard credentials included. |
| #39 | D; S2 shared/CLI | Accepted S2 shared declared-env floor across process and MCP declarations; no duplicate host list. |
| #235 | D; S2 shared + CLI/DB | Accepted S2 injected platform-free ancestor helper through tool fs and native save_to. CAS uses separate physical identity checks; do not claim it calls this helper. |
| #113 | C; S2 DB | Accepted S2 drive-relative rejection before save_to I/O, including C:relative, with native/platform evidence. |
| G21 | D; S2 CLI | Accepted S2 removes dead global tmp provisioning and supplies exact host scratch descriptor prerequisite. Existing directories not deleted; no shipping ordinary-chat allocator. |
| #1 | D; S2 CLI | Accepted S2 workflow AND agent catalogs: pre-enumeration/opened-file containment, regular/bounded files, contained aliases positive. |
| #27 | D; S3 CLI secrets | Step 3 accepted: direct native-binding mocks, get/set/delete constructor/operation faults, private cause preserved, fixed public errors/human/JSON/verbose sentinel absence. No real locked-keychain or native-load claim. |
| #31 | D; S3 CLI secrets | Step 3 accepted: aggregate 65536-byte reader cap before retention/copy, exact/+1 and single oversized chunks; faithful split Unicode/whitespace; iterator cleanup. |
| #293 | D; S3 CLI secrets | Same S3 reader plus actual provider/gate consumer tests; trimming belongs to provider boundary. Gate/provider may need prior DB open; no zero-history claim for these consumers. |
| #196 | B; S3 LLM/CLI | Step 3 accepted: finite query-name families, opaque sentinels and benign near-name controls; fixed surfaced errors. Encoded names/arbitrary content not covered. |
| #25 | D; S4 CLI run/core/DB evidence | Implementation reviewed: reject every explicit secret-typed --input (even empty), add boolean --secret-inputs-stdin, share gate parser, no invalid-input key/provider/history/MCP side effects, masked persisted slots; ADR0107. |
| #30 | D; S5 CLI/history/docs | Implementation reviewed: bounded value-free best-effort literal warnings at create/import/run; faithful admitted MCP-augmented snapshot retained; classify sensitive plaintext in canonical database reference. |
| #80 | A; S5 core export + CLI | Implementation reviewed: explicit continuity/review notice on real export surfaces, preserve scaffold semantics and machine stdout. |
| #81 | A; S5 reuse W7 + S8 certify | Existing ADR0095 content-free model-tool structure controls; producer→SQLite→export actual refusal, no raw result opt-in and no universal transcript masking. |
| #83 | A; S5 core export | Implementation reviewed: deterministic NFKD/combining mark normalization, dotless-i/sharp-s mappings, legal ASCII slug or exported-session-<session-id>; no universal transliteration claim. |
| #115 | C; S5 reuse W7 + S8 certify | Strict session rows and producer→SQLite→export rejection; document user/assistant/@/! retained content and legacy refusal; no silent scrub migration. |
| G22 | A; S5 core analysis | Implementation reviewed: reject unsupported direct secrets.* context references at parse while preserving legitimate secret-input→credential context and transitive text-sink restrictions. Not blanket ban on secret context, no acceptance of Proposed ADR0060. |
| G31 | D; S5 filing + S8 revalidation | Existing DNS background-work follow-up now explicitly filed in deferred-tasks.md (80–93). Verify caller cancellation/fixed error/late-connect guards; no new resolver, no native DNS abortability claim. |
| #111 | C; S6 DB both stores | Implementation reviewed: independent inline put limits (256KiB image/audio; no video/document), cumulative 25MiB putStream, exact/+1 before excess copy/hash/write. |
| #108 | C; S6 DB + CLI | Implementation reviewed: ownership-aware 24h temp GC, crash/claim recovery/live-writer/PID uncertainty/two sweepers; explicit narrow legacy-offline maintenance. |
| #112 | C; S6 DB both stores | Implementation reviewed: pre-abort and in-I/O readRange cancellation; bounded opened-fd legacy reads; no streaming delivery claim. |
| #107 | C; S6 fetch/store | Implementation reviewed: declared/header/independent body evidence, finite reviewed formats/aliases and compatibility; missing/octet-stream excludes PCM. |
| #109 | C; S6 DB/core ports | Implementation reviewed: independent descriptor/recordObject checks; every occurrence and handle-only admission before dedup; immutable tuples/durations and transactional pre-append metadata admission. |
| #110 | C; S6 docs/code | Implementation reviewed: remove stale non-persisted-MIME comment in same verified media change; canonical references match real metadata. |
| G20 | D; S7 DB/provider/CLI | Implementation reviewed: all new nonempty maps refuse before SQL, omission preserves genuine legacy, {} clears, no resurrection; typed content-free structural-guard error; inert wire/public projections. This closes design/interim gate only. |

D12's general filesystem predicate is accepted with invocation authority and the
scratch-floor prerequisite; complete M/N child lifecycle remains open. D13 uses
the approved interim gate, with live header activation prohibited pending custody
and migration prerequisites. D14 and Wave D15 use ADR-0095/0098 structural tool
content, not a raw-result export opt-in or universal masking. D17 is four new
sittings plus reused W4. No new user decision or deferred item is introduced.

Exit 1 revalidation covers #91's redacted approval preview/real dispatch positive,
#228's atomic persister and surfaced background failure, and #56's real Ink hostile
frame. Exit 2 covers actual run TUI, final summary, universal error renderer and
human-gate card, preserving machine escaping and the documented error exception.
Exit 3 reuses W4's definition/config trust boundary with current complete tests.
The D acceptance is traced in full: untrusted definitions/results, collision
**refusal**, bounded configurable connect/discovery/frames, catalog containment,
shared credential/env floor, existing permission self-heal, bounded faithful input
and first-run argv refusal, shared ancestor use in tool fs/save-to (CAS has separate
identity checks), structured diagnostics, snapshot lint, native-bridge mocks,
fail-loud args/teardown, direct adapter controls with #297's unclaimed floor, G20's
interim enforcement and G31's explicit residual filing. Formal sign-off waits for
final author gates and both NEW complete whole-wave rounds. M2.5.5-2's **D half**
is the relevant milestone slice; its I half and phase exit criteria 4–8 remain open.


### Step 7 acceptance — 2026-10-13

**Accepted on `development`.** The two NEW clean complete cumulative R2/R3 rounds
at `3a6f3cc4` cover every one of the twenty Step 7 paths. Its exact implementation
head `01259d12` passes all nine jobs in [CI run 38335121918](https://github.com/HodeTech/Relavium/actions/runs/38335121918),
including the required success-only aggregate, native Windows and the forced Node
22.13 floor. Complete 41-control secrets evidence is independently audited by Root
and tooling reviewers as recorded above. The only successor changes at the review
head are two roadmap corrections; later Step 8 hygiene changes test identities and
the evidence checker, without altering the accepted provider runtime.

The canonical [interim provider policy](../../reference/shared-core/database-schema.md#interim-provider-header-policy)
is implemented: pre-side-effect refusal, exact omission preservation, explicit
logical clear, trusted validated legacy reads and actual SDK/public/verbose
exclusion. There is no automatic migration, physical erase or live-header feature.
Future custody/schema/egress/precedence/recovery prerequisites remain binding.
Steps 1–7 are accepted; whole-wave Step 8 remains separate.

### Step 8 first cumulative review and correction — 2026-10-13

Three NEW independent reviewers inspect all **291 cumulative paths** at `a75209ad`
against `664336c2`: contracts/stores 110, CLI/security 91 and tools/documents 90.
The first two partitions are clean; tooling verifies one Medium live-status error.
Three deferred-task rows still mark accepted Step 2 invocation roots and the scratch
floor prerequisite pending. Those rows now link acceptance and close only the
implemented prerequisite, retaining full M/N and production provisioning/isolation/
join/cleanup/recovery. This is a documentation correction, not a new deferral or
runtime change. **R1 is finding-bearing and is not counted as clean acceptance.**

Root reads all three complete reports. Independent focused executions pass 138
cases in eight contracts/native files and 1,656 cases in seventy CLI/MCP files,
with two established platform skips. These are overlapping review executions,
not a unique whole-suite total. Tooling independently audits both complete prior
`01259d12` filesystem and secrets artifacts, all forty distinct ledger IDs and the
full document/link/append-only inventory. Exact-source final author/publication
evidence retains its own attribution. Two NEW complete clean cumulative whole-wave
rounds after this correction remain required before Step 8 acceptance.


#### Step 8 frozen-source author gates — 2026-10-13

At exact committed head `a75209ad`, fresh `pnpm run ci`, bare `pnpm coverage` and
`pnpm coverage:enforced` all pass. The ordinary/coverage inventories are **562 files /
12,364 passes / 14 established skips** under `CI=true`. Broad Turbo lint/types,
test/build and build/format groups contain respectively 12/17, 9/11 and 5/7 cache
hits; these commands are not called uncached. Both coverage executions are fresh.
Bare coverage enforces the core/LLM/MCP line-and-branch floor; the separate enforced
command retains its documented LLM/MCP enforcement with core measured. Bare package
line/branch results are core 96.62/90.74, LLM 97.69/95.51 and MCP 96.17/90.53.

All **188 acceptance-tool tests**, fences, isolation, DB sync, CLI/media packaging,
overflow and 16-refusal/two-positive/zero-fetch budget-replay smokes pass. Complete
local filesystem and secrets matrices execute 99/297/5,115 and 41/123/8,445
controls/phases/cases, with 255 and 653 reported removal failures respectively;
local summary-only results are not substituted for published physical audits.
At the same head, current published wire/usage/secrets/filesystem artifacts are
independently audited. Their final counts and family-specific qualifications belong
to the closing register; the success-only aggregate is still pending at this
checkpoint. No code changes are made to obtain this documentation correction.
Two NEW clean complete cumulative whole-wave rounds remain required.


### Wave 2 closing register — 2026-10-13

> Current disposition — 2026-10-15: Steps 1–8 and maintainer corrections are complete on `main` after PR #94 merged. The [merge checkpoint](#wave-2-merge-checkpoint--2026-10-15) joins final source reviews and execution; the dated evidence below retains its original scope.

**Original acceptance — 2026-10-13: Steps 1–8 accepted on `development`, before merge.**
This is the joint Phase 2.5.5/2.6 “Shut the doors” wave. It does not reopen the
merged Phase 2.6.5 W2/W8 interlude or close all of Phase 2.5.5/2.6.

The [forty-ID disposition ledger](#wave-2-individual-dispositions--certification-in-progress)
joins each queue item to its accepted implementation or reused W4 controls. The
four new [threat sittings](../../standards/security-review.md#wave-2-sittings--filesystem-secrets-and-config-2026-10-13)
cover filesystem boundaries, secrets input, secrets at rest and config trust.
W4's hostile-MCP sitting is reused with current direct and actual-SDK regressions.
There are four new sittings, not five new reviews of the same class.

| Step | Accepted result and controlling evidence |
| --- | --- |
| 1 | Corrected canonical trust contracts and finite causal-control foundations; [acceptance](#step-1-acceptance--2026-10-12). |
| 2 | Invocation-authorized filesystem roots/selectors, shared ancestor walk, credential floor, catalog containment and scratch-floor prerequisite; [acceptance](#step-2-acceptance--2026-10-12). Full M/N lifecycle remains open. |
| 3 | Bounded owned secret stdin, native-bridge failure privacy and finite URL-query scrubbing; [acceptance](#step-3-acceptance--2026-10-12). |
| 4 | Secret argv refusal and bounded first-run stdin delivery, native masked history and resume resupply; [acceptance](#step-4-acceptance--2026-10-12). |
| 5 | Faithful-snapshot warnings, structural session/tool-content refusal, context secret analysis and export continuity/slug/notice delivery; [acceptance](#step-5-acceptance--2026-10-12). |
| 6 | Bounded structural media verification, descriptor/admission authority, CAS/temp/native lifecycle and explicit iterator ownership; [acceptance](#step-6-acceptance--2026-10-13). |
| 7 | Interim refusal of new nonempty provider headers, legacy preservation, explicit logical clear and SDK/public-output exclusion; [acceptance](#step-7-acceptance--2026-10-13). |
| 8 | Four new security sittings, W4 revalidation, per-ID/exit/D sign-off, fresh broad author and published physical controls, and two NEW clean complete cumulative rounds after the R1 correction; evidence below. |

#### Final independent cumulative review

R2 and R3 are two NEW complete clean cumulative whole-wave rounds at
`cfae361adebfadf7e354b79907330758275e64e5`, after the R1 live-status correction.
Each round uses three new independent reviewers: contracts/stores (110 paths),
CLI/security (91), and tooling/docs (90), covering all **291 distinct cumulative
paths** against `664336c2794622c2b940be823966eddc9d61423d`. Critical partitions use
`gpt-6-astra`/high; tooling/docs uses `gpt-6.1-sol`/high. Root reads all six full
reports and reconciles disjoint manifests, actual inspected ranges and exact hashes.
Every cumulative hunk, complete new/security primitive module and relevant
contract/caller is covered; unrelated unchanged historical test bodies/registers
are not recertified. No verified actionable finding remains.

Fresh scoped R2 evidence includes five native/source workers, all fifty assigned
CLI files (1,292 passes, two established Windows-only skips, with two temporary
alias collection faults corrected and completed separately), and 178 tool tests.
R3 independently passes 29 source/native files (613 tests, zero skips), sixteen
CLI files (572 passes, two Windows-only skips) and 181 tooling tests. R2/R3 tools
reviewers also independently inspect retained physical artifact joins. These
focused cohorts overlap other executions and are not added to whole-project
unique counts. R1 remains finding-bearing; failed probe/setup invocations retain
their disclosed limits rather than being promoted to passing evidence.

Detailed reports remain ignored/local. Final publication metadata is reviewed
separately; it does not replace these complete product rounds or relabel prior
CI execution as a new run at a Markdown-only successor.

The R1 live deferred-status finding is corrected: accepted invocation-root and
scratch-floor prerequisites no longer appear pending. Full Phase 2.6.M/N and
production allocation/isolation/join/cleanup/recovery remain open. Earlier dated
checkpoint statements describe their original state; new landing notes in all
25 affected ADRs point to this register without rewriting the decisions.

#### Exact-source author and publication evidence

At exact committed source head `a75209ad`, all three author commands pass:
`pnpm run ci`, bare `pnpm coverage` and `pnpm coverage:enforced`. Ordinary tests
and both fresh coverage executions retain **562 files / 12,364 passes / 14
established skips** under `CI=true`. Turbo lint/types, test/dependency and
build/format groups contain respectively 12/17, 9/11 and 5/7 cache hits; they are
not described as uncached. Bare coverage enforces the core/LLM/MCP line/branch
floors: core 96.62/90.74, LLM 97.69/95.51 and MCP 96.17/90.53. The separate enforced
command retains its documented LLM/MCP enforcement, with core measured.

All 188 acceptance-tool tests, source/dependency fences, isolation, DB sync,
formatting, bundle closure and compiled CLI/media packaging/overflow/replay smokes
pass. Budget replay retains sixteen refusal prefixes, two legacy positive controls
and zero fetches. Complete local filesystem/secrets matrices retain 99/297/5,115
and 41/123/8,445 controls/phases/cases; their 255 and 653 reported removal failures
remain local summary-only evidence.

At that same head, [published CI run 38338972257](https://github.com/HodeTech/Relavium/actions/runs/38338972257)
passes all **nine jobs**, including the success-only required aggregate, all four
complete causal families, native Windows, official Node 22.13 and coverage/peer
checks. The forced floor and published enforced coverage retain the same
562/12,364/14 inventory. Windows executes the native DB/concurrency/filesystem/CAS/
media/packaging/headless suites with sixteen established POSIX-only filesystem
skips; no unsupported-platform execution is inferred.

Root downloads and independently audits all four actual published artifact families
from `a75209ad`; no predecessor artifact is substituted:

| Family | Complete physical result |
| --- | --- |
| Filesystem | 99 controls / 297 phases / 5,115 case executions; 255 removal failures = 248 ordinary assertions, four Vitest rejection-expectation assertions and three separately traced secondary effects. Required semantic witnesses and complete fixed/restored inventories pass. 1,789 files / 32,560,048 retained bytes including envelope. |
| Secrets | 41 controls / 123 phases / 8,445 case executions; 652 removal failures = 650 ordinary assertions and two Vitest rejection-expectation assertions, zero collateral failures. All 276 required named witnesses pass. 745 files / 25,002,129 retained bytes including envelope. The local 653 count is separate. |
| Wire | Four controls / nine phases including shared baseline / 216 executions over the same 24-case inventory. All 36 primary semantic assertions fail as intended; fourteen secondary assertions and six normalized provider refusals are individually qualified. 12 files / 143,985 retained bytes. |
| Usage | 23 mechanisms / 3,303 mechanism-phase executions plus 435 permanent cases = 3,738 total executions; 227 semantic failures. The permanent cohort joins 71 native children and one intentional readiness-timeout control. All phase/permanent identities are unique. 1,209 files / 96,604,425 retained bytes including envelope. |

Filesystem source pins join 1,128 exact Git blobs, 297 packed manifests, 458
installed dependency packages and 21,013 dependency-file pins; secrets joins
1,120 source blobs and 123 packed manifests. Usage independently verifies all
1,100 source pins against Git and seventy exact process-record joins. The bounded
artifact sizes are physical audits, not declaration projections.

The earlier Step 6 usage summary's “plus 435 permanent cases” describes the
permanent cohort already included in its 3,738 total; it is not 435 additional
executions. The exact arithmetic is 3,303 mechanism-phase + 435 permanent = 3,738.

Each physical family retains its own exact source-head attribution. Current
usage phase/permanent `(file, case)` identities are unique, including both bodies
of the three inherited query-title pairs. Fixed/restored suites are complete and
green; removal failures require their declared semantic witnesses. The three
filesystem secondary effects and the wire normalized refusals are qualified
consequences, not substituted for the required witnesses. Previous selected,
interrupted or cancelled runs do not certify the complete matrix.

Source pins are checked against exact Git blobs. Packed manifests, loader/body
receipts, process/native joins, complete inventories and restoration are checked;
filesystem/secrets stdio digests are reconstructed. Usage retains bounded UTF-8
stdio and exact process-record joins without claiming an independent remote
stdio digest. Remote installed dependency bytes are not locally rehashed; their
captured pins and executed loader receipts are verified. Wire installed SDK byte
inventories match an independent local capture; a differing local shared build
is not substituted for the remote build. Documentation-only successor commits
are not relabeled as new execution at a different head.

#### Exit criteria 1–3 and sub-stream D sign-off

| Obligation | Accepted disposition |
| --- | --- |
| Phase exit 1 | All three critical findings are closed and directly regression-tested: #91 actual preview redaction, #228 persister failure/atomic history, #56 real Ink `RunApp` sanitization. W1/W7/W8 fixes are revalidated rather than reimplemented. |
| Phase exit 2 | All four human boundaries are exercised: workflow TUI, persisted run summary, universal error presentation and human-gate card. Machine JSON preserves ordinary content through escaping, with its documented lossy error exception; there is no universal content-scrubbing claim. |
| Phase exit 3 | MCP tool-definition sanitation/provenance and config name-collision **refusal** are verified, including actual model-visible tool mapping, shared schema boundaries and current config/consent regressions. |
| D acceptance | The complete 2.5.5.D paragraph holds under its approved refinements: bounded startup/catalog/ingress/results; structured errors; credential/env floor; all filesystem/selector/catalog consumers; current permission self-heal; secret argv/stdin controls; faithful snapshot warning; interim header gate; direct network-adapter tests and actual version handshake. #297 does not claim a new per-file coverage floor. G31 is filed with its bounded DNS-cancellation residual, not silently presented as fixed. |
| M2.5.5-2 | The **D half** is accepted. Its I half, decomposition work, later Waves 3–7 and formal whole-phase exit criteria 4–8 remain open. |

No new deferral is created. Existing CR-70/CR-93/CR-94/CR-95, W3 capacity,
W4 DNS, media range/heap/format and other approved residuals retain their severity,
triggers and canonical [deferred homes](../deferred-tasks.md).
Filesystem guarantees assume cooperating owner-controlled storage; there is no
hostile same-user isolation or OS subprocess jail. The scratch descriptor/floor
is not a production allocator. Media profiles are finite structural checks;
PCM is qualified, and playback/full decoding/malware inspection are unclaimed.
Native iterator ownership is exact-object/private-module provenance: explicit
wrapper adoption, one loaded shared domain and trusted EOF/Promise obligations
remain binding; foreign iterators do not inherit native authority. Secrets scans
are finite; retained user/model/attachment/shell/run/snapshot content and legacy
header rows can be sensitive. Logical clearing is not SQLite/WAL/backup erasure.
Future live headers require custody/schema/egress/precedence/recovery work.

No ADR approval, billing, key, provider capture or user decision is pending for
this wave. The next engineering work is [Wave 3 — Clear the ground](../current.md#wave-3--clear-the-ground),
starting with its serialized multi-file queue and a fresh decision/document preflight.
This acceptance does not authorize implementing that next wave within this change.

### Post-publication recovery accounting correction — 2026-10-13

The first `84a2fddb` push [filesystem job](https://github.com/HodeTech/Relavium/actions/runs/38345819360/job/115126866456)
refused the restored native recovery concurrency case. The parallel PR matrix
passing does not clear that failure. A deterministic native-filesystem witness
and two explicit multi-process schedules establish a production reporting race:
a recovery can win the final empty claim-directory removal after retaining a live
peer, while both processes report zero removals. The original test is retained.

The correction implements the existing one-claim reporting contract at the final
native rmdir winner. The losing recovery recognizes raw or normalized directory
absence only after its own identity-checked marker removal; pinned-root revocation,
earlier ownership admission and substantive I/O still refuse. Two deterministic
process cases and two listing-disposition cases enlarge the complete temporary
suite from nineteen to twenty-three. Separate winner-accounting and absence
removals require both native race witnesses. The five existing temporary controls
run the enlarged suite; the declared filesystem matrix is now **101 controls /
303 phases / 5,313 case executions**. These are declared workloads, not a claim
that an earlier 99-control artifact executed the additional cases.

The [canonical maintenance contract](../../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
and dated [ADR-0106 correction](../../decisions/0106-media-publication-requires-bounded-verified-bytes.md#recovery-cleanup-accounting-correction--2026-10-13)
record the behavior without new deletion authority, minimum age or dependency.
The correction requires two NEW independent complete clean cumulative correction
review rounds and exact-head publication gates. Their [PR #94 publication record](https://github.com/HodeTech/Relavium/pull/94)
retains their separate source attribution; scoped correction reviews do not
relabel earlier whole-wave rounds or artifacts as fresh executions. The closing
register's `a75209ad`/`cfae361a` evidence remains its historical checkpoint.

### Native evidence journal capacity correction — 2026-10-13

Both `5021bc59` publication runs reported all 303 filesystem phases, including
the two new recovery removals and their restored 23-case suites. Export then
refused `Raw evaluation receipt file bound`; no filesystem artifact was retained,
and the required aggregate correctly refused publication. Passing phase log lines
do not substitute for the missing independently auditable artifact.

The former 99-control artifact already contained 1,969 raw process journals.
The enlarged native workload exceeded the 2,000-journal input count, which had
incorrectly shared the retained physical-file ceiling. The correction separates
the raw journal/segment count at 4,096 from the unchanged 2,000 physical output
files. Raw input, index/archive and retained evidence remain bounded by their
existing 64-MiB ceilings; paths, semantic witnesses, process/source joins,
phase inventories and timeouts are unchanged. Every original journal remains
losslessly indexed. The [tooling contract](../../../tools/causal-controls/README.md)
owns these independent limits.

Permanent boundary controls reconstruct all 4,096 synthetic PID/thread journals,
refuse 4,097 at both exporter and standalone verifier, and test physical output
exactly at 2,000 files and one file over, counting summary and envelope. The
earlier two recovery-review rounds certify their original source scope only.
This additional tooling correction requires two NEW complete clean cumulative
correction rounds and fresh published gates/artifact inspection; their separate
source attribution belongs in the [PR #94 publication record](https://github.com/HodeTech/Relavium/pull/94).

### PR #94 systematic review corrections — 2026-10-13

The maintainer's complete review of `395fbf95980aa1fd41e56156c93b9c2db120348c`
against `664336c2794622c2b940be823966eddc9d61423d` requested three corrections.
All three source repairs are now independently accepted. Original eight-step and
publication records retain their checkpoint attribution; the old artifacts'
physical consistency does not establish the repaired runner-error guarantee.
Current corrected-head publication evidence belongs to the
[PR #94 publication record](https://github.com/HodeTech/Relavium/pull/94), separately
from source acceptance and maintainer merge review.

| Increment | Confirmed finding | Required correction and evidence | State |
| --- | --- | --- | --- |
| 1 — R94-1 (High) | JSON-only Vitest reporting omits unhandled runner errors, so a named removal assertion can coexist with an invisible background failure. | Own a structured completed runner-error receipt, require zero errors before phase acceptance, and permanently exercise the real coordinator with a designated assertion plus a genuine unhandled rejection/exception. Refresh affected complete controls; old artifacts do not certify this repair. | Source accepted at `9664b7cc` after two NEW clean complete cumulative rounds (14 paths / 48 hunks each); final publication gates are owned by the PR #94 record. |
| 2 — R94-2 (High) | Valid OpusTags padding is refused after otherwise supported provider generation. | Consume the permitted bounded Opus tail after complete comment framing; preserve Vorbis framing. Pin fragmented packet/page positives, malformed negatives and actual store/installed-SDK publication. | Source accepted at `0269a78a` after two NEW clean complete cumulative rounds (23 paths / 61 hunks each); final publication gates are owned by the PR #94 record. |
| 3 — R94-3 (Medium) | FLAC nonfinal minimum and fixed block-size consistency are not enforced. | Validate the previous frame once a successor establishes that it is nonfinal; retain the legal shorter final frame. Pin fragmented verifier and actual-store refusal/acceptance pairs. | Source accepted at `f4ca3c53` after two NEW clean complete cumulative rounds (28 paths / 72 hunks each); 54 permanent cases and three isolated removal controls; final publication gates are owned by the PR #94 record. |

Each increment follows implement/regression/commit, independent review/fix/commit,
then a NEW complete cumulative review round. A material correction restarts the
two-clean-round requirement. Final correction acceptance additionally requires
current broad author/coverage/platform gates and independently inspected complete
filesystem/secrets evidence. Report counts and source pins remain attributed to
the head that actually executed them. Review records remain local/ignored.

These are repairs to accepted admission, structural-media and test-evidence
contracts, not new format profiles or policies. No new ADR, runtime dependency,
live provider request, credential, billing action or deferral is required. The
[canonical media profile](../../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
and [causal runner contract](../../../tools/causal-controls/README.md) own the
implementation details. Wave 3 remains subsequent work.

R94-1's author gate passed 269 acceptance-tool tests at its corrected bytes. Each
new runtime review independently passed all 202 causal-tool tests, including real
coordinator rejection, exception and hook contamination; separate evidence reviews
covered the entire same delta and adversarial raw/retained receipt boundaries.
Selected native-child fixed/removal/restored captures retained three completed
zero-error receipts each, independently joined to exact source/runtime/process
records. These scoped source gates do not replace the required corrected-head
full-family refresh or certify all original PR files again. R94-2 and R94-3 remain
separate increments.

R94-2's final affected cohort passes 42 tests: 24 verifier, four real-store and
14 installed-SDK publication cases. Both new runtime rounds independently execute
the selected exact-commit control: 42 fixed pass, 17 named removal assertions,
42 restored pass, with all ten required witnesses and three zero-error receipts.
Root independently joins every phase's source/runtime/process/reporter records,
restoration, installed dependency bytes and unchanged physical bounds. Each new
integration reviewer covers the entire same cumulative delta and independently
probes legal and malformed continued-packet boundaries. Full product lint/typecheck,
workspace tests and build pass at `0269a78a`; all six actual test tasks execute
freshly. The five cache hits among eleven tasks in that test graph are prerequisite
builds already executed in its preceding zero-cache lint/typecheck/build graph.
The separate final build graph reports five of six tasks cached. Their scope is source
acceptance; final corrected-head full-family/coverage/platform evidence is separate.

R94-3 adds 54 permanent cases: 25 verifier, 24 actual-store and five engine/CLI
publication cases. Minimum, fixed nonfinal equality and fixed final growth each
have an isolated removal control over the same complete 54-case cohort. Both NEW
runtime rounds execute all three at clean `f4ca3c53`: 54 fixed pass, respectively
18/9/8 named removal assertion failures, and 54 restored pass. Each round has nine
completed zero-error runner receipts. Root independently joins exact Git source,
raw runtime/reporter/PID evidence, all required witnesses, unchanged inventories,
restoration, installed dependency bytes and physical bounds. Each NEW integration
reviewer covers the entire same 28-path /72-hunk cumulative correction. Legal short
final frames and variable-size positive controls remain accepted; actual stores
and the engine/CLI metadata-before-append/grants-after-ACK path refuse malformed
streams. Event persistence in that CLI cohort is InMemoryRunStore; only metadata
is file-backed SQLite.

The three final source controls are selected captures, not complete-family evidence.
The causal source graph excludes `docs/**`; documentation acceptance uses separate
Git/hash inventories. The final two source rounds cover the complete correction
range `395fbf95` → `f4ca3c53`, not a new review of all 292 original PR paths. The
`193c4649` documentation-only closure preserves those runtime bytes. Final full CI,
bare/enforced coverage, native Windows/Node-floor results and complete filesystem/
secrets physical audits must be executed at the corrected publication head and
recorded in PR #94 before it is ready for maintainer review. A selected capture,
capacity projection, cached task or prior-head success cannot substitute for those
gates. No new decision, provider capture, credential or billing action is pending.

#### Corrected-head local review isolation — 2026-10-13

The first final bare coverage run at `193c4649` collected an intentional failing
review reproduction from ignored `docs/reviews/`: the 567 product files passed
12,454 tests with 13 established skips, but the extra reproduction failed and
raised its deliberate background rejection. That run is failed evidence, not a
coverage pass. Review files remain untouched. The root-anchored local-artifact
exclusion now reaches both test discovery and coverage, with an unconditional
marker-free probe and permanent removal/ownership controls; every real
source-adjacent test must still be collected in root and package modes. Coverage
thresholds, product includes and all existing exclusions remain unchanged.

This publication correction requires two NEW complete clean cumulative rounds
covering its configuration/guard changes and the final documentation closure,
plus fresh bare/enforced coverage and corrected-head full publication gates.
Their actual source pins and results belong to the PR #94 publication record;
this requirement does not upgrade the failed run or earlier selected captures.

#### Publication field-membership clarification — 2026-10-13

SonarCloud classified the two default string sorts in the receipt field-name
comparison as reliability bugs. The accepted operation is exact field-set equality,
not alphabetic or numeric ordering. Expressing it directly with Set equality
preserves the existing acceptance set and removes the irrelevant sorting operation.
A permanent regression accepts reordered valid fields and refuses a same-size
lookalike replacement of every field; existing missing/extra/duplicate field,
identity, completion, zero-error and coordinator contamination controls remain.
No receipt field or protocol version changes.

The local `3cfa2b7e` full-CI attempt was deliberately stopped through its owned
worker after this publication feedback; its coordinator joined and removed its
scratch. Its successful partial stages and earlier coverage remain attributed to
that head, not promoted to a complete CI pass. The final publication record must
join two NEW complete clean cumulative publication rounds, fresh current-head
local/remote gates and complete affected physical controls after this clarification.

#### Local cleanup-order control correction — 2026-10-13

The new runner authority refused `media-fs-store-local-first` during both Linux
publication jobs and local full CI at `9299e3fd`: its removal produced two
unhandled errors. Those failed, incomplete runs remain diagnostic evidence. The
old removal dropped the publisher await, accidentally abandoning its Promise and
also breaking natural EOF. The corrected control moves the source-close join
into the producer's verification-failure path before publisher cleanup, while
keeping the publisher awaited and preserving the primary byte failure. No
production behavior, case inventory, deadline or zero-error requirement changes.

The selected author capture runs the same six cases in all three phases: fixed
and restored pass; removal produces the named cleanup-order assertion plus the
related foreign-close assertion, with three completed zero-error runner receipts.
It is not complete-family acceptance. Two NEW independent complete cumulative
correction rounds and fresh final publication gates, including the entire
filesystem matrix, must join at the final source head in PR #94.

#### PR #94 lower-priority review corrections — 2026-10-13

The subsequent systematic review covers all 305 paths at `798192f2` against
`664336c2` and reports twelve Low findings plus three informational notes. Every
verified Low is addressed in three increments; none is deferred. The original
review scope and its remote-evidence limits are retained, rather than treating
that review as a new execution of the previously published CI artifacts.

| Increment | Report items | Correction and permanent evidence |
| --- | --- | --- |
| 1 — security floor and CLI refusals | 1, 2, 3, 9, 10 | Extend the existing Git credential floor to exact `config.worktree` and the shared declared-environment floor to AWS/Docker configuration aliases; correct the Windows path-display comment. Fixed session-persistence exit-2 diagnostics preserve row privacy and refuse before resume/export construction. Create/import notices follow successful writes. Real dirty-row and failed-write controls, lexical/canonical/discovery controls and separate worktree/environment removals pin the boundaries. |
| 2 — media conformance and reachable contracts | 4, 5, 6, 7 | Refuse FLAC partition equality and mandatory metadata violations, with independent fixed/LPC/Rice/escape/wasted-bit vectors and the published RFC Appendix D.2.1 fixture. The complete 138-case cohort reaches verifier, both real stores, legacy revalidation and engine/CLI publication. Remove only the unreachable retention variant and consumer cleanup branches; preserve the shared helper's native close-only failure. Installed-SDK selector tests pin 67 cases and the canonical contract states exactly which defined overrides refuse. |
| 3 — CI and live documentation | 11, 12, 14 | Distinguish historical 99-control capacity arithmetic from the current 109-control /327-phase declaration and 1,969-file projection under unchanged bounds. The Windows headless smoke requires the canonical EOF exit code as well as absence of raw-mode failures; permanent controls execute its actual workflow body. Root guides and the live roadmap agree with the already published npm v0.1.1. |

Increment 1 is source-accepted at `d98e18c2` after two NEW complete clean cumulative
rounds over 19 paths /33 hunks. Increment 2 is source-accepted at `70eafa12` after
two NEW complete clean cumulative rounds over 32 paths /80 hunks. These scoped
reviews cover the entire correction delta from `798192f2`; they are not another
whole-PR review. Increment 3 and the final combined source receive the same
commit/review/fix discipline. The PR #94 publication record owns their actual
reviewed-head acceptance and fresh final broad/platform/physical-evidence gates.
No earlier-head success, selected control or capacity projection substitutes for
those gates.

The first Step 2 cache-removal capture correctly refused an introduced test-cleanup
error: a failing identity assertion could abandon the new fixture's rejecting
native acknowledgement. `70eafa12` observes that acknowledgement before assertions
and joins it in `finally`. No product mechanism, test inventory or zero-error gate
was weakened. All eighteen affected selected mechanisms then passed 54 phases /
2,847 executions with 54 completed zero-error receipts at that head. They remain
selected evidence (`complete: false`), separate from the final complete family.

The Step 1/2 author logs execute all six actual workspace test tasks freshly. Their
five cache hits in the eleven-task test graph are prerequisite builds already
executed in the preceding zero-cache lint/typecheck/build graph; the final CLI
build also executes freshly. Step 2's broad 569-file /12,635-pass /13-skip run
precedes the final test-only acknowledgement correction; focused tests and selected
controls verify the latter, and final broad gates retain their own exact head.

Informational item 8 is a pre-existing narrowing revalidated by the event bus;
item 13 proposes coordinated CI-guard removal without demonstrating a defect;
item 15 is the accepted ADR-0108 interim legacy-read/runtime-write-refusal design.
They add no new implementation or deferral. Accepted decisions, format profiles,
permission authority, dependencies, timeouts and retained-evidence ceilings are
unchanged. The canonical [media contract](../../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106),
[CLI contract](../../reference/cli/commands.md), and
[causal runner contract](../../../tools/causal-controls/README.md) own the details.
Review records remain local and ignored. No new ADR approval, provider call, key,
billing action or user decision is required. Wave 3 remains subsequent work;
PR #94 and Wave 2 publication are separate from merge and full phase closure.

The final `77faa460` publication attempt exposed two stale secrets-cohort counts:
the new failed-write regressions made both create/import files eleven cases, while
their unchanged declarations still expected ten. Both remote secrets jobs correctly
refused the first enlarged cohort. The declarations and adjacent README now retain
the complete eleven-case files; neither a case nor a named witness is removed.
This confirmed cross-family finding invalidates that head's final clean acceptance.
Two NEW complete clean cumulative source rounds and fresh final gates are required
after the correction. The local full-CI attempt was stopped through its proven
owned Vitest worker; its coordinator joined and removed its scratch. Its completed
wire/usage and partial filesystem stages remain attributed to `77faa460`.

At the same head, the push Windows job passed, but the PR Windows job timed out
in two native CLI filesystem cases at their unchanged five-second limits. This
establishes a failed platform attempt, not a demonstrated product fault or a
successful rerun. The nine-file Windows CLI filesystem task now runs files serially
with one worker to reduce file-level contention; its exact file/case inventory,
individual deadlines and job bound remain unchanged. The actual workflow command
has a scheduling guard, and new native Windows runs remain the acceptance evidence.

### PR #94 additional systematic review — 2026-10-15

The maintainer's review of `992e6dab` independently reproduced two High valid-media
publication failures, a Medium scratch-policy composition defect, a Low exact-owned
marker cleanup defect and a qualified rooted-literal glob inconsistency. A second
report adds lower-priority compatibility, diagnostics and contract hypotheses.
These findings reopened correction acceptance for PR #94. Earlier clean source rounds,
CI/Sonar success and physical captures retain their historical heads; they do not
certify the newly demonstrated scenarios. The following implementation checkpoints
retain their dates; PR #94 owns the actual current source, execution and ready/merge status.

| Increment | Scope | Current gate |
| --- | --- | --- |
| 1 | Generated-result object preflight, bounded streaming and optional small-host compatibility; actual SDK/executor/engine/both-store publication. | Accepted source at `51140d48`: two NEW clean complete cumulative rounds, each covering 17 paths / 29 hunks with independently joined hashes. The selected current-head control has 3 phases / 54 executions and zero runner errors; full-family publication remains separate. |
| 2 | Vorbis setup bit framing, bounded structural traversal, allocation-free header CRC, extended MP4 sizes and unknown FLAC totals. | Accepted source at `ef256157`: two NEW clean complete cumulative rounds, each covering all 14 paths / 34 hunks. The 113 new regressions pass; original-source control has 15 expected assertion failures and one adjacent positive among 16 selected cases. Existing selected comment-count and Opus-tail controls pass 60 and 126 executions respectively (`complete: false`); corrected-head full publication remains separate. |
| 3 | Scratch-policy pin composition, rooted literal glob, complete write floor and exact-owned maintenance/recovery marker cleanup. | Accepted source at `e9717319`: two NEW clean complete cumulative rounds after the UNC repair, each covering all 15 paths / 47 hunks and five full new regression files with independently joined hashes. The 115 local passes / seven Windows-only disables and 307-file / 5,341-pass / ten-skip affected graph remain scoped author evidence; unknown-owner retention is unchanged. |
| 4 | Snapshot own-property preservation and supported-domain evidence, safe input diagnostics, concrete CI/evidence and document corrections. | Implementation complete, including the finite pin-error followup below. The first `b87462d2` round remains nonclean history. Two NEW clean complete cumulative rounds after the final material fix and actual corrected-source gates are required; PR #94 owns their current verdicts and execution. |

The [canonical publication contract](../../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns result bounds and finite format evidence. Request-message and direct-put
ceilings remain separate. The generated PNG regression reconstructs the retained
3,147,775-byte review fixture independently; macOS native decoding is separate
local evidence. Default TTS MPEG and Sora MP4 fixtures establish the declared finite
structural profile, without claiming decoded audio/video or paid-provider execution.

Increment 2's affected-workspace gate covers shared, LLM, DB, core and CLI: 557
files / 12,554 passing tests / 13 established skips. Its successful graph reuses
three unchanged test-task caches; core and CLI rerun after three legacy fixture
barriers were moved from direct put to the selected stream write. The same 162
engine cases and their original deadlines remain intact. Lint/typecheck, CLI
build, seam/dependency fences, formatting and relative-document checks pass.
These author gates are not final whole-project or platform publication.

Increment 3 retains the original opaque workspace, selected-root and invocation-grant
pins when attaching host-issued scratch. Forged/conflicting descriptors refuse;
lexical provenance and identity revocation remain authoritative. Literal globs now
admit their real parent directory. Marker acquisition keeps its native fd identity
through close, retires only its exact owned marker on failure and leaves recovery
directory counting to normal cleanup. Unknown ownership, replacement and revoked
roots remain conservative. Fixed read cancellation adds no caller-provided cause.
The Windows cohorts include the new filesystem and earlier media regressions; the
full DB cohort remains selected. These selections are not native Windows execution.

The increment 3 pre-UNC `eee9ca53` DB and CLI test tasks execute freshly under `CI=true`; the five
successful cache hits in their seven-task graph are prerequisite builds. Its four
skips comprise the existing Windows-specific and local-only scale guards plus the
new Windows literal-path case. Lint/typecheck, build, isolation, tooling, fences,
formatting and document checks pass. The initial lint refusal of an unsafe Vitest
matcher assignment is retained; removing that redundant pre-read matcher keeps
the original fulfilled-versus-rejected witness and actual content/path assertions.
These author results do not certify a native Windows run or final whole-project CI.

The first complete cumulative increment 3 review found the raw-UNC glob floor
interaction: Windows separator normalization bypassed the original lexical denial.
Literal parent support made the inherited wildcard hole reachable for literal paths.
The repair admits the raw spelling before normalization, covers equivalent native
Windows separators and preserves POSIX double-slash paths. Two original-`eee9ca53`
raw-UNC cases fail at their named assertion before this repair; the earlier thirteen
original-runtime failures retain their separate scope. New tests assert fixed fatal
refusal with zero asynchronous lookup, enumeration or byte access. Windows controls
remain selected rather than locally executed. The updated CLI test task runs freshly;
the unchanged DB test task reuses its successful cache. Five additional cache hits
are prerequisite builds. The five selected existing controls at `eee9ca53` pass
15 phases / 327 executions with zero runner errors (`complete: false`), and retain
that historical head. They do not replace corrected-head whole-family publication.

Unsupported noninert publication values already refuse under the current canonical
contract; increment 4 documents and pins that compatibility limit without invoking
caller serializers. Unknown maintenance ownership remains
conservative: recognizing no current owner is not deletion or maintenance authority.
Automatic unknown-owner discard would require an explicit approved decision.
MCP registration credentials remain runtime connection configuration; the augmented
workflow snapshot adds discovered tool grants, not resolved registration secrets.
The authored-definition notice retains its documented best-effort scope.

All four increments require committed regressions and two NEW independent complete
clean cumulative source rounds after their final material fix. Actual corrected-source
full CI, bare/enforced coverage, platform and physical-evidence gates are required
before merge. [PR #94](https://github.com/HodeTech/Relavium/pull/94) owns their current
source verdicts, execution publication and ready/merge status. The receipts below are
attributed implementation checkpoints, not a substitute for those actual outcomes. No new ADR, provider capture, key or billing action
is required for these existing-contract repairs. Wave 3 remains subsequent work.

Increment 4 preserves collection own data, nested media and alias accounting after
intrinsic Map/Set entries. Only array length receives the intrinsic descriptor rule.
The synchronous admission scan owns frozen primitive descriptors without cloning the
whole enclosing graph again; the held engine metadata-port control preserves the
existing ownership barrier, without claiming a measured allocation benchmark.
Reflection faults and compatible foreign admission exceptions cannot contribute
private diagnostic text: fixed local messages and closed own-data codes govern
classification, with cancellation first and native-iterator ownership unchanged.

The original runtime with six changed regression paths reports 135 cases: 94 pass
and 41 fail. Of those failures, 26 are named assertion failures and 15 are test-body
errors (including expected-own-data, rejected-promise and reflection witnesses),
not an assertion-only causal receipt or a runner-level zero-error certificate.
After repair, the eight focused files report 152 passes. The broad five-package
run reports 569 files / 12,745 passes / 20 explicit established/platform skips;
all five test tasks execute freshly and five prerequisite builds are cached.
The initial lint refusal of a control-character regex in a new test is retained;
explicit string checks preserve the case and its terminal-control expectations.
Lint/typecheck, build, isolation, tooling and seam/dependency gates subsequently pass.

CLI admission keeps unknown/duplicate raw argv keys and values opaque under
ADR-0107. Already-declared core input faults now show bounded sanitized labels and
structural value-free reasons before services start. A name grammar or finite
scrubber is not proof an arbitrary unknown key contains no credential. Provider
policy diagnostics use the canonical error constructor's own fixed message.
Serializer controls now prove literal transcript preservation and attribute the
structural signature/secret exclusion to its upstream boundary.

The new required post-workspace CI validator demands the actual bounded native DB
journal, matching parent/child identities, all ten workers/nine modes, original
readiness deadlines, transaction barriers and joined outcomes. Root's separate
local execution of the existing native fixture passes ten cases and produces 97
records (31 parent, 65 child, one setup), accepted by the real validator. Forty-six
Node diagnostics/physical-selection controls pass. This is actual macOS evidence,
not native Windows or remote CI certification. Historical filesystem/secrets budget
comments, the ADR-0065 dated section reference and CLI command freshness are corrected.

Other report hypotheses retain explicit dispositions: unknown maintenance ownership
remains conservatively blocking under its accepted contract; the zero-error reporter
has its documented finite completion window; total retained-file/byte caps are
verified at export; native child/source/dependency pins retain their cooperating-host
scope. Workspace serialization and physical packaging/source joins are intentional.
Published historical attribution, condensed guide numbering and ADR section style
are not rewritten. The separate pre-existing transcript-persistence observation is
not claimed repaired. These dispositions add no approved deferral or new decision.


### Increment 4 pin-error followup — 2026-10-15

Both independent increment-4 reviewers and the separate complete correction reviewer
confirmed the same remaining `NodeMediaPinError` prototype pass-through at `b87462d2`.
Their independently reported High/Low severities retain their original scopes; Root
reproduced the defect through the actual compiled engine and in-memory durable port.
A synthetic private message reached both delivered and persisted failures. No live
provider, user credential/history or native SQLite claim follows from that probe.

The repair records only finite engine-authored failures in a private immutable
node-bound capture. Prototype/constructor shapes and mutable public fields provide
no capture; wrong-node reuse refuses before external-field fallback. The dispatch
catch independently queries the capture. Existing per-node/run limit messages and
ceilings remain, all pin failures stay nonretryable, and cancellation remains first.

Four selected original-runtime controls fail at named assertions: the class capture
case and three real engine host/executor cases. The latter execute the synthetic
node three times under forged retry policy, instead of the expected one. The
reference host's work timers are driven explicitly after arming, without wall-clock
sleep. A preceding attempt with undriven manual timers timed out and is not causal
acceptance; an earlier title selector selected only the unit case. Those attempts
retain their limited scopes. Fixed controls report 52 passes across four files,
including finite factory/capture and direct JavaScript constructor-bypass controls.
The initial followup lint refusal of an unsafe reflection return and unknown Promise
rejection reasons in tests is retained; explicit unknown data and actual Error
fixture types correct those tests without changing the behavioral witness.

Followup author gates under `CI=true` pass core/CLI lint/typecheck, build, isolation
and architecture fences. Both test tasks execute freshly: 401 files / 7,979 passes /
ten explicit platform/CI skips; five successful cache hits are prerequisite builds.
The prior five-package and native-journal author receipts remain attributed to their
recorded working source. They do not certify this correction's final publication.

The initial `b87462d2` full local CI was stopped at an owned usage-control Vitest
worker after the finding. The coordinator and pipeline joined, and no owned worker
remained; retained failed-attempt diagnostics are not a completed family. Earlier
completed stages and remote runs keep their original source, without final acceptance.
Two NEW complete clean cumulative rounds now cover all four correction increments
together, including the entire increment-4 diff. PR #94 owns their actual verdicts
and the required final CI/coverage/platform/physical-evidence publication; the old
nonclean round contributes no clean acceptance. No new ADR, deferral or user action
is introduced, and Wave 3 remains subsequent work.

### Wave 2 merge checkpoint — 2026-10-15

[PR #94](https://github.com/HodeTech/Relavium/pull/94) merged to `main` at
**17:50:23 UTC (20:50:23 Europe/Istanbul)**, merge commit
`ab08209ea0fd4681a9ed760811c6b1acfc6501b9`. Its final reviewed head is
`4cdfe011fc62841e6daba3b39391d0d1e540c4dc`; the merge tree is byte-identical
to that source. **All eight Wave 2 steps and the maintainer corrections are
complete on `main`.** ADR-0105–0109 remain Accepted. The forty-ID
[disposition ledger](#wave-2-individual-dispositions--certification-in-progress),
[original closing register](#wave-2-closing-register--2026-10-13),
[first corrections](#pr-94-systematic-review-corrections--2026-10-13),
[lower-priority corrections](#pr-94-lower-priority-review-corrections--2026-10-13)
and [additional corrections](#pr-94-additional-systematic-review--2026-10-15)
retain their exact source scopes and historical receipts.

#### Completed scope

| Area | Complete on `main` |
| --- | --- |
| Filesystem authority | Invocation-only grants and narrowing selectors, credential floors, shared ancestor walk, catalog containment, exact scratch-floor prerequisite and composition, literal glob admission. |
| Secrets and config trust | Bounded owned stdin, first-run secret delivery and argv refusal, native bridge failure privacy, finite scrubbing and faithful-snapshot warnings. |
| Persistence and export | Revalidated structural session/tool-content refusal, secret-taint context sites, export continuity/slug and completion notices. |
| Media and native lifecycle | Verified bounded bytes before publication, CAS/temp ownership and recovery, explicit iterator provenance, generated-result streaming and valid Opus/Vorbis/FLAC handling. |
| Provider-header gate | Nonempty-map refusal, inert legacy rows, explicit logical clear and SDK/public-projection exclusion; live header activation remains gated. |
| Review corrections and evidence | Runner-error rejection, finite immutable node-bound pin diagnostics, safe declared-input reasons, native DB journal validation, all 151 filesystem/secrets anchors and complete refreshed controls. |

The four implementation increments from the 2026-10-15 review, including the
pin-error followup and final removal-anchor synchronization, have **two NEW
independent complete clean cumulative correction rounds** at `4cdfe011`. Each
round covers all **67 correction paths / 188 hunks / 24 complete new files**,
including the entire increment-4 subset (34 paths / 94 hunks / 11 new files).
These are scoped correction reviews, not a new review of every original PR path.
Original whole-wave acceptance and earlier correction rounds retain their separate
attribution. Root joined the complete reports and file/blob/diff inventories;
detailed review records remain local and Git-ignored.

#### Final reviewed-source execution

Full local `pnpm run ci`, ordinary coverage and enforced coverage pass at
`4cdfe011`. Both local coverage commands execute freshly and record **588 files /
12,983 passing tests / 20 explicit skips**. Published CI coverage records
**12,982 passes / 21 skips**, with the established additional CI-only skip;
thresholds are unchanged. Matching workspace/build/lint cache reuse is recorded
separately and is not described as fresh execution.

All nine jobs in each [push CI](https://github.com/HodeTech/Relavium/actions/runs/38771189079)
and [PR CI](https://github.com/HodeTech/Relavium/actions/runs/38771197426) pass,
including the required aggregate, Node 22.13.0 floor, native Windows and acceptance
jobs. SonarCloud succeeds with quality gate OK; demonstrated false positives have
individual reasons, with no rule/gate weakening. Other nonblocking maintainability
suggestions remain visible. PR checkout `24f66e27` has the same Git tree; literal-head
physical evidence comes from push CI. These results do not claim new execution
of the merge commit or this documentation-only successor.

Selected native Windows evidence includes DB 58 files / 1,031 passes, filesystem
12 files / 323 passes / 18 platform skips, and shared/CLI media 14/8 files /
399/87 passes, plus CAS, packaging and headless EOF4 controls. This is not whole-repository
Windows coverage. The required native DB journal contains 97 records, ten workers
and nine modes; actual identities, stages, original readiness bounds and joined
outcomes pass independent validation. All 321 acceptance-tool tests pass.

Complete local and literal-head push exports were independently inspected:

| Family | Controls | Phase records / case executions | Outcome authority |
| --- | ---: | --- | --- |
| Filesystem | 110 | 330 / 8,148 | 330 completed runner receipts, zero runner errors. |
| Secrets | 41 | 123 / 8,451 | 123 completed runner receipts, zero runner errors. |
| Wire | 4 | 9 / 216 | Same 24-case installed-SDK HTTP inventory. |
| Usage | 23 | 70 / 3,738 | Includes 435 permanent cases and 71 native children. |

Frozen Git blobs, exact removal bytes, complete inventories, named semantic
witnesses, restoration, process/runtime joins and retained bounds pass. Qualified
secondary removal effects cannot replace causal witnesses. Filesystem/secrets
retain their 2,000-file/64-MiB bounds; usage/wire retain their separate existing
20,000-file/256-MiB bounds and outcome authorities. Remote dependency pins/loader
receipts are joined without claiming local rehashing of remote installed bytes.
Earlier partial, failed, selected or prior-head runs do not count as final acceptance.

#### Exit status and next work

**Phase 2.5.5 exit criteria 1–3 and sub-stream D acceptance are satisfied on `main`
by PR #94.** M2.5.5-2's D half is complete; its I half remains open. Whole-phase
exit criteria 4–8, later Waves 3–7 and full Phase 2.5.5/2.6 remain open.
Full M/N production lifecycle, future live headers and existing approved limits
retain their [canonical deferred homes](../deferred-tasks.md); closure creates no
new deferral or architectural decision. Finite structural media verification,
cooperating-host filesystem assumptions, one loaded shared-module iterator domain
and sensitive retained content remain explicit.

Wave 2 has no remaining implementation, review, publication, ADR approval, provider
capture, key, billing or user-decision gate. Next is [Wave 3 — Clear the ground](../current.md#wave-3--clear-the-ground),
starting with its fresh document/decision preflight and serialized multi-file queue:
shared close handling, safe path presentation and exhaustiveness guards. The
remaining decomposition, viewport, shared-schema and CLI/process queues follow
their existing order; Wave 3's unresolved recommendations are not approvals.
This merge-status update starts no Wave 3 implementation and changes no release version.

### Wave 3 preflight and proposed execution plan — 2026-10-15

**Source baseline:** `development` at `702cdc9c59c688a48a240c2961bbf16b491e0ace`.
Wave 2 is merged; this is its documentation successor. Wave 3 is in document/decision
preflight, with no implementation accepted or started by this entry. The current
[Wave 3 queue](../current.md#wave-3--clear-the-ground) owns scope groupings and
later-wave boundaries; the numbered increments below own proposed execution order
and review gates. A/E/G/I above retain scope and acceptance. No release, new provider capture, credential or
paid test is required. Detailed working reports stay local and Git-ignored.

Three independently scoped agents examined CLI/process, shared/core and chat/Home/
viewport documents and actual sources/tests. The parent read their complete reports
and independently reran the source/QuickJS context-taint probe. Existing focused
checks passed 8 files / 260 tests (shared/core) and 5 files / 59 tests (CLI), with
no full CI, coverage, platform run or implementation acceptance inferred. These
preflight agents are not either of the two fresh implementation review rounds.

#### Preflight corrections and already-satisfied work

| Finding(s) | Current evidence and disposition |
|---|---|
| D10/G50, G38/G39/G47/G49, #91 | Existing typed budget guards, reservation/warning and redacted preview controls remain accepted; preserve, do not reimplement. |
| #75 | W2/CR-22 already derives remaining run deadlines. Preserve actual clock/cancel semantics. |
| #77/G48 | W8 closes the original stream-consumption blocker. Preserve ADR-0087's actual contract and approved exact-capacity residuals. |
| #211, G16 | ADR-0083 already validates input defaults/enums; W7 already enforces compaction-role/structural session rows on read and write. No legacy reader tightening. |
| #89/parallel half of #212 | Full WorkflowSchema rejects duplicate parallel members; exported leaf/union schema still needs consistent enforcement. Centralize without duplicate diagnostics. |
| G22, #80/#81/#83/#115 | Wave 2 context namespace refusal and W7/Wave 2 structural persistence/export/caveat/slug work are complete. The new context-to-JavaScript leak is distinct. |
| #78, #280 DB half | Checkpoint comments already name the tiered journal; DbOpenError already has fixed path-free messages. Remaining CLI open/error wrapping lands last. |
| #21 MCP half, #42 rejection half | W4 already reaps MCP and #228 already installs the recoverable rejection net. Remaining active-session abort and fatal/EPIPE/process-group work remain. |
| G36/G37/G46, #20 | Direct verbose and selector tests exist. Idempotent gate JSON routing exists but needs direct regressions. Revalidate, do not claim absent code. |
| G34/G44/#56/#57, G0/#50 | Wave 1 terminal sanitization and job-control/onboarding ordering are closed and preserved by Wave 2. |
| #93 | ADR-0105 already decides immutable host filesystem authority. Clarify descriptive dispatch tier; no per-turn grant expansion. |
| #216 | Remaining `success` is canonical event data, not an internal competing result shape. Keep the wire exception; no event rename. |
| #303/#304 | Exact catalog round-trip fixture already exists; revalidate it. Compiler assertion sites moved from MCP to shared in W6. |
| #125/D26 | Bare Home cannot invoke `/cost`; live in-Home chat uses the real shared DB-backed implementation. Proposed disposition is chat-only plus parity regression, not selection of an arbitrary historical session. |
| #274/#239 | Tested exported `validate:false` and the adapters subpath are public surfaces, not proven dead APIs. Proposed compatibility disposition retains/document them. Local dead exports #240/#241 can be removed after consumer audit. |

The old E paragraph's “Required ADR: none new” does not authorize changed public
CLI contracts, trust boundaries or distribution/storage decisions. The phase's
current exit criterion 8 applies. The old shared count of “seven remaining” and
the old god-file sizes are historical: current chat/Home/chat-ink are 2,822/1,604/
1,906 lines. The correct existing identifier comparator is shared `byCodeUnit`;
the token heuristic is now in LLM `request-estimator`, not an adapter module.

#### Decisions presented together before implementation

All entries below are **proposed**, not maintainer rulings. Approval covers the
concrete public/API/secrets plan as well as the new ADRs. No proposed choice silently
changes a currently Accepted ADR or a canonical reference before approval.

| Decision | Recommended choice and compatibility boundary |
|---|---|
| ADR-0110: D19/D20/D22, #13/#19/#309, G15/G35 | [Explicit CLI compatibility](../../decisions/0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md): retain quiet+verbose conflict; exact DEBUG=1 alias; preserve JSON/safety data; unexpected/output infrastructure exit 9 with distinct diagnostics; versioned explicit JSON help; alias-preserving pricing/chat syntax; key-delete consent; G15 refuted with durable-only replay preservation. Genuine run outcomes and exits 3–8/signals keep their contracts. D22's old two-exception shorthand must be reconciled to this explicit enumerated scope. |
| ADR-0111: #43/#44/#46/#271 | [Lazy packaged runtime](../../decisions/0111-cli-meta-operations-use-a-lazy-packaged-runtime.md): lightweight descriptor-only meta graph; engine-inlined finite chunks, complete closure guard and packed platform controls; exact-byte private sourcemaps. The maintainer selected public-recipient encrypted CI archival; GnuPG, pinned recipient and per-version ciphertext retention are proposed mechanics. Public plaintext artifacts are prohibited. |
| ADR-0112: G30/#34/#49/#52/#55 | [Operator-owned chat policy and preferences](../../decisions/0112-chat-network-grants-and-onboarding-state-are-operator-owned.md): global-only domain authority, exact DNS/deny-all/approval/SSRF floors; explicit unavailable-keychain acknowledgement with current-state recheck; truthful model-write recovery; non-retryable final-component link refusal and honest recovery; live monotonically narrowing invocation HTTP authority even after failed Home replacement. |
| ADR-0113: #92 and reproduced leak | [Declared-source context provenance](../../decisions/0113-secret-derived-context-keeps-provenance-at-public-sinks.md): reuse existing linear taint graph, preserve trusted raw resolution, qualify context/input provenance before executor/preparation; remove raw denied values, refuse templates and diagnose executed VM denied access with an explicitly finite latch; required owned projection. Record unsupported future tool mappings honestly rather than fabricate a producer. |
| D18, D26/#125, #311 | Keep chat-ink restructuring with Wave 5a; keep cost chat-only with both real surfaces tested; correct Commander parser-path token echo and add static help; preserve dispatcher privacy. These are explicit dispositions, not new features or undisclosed deferrals. |
| #89/#90/G18/#210/G17 | Apply missing duplicate/cross-field guards at leaf and full boundaries. Condition equality is typed (`true` differs from `'true'`; 0 equals -0). Duplicate fallback tuples are provider+model within the fallback list; do not forbid equality with the primary. Timeout without action retains default reject; action without timeout refuses. |
| G17 RunSchema detail | Preserve optional legacy timestamps and outputs. Reject completedAt on nonterminal states, startedAt on pending, and error outside failed; retain temporal checks. Terminal records need not invent timestamps/error fields. Do not adopt a stricter logical schema as a DB reader or migrate historical rows. Existing tests accepting contradictory present fields must change deliberately. |
| #213/#219, #217/#222/#239/#274 | Retain named event exports while sharing the actual exactly-one-correlation envelope validation without payload stripping. Add a minimal shared error base, preserving constructor/name/code/kind/reason/context/cause/guards and existing structural boundary checks; inventory current classes, not historical 15. Add ModelFeature with deprecated Capability alias; retain Accepted ToolHost *Capability names, use Port for new orchestration interfaces. Retain documented adapters/validate compatibility surfaces. |
| #95 tool input caps | UTF-8 byte limits: write content 8 MiB, HTTP body 1 MiB, git message 16 KiB; run args ≤256, each ≤16 KiB and aggregate ≤64 KiB. Add cheap length prechecks, real byte refinement and accurate model metadata. These are proposed new limits, not promises of OS command-line capacity. Refuse before approval/effect/host work. |
| #87/#82/#275 | Document system_prompt_append as literal, preserving taint scans and intentional brace text; do not activate Proposed ADR-0060 or interpolate instructions. Decode quoted argument quote/backslash escapes without eval or blanket Windows-path reinterpretation. Use an in-house priority structure preserving Kahn's authored-index order, with equivalence tests. |
| G4/#65/#64/#66/#63 | Bound input history to 500 and width memoization to 1,024 entries; 8-cell tabs before wrapping; latest-size frame coalescing with immediate narrowing safety, not stale-width debounce. Both chat surfaces enforce 80×24 and disable hidden affirmative approvals while retaining reject/abort/resize. No transcript trimming or new Unicode table. |

The live synthetic security reproduction is a declared secret input → context alias
→ bare JS transform → output. Three events expose the canary while run:started is
correctly masked. It is not covered by an approved deferral. The owning permanent
regressions and a dedicated secret-flow sitting must accompany its correction.
No credential values or request captures belong in tracked evidence.

#### Proposed implementation increments

| Step | Scope, finding IDs and principal verification |
|---|---|
| 1 | **Serialized multi-file queue first:** shared close handling #22 (four named siblings plus newer owned journal sites) → safe source labels #4/G11 plus #3's UTF-8 source admission parity → exhaustive session/picker/run switches #300/#301/G3 and actual reasoning rendering. Preserve primary outcomes and host-safe-close ownership. For #3, use the sibling 4× byte precheck plus authoritative parser character bound; test a dense multibyte source above the old byte cap but below the character cap, ASCII character overflow and true byte overflow. Add native error and mounted output regressions. |
| 2 | **Shared admission and diagnostics:** #89/#90/#212/G18/#210/G17, certify #211/G16; shared parser reason helper #85/#86 and config numeric bounds #32. Approved status/duplicate matrices, direct leaf/full parse tests and no value-bearing diagnostics. |
| 3 | **Secret provenance:** ADR-0113/#92, fresh/resume/preparation/condition/transform/merge paths, engine-owned context/input provenance and actual VM/template consumers; direct secret-input marker compatibility, finite denial latch and single serialized payload with exact result parity. Real SQLite columns, clean positives and historical-output limitation. Dedicated security sitting, no future mapping implementation. |
| 4 | **Error/envelope substrate:** #213/#219, actual migrated-class inventory and cross-bundle structural guards. Preserve exported names/discriminants, constructor/cause behaviour and event payloads. Convert only supported error classes, not vendor errors or plain seam unions. |
| 5 | **Tools and engine tails:** #93/#95/#96/#98/#97/#214/#221/#258/#259/#308, #94/#82/#87/#76/G9/#79/#274/#275. Bounds before effects, model-visible semantics, existing ordinal helper, path-local cycle guards, cancellation race and deterministic plan equivalence; certify #75/#78/#216 instead of rewriting them. |
| 6 | **Pure process/discovery substrate:** ADR-0110 categories, shared early flag grammar, explicit exit/site inventory, enriched descriptor registry with legacy/model and new CLI projections, one closed CLI code/origin authority, storage-boundary classification inventory and kind-specific invocation owner registry. Include caught/forced-exit owners and total observation priority. Contracts precede consumers. Unit/source checks do not claim fatal/native or JSON-help integration complete. |
| 7 | **Lazy runtime and package graph:** #43/#44/#271/ADR-0111, consuming Step 6. Guard dynamic imports from a lightweight entry; defer classifier/sanitizer/service barrels and MCP wiring; preserve filesystem → one seedFileCatalogOnce owner → DB catalog → model/cost ordering and media exception; explicitly test meta-only admission refinement. Finite flat chunks, all-output closure, real packed existing meta/run/chat/migration/identity and minimum-Node/platform controls. New JSON help waits for Step 10. |
| 7a | **Recorded split, 2026-10-16 — source/router and finite compiled graph:** exact sanitizer leaves, guarded entry/runtime imports, untouched compiled human meta and grammar controls, actual execution admission ordering, one invocation file seed and eleven current DB-owner/quote/media/fixture controls. One split ESM build, flat layout, entry-only shebang and every-output file/import/dependency closure. Preserve affected compiled workflow/media smokes. Two NEW complete cumulative clean rounds and a scoped security sitting are required. This accepts only the compiled graph, not installed packaging or whole Step 7. |
| 7b | **Recorded split, 2026-10-16 — exact tarball and required consumers:** independently inspect actual tar bytes/modes/public inventory; install the same digest outside the workspace; prove complete real chat/resume, workflow/migrations/native/CAS/MCP/class identity and invocation-context continuity. Required exact Node 22.0.0 and current-runtime Linux/macOS/Windows consumers aggregate the same artifact. Final cumulative reviews include all 7a changes from the Step 6 boundary. Whole Step 7 and ADR-0111's graph obligations close only after both increments; actual registered native-owner cleanup remains Step 8. |
| 8 | **Native process integration:** #40/#41/#42/#224/#269/G35 under ADR-0110, after the early graph can catch import failures. Wire kind-specific owners, output_unavailable/cli_internal 9, known storage/history/departure classification, run-only health precedence and session join uncertainty. Preserve recoverable #228/signals; MCP PID versus tool PGID/Windows, terminal restore before stderr, total remaining fatal budget, competing faults and both sinks. Minimal I/O adapters land here; central DB refactor stays last. No false host-safe-close ACK. |
| 8a | **Recorded split, 2026-10-16 — origin and inert native foundation:** private factory/I/O storage facts and read-only classification, fixed projections, observable registry termination and one live absolute budget through diagnostic ACK. Preserve actual migration/checkpoint origin at fixed native/vendor boundaries; no arbitrary cause-tree classification. Native fixtures explicitly install the coordinator; product activation waits for all creation owners. |
| 8b | **Recorded split — creation-owned native processes:** tool POSIX group versus MCP PID, actual close/retirement, verified absolute Windows teardown admission and helper lifetime; connect OS/editor helpers and replace independent reapers without claiming full descendant containment. |
| 8c | **Recorded split — workflow and render integration:** run/gate/budget/driver owners, real return/throw health priority, cancellation, terminal/job-control leases and force-quit routing. No timer certifies DB close or receipt settlement. |
| 8d | **Recorded split — sessions, terminal and activation:** fresh/resumed/one-shot/Home/pending/replaced session lifetimes, retained publication failure and shared actual cleanup promises; connect caught slash/rebuild faults, restore terminal custody before diagnosis, then activate early coordinator/background/sink integration. Actual native/platform/packed controls and complete cumulative Step 8 acceptance follow. |
| 9 | **Release map/custody substrate:** #46/ADR-0111, independently reviewed after the finite graph. Upstream TS maps, sole prepack final build, pre-hash trailer removal/staging, exact tarball/CLI+engine symbolication, encrypt-once candidate with permissioned prebuild discovery/reservation → pack/reuse → smoke → archive → npm → finalization. Required artifact/platform aggregation, all rerun modes, lost-staging refusal and permission-enforcing offline API controls. Dedicated archive/crypto security sitting. Fixture proof never claims production recipient/custody configuration. |
| 10 | **CLI behaviour/discovery integration:** #45/#264/#265/#268/#13/#17/#18/#310/#309/#19 under ADR-0110, consuming Steps 6–9. Production owner category matrix, real root/subtree JSON help, pricing/chat aliases, non-echoing Commander refusal and signal-safe deletion consent. G15 is refuted and receives real engine/store/log preservation evidence, with no invented token coalescing. Repeat affected packed gates. |
| 11 | **Chat normalization and abort:** #236/#237/#242/#307 → #218 → #21/#23. Canonical token/money source with approved additive LLM export, preserved two-decimal cap formatting and real immediate abort while a turn is blocked. Audit Home's imports. |
| 12 | **Chat decomposition:** #220/#244 after preceding chat fixes. Split lifecycle/drivers, line handler, printers and reseat/clear ownership. Preserve compatibility entry points, W7/W8 receipts, unknown-usage, full-screen bounds, disclosure activation and cancellation. |
| 13 | **Chat domain policy:** G30/ADR-0112 after decomposition, all fresh/resume/Home/agent/rebuild paths. Invocation-live policy owner shared by old/pending hosts, post-approval/post-prepare target guard, pinned global selection, suspension/recovery and latest-only build publication. Actual failed/overlapping Home rebuild and approval-race controls, alongside no-authority/SSRF/ports; separate egress/config-trust security sitting. |
| 14 | **Home controller:** certify G37, fix #281, record/test #125/D26 before #215/#243 decomposition; then #217/#222 scoped naming. Overlay discriminated union, subcontrollers, stale async work/focus/approval invariants and both live cost surfaces. |
| 15 | **Viewport/input:** #58/#62/G40/G51 → #65 → #64/#66, then #63/#69/G4/G55. Grapheme-correct editing/truncation, tabs, bounded caches, safe resizing, TERM=dumb and both small-terminal surfaces, input history and mouse bounds. CJK measurement and real emitted rows. |
| 16 | **Onboarding and overlays:** #49/#52/#51/#53/#55/G5/G52/G41/G53 and #34 under ADR-0112. Real next-model/ephemeral invocation binding across clear/reseat, recoverable persistence, explicit acknowledgement/current keyless nudge, shared pre-read writer symlink refusal, surfaced typed recovery and deterministic existing-file comment-loss notices. Hidden-approval safety/color-off; keychain/config security sitting. |
| 17 | **Remaining CLI/hygiene:** #24/#26/G43/G2/#12/#54/G14/#11/#47/#48/#240/#241/#311/G54/#303/#304; certify #20/G36/G46. One-shot coverage-aware cost/banner, actual-host doctor, typed faults, no silent missing-dist skip, guard misuse, attachment estimate and compiler checks. #239 remains the approved documented compatibility surface. |
| 18 | **openLocalDb LAST:** #278/#280 across every moved caller. Centralize the already-integrated classification/wrapping with fixed safe errors, attempt-all secondary cleanup, preserved causes, privacy/checkpoint notices and exact writer lifetimes. Actual command-family failure probes; no duplicate wrapper left behind. |
| 19 | **Whole-wave acceptance and publication:** every item disposition; A/E/G and M2.5.5-3 evidence; ordinary/enforced coverage and required CI/build/fences/smokes/causal/platform checks at attributed source; measure and promote core's ≥90% line/branch floor to required CI as testing.md requires after Wave 3 coverage work, fixing meaningful missing coverage before closure. Two new whole-wave cumulative reviews, canonical doc/ADR landings and PR. I/whole phases/later product waves stay open. |

Steps are dependency-safe increments, not permission to parallel-edit shared hot
files. Within each row, arrows remain strict. The process/packaging sequence replaces the old fatal-before-lazy assumption: pure contracts → guarded lazy graph → native fatal integration → map/archive custody → remaining CLI behaviour. It is nineteen increments, with no parallel edits of shared hot files. Step 1 completes before all other
code. Home cost is disposed or implemented before its decomposition; viewport
geometry work never races editor/cache work. If review exposes a necessary smaller
increment, split it with unchanged ID coverage and record the split before proceeding.

For **every** increment: implement with meaningful regressions, run required author
checks, commit; perform a new independent complete cumulative review, verify/fix
findings and commit; perform a second new independent complete cumulative review.
A material fix invalidates preceding clean rounds: obtain two new clean complete
rounds after the final fix. Only then advance automatically. Review agent models
and effort follow criticality; neither this preflight nor an old agent round is
implementation acceptance. Final publication does not infer merge or execution at
an untested successor revision.

#### Existing later-wave ownership and approval gate

The renderer restructuring decision D18 and character-wrap #61 retain Wave 5a
ownership. #61 needs a formal linked deferral record when this proposed disposition
is approved; it is not permission to silently relax I's final acceptance. Picker
position #60 and full I sign-off remain Wave 5a. Full M/N tools/child lifecycle,
CR-70/93, CR-95 continuation, exact-capacity residuals, Wave 4b retention/release
and the remaining whole-phase criteria retain their current canonical owners.

**Gate:** maintainer approval of ADR-0110–0113 and this concrete plan. Archive-method
selection is complete; production recipient/storage setup is a separate actual-release
prerequisite, not an approval or credential needed to review these proposals.
No dependent code is authorized merely by a recommendation,
preflight test pass or a clean proposal review. Approval is requested because the
user explicitly requires it for new ADRs and implement-task step 3 requires it for
public API/Accepted-decision/secrets changes. No product step is complete yet.

#### Proposal review disposition — 2026-10-15

Two new independent complete cumulative round-1 reviews of all seven proposal paths
at `bd1da978` independently verify one Medium: the still-open E #3 UTF-8 resolver
byte-cap correction was not assigned. Step 1 now owns it with multibyte, character-
overflow and byte-overflow controls; it is neither deferred nor silently closed.
The parent also makes #115's existing Wave 2 certification explicit, places G35's
exit definition with its first process consumers, and states the required core
coverage promotion without an optional close-out interpretation.
The four ADR proposals have no additional verified round-1 finding. This correction
requires fresh complete cumulative proposal review; it is not maintainer approval,
implementation acceptance or a clean implementation round.

The fresh complete cumulative round-2 review at `6f47c13b` is clean across all seven
paths and all four ADRs. The maintainer then selected public-recipient encrypted CI
archival as the method only. ADR-0111 now specifies isolated GnuPG tooling, pinned
recipient identity and exact ciphertext retention beyond expiring workflow artifacts;
no plaintext map, production key setup, upload, ADR acceptance or code implementation
is inferred. At that source checkpoint, fresh complete cumulative reviews of the
final proposal were still required; their outcome follows.

#### Final proposal readiness — 2026-10-15

Two NEW independent complete cumulative final reviews at `39967075` cover all
seven proposal paths and all four ADRs, including the selected encrypted archive
mechanism. Authority/security (`gpt-6.1-sol`, high) and compatibility/execution
(`gpt-6-sol`, high) each report zero verified findings. The parent reads both full
reports and verifies all A/E/G/I IDs have explicit owners/dispositions, all seventeen
steps remain ordered, and the final proposal preserves the corrected #3 controls.
These are proposal-readiness reviews, not product implementation or whole-wave acceptance.

Document validation resolves 2,882 relative links/anchors across the 56 Markdown
files changed since the Wave 2 base; exact Wave 3 scope is seven documentation paths.
All 109 pre-existing ADR files are byte-identical to baseline `702cdc9c`; four new
ADRs remain Proposed. Diff whitespace passes. The existing 319 focused preflight
test passes and the synthetic security reproduction remain attributed to their
original unchanged-source runs; no new CI/platform/coverage/release execution is inferred.

This receipt/current-status update changes no reviewed ADR mechanism or proposed
implementation step. **Document preflight is ready for maintainer review. Approval
of ADR-0110–0113 and the concrete plan is the only current implementation gate.**
The archive-method choice is complete; production recipient/retention configuration
belongs to actual release preparation. No provider request, key access, billing,
archive upload or code implementation has started. Detailed reports remain local
and Git-ignored, and no proposal round substitutes for a future implementation review.

#### Maintainer review reopened the proposal — 2026-10-15

**Current status: revised proposal, not approved; no implementation started.**
The clean proposal reports at 39967075/20af0617 are historical and were insufficient
source verification. Both submitted reviews reopen readiness. Three source audits
(CLI/process, packaging, chat/taint) and offline feasibility probes below replace
unsupported premises; they are not implementation acceptance or final proposal rounds.

| Reviewed concern | Verified disposition / revised mechanism |
|---|---|
| Public repo versus source-map secrecy | Remove symbol/layout secrecy premise; retain the maintainer-selected encrypted archive as distribution/custody policy, consistent with ADR-0051. |
| G15 shipping token replay | Refuted by live-bus emit and durable-store/log code. Preserve actual replay and add engine/store/log regression; no invented token persistence/coalescing. Historical inventory remains provenance. |
| Exit 9 / broad internal / surfaces / EPIPE | Inventory each site; known history/departure/operational failure remains classified 1, real outcomes/signals retain meanings, generic CLI/wiring failure is 9. EPIPE is operational output_unavailable, not unknown. Canonical surface table and inspect-before-retry remedy are proposed. |
| Fatal ownership, health, early flags and lazy entry | One lightweight invocation-owned registry, actual retirement promises, return/throw health precedence, responsive fatal backstop without false store ACK; pure contracts precede graph, native integration follows graph. Windows is an explicit native acceptance obligation. |
| Quiet/verbose/debug/non-echo | Real output-owner taxonomy and safe bounded projection; no raw arbitrary stack/cause guarantee. Exact DEBUG=1 and Commander parser non-echo are explicit compatibility changes. |
| Help manifest / aliases / #18/#310 | One enriched descriptor authority, compatible legacy model projection and complete new CLI DTO; groups may execute, flags retain source presence until conflicts checked. Remaining command-scoped input meanings deliberately stay. |
| D19/D22 / ADR-0049 versus ADR-0056 / exit criterion 4 | Proposed decision rows explicitly replace the old ladder/two-exception shorthand. At acceptance append both ADR forward notes and reconcile phase criterion 4/E's no-new-ADR claim before code; event rails remain unchanged. |
| Pack/prepack/maps/symbolication | Sole final CLI prepack build, upstream maps chained to original TS, known tsup trailer removed before receipt, maps staged outside package; exact packed CLI and engine source-location controls. |
| Randomized encryption / archive permissions / retries | Encrypt once, retain original tgz/ciphertext/binding receipt, verify/reuse on retry, refuse conflicts/unrecoverable expiry. Separate trusted-tag archive job and dry-run dispatch; production setup remains Wave 4b. |
| Catalog / ADR-0072 / media | Preserve filesystem admission before cache fallback, DB overlay before first model/cost read; never late-replace DB prices. Add actual catalog-order/long-tail/empty-DB/repeated-host controls and media maintenance exception. |
| Source-map/platform/crypto gates | New proposed packaging reference owns receipts/retention/retry; required packed OS plus public minimum Node controls and dedicated crypto/CI-custody sitting. Existing workspace floor is not packed-floor proof. |
| HTTP policy freshness / surface claims / threat scope | Global-only chat_http policy, immutable initial and monotonically narrowing accepted invocation ceilings, real rereads on every rebuild, no startup fallback on read error. Default Home/ask denials stay; custom granted chat supplies the positive. Other shell/MCP/provider authority remains separate. |
| Config links / acknowledgement / rollback | Final-component link write refusal is path-free and non-retryable, read remains allowed; manual/ephemeral recovery, no false Connected or Retry loop. Ancestor/hardlink/owner-race limitations explicit. Typed current key availability precedes remembered UX state; exact old-binary key removal/exit 2 is canonical. |
| Secret context / engine boundary / preparation / silent marker | Actual leak reproduced. Qualify once before executor/preparation, retain trusted raw resolver locally/publicly, require one projection; real public-template consumer replaces dead preparation plumbing. VM denied access fails loudly with private sticky latch and checked serialization; direct-input marker contract stays. |
| Optional tool provenance / canonical producer contradiction | Absence remains explicitly unverified compatibility state; no live mapping producer or fabricated empty one. Name both tool-registry passages for correction and retain future fail-closed mapping prerequisite. |
| Taint acceptance / details / mutation | Actual engine+standard executor+QuickJS+SQLite columns, downstream gate and condition oracle with exact successful positive controls; fixed secret_context reason. Copy/freeze arrays, not mutable Sets; error detail is not universally safe. Existing parser/tool controls labelled preservation. |
| Canonical homes / traceability / acceptance timing | Proposed exact contracts live in commands/config/expression/runner/tool/packaging references, with rationale in ADRs. All listed CLI IDs have owners. New ADR acceptance notes precede dependent code; old Accepted bodies are not rewritten. |

Source audits at 20af0617 include 7 focused CLI suites / 127 passing tests.
Actual engine/standard-executor/QuickJS probes reproduce direct/computed/serialized/
nested/custom-merge leaks and the condition oracle. Native SQLite positive and
negative runs both complete: the canary reaches three run-event rows, two step
output rows and one run output row; downstream human-gate exposure is confirmed.
Direct/transitive model/human context templates already refuse and remain controls.
The initial VM private-latch alternative passes the originally enumerated
feasibility checks but its ordinary final envelope is later shown forgeable through
inherited toJSON at host dump. The correction record below supersedes any broader
feasibility inference; clean-read/key-only positives remain historical evidence. An in-memory installed TypeScript→esbuild map-chain probe maps a synthetic
engine frame to its original TS location without embedded sources. These probes
are design evidence, not integrated fixes, full CI, native Windows or release proof.

**Approval scope:** the revised four Proposed ADRs, linked unshipped canonical
contracts and nineteen-increment plan, including fail-loud context semantics,
monotonic HTTP rebuild grants, non-retryable link writes, operational EPIPE versus
generic 9, and exact-byte encrypted custody. Archive method selection persists.
Fresh complete cumulative proposal reviews and maintainer approval remain pending;
no product task, production recipient, provider/key/billing or upload is claimed.

#### Revised proposal round 1 corrections — 2026-10-15

Two NEW complete cumulative source-based reviews of all fourteen proposal paths
at 86400811 independently request changes. Both verify final-envelope host-dump
forgery, public build-cache map exposure and living G15 task inconsistency.
Authority review additionally verifies missing owned-frame provenance and positive
Windows facility/scope. All five are corrected in the proposal before approval:

- The VM control envelope uses null-prototype captured serialization and primitive
  string transport, then host typeof/getString/parse/strict arm validation. Author
  bindings stay const. The parent's six revised feasibility controls pass, including
  prototype-poisoned envelope, caught reads, latch reset, returned getter, exact clean
  result and reassignment refusal; the earlier wrapper is not certification.
- Map-enabled dependency builds belong only to isolated uncached candidate stages,
  with ordinary workspace builds map-free and all cache/artifact/failure paths
  covered by planted-marker controls. Public source does not change custody policy.
- Verbose frames emit only closed build-owned canonical relative file identities
  plus numeric locations; arbitrary valid-looking stack paths/functions are dropped.
- Windows uses verified trusted absolute taskkill/fixed owned-root argv, with
  actual close joining, bounded completion and admission refusal if unavailable.
  Live tree/group cleanup is best effort; detached/root-exited/PID-race containment
  is explicitly unclaimed. Existing M/N ownership is preserved. This scope requires
  maintainer approval with ADR-0110, not an inferred acceptance of a universal claim.
- Living E G15 and crash acceptance now point to current source/policy; the frozen
  historical inventory is not rewritten.

Reviews remain nonclean history. These corrections require two NEW complete
cumulative clean proposal rounds after their final material fix. No implementation,
Windows native gate, public archive, full CI/coverage or ADR approval is inferred.

#### Revised proposal round 2 clarification — 2026-10-15

The NEW complete cumulative review at 35935273 verifies the five round-1
corrections and reports one Medium: package-test and release-candidate modes
were implicit. The canonical packaging contract now separates them. Required
PR/push/manual tests keep map verification local, discard private outputs and share
only the exact tarball/package-test hash receipt without production keys. Actual
trusted-tag release requires production encryption in its originating pack job
before any handoff, retains the original three-asset candidate and never promotes
a test artifact whose maps were discarded. No recipient-less or fixture-key
product release is authorized. Existing retry/no-overwrite rules still apply.

The focused 127-test pass, actual engine/SQLite probe and six primitive-envelope
controls retain that review's exact 35935273 attribution; no product fix/CI/Windows
execution is claimed. This material clarification requires two NEW complete
cumulative clean proposal rounds at its corrected head before approval is requested.

#### Revised proposal readiness after source corrections — 2026-10-15

> **Historical readiness superseded — 2026-10-16.** The maintainer rereview below
> demonstrates source/contract gaps present at this checkpoint. Its reported clean
> rounds are retained as history, not current readiness or implementation approval.

Two NEW independent COMPLETE cumulative reviews are clean at exact reviewed source
49ba03eecf9856e3d6f0bda6528f4a48d94a34e8: round 3 (gpt-6.1-sol, high) and round 4
(gpt-6-sol, high). Each covers all fourteen proposal paths, all four ADRs, the
nineteen-increment plan and related actual source/Accepted contracts, rather than
only the most recent correction. Each records zero verified material findings.
The parent reads both complete reports. Nonclean rounds at 86400811 and 35935273
remain historical and are not counted as clean; the old 39967075 readiness claim
is superseded by this source-corrected proposal.

Exact-head six-control installed-QuickJS primitive-envelope feasibility passes
in both final rounds; round 3 also reruns actual engine/standard-executor/SQLite
positive and negative intake. These reproduce the **existing unfixed** exposure,
not a product correction. The prior 7-suite/127-test and synthetic TS-map-chain
results keep their actual execution attribution. Source inventory proves only
documentation changed, all 109 prior numbered ADRs remain byte-identical to
702cdc9c, and ADR-0110–0113 remain Proposed. Parent doc validation resolves 3,033
relative links/anchors across the 61 Markdown files changed since the older
Wave 2 base; final reviewer scope remains fourteen proposal paths. Diff whitespace
passes. No full CI, coverage, native Windows, exact pack/release or provider/key/
billing execution is inferred.

This final receipt and current-status update add no mechanism or step to the
reviewed proposal. **Ready for maintainer approval of the four Proposed ADRs,
their explicitly unshipped canonical contracts and nineteen-increment plan.**
Approval includes the fail-loud qualified context boundary, monotonically narrowing
HTTP rebuild authority, non-retryable intentional-link write refusal, explicit
CLI compatibility and finite native teardown scope, and separated package-test/
encrypted-release custody modes. The selected archive method remains unchanged.

No implementation is authorized by a clean proposal review. After explicit
approval, update ADR statuses/index and append the specified Accepted-ADR forward
notes before dependent code, then start serialized Step 1 and its required review
loop. Production recipient/recovery configuration remains an actual Wave 4b release
prerequisite; no production key, provider capture, billing or upload is needed for
the current approval. Detailed reports remain local and Git-ignored.

#### Second maintainer rereview and proposal corrections — 2026-10-16

**Current status: revised Proposed decisions; source preflight reopened, no product
implementation.** The two submitted rereviews show that the a8708a65/49ba03ee clean
proposal records did not establish adequate source coverage. Those readiness claims
are superseded, not counted toward the corrected proposal. No assertion that all
old partial findings became implemented fixes is made. The four decisions and
nineteen-step plan still require new complete cumulative reviews and maintainer
approval before code.

Three scoped source intakes (CLI, packaging, chat/context) and parent verification
support the dispositions below. They are not full clean proposal rounds. The
chat/context agent supplied source observations and retained synthetic evidence,
then its turn was stopped by automatic cybersecurity review; it produced no final
clean review. It is not counted as completed or retried to evade that restriction.
The parent can continue normal documentation work using inspected source/evidence.
No release/API mutation, paid call, key access, provider capture or product edit
occurred. The chosen encrypted archive method is retained.

| Submitted concern | Revised proposal or verified disposition; implementation owner |
|---|---|
| A: EPIPE 1 versus workflow failure | Classified output infrastructure now uses output_unavailable/9; unexpected uses cli_internal/9. Known operational 1 remains explicitly scoped. Commands owns the table/remedy; Steps 6/8/10. |
| Chat/Home/agent fictitious joined 5–8 | Run-only RunHandle health; session cancel/join/publication failure, no new session-health DTO. Failed chat turns keep REPL live, unknown caught faults reach coordinator. Steps 6/8/11/12/14. |
| POSIX MCP group / root-exit semantics | Creation-specific tool PGID versus SDK MCP PID, narrow actual lifetime adapter and explicit PID/PGID uncertainty. Windows verified taskkill only for still-owned live root. Steps 6/8; no SDK transport rewrite or universal containment claim. |
| Fatal race, budget, stderr and catches | Sticky total observation order, one cleanup/deadline including taskkill/restore/flush, terminal restore before stderr, never diagnostic stdout. Existing total budget text was already present; synchronous-after-expiry ambiguity is corrected. Inventory slash/rebuild/one-shot/forced-exit catches and unknown origin. Steps 6/8. |
| DB failure classification before final refactor | Native typed DbOpenError/owned errno operational mapping and minimal adapters precede native integration; invalid schema remains 2, import/ABI fault 9. Existing wrappers' runtime-IO 2→1 change is explicit. Step 18 only centralizes the already-required contract. |
| Pricing binding and own remedies | Legacy model/executor input/output bindings remain; canonical shell spellings track source presence before conflicts. Update every generated hint/example so it does not recommend deprecated pricing/chat aliases. Step 10. |
| Release retry permissions / final writer | Concrete admission→draft-visible Actions-read discovery/reservation→fresh pack or reuse→smoke→archive→npm→finalize graph; only custody jobs get Contents write, top-level deny default, read-only publish consumes verified tarball/receipt. All reruns discover before build. Step 9. |
| Lost candidate / randomized encryption | Reserve original version/source/attempt before first build; incomplete/lost candidate requires recovery, never new encryption/replacement. Retain all three assets beyond Actions expiry. Permission-enforcing fake service tests actual state controller and call counts; no live tag needed. Step 9. |
| Maps / finalizer / chunks / public floor | Installed compiler overrides and concrete dependency order, prepack map enable, missing-upstream refusal and repository-relative finalization, entry-only hashbang/modes, exact-tarball required aggregate on supported OSes and Node 22.0.0. Steps 7/9 and final repeat. |
| Help admission / catalog | Missing directory no longer blocks meta once pure grammar passes: explicit ADR-0105 refinement. One invocation seed owner and eleven current DB-overlay sites, including quote/fixture/media exceptions. Step 7. |
| Public-source encryption proportionality / settings | Preserve selected distribution/custody policy, acknowledge availability cost and revisit only with maintainer policy change. Current repository defaults/immutability are not protection; explicit workflow permissions/concurrency/no-overwrite are required. Step 9; production setup remains Wave 4b. |
| Home build-first / failed and overlapping rebuilds | One live narrowing owner shared by all hosts; post-approval/post-prepare check uses owned PolicyTarget. A validated removal survives failed replacement; stale build cannot restore policy/selection. Step 13 before later Home decomposition acceptance. |
| Policy source / errors / widening / IP aliases | Pin lexical global selection/home once, initial missing versus transient error distinctions, suspend rather than falsely revoke on read fault, no startup fallback, fixed ignored-widening notice. ASCII validation before fold and alternate IP rejection; workflow policy stays separate. Step 13. |
| Ephemeral selection / UX acknowledgement / shared writer | Invocation binding survives clear/reseat and latest-only publication; current key state outranks portable UX preference. Shared lstat refusal before read/chmod for all writers, actionable Home/wizard diagnostics, existing-file comment-loss notice, old-binary rollback cannot promise new meta behavior. Steps 13/16. |
| B: direct secret marker asymmetry | Deliberately replace direct expression-input markers with the same denied-value contract as ctx; public templates also refuse direct secret inputs even for hand-constructed workflows. Display/input-node markers remain. Step 3, requiring approval of this explicit compatibility change. |
| C/F: accessor rationale / error identity | ADR-0093 before-money ordering stays; runtime privacy excludes raw values, latch diagnoses executed denied reads. Existing sandbox_error gains fixed secret_context reason, not a new engine ErrorCode. Step 3. |
| Latch resource bypass / serialization | Document caught pre-accessor stack failure as finite semantic limit, not confidentiality failure. One authored payload serialization before latch check; outer primitive-only envelope cannot run author serialization again. Actual numeric/boxed/object parity and bounded transport are required. Step 3. |
| Mutable secret Set / actual producer inventory | One owned mutation-incapable membership facade plus immutable array; fresh, budget preparation and cross-process resume plus all low-level scope/test producers migrate. Correct stale scope/error comments and private-detail claims. Step 3. |
| Old durable outputs / tool provenance | No automatic historical scrubbing or claim legacy run.outputs is secret-free. Land at-rest/recovery guidance. Optional external tool provenance remains explicitly unverified; nonexistent mapping producer not fabricated. Actual repaired exposure and #92 limitation stay distinct. Step 3. |
| D/E/G: metadata / partial index / Proposed references | Standard Status/Date/Related only. At approval add clause-specific partial Status/index/forward notes; promote each exact reference only at implementing increment acceptance, not ADR acceptance. Explicit landing checklist below. |
| Claimed broken Wave 2 anchors | Refuted: explicit HTML alias wave-2-individual-dispositions--certification-in-progress exists and preserves both links. Do not manufacture a repair/deferral. |

**Evidence scope.** Source remains product-identical to 702cdc9c. Installed synthetic
TypeScript/tsup/esbuild controls verify map chaining, silent missing-upstream fallback
and entry/chunk mode behavior; these are not actual packed product/release controls.
Existing actual-engine intake confirms direct-input marker comparison completes
false and hand-built human-template input can expose the synthetic canary. Installed
QuickJS emulation reproduces caught pre-accessor stack failure in eight of eight
intake cases without raw values in the VM. Parent additionally executes 36 actual
baseline sandbox result cases across condition/transform/merge: top-level NaN,
±Infinity and -0 stay numbers, boxed primitive is rejected, Map/Set is {}, and
cycle/nonserializable results refuse. Those observations constrain the proposal;
no new implementation or final VM mechanism is certified. No full CI/coverage,
Windows, actual product tarball, GPG/production custody or published API validation
is inferred. Working reports/probes remain local and ignored.

**Canonical landing checklist (required, not a future unowned debt):**

1. At explicit approval: change only new ADR statuses/index, append old clause-specific
   notes and partial Accepted/index annotations for ADR-0047/0049/0051; ADR-0049
   names §5 infrastructure/pre-run exceptions as well as §6 explicit JSON help. Append the
   listed refinements, including ADR-0105 meta admission and ADR-0027/0083 direct-input
   compatibility/ADR-0093 rationale. Reconcile D19/D22, E no-new-ADR statement and
   phase criterion 4 before dependent code. Keep historical bodies intact.
2. Step 3: merge actual secret-boundary/producer behavior into expression-sandbox,
   agent-runner, workflow/tool contracts; replace both contradictory tool provenance
   passages and stale source comments. Update at-rest/recovery guidance. Preserve
   unimplemented remainder as explicitly Proposed.
3. Steps 6–10: promote implemented commands, groups/flags/pricing remedies, errors/
   exits and packaging sections; reconcile phase CLI acceptance plus chat-session.md,
   home.md and current command text. Step 9 updates release-a-surface.md for exact
   graph/map/modes/recovery. No shipped claim for a merely approved mechanism.
4. Steps 13/16: promote exact config/tool/chat/Home policy, selection and writer
   sections as their code is accepted, including rollback and surfaced remedies.
5. Step 19: inventory all Proposed sections in commands.md, packaging.md,
   config-spec.md, tool-registry.md, expression-sandbox-spec.md and agent-runner.md.
   Merge/remove every completed proposal section/banner and reconcile overlapping
   old current text; any genuine unimplemented scope stays visibly open. Repeat
   link/anchor, append-only and exact-head source/evidence checks. No blanket
   “all references describe shipping code” claim before this inventory passes.

These edits need fresh complete cumulative source-based proposal reviews. No
implementation is authorized by prior clean reports or source feasibility probes.
The maintainer must approve the revised four ADRs/contracts/plan before Step 1;
archive method selection is already complete, and no production key is requested.

#### Second rereview proposal round 1 corrections — 2026-10-16

The NEW complete cumulative source review at 86ff88a8 covers all fourteen proposal
paths and verifies three Medium findings. They are corrected in the proposal:

- Native failed-jobs rerun skips successful discovery. Fresh pack now requires a
  same-current-attempt discovery/reservation; stale fresh output refuses before
  build. Explicit retry matrix separates exact reuse/downstream retries from
  rerun-all discovery and unrecoverable incomplete reservations.
- Reuse has encrypted maps only and cannot rerun plaintext map/symbolication
  checks. Those checks belong to the fresh originating pack; retry verifies its
  trusted successful identity/completion evidence and exact digests, then reruns
  tarball smoke. No CI private key or fictitious fresh symbolication is added.
- Lexically sorting context changes clean expression results and loses clean/
  denied interleaving. Owned orderedKeys preserves actual resolved own-key order;
  input presence/enumeration also stays intact. Mutation controls include facade
  callback back-references, not only missing Set.clear on the wrapper.

Canonical operational-1 recovery also carries inspection advice after admitted
work, consistent with the existing ADR uncertainty rule. These are documentation
corrections, not fixes to running product code. ADRs remain Proposed. The nonclean
round is retained; two NEW complete cumulative clean proposal rounds are required
after this final material correction before asking for approval.

#### Second rereview proposal round 2 wording closure — 2026-10-16

The NEW complete cumulative source review at 741d0db4 (gpt-6.1-sol, xhigh)
verifies all three prior Mediums resolved and records no new material finding.
Two optional Low cautions are also closed: absent declared-secret input accessors
retain non-enumerability, and ADR-0049’s partial-replacement instructions name
§5 infrastructure/pre-run exceptions as well as §6 explicit JSON help. These
clarify the already explicit behavior matrix rather than introduce another rule.
The earlier complete round at 86ff88a8 used gpt-6-astra, xhigh.

For an unambiguous final checkpoint, obtain two NEW independent complete cumulative
reviews of all fourteen paths at the wording-corrected source. Neither round 1’s
three Mediums nor round 2’s optional cautions are hidden or relabeled zero issues.
All four ADRs remain Proposed; code, platform, production custody and whole-wave
acceptance are still future implementation gates.

#### Final proposal rounds reopened omitted-input presence — 2026-10-16

Two NEW independent complete cumulative reviews at c6166331 (gpt-6-astra/high and
gpt-6.1-sol/high) independently verify one shared Medium. Non-enumerable denied
accessors for omitted optional secret inputs still change hasOwn/in, own-property
names/descriptors and direct reads. They contradict the promised own-presence
parity. Both rounds are nonclean; the authority report's initial clean assessment
was superseded by its independently verified addendum and is not counted.

The corrected proposal creates **no property/accessor for an omitted optional
secret input**. VM denial applies to present admitted secret values; absence
retains undefined and all ordinary reflective observations. Public-template
secret references still use declaration-based refusal before filters/defaults.
Secret defaults remain forbidden, and missing-required/nonsecret-default admission
is not changed. Actual implementation controls must pair supplied-secret denial
with omitted-input hasOwn/in/keys/descriptors/Reflect (where supported)/undefined
parity. The earlier non-enumerable proposal notes above are historical, superseded
by this correction rather than used as current authority.

No product code or new confidentiality guarantee is introduced. Both complete
reports were read in full. After this material correction two NEW independent
complete cumulative clean proposal rounds are required before requesting approval.
All four ADRs remain Proposed and production/release/provider/key/billing work
remains outside this preflight.

#### Live roadmap scheduling correction — 2026-10-16

Two NEW independent complete cumulative reviews at effab2ac (gpt-6-astra/high and
gpt-6-sol/high) confirm omitted-input absence parity and independently verify one
shared Medium: current.md still permits the post-first queues and tails in “any
order”, while the proposed nineteen-increment plan requires serial gated advance.
Both reports are nonclean and have been read in full; neither counts toward final
readiness.

The live roadmap now labels its original groups as scope/dependency inventory and
links the numbered increments as the sole proposed execution/review authority.
The phase introduction no longer delegates execution back to those groups. Source-
corrected preservation dispositions, viewport coalescing, pending formal #61
record and later full-I ownership remain explicit; no work is silently closed or
newly deferred. This is a planning consistency correction, not a change to the
already proposed nineteen-step sequence or any product source.

Two NEW independent complete cumulative clean rounds at the corrected source are
required. ADR-0110–0113 remain Proposed, and maintainer approval precedes code.

#### Second maintainer rereview final proposal readiness — 2026-10-16

Two NEW independent COMPLETE cumulative reviews are clean at exact source
76065d2d12f53b728fc40954eceb2d58f2efd7ff: authority (gpt-6-astra/high) and
compatibility (gpt-6.1-sol/high). Each independently covers all fourteen proposal
paths, all four full ADRs, all nineteen increments and the relevant actual source/
Accepted contracts. Both report zero verified findings; the parent reads both
full reports. They follow the last material scheduling correction, not merely its
two changed files. No earlier nonclean or superseded verdict counts toward them.

The complete rounds at 86ff88a8, c6166331 and effab2ac remain nonclean history;
741d0db4’s two optional Low cautions were corrected before these final rounds.
The c6166331 authority report’s initial clean verdict was explicitly superseded
and is not counted. Earlier a8708a65/49ba03ee readiness remains superseded.

Current proposal decisions now consistently specify distinct CLI output/internal
9 with actual run-only health precedence and owner-kind teardown; exact originating
map evidence and permissioned reservation/retry/finalization; invocation-live HTTP
narrowing across failed Home builds; and owned context/input exclusion with one
result serialization, finite observed-access diagnosis and exact value/key/absence
parity. Declared-secret template refusal, forbidden secret defaults, legacy-output
limits and unsupported tool-mapping scope stay explicit. The numbered plan owns
execution, while original roadmap groups are scope inventory.

Actual final-round validation includes diff whitespace, independent relative-file
checks and unchanged product/old ADR inventories. Compatibility additionally runs
nine existing schema/manifest/options/source-label/viewport suites: 255 tests pass
at 76065d2d, with no skips. These are unchanged-source preservation/preflight tests,
not tests of future implementation. Prettier skips ignored Markdown and is not
formatting evidence. Parent link/anchor validation covers 61 changed Markdown
files and 3,037 relative links/anchors with zero errors; all 109 earlier numbered
ADRs remain byte-identical to baseline 702cdc9c and four new ADRs remain Proposed.
No full CI/coverage, native teardown/Windows, actual product pack/map/GPG release,
security-sitting, provider/key/billing or production-custody acceptance is inferred.
Detailed review/probe records remain local and Git-ignored.

**Ready for maintainer review and explicit approval of ADR-0110–0113, their
unshipped canonical contracts and the nineteen-increment plan.** No product code
has started. The selected encrypted archive method persists; actual production
recipient/recovery configuration belongs to Wave 4b, not this approval. Approval
is still required by the user’s new-ADR instruction and implement-task plan gate.

This receipt/current-status update changes no reviewed decision, mechanism or
implementation step. After approval, update new ADR statuses/index and append
clause-specific Accepted-ADR notes before dependent code, then start Step 1 and
its implementation/commit/two-new-clean-review loop. Later increments advance
automatically after their gates. Whole-wave acceptance and PR remain Step 19;
full I/whole phases and existing approved later-wave scope are not closed here.

### Wave 3 maintainer approval and implementation checkpoint — 2026-10-16

The maintainer explicitly approved final ADR-0110–0113, their linked unshipped
canonical contracts and all nineteen increments. Their statuses/index are Accepted;
clause-specific partial replacements and forward notes were recorded before
dependent code. ADR-0047/0051 retain framework, licensing/private-engine and
no-public-map rules outside the replaced single-output constraint; ADR-0049
retains actual outcomes/stdout outside the enumerated §5/§6 changes. D19/D22,
E's old no-new-ADR assertion and exit criterion 4 are reconciled.

Step 1 is active on `development`; no product implementation or implementation
review acceptance is claimed by this checkpoint. Every increment still requires
author gates, commits and two NEW independent complete cumulative clean reviews
after its last material fix. Later increments advance automatically after those
gates. The previously recorded proposal reviews remain proposal-only evidence.

The approved #61 character-wrap disposition is now linked in
[deferred-tasks.md](../deferred-tasks.md#wave-3-approved-later-wave-ownership--2026-10-16):
Wave 5a owns it alongside D18/#60; full I acceptance is not waived. Production
recipient/recovery setup remains a Wave 4b actual-release prerequisite. No ADR
approval, provider capture, key, billing or upload is pending for Wave 3.

### Wave 3 Step 1 author candidate — 2026-10-16

The serialized queue is implemented in its approved order: shared safe synchronous
close handling (#22), source labels/UTF-8 admission (#4/G11/#3), then six exhaustive
session/picker/run switches (#300/#301/G3) and actual live reasoning projection.
The four named command siblings, existing chat owners, Home and the newer one-shot
journal retain their lifetime joins. The transient pricing-reader owner also uses
the same helper rather than allowing close to override its non-fatal read contract.
Fixed owned-label warnings neither inspect native error text nor retry on stdout;
a failed warning sink cannot replace the primary outcome. Native error causes stay
private behind safe source labels. Reasoning has an independent bounded display
buffer and never becomes persisted assistant text. No event/exit/usage contract is
renamed; the later process/discovery changes remain unshipped.

Author gates pass: all workspace lint/typecheck and 590 test files, 13,020 passing
tests plus 20 established skips; all six build tasks pass. Seam-fence and changed-
file strict-TypeScript screens, diff whitespace and 3,329 relative links/anchors
also pass. Four local removal controls break 21/7/1/3 designated regressions for
close handling, source admission/labels, export diagnostics and reasoning;
each source is restored byte-identically, followed by the passing complete author
suite. Filtered removal runs' unselected tests are not platform skips or coverage.
These are local author checks, not full CI/coverage/platform or whole-wave evidence.

**Historical author-stage review gate (now satisfied below):** commit the author candidate, then obtain two NEW independent
complete cumulative clean Step 1 rounds after the last material fix. No Step 1
acceptance or permission to advance to Step 2 is inferred from author checks alone.
Detailed working logs remain local and Git-ignored.

### Wave 3 Step 1 acceptance — 2026-10-16

Step 1 is independently accepted at `c610a4ad4947aca122cd4f0df807166735df67b3`.
Two NEW complete cumulative clean rounds cover all 31 changed paths and actual
consumers: gpt-6-astra/high (13 files / 250 independent passing tests) followed by
gpt-6.1-sol/high (27 files / 866 independent passing tests plus four Windows-path
semantic controls). Both report zero findings; the parent read both full reports.
They are new implementation reviews, separate from proposal acceptance.

All scoped #22/#4/G11/#3/#300/#301/G3 work is complete. The author gates retain
their actual attribution: 590 files / 13,020 passing tests / 20 established skips,
all workspace lint/typecheck and six build tasks. Test-isolation additionally
confirms all 590 collected files belong to the six intended workspaces; source
formatting, seam fence, whitespace and relative links pass. The earlier author
file-count sum was mistakenly recorded as 690 and is corrected to 590 here and
in that receipt; component execution, test counts and reviewed product bytes
are unchanged. This metadata/landing update is not a new product revision or a
claim of whole-wave CI, coverage, platform or successor execution.

Next is Step 2: shared admission/diagnostics and preserved existing guards.
No user decision or review fix is pending for Step 1. Detailed reports and local
removal logs remain Git-ignored; Step 19 retains whole-wave acceptance/publication.

### Wave 3 Step 2 author candidate — 2026-10-16

Shared authored admission now rejects duplicate parallel members, typed condition
matches and fallback model/provider tuples (#89/#90/#212/G18). One human-gate
cross-field authority validates both the exported leaf and NodeSchema union
(#210); timeout without action retains default rejection. Full workflow admission
no longer reports parallel duplicates twice. Primary-equal fallback entries and
different provider/model tuples remain permitted. Logical RunSchema refuses only
contradictory present lifecycle fields (G17), retaining missing legacy fields,
optional outputs and the existing temporal checks. No persisted-row reader or
migration is tightened. Existing input-default/enum and compaction-role guards
(#211/G16) are preserved and revalidated by their actual shared/DB suites.

The two core parsers share schema-derived reasons (#85/#86), including expected
schema literals and useful standalone agent reasons with unchanged fields/code.
Duplicate MCP reasons no longer reflect registration identities; strict unknown-
key diagnostics remain linear. Config range diagnostics report their real bound
and inclusion rule (#32), through the existing loader/writer formatter. Canonical
authored/config/logical-run references are updated; no dependency or event code is
added. The old ceiling fixture now uses distinct fallback identities so it still
isolates chain length and every entry's attempt ceiling rather than failing the
new earlier duplicate guard.

Required author gates pass: 591 files / 13,101 passing tests / 20 established
skips, all workspace lint/typecheck and six builds. Formatting, seam fence,
test-isolation (591 files / six workspaces), whitespace and relative links pass.
Six local removal controls break 25/3/9/3/3/6 intended regressions for node, agent,
run, literal, standalone reasons and config-bound mechanisms; source bytes are
restored exactly before the complete passing author suite. Filtered unselected
cases are not platform skips. This is not full CI/coverage/platform or whole-wave
acceptance. **Independent complete cumulative review is pending**; obtain two NEW
clean rounds after the final material fix before Step 3. Working logs remain local
and Git-ignored.


### Wave 3 Step 2 review correction — 2026-10-16

The first complete cumulative review at `7912c5e7` reports one verified High:
AgentSessionSchema embedded the newly tightened AgentSchema, so a historically
valid duplicate fallback snapshot failed loadSession, listSessions and loadFull.
The parent reads the full report and confirms the real SQLite reproduction and
baseline-positive control. The author candidate's reader-preservation claim was
therefore premature; this round is not clean and does not permit Step 3.

AgentSnapshotSchema now owns the historical structural/MCP checks, while
AgentSchema composes the fresh-authoring fallback uniqueness refinement.
AgentSessionSchema uses the snapshot contract: history reads and session updates
retain ordered entries and their different attempt budgets, without deduplicating
or rewriting them. Fresh standalone/inline authoring still refuses duplicate
model/provider tuples. The canonical database reference names that boundary.

Permanent shared and real SQLite regressions cover fresh rejection, legacy
load/list/full reads, unchanged snapshot bytes after a session update, and retained
structural/MCP rejection. Removing the snapshot separation breaks both designated
regressions; exact byte restoration passes both. Seven focused files / 294 tests
also pass. Final author gates pass at the corrected source: all workspace
lint/typecheck, 591 files / 13,103 passing tests / 20 established skips and six
build tasks. Source formatting, fences, whitespace and 3,337 relative links pass.
These remain local author gates, not full CI/coverage/native-platform certification.
Two NEW complete cumulative clean rounds after this material fix are required;
no earlier round is counted as acceptance. Detailed reports/logs remain local and
Git-ignored.


### Wave 3 Step 2 frozen-workflow correction — 2026-10-16

The NEW complete cumulative review at `09e5927d` confirms one High and one Medium;
the parent reads the full report and verifies both actual consumer paths. The
session-reader correction stands, but the engine's frozen-content identity check
and CLI gate reader still applied fresh WorkflowSchema rules to historical runs.
Unchanged inline fallback duplicates, repeated condition matches and inactive
orphan timeout actions were valid at the Step 2 base. This round is not clean;
no earlier review is counted toward acceptance.

WorkflowSnapshotSchema now composes the same structural fields and shared
whole-document invariants with historical agent/node contracts. It omits only the
new author-only fallback/condition/gate checks. Prior strict fields, duplicate
identities, input default/enum checks, parallel member uniqueness, custom merge
requirements and parallel-edge consistency remain enforced. Actual CLI gate and
engine frozen-identity readers use this contract; fresh parsers retain strict
WorkflowSchema/AgentSchema/leaf admission. Historical content remains the identity
authority, without automatic graph repair or fallback deduplication.

Permanent controls cover the real frozen-content verifier and actual CLI → engine
→ SQLite pause/resume for all three shapes, exact completed output, first-declared
condition selection, inactive timeout action, preserved original events/snapshot
and continued corrupt parallel-member refusal. Shared snapshot controls retain
seven prior rejection classes. Session export faithfully preserves old fallback
order/budgets; canonical mapping and serializer comments now qualify the current-
authoring round-trip guarantee, a permanent test pins explicit repair/current
refusal, and the shared successful-export notice names required historical review.
The exporter neither rewrites history nor silently deduplicates the snapshot.

Final author gates pass: all workspace lint/typecheck, 591 files / 13,119 passing
tests / 20 established skips, six build tasks (five cached), seam/dependency fences,
test-isolation across all six workspaces, source formatting, whitespace and 3,338
relative links. Nine fresh mechanism removals break 25/3/9/3/3/6/1/3/3 designated
regressions for node, agent, run, literal, standalone reasons, config bounds,
historical session, engine frozen identity and CLI gate readers; every source is
restored byte-identically before the final passing author suite. Filtered cases
are not platform skips. This is local author evidence, not full CI, coverage,
native-platform or whole-wave certification. Two NEW independent complete clean
cumulative Step 2 rounds after this final material fix remain required before
Step 3. Detailed reports/controls remain local and Git-ignored.


### Wave 3 Step 2 acceptance — 2026-10-16

Step 2 is independently accepted at `4048526fbf2585560cd12dbdf11fc3412d4be9d5`.
Two NEW complete cumulative clean rounds after the final material fix cover all
34 changed paths and actual consumers: gpt-6.1-sol/high (16 files / 545 independent
passing tests, baseline compatibility and wrapper controls) followed by
gpt-6-astra/high (17 files / 585 independent passing tests, 21 workflow + five
agent baseline comparisons, 40 wrapper assertions, actual SQLite preservation and
10 runtime/source correspondence checks). Both report zero findings. The parent
reads both full reports and verifies the original session-reader, frozen-workflow
reader and export-contract findings are resolved; the two earlier nonclean rounds
are not counted toward acceptance.

All scoped #89/#90/#212/G18/#210/G17/#85/#86/#32 work is complete; #211/G16 are
certified existing guards. The author evidence retains its actual scope: 591 files
/ 13,119 passing tests / 20 established skips, workspace lint/typecheck, six builds
(five cached), fences, 591-file/six-workspace isolation, formatting/whitespace and
relative links. Nine causal removals and exact restoration precede the final
passing author suite. Reviewer executions are separate from those author gates;
no full CI/coverage/native-platform, successor execution or whole-wave acceptance
is inferred from this metadata landing.

Next is Step 3, ADR-0113 secret provenance and actual VM/public-template consumers,
with a dedicated security sitting. No user decision or review finding remains
pending for Step 2. Detailed reports and working controls remain Git-ignored;
Step 19 retains whole-wave acceptance/publication.


### Wave 3 Step 3 author candidate — 2026-10-16

**Implemented; security and independent acceptance pending.** Core source and its
producer/VM/template regressions are committed at `8813391b`; the actual native
SQLite integration is `aba979f4`. ADR-0113 owns the explicit low-level projection
and direct secret-input expression compatibility change. The existing linear
source graph supplies immutable owned context/input authority to fresh execution,
same-process resume and cross-process budget preparation, with actual public
prompt/human and expression consumers. Trusted raw resolution and display markers
retain their separate contracts. No future authored tool-mapping producer is
invented; #92's mapping limitation remains distinct from the repaired exposure.

The actual QuickJS suite preserves optional-secret absence, original key order,
clean result semantics, numeric tags and one authored serialization. A private
VM-owned closure separates evaluation and serialization native calls in the same
VM under the original deadline; it never exports an authored object. The first
focused run exposed a serialization-interrupt classification regression; the
corrected source preserves baseline result_type/non_serializable outcomes. The
finite exhausted-stack witness returns its clean fallback without a denial; it
carries no raw denied value. Ordinary executed/caught reads produce fixed
secret_context with no detail/cause. Canonical source/error comments and at-rest/
recovery guidance explicitly retain historical/arbitrary content sensitivity.

Author workspace lint/typecheck/tests pass: **597 files / 13,442 passing tests /
20 established skips** across six workspaces. Build passes all six tasks;
platform/vendor/dependency fences, isolation and changed-source formatting pass.
These are local author gates, not full CI/coverage/platform or whole-wave proof.
New focused ownership/public-template/VM/transport/producer/native-SQLite files
contribute 29/19/184/67/6/18 tests respectively. They include independently
successful clean execution/persistence and actual same/fresh-engine secret resupply.

An isolated build of the exact Step 2 core at `873da1c34` reproduces the repaired
leak with real WorkflowEngine, standard executor, QuickJS and file-backed SQLite.
The clean positive completes with exact outputs and nonempty rows. A successful
ctx.alias result places the synthetic canary in public events and all three
required columns (run_events.payload_json, step_executions.output_json and
runs.output_json); a separate downstream human gate displays it. Cancellation of
that separate gate graph is not used to infer run-output leakage. No live product
source/dist was rolled back, and no provider/key/network call was made.

Three local fixed/removal/restored cohorts pin context qualification, public
whole-template refusal and the private VM latch. Removing them causes **6 / 6 /
64 named assertion failures**, respectively; each fixed/restored inventory passes
29 / 19 / 184 tests and restores exact source bytes. The installed runner reporter
records zero unhandled errors in all nine final phases. The first exploratory
cohort attempt had a mismatched named-witness check; it was rejected and retained,
then the permanent assertion marker was made explicit before the final complete
cohorts. This is scoped author evidence, not independent review acceptance or a
replacement for Step 19's repeatable whole-wave publication.

Dedicated secret-flow security sitting and two NEW independent complete cumulative
clean reviews after the last material correction remain required before Step 4.
Detailed baseline hashes, runtime identities, local probes and reports remain
Git-ignored under docs/reviews; no production credential, paid call, release,
archive upload or user decision is needed for this increment.


### Wave 3 Step 3 review corrections — 2026-10-16

The first complete cumulative review of `3222a8c6` is **not clean**: two High
findings identify lost native top-level Error result metadata and changed ordinary
thrown-value classification; one Medium identifies missing required provenance
validation when agent/human templates are absent. The separate secret-flow
security sitting corroborates the classification finding and is also **not clean**.
Neither counts toward acceptance. The parent reads both full reports, independently
compares the pinned Step 2 runtime and verifies the findings before correction.

The private VM converter now preserves the pinned bridge's supplemental diagnostic
fields and ordinary thrown-value normalization under the original shared deadline.
Authored result/error conversion completes before the private denial check; only
inert detached JSON reaches final encoding and the bounded primitive transport.
Boxed values, nonfinite numbers, failed/cyclic/stateful conversion and denial during
Error getters/toJSON have permanent actual-QuickJS controls. Stack frame text
reflects the private wrapper and is not a stable ABI. Empty agent and human text
still validates required owned provenance; absent assignee and existing cancellation
contracts remain intact. New files contribute 216 parity and 38 empty-template
regressions; the original red runs independently expose the repaired mechanisms.

An additional parent reproduction finds a live context-definition ownership gap:
a caller changes an originally clean definition after start, while taint analysis
retains the earlier definition; successful node output exposes the synthetic
canary. Taint analysis and raw resolution now consume the same frozen owned
context definitions in fresh, resumed and budget-preparation paths. This is a
context-definition snapshot, not a claim that every workflow field is immutable.
Seventeen permanent actual-engine controls cover immediate and suspended-read
mutations, same-process resume and trusted raw-resolver compatibility. Actual
file-backed SQLite also pins the successful clean mutation control and native
Error-result persistence, with nonempty event/step/run rows.

Final corrected-source author gates pass: all workspace lint/typecheck, **600 files
/ 13,720 passing tests / 20 established skips**, six-workspace isolation, source
formatting/whitespace, dependency/vendor/platform fences and 3,365 relative links
across 72 changed Markdown files. All six build tasks pass (five cached).
Six fresh fixed/removal/restored cohorts pin context qualification,
public-template refusal, finite VM latch, native result projection, thrown-value
projection and actual engine definition binding. Removals produce **6 / 6 / 64 /
60 / 81 / 8** named assertion failures; fixed/restored inventories are **29 / 19 /
184 / 216 / 216 / 17**. All eighteen final runner receipts report zero unhandled
errors and all sources restore byte-identically before the final full author suite.
An exploratory witness-name mismatch was rejected rather than certified.

These remain local author controls, not full CI/coverage/native-platform or
whole-wave certification. A fresh security revalidation and two NEW independent
complete cumulative clean rounds after the last material correction remain
required before Step 4. Baseline evidence, detailed reports and local controls
stay Git-ignored. No new decision, credential, paid call or release is pending.


### Wave 3 Step 3 conversion-order correction — 2026-10-16

The NEW complete cumulative review at `1728c9b4` is **not clean**: one High
finding shows diagnostic hydration occurring before ordinary JSON traversal
finishes. The fresh security revalidation independently corroborates it; no
additional declared-secret confidentiality or ambient-authority defect is verified.
The parent reads both complete reports and reproduces the issue against the
isolated accepted Step 2 runtime. Neither review counts toward acceptance.

An undefined diagnostic getter changes a later sibling value from 1 to 2;
the actual WorkflowEngine/standard executor consequently fails a previously
successful output schema. The same sequencing defect changes an ordinary thrown
object from memory to stack classification. A separate supplemental object's
`toJSON` can also run before later diagnostic getters, changing their values.
These are one converter-order defect, not three independently counted findings.

The converter now completes the original JSON traversal once, then reads all
missing diagnostic fields in the pinned bridge's fixed order, then serializes
supplemental values before the private denial check. It removes the eager root
replacer and boxed-value emulation. Final encoding still contains detached JSON
only; the original authored `toJSON` is not invoked again, no successful authored
object is dumped after denial observation, and the original VM deadline remains.
Permanent actual-VM controls pin sibling values/key order, supplemental callback
ordering, ordinary thrown classification and denied supplemental conversion.
The parity suite grows from 216 to 243 cases; its pre-fix run has 16 genuine
assertion failures. A separate real-engine output-schema test fails before repair
and completes with exact output after it. Eleven independent old/current probes
also match after correction. Detailed raw probes remain local and Git-ignored.

Fresh final author gates pass on the restored corrected source: all workspace
lint/typecheck, **601 files / 13,748 passing tests / 20 established skips**, all
six build tasks (five cached), fences, 601-file/six-workspace isolation, changed-
source formatting/whitespace and 3,365 relative links. Seven fresh causal cohorts
produce **6 / 6 / 64 / 75 / 84 / 8 / 1** named removal failures, with passing
fixed/restored inventories **29 / 19 / 184 / 243 / 243 / 17 / 1**, respectively.
All 21 final runner receipts record zero unhandled errors; every source restores
byte-identically before the final passing full author suite. The seventh cohort
pins the actual engine output-schema success rather than a fabricated converter.

Fresh security revalidation and two NEW independent complete cumulative clean
rounds after this final material fix remain required before Step 4. All earlier
nonclean rounds remain explicitly nonclean. These author gates are not full CI,
coverage, native-platform or whole-wave acceptance; later plan ownership remains.


### Wave 3 Step 3 primitive-conversion correction — 2026-10-16

The attempted NEW cumulative review at `a2db0b77` verifies one further High:
primitive values enter object diagnostic hydration, invoking prototype getters
that the accepted native primitive conversion never reads. The tool interrupts
that agent's turn; its retained report is explicitly **partial and nonclean**, not
complete cumulative acceptance. The separate completed security revalidation
independently corroborates the primitive discrepancy and is also **nonclean**;
no additional declared-secret confidentiality or authority issue is verified.
The parent reads both reports and reproduces the ordinary API difference against
accepted Step 2. No incomplete or earlier nonclean round counts toward acceptance.

A finite Number/String/Boolean value must not invoke an unused diagnostic getter.
Thrown primitive conversion has the same requirement; a custom BigInt `toJSON`
previously changed ordinary private detail from `2` to `changed`. Conversion now
branches on the original primitive type before object hydration or JSON hooks.
Boxed values and objects yielding scalar JSON keep their separate object path;
numeric tags, the original deadline, supplemental conversion before denial and
inert final transport remain intact.

The actual-VM parity suite grows from 243 to 309 cases. The first 54 new pre-fix
assertion failures cover every diagnostic field on Number/String/Boolean across
all three expression kinds and ordinary thrown String/Boolean/BigInt behavior.
A further parent comparison exposes the same unwanted lookup after object JSON
conversion yields a scalar: boxed Number/String/Boolean and object `toJSON`.
Twelve additional regressions fail before the converted-shape guard and pass
after it. Hydration now requires converted object/array data; original object
conversion and original-type classification still apply. The corrected focused
suite passes. These are synthetic local compatibility controls, without real
credentials, provider calls or external targets.

Fresh corrected-source author gates pass: all workspace lint/typecheck, **601 files
/ 13,814 passing tests / 20 established skips**, six builds (five cached), source
format/whitespace, vendor/platform/dependency fences, 601-file/six-workspace
isolation and 3,365 relative links. Ordinary primitive and boxed/scalar old/current
comparisons match after repair.

Nine final fixed/removal/restored cohorts pin qualification, template refusal,
finite latch, result projection, thrown projection, owned definition binding,
actual engine hydration order, native primitive conversion and scalar hydration.
They produce **6 / 6 / 64 / 75 / 105 / 8 / 1 / 6 / 12** named removal failures;
fixed/restored inventories are **29 / 19 / 184 / 309 / 309 / 17 / 1 / 309 / 309**.
All 27 final runner receipts record zero unhandled errors and exact source
restoration precedes the final passing full suite. A truncated Vitest witness
name rejected an exploratory attempt; it was not published as acceptance, and
the final run pins the stable unique named assertion plus its mechanism marker.

Fresh security revalidation and two NEW independent complete cumulative clean
reviews after this final correction remain required before Step 4. The interrupted
review is incomplete; none of the nonclean or incomplete sittings is counted.
These local author controls do not claim full CI/coverage/native-platform,
whole-wave acceptance, a release or new permission. Detailed records stay ignored.


### Wave 3 Step 3 acceptance — 2026-10-16

Step 3 is independently accepted at `5d8c0b0cf91604c2c270ff0351b4168508fe6041`.
Two NEW independent complete cumulative clean reviews after the final material
fix cover all **42 changed paths / 108 hunks**, including all thirteen added
files and actual consumers. Selected reviewers are gpt-6-astra/high (30 files /
1,513 independently passing tests) and gpt-6.1-sol/high (20 files / 1,193 tests).
Both report zero findings and independently run the 26 retained ordinary
Step-2/current comparisons with matching outcomes. The parent reads both full
reports. Earlier nonclean sittings and the interrupted incomplete review are
not counted. Detailed reports remain local and Git-ignored.

The separate NEW secret-flow security sitting is clean at the same source,
with **19 files / 1,156 independently passing tests**, no skips and independent
inspection of all 27 causal phases. It traces actual producer/preparation/resume,
VM/template, standard-handler/public-event and native SQLite boundaries; its
mandatory checklist distinguishes unchanged/out-of-scope paths. This is a
security disposition, not a third complete correctness round. Test counts overlap
and are not added to author or other reviewer totals.

ADR-0113 implementation and the actual context exposure are complete. #92 has
its approved explicit documented limitation: no current authored tool-mapping
producer exists, optional external provenance is unverified, and future mapping
must supply final effective-argument provenance. No fake producer or general
value-scanning guarantee is introduced. Canonical contracts preserve required
owned low-level metadata, direct-input compatibility, optional absence/key order,
finite observed-access semantics, native result/error conversion and trusted raw/
historical-content limits. All verified review findings and the parent-owned
context-definition race are repaired; no scoped review finding remains open.

Final author evidence remains precisely attributed: **601 files / 13,814 passing
tests / 20 established skips**, workspace lint/typecheck, six builds (five cached),
fences, isolation, formatting/whitespace and relative links. Nine exact-restored
causal cohorts and the final full passing suite precede acceptance. This metadata
landing does not claim execution at a successor, full CI/coverage/native-platform,
whole-wave acceptance or merge. Step 19 retains those final gates/publication.

Next is Step 4's approved minimal error/envelope substrate. Read-only inventories
for Steps 4–5 are preparation, not implementation acceptance. No user decision,
credential, provider capture, billing or release action is pending.


### Wave 3 Step 4 error/envelope substrate — implementation checkpoint, 2026-10-16

The approved #213/#219 increment introduces the minimal shared `RelaviumError`
without a new discriminant, name, context or cause policy. Existing family
constructors and descendant parents remain unchanged. The source inventory
replaces the historical 15/17 estimates: **96 existing error declarations**,
including 86 module exports and ten non-exported implementation error classes. Of those
exports, **83 belong to production** (60 unique package-root-public identities
and 23 implementation exports); three others belong to capture/conformance
tooling. Public aliases/re-exports do not create another class identity.

Migration changes **46 direct native-Error roots across 37 production files**.
Their 37 existing module-exported production descendants acquire the same
ancestry through their current parents. The unchanged private `OsTimeoutError`
also inherits it through `OsCapabilityError`; it is additional to that export-
scoped count. The new base itself is additional to the 96-declaration intake.
Private class sources, capture/conformance errors, vendor exceptions and plain
seam unions retain their existing implementations. This is a scoped disposition, not a claim that
every thrown value or private control-flow path has shared ancestry.

| Package | Module-exported production classes reached | Direct roots changed | Existing roots |
| --- | ---: | ---: | --- |
| `packages/shared` | 10 | 10 | `NonCanonicalValueError`, `ExistingAncestorError`, `MediaAdmissionError`, `CorruptRunEventError`, `RunSuspensionCorruptionError`, `AppendConflictError`, `LeaseFencedError`, `EffectTransitionError`, `EffectConflictError`, `InvalidUsageEvidenceError` |
| `packages/llm` | 9 | 2 | `LlmConfigError`, `LlmProviderError` |
| `packages/core` | 29 | 16 | `AgentParseError`, `SessionStateError`, `AgentTurnError`, `BudgetExceededError`, `BudgetPauseError`, `CommitmentDurabilityError`, `InvalidDispatchAllowanceError`, `EngineStateError`, `RunLoopInvariantError`, `NodeMediaPinError`, `LedgerDurabilityError`, `WorkflowParseError`, `InterpolationError`, `WorkflowContextError`, `SandboxError`, `ToolDispatchError` |
| `packages/db` | 12 | 12 | `DbOpenError`, `MediaStoreFilesystemError`, `MediaTemporaryMaintenanceError`, `MediaWriteError`, `ModelCatalogCapabilitiesError`, `ProviderHeaderPolicyError`, `UnreadableRunEventLogError`, `SafeEgressError`, `SessionEffectPrivacyError`, `SessionEffectTurnError`, `SessionMessageBoundaryError`, `SessionUsageError` |
| `packages/mcp` | 8 | 1 | `McpError` |
| `apps/cli` | 15 | 5 | `StdioResolutionError`, `ConsentStoreError`, `HostCapabilityError`, `CliError`, `KeychainUnavailableError` |

Existing structural budget, corruption, unreadable-history, provider-header and
media-admission boundary classifiers retain their individual acceptance rules.
Local identity guards and private WeakMap authority also remain unchanged; the
base is neither a safe-message classifier nor cross-bundle authority. New foreign
class tests are explicitly simulations, not execution of a second packed bundle.

The retained `BaseEventSchema` now uses the same parsed correlation refinement
as the full run family. Direct both/neither cases fail; declared full event
payloads remain intact. Generic envelope projection is not substituted for a full
event. Lenient opposite-key/future-field stripping, strict accounting boundaries,
nine cross-field guards and unknown-discriminator forward reading are preserved.
The authored envelope suite first reports exactly two assertion failures on the
unchanged implementation and passes all forty controls after repair.

Six package/surface compatibility files add thirty constructor/guard controls.
Four local fixed/removal/restored cohorts pin direct envelope correlation, full
payload preservation, native cause forwarding and foreign structural budgets.
Passing fixed/restored inventories are **40 / 40 / 6 / 11**; removal produces
**2 / 10 / 3 / 1** failed tests. The payload cohort has nine direct AssertionErrors
and one secondary test-local TypeError after its payload is removed; each cohort
contains its pinned named, marker-bearing assertion failure. All twelve final runner receipts
record zero unhandled errors, and exact source restoration is verified before
broad author gates. The retained controls are local author evidence, not full CI,
coverage, native-platform or whole-wave acceptance.

Broad author checks pass: **608 files / 13,884 passing tests / 20 established
skips**, all workspace lint/typecheck, source formatting/whitespace, vendor and
platform/dependency fences, 608-file/six-workspace isolation and 3,511 relative
links across 74 changed Markdown files. Dependency outputs are built before
native/dist consumers; all six build tasks pass.

Two NEW independent complete cumulative clean reviews remain required before
Step 5. Detailed source inventories and reports remain Git-ignored. No new ADR,
user decision, credential or external operation is needed.


### Wave 3 Step 4 first review corrections — 2026-10-16

The complete cumulative review at `b11703a0` covers all **50 changed paths /
97 hunks** and independently passes **23 files / 730 tests**. It verifies every
existing class member list unchanged, resolves public aliases, and audits all
twelve causal receipts and reconstructed mutation hashes. It reports two Low
checkpoint precision findings and no verified product defect; this sitting is
**not a clean acceptance round**.

The parent reads the full report and verifies both findings. The inventory now
qualifies its 83-class/37-descendant counts as module-exported production and
explicitly records the additional unchanged private `OsTimeoutError` descendant.
The retained payload removal is accurately described as nine AssertionErrors
and one secondary test-local TypeError, separate from the zero-unhandled runner
receipt. Existing product and test bytes remain unchanged. These documentation
corrections do not claim a fresh source execution; author gates retain their
original source attribution. Two NEW complete cumulative clean reviews at the
corrected head remain required before Step 5.


### Wave 3 Step 4 acceptance — 2026-10-16

Step 4 is independently accepted at `b16c3b4c29a82396c8f060f6e3ed199e2f340476`.
Two NEW complete cumulative clean reviews after the final correction cover all
**50 changed paths / 97 hunks**, including the eight additions, unchanged error
descendants and actual consumers. Selected reviewers are gpt-6.1-sol/high
(**26 files / 819 passing tests**) and gpt-6-astra/high (**29 files / 1,214 tests**),
with zero skips in their independent runs. The parent reads both complete reports.
The earlier two-Low sitting remains nonclean; both verified documentation findings
are fixed, with no scoped review finding left open.

The minimal error base and direct envelope correction satisfy #219/#213. Every
existing class member list is unchanged; export-scoped counts, private inherited
timeout, structural versus local authority and native versus plain seam values
are explicit. Full payload and historical-reader controls remain effective.
Both reviewers independently audit all twelve retained causal receipts, source
and reconstructed mutant hashes; the secondary test-local payload TypeError is
accurately separated from zero runner-unhandled errors.

Author evidence retains its original scope: **608 files / 13,884 passing tests /
20 established skips**, workspace lint/typecheck, six builds, source formatting,
fences, isolation and relative links. Reviewer counts overlap and are not added
to author counts. This metadata landing does not claim new source execution,
full CI/coverage/native-platform, whole-wave acceptance or merge. Detailed
reports remain local and Git-ignored.

Step 5's tools/engine-tail implementation now proceeds automatically. Its read-
only test designs are preparation, not acceptance. Necessary same-defect registry
redaction prewalks and remaining identifier-sort consumers stay in that increment.
No new ADR, user decision, provider capture, credential or external operation is
pending. Step 19 retains final whole-wave validation and publication.

### Wave 3 Step 5 implementation checkpoint — 2026-10-16

Step 5 is implemented from accepted Step 4 base
`e60b10478f5f5200f8ef55d01a6976c2dcb9fb87`; independent security and two NEW complete
cumulative correctness rounds are still required. This is author evidence, not
acceptance of Step 5 or the whole wave.

| Queue | Implemented or certified disposition |
| --- | --- |
| #95 | Executable effective-argument UTF-8 admission with cheap count, member-length and aggregate-length prechecks before byte scanning. Inclusive limits and model metadata have their [canonical home](../../reference/shared-core/built-in-tools.md#tool-input-bounds). Actual refusals precede target, confirmation, journal preparation, dispatch hook and host; small/exact-cap/mapping/config-exclusion positives reach the real journal and host. |
| #96/#98 | All thirteen built-ins describe their 28 immediate model-visible properties and array items. Actual ToolDef parsing and all four wire normalizers retain bounds/descriptions, required distinctions and configuration exclusions; Gemini keeps its existing dialect treatment of additional properties. |
| #94 | Both bounding walks and both registry prewalks use ancestor-path cycle guards with retirement in `finally`, including early returns. Shared siblings survive; true back-references remain finite. Real events, reference replay/conflict and native SQLite digest controls distinguish clean selections while retaining deliberate secret-projection equality. |
| #76/G9 | Ordinary/budget prompt resolution forwards the identical signal and checks after its final await; human-gate final resolution does likewise. The actual engine race produced a pause on both delivered and stored rails before the fix, contrary to the preparation note's fence-preservation prediction. The corrected real handler returns cancelled and publishes no pause. Live execution and gate pause/resume remain positive controls. |
| #82 | Quoted filter arguments decode only matching quote/backslash escapes after structural splitting. Exact runtime default values, structural delimiters, unknown escapes and Windows path text are pinned. Two old assertions contradicted their own intended decoded values and are corrected. |
| #275 | A private min-heap preserves Kahn's minimum authored index across the entire ready set. An independent full-sort oracle compares complete plans/maps over generated and named graphs, derived edges and cycles. Empty workflow admission remains refused. |
| #258/#259 | Four lookup-local parameters become `modelId`, without renaming request/payload fields. Twelve live unpinned comparator expressions use the existing UTF-16 code-unit helper, including the verified DB money/coverage model union. The private preparation note overcounted these as thirteen. Case folding, groups, ties, raw historical model names and MCP set/ordered-vector distinctions remain. The two explicitly English LLM display comparisons are unchanged. |
| #93/#97/#214/#87 | Descriptive dispatch scope cannot widen immutable host filesystem authority; stale egress comments describe conditional host availability. Workflow version is an optional string with Semver recommended, not validated. System append remains literal authored text with existing reference/dependency/secret scans; Proposed ADR-0060 is not activated. |
| #308 | Actual default/approval-enabled sessions and workflow-agent execution all retain `gateApproved:false`, refusing before confirm, journal prepare and process work. The message offers manual review/commit. A true-gate registry positive is explicitly synthetic, not an invented shipping workflow approval route. |
| #79/#75/#78/#216/#274 | Equivalent abort/backoff outcomes are combined. Existing timeout/scheduling and tiered journal behaviour are certified by their owning suites, not rewritten. Public `success` remains unchanged. Exported bus `validate:false` remains compatible, with actually invalid payloads and mandatory raw correlation/counter/clock/listener controls. |

Twenty-one new test files contribute 393 cases; actual git-denial controls and the
split pre/post-preparation cancellation case add four cases in existing owners.
Author-reported baselines describe 115 expected bound/metadata failures, alias/replay/digest
failures, eight quoted-decoding failures, six direct gate failures, the actual
engine pause race and forty prompt-cancellation failures. Fixture/API mistakes
were corrected separately; they are not attributed to production. DAG, literal
append and bus controls certify existing behaviour rather than claim old defects. Original raw baseline
outputs were tool-response observations, not retained physical runner reports. The
retrospective ignored author note discloses that limit; fresh broad/causal records
below are independently retained. Later comparator-observer test refinements are
attributed to final source rather than earlier author hashes.

The broad workspace command passes: **629 files / 14,281 passing tests / 20
established skips**, plus all workspace lint/typecheck tasks. Standard Turbo cache
reuse for unchanged inputs is retained; this is not a claim that every test was
freshly executed. The two initial broad failures were stale metadata and the
superseded pre-aborted preparation expectation; both are corrected without
weakening the actual range/provenance/cancellation controls.

Thirty-one selected local causal cohorts retain **93 zero-unhandled-error runner
receipts**: fixed passes, a named expected assertion fails on mechanism removal,
and exact-byte restoration passes. Each source/mutant hash and expected collected
count is checked. Seven completed cohorts and the remaining twenty-four are
retained separately: an initial eighth-cohort witness-label mismatch stopped the
first capture after restoring source; that incomplete attempt is not accepted.
Four secondary test-local errors are retained: three replay expectations whose promises
incorrectly resolve, plus the DB poisoned-comparator error. They are distinct from zero
runner-unhandled errors. The priority mutation checks authored-minimum semantics,
not a benchmark; schema/guard removals do not certify unrelated mechanisms.
The existing source-owned reporter is pinned; these selected probes do not claim
whole-workspace provenance or remote/native-platform acceptance.

Six forced builds pass without cache reuse before native author tests and again after
source restoration. Formatting covers all 46 changed TypeScript files; seam/dependency
fences, six-workspace test isolation and relative-link/append-only checks pass.
The document scan checks 74 Markdown files / 3,516 relative links and 31 pre-existing
ADRs. These gates are separate from the review rounds below.

Canonical changes land only in the owning tool, YAML, runner and event contracts.
Detailed baseline, causal and review records remain local and Git-ignored. There
is no new dependency, engine platform import, error taxonomy, grant feature, ADR,
provider call, credential/billing action or external publication. Final full CI,
ordinary/enforced coverage, platform and whole-wave publication remain Step 19.


### Wave 3 Step 5 first review correction — 2026-10-16

The first complete cumulative correctness review at `25cac33a` covers all 52 paths /
124 hunks and freshly passes 35 files / 942 tests, direct four-package typechecks
and all 46 changed TypeScript lint targets. Its result is **nonclean**: one verified
Medium canonical-documentation finding, with no production defect. It is not either
of the required clean rounds.

The parent reads the full report and confirms all three stale statements: summaries
are produced by registry bounding, not truncated in the bus, and network availability
is profile-dependent rather than waiting for historical 1.AE. The canonical registry
reference now describes the actual chat-read-write wiring, retains the read-only and
workflow omissions, and states the string-seam/spill limitation accurately. No runtime
capability or workflow network feature is added. The author checkpoint also makes raw
baseline-retention and later test-observer attribution explicit.

The separate independent security sitting at `25cac33a` passes 18 files / 680 tests,
zero skips, with no verified finding. Its evidence is source-pinned; this correction
changes only two documents. All production/test bytes and the 31 causal source hashes
remain unchanged. Existing broad/build evidence keeps its original source and cache
scope. Relative-link/append-only and diff checks are rerun for this document correction;
two NEW independent complete cumulative clean rounds remain required after this fix.


### Wave 3 Step 5 acceptance — 2026-10-16

Step 5 is independently accepted at
`fd54e22a776f13f92b520b42737928543cfe9532`. Two NEW complete cumulative clean
reviews after the final documentation correction cover all **52 paths / 127
hunks**, including all 21 new files, nineteen production paths, six old-test
owners and six documents. Reviewers are gpt-6-astra/high (**35 files / 942 passing
tests**) and gpt-6.1-sol/xhigh (**37 files / 987 tests**), both with zero skips.
The parent reads both full reports. The original one-Medium sitting remains
nonclean history; its three stale registry statements are corrected, with no
verified scoped finding left open.

The separate clean security sitting at `25cac33a` passes **18 files / 680 tests**.
Its subsequent documentation-only revalidation through the accepted head is
clean: all 46 production/test TypeScript paths and 31 causal source hashes are
unchanged, with no new test execution inferred. The [security register](../../standards/security-review.md#sitting-wave-3-tool-admission-and-alias-safe-projections-2026-10-16)
records its scope and limits. Both correctness reviewers independently audit
all **31 accepted causal cohorts / 93 zero-unhandled runner receipts**, source
and reconstructed mutant hashes, expected assertion witnesses and exact-byte
restoration. The incomplete initial eighth capture, four secondary test-local
errors and retrospective author baseline limits remain explicitly attributed.

All Step 5 queues in the implementation table above now have independent scoped
acceptance. Actual effective-input bounds, alias-safe event/journal projections,
ordinal identifier consumers, final-await cancellation and authored-minimum DAG
semantics are pinned. Existing timeout, journal, literal-append and bus compatibility
controls are certified without inventing old defects. Actual sessions and workflow
agents retain Git gate refusal; the approved registry positive is synthetic.
Canonical contracts preserve conditional host availability and intentional
projection/trust limits rather than claim new authority or lossless secrecy.

Broad author evidence remains **629 files / 14,281 passing tests / 20 established
skips**, all workspace lint/typechecks, six forced builds before native consumers
and again after restoration, source formatting, isolation, fences and document
checks. Normal test-cache reuse and original source attribution remain explicit.
Reviewer selections overlap and are not added to author totals. This metadata
landing claims no new source execution, full CI, ordinary/enforced coverage,
native-platform acceptance, whole-wave acceptance or merge. Detailed reports
remain local and Git-ignored.

Step 6 proceeds automatically under approved ADR-0110/0111: pure early flags,
closed code/origin and observation contracts, one descriptor authority, compatible
legacy/model and separate CLI discovery projections, source-verified classification
inventory and creation-specific invocation ownership. Its read-only designs are
preparation, not implementation acceptance. Real fatal/native integration and
JSON-help behaviour retain their later steps. No new ADR, user decision, provider
capture, credential, billing or external operation is pending; Step 19 retains
whole-wave validation and publication.

### Wave 3 Step 6 implementation checkpoint — 2026-10-16

**Implemented on `development`, not independently accepted.** The increment starts
at Step 5 acceptance metadata `952115d3`. Approved ADR-0110/0111 now have a pure
process/discovery substrate before their runtime consumers. The
[CLI contract](../../reference/cli/commands.md#proposed-wave-3-cli-compatibility)
owns exact classifications, descriptor fields and staged integration boundaries.

One closed CLI code/origin/exit authority preserves the five existing codes for
refusal, including operational `internal`/1, and adds distinct fixed infrastructure,
output, storage and settings-write diagnostics. The heavy runtime classifier
re-exports the same constructor/guard; generic unknown handling remains unchanged
until Step 8. The shared error constructor and filesystem limits have supported
pure package leaves without loading the schema barrel; config/root exports retain
identity. Early flags share descriptor grammar, preserve command tokens and the
terminator, reject nonabsolute root syntax before filesystem work, and apply exact
DEBUG=1 with explicit quiet/verbose conflict and override rules. Semantic category
selection is pure; production output owners remain Step 10.

The one enriched descriptor authority derives the current Commander grammar,
global help and all **24 unchanged strict alias-free model entries**, compared
against a literal pre-refactor fixture. Twenty-nine descriptors include executable
containers, four nonexecuting groups and the unavailable init stub. Actual actions
receive injected dispatch, preserve every binding and await its result; finite
implementation bindings are checked both ways. The separate explicit public DTO
supports canonical subtrees, aliases and complete option grammar without exposing
internal compatibility/loader state. Canonical chat aliases, pricing flags and
key-removal force metadata are staged: production JSON help and those behaviours
remain Step 10. Compiler-emitted import controls prove the pure local leaves;
the separate Commander adapter guard stops at the external framework boundary,
not at an imagined dependency-free or packed/native proof.

The creation-kind registry keeps actual retirement separate from stop/join/reap
attempts. It starts no idle session join at registration, removes settled owner
closures, retains unacknowledged owners and bounded classifications, samples only
actual workflow health and applies the total sticky exit order. Reentrant cleanup
shares one operation. Classification, terminal restoration and helpers consume
one live absolute fatal budget; expiry never grants retirement or store-close ACK.
Every owner still receives finite synchronous cancellation at zero remaining
budget, while new joins/restoration/reap helpers are refused. Actual native,
RunHandle, AgentSession, sink and terminal adapters remain Step 8.

The source-verified inventory covers twelve literal internal constructors, caught
and forced-exit owners, and storage/open boundaries. It preserves supported inline
recovery and records the constructor-time addon/ABI ambiguity inside DbOpenError:
a blanket typed-error or arbitrary cause-tree classification is insufficient.
Minimal origin adapters land in Step 8; central openLocalDb remains last in Step 18.

Author evidence distinguishes genuine original defects from new-substrate controls.
The original lexical baseline is **52 cases / 46 passing / six failing**; an
intermediate lookup exposes three prototype-token failures before the private Map
fix. New owner regressions reproduce signal-state poisoning, reentrant join order,
classification-time renewal and skipped sibling cancellation after expiry. Test
fixture fixes preserve exact context identity and complete unique case names;
they are not product regressions. Initial lint failures were unused imports/fixture
typing, corrected before the final gates.

All **14 final causal cohorts / 42 structured zero-unhandled runner receipts**
pass fixed/removal/restored checks, exact named assertion witnesses, complete
unchanged inventories, source/test/reporter pins and byte-exact restoration.
Earlier incomplete runs stopped on duplicate case labels or a quoted witness
mismatch; neither is counted. Two existing secret controls were repointed to the
real generic action/parser path without removing IDs or cases. Their retained
isolated captures each contain one selected control / three verified receipts,
1,223 physical source/tool files and 457 installed dependency packages; forwarding
is 14/13/14 passing and parser projection 28/22/28. These selected captures are
explicitly not a complete 41-control family. These captures precede the final finite-cancellation correction; their target
source and selected test bytes are unchanged. The parent separately verified
retained stdio, runtime receipts, evaluations and manifests. Filesystem's 110 anchors
remain unique; no filesystem control was changed.

Final author gates pass: **639 files / 14,554 passing tests / 20 established skips**,
all workspace lint/typechecks and all six forced builds after causal restoration.
The final CLI suite runs fresh; other workspaces reuse valid normal test caches.
Earlier broad execution at the pre-final registry revision records 14,553 passes;
its counts are not added to the final total. All **322 acceptance-tool tests** pass,
alongside tooling lint/typecheck, seam/engine dependency fences, DB synchronization,
639-file test isolation, formatting of all 35 changed code/data paths, bundle closure,
compiled CLI smoke and document/diff checks. Native consumers use rebuilt dist,
not ordinary-test source aliases. Two NEW complete cumulative reviews and the
scoped security sitting remain pending; author checks do not replace them.
No full CI/coverage, native-platform or whole-wave acceptance is inferred from
these unit/source checks. No new dependency, ADR, decision, provider capture,
credential, billing or external action is introduced. Steps 7–19 remain open;
commit and two NEW independent complete cumulative clean rounds plus a separate
scoped security sitting are required before Step 7 implementation proceeds.


### Wave 3 Step 6 acceptance — 2026-10-16

Step 6 is independently accepted at
`f3cab0db993714006e8c318f37618e2cf2683333`, from Step 5 metadata
`952115d3506b0078faefa10dee8dfb4236e19c1c`. Two NEW independent complete
cumulative clean reviews cover all **38 paths / 95 zero-context hunks**, including
all nineteen new files. Reviewers are gpt-6-astra/high (**26 files / 512 tests**, plus
322 acceptance-tool tests) and gpt-6.1-sol/xhigh (**16 files / 395 tests**, plus
119 related tooling tests), with zero skips and no verified finding. The parent
reads both full reports, independently checks the evidence and records no source
change after these rounds. Differential controls preserve all 24 original model
entries, 29 Commander nodes and 48 old/new action payload comparisons.

The separate NEW clean security sitting passes **14 files / 340 tests**, plus one
acceptance-tool test, with zero skips. Its scope is the pure process/discovery
substrate, not the later native fatal path. All fourteen final causal cohorts /
42 structured zero-unhandled receipts retain named assertion witnesses, unchanged
case inventories, exact direct target/test/reporter pins and restoration. These
local cohorts do not claim a complete transitive dependency snapshot. Two selected
existing secret controls each retain three physical receipts, 1,223 source/tool
files and 457 dependency packages; they precede the last registry fix, with their
target/test bytes unchanged, and are not a complete 41-control capture. Both full
reviewers and the security reviewer independently audit these records.

Final author evidence remains **639 files / 14,554 passing tests / 20 established
skips**, all workspace lint/typechecks, six forced builds after causal restoration,
322 acceptance-tool tests, source fences, DB synchronization, test isolation,
formatting, compiled CLI smoke, bundle closure and document/diff checks. The final
CLI test suite runs fresh; other workspaces use valid test caches. Review executions
are independent scoped checks and are not added to the author total. This metadata
landing does not imply new source execution, full CI/coverage, native-platform,
installed-tarball or whole-wave acceptance.

Step 7 proceeds automatically through the recorded **7a → 7b** split. The split
preserves every original finding and acceptance obligation. Step 7a proves the
actual finite compiled graph and catalog ordering; Step 7b adds the independently
inspected installed artifact and required platform/minimum-runtime controls. Whole
Step 7 remains open until both pass; Step 8 does not start after 7a alone. Registry
identity before Step 8 means one canonical module, one bootstrap invocation object
and preserved context identity across lazy routes. Actual registered native-owner
stop/join evidence belongs to Step 8. No new ADR, dependency, deferral, provider
request, credential, billing or user decision is introduced.


### Wave 3 Step 7a implementation checkpoint — 2026-10-16

**Implemented on `development`, not independently accepted.** The recorded 7a → 7b
split starts at Step 6 acceptance metadata `b09008e7`. This increment implements
only the guarded lazy source/runtime and finite compiled graph under ADR-0111.
[Packaging](../../reference/cli/packaging.md#compiled-graph-implementation-boundary--step-7a)
owns its current boundary; installed packaging, native fatal integration, maps/
custody and new JSON help retain Steps 7b, 8, 9 and 10 respectively.

The real bootstrap constructs one invocation before guarded imports and threads
that exact object through actions and interactive Home. Existing error and
sanitizer implementations have pure supported leaves, retaining root identities.
An initial grant-admission graph reached the core/provider barrel through its error
base; the exact existing ToolDispatchError base is extracted without changing the
family or private filesystem authority. Directory admission now precedes optional
file-cache seeding and the lazy runtime. Meta uses the same grammar but does not
stat an absent absolute grant. Pure syntax/size/count checks remain; no ad-hoc
help-token parser or model/user-derived import path is introduced.

One invocation-owned total file-cache attempt is lazy, concurrent/reentrant safe
and remains attempted after missing/torn/import failure. Nine priced executor
routes and Home use it before first runtime metadata access; current eleven DB
consumers remain unchanged and install the latest admitted DB tail. History,
provider management, authoring and media do not load an unused file cache; an
actual string agent fixture skips it. New tests distinguish injected action/
context observers from actual SQLite/cache/cost helper integration. Existing
agent fixture tests also pass; no eleven-surface end-to-end claim is made.
MCP installs the same build version token only at its actual construction choke.

One actual tsup invocation emits **24 flat ESM files / 375 inputs**, with all
seventeen third-party runtime dependencies external. The entry alone has a
hashbang and executable POSIX mode. The new emitted checker parses every JS
loading edge and compares independent file/import inventories, dependency parity,
reachability and single input contribution. Seventy-six negative/positive tool
controls include actual esbuild split fixtures. Windows explicitly reports graph
scope without fabricating POSIX mode observations; actual tar headers belong 7b.

The untouched final compiled entry passes **175 native controls** on Node 22.23.1 /
macOS: forty current human meta forms × JSON/plain × absent-root/no-root, twelve
grammar refusals, real grant admission before services and two guarded deferred
import failures. Native witnesses forbid service/config/cache/grant/network/
subprocess activity and retain all 24 unchanged JS digests. Ten self-controls pin
these witnesses, descendant boundaries, UTF-8 output bounds and child termination.
This is repository-dist evidence, not an installed artifact, minimum Node or other
platform certification. Existing compiled workflow/budget/MCP-signal and native
media ownership smokes also pass; their deliberate failure controls are not
claimed as successful generation tests.

All **six final local causal cohorts / eighteen structured zero-unhandled receipts**
pass named assertions, complete unique inventories, direct target/test/reporter
pins and byte-exact restoration. Earlier partial execution stops on ambiguous
new test labels and is not counted; labels are made unique without changing
assertions. Four existing secret controls and one filesystem invocation control
retain IDs, mutation bodies and workloads after target moves. Their selected
physical captures each have three verified receipts and 457 dependency packages;
source inventories are 1,239, 1,239, 1,240, 1,240 and 1,248 files respectively.
These precommit snapshots name base `b09008e7` and their physical source pins,
not a future committed head or complete 41/110-control family. The parent verifies
stdio, runtime receipts, evaluations, manifests and restoration independently.

Final author gates pass **646 files / 14,659 tests / 20 established skips**, all
workspace lint/typechecks and six forced builds after causal restoration. The
final CLI suite runs fresh; ten of eleven test/build tasks reuse valid normal
caches in the workspace gate. All **408 acceptance-tool tests**, tools lint/
typecheck, seam/engine fences, DB synchronization, 646-file isolation, changed
code/data formatting, bundle closure, compiled smokes and document/diff checks pass.
Initial author failures are corrected test return typing, await-free async doubles,
the moved JSON-renderer lint requirement and one stale mutation anchor. A later
tooling run overlaps separately invoked coordinator captures and misattributes
their global temporary directories as a leak; serialized final execution passes.
No source cleanliness or gate is inferred from either failed run.

Two NEW independent complete cumulative clean reviews and a separate sanitizer/
bootstrap/package-boundary security sitting remain required before accepting 7a.
Step 7b, whole Step 7 and Steps 8–19 remain open. No new ADR, runtime dependency,
provider capture, credential, billing action, external release or user decision
is introduced. No full CI/coverage or native-platform publication is claimed.


### Wave 3 Step 7a acceptance — 2026-10-16

Step 7a is independently accepted at
`6ffdd63ef1eb621efa5b7cbe2749011e367fcf04`, from Step 6 metadata
`b09008e76b3c31e4cf0c51e93b3788e07ea117bb`. Two NEW independent complete
cumulative clean reviews cover every one of **60 paths / 127 zero-context hunks**,
including all 28 full new files. Reviewers are gpt-6-astra/high (**18 files /
547 passing tests**) and gpt-6.1-sol/xhigh (**16 files / 538 passing tests**), both
with zero skips, plus ninety tooling tests each. Both independently execute all
175 compiled controls and the 24-output / 375-input / seventeen-dependency closure.
The parent reads both complete reports. Neither round finds an actionable defect;
no material source change follows them.

The separate clean security sitting executes **10 files / 391 tests**, with two
established Windows-only skips, 86 tool tests, 175 compiled controls and four extra
debug/JSON failure controls. It checks exact extraction, loader/admission/privacy/
catalog boundaries and all retained scoped evidence. Both complete reviewers and
the security reviewer independently audit all eighteen direct causal receipts and
all fifteen selected physical phases. Direct target/test/reporter pins remain
narrower than the five isolated physical captures; the latter retain their
precommit base, differing broader source inventories and 457 dependency packages.
No whole-family or all-final-source equivalence is inferred. The second reviewer
also verifies the dependency inventory's 21,013 actual files.

Final author gates retain **646 files / 14,659 passes / 20 established skips**,
all workspace lint/typechecks, six forced builds, 408 acceptance-tool tests,
formatting/isolation/fences/DB synchronization, compiled smokes and document/diff
checks. Scoped reviewer totals are separate and not added to author counts.
Every final compiled JS digest remains unchanged throughout both reviews and the
security sitting. A separate unhooked local three-spawn-per-case comparison records
56–59 ms medians against the fresh 427–433 ms Step 6 baseline on the same Node
22.23.1 host; all six existing human-output forms retain exact stdout bytes.
The seventh case is the approved absent-root help refinement, exit 2 → 0. These
measurements are not a portable threshold or installed-package benchmark.

This accepts the **compiled graph only**. Whole Step 7 remains open. Step 7b starts
automatically with actual tar inspection, external same-digest installation,
complete chat/resume, migration/native/MCP/CAS/class/context controls and required
exact Node 22.0.0 Linux plus current `.nvmrc` (24) Linux/macOS/Windows consumers.
A read-only synthetic transport feasibility probe against unchanged repository
dist already observes two real SDK dispatches, two refused keyring constructors,
four durable transcript rows, same-session resume and exit 4 twice. The parent
reads its full ignored report. That probe is preparation, not installed-tarball,
minimum-runtime or platform acceptance; no real credential/service is used.
Actual registered native-owner cleanup remains Step 8, maps/custody Step 9 and
new CLI discovery Step 10. This metadata landing does not imply new source
execution, full CI/coverage, a release or whole-wave acceptance. No new ADR,
dependency, deferral, billing action or user decision is introduced.

## Wave 3 Step 7b implementation checkpoint — 2026-10-16

Step 7a remains independently accepted at source `6ffdd63e`, with metadata
`bc79793d`. Step 7b now implements independent archive inspection, exact installed
package controls and required platform aggregation under ADR-0111. This checkpoint
is author evidence, **not** independent acceptance or remote platform execution.
Whole Step 7 remains open. Two NEW complete cumulative clean reviews from the
Step 6 boundary, a package/CI security sitting, and actual required platform
success remain necessary before Step 8.

The [package tooling](../../../tools/cli-package/README.md) owns one fresh ordered
dependency emit and the sole CLI prepack build. It observes one actual prepack
build-start record and independently inspects bounded gzip/USTAR bytes without
extraction. Every JS and migration byte matches finalized/canonical files;
publication metadata matches pnpm's catalog/workspace transform. Negative controls
cover malformed/truncated/oversized archives, checksums, paths, types, modes,
hashbangs, map links, missing/extra/duplicate files and digest drift.

The consumer installs a verified copy outside the workspace with pnpm 9.12.3 and
the existing lifecycle allowlist. It compares all **69** installed public files,
records all **17** actual runtime dependency versions/metadata digests, repeats
**175** untouched-entry bootstrap controls and six fixed installed behaviour cases.
Actual chat uses the installed OpenAI SDK, bundled adapter/AgentSession and native
SQLite: two dispatches, four ordered durable transcript rows, same-session resume,
complete cost/usage and exit 4 after each persisted assistant. Its two synthetic
keyring constructor attempts are refused before native API access. The budget
preflight has one separately asserted refusal; no provider dispatch occurs there.
Actual native addons load in a separate unmodified process without a keychain API
call. Workflow/gate discovery and fresh-process resume, invalid budget decisions,
abort/idempotence, governed effect denial, MCP initialize version and media/CAS
cleanup/native iterator join execute through the installed package.

The new required pack → four consumers → aggregate jobs share an immutable
tarball identity. Current `.nvmrc` (24) Linux/macOS/Windows and exact Node 22.0.0
Linux must actually pass. Only the bounded public consumer summary is uploaded;
support logs, transport bodies and host paths are excluded. Source/digest/origin,
exact case inventory, dependency/file identities and runtime/platform checks
refuse incomplete or mismatched evidence. Job success is also required through
`ci.needs` and explicit checks under `always()`. Same-artifact consumer retries
retain prior successful legs and replace only their latest smoke receipts, never
the tarball. Release smoke uses the same consumer; Step 9 still owns original-TS
maps, encrypted custody and release discovery/archive/retry integration.

Local author execution on **Node 22.23.1 / macOS arm64** passes archive inspection,
outside-workspace install, all 175 bootstrap controls and all six installed cases.
The finalized-pipeline candidate is `a1a4d5f8…`; the separate local full-CI wrapper
candidate is `620aa6e5…`, and both have complete local consumer results. Earlier
`386c106b…` controls are attributed to their own artifact. These are distinct
local candidates, not one shared remote artifact or production candidates. Local
receipts retain their precommit source/dirty flag and cannot certify a CI leg.
The first setup omitted the consumer's package-manager pin and Corepack selected
pnpm 12; that failed attempt is excluded. The corrected consumer pins 9.12.3.
The first integrated metadata reader's 128-KiB limit rejected Drizzle's actual
larger package manifest; the bounded dependency-only limit is corrected to 1 MiB.
Neither author setup failure is presented as a product regression or deferred work.

Author gates pass **473 acceptance-tool tests** with no skips, tooling lint and
typecheck, formatting, seam/dependency guards and default compiled/media smokes.
The unchanged workspace suite retains **646 files / 14,659 passes / 20 established
skips**, with eleven valid cached tasks on this tooling-only increment; this is
not claimed as a fresh execution. Fresh ordered dependency emits and prepack build
execute in the package controls. Document/diff, isolation and DB-sync results are
recorded before review. No new runtime dependency, ADR, deferral, credential,
billing action, provider request or production upload is introduced.

### Step 7b first cumulative review and fresh-CI corrections — 2026-10-16

The first NEW complete cumulative review at `7b2b88ff` is **non-clean**: all
97 paths / 183 hunks / 58 full new files were covered, and two actual fresh-CI
failures were independently reproduced. Its 151 tooling tests, nine runtime files /
255 passes and 175 compiled controls are prepared-workspace evidence, not a
substitute for those failures. The separate security sitting found no verified
security defect but explicitly retained the failed platform gate. Both full local
reports are read by the parent and remain Git-ignored.

1. The POSIX pnpm action installs a regular shell wrapper with its JavaScript
   entry in the reviewed sibling package location. The resolver previously
   supported that location only on Windows. The correction uses the same explicit
   sibling-JS locations on POSIX, without parsing/executing shell text or weakening
   the pinned-version check. A native layout regression proves positive resolution
   and refusal when that sibling is absent; removing the correction breaks it.
2. The shared/LLM compiled root/leaf controls imported their own `dist` before
   lint/typecheck's existing `^build` graph guaranteed it. Local pre-existing outputs
   and cached gates concealed that prerequisite. Source identity/redaction checks
   remain in their owning packages; actual compiled identity, complete redaction
   corpus and service-free leaf-evaluation controls move to the CLI, whose declared
   dependencies and existing build graph already guarantee those outputs. No
   source alias, Turbo change, skip, dependency or weakened assertion is introduced.
   The read-only TypeScript host probe that hides only each owner's `dist` changes
   from four unresolved self imports to zero; fresh checkout execution is a
   separate required verification.

Corrected author gates pass **647 files / 14,660 tests / 20 established skips**:
all 17 lint/typecheck/build-prerequisite tasks are fresh, and all six workspace
test tasks execute freshly (the five prerequisite build tasks are valid cache
hits). **474 acceptance-tool tests** pass without skips. These results do not
yet imply new remote consumers, a clean post-fix review, or whole Step 7 acceptance.
The old failed push `38862829767` and its skipped consumers are not counted as
platform evidence. The corrections require two NEW complete cumulative clean
rounds after the final material fix, the affected security delta and real required
same-artifact platform success. No new decision or deferral is introduced.

### Step 7b second cumulative review and native CI corrections — 2026-10-16

The second NEW complete cumulative review at `cd78816a` covers **98 paths /
185 hunks / 59 full new files** and is **non-clean**. It independently verifies
both prior fixes but reproduces the required Windows consumer's preload failure.
Its 152 tooling tests, eight runtime files / 106 passes and 175 local compiled
controls do not substitute for Windows acceptance. The separate correction
security sitting is clean in its stated affected scope; neither report accepts
whole Step 7. The parent reads both complete reports.

Actual push `38864509846` produces a clean-source tarball and successful current
Linux, exact Node 22.0.0 Linux and current macOS consumers. Windows and the required
aggregate fail. The separate required usage gate also fails; a diagnostic agent
verifies the retained worker error against the uploaded exact-source manifests.
Neither failure is attributed to transient scheduling or reported as success.

- Windows `--import` must receive an ESM file URL, rather than a drive-qualified
  native path. The bootstrap child now retains the existing URL. Its permanent
  native regression relocates the unchanged tooling implementation beneath URL
  metacharacters; converting back to a path makes that exact test fail on POSIX
  too. An isolated copied-source fixed/removal/restored control exits 0/1/0 with
  the expected module-resolution assertion; production source is not mutated.
- The nested replay loader lacked the newly supported pure subpaths although the
  outer usage loader already knew them. The actual current producer failed before
  its semantic cases on `@relavium/shared/terminal-safe`. Five exact leaf mappings
  are added, preserving manifest membership, physical-root and opposite-mode
  refusal. Actual current/frozen workers exercise all five current leaves, the
  historical terminal-safe leaf, four absent-frozen refusals and unknown-subpath
  refusal. Module-body audits pin the loaded leaves; no frozen archive, dependency
  byte, replay prefix, positive control or semantic refusal is replaced.

An independently cloned `development` tree at `cd78816a`, with no prior dist/cache
and distinct sibling HOME/TMP/cwd roots, passes all 17 fresh lint/typecheck/build
tasks and all six fresh workspace test tasks: **647 files / 14,659 passes /
21 established CI-mode skips**. Five prerequisite builds are valid subsequent
cache hits. The earlier clone run had a test-harness HOME/TMP ancestry collision
and is retained as failed verification, not accepted. The ordinary prepared
workspace result remains separately **14,660 passes / 20 skips**; the additional
CI-mode projection skip is existing conditional behavior, not a new source skip.

The two native corrections pass **475 acceptance-tool tests**, tools typecheck,
lint and formatting, the 175 compiled bootstrap controls and the actual full
replay smoke (**16 refusals / two legacy controls / zero fetches**). The selected
owner-basis causal control has fixed/removal/restored inventories 2/2/2, with the
expected one semantic removal failure; it is not the complete usage matrix.
The first lint attempt rejects computed fixture imports; the correction retains
literal leaf imports and explicitly justifies only the owned URL-path fixture.
Two NEW complete cumulative clean rounds after these final material fixes,
affected security review and real required same-artifact platform success remain
necessary. No new decision, dependency or deferral is introduced.

### Step 7b third cumulative review and completed-consumer correction — 2026-10-16

The third NEW complete cumulative review at `eb21b86c` covers **103 paths /
193 hunks / 59 full new files** and is **non-clean**. It verifies the prior four
corrections, then independently reproduces the actual Windows consumer's outer
cleanup failure. All 175 bootstrap controls and six installed cases finish, but
`consume.mjs` still hosts installed SQLite native loads and fails to remove its
installation. A success receipt/summary was written before that required removal.
The real success-only upload and separate job-result aggregate refuse the failed
job. Its local 153 tooling / 106 runtime / 175 compiled passes do not close this
failure. The parent reads the full report and the separate native security sitting.

The correction runs the complete installed cohort in one bounded native worker,
joins actual process closure, and binds its bounded private report to the observed
worker PID, parent, source, artifact and runtime. The cleanup process imports no
installed native module. Required installation removal precedes both success
receipt and summary. An exercise failure retains its exact primary value through
secondary cleanup or diagnostic failure; a cleanup-only failure prevents success.
Seven permanent controls include a real copied SQLite addon in the worker,
forbidden native loading in the parent, worker exit before removal/publication,
wrong PID, nonzero-after-early-report, cleanup refusal and Error/null/undefined
primary retention. Existing timeout/output/join controls remain required.

Actual CI `38866746303` passes the **complete usage causal gate**, correcting the
nested replay alias failure. Pack, current Linux/macOS and exact Node 22.0.0 Linux
also pass, with the same remote `5cc4e96e…` artifact; Windows/aggregate remain
failed at this historical source. Independently downloaded tar bytes and three
successful receipts bind to clean source `eb21b86c`; no four-leg or full-CI pass
is inferred. The local `df7935b2…` candidate is separately attributed.

The same run exposes four stale secrets-workload declarations after Step 2's
historical-reader regressions: the gate file contains 65, not 61 cases; each of
three serializer controls contains 25, not 24. A separate source-fenced actual
collection audits all **41 secrets declarations / 23 files / 1,041 cases** and
all **110 filesystem declarations / 38 files / 658 cases**. Only those four
counts differ. Their exact counts are corrected without weakening whole-file
equality, runtime receipts, semantic markers, restoration or source provenance.
The four selected fixed/removal/restored cohorts retain **65/25/25/25** cases per
phase, with **3/2/3/2** expected semantic removal failures and byte-identical
restoration. Selected runs remain incomplete-family evidence.

The first author tooling run exposes a separate test-isolation assumption:
coordinator tests compare all matching names in the shared OS temp root while
four real selected controls create/remove their own roots concurrently. Each
coordinator fixture now supplies and scans its own TMPDIR/TMP/TEMP directory;
the scratch-leak assertion remains exact. No other invocation's temp state is
treated as this fixture's cleanup failure. The corrected **482 acceptance-tool
tests** pass with zero skips. Initial author lint catches a moved summary binding
and an unsafe-finally form; fixed lexical bindings and explicit primary capture
pass lint without rule suppression. The earlier consumer attempt with that binding
error remains failed evidence; its corrected local retry passes all 175/six cases.

Affected security and two NEW complete cumulative clean rounds after these
material corrections, plus actual required same-artifact platform success, remain
open. No new ADR, dependency, deferral, credential or provider action is introduced.

## Wave 3 Step 7b and whole Step 7 acceptance — 2026-10-16

**Accepted on `development` at `c836ffe616803697285f51204c78b76ce3a99814`.**
The parent reads both NEW complete cumulative clean reports after the final
native-worker, workload and coordinator-isolation corrections. R4 uses
gpt-6-astra/high; R5 uses gpt-6.1-sol/xhigh. Each independently covers all
**107 paths / 211 zero-context hunks / 62 full added files** from the accepted
Step 6 boundary `b09008e7`, including all Step 7a work and every correction.
Each freshly passes **160 tooling tests, eight runtime files / 106 tests,
six actual coordinator tests and 175 untouched compiled bootstrap controls**,
with zero skips. Closure remains **24 JS / 375 inputs / 17 external dependencies**;
the hidden-own-dist resolution probe has zero unresolved self imports.
Finding-bearing R1–R3 and interrupted attempts are not counted clean.

The separate NEW completed-consumer security sitting is clean at the same source:
**61 tooling tests and nine independent copied-launcher negative probes**.
The parent reads the whole report. Exact child closure precedes installation
removal, and required removal precedes public success. This gate is distinct
from both complete correctness rounds and from Step 8 product fatal ownership.

### Author, artifact and actual required platform evidence

The final author **482 acceptance-tool tests** pass with zero skips; tools
lint/typecheck/format/fences pass. Ordinary workspace checks retain the valid
**647 files / 14,660 passes / 20 established skips** cache attribution and the
separate earlier fresh clone's **647 / 14,659 / 21 established CI-projection
skips**. Neither is relabeled as a new fresh final-source full suite. Fresh
reviewer checks above independently exercise the affected current source.
Earlier build, selected causal and failed attempts keep their original scopes.

GitHub push run **38869520079 / attempt 1** is the exact reviewed source.
Actual successful jobs are pack **116870449731**, current Linux **116870634562**,
current macOS **116870634638**, current Windows **116870634595**, exact minimum
Linux **116870634584**, and required packed aggregate **116871821131**.
All four consumers bind the same original tarball:
`9926f8eab1686f3e541052f1af22b832658166126c7a6ac72b908e2f7f18c228`.
Current legs run **v24.21.0**; the minimum leg runs **v22.0.0**. Both complete
reviewers independently inspect actual bytes and strict receipts against actual
API job/source/origin identity; R5 downloads its own copies. The parent also
independently inspects original bytes and all four receipts. Each leg passes
175 bootstrap controls and six installed cases. Historical Windows failures
remain failed evidence, not accepted runs.

The separately produced local candidate is
`d707f89adbb71490a5c03b59cc095bce1ff6dda7b265df9c83d4ab965c09d7ed`,
**69 public files / 24 JS / 17 dependencies**, at the same source. Its completed
175/six consumer, joined worker and absent installation are independently checked;
its explicit local `dirty: true`/isolated-Git-HOME qualification is retained.
It is never substituted for the clean GitHub artifact or a remote platform leg.

### Broader CI and physical evidence retain separate attribution

At this acceptance checkpoint, actual current wire, complete secrets, complete
usage, coverage and advisory platform jobs are successful; filesystem controls
and the overall CI run remain **in progress**. Required Step 7 package/platform
gates above are complete. No whole-CI or successor-metadata execution is inferred.
The current CI run is allowed to finish without a superseding push; any later
failure remains actionable. Whole-wave source/coverage/platform gates repeat in
Step 19 after later implementation.

A separate read-only physical audit downloads current wire, secrets and usage
artifacts from that run and validates exact source, counts, semantic witnesses,
restoration and retained bounds: wire **four mechanisms / 24 cases**;
secrets **41 controls / 123 phases**, including the repaired **65/25/25/25**
cohorts and all 123 zero-unhandled completed runtime receipts; usage **23 controls /
eight groups**, with **435 permanent cases / 71 native children / one ordered
readiness-timeout control**. Raw source/body/dependency journals are joined within
their respective export scope. This is inspection of remote execution, not new
local mutation execution; absent nested trees and reporter-boundary limits are
explicit. Filesystem's current physical artifact is not yet audited here.

Detailed review/audit records remain local and Git-ignored. No installed smoke
claims real provider/keychain API use, TLS certification or hostile same-user
containment. No new dependency, ADR, deferral, credential, billing or approval
gate is introduced. **Step 7b and whole Step 7 are closed; Steps 8–19 remain open.**

### Recorded Step 8 serial split before implementation

The four rows 8a → 8b → 8c → 8d above preserve all original Step 8 IDs and
approved contracts. Each receives an implementation commit and two NEW complete
cumulative clean rounds after its last material correction; native/process
security sittings remain separate. 8a supplies provenance and an inert native
foundation. Product fatal activation waits until 8d connects every actual
creation owner and caught/forced-exit path. The fixed migration adapter may decode
one verified public Drizzle wrapper at its actual owned operation, never arbitrary
provider/plugin causes or a recursive private cause tree; checkpoint origin is
retained before native evidence is erased. No driver fork or migrator replacement
is planned. Whole Step 8 stays open until 8d's complete cumulative acceptance.
The central opener refactor remains Step 18, and whole-wave publication Step 19.

### Step 7 completed full-CI follow-up — 2026-10-16

After the acceptance checkpoint above, GitHub run **38869520079 / attempt 1**
completed successfully at the exact accepted source
**`c836ffe616803697285f51204c78b76ce3a99814`**. The completed CI workspace suite
reports **647 files / 14,659 passes / 21 established CI-projection skips**.
This appends the later result to the earlier in-progress observation; it does
not rewrite that historical checkpoint or claim execution of successor
metadata `d9625ff0` or the Step 8a working tree. Earlier physical artifact
audits retain their recorded scopes. Whole-wave gates repeat in Step 19.

A separate completed filesystem physical audit verifies **110 controls / 330 phases**
from that run: all completed zero-unhandled receipts, exact immutable-source pins,
named semantic failures and byte-identical restoration. The retained tree contains
**1,987 files / 39,697,863 bytes**; the fourteen native controls retain their
42 phase identities and child/dependency witnesses. The **8,148 repeated phase
cases / 361 semantic failures** are execution totals, not unique permanent cases.
The parent reads the complete separate audit. No local re-execution or
merge-/metadata-head execution is inferred.

## Wave 3 Step 8a implementation checkpoint — 2026-10-16

Step 8a implements the approved minimal storage-origin and runtime projection
subset above accepted Step 7 metadata `d9625ff0`. The DB root exposes only the
read-only storage-failure query; private factory/native association, native
storage allowlisting and fixed one-wrapper Drizzle handling preserve existing
error, migration, checkpoint and media contracts. CLI owned filesystem and
open/maintenance/export adapters distinguish storage 1, known refusals 2,
unknown infrastructure 9 and failed output 9 without a blanket internal-code
rewrite. Core exports its frozen existing transient-code authority.

The native registry observer, fixed early diagnostic formatter, successor
keepalive observer and native stream/deadline adapter form an **inert product
foundation**. Explicit native fixtures exercise registered owners, both real
streams, restoration-before-diagnostic ordering and the common absolute
budget. Production activation waits for Step 8d's actual owners and all
caught/forced-exit paths; this checkpoint does not claim those are connected.

Author gates, isolated causal controls, physical custody audits and independent
review reports retain their individual source and execution attribution in
the accompanying evidence record. **Step 8a is not accepted by this
implementation checkpoint. Whole Step 8 and Steps 8b–19 remain open.** No new
ADR, runtime dependency, credential, billing or provider capture is required.

### Step 8a author and selected-control evidence

The implementation is based on `d9625ff0`; these local checks execute its
uncommitted Step 8a body, not pristine metadata or a published commit. Ordinary
workspace checks pass **657 files / 14,791 tests / 20 established local skips**.
The last complete workspace invocation reruns CLI and reuses ten valid test
tasks; earlier affected DB/core invocations remain separately attributed.
Two subsequent parameterized-title changes keep all 66 affected cases and their
assertions, and the full two-file workload passes. Build/format, tools
lint/typecheck, schema sync, seam/engine fences and **482 acceptance-tool tests**
pass. Compiled CLI, media-packaging, overflow and budget-replay smokes pass;
negative replay controls retain their expected fixed failure diagnostics.

A fresh local prepack and outside-workspace consumer pass **175 bootstrap controls
and six installed cases** on macOS/Node **22.23.1**. The candidate is
`ff18f5f5812b28e313cfc2d5ea1beac3f1e5685722fe63bc34df1ba80fc549f8`,
**422,086 bytes / 70 public files / 25 JS chunks / 17 dependencies**, with
explicit local `dirty: true` and parent metadata `d9625ff0`. Actual consumer
publication follows joined work and required installation removal. This is
local-host evidence; it is not a clean remote artifact or four new platform legs.

Five DB-origin controls and six CLI/native controls independently remove one
mechanism in copied source, then restore the exact original bytes. Their
**33 completed zero-unhandled runner receipts / 750 repeated phase cases /
41 semantic failures with declared named witnesses** are independently audited with complete inventories,
source/target/test body pins, runtime/stdio/dependency receipts and restoration.
The retained local artifacts contain **222 files / 14,149,147 bytes** and
**255 / 16,239,468 bytes**, with their raw graphs and caches removed. The two
DB-backed CLI controls additionally require an actual native-addon receipt in
a target worker; four pure controls expressly decline that claim. Controlled
filesystem/pragma failures are fault injection, not measured OS failures.
The local coordinators retain `complete: false` / `acceptance: false`: they are
selected raw causal evidence, not a new finite-family archive or whole-wave
certificate. The first two CLI runs refused duplicate parameterized case names;
those refusals remain failed evidence. Permanent names were made unique before
the final full six-control run, with no reduced count or weakened guard.

The adapted CAS-shard anchor and three updated secrets workloads also pass their
canonical fixed/removal/restored checks: **21 / 77 / 77 / 67 cases** respectively.
These selected checks do not claim new complete filesystem/secrets-family
execution. All copied removals leave the developer source unchanged. Existing
actual-native fixtures test autonomous cleanup, a common deadline through the
final write ACK, competing late stream failure, both broken pipes and terminal
restoration ordering without safe-DB-close or universal containment claims.

The implementation commits carry this candidate. Two NEW complete cumulative
clean reviews after the last material correction and a separate security sitting remain required.
Whole Step 8 and Steps 8b–19 remain open; no user decision is pending.

## Wave 3 Step 8a acceptance — 2026-10-16

**Independently accepted on `development` at
`e0a5ae19981e749a75455e6b5698c806d9f1c674`.** The parent reads both NEW
complete cumulative clean reports, R1 (gpt-6-astra/xhigh) and R2
(gpt-6.1-sol/xhigh). Each reviews every **61 paths / 177 zero-context hunks /
17 complete added files** from `d9625ff0`, then independently passes all
**24 changed test files / 481 tests / zero skips**. No material correction is
requested, and no source or dist mutation occurs between those rounds.

The separate security sitting is also clean at that exact source: **26 complete
files / 525 passing tests / zero skips**, plus five independently authored
probes. It verifies fixed projection/privacy, private origin identity and factory
association, inert imports, actual native fixture observations and emitted
DB/core-source equality. These overlapping reviewer cohorts are separate
executions, not added together as unique test coverage. The parent reads its
full report; this sitting does not substitute for either correctness round.

Both correctness reviewers inspect the actual retained local causal coordinators,
source/test bodies, exact removals/restorations, stdio, complete inventories,
runtime/dependency and zero-unhandled receipts. R2 additionally reconciles all
21,013 installed dependency file digests. The **11 controls / 33 phases /
750 repeated cases / 41 semantic failed cases with declared named witnesses**
keep their original uncommitted-body attribution and `complete: false` /
`acceptance: false` local labels. The DB capture predates six unrelated CLI
assertion-marker changes; all production and selected DB targets/tests match.
All 1,256 CLI capture pins match current. No new family certificate or fresh
reviewer mutation execution is inferred.

### Actual current-source package and CI attribution

A separate read-only audit and R2 independently inspect actual downloaded
GitHub bytes and strict receipts against freshly queried job/source identities.
Push run **38880157607 / attempt 1** executes the reviewed `e0a5ae19` source.
Actual successful jobs are pack **116904676623**, current Linux **116904849909**,
current macOS **116904849827**, current Windows **116904849911**, minimum Linux
**116904849776**, and required aggregate **116906278121**. All four consumers
bind **`7d02747c6f8c52b0b12ef44dab990e1658fa652b83600280a928aad22897e18e`**:
**421,903 bytes / 70 public files / 25 JS / 17 dependencies**. Each passes
175 bootstrap controls and six installed cases. Current runtimes are **24.21.0**;
minimum Linux is exactly **22.0.0**. Forty-four canonical migration/public asset
files match frozen source byte for byte. Public receipts do not export their
private worker/cleanup logs, installation trees or native dependency bodies;
those absent physical details are not reconstructed or independently attested.
The separately qualified local dirty candidate is not substituted for this tarball.

At this checkpoint, current wire, complete secrets, complete usage, enforced
LLM/MCP coverage, advisory Windows and Node-floor jobs also report success.
Filesystem controls remain in progress; the dependent main CI job and overall
run have not yet completed. This is independent Step 8a acceptance, **not a
whole-CI claim**. The existing run is allowed to finish; any failure remains
actively actionable. Earlier full-CI evidence belongs to `c836ffe6`, and no
execution of this successor acceptance-metadata commit is inferred. Whole-wave
gates repeat at the final implementation in Step 19.

Step 8a's origin adapters and inert native foundation are closed. **Whole Step 8
remains open**, with actual creation owners in 8b, workflow health in 8c, and
session/terminal/caught/forced-exit activation in 8d. Later 8b–8d reviews remain
complete and cumulative from `d9625ff0`; accepting this foundation does not
narrow those reviews. Step 18 still owns central DB-opener consolidation and
Step 19 publication. Detailed reports/artifacts stay local and Git-ignored.
No new ADR, dependency, deferral, credential, billing, provider or user-decision
gate is introduced. Step 8b proceeds automatically.

### Step 8a completed full CI follow-up — 2026-10-16

The previously pending push run **38880157607 / attempt 1** subsequently
reports **success** for the exact reviewed source
`e0a5ae19981e749a75455e6b5698c806d9f1c674`. The parent queries the completed
job identities and reads main job **116919762337**: lint/typecheck, build,
format, isolation and CLI/media/overflow/budget-replay smoke gates pass.
The serialized workspace execution records **657 files / 14,790 passing tests /
21 established CI skips**: eleven dialect capability cases, nine filesystem
platform cases and one CI-only Ink projection case. These are remote execution
totals, separate from the earlier local 14,791 / twenty-skip observation.

Filesystem, secrets, usage, wire, enforced LLM/MCP coverage and all required
same-tarball consumers/aggregate also report success. The earlier physical
package audit retains its exact six-case scope and artifact identity; a
successful job status does not imply a new independent download/audit of its
private causal artifacts. No execution of acceptance metadata `a5742dd9`, the
subsequent Step 8b working tree or its added seventh installed case is inferred.
The historical in-progress checkpoint above remains unchanged. Step 8b is in
implementation; whole Step 8 and later whole-wave gates remain open.

## Wave 3 Step 8b implementation checkpoint — 2026-10-16

Step 8b implements actual native creation ownership above accepted Step 8a
metadata `a5742dd9`. Every product creation receives the original invocation's
native controller before asynchronous initialization: workflow and gate/budget
resume, one-shot live/offline agents, fresh/resumed chat, pending/replaced Home
hosts, OS helpers and both default editor bindings. Native attachment is reserved
before entry; a public error or successful cancellation request does not retire
the target. The [CLI contract](../../reference/cli/commands.md#native-crash-teardown-scope)
owns platform and helper semantics. The [MCP contract](../../reference/shared-core/mcp-integration.md#creation-owned-native-stdio-lifetime)
separates actual native closure from full SDK/work completion. A separately
reproduced standalone clear/reseat omission now carries the existing consent
gate alongside the same native authority, without bypassing approval.

Registry entries carry live budget notifications and finite exit hooks, with
one removable creation-owned exit callback and no completed PID history or
independent process-wide reaper set. Windows admission verifies its absolute
installation facility before native entry; target and already-entered helper
remain separate obligations. Existing cooperative signal/grace behaviour is
preserved. Product fatal activation and workflow/session/terminal health remain
8c–8d; native closure alone does not acknowledge storage or receipts.

### Step 8b author evidence and remaining gates

The local uncommitted candidate passes serialized workspace checks:
**664 files / 14,943 passing tests / 21 declared local/platform skips**. CLI and MCP
execute freshly; nine other test tasks reuse valid cache entries. Build/format,
tools lint/typecheck, schema sync, seam/engine fences, isolation and the finite
**26-JS / 380-input / 17-dependency** closure pass. The complete acceptance-tool
command passes **496 tests** after the fixture corrections below. Its earlier execution correctly refused source
custody after a concurrent author script edit; that failed run remains failed
evidence and is followed by the successful frozen-source rerun. Compiled CLI,
media-packaging, bootstrap, overflow-capture and budget-replay smokes also pass.

The seventh required installed case exercises actual creation-owned native
cleanup through the public offline agent route. Two early local executions
remain failed evidence: a copied Homebrew Node lacked its adjacent ABI dylib,
then two same-directory copies tried to overwrite that read-only support file.
The corrected fixture verifies and reuses the exact ordinary support bytes;
its permanent actual regression runs both copies and verifies the descendant's
own PID/parent readiness. Separate sentinel, altered-byte, symlink, callback and
delayed-close controls pass. No product mechanism changes for these fixture fixes.

A fresh local tarball and corrected outside-workspace consumer pass **175
bootstrap controls and all seven installed cases** on macOS/Node **22.23.1**:
**`39f47a9e006d924c551867522fd65d445074e6cf9f9bf92974f8afe241a5547f`**,
**425,640 bytes / 71 public files / 26 JS / 17 dependencies**. The parent
independently inspects exact archive file bytes/modes, source/runtime bindings,
all three actual native subcases and joined worker/installation removal.
Synthetic native error, finite creation-exit callback and natural POSIX leader
exit each retain real close obligations, leave their unrelated owned sibling
alive and complete without external-watchdog cleanup. This candidate explicitly
records `dirty: true` at parent metadata `a5742dd9`; it is local-host evidence,
not execution of a pristine successor commit or four new platform legs.
Earlier Step 8a six-case platform evidence is not substituted. Windows
simulation is not actual Windows execution; current platform receipts must
bind the same new tarball.

Two isolated causal preparations cover 23 native mechanisms and 23 forwarding
sites; they are still unexecuted and unpinned at this checkpoint. Full source,
runtime, complete-cohort and physical dependency custody must be fixed before
execution. Any resulting local selected evidence remains distinct from a
whole-wave or family certificate. Two NEW complete cumulative clean reviews
from `d9625ff0` and a separate native/process security sitting remain required.
**Step 8b is not accepted. Whole Step 8 and Steps 8c–19 remain open.** No new
ADR, dependency, credential, billing, provider or user-decision gate is introduced.


## Wave 3 Step 8b first review and CI corrections — 2026-10-16

The complete cumulative review of `d9625ff0` → `e6e91039` covers **112 paths /
456 hunks / 33 whole added files** and is **NONCLEAN**. Independent ordinary
execution passes **1,076 tests / 45 files**, with one actual-Windows-only local
skip. The separate security sitting is also NONCLEAN and independently reproduces
the same helper-cancellation reentry. Neither sitting counts towards the two new
clean rounds required after the final material correction.

Node's actual `ChildProcess.kill` error protocol reproduces 1,296 nested helper
kill requests from one native refusal, using an inert simulated native handle
and no PID operation. The correction guards synchronous cancellation reentry,
allows later independent finite requests and still owes both actual native closes.
Two permanent semantic cases cover helper error and finite exit. The independent
real-Node-protocol correction probe observes one request; it is local simulation,
not actual Windows execution or a new native-close acknowledgement.

Required CI run **38893418852**, exact source `e6e91039`, fails secrets, usage and
the current-Windows installed consumer. Linux/macOS/current and Linux/Node 22.0
installed legs pass but do not substitute for Windows or the four-leg aggregate.
Five secrets declarations are refreshed against complete ordinary inventories:
run **79**, gate **68**, chat **127**, preserving every witness and strict guard.
The usage permanent cohort contains **440**, rather than 435, cases; all 23
mechanisms and 71 native fixture lifetimes in the original failed capture retain
their exact partial scope. A generated temporary editor script was correctly
refused by the inherited physical source fence. Both editor tests now use one
tracked ESM fixture with explicit readiness/release and watchdog-failure evidence;
no source-fence, NODE_OPTIONS or acceptance timeout is weakened.

The original Windows worker exits 1 with empty stderr before the launcher can
read its private report; the failing case/mode is therefore still unknown. A
failure-only, bounded synthetic-test diagnostic now projects canonical identities,
failed cases and native cleanup facts to stderr after existing cleanup. It grants
no success or receipt and preserves actual worker join and installation removal.
The advisory Windows filesystem test separately exceeds its unchanged five-second
bound; no product defect or timeout-relaxation justification is inferred.

The original native capture completes **23 controls / 69 phases / 1,380 repeated
cases** and is independently physically audited. Original forwarding capture
remains **failed overall**, after seven completed controls: three existing budget
cases declare 20 seconds and correctly refuse the causal guard's 15-second ceiling.
The corrected private declaration uses the complete 68-case gate file to prove
its shared physical human/budget forwarding site; all 38 ordinary budget cases,
including their existing bounds, remain mandatory. No successful replacement
capture is claimed. Final correction source requires all **24 native controls**
(including cancellation reentry), all **23 forwarding controls**, fresh author
checks, actual platform checks, two NEW complete cumulative clean reviews and a
NEW clean separate security sitting. **Step 8b and whole Step 8 remain open.**
No ADR approval, user decision, provider, keychain, billing or credential is pending.


### Step 8b first-correction author gates — 2026-10-16

The corrected uncommitted body above parent `e6e91039` passes serialized workspace
checks: **664 files / 14,945 passing tests / 21 declared local/platform skips**;
CLI's **287 files / 5,016 passes / ten skips** run freshly, while ten other test
tasks reuse valid caches. All 17 lint/typecheck tasks, seven build/format tasks,
**505 acceptance-tool tests**, tools lint/typecheck, schema sync, isolation,
seam/dependency/finite-bundle guards and compiled CLI/media/overflow/replay smokes
pass. Fresh complete native/forwarding ordinary selection passes **15 files /
572 tests / zero skips**, including all 38 budget cases with unchanged bounds.
The editor fixture's first lint attempt correctly refuses implicit Node globals;
explicit built-in imports fix it without weakening lint. Original failed runs and
NONCLEAN reviews retain their scope. No new causal, actual-Windows or independent
correction-review acceptance is inferred from these author gates.

### Step 8b adverse-fixture and case-identity correction — 2026-10-16

The complete cumulative review and separate security sitting at **`76fb1397`**
remain NONCLEAN. They independently verify the original helper correction, five
secrets inventory corrections and physical **24-control / 72-phase / 1,557-case**
native capture, including **74 semantic failures / 72 zero-unhandled receipts**.
The parent independently audits the same exact source/runtime/dependency bodies,
restoration and graph removal: **1,173 retained files / 31,502,006 bytes**. This
selected local evidence does not certify platform or whole-wave acceptance.

The new Windows diagnostic isolates two passing actual-native modes and one
failed adverse control: `facility-refusal` exits **134** before any native witness.
The fixture changes launching SystemRoot before Node starts and therefore does
not isolate the product verifier; the deeper abort cause is unproven. The correction
preserves the launching environment and targets the exact taskkill access boundary
with an explicitly labelled synthetic native fault after bootstrap. The production
verifier and pre-entry refusal stay intact. Actual Windows success remains required.

Forwarding capture **`otgxYP` remains failed overall** after nine completed
controls. Its rejected chat fixed phase passes all **127** cases but two identities
embed transformed function source. Stable `plain`/`json` labels now preserve those
same two assertions and bounds; exact case-inventory guards are unchanged. Fresh
final-source ordinary inventories, all 24 native controls and all 23 forwarding
controls remain required.
CI **38900819422** at `76fb1397` passes the complete secrets family, unchanged
Windows advisory test, wire, coverage and the three other installed legs; the
required Windows consumer and aggregate remain failed. Broader running jobs retain
their eventual separately attributed result. Neither NONCLEAN sitting counts as a
new clean round; final corrections require two NEW complete cumulative clean
reviews and a NEW clean security sitting. No user decision or new ADR is pending.

The subsequent adverse-fixture correction has fresh author verification: the full
package-tools cohort passes **82/82**, the full acceptance-tool suite **507/507**,
and the complete ordinary fifteen-file causal inventory **572/572**, with no
skips or function-source case names. Workspace lint/typecheck passes **17/17**;
all **11** test tasks pass (ten valid cache hits), including a fresh CLI run of
**287 files / 5,016 passes / 10 established skips**. The seven-task build/format,
tools lint/typecheck and source-fence checks retain their separately recorded
results. These are author checks before the new source freeze; actual-platform,
causal and independent final-correction acceptance are not inferred.

### Step 8b canonical exit-classification correction — 2026-10-16

The new complete cumulative correctness round 1 and separate security sitting at
**`ab50be11`** are clean, but new cumulative round 2 is **NONCLEAN**: the
[provider-header reference](../../reference/shared-core/database-schema.md#interim-provider-header-policy)
and [Home reference](../../reference/cli/home.md#the-tty-gate-when-the-home-opens)
still describe unexpected failures as exit 1. The parent verifies both against
actual classification and the permanent provider-header/Home regressions, then
corrects the references to the already-approved CLI contract. Known operational 1,
invalid invocation 2 and staged caught/fatal integration remain distinct. No
runtime, test, tool, dependency or decision changes in this correction.

All three sittings cover **120 paths / 485 hunks / 36 complete added files** from
the unchanged whole-Step-7 base `d9625ff0`; each independently executes all
**48 changed test files / 1,100 passes / one actual-Windows-only local skip** and
inspects both complete retained raw captures. The parent reads the full reports
and ledgers before accepting their dispositions. The earlier clean sittings do
not accept this subsequent documentation correction; two NEW complete cumulative
clean rounds remain required.

Executed native/control and platform evidence remains attributed to `ab50be11`:
**24 native controls / 72 phases / 1,557 repeated cases / 74 semantic failures**,
**23 forwarding controls / 69 phases / 4,383 repeated cases / 39 semantic failures**,
and **141 zero-unhandled completed receipts**. The parent and all three reviewers
independently inspect actual source/dependency/runtime pins, exact restoration,
strict full inventories, bounded retention and removed graphs. Native retains
**1,173 files / 31,501,966 bytes**; forwarding **972 / 56,727,016**, with 207 MCP
fixture pin checks and no fabricated per-phase fixture-body custody.

CI **38904219484** executes the same **425,556-byte** tarball
`cc269b86836876e4cb931bf62ad5dddf79591263d12c2ca1863ec7a2af58c0c6` on current
Windows/macOS/Linux and exact Node 22.0.0 Linux; all four consumers and the required
aggregate pass **175 bootstrap controls / seven installed cases** each. The parent
and reviewers independently bind all five downloaded ZIPs to API digests and
inspect all 71 public tar members and strict reports. Public success receipts do
not export remote private per-mode journals. Broader CI completion retains its
separate actual status; no overall-CI-green or documentation-head execution is
inferred. Runtime byte equivalence must be independently checked before reusing
this attributed evidence. Step 8b acceptance, 8c–8d, whole Step 8 and later Wave 3
work remain open; no new ADR or user decision is needed.


## Wave 3 Step 8b acceptance — 2026-10-16

**Step 8b is independently accepted on `development` at reviewed source
`e16a7659d5855dcd0cb75e659573cc218152e139`.** After the canonical-reference
correction, two NEW complete cumulative correctness rounds and a NEW separate
security sitting are clean. Every sitting covers the unchanged whole-Step-7 base
`d9625ff0a641197c6ed45968df99094a25db88d6` through that source: **121 paths /
488 zero-context hunks / 36 whole added files**. Each independently executes all
**48 changed test files / 1,100 passes / one actual-Windows-only local skip**.
The parent reads every full report and per-file assessment and independently
verifies the immutable file, diff, Git and retained-artifact pins. Final round 2's
488 individual hunk bodies also match. Detailed reports remain local and
Git-ignored; their final report SHA-256 values are recorded below.

| Sitting | Model / effort | Report SHA-256 |
|---------|----------------|---------------|
| New cumulative correctness round 1 | GPT-6 Astra / xhigh | `a54e5a2d5afef0c6b73627407f6afd78cd3d2eba3143cff04a077cc6f9edd4e2` |
| New cumulative correctness round 2 | GPT-6.1 Sol / xhigh | `5072e3563d694d9a9580e972d3e60ef24c2f6ab94a049fd500cd0ff6e53c8180` |
| New separate security sitting | GPT-6.1 Sol / xhigh | `ea42171a24f7015818b147f248ccc421f6b6213506acf4054c808ba508817aee` |

Independent additional probes pass: round 1's 16 lifecycle and 21 negative
package-binding probes, round 2's four lifecycle/projection probes, and the
security sitting's six corrected boundary probes. These counts are attributed
separately, not presented as unique product-suite cases. The security probe's
initial source/dist identity setup failure remains recorded; explicit shared
source aliases correct that probe, without a product change or suppressed failure.
The dangling editorial word in the database reference is removed in this acceptance
metadata; this does not alter its already-reviewed classification contract.

The parent and all three reviewers inspect the complete native and forwarding
raw captures and all five downloaded package/report archives described in the
[preceding evidence checkpoint](#step-8b-canonical-exit-classification-correction--2026-10-16).
Their execution remains **`ab50be11`**, never relabelled as a run of the
documentation-only `e16a7659`: all **1,270 source/tool entries**, **21,013 physical
dependency files / 457 packages**, and Node/Vitest runtime identities are
independently equivalent. Both complete captures retain 141 zero-unhandled phase
receipts, exact restoration and their bounded inventories. Earlier failed runs
and NONCLEAN reviews remain historical evidence, not current acceptance.

Full push CI **38904219484 / attempt 1 / `ab50be11`** has now completed
successfully: **all 15 jobs pass**, including the full filesystem cohort and
required lint/typecheck/test/build/fences/smokes job. Actual current Windows,
macOS and Linux plus exact Node 22.0.0 Linux consume the same tarball, with all
four strict receipts and their aggregate passing. The parent and reviewers
independently inspect the physical archives and public receipt bindings; remote
private per-mode worker journals are not exported by those success receipts and
are not inferred. The actual-Windows adverse case injects a post-bootstrap native
access failure; it is not evidence of a real OS permission fault.

The [separate security sitting](../../standards/security-review.md#sitting-wave-3-creation-owned-native-processes-2026-10-16)
retains the distinctions between fixed diagnostic projection and unchanged legacy
human verbose stacks, native close and receipt ACK, and owned process types and
universal descendant containment. Global native activation is still inert.
**Whole Step 8 is open:** 8c must connect workflow, preparation and terminal
lifetimes; 8d must connect the remaining surfaces and all caught/fatal exits.
Steps 9–19 and whole-wave acceptance remain staged. No new ADR, provider capture,
credential, billing or user decision is needed. Step 8c proceeds automatically.

### Wave 3 Step 8c implementation checkpoint — 2026-10-16

**Author verification in progress; not independently accepted.** The approved
workflow/render increment connects `run`, human-gate resume and budget resume to
the original invocation's pre-registered workflow and terminal owners. The
[canonical CLI contract](../../reference/cli/commands.md#workflow-and-terminal-ownership)
owns exact cancellation, health precedence, native acquisition and cleanup
semantics. Product-wide fatal/background/sink activation and session lifetimes
remain 8d; no whole-Step-8 or whole-wave completion is implied.

The command subscription precedes secret stdin, consent, discovery and engine
construction. An identity-owned stop checkpoint refuses later service/business
entry, while an unrelated failure racing cancellation keeps its own classifier.
Late handles enter the same primary driver without new UI ownership. Actual
primary done and actual non-continue departure stay distinct; available receipt
health progresses even while a prompt holds input. Stronger actual health
survives render/finalize/maintenance errors and typed ownership-loss remedies are
preserved. Neither rejected iteration nor a cleanup timer authorizes DB close.

Terminal constructors pre-adopt actual native cleanup capabilities. Missing
handles after failed mount, rejected prompts and incomplete registrations retain
their obligation. A permanent seal blocks remount, redraw and job-control reclaim
before independent input/listener/cursor restoration. All deferred and post-await
restoration entries recheck the original remaining budget. Captured input/stdout
are passed to installed Ink/Clack; the selected CLI mode explicitly controls Ink's
interactive mode. JSON on a TTY remains native-free and contains no restoration
control bytes.

The first owned infrastructure fault now starts the same finite backstop before
cleanup can hold it from the root catch. Signal and later native finalization
share one observer/deadline/physical-exit latch. The staged infrastructure fallback
permits outer diagnosis after actual cleanup; it claims no diagnostic delivery
ACK. MCP callback-reported close failures retain the obligation even when its
manager's `close()` fulfills. An unknown database-close throw supplies no ACK.
Earlier Step 1 warning tests now distinguish preserved durable workflow events
from CLI lifetime success; this is the approved later process integration, not a
new deferral or decision.

Fresh focused execution includes actual engine/SQLite health regressions, native
Node processes around a real MCP manager with synthetic connection faults, and
installed Ink/Clack bound to handle-free owned TTY fixtures. The native cleanup
fixture joins actual process/pipe close, requires DB-close count zero while its
obligation is held and rejects external-watchdog cleanup. Its local POSIX leg
delivers real SIGTERM; the Windows source leg explicitly uses the registered
callback because Node does not deliver that POSIX signal there. No actual Windows
execution is inferred. No provider, keychain, editor or interactive operator
terminal is used.

A narrow read-only mechanics advisor found preparation, release, callback and
first-fault ordering gaps; verified fixes have permanent regressions. That advice
is **not** either complete cumulative review or the separate security sitting.
Both NEW complete cumulative clean rounds must still cover the entire Step 8
range from `d9625ff0a641197c6ed45968df99094a25db88d6`, after the final material fix.
Fresh author lint/typecheck and workspace tests pass: the CLI executes 298 files /
5,108 passing cases / 10 established skips; unchanged workspace results retain
their cache attribution. Build and format pass. The compiled CLI smoke also
passes, including actual MCP-child reaping and SIGINT during budget-resume
connection. Its first run exposed a genuine typed MCP-cancellation classification
regression; the fix and permanent regression distinguish owned cancellation from
a competing opaque failure. The independent ordinary causal inventory is eight
complete files / 125 passing cases, without skips. None of these author runs is
an independent review. Fresh causal, package/platform and independent review
gates remain open at this checkpoint. Historical 8b captures and platform
receipts retain their original source; none is relabelled as execution of these
changed runtime bytes. No new ADR, credential, billing, provider capture or user
decision is pending.

### Wave 3 Step 8c first cumulative review corrections — 2026-10-16

**Not accepted; new complete cumulative reviews required after the corrections.**
The first complete cumulative correctness and separate security audits cover
`d9625ff0a641197c6ed45968df99094a25db88d6` through `9e4cac77`: 164 paths /
770 zero-context hunks / 54 whole added files. Their NONCLEAN findings are
independently verified; neither audit is counted as clean implementation acceptance.

| Verified concern | Correction and evidence boundary |
|---|---|
| MCP asynchronous close at zero common budget | Recheck the live remaining budget immediately before first cooperative close. Keep finite owned PID cancellation and retain actual native-close uncertainty. Six separate Linux/Windows protocol cases cover attached, late-attach and liveness-reentrant expiry; simulated ports claim no actual Windows execution. |
| Autonomous native fault lacks workflow physical exit | Workflow creation explicitly activates the same fallback observer before owner/native entry. Activation alone starts no timer; ordinary termination cannot exit. An actual WorkflowLifetime with simulated Windows native handles pins autonomous helper failure, the original deadline, physical exit 9 exactly once and retained obligations until actual closure. Global/session activation remains 8d. |
| Callback removal reaches watchdog before its semantic witness | The native test observes actual premature command-settlement IPC alongside actual child close, validates readiness/stdio before the named assertion, then joins its owned fixture in finally. The watchdog cannot witness acceptance. Both run/gate callback removal controls require fresh complete-cohort execution. |
| Intentional gate unit fault uses real exit ports | Inject explicit fake physical-exit ports for the opaque opener-failure unit case. Actual child-process exit controls stay intact. Slower CI exposed the old fixture via one unhandled process.exit(9); the red coverage/Node-floor jobs remain attributed to `9e4cac77`. |
| Canonical MCP reference calls accepted 8b pending | Promote the stale current-status qualifier to accepted 8b; no security contract or 8c/8d acceptance changes. |

The rejected first causal capture retains eight completed mechanisms and the
failed ninth removal: the coordinator correctly refuses a missing semantic
marker, restores bytes and removes the copied graph. Overall acceptance remains
false. It is not relabelled as final corrected-source evidence. The first
clean-source freeze and its local records remain immutable.

Focused correction execution passes 129 cases across five complete files. Fresh
workspace checks pass, including the CLI's 298 files / 5,116 passing cases /
10 established skips; unchanged workspaces retain cache attribution. Final
compiled/package/platform, corrected causal and NEW independent review gates
remain open. The first source's four same-tarball platform consumers pass and
all 71 members are independently verified, but its overall CI is red and none of
that execution is transferred to these changed runtime bytes.

These corrections implement the approved deadline/ownership contract without a
new decision, dependency or deferral. Source and evidence scopes remain explicit;
whole Step 8, 8d and Steps 9–19 are still open. No user action is pending.

## Wave 3 Step 8c acceptance — 2026-10-16

**Step 8c is independently accepted on `development` at reviewed source
`dbab25d85a2c4ae97c252cdaaf47921648e245af`.** Following the verified first-round
corrections, two NEW complete cumulative correctness rounds and a NEW separate
security sitting are clean. Each covers the mandatory whole-Step-7 base
`d9625ff0a641197c6ed45968df99094a25db88d6` through that source: **164 paths /
770 zero-context hunks / 54 whole added files**. Detailed reports remain local
and Git-ignored; their final report digests are recorded below.

| Sitting | Model / effort | Fresh execution | Report SHA-256 |
|---|---|---|---|
| New cumulative correctness round 1 | GPT-6 Astra / xhigh | 65 files / 1,396 passes / one actual-Windows-only local skip; 50 tooling tests and four independent inert probes | `e786051ba38f3cf840ae15a73111d3b4ed25a03203835184ce834f692fcfc8f7` |
| New cumulative correctness round 2 | GPT-6.1 Sol / xhigh | 65 files / 1,396 passes / one actual-Windows-only local skip; 50 tooling tests and four independent inert probes | `0f272955baf1b2a1176a7160f75436710548ce34cf38e472393d6c7c55d9716e` |
| New separate security sitting | GPT-6.1 Sol / xhigh | 26 files / 380 passes / one actual-Windows-only local skip; 22 tooling tests | `f9776b8f4499877d085400069bedfa7c82adcc153cb643f2c1fed61e15ade2e7` |

The parent reads all three complete reports and every substantive path assessment,
then independently verifies every current file pin and all 770 individual hunk
bodies and hashes. Round 2's final 147-file report inventory and seal also match.
Its draft assessment inaccuracies are corrected after source reinspection; the
parent reads all 39 corrected assessments. This report correction changes no
product bytes, test execution or finding disposition. Independent test totals
above are separate executions, not a deduplicated product-suite total.

Fresh author lint/typecheck and workspace tests pass, with the CLI executing
298 files / 5,116 passing cases / 10 established skips; unchanged workspace
results retain cache attribution. Build, formatting and the compiled CLI smoke
pass. The final complete ordinary ownership cohort passes 10 files / 171 cases
without skips. The last assertion-label correction is included in that cohort
and both fresh correctness-review cohorts; no new full local coverage execution
is inferred.

The corrected-source selected causal capture is complete: **13 mechanisms /
39 fixed-removal-restored phases / 597 repeated executions / 21 named semantic
witnesses / 22 actual removal assertion failures**. Every completed phase has a
zero-unhandled runner receipt, the exact full inventory and byte-identical
restoration. The freeze digest is
`f0e60563dbe4ae4df95ff2a9a83a843b9f8be7895ba4e3b3ea99a3ca919178a4`.
The parent and all three reviewers independently inspect the actual raw receipts,
1,288 source/tool pins, 21,013 dependency files / 457 packages, runtime identities
and retained graph bodies. The bounded retained inventory is **825 files /
43,528,270 bytes**; copied graphs and caches are removed. Six run/gate callback
phases have actual target-process SQLite-addon load receipts. The selected capture
does not claim whole-wave acceptance or fresh reviewer mutation execution.

The rejected first capture, its failed ninth removal and its immutable source
freeze remain historical, with acceptance false. Earlier NONCLEAN reviews are
not reused as clean sittings. Their first-source CI has two real failed jobs and
was subsequently cancelled by the corrected-source push; its four successful
package consumers do not become execution evidence for the changed runtime.

Full push CI **38936742126 / attempt 1 / `dbab25d8`** completes successfully:
all **15 jobs** pass, including required lint/typecheck/test/build/fences/smokes,
coverage, filesystem, secrets, wire and usage controls. Current Windows, macOS
and Linux and exact Node 22.0.0 Linux consume the same **429,116-byte** tarball,
SHA-256 `529942465b79c6d147c4f45ea5b22dea1efe14770f12715f2487ff0b69e34c54`.
All four consumers and their required aggregate pass **175 bootstrap controls /
seven installed cases** each. The current-runtime consumers use Node 24.21.0.
The parent and reviewers independently inspect all five physical package/report
ZIPs, all 71 public tar members and matching installed inventories, all 26
reachable JavaScript outputs and seventeen declared external dependencies.
No SonarCloud result, merge-commit execution or remote private worker journal is
inferred from this push run or its public success receipts.

The [separate security sitting](../../standards/security-review.md#sitting-wave-3-workflow-and-terminal-ownership-2026-10-16)
retains exact evidence limits: local simulated Windows protocol controls do not
claim actual OS execution, actual platform packaging does not prove 8d global
activation, and the workflow-cleanup fixture uses a real SQLite/MCP manager with
synthetic connections rather than an actual MCP subprocess. The installed native
case exercises creation-owned offline agent tooling, not the new autonomous
WorkflowLifetime fault on actual Windows. Actual native close and persistence
ACK remain distinct. Fixed diagnostics do not certify unchanged legacy verbose
stack confidentiality.

The [workflow ownership contract](../../reference/cli/commands.md#workflow-and-terminal-ownership)
is accepted for 8c. **Whole Step 8 remains open:** Step 8d connects all remaining
session/preparation/terminal lifetimes and caught/fatal/background/sink paths,
then supplies its own cumulative and actual-platform acceptance. Steps 9–19 and
whole-wave publication remain staged. No new ADR, deferral, provider capture,
credential, billing or user decision is needed. Step 8d proceeds automatically.

## Wave 3 Step 8d session substrate checkpoint — 2026-10-16

**Implementation checkpoint on `development`, not Step 8d acceptance.**
The session work/surface/host owners and a per-acquisition terminal owner are
implemented. Standalone one-shot `agent run` connects its input, consent,
construction, actual producer/accounting/MCP cleanup, warning delivery and shared
database lifetime. The [canonical CLI contract](../../reference/cli/commands.md#session-ownership-implementation-checkpoint)
describes this partial scope. The SDK-free optional failed-start MCP lifecycle
reports close uncertainty before waiting on siblings and preserves their actual
raw lifetimes; its [canonical home](../../reference/shared-core/mcp-integration.md#failed-start-cleanup-lifecycle)
records compatibility and the common budget.

Scoped read-only implementation advice found terminal-write observation behind
a held provider, lost failed-start MCP close uncertainty, pre-cleanup setup fault
ordering, late consent writes, lease capture before acknowledgement, repeated
Clack close and lost output-failure classification. Each is corrected with
permanent regressions. These advisory reads are **not** either required complete
cumulative clean round or the separate security sitting. Earlier failed author
attempts remain failed evidence; no warning/timeout is relabelled as cleanup ACK.

At the frozen author source, before the final two late-consent integration
controls, the fresh ordinary CLI suite passes **304 files / 5,178 tests /
10 established skips**. Production bytes remain unchanged when those two
controls are added; the focused agent cohort passes all **37 tests**. The complete
MCP suite passes **20 files / 242 tests**.
Workspace lint/typecheck passes **17 tasks**, with twelve existing cache hits and
five fresh executions. The CLI build, seam/dependency fences, finite bundle closure,
compiled bootstrap and compiled CLI smoke pass. Closure remains **26 JavaScript
outputs / seventeen external dependencies**. The installed-Clack regression uses
synthetic streams; terminal-owner controls use captured clocks/deferred work.
Neither proves operator TTY restoration or actual Windows session shutdown.
The final `CI=true` workspace lint/typecheck/test gate passes **23 tasks**:
twenty valid cache hits and fresh CLI lint, typecheck and tests. That fresh CLI
execution includes both late-consent controls: **304 files / 5,179 tests /
11 established CI-projection skips**. Other packages' replayed test inventories
remain cache-attributed, rather than a fresh whole-repository execution. No new
remote CI, packed-platform, whole-wave or merge execution is inferred.

Remaining Step 8d work is actual fresh/resume/clear/reseat and superseded chat/Home
host integration; entered Ink suspension, persistent alternate-screen/job-control
and wizard custody; then native/bootstrap/caught/fatal/background/sink activation.
Two NEW complete cumulative clean rounds from the original `d9625ff0` boundary,
a separate NEW clean security sitting and actual required platform evidence are
still owed after final integration. **Whole Step 8 and Steps 9–19 remain open.**
No new ADR, deferral, credential, provider call, billing or user decision is needed.

## Wave 3 Step 8d chat and Home integration checkpoint — 2026-10-17

**Partial implementation on `development` at `f39a360d`; not Step 8d acceptance.** The
[canonical session ownership contract](../../reference/cli/commands.md#session-ownership-implementation-checkpoint)
now describes actual fresh/resume/clear/reseat and pending/superseded Home
construction, per-instance host/view/persister lifetime, captured Ink/prompt input,
shared database cleanup and persistent terminal/job-control integration.
One-shot acceptance is not inferred from the earlier substrate checkpoint.

Source advisory reads identify and correct the following mechanisms. They are
implementation advice, not either required complete cumulative clean round or
the separate security sitting. Reports remain local and Git-ignored. The first
53-path pin remains historical; subsequent fixes have their own source identity.
Changes made during advisory reads are explicitly outside those earlier hashes.

| Observed mechanism | Correction and permanent evidence |
|---|---|
| Readable-listener removal reentry consumes a pre-existing occurrence | Recheck actual multiplicity before every bounded removal. The real EventEmitter regression first fails at the baseline-preservation assertion, then passes. |
| Mounted input continues while native teardown waits | Gate root key/paste/submit handling before dispatch, including Home mouse copy. Installed Ink with a held native drain first reproduces a second Ctrl-Z dispatch, then passes after sealing. |
| Pending/replaced or equal-ID hosts are confused with the current UI pointer | Retain every actual builder invocation through post-build setup and all actual roots/children. Existing physical native forwarding controls retain separate instance/child counts. |
| Validation timeout or catalog completion permits early database close | Move shared close into surface cleanup after all roots/transferred work. Actual Home lifetime regressions retain held fake generation/discovery and refuse post-stop catalog writes. |
| Failed database close drops signal custody | Remove the signal subscription only after shared cleanup succeeds. A later terminating signal retains the original infrastructure disposition and deadline. |
| Partial view/exit-net/input registration or a failed remover supplies false release | Transfer custody before registration, guard empty construction, attempt sibling releases independently and retain uncertainty. Keep the synchronous exit net through final control ACK. |
| Unknown local catalog faults wait behind a held sibling | Report clock/key/publication faults at their actual boundary. Preserve optional cache-read recovery and ordinary provider-discovery isolation. |
| Old-host cleanup has no job-control handler; final publication starts after expiry | Hand off gap custody before waiting on receipts/MCP. Check remaining budget at each final publication; retain failed output classification before sibling joins. |
| Control enqueue is treated as native handoff | Retain exact captured delivery promises and await release/reclaim before native continuation. Final persistent-buffer restoration follows all actual child mounts and bindings. |
| Wizard or consent continuation writes after stop | Bind native prompts and cancellation, omit the installed ambient-input spinner, retain raw validation, and recheck admission after every relevant await and before credential writes. |

No new dependency, ADR, deferral, paid provider call, credential or user decision
is introduced. The bootstrap remains unchanged and native product-wide fatal
activation is still staged. Complete Step 8d acceptance still requires two NEW
complete cumulative clean rounds from `d9625ff0`, a separate NEW clean security
sitting and actual required same-artifact platform evidence. Whole Step 8 and
Steps 9–19 remain open; work proceeds automatically.

The final frozen partial source has **56 product/tool paths**, with no source
drift across the author gates. Fresh ordinary CLI execution passes **314 files /
5,266 tests / ten established skips**. The workspace lint/typecheck/test gate
passes **23 tasks**, comprising twenty valid cache hits and three fresh CLI tasks;
other packages' cached inventories are not a fresh whole-repository execution.
The build passes **six tasks**, with five cache hits and a fresh CLI build.
Tool lint, seam and engine-dependency fences, compiled CLI smoke and all **175
compiled bootstrap controls** pass on macOS/Node **22.23.1**. The finite packaged
graph has **25 JavaScript outputs / seventeen declared external dependencies**.
Both affected secrets controls (`export-live-review-notice` and
`export-live-interactive-notice-routing`) pass separate isolated
fixed/removal/restored cycles against the complete **130-case** chat file, with
the expected assertion failures and byte-identical restoration. These selected
cycles do not claim completion of the entire secrets-control family. Synthetic
TTY/input controls and local macOS smoke do not establish actual Windows session
shutdown, operator-terminal restoration or complete Step 8d acceptance.

## Wave 3 Step 8d management ownership checkpoint — 2026-10-17

**Partial implementation on `development` at `9798c51c`; not Step 8d acceptance.** A focused
read-only activation inventory found remaining management, standalone create,
deep-doctor and media-maintenance owners. Their integration follows the existing
ADR-0110 all-owners decision. The
[canonical command contract](../../reference/cli/commands.md#management-ownership-implementation-checkpoint)
owns concrete lifetime semantics; no new ADR, dependency, deferral or user
decision is introduced.

The command identity has stop/join/actual-retirement capability, without session
or workflow health. Shared no-health work mechanics preserve existing session
owners. Provider/model operations, captured stdin, deferred command database
cleanup, actual create prompts and the separate maintenance route are connected.
Every actual chat/Home doctor constructor forwards its host's raw producer
lifetime. The report timeout is not producer settlement: the new doctor
regression failed at that exact premature-cleanup assertion before correction.

Further implementation advice found four material integration gaps, all
corrected: spreading a class dropped the catalog signal getter; stopped business
IO blocked create-prompt restoration; a best-effort catalog catch consumed local
publication faults; and transient resolver/pricing handles lost failed-close
custody. Permanent controls exercise captured installed Clack, held native stdin
close, real SQLite with held discovery, late scaffold answers, retained
maintenance work, exact synchronous close and failed-release uncertainty.
The maintenance hold is an injected raw operation, not a claim of a real marker
failure. Synthetic streams do not establish operator-terminal restoration.

Earlier failed author runs remain attributed: nine lint errors stopped the first
workspace gate, and a later CLI run failed three native-forwarding assertions
that sampled the parent inventory before an already-closed transient resource's
positive retirement reaction. The fixture now requires actual removal before
measuring its strict native-parent baseline; cancellation or a timer never
supplies that fact. All **167** chat/one-shot cases then pass. These focused
advisories and author controls are neither required cumulative review round nor
the separate security sitting.

At the final frozen **33-path** product/test source, the complete workspace gate
passes **23 tasks**: twenty valid cache hits and fresh CLI lint, typecheck and
ordinary tests. Fresh CLI execution passes **320 files / 5,290 tests / ten
established skips**. The build passes **six tasks**, with five cache hits and a
fresh CLI build. Finite closure remains **25 JavaScript outputs / seventeen
declared external dependencies**; compiled CLI smoke and all **175 bootstrap
controls** pass locally on macOS/Node **22.23.1**. Unchanged package results retain
their cache attribution. No remote CI, new same-tarball platform execution,
whole-wave test or merge execution is inferred.

The original bootstrap remains unchanged. Global native installation,
post-import/caught/fatal/background/sink integration, two NEW complete cumulative
clean rounds from `d9625ff0`, a NEW clean security sitting and required actual
same-artifact platform evidence remain open. Whole Step 8 and Steps 9–19 remain
open; no provider, credential, billing or user action is pending.

## Wave 3 Step 8d native activation implementation checkpoint — 2026-10-17

**Implemented on `development` at `a2acba8e`, with required installed controls at
`2928d8ef`; not Step 8d acceptance.** The product entry installs the native
coordinator before deferred runtime loading and retains the actual loader/run
root. The original registry, finite-exit observer, absolute budget and physical
exit latch remain one authority. Explicit signal custody preserves each actual
surface's existing cooperative Ctrl-C behaviour while covering startup and
post-surface gaps. Runtime classification precedes return to the pure entry;
known operational refusals keep their meanings. Fatal classification precedes
joins and the sole fixed diagnostic follows acknowledged terminal restoration.
Background-only exit 9 remains recoverable rather than becoming a second fatal
failure. The canonical [ownership contract](../../reference/cli/commands.md#invocation-owners-and-fatal-ordering)
and [packaging contract](../../reference/cli/packaging.md) own these mechanics.

The two caught-exit advisory findings are corrected: an unexpected Home snapshot
failure after chat teardown reaches its actual lifetime, and owned slash commands
publish no ordinary notices after stop, including delayed doctor/compaction and
export-failure paths. Four assertions failed before the fixes; the focused 227-test
suite then passed, including positive normal-notice and terminating-Home controls.
Ownerless Home embeddings retain their original causes. The initial broad attempt
exposed eight ownerless compatibility failures; the corrected boundary's 85-test
focused run passed. Author lint/test failures are not clean review rounds.

Author workspace validation passed 23/23 tasks, with 20 valid cache hits and
fresh CLI lint/typecheck/test: 322 files, 5,314 passing tests and 10 established
skips. Other package test inventories were replayed from valid cache. Build
passed 6/6 (five cached packages and a fresh CLI). The finite emitted graph has
25 JavaScript outputs, 404 inputs and 17 declared externals. Tools lint/typecheck,
508 acceptance-tool tests, 37 focused package-tool tests, seam/purity gates,
compiled CLI smoke and all 177 compiled bootstrap controls passed on local
macOS/Node 22.23.1. Final publication validation remains attributed to the saved
working-tree source records, not inferred execution of a later commit.

Two selected live-export mechanisms each passed fixed/removal/restored with
133 fixed/restored tests, their named semantic failures, byte-exact restoration
and unchanged developer source. Each selected-family record deliberately remains
`complete: false`; this is not the full secrets family. The new installed eighth
case exercises real uncaught, unhandled-rejection and closed-stdout events through
the untouched selected entry. It joins exact target/descendant readiness, retains
the unrelated sibling, refuses a fatal diagnostic while native close delivery is
held, and requires one fixed diagnostic after delivery. Background mode permits
an ordinary successful turn before background-only exit 9. The local selected
package passed 177 bootstrap controls and all eight cases; its recorded tarball
SHA-256 is `22a0337dedbe85e2b6bf50b3245681e940d9c9480e581e736a4186aa13cb0cbe`.
Its receipt names `a2acba8e` with the then-uncommitted, pinned control changes;
no clean-commit or other-platform execution is inferred. Interactive restoration
and deadline nonrenewal retain their separate source-test attribution.

Local source records remain Git-ignored: the final activation record pins 33
paths (SHA-256 `4020e5ac1d09fb97c8e02a25dd5735cc0c007e244ce0b94f709c84da3d6fd498`),
and the installed-control record pins 12 unchanged paths
(`8e37bc50943db3039d2ab48d3785c198dd2415543247b7823de2dbd8a9065e63`).
Earlier author attempts, moving-source advisories and superseded evidence retain
their original scopes. None is an independent complete cumulative or security
review. No provider, keychain, operator-terminal, live clipboard or paid operation
was used.

**Remaining gates:** two NEW complete cumulative clean review rounds from
`d9625ff0a641197c6ed45968df99094a25db88d6` after the final material correction,
a NEW separate clean security sitting, fresh required full CI and the four
current same-tarball Linux/macOS/Windows/Node-22.0.0 consumers with the eighth case.
Whole Step 8 and Steps 9–19 remain open. No new ADR approval, provider capture,
credential, billing or user decision is pending. Work proceeds automatically.

## Wave 3 Step 8d first cumulative review and corrections — 2026-10-17

**Complete cumulative round 1 is NONCLEAN at `e3b0b673`; Step 8d is not accepted.**
Three independent reviewers inspected every path from
`d9625ff0a641197c6ed45968df99094a25db88d6`: 69 session/terminal paths,
117 workflow/management paths and 69 native/tooling/documentation paths.
Their coverage records join exactly 255 distinct paths without omission or
intersection. The local Git-ignored aggregate has SHA-256
`ff119d6d7d733a1bbf827ddb9d93206a5baa59ca9a5ea74043bbc89b6bcc7fff`.
A clean individual slice does not turn this nonclean round into acceptance.

All three verified findings are corrected in the subsequent working source:

- Fresh workflow and gate-resume default secret readers now use the original
  captured native stdin and workflow cancellation/failure ownership. The first
  cooperative Ctrl-C closes the actual open input pipe; command retirement and
  gate DB closure follow actual stdin close, without entering keys or the engine.
  Two permanent native-child regressions use an actual POSIX SIGINT on macOS and
  the exact registered callback on Windows. Removing only cancellation forwarding
  breaks both regressions; watchdog termination remains failure, never an ACK.
  Human-gate resume is physically exercised; the shared budget-resume helper is
  covered by its existing command tests rather than claimed as a new native probe.
- The installed Windows bootstrap cohort now requires five actual target/helper
  creations; the other cohort/platform combinations retain three. At the old head,
  all three Windows modes passed their native lifetime assertions before the wrong
  aggregate count refused publication. This does not certify the corrected head.
- The secrets-control README now records the actual 133-case live-chat inventory.

Required CI at the old head also refused the minimum-Node installed case. An
independently downloaded official Node 22.0.0 macOS runtime, verified against its
published SHA-256, reproduced the failure: the exact experimental JSON-module
warning was mistaken for a premature product diagnostic. The warning now remains
in raw private stderr and a separately named runtime observation; only the exact
owned-PID/version/two-line frame can be separated. Unknown, partial, duplicate and
wrong-identity stderr still fails. Three permanent tooling tests cover that fence.
The unchanged old package then passed all 177 bootstrap and eight installed cases
locally on Node 22.0.0; its SHA-256 is
`5d50070afbfe2f61efa6f59c64238ea374b48ba745b78b5b885cdb69da761ff0`.
This is a tooling correction on an old package, not corrected-product or Linux
acceptance. The old remote artifact retains its different recorded digest.

Four advisory Node-22.13 test failures reproduced on Node 22.0.0: older native
streams do not emit the `removeListener` event used by those injection fixtures.
The fixtures now inject reentry/refusal after the actual native remover returns,
independently of that optional runtime event. The callback-multiplicity control
also requires positive reentry. Both original-Node and minimum-Node 32-test cohorts
pass. Product removal logic is unchanged. Existing secret-reader fixtures now
supply captured sources rather than replacing ambient process stdin; named causal
witnesses and fixed test inventories remain unchanged.

Author validation after the corrections passes workspace lint/typecheck (17 tasks,
15 cached) and tests (11 tasks, ten cached packages and a fresh CLI execution).
Fresh CLI results are 323 files, 5,316 passing tests and ten established skips.
Build passes all six tasks, finite emitted-graph closure and 177 bootstrap controls
pass, as do tools lint/typecheck, 511 acceptance-tool tests and seam/purity gates.
Initial broad validation exposed four remaining ambient-stdin fixture failures;
those are corrected and the fresh workspace run is green. Earlier failed attempts
and source-change-contaminated selected controls remain failure evidence.

The default-reader and consumed-stdin consent mechanisms each pass their fresh
fixed/removal/restored cycles with 80 and 68 fixed/restored cases respectively,
exact named failures and byte-identical restoration. Both selected-family reports
retain `complete: false` and verify unchanged developer sources; neither is the
full secrets family. Test-isolation controls and the compiled CLI smoke also pass.

Two NEW complete cumulative clean review rounds after the final correction, a NEW
separate clean security sitting and fresh required full CI/four same-artifact
platform consumers remain open. Whole Step 8 and Steps 9–19 remain open. No new
ADR approval, credential, provider, billing or user action is pending.


## Wave 3 Step 8d second cumulative review and native-input corrections — 2026-10-17

**Complete cumulative round 2 is NONCLEAN at `98259c97`; Step 8d remains open.**
Three independent reviewers inspected all 262 paths from `d9625ff0`: 70
session/terminal paths, 121 workflow/management paths and 71 native/tooling/docs
paths. Their inventories join without omission or overlap. The local Git-ignored
aggregate SHA-256 is `7d805b33457b732acbecd05bea77de9b143875c02be047e4f3da5bc496dc7a7c`.
Two verified High findings, followed by one verified High supplemental finding,
are corrected in the subsequent source. A clean slice, supplemental advisory or
passing author test is not a complete clean review round.

- Plain/JSON chat now reserves partial native readline cleanup before construction
  or iterator entry. The actual entered driver remains owned through cancellation,
  late continuations, callback removal and input pause. Eight full-command
  regressions failed before correction; separate retained-continuation and failed
  removal controls cover the original finite-exit path without inventing cleanup
  ACK. Prior input callbacks remain intact.
- Both catalog-refresh axes recheck their original admission before each credential
  candidate, database read and clock stamp. An unexpected first-key failure can no
  longer start another candidate after synchronous owner stop. Ordinary typed
  missing-key discovery still continues. Three negative controls failed before
  correction; two ordinary-discovery controls remain positive.
- The focused supplemental audit reproduced early secret refusal retiring before
  actual native close: both partial iterator setup and the ordinary 65,537-byte
  refusal. The reader now reserves native close observation before iterator entry,
  independently requests destruction before awaiting iterator cleanup and joins
  actual close delivery on every consumed non-TTY outcome. Operator TTY refusal
  remains before consumption; generic iterables retain their awaited-return/primary
  failure contract. Two held-`_destroy` regressions failed before correction.
  Close-observer failure still requests destruction but retains uncertainty and
  database ownership through the original physical exit. No second timeout is added.

The author's first secret-reader repair prematurely acknowledged `Socket.closed`;
existing actual workflow/gate pipe tests caught both missing close-delivery events.
The public flag can become true before native close delivery. The repair now uses
its owned event receipt; an unobserved preclosed source retains uncertainty. Four
permanent native-pipe controls hold actual close delivery across factory refusal,
cap refusal, cancellation and preclosed input. No public flag, iterator return,
internal state bit or elapsed deadline supplies delivery ACK. The focused advisory
was initially clean on a narrower probe set; its appended follow-up records this
miss and corrected scope. Neither advisory counts as an acceptance/security round.

At `98259c97`, all four required same-tarball remote consumers and their aggregate
passed, including current Windows and Node 22.0.0. This is historical execution,
not execution of the subsequent corrections. Broader CI refused the usage inventory
and the Windows advisory job. The usage suite passed all 23 mechanisms and 446
permanent cases before rejecting its stale 440-case pin; the corrected guard pins
446 and independently collects the actual 17 test files. Native-child inventory
remains 71. Four intentional fatal-exit filesystem fixtures now use their existing
injected finite clock/exit ports instead of accidentally exiting the real test
worker three seconds later. Production timing and physical exit are unchanged.
The concurrency outbox now belongs to the test's own temporary directory. This
hermetic change is not claimed to explain the separately observed Windows 5s
coexistence timeout; its timeout remains unchanged and fresh platform execution is
required.

At the final frozen fifteen-path product/test/tooling source, author workspace
lint/typecheck passes all seventeen tasks (fifteen valid cache hits); tests pass all
eleven tasks, with ten cached packages and fresh CLI execution: **327 files, 5,343
passing tests and ten established skips**. Build passes six tasks (five cached).
Tools lint/typecheck, all **512 acceptance-tool tests**, test isolation, seam/purity,
finite emitted-graph closure, **177 compiled bootstrap controls** and compiled CLI
smoke pass locally on macOS/Node 22.23.1. The local Git-ignored author source pin
has SHA-256 `9b2441993c2fb6bf39d174c5352f45d9ea60066bab84ccd0222d5d15c2714354`.

Removing only entered-readline retention or only native-secret close joining breaks
the corresponding named semantic regressions; both exact restorations pass. The
existing generic-iterator cleanup mechanism also passes its fixed/removal/restored
cycle with 31 fixed/restored cases. That selected-family report retains
`complete: false`; this is not full-family or remote/platform acceptance.
Earlier failed tool invocations, loader/fixture corrections, the first
full workspace's two close-order failures and narrower historical evidence retain
their scopes. Test collection initially overwrote one test file; the author restored
its exact HEAD bytes immediately. The new collector always writes an explicitly
owned temporary output path, so no test filter can become its report destination.
No unintended test-content change remains.

Two NEW complete cumulative clean rounds after the final material fix, a NEW
separate clean security sitting, fresh full CI and the four same-artifact platform
consumers remain open. Whole Step 8 and Steps 9–19 remain open. No user decision,
ADR approval, credential, provider capture or billing action is pending.


## Wave 3 Step 8d third cumulative review and partial-acquisition corrections — 2026-10-17

**Complete cumulative round 3 is NONCLEAN at `ec8ba368`; Step 8d remains open.**
Three independent complete slices join all 269 cumulative paths from `d9625ff0`
without omission or overlap: 73 session/terminal, 125 workflow/management and
71 native/tooling/docs. The local Git-ignored aggregate SHA-256 is
`ceb0e5610e795f23fda760599e2cea96caf409c60f6a08f200b49b3c65748d0d`.
A clean slice is not a clean round. One verified Blocker and two verified High
findings require the subsequent corrections below.

- The permanent usage collector now copies the actual source graph into an owned
  install-only tree, with no build outputs or workspace-package links. It uses
  the canonical source aliases and refuses transformations into the original
  workspace. A no-alias negative control establishes that the local built graph
  cannot supply the proof. Actual collection still pins 17 files / 446 cases;
  the independent runtime native-child inventory stays 71. Required install-only
  CI jobs gain no build prerequisite or weakened gate.
- Secret stdin and one-shot agent input share captured native close observation
  before iterator acquisition. EOF, partial setup, cancellation and unobserved
  preclosed sources cannot supply close ACK from public flags. Independent native
  cancellation and callback removal retain their own uncertainty. A failed abort
  listener removal still joins actual close and cannot retire the input. The
  caller's operator-TTY refusal remains before consumption.
- Every shipping database route now transfers its actual native close capability
  to its original owner immediately after SQLite construction, before PRAGMAs,
  hardening, migrations or store construction can throw. Production-injected
  openers forward the same optional handoff. Legacy returned methods preserve
  their receiver; returned wrappers cannot replace an early native capability.
  Workflow, management, chat/Home, one-shot journal and transient resolver/pricing
  owners retain their existing identities and cleanup order. The sole-opener
  refactor remains Step 18. Primary and secondary startup failures survive
  together; failed release cannot inherit operational storage provenance.
- Optional pricing degradation no longer swallows unknown acquisition or native
  cleanup faults. A later successful release can retire the actual resource while
  retaining the earlier infrastructure observation. A one-shot database tail
  closes before its surface removes signal custody; unknown partial construction
  retains that custody through the same original finite-exit obligation.

Thirty-three real SQLite controls exercise management, workflow/gate, fresh and
resumed chat, Home, one-shot journal and optional pricing paths. Sixteen native
failure cases break at named semantic assertions when only original-owner handoff
is removed; exact restoration passes all 33. The native-constructor controls fail
before the pre-PRAGMA fix and pass afterward. Four actual agent child controls
cover EOF, iterator-factory refusal, cancellation and preclosed input; restoring
only the previous agent reader breaks the EOF ownership assertion. The first
removal attempt instead hit an unhandled IPC EPIPE and is excluded: the parent
fixture now observes release-send failure and the repeated removal reaches the
semantic assertion. The 31-case secret iterator cleanup mechanism retains its
fixed/removal/restored proof, with the selected-family report explicitly
`complete: false`.

CI run `38984767780` at `ec8ba368` remains failed. Its install-only filesystem and
secrets jobs exposed the collector defect before their families ran. Coverage
exposed a Node-24-incompatible test continuation: a closed readline interface
cannot be resumed there. The corrected control resumes its captured native input,
proves that late activity happened, and retains all final cleanup assertions.
Independent Node 24 focused execution passes. This is a test correction, not a
relaxation of product sealing or native cleanup.

That run's current-Windows advisory and Linux/Windows/Node-22.0.0 packed consumers
pass. Its macOS packed leg remains failed with an unexpected infrastructure 9;
its initiating cause is not established. The exact package and matching official
Node 24.21.0 pass eleven instrumented local cohorts and one untouched eight-case
cohort, but the local OS differs from the remote image. These local passes neither
replace the remote failure nor establish a flake. No package assertion, native
close/readiness control or watchdog is relaxed.

At the final frozen 42-path product/test/tooling source, author workspace
lint/typecheck passes seventeen tasks (fifteen cached); tests pass eleven tasks
(ten cached), with fresh CLI execution of **332 files / 5,394 passing tests /
eleven reported skips**. Build passes six tasks (five cached); the finite CLI
graph has 25 outputs / 407 inputs / seventeen declared externals. Tools
lint/typecheck, all **512 acceptance-tool tests**, seam/purity, test isolation,
**177 compiled bootstrap controls** and compiled CLI smoke pass. Node 24.19.0
passes twelve focused native-input/readline cases; official Node 22.0.0 passes
43 focused reader/acquisition cases. These are author checks, not remote package
or independent-review acceptance. The local Git-ignored source pin SHA-256 is
`4a7cb298512fba75fb35ae616feae765f532705b04f7d784b5d4cebc82acdcc1`.

Earlier lint/type/fixture failures and the full workspace's two obsolete
immediate-retirement controls retain their historical scopes. Those injected
unknown-open controls now use fake physical-exit ports, verify retained signal
custody and independently joined MCP cleanup, and cannot terminate the real test
worker. No timeout, production shutdown budget or required gate was increased.

Two NEW complete cumulative clean rounds after the last material fix,
a NEW separate clean security sitting, fresh full CI and all four same-artifact
platform consumers remain required. Whole Step 8 and Steps 9–19 remain open.
No user decision, ADR approval, provider, key, billing or capture action is pending.

### Wave 3 Step 8d fourth cumulative review and native-resource corrections — 2026-10-17

**Implementation correction checkpoint; not Step 8d acceptance.** Three NEW
complete cumulative reviewers cover all **279 paths / 1,506 zero-context hunks**
at `db825377a6b213d8a63a1ed0b39a2a63b9193982`, against the unchanged cumulative base
`d9625ff0a641197c6ed45968df99094a25db88d6`. Their disjoint 73/129/77-path slices
join exactly, with every assigned physical source hash checked. The session slice
is scoped CLEAN; workflow/management and native/tools/docs are NONCLEAN, with
three verified High findings. The local Git-ignored aggregate SHA-256 is
`13554160ab36a9fd076e5b26dc14e0983e9ce4ad0aeea70a378a90e14b9278fd`.
Rounds 1–4 remain NONCLEAN; a clean slice is not whole-increment acceptance.

- **WM-R4-1, consumed one-shot input:** the default `agent run` gate previously
  treated stale TTY metadata as permission to prompt after mandatory stdin had
  reached actual EOF/close. An actual command/default-builder/installed-Clack
  reviewer probe remained pending without spawning MCP until its original signal
  cancelled it. The corrected default has no second input authority; unapproved
  stdio refuses before prompt/client construction. The paired exact-digest control
  succeeds through the real builder and manager without writing a grant. Explicit
  injected host consent retains its own authority.
- **WM-R4-2, expired successful-client cleanup:** workflow late publication and
  all three actual run/human-gate/budget-resume finalizers now use the original
  remaining budget, as the agent connector already did. Expiry cannot start a new
  asynchronous SDK close or release the database/signals. Paired actual-manager
  controls exercise zero remaining time and a close entered with one millisecond
  remaining; the latter holds real close acknowledgement before actual SQLite
  release. The original absolute deadline is unchanged.
- **N4-01, auxiliary SQLite custody:** the migration lock creates a second native
  connection, distinct from history. Its close capability is now captured before
  PRAGMA/lock acquisition and added to the one composite already transferred to
  the original opener owner. Failed auxiliary release does not skip independent
  main release, retire the owner, remove signals or gain operational storage
  provenance. Primary and cleanup causes survive. Actual installed-driver
  held-iterator close refusal, opaque/storage-shaped injections, later successful
  release and normal two-connection closure have permanent controls. The held
  iterator is an injected schedule, not a claim that ordinary migration creates
  it or that an OS disk fault was measured.

Independent reviewer execution remains scoped: 697 session tests; 56 workflow
preparation/acquisition tests; 117 native source tests, 54 tooling tests and three
actual-handle reproductions. Counts overlap author selections and are not summed
into a new whole-suite claim. Root independently reproduced all three lock-close
cases. Author regression execution passes 289 CLI cases in ten complete files
and fourteen DB cases in three complete files before final whole-workspace gates.
Five separate author removal exercises break the named forwarding, native lock
handoff, consumed-input and workflow close controls; each restores exact original
bytes. The initial malformed forwarding mutation and the initial obscured native
witness are rejected harness attempts, retained locally and not acceptance
results. Filtered unselected cases are not product skips or whole-suite execution.

The CLI declares the already-catalogued SQLite development type package for its
actual native-handle tests; no runtime package or resolved version changes.
Frozen offline lockfile validation and CLI/DB typechecks pass. Canonical behavior
belongs in the [CLI lifecycle contract](../../reference/cli/commands.md#management-ownership-implementation-checkpoint)
and [database contract](../../reference/shared-core/database-schema.md#concurrency--transaction-behavior).

At source `db825377`, required packed Linux/macOS/Windows and minimum Node 22.0.0
consumers and their aggregate pass in run `38989000942`. Broader CI was still
running at this checkpoint. These new remote passes do not rewrite the earlier
unexplained `ec8ba368` macOS failure or count as post-correction evidence.
Two NEW complete cumulative clean rounds after the last material fix, a NEW
separate clean security sitting, fresh full CI and all four same-artifact package
consumers remain required. Whole Step 8 and Steps 9–19 remain open. No user,
ADR, provider, key, billing or capture decision is pending.

**Final author source gates for this correction.** Workspace lint/typecheck passes
seventeen tasks (fifteen cached); tests pass eleven tasks (nine cached), with
fresh CLI **334 files / 5,407 passing tests / eleven existing reported skips**
and fresh DB **64 files / 1,062 passing tests / no skips**. Build passes six tasks
(five cached); bundle closure remains 25 outputs / 407 inputs / seventeen declared
externals. All 512 acceptance-tool tests, tools lint/typecheck, schema sync,
format, seam/purity, test isolation, 177 compiled bootstrap controls and compiled
CLI smoke pass. The final five removal exercises restore exact bytes; restored
execution passes 246 CLI and fourteen DB cases with no failures/skips. Earlier
author lint failures are corrected, not waived. The local 18-path product/test/
configuration source pin SHA-256 is `c33fe30d7ee58825a924e2d1ac81f64a94ab0c474cc8d2b890ab9dae407585d0`. These are author gates;
independent cumulative review, security and post-correction remote acceptance
remain open.

### Wave 3 Step 8d fifth cumulative review and deferred-close correction — 2026-10-17

**NONCLEAN; no Step 8d acceptance.** Three NEW complete cumulative reviewers cover
all **285 paths / 1,526 zero-context hunks** at
`ad743ba5819361ad070a27ee31f0fb5751b823d4`, against the same `d9625ff0` base.
Root independently verifies every physical file, complete diff and individual
hunk hash, with disjoint 73/131/81-path coverage. The local Git-ignored aggregate
SHA-256 is `56250341253e61c55c6788f142a1998bde576ffb378bc582be8f660c91d34adc`.
Session/terminal is scoped CLEAN; the other two slices corroborate the same High
**WM-R5-1**, counted once. R4's three original schedules are repaired; all first
five complete rounds remain NONCLEAN.

The helper admitted a successful MCP manager close with one millisecond left,
but the manager deferred actual connection entry and discarded the lifecycle
budget after successful startup. An already queued microtask could consume that
millisecond before transport/SDK close began. Root and both relevant reviewers
reproduce the paired helper schedule; independent reviewer probes additionally
exercise actual `runCommand`, the real manager and real SQLite. These are
synthetic connections/fake clock schedules, not native MCP subprocesses. They
establish forbidden late close entry, not a renewed deadline, false ACK or survival
past physical exit.

The manager now retains the same live budget across deferred successful close
and checks it at every actual transport-close factory. Successful-client reporters
remain distinct from failed-start observers, preserving once-per-callback delivery
and the shared reentrant close promise. Permanent controls cover queued expiry,
remaining-time positive acknowledgement, per-connection exhaustion and reporter
identity; actual run/human/budget finalizers add the queued-expiry schedule beside
their zero/one-millisecond pairs. No shutdown budget or timeout increases.
Canonical semantics live in the [MCP integration contract](../../reference/shared-core/mcp-integration.md#failed-start-cleanup-lifecycle).

Reviewer execution retains its separate scopes: 697 session tests; 405 workflow
cases plus two selected budget cases; 159 native cases and 66 tool cases; four
shared defect-observation probes. These overlapping counts are not a new suite
aggregate or the separate security sitting. The root-read complete reports remain
local and ignored.

At `ad743ba5`, all four packed consumers/aggregate pass. Root downloads the actual
five GitHub artifacts, verifies each GitHub ZIP digest, rechecks tar bytes/public
inventory and all seventy installed files per consumer, and binds every report
to the actual remote run/attempt/source. The common tarball SHA-256 is
`487870990752ce6559f9cdec979702bff0a8ba8670e439223f434e3f6c40554f`;
the independent local physical-audit record SHA-256 is
`e0f503fb4adf29f414f54e7cad40d7bc9a5f29bf53e13455ee00c270cb2f37a2`.
This is artifact inspection, not a new remote consumer execution. Current Node
consumers use 24.21.0; the separate minimum leg is exactly 22.0.0.

Broader CI `38991418424` is not accepted: required secrets controls correctly
reject an obsolete 80-case run-file pin after R4 added two cases, and the Windows
advisory times out once in benign-alias resume (5,143 ms against 5,000). The
secrets pins are updated to the actual final 83 run / 71 gate cases, including
this correction's added schedule, while exact-count/identity/runtime-error and
fixed/removal/restored checks remain strict. No control or assertion is removed.
The same Windows case passed at prior `db825377` in 437 ms; local macOS controls
do not explain or clear the current Windows failure. Fresh Windows evidence
remains required; no timeout relaxation or inferred product repair is recorded.

Two NEW complete cumulative clean rounds after the last material correction,
a NEW clean separate security sitting and fresh full CI/platform evidence remain
required. Whole Step 8 and Steps 9–19 remain open. No new ADR or user decision,
provider, credential, billing or production custody setup is needed here.


**Final author gates for the R5 correction.** Seventeen workspace lint/typecheck
tasks pass (twelve cached); eleven test tasks pass (nine cached), with fresh CLI
**334 files / 5,410 passing tests / eleven established reported skips** and fresh
MCP **twenty files / 246 passing tests / no skips**. Build/format passes seven
tasks (five cached); all 512 acceptance-tool tests, tools lint/typecheck, schema
sync, seam/purity, test isolation, 25-output bundle closure, 177 compiled bootstrap
controls and compiled CLI smoke pass. The new regressions first break at the two
named MCP assertions and all three actual workflow-finalizer assertions before
the fix; their corrected complete/selected executions pass. Filtered unselected
cases are not product skips or whole-suite evidence.

Three affected secrets controls independently pass fixed/removal/restored at
83/71/83 complete-file cases, **nine phases / 711 executions**. Each removal
breaks its named witness, every restored source digest equals its fixed digest,
and the isolated graph reports developer sources unchanged. This selected run
honestly retains `complete: false`; it is not acceptance of the full secrets
family. An initial unsupported argument invocation is a rejected setup, not a
product result. The local causal-summary SHA-256 is
`aca1ee8f4a921f86afdcc175b9a247d516aaae4766c7e1739c5314206157a551`;
the seven-path product/test/control author pin SHA-256 is
`92bd5f22ec12fd8fda5db4e577044d0baa53bfdced9275f579025e7116c0385f`.

Separate read-only Windows triage finds no verified defect. The unchanged
original eight-case suite passes locally, and an immutable `ad743ba5` snapshot
verifies all eight acquired native handles close with zero remaining product
owners. Local macOS timings cannot explain the remote Windows timeout. The local
triage report SHA-256 is
`edf43b42f6ab90043e05cf2445d213bdf71146aed32a798de1a37c690a0d4702`.
These are author/triage records; rounds 1–5 remain NONCLEAN and new cumulative
review, separate security and post-correction CI/platform acceptance remain open.


### Wave 3 Step 8d sixth cumulative review and first-fault correction — 2026-10-17

**NONCLEAN; implementation correction, not acceptance.** Three NEW complete
cumulative reviewers cover all **285 paths / 1,526 zero-context hunks** at
`4b7ba2164d119d72a0fccaea742a6e261f03576f`, against the same `d9625ff0` base.
Root reads every full report and independently rejoins all 73/131/81 physical
file, complete diff and individual hunk hashes. The local ignored aggregate
SHA-256 is `daf8739b459e0fda0e47320a1480d6681599916ac6fef57739252f3c4700482d`.
All three slices are NONCLEAN. Three verified High findings, independently
corroborated and counted once each, require correction:

- **WM-R6-1:** a successfully initialized manager retains an actual connection
  close refusal but reports it only after every sibling close settles. Actual
  `runCommand`, the default engine, real SQLite and the actual manager reproduce
  no infrastructure observation/deadline/exit at a manually advanced 10,000 ms;
  releasing the held sibling then creates the first deadline at 13,000. Root
  independently reruns the same three-probe source selection. Its initial wrong
  configuration collected zero tests and is rejected setup, not evidence. The
  two paired R5 controls independently confirm its deferred-budget fix.
- **F1:** the current chat reference still promises crash exit 1 and excludes
  infrastructure 9 from its one-shot wording. The correction preserves ordinary
  classified failed turns, deliberate chat end and invalid invocation, while
  linking the canonical infrastructure/remedy contract. This adjacent unchanged
  reference was supporting context, not an extra assigned path in the review.
- **F2:** the current Home reference still promises immediate second-signal exit
  and timer-bounded cleanup followed by DB closure. The corrected product reference
  describes the original deadline and actual joins, keeps infrastructure precedence
  visible, and distinguishes the ownerless library compatibility path.

Successful MCP reporters are now registered before shared cleanup, notified once
per failed server as each fault occurs, and replay retained faults immediately
when attached late. Mark-before-callback prevents duplicate reentry. Every actual
close remains joined; a reporter exception is retained until those joins settle,
and failed-start observation remains separate. The original live budget still
controls actual entry. Four new manager schedules and an actual workflow/SQLite
regression pass; replacing only the manager with its pre-fix bytes breaks exactly
five permanent cases, then restores the fixed bytes. This is an author removal
exercise, not a new formal whole-family causal certificate. The run/gate secrets
workloads remain 83/71; no control inventory is weakened.

Reviewer scopes remain distinct and overlap author selections: 697 session cases;
467 workflow cases plus three probes; 163 native source cases, 66 tooling cases,
four paired correction probes and three shared probes. This is neither full CI
nor the separately required security sitting. All first six rounds remain NONCLEAN.

At `4b7ba216`, minimum/current Linux and current Windows installed consumers pass;
required macOS and therefore the packed aggregate fail. The new Windows advisory
passes, including all eight benign-alias cases, without changing the old 5-second
bound. This does not explain the prior `ad743ba5` timeout. The current macOS
injected-error control returns fixed infrastructure 9 where ordinary native
outcomes still require 0/1. Actual target/descendant readiness, native close,
listener removal and fixture/sentinel cleanup are recorded, without a watchdog;
the initiating fault remains unknown. Node there is actually **24.20.0**, not a
version inferred from another platform's current-runtime leg.

Independent immutable-source triage verifies the actual tarball
`0a1a38868a581806d026bd707e43634b39d790ac2cfcda7d3cd4b183763b56a3`, all
seventy installed files and official Node 24.20.0. Thirty-one local injected-error
executions and 96 native subcases pass, including an unchanged complete eight-case
worker. Local macOS 27.0.1 differs from the CI host's 26.6.2. Invalid canonical-path/
module-context attempts and their cleanup limits are retained separately. These
passes do not clear either failed macOS source. The ignored triage report SHA-256
is `db3004eb5f27425c54c6c68a1afcb44790219348f229885b59b8814a28831069`,
and its 89-file evidence manifest SHA-256 is
`80b045f29009e523e41056fe2f424c98ca78946d0ca101f892d36d70632927b2`.

The existing installed-test witness adds passive actual signal/uncaught-occurrence
observations with bounded native-origin facts and a required terminal completeness
record. It forwards the original receiver, arguments, result and throwable,
retains observation failure without masking the native result, and adds no
product handler/registry/exit authority. No exit, acknowledgement, readiness,
watchdog or timeout assertion is relaxed. The new tooling is locally exercised
against the unchanged old tarball with its complete eight-case worker and all
seventy installed bytes preserved; this is tooling validation, not a newly built
post-manager-fix artifact or remote platform acceptance. Required future macOS
execution remains open; no unobserved errno is normalized or declared harmless.

Two NEW complete cumulative clean reviews after the last material correction,
a NEW separate clean security sitting and fresh full CI/all four exact-package
platform consumers remain required. Whole Step 8 and Steps 9–19 remain open.
No ADR approval, user decision, provider, credential, billing, capture or production
recipient setup is pending. Root continues automatically.


**Final author gates for the R6 correction.** Seventeen workspace lint/typecheck
tasks pass (twelve cached); eleven workspace test tasks pass (nine cached).
Fresh CLI execution is **335 files / 5,412 passing tests / ten reported skips**;
fresh MCP is **twenty files / 250 passing tests / no skips**. The previously
CI-skipped local wrap-shape case runs and passes in this non-CI author environment;
this explains the changed CLI skip count without deleting or weakening a case.
All **516 acceptance-tool tests**, tools lint/typecheck, schema sync, seam/purity,
714-file test isolation, build/format, 25-output closure, 177 compiled bootstrap
controls and compiled CLI smoke pass. Build/format has seven tasks, five cached.
The initial copied-tool fixture import failures and missing performance import
lint failure are repaired, not waived. A missing old temporary artifact path is
rejected local setup before install; the retained artifact is used for the valid
new-diagnostic worker. Root independently verifies all 89 sealed triage files.

The ten-path product/test/tool author pin SHA-256 is
`794c04657e8ef264f718805cc53d0c02a922b20474aa0160df5322e5208e9c3f`.
These are author gates; independent cumulative review, security and fresh required
remote acceptance remain open. At the previous source, wire/usage/secrets controls,
coverage and Node-floor/Windows advisories have passed while filesystem controls
are still running; required macOS/packed aggregation remain failed. No whole-CI
success or post-correction artifact evidence is inferred from that partial run.

### Wave 3 Step 8d seventh cumulative review and native-outcome correction — 2026-10-17

**Implemented correction; independent acceptance remains open.** Three NEW
read-only reviewers assess the complete original `d9625ff0` base through
`86f0422ac1d5010986f89e48dc8ddcb8f7547936`. Root independently recomputes all
288 physical-file hashes, full zero-context diffs and 1,534 individual hunk hashes,
then verifies disjoint complete coverage: session/terminal 73 paths / 505 hunks,
workflow/management 132 / 791, native/tools/docs 83 / 238. R7 is **NONCLEAN**, with
one confirmed Medium tooling finding, `WNT-R7-1`; the other two complete slices
are clean. No clean slice is inherited as a new whole review. The local aggregate
SHA-256 is `b9f0144911010f50cec5ddabdc85c252dc6194e8f234e84e7cc5bcf37e337292`.
All seven historical complete rounds remain NONCLEAN.

The required macOS job `117286651653`, run `38995305462`, at the reviewed source
now records the actual initiating native fact. The same explicitly created
detached group receives a successful SIGKILL, then a SIGKILL refusal with own
`EPERM`/`-1`; actual target close follows, then the final reap receives `ESRCH`/`-3`.
The passive diagnostic is complete, and product infrastructure 9 is retained.
Prior successful signaling or later absence cannot erase a real refusal. The
product's two final reaps and non-ESRCH failure rule remain unchanged. The
unconditional nonbootstrap smoke expectation rejects 9 before its remaining
postconditions run. Two independent readings and an actual-source protocol probe
corroborate this control defect. Current XNU source suggests a possible group-state
explanation, but the runner's exact kernel/member states are unverified; no
harmlessness, zombie-cause or flake conclusion is drawn.

The [installed-package control](../../../tools/cli-package/README.md) now accepts only
that narrowly witnessed Darwin injected-error **failure outcome**: complete
three-signal evidence tied to the actual creation, exact infrastructure 9 with one
fixed `cli_internal` diagnostic, actual target/delivered closure and **zero**
completed turns. Fault-free cases retain 0/1 and one completed turn. All original
readiness, descendant absence, sibling survival, watchdog, timing, cleanup,
compiled-byte and forbidden-service assertions still execute. Missing/foreign/
extra fault evidence or an unexplained 9 refuses. This is correct failure
classification, not ordinary success or retrospective acceptance of a failed CI
run. The permanent validator has thirty adverse vectors; a separate native-owner
preservation case pins sticky 9 through explicitly simulated native close without
adding a product fix.

Root safely downloads the exact reviewed package, verifies GitHub ZIP digest
`2aed0e470de56b5948137d93249deef63679ffac7a3d57ff8433e63778007d14`,
tarball `7b20f20ba6d073fcb50f682e6a1cde7f19042e0dd2797e09c9733f59f39e9acc`
and all seventy installed files. A synthetic native-edge EPERM after an actual
successful group kill makes the original control fail semantically. It establishes
actual infrastructure cancellation with zero completed turns. The corrected
control then executes all three nonbootstrap modes, preserving every postcondition:
9 for the witnessed refusal and ordinary 0/0 for the other modes. A separate
unchanged-installation complete eight-case worker passes. Both retain byte identity
and actual owned cleanup; the installation is removed. These are local author
controls on Node 24.20.0, not fresh remote 24.21.0 or full-CI acceptance. An initial
experimental injection also affected an unrelated mode and is correctly rejected;
that invalid experiment is retained separately rather than counted as a pass.

**Separate fixture-lifetime corrections.** Fresh Windows advisory job
`117286543561` fails a native DB readiness wait, the CLI native-writer case deadline
and the following root-alias expectation (0 expected, 2 observed). The required
Windows packed consumer passes at this source; it does not clear the advisory.
Three restricted actual-source/native probes establish pre-existing fixture
problems: error/exit was treated as child retirement, and a raw timed-out test can
enter the next case's mocked home. Holding that late native maintenance operation
reproduces `maintenance_active`/2 at the next root. This is a feasible source
schedule, not proof of the remote failure's exact cause. The local full workspace
run separately exposes two acquisition-test files: a first-case timeout, then
close count four instead of two, plus an acquisition admission wait failure. Two
restricted actual SQLite probes reproduce late-import reuse of the next mock and
preserve exact count two when the original case is sealed.

Corrections retain the existing five-second readiness/case limits, one-second
admission wait, exact outcomes and close-count assertions. Native fixture cleanup
joins actual **close**, with runner-owned cleanup before home replacement. The
writer captures its original signal/home, seals after timeout and uses one
remaining case budget instead of renewed phase budgets. Bounded fixed phase,
exit/close and diagnostic-code facts improve future failure attribution. The DB
fixture's real started-child error regression requires cancellation and actual
close; restoring the erroneous error-as-ended guard fails its named semantic
assertion and byte-exact restoration is retained. Acquisition cases now retain
their raw scenario through runner cleanup, check the original captured signal
and an explicit cleanup seal after imports/before native admission, join pending
startup before mock reset and retain every exact native disposal capability.
Pure module transformation is prepared before the unchanged semantic case timer.
Deliberately unacknowledged failed-close product results remain pending; manual
harness disposal is never a product ACK. No product runtime or accepted decision
is changed by these fixture repairs.

The ignored Windows triage report/evidence SHA-256 values are
`6edb030e22389ac53c85ea64fc056be9258a34cfdc34477ad26b82feb68a16db` /
`6d22bf164ac290e61a0280d8f9a195bc392457fab0244680f9aced89c07f711f`;
the acquisition triage values are
`af7f63d915e800280950cbd6f93a7d25b85b87b053f58a5cdbaf7abf5da877e3` /
`ac2f71b9a91e0d6e5aa7ce4c726ab71dff440bdbcca0aa6c4989aab99966df49`.
Their original sources and scope limits are preserved; they do not review the
subsequent author corrections. Initial author import/context setup mistakes are
repaired before the valid focused controls, not waived as successful executions.
Author validation continues on the corrected source. Historical red runs remain
red; no exact Windows readiness/root-cause diagnosis is inferred from local green.

Two NEW complete cumulative clean rounds after the final material correction,
a NEW separate clean security sitting and fresh full CI plus all four actual
same-artifact consumers remain required. Whole Step 8 and Steps 9–19 remain open.
No ADR approval, user decision, billing, provider/keychain operation, capture,
production recipient or release upload is pending. Work continues automatically.

**Final author gates for the R7 correction.** The corrected source passes all
seventeen workspace lint/typecheck tasks (fifteen cached) and eleven workspace
test tasks (nine cached). Fresh DB execution is **64 files / 1,062 passing tests**;
fresh CLI is **335 files / 5,413 passing tests / ten established local skips**.
All **547 acceptance-tool tests**, final tools lint/typecheck, schema sync,
seam/purity, 714-file test-isolation/ownership, seven build/format tasks
(five cached), 25-output compiled closure and 177 compiled bootstrap controls pass.
The earlier full-suite, context-setup and cleanup-lint failures remain retained
and repaired; they are not waived or counted as positive controls.

The eleven-path source seal SHA-256 is
`c5e27edb6dce7c57dceca4abaa1590c7f6e263d0b0e55614b96f7f64350212ac`;
all sealed bytes are independently checked unchanged after final gates. The
separate eight-case exact-package author worker and selected native/fixture
removals retain the narrower scopes recorded above. Fresh required remote CI,
all four actual same-artifact platforms, two NEW clean cumulative reviews and a
NEW clean security sitting remain open. This author checkpoint grants no Step 8d,
whole Step 8 or later-increment acceptance.


### Wave 3 Step 8d eighth cumulative review and coexistence-fixture correction — 2026-10-17

**R8 is complete and NONCLEAN; Step 8d and whole Step 8 remain open.** The root
read all three new cumulative reports and independently recomputed every physical
file, complete U0 diff and hunk identity at frozen `09740575`, from the original
Step 8 base `d9625ff0`. Coverage is disjoint and complete: **293 paths / 1,578 hunks**.
The inventory SHA-256 is
`aca454b00ff8b040f3b1880f1e98291c829c57a71bf270c26e1e3819ec96affe`;
the independently joined aggregate is
`5cfac59a82a137bfc1c762e69e21da36ea4ab54b9feddc9ea97dc0063a440736`.

| Complete cumulative slice | Paths / hunks | Fresh execution, separately attributed | Verdict |
|---|---:|---|---|
| Session/terminal | 73 / 505 | 35 files / 697 passes, zero skips | CLEAN |
| Workflow/management | 134 / 809 | 37 files / 489 passes, one established non-Windows skip | CLEAN |
| Native/tools/docs | 86 / 264 | 19 source files / 228 passes; 101 tooling passes | NONCLEAN: WNT-R8-1 |

Selections overlap between reviewers; no deduplicated combined test total is
claimed. These source/protocol executions do not certify operator TTYs, actual
Windows execution, full CI or the separately required security sitting. Report
SHA-256 values, in table order, are
`e61f634eca969f2bf689d5764781fa68d415ac2c929114b44204fa2b56b99c6a`,
`1720af1abf90314aecafda914c3b433070e838e349eebdd73f2b684c5ac56367` and
`ad15f1da99581e2f569c0ee29895d0de452e4d298691bfd6da78c88bb8b0b9ec`.
Their independently checked coverage-ledger hashes are
`feda555fbc16596bb51b0f62f58585d98f7d3764ae033eb4549bc9dcfddd3691`,
`1362e03eb660d1803d9e7711e59944d917d96aedecac790e1dac028b9e21652c` and
`6baf0efcd3594b4051cb655ed66b487ea3048ee345b96016054a298443afc579`.
Records remain local and Git-ignored.

**WNT-R8-1, Medium, independently corroborated.** The current one-shot command
summary omitted infrastructure exit 9 and promised unconditional MCP reaping,
contradicting the implemented finite cleanup contract and the same canonical
file's detailed sections. The correction qualifies ordinary outcomes and links
[the one-shot contract](../../reference/cli/commands.md#relavium-agent-run) to
its sole failure/teardown authorities. It changes no product runtime policy and
introduces no ADR decision or universal descendant-containment claim.

**Fresh physical package evidence at the reviewed source.** Push CI
`38998232222`, attempt 1, records successful pack, all four installed consumers
and required aggregation at `09740575`. The root downloaded and SHA-checked all
five GitHub ZIPs, bounded their extraction, independently inspected every tar
member and reran strict receipt aggregation against observed job/source/origin
metadata. The native reviewer separately inspected those physical bytes and
receipts. The actual tarball is **445,642 bytes / 70 public files**, SHA-256
`f0c2d8abccaeed8df245bfb08c86da0faaf71d67e69bb68c678d91d452915b5b`.
Current Linux/macOS/Windows use Node 24.21.0; minimum Linux uses exact Node 22.0.0.
Each report binds eight installed cases and 177 bootstrap controls to that same
artifact. Root physical-audit SHA-256:
`7a0d38ff0cbd8904773b5d1fe0dd95790e3aab540080171953350025e91ca9e0`.
Inspection is not a new consumer execution or final-source acceptance.

**Separate Windows advisory remains failed.** Job `117295420447` in that run
passes the previously repaired DB/media suites but times out the first
coexistence case at its original **5,000 ms** bound (reported duration 10,452 ms).
The cross-process case passes. The remote log contains no identifying phase;
SQLite contention, WebAssembly startup and scheduler delay are not established
causes. No flake, waiver or retrospective pass is inferred.

A new independent ignored triage uses exact current source, actual file SQLite
and real `runCommand`. Six separately retained controls reproduce two fixture
gaps: setup before the cleanup scope leaks the first native connection on an
injected setup fault; Vitest timeout aborts its context but leaves the raw run
and both connections live. Explicit raw release/join permits the original run
assertions to pass after the timeout. Guarded setup closes the original handle
while retaining the same injected failure. A captured context-abort bridge to
shipping cooperative stop prevents engine entry, retains the failed timeout,
returns actual run 1 with no events and joins both closes. These local causal
facts do not explain the remote delay. The original source/probe/config/log
bytes are independently hash-verified; triage report/manifest SHA-256 values are
`11c31edbda2e3aadbd37550603ffb215ffa673644d9b3dd8d1d8a22fc0b1c124` /
`62bec05ae9782f5cc74280438003c7b3111eca01ebb108930e0e9becff9ca722`.
One preliminary duplicate baseline is explicitly excluded from the six controls.

The author correction retains the raw case before entry and awaits it from
runner `afterEach`. Exact SQLite close capabilities are captured before factory
setup; migration and the second open remain within cleanup ownership. The test
context abort reaches the original cooperative run stop; rejection of one writer
still joins both actual writers before either native close. Fixed bounded phase
timings contain no path, transcript or raw failure text. Three permanent controls
pin actual setup cleanup, a held real build's cancellation/late settlement and
preservation of the original fault alongside a native cleanup failure. The
unchanged normal run, NDJSON, transcript and cross-process assertions remain.
Neither case/readiness bounds nor workload scheduling are extended. No speculative
WebAssembly warmup or serialization change is applied. Author gates and fresh
final-source Windows evidence are required; the initiating remote delay remains
unclassified.

Two NEW complete cumulative clean rounds after the last material correction, a
NEW separate clean security sitting and fresh full CI plus all four actual
same-artifact platforms remain required. Historical R1–R8 and failed CI results
keep their source scopes. No Step 8d, whole Step 8 or later-step acceptance is
inferred. No user decision, ADR approval, credential, billing, provider capture,
production recipient or release upload is pending. Work continues automatically.


**Final author gates for the R8 correction.** All seventeen workspace lint/typecheck
tasks pass (fifteen cached); all eleven workspace test tasks pass (ten cached).
The fresh CLI run records **335 files / 5,416 passes / ten established local skips**.
Final build/format has seven successful tasks (five cached). Seam/engine-dependency
fences, 714-file isolation/ownership, 25-output/407-input/17-external compiled
closure, 177 bootstrap controls and compiled CLI smoke pass. No runtime source,
manifest, lockfile, tool or ADR body changes in this correction. A mistaken
nonexistent purity-script invocation and the initial test lint failure are retained
as invalid/failed attempts, then corrected before the final gates; neither is
counted as a pass.

The final test-source seal is
`503966adb470b0d32db8039a1b52c36579f503ae6df6251ea56d1cabd86564f1`;
its exact source bytes are independently checked unchanged after all gates. Two
selected author removals independently disable actual native close and cooperative
stop delivery in private byte copies. Each breaks its precise named semantic
assertion; neither setup/timeout/nonzero alone certifies removal. The complete
five-case fixed and byte-restored files pass. Filtered removal runs each execute
one case with four explicit selection skips, not a full-file acceptance. Final
causal-result SHA-256:
`34ef08c1aceb2dffeef8ceaaf8b183363563316ebf479581902f05f5ceeb8fe7`.
Initial copy-config over-selection and a rejected non-unique mutation anchor are
excluded from that causal matrix. These author controls do not replace independent
reviews or explain the remote Windows timeout. Fresh final-source CI/platforms,
two NEW clean cumulative rounds and a NEW clean security sitting remain required.

### Wave 3 Step 8d ninth cumulative review and caught-fault correction — 2026-10-17

**R9 is complete and NONCLEAN; Step 8d and whole Step 8 remain open.** The root
read all three new complete reports and independently recomputed every physical
file, full U0 diff and hunk from original Step 8 base `d9625ff0` to frozen
`40086e71`. Coverage is disjoint and complete: **293 paths / 1,588 hunks**.
Inventory SHA-256:
`2f5f938dca6c091169835b30dead1d8d5712c6ce37a08438f4af48a754548993`;
independently joined aggregate:
`bd36912c9c8ff457aa09c61a3a44cc3a8616930d8bd69862943a5826a23b0d1c`.

| Complete cumulative slice | Paths / hunks | Fresh execution, separately attributed | Verdict |
|---|---:|---|---|
| Session/terminal | 73 / 505 | 35 complete files / 697 passes; separate actual Home/onboarding probe / two passes, zero skips | NONCLEAN: ST-R9-1, High |
| Workflow/management | 134 / 818 | 68 complete files / 1,276 passes, one established host skip; independent eight-case probe has six precise failures and two positive passes | NONCLEAN: R9-WM-01, High |
| Native/tools/docs | 86 / 265 | 18 source files / 191 passes; 101 tooling passes; four independent signal probes, zero skips | NONCLEAN: WNT-R9-1, Medium |

Selections overlap; no combined deduplicated execution total is inferred. In
table order, report SHA-256 values are
`69efbdc45f67a337e529437c1c0f0cc233a4a04e6d3acd73c93e6e3d73e793ee`,
`371e07d09011adeaf07b11fc1c5b1be4f39123e4b0393d77b8f08c86258dbbca` and
`8d9fb2c8f4f3a1350984f37ce0d66cd2979532cb9d4ec077f4ae9d15de605b53`.
Checked coverage-ledger hashes are
`25b5eb65f629db004a268f0e88fe5d8ee6095aa42fd62fb526682935d9de975d`,
`a0511bc6f1ad4ddfdeccd5bf466510b605352d5d2857899ea055ed192f4b1373` and
`30bfc7da2c83dc8065a92d06d1be02662774108c2863836176674846bce1d9df`.
Records remain local and Git-ignored. Native evidence distinguishes fresh source
parents from existing-dist child fixtures. Failed reviewer setup attempts receive
no acceptance credit. Root replays have separate copies; reviewers regenerated
their final reports after an overwritten probe output path.

**ST-R9-1, High, independently reproduced.** The real Home default writer can
throw unexpectedly before its filesystem refusal adapter. Inline picker recovery
consumed the fault without notifying the original owner, permitting Home exit 0.
The owned callback now checks admission and observes failure before UI recovery.
Known typed config refusals remain inline; ownerless compatibility is preserved.
Onboarding already observes the same fault correctly and needs no runtime change.

**R9-WM-01, High, independently reproduced through shipping dispatch.** Passive
one-shot render faults were isolated by the event bus and reduced to warnings.
Failed rendering also prevented recording a turn error, changing failed-turn 1
into success 0. Captured writes now classify actual sink refusal and notify the
original surface owner. The subscriber records the turn error independently,
seals rendering before cancellation reentry and observes its exceptions before
bus isolation. Mandatory host ownership and admission checks prevent turn entry
after a start-render fault. Actual producer, usage, MCP and native database joins
still precede retirement. No workflow health is manufactured. The proof uses an
injected captured-sink refusal with actual dispatch/cassette/SQLite, not OS EPIPE.

**WNT-R9-1, Medium.** The canonical exit summary now distinguishes cooperative
first SIGINT from second SIGINT and terminating HUP/QUIT/TERM, linking existing
outcome precedence. No runtime signal policy changes.

**Permanent and causal evidence.** Thirteen new cases cover direct and shipping
dispatch, plain and JSON output, successful and failed turns, known Home config
refusal, unexpected actual-writer failure and a held host-close/database join.
Two complete current-source files pass **113 tests**, zero skips. The same tests
against a private immutable `40086e71` archive produce exactly **ten named semantic
failures / 103 passes**, zero skips. Both executions have owned runner completion
receipts with **zero unhandled errors**. No tracked runtime mutation, timeout,
import failure or mere nonzero exit certifies causal proof. Control artifact:
`cc4ee289b92054b526a4219f079033090955518a13ae23e4f51ebdd6a454836f`.
Fixture finally blocks join actual drives even when semantic assertions fail.
An initial test-only generic mock type error was corrected; an unsupported Python
extraction option was a preparation failure. Neither receives passing credit.

**Separately attributed reviewed-source platforms.** Push run `39000420576`,
attempt 1, passes pack, all four same-artifact consumers, required aggregation
and Windows advisory at `40086e71`. Root and native reviewer independently inspect
all five ZIPs, 70 public tar members and four bound receipts. Tarball: **445,642
bytes**, SHA-256
`3517a497fd5f1dca8d042cfefbc824b4fcb8394acb548e3d9b166f77ee28e283`;
physical audit:
`278d7aa1f8319b241b5767b9044de85b8673cd43c4f80563dbea7542e1d93e26`.
Actual Windows coexistence passes all five cases at the unchanged five-second
bound. These results precede the runtime corrections. The earlier `09740575`
timeout remains failed with exact cause unclassified; a later pass does not
explain it. Required broader CI retains its own observed status.

Two NEW complete cumulative clean rounds after the last material correction, a
NEW separate clean security sitting and fresh final-source full CI plus all four
actual same-artifact platforms remain required. R1–R9 retain NONCLEAN verdicts.
No Step 8d, whole Step 8, later-step or whole-wave acceptance is inferred. No user
decision, ADR approval, credential, billing, provider capture, production recipient
or release upload is pending. Implementation continues automatically.


**Final author gates for the R9 correction.** All seventeen workspace lint/typecheck
tasks pass (fifteen cached); all eleven workspace test tasks pass (ten cached).
The fresh CLI run records **335 files / 5,429 passes / ten established local skips**.
Build/format passes all seven tasks (six cached). Seam and engine-dependency
fences, 714-file isolation/ownership, 25-output/407-input/17-external compiled
closure, 177 bootstrap controls and compiled CLI smoke pass. Product/test source
and the canonical exit summary are sealed separately from append-only status
records; seal SHA-256:
`4ba3e9799c4f2382256425fdc2c83b1fb76c0befae899c5ca5662028d884aced`.
Source pins are checked unchanged after the gates. This does not replace the
required new independent reviews, separate security or final-source CI/platforms.


### Wave 3 Step 8d tenth cumulative review and original-owner corrections — 2026-10-17

**NONCLEAN; implementation corrections in progress.** Source `4c0fa5b7` has a
NEW complete cumulative review from base `d9625ff0`: all **293 physical paths /
1,600 full U0 hunks** independently rehashed and joined without overlap or omission.
Session/terminal: 73/509, NONCLEAN; workflow/management: 134/825, NONCLEAN;
native/tools/docs: 86/266, scoped CLEAN. The interrupted session sitting was
completed independently from retained captures plus fresh source review/execution;
no interrupted predecessor completion or earlier clean credit is inherited.
Root independently joined every physical file, full patch and hunk identity.
Aggregate SHA-256:
`e11fe25dbf8011952ebb5ebae4bb35cba82b4fe8a7dcbf1246cbfc5776b17a22`.
Detailed reports/ledgers remain local and Git-ignored.

| Confirmed finding | Correction and preservation |
| --- | --- |
| ST-R10-1 — passive Home/plain/JSON/Ink session consumers hide failures behind bus isolation | Observe through original owner before local recovery; seal before reentrant cancellation; classify captured business output and retain independent restoration capabilities |
| ST-R10-2 — export provenance catch also encloses native timestamp failure | Compute timestamp outside best-effort row write; preserve already-written scaffold and existing row-write warning policy |
| ST-R10-3 — native `/edit` setup failure becomes an inline editor outcome before owner observation | Observe concrete native creation/write before partial cleanup; preserve known errno/editor refusal and never-throws outcome compatibility; report partial-cleanup uncertainty |
| R10-WM-01 — gate/budget checkpoint native failure becomes invocation 2 | Preserve original cause; keep existing typed suspension corruption operational 1 with fixed history-inspection advice; unexpected native failure remains infrastructure 9 |

Fresh reviewer verification records 35 assigned session files / **699 passes**,
68 assigned workflow files / **1,287 passes and one established host skip**, and
20 native source files / **304 passes**, with **101 Node tests** separately.
Counts retain their own cohorts; overlap is not added into a unique whole-project
claim. Session probes freshly reproduce all three findings, seven cases across
four physical files with zero runner-unhandled errors. Workflow native checkpoint
controls have four precise expected9 failures / four passing known-history/missing-run
controls; valid-row fold controls separately characterize the old noncanonical
mapping. Root independently reproduces Home/plain/JSON/Ink, export, checkpoint and
native editor observations with owned zero-unhandled reporter receipts. These are
injected offline/native-boundary scenarios, not live provider or naturally observed
OS corruption claims.

**Separately attributed source platforms.** At `4c0fa5b7`, push run `39002571093`
passes pack, required package aggregation and all four same-artifact consumers.
Root and native reviewer independently inspect five ZIPs, 70 public tar members
and four bound receipts. Tarball: **445,764 bytes**, SHA-256
`6ff96978bf39cba43a817fa1f739ad5897355ccd2af6d3f800a0285c49968cb5`;
physical audit SHA-256:
`8d35a9f645dc3058da71baf8db56619e3aaa87631a860951c36038fcb0585130`.
Its Windows advisory fails the benign-alias filesystem case at its unchanged
5,000-ms bound (reported 5,418 ms; 322 passes / eighteen Windows skips). The remote
initiating phase/cause remains **unknown**. Broader required CI retains its actual
separate status; these platform passes precede the R10 corrections.

Separate isolated macOS/native-SQLite triage proves that runner timeout does not
join pending raw work, mutable fixture identity can affect late reads, and an actual
read fault bypasses an unguarded close. Eight unchanged original cases plus three
controls pass; two intentionally held original-bound timeout controls remain RED;
two real missing-table read controls pass. All fresh owned launchers/children join,
all source/dependency pins remain fixed, and no watchdog fires. This does not explain
or waive the remote Windows failure. The correction retains immutable case identity,
bridges runner abort to the original invocation, joins raw work before HOME/root
removal, and protects manual native reads/writes with `finally`. No timeout widening,
new skip, speculative warmup or serialization is introduced.

Author correction gates, permanent old-runtime causal checks, two NEW complete
cumulative clean rounds after the last material fix, a NEW separate clean security
sitting and fresh final-source full CI plus all four same-artifact consumers remain
required. R1–R10 retain NONCLEAN verdicts. No Step 8d, whole Step 8, later-step or
whole-wave acceptance is inferred. No new ADR, user decision, provider capture,
credential, billing, production recipient or release upload is pending.


**R10 correction author gates.** Workspace lint/typecheck/test passes all **23
tasks** (twenty cached); the fresh CLI cohort records **341 files / 5,475 passes /
ten established skips**. Build/format passes all seven tasks (five cached).
Seam and engine-dependency fences, tools typecheck, **720-file** isolation/ownership,
compiled **25-output / 408-input / 17-external** closure, **177** bootstrap controls
and compiled CLI smoke pass. No dependency-manifest change or core/LLM/DB/MCP/shared runtime
source delta is introduced. All 490 relative file targets in the five changed Markdown
homes resolve; mandatory managed Turbo headings and fenced examples are preserved.

Permanent controls execute twelve identical test files against an immutable
`4c0fa5b7` Git archive and the corrected source. Old runtime: **29 precise semantic
assertion failures / 228 passes**; corrected source: **261 passes**, including four
additional helper tests. Both owned runner receipts report zero unhandled errors;
actual execution sessions join. No tracked runtime is mutated for these controls.
The original no-collection dependency-link attempt receives no passing credit.
A final Prettier-only comment indentation change in one test is independently
verified to preserve the complete TypeScript executable-token sequence; the original
execution pins and explicit format-equivalence receipt remain local. Causal record
SHA-256: `baf2ada2043e876a911e73d5e19f253617c1194687004511d1eb2c5a6ec72e16`.

Material source/test/canonical-contract seal SHA-256: `bea2dbf25e58cf75ffa7f4421d1926f6b9f51fe5c7df4093e974c080cd23011f`.
Append-only status records are excluded from that seal to avoid a circular hash.
Initial test expectation/type/lint/format failures were corrected and retain their
failed attribution; only the successful final commands above receive credit.
These author gates do not replace two NEW complete cumulative clean rounds, the
NEW separate clean security sitting or fresh final-source full CI and all four
same-artifact consumers. Step 8d and whole Step 8 remain open.


### Wave 3 Step 8d eleventh cumulative review and advisory-owner corrections — 2026-10-17

**NONCLEAN; corrections committed at `d8e6b4d5`.** Three NEW independent sittings
review frozen `b9bc7118` cumulatively from `d9625ff0`: all **302 physical paths /
1,650 U0 hunks** are independently rehashed and joined without overlap or omission.
Session/terminal: 79/532; workflow/management: 136/834; native/tools/docs: 87/284.
All three verdicts are NONCLEAN. Root reads all reports, corroborates the runtime
findings, and independently verifies every physical/full-diff/hunk identity.
Aggregate SHA-256:
`9eb66529d81ceef58303f6971517b54742bd1794ebbb752322b1739f3dc2e8a3`.
Detailed reports and physical ledgers remain local and Git-ignored.

| Confirmed finding | Correction and preservation |
| --- | --- |
| ST-R11-1 — budget/unpriced notifications consume output/view faults before original-owner observation | Bind the synchronous notification family at shared runtime creation; observe its own original cause before governor/bus recovery and seal before cancellation reentry. Preserve healthy warnings, successful passive-error reporting, ownerless compatibility and original restoration capabilities |
| R11-WM-01 — missing local MCP consent wiring remains operational 1 despite the accepted infrastructure-9 inventory | Use existing fixed `cli_internal` at this exact pre-start guard. Preserve known consent/cancellation outcomes and actual workflow health priority; do not reinterpret `internal` globally |
| WNT-R11-1 — filesystem workspace declaration expects eight cases after two permanent controls were added | Refresh only the complete workload pin to ten; preserve named semantic assertions, exact inventory, runtime-error refusal and original bounds |
| WNT-R11-2 — command-export declaration and README still expect fifteen cases | Refresh to sixteen, preserving the new timestamp regression, full-file witness and restoration requirements |

Fresh assigned reviewer execution: session **40 files / 744 passes**, workflow
**70 files / 1,301 passes / one established platform skip**, native **19 files /
201 passes**, with a separate **16-pass** command-export file and **101 Node tests**.
Every reported cohort has zero runner-unhandled errors and actual joined execution;
overlapping checks are not added into a unique project total. The 61-file / 1,726-case
union is collection evidence for 151 declarations, not execution of that mutation
family. Only two workload count mismatches were found.

Actual owned chat-resume plain/JSON and Home controls reproduce hidden notification
faults with real SQLite and scripted offline providers. Effort, manual compaction
acknowledgement and installed Ink error controls retain their distinct successful
owner-observation evidence. The missing-consent guard refuses before spawn on both
actual lifetime routes, but originally selects the wrong classification. Shipping
callers currently supply consent; no CLI route to unconsented spawning is claimed.

**Permanent causal evidence.** Three identical new regression files execute against
the corrected source and an immutable `b9bc7118` Git archive. All **1,736 original
tracked blobs** in that archive are independently reverified; only the three new
test files are explicitly overlaid. Old runtime: **eight precise assertion failures /
eight passes**. Corrected runtime: **sixteen passes**, zero skips. Both actual sessions
join and owned reporter receipts record zero unhandled errors. The healthy pairs,
original cause, provider entry counts, durable replies, native DB close and zero
remaining owners are checked. Parent source aliases and shared installed dependencies
are explicit; no Windows, provider-call or operator-TTY evidence is inferred.
Causal record SHA-256:
`e55cf4054a155db9dd844d13f7854687742ac06ec49f9f0984a7a0c0dbb9ed40`.
Additional actual session-host reporter tests preserve successful passive reporting
while observing a failure in the reporter itself; helper tests pin cancellation
reentry, stopped entry and ownerless compatibility.

**Separately attributed platform evidence.** Reviewed-source push run `39006313132`
attempt 1 completes with **failure**. Both required causal families reject the stale
counts, and the main required job refuses their failed dependency. Coverage, wire,
usage, minimum-installable-Node and peer checks pass in their own scopes. Pack,
all four installed consumers and required package aggregation pass. Root and native
reviewer independently inspect five ZIPs, 70 public members and four bound receipts.
Tarball: **446,001 bytes**, SHA-256
`98e6b32548904d59588a14e28b478c8bc62d6c21761ef3e001e24275679a8e77`;
physical audit SHA-256:
`5af82c23fb67d39877e96705cdd73d9a794a479180c64c730a02c4d8f420f58c`.
The current-runtime legs report Node 24.21.0; the minimum consumer is exactly 22.0.0.
Package passes do not make full CI green.

The separate Windows advisory fails the benign-alias fixture at **5,108 ms** against
the unchanged **5,000-ms** bound (324 passes / eighteen established skips). Its
initiating phase/cause remains **unknown**, as do the earlier attributed failures.
Read-only source inspection and separately joined original/proposed native probes
prove that a manual fixture snapshot redundantly runs migration/checkpoint maintenance.
Both complete ten-case files pass locally with zero unhandled errors and all native
connections closed; benign-case connections change from four main/four lock to four
main/three lock. The private snapshot helper now uses the existing real SQLite/store
read with `finally` close. Default fresh/resume openers and all semantic assertions
remain intact. The actual missing-table control still proves native close on read
failure. Bounded fixed-label/elapsed-number abort diagnostics record no paths, values
or raw causes and grant no cleanup acknowledgement. This removes demonstrated
unnecessary test work; it does not claim to explain or repair the remote timeout.
No warmup, serialization, skip or timeout increase is introduced.

**Correction author gates.** Final workspace lint/typecheck/test passes all **23
tasks** (twenty cached), with fresh CLI **344 files / 5,496 passes / ten established
skips**. Build/format passes seven tasks (five cached). Seam and engine-dependency
fences, tools typecheck, **723-file** isolation/ownership, compiled **25-output /
408-input / 17-external** closure, **177** bootstrap controls and compiled CLI smoke
pass. Initial test-only type/lint failures and a misspelled helper-command attempt
receive no passing credit; successful final commands are separately retained.
The fourteen material source/test/tool/contract files remain unchanged through these
gates. Material seal SHA-256:
`c6f121b7b035b5d166afc6d2428c724ab55ce19552945802ddbe13ab1fd195dd`.
Append-only status records are excluded to avoid a circular hash.

Complete filesystem/secrets causal republication, two NEW clean complete cumulative
rounds after the last material fix, a NEW separate clean security sitting and fresh
final-source full CI plus all four same-artifact consumers remain required. R1–R11
retain NONCLEAN verdicts. Step 8d, whole Step 8 and later increments remain open.
No new ADR, maintainer decision, key, billing, provider capture, production recipient
or release upload is pending. Implementation continues automatically.


### Wave 3 Step 8d twelfth cumulative review and cooperative-terminal correction — 2026-10-17

**R12 is complete and NONCLEAN; Step 8d and whole Step 8 remain open.** Three NEW
independent reviewers cover `d9625ff0a641197c6ed45968df99094a25db88d6` →
`518082b1d407fd8c23b0384e9ec150c05630b832`: 81/138/87 disjoint physical paths and
543/839/290 complete cumulative hunks, respectively. The root reads all three
reports and independently recomputes physical, full-diff and every hunk identity:
**306 paths / 1,672 hunks**, no gap or overlap. Inventory SHA-256 is
`7d30d6427380b5adbb8f6ffb577d34da3c08ea89e954917c74c074f93025e151`;
aggregate SHA-256 is `37cf2c88e988355ff33c18afed0f2a7e622ce3bfd859f40f0829c5de61f13953`.
All detailed reports remain local and Git-ignored.

| Group | New whole-file execution | Verdict / confirmed finding |
|---|---|---|
| Session / terminal | 42 TypeScript files / 757 passes / no skips or unhandled errors | NONCLEAN, High `ST-R12-1`: healthy owned JSON EOF, exit and cancel omit their sole real terminal |
| Workflow / management | 72 TypeScript files / 1,397 passes / one established Windows skip / no unhandled errors | NONCLEAN, High `R12-WM-01`: workflow pricing/effort callback faults become success or ordinary failure instead of original-owner infrastructure failure |
| Native / tooling / docs | 19 TypeScript files / 201 passes, eight Node suites / 101 passes, no skips or unhandled errors | Scoped CLEAN; no new finding; all 151 declaration anchors and collected workloads reconcile |

All reviewer runners actually join. Source aliases, existing-dist native child
imports, synthetic OS ports, intentionally held legacy test promises and absence
of a complete independent opening dependency inventory retain their explicit
report qualifications. Passing ordinary suites do not disprove the two precise
semantic reproductions or establish a separate security sitting.

**Confirmed corrections, `3d937244`.** Cooperative session cancellation publishes
the actual synchronous terminal before sealing output, observes the original
persister refusal, and stops the same work owner in all cases. Fatal registry stop
still seals first; stopped subscribers are never reopened. Held provider/accounting
work remains owed after the terminal. Workflow notification binding uses the same
passive-notification boundary as sessions, before core advisory recovery. Actual
workflow health and the original captured terminal-restoration capabilities remain
independent; the fixed [CLI contract](../../reference/cli/commands.md#cooperative-session-finalization-and-passive-notifications)
is canonical. No new ADR, code category, dependency or user decision is introduced.

Permanent source integration covers 22 JSON cases across fresh/resume, EOF, exit,
cancel, first cooperative SIGINT, ownerless compatibility and terminal-output
refusal; eight workflow cases pair healthy/faulted pricing and effort diagnostics
on fresh runs and actual SQLite gate resumes in both output modes. Five shared
notification cases preserve original argument identity, reentry sealing and actual
8/7/5/6 priority. Existing actual host/persister suites now also exercise cooperative
cancellation with a held producer and a refused terminal write. The old source is
an immutable archive (SHA-256
`e3995764a3e8f11c8054fc46df2022c00049e514523bbe5b39c4dc10da83e427`), with all
1,739 tracked blobs independently verified. The identical two new command suites
produce **24 precise assertion failures / six healthy positives / zero skips or
unhandled errors** against it. Later helper-only tests are not falsely claimed as
runnable against an absent old export. Fixed-candidate controls pass 65 cases in
five complete files; the existing eight-file sibling cohort passes 238 cases.
Regression-control receipt SHA-256 is
`db6a6e1691a1d6a8280f048e23c3852c6d44b2d5d9ccc93c7a13dd346c1461f9`.

**Native fixture and Windows qualification.** The old source's Windows advisory
job `117325099391` in run `39008265384` fails a different case:
`fs-invocation.test.ts` clear/reseat, **7,617 ms / original 5,000-ms bound**.
All ten workspace-admission cases, including the old benign-alias case, pass.
Neither the initiating phase nor raw-pending state is established: installed
Vitest can reject while the body is pending or after overlong synchronous work
settles. No historical Windows failure is retrospectively passed or explained.

Separate original and observer-only whole-file controls both pass 19 cases.
Instrumented controls retain real native calls: three main clients / three
migration passes / six close returns become three / two / five, with zero returned
main clients still open. A real missing-table read still propagates and closes
its exact native connection. This removes only redundant observer maintenance;
default product fresh/resume openers, all assertions and original time bounds
remain. The final clear/reseat fixture passes the original invocation into the
command, retains its raw operation and abort custody, refuses a later case while
prior work/owners remain live, and keeps its root/environment through actual
retirement. Its 32-entry fixed-label trace diagnoses progress without certifying
cleanup. A separate deliberately held local builder triggers the unchanged
five-second timeout: the root/HOME remain present with two owners before release,
then disappear only after the actual raw join and zero owners. That probe remains
an expected timeout, not a passing liveness test or remote-cause explanation.

**Completed historical causal republication at `518082b1`.** Both full families
actually join before any correction is applied. Root and an independent follow-up
auditor verify exact frozen source/declaration membership, named mutation
witnesses, source/evaluation/runtime/stdio bindings and complete physical trees:

| Family | Controls / phases | Physical files / bytes | Runner unhandled errors |
|---|---|---|---|
| Filesystem | 110 / 330 | 1,987 / 43,687,739 | 0 |
| Secrets | 41 / 123 | 745 / 27,883,106 | 0 |

All exports satisfy their unchanged 2,000-file / 64-MiB physical limits. Original
source pins join frozen Git blobs; dependency metadata does not retain dependency
bodies, deleted execution graphs are not recreated, and a missing opening physical
dependency inventory does not acquire an equality claim. Independent follow-up
receipt SHA-256 is
`f333751144d8dd2c153a3a094a2bbbf4dba7ee2593ad23a3595f554a7ccfb076`;
its separate seal is `41cad778a257b99d4f9ea7928516f43c0139ed94a2acbb547f5a9245bdc93bb5`.
Earlier sealed R12 reports are unchanged. These controls do not certify the later
correction source.

The same historical run's four installed consumers and aggregate pass. Root and
independent audit inspect five ZIPs, all 70 public tar members and four receipt
origins for tarball SHA-256
`e9c2feb13b887835e8a685c5ea2c6e6bd80605513669d52abcb4bae746df2381`
(**446,105 bytes**): current Linux/macOS/Windows Node 24.21.0 and minimum Linux
Node 22.0.0, each with 177 bootstrap controls and eight installed cases. This is
physical inspection of published execution, not another execution or full-CI
acceptance. Its Windows advisory retains the separate failed status above.

**Correction author gates.** Final `pnpm turbo run lint typecheck test` passes all
23 tasks (20 cached), including fresh **347 CLI files / 5,533 passes / ten established
skips**. Fences, engine-dependency and tooling type checks, 726-file isolation and
build pass; compiled closure remains 25 outputs / 409 inputs / 17 externals.
Untouched compiled bootstrap passes 177 controls on local Node 22.23.1/Darwin;
compiled workflow/MCP/budget smoke passes. The 13-file correction source seal SHA-256 is
`af282cfd6f2585737e4565cc0a842b810e38f6b1f777799c914737c9af19e4e8`.
These are author checks, not independent acceptance. R1–R12 retain NONCLEAN
verdicts. Two NEW complete cumulative CLEAN rounds after the last material fix,
a NEW separate clean security sitting and fresh full CI plus all four same-artifact
package consumers remain required. Steps 9–19 have not started; no credential,
provider capture, billing, production archive recipient or user decision is pending.

### Wave 3 Step 8d thirteenth cumulative review and checkpoint-notice correction — 2026-10-17

**R13 is complete and NONCLEAN; Step 8d and whole Step 8 remain open.** The
cumulative range is `d9625ff0a641197c6ed45968df99094a25db88d6` →
`c15aa3148b887b94bf9731ff4dc0027bbe71aac9`: **310 paths / 1,706 hunks**, with no
gap or overlap. Session/terminal covers 82/544; workflow/management 139/870;
native/tooling/docs 89/292. The workflow group explicitly attributes five complete
test bodies / 83 hunks to a fourth, named supplementary reviewer; the primary
personally reads the other 134 bodies / 787 hunks. This is one complete sitting,
not an extra clean round or borrowed execution. Root reads all four reports and
recomputes every physical/full-diff/hunk identity. Inventory SHA-256 is
`3b32cb00c4e0727f3a17fe35f0878045d33e92641e5437073c887146f9b59460`;
aggregate SHA-256 is `c0fc759b768fbd2920b3631e5ed5834df516e24e02043b6290a11b6879844166`.
Opening/closing freeze is identical across 1,743 tracked blobs, 21,165 physical
dependency files / 1,215 lexical symlinks and 466 existing dist files. Mutable
caches are excluded; symlinks are not followed. Detailed records remain local and
Git-ignored.

Fresh whole-file executions pass: session/terminal 43 files / 781 tests;
workflow/management 73 / 1,405 with one established Windows-only skip;
native/tooling 20 TypeScript files / 206 tests plus eight Node suites / 101 tests.
All actual launchers join, with zero reported unhandled errors. Source aliases,
existing-dist native children and synthetic IO/clock/Windows ports retain their
explicit report limits. These executions do not establish a separate security
sitting or final-source CI.

**Confirmed High `WM-R13-01`, corrected at `afb3b932`.** Default deferred-checkpoint
notices reacquire process IO, suppress acknowledged-write failure and lose pending
delivery custody. Independent reviewer and root probes each use real SQLite,
actual command/native coordination and synthetic native write outcomes: one
healthy positive / three precise assertion failures / zero unhandled errors.
The correction forwards the original captured IO and invocation through default
workflow/session/management factories. It observes synchronous failure before the
opener returns, observes asynchronous rejection on settlement and owns the actual
pending write independently of the successfully transferred DB connection. Native
close, a stop request or deadline never becomes a delivery acknowledgement.
Known workflow-health priority and ownerless best-effort compatibility remain;
the [CLI contract](../../reference/cli/commands.md#cooperative-session-finalization-and-passive-notifications)
is canonical. This is the approved Step 8d boundary, not Step 18 centralization or
a new ADR, dependency, public package seam or decision.

Permanent controls include real default factories and an actual management
command, held delivery after DB close, synchronous/asynchronous failures,
reentry, finite termination and existing workflow-health priority. The identical
22 regression cases produce precise AssertionErrors on an immutable `c15aa314`
archive while ten unchanged opener controls pass. The fixed candidate passes
632 tests in 22 whole files; actual child waits and zero run-end unhandled errors
are recorded. Native SQLite creation/migrations are real; only checkpoint
`deferred` disposition is forced. These are not observations of kernel EPIPE or
actual OS process exit. Candidate parent aliases do not claim to rewrite every
native child's existing-dist imports. Validation receipt SHA-256 is
`fffcd6398f9dbd8b3ca0edb64a3214fa9743c5b78e7541fc1ec38353505f0767`.

**Author gates on the applied correction:** `pnpm turbo run lint typecheck test`
passes all 23 tasks (20 cached), with fresh **349 CLI files / 5,566 passing tests /
ten established skips**. Build passes six tasks (five cached); format, fences,
engine dependencies, tooling typecheck and 728-file isolation pass. Compiled
closure is 25 outputs / 410 inputs / 17 externals. Untouched compiled bootstrap
passes 177 controls on local Node 22.23.1/Darwin, and compiled workflow/MCP/budget
smoke passes. These are author checks, not independent acceptance.

At the older reviewed source `c15aa314`, all four installed consumers and Windows
advisory pass in run `39010171558`; full CI is still in progress when recorded.
Root and an independent reviewer inspect five ZIPs, all 70 public tar members and
four receipt origins for tarball SHA-256
`23c8efff4dcd3155445e6827f6a9181b0402e29603168492731741c19f5cf7fc`
(446,233 bytes). Current Linux/macOS/Windows use Node 24.21.0; minimum Linux uses
22.0.0, each with 177 bootstrap controls and eight installed cases. This is
physical inspection of published execution, not another execution or acceptance
of the later correction. Earlier failed/cancelled CI and Windows jobs retain their
separate source attribution; no unknown initiating cause is invented.

R1–R13 remain NONCLEAN. Two NEW complete cumulative CLEAN rounds after the last
material correction, a NEW separate clean security sitting and fresh full CI plus
all four same-artifact consumers remain required. Steps 9–19 have not started;
no credential, billing, provider capture, production recipient or user decision is
pending.

### Wave 3 Step 8d fourteenth cumulative review and disclosure-retention corrections — 2026-10-17

**R14 is complete and NONCLEAN; Step 8d and whole Step 8 remain open.** The
cumulative range is `d9625ff0a641197c6ed45968df99094a25db88d6` →
`dcc23cfbf3aa497b5100e8353fdd58a9b92fbe9d`: **314 paths / 1,715 hunks** in six
disjoint groups. Seven named reviewers read their assigned complete current
production/test/support bodies and every cumulative/deleted hunk. The native
87-path group explicitly combines its 55-path primary and 32-path supplement;
neither borrows personal reading or execution, and the supplement is not an extra
round. Large normative/register files retain their changed-section/context
qualification. Root reads all seven reports and independently recomputes every
physical/full-diff/hunk identity. Inventory SHA-256 is
`492d5c7cd7f640e74b96c008d249e44036d6ab2d99fe7d8e7ceb7cfc42b20fc2`;
aggregate SHA-256 is `2f374a8c11700bfa4e8c9509e9b5a8ed51b5b24ca10b2981be51090162f48352`.
Opening/closing freezes are identical across 1,746 tracked blobs, 21,165 physical
dependency files, 1,215 lexical symlinks and 466 existing dist files. Detailed
records remain local and Git-ignored.

**Two High surface findings, corrected at `d6d2fbdd`.** `R14-CHAT-1` and
`R14-HOME-1` independently reproduce the same disclosure-recovery gap: raw notice
failure is recovered, and fallback stderr delivery can remain pending after the
session/database and invocation owners retire. The shared retention boundary now
observes actual publication/render/sink failure before advisory recovery and
retains entered delivery through the original session or workflow owner. Failed
disclosure keeps audit evidence; successful maintenance warnings remain best
effort. Safe committed one-shot cleanup remains permitted after stop. Ownerless
library compatibility and actual workflow-health priority remain unchanged.
Root additionally reproduces this warning gap through actual `run` and `gate`
commands; both shipping callers now retain the same original delivery ownership.
The [CLI contract](../../reference/cli/commands.md#cooperative-session-finalization-and-passive-notifications)
owns the behaviour. This needs no new ADR, dependency, public seam or decision.

Identical actual chat/run/gate regressions on an immutable `dcc23cfb` archive yield
**eight precise assertion failures / seven positive controls**; the corrected
source passes all fifteen. Real Home/reseat/SQLite controls add seven cases;
substituting only the exact frozen retention helper into that candidate graph
breaks its three output-fault assertions and preserves four controls. That is a
helper-removal control, not original-whole-source execution. Held successful
acknowledgements, no-publish renderers, recoverable disclosure-read refusal and
ownerless compatibility remain separately exercised. Providers, renderer ports,
exit clocks and sink faults are synthetic; SQLite and command/host execution are
real. Existing-dist native children and source-alias parents retain their limits.

**Two Medium findings are corrected.** `R14-MS-1` is fixed in the same CLI commit:
workspace fixture setup refuses an unretired predecessor before global mutation;
teardown shares its actual join, seals entry and restores only its captured
current fixture. Two new permanent controls pass, and the complete file passes
12/12. Real-runner original/corrected schedules retain the original five-second
test / ten-second hook bounds. Deliberate predecessor timeout/refusal remains
failed evidence; only the corrected later recovery passes. No historical Windows
initiating cause is inferred. `W3-8D-R14-TD-01` is corrected at `e218ba0e`: installed
worker diagnostics project a fixed private-detail label for all arbitrary error
text, retaining useful closed native/case facts and the unchanged raw private
report. The actual child-stderr → assertion → wrapper → projection regression and
nested-field controls fail on frozen code; all 31 focused fixed tests pass. The
five baseline failures include three changed label expectations, not five claimed
independent causal mechanisms. This is synthetic test-output custody, not an
observed production credential leak.

**Applied-source author gates pass.** `pnpm turbo run lint typecheck test` passes
23 tasks (20 cached); fresh CLI execution passes **352 files / 5,590 tests / ten
established skips**. A separate post-build complete CLI run confirms the same
counts and zero machine-reported unhandled errors, with the actual child joined.
All 549 acceptance-tool tests pass. Build passes six tasks (five cached); format,
fences, engine dependencies, tooling lint/typecheck and 731-file isolation pass.
Compiled closure remains 25 outputs / 410 inputs / 17 externals. Compiled bootstrap
passes 177 controls on local Darwin / Node 22.23.1, and workflow/MCP/budget CLI smoke
passes. Initial test-only typing/lint/format failures were corrected before these
final gates; no assertion or timeout was weakened. Author validation SHA-256 is
`d29ab254051d3c6fed7b1ee2de44c3858e6c0b3e9baefb51323896703d4f0e7c`.

At reviewed `dcc23cfb`, run `39012759605` has successful pack, all four required
same-artifact consumers, their aggregate and Windows advisory. Root and an
independent reviewer physically inspect five ZIPs, all 70 tar members and four
receipts: tarball SHA-256 `e7e72e016d90be0a4767aa05974e38963f5bbd277203a2b0926430982d223c2a`,
446,189 bytes, 177 bootstrap controls and eight installed cases per consumer.
Full CI is still in progress at the filesystem causal job when recorded. These
old-source results do not accept the later correction. The superseded `c15aa314`
run was cancelled before full CI finished; its existing platform successes and
all earlier failed Windows outcomes retain their original attribution.

R1–R14 remain NONCLEAN. Two NEW complete cumulative CLEAN rounds after the last
material fix, a NEW separate clean security sitting and fresh full CI plus all
four same-artifact consumers remain required. Steps 9–19 have not started. No
credential, provider capture, billing, production archive recipient or user
decision is pending; implementation continues automatically on `development`.

### Wave 3 Step 8d fifteenth cumulative review and Home doctor correction — 2026-10-17

**R15 is complete and NONCLEAN; Step 8d and whole Step 8 remain open.** Seven NEW
reviewers cover the complete cumulative `d9625ff0` → `eb5d61af` range: **318 paths /
1,737 hunks** across seven disjoint groups. Root reads every original report and
independently rehashes every physical body, full diff and hunk. Large normative,
register and generated files retain explicit changed-section/context qualifications.
Inventory SHA-256 is `26c345c208da564889ed53a5b03ab5fab06ff61236986080d3c13449e7fb49bf`;
aggregate SHA-256 is `6b61ce20970adb1967e10ee9ab502c1100680178796fa17ef383b4f601b031ad`.
Opening/closing freezes are identical across 1,749 tracked blobs, 21,165 physical
dependency files, 1,215 lexical symlinks and 466 existing dist files. Detailed
reports, the root reading receipt and all failed/corrected harness attempts remain
local and Git-ignored. Recognizing an explicitly qualified ledger field alias did
not rewrite any sealed report or relax personal reading requirements.

**High `R15-HOME-01` is corrected at `151abaf5`.** Bare Home's final `/doctor`
notification could throw into palette recovery, leave input admitted and exit 0.
The original Home invocation now observes common controller-notification failures
before that recovery and owns the complete entered report through formatting and
publication. Unexpected report/formatter/listener faults retain private original
causes and select infrastructure 9. Known check refusals stay inline; stale reports
cannot overwrite newer interaction, and ownerless compatibility remains intact.
The [canonical CLI contract](../../reference/cli/commands.md#cooperative-session-finalization-and-passive-notifications)
owns the behaviour. No new ADR, runtime dependency or public provider seam is needed.

Eight new permanent actual Home/SQLite cases pass. The identical new suite on an
immutable archive of all 1,749 reviewed blobs yields **five precise assertion
failures / three positive controls**: checking/final publication and formatting
faults wrongly exit 0, while held/late-rejected report work retires too early.
All eight pass on the correction. A separate limited author-side reviewer runs
six fresh signal/fatal reentry, stale-report and common-notification controls,
all passing with an explicit zero-unhandled receipt and actual child join. That
check is not a complete cumulative round or security sitting. Renderer, probe,
held-report and fault ports remain synthetic around real Home/ownership/SQLite;
no live provider, operator TTY or packaged-platform execution is inferred.

**Blocker `W3-8D-R15-TD-01` is corrected at `1ed15ab8`.** Two fixture-isolation
tests made the complete workspace workload 12, but its declaration still expected
10. Required CI correctly refused that drift. Only the exact declaration changes;
whole-file identity, named witnesses, error receipts, original bounds and byte-exact
restoration stay enforced. The applied-source selected control passes fixed 12/12,
breaks seven assertions on removal, and passes restored 12/12, with actual joined
children and zero runner-reported unhandled errors in all three phases. This
selected diagnostic run retains `complete: false`; it is not the entire family.
The immutable physical source manifest records precommit author bytes and is kept
separate from the reviewed predecessor's Git label. Independently collected 61
files / 1,728 cases identify only this one mismatch across all 151 filesystem and
secrets declarations. An inherited secrets README count is also corrected from
24 to the existing 25 serializer cases; it predates the cumulative base and is not
a new R15 finding or runtime change.

**Applied-source author gates pass.** `pnpm turbo run lint typecheck test` passes
23 tasks (20 cached): **353 CLI files / 5,598 passing tests / ten established skips**.
A separate post-build complete CLI run has the same counts, an explicit zero
unhandled-errors receipt and an actually joined launcher. All **549 acceptance-tool
tests** pass. Build passes six tasks (five cached); tools lint/typecheck, formatting,
fences, engine dependencies and 732-file isolation pass. Compiled closure stays
25 outputs / 410 inputs / 17 externals. Actual local Darwin / Node 22.23.1 compiled
bootstrap passes 177 controls; workflow/MCP/budget CLI smoke passes. No production
assertion or timeout is weakened. Initial isolated lint and reviewer-harness
mistakes retain failed evidence and are not counted as product failures or passes.

At reviewed `eb5d61af`, CI `39015097996` completes failure: the filesystem job
rejects 12 versus 10, and the required job rejects that failed dependency before
its test phases. This is one defect with a downstream gate consequence, not a
second observed CLI-test failure. The other thirteen jobs succeed. Root and an
independent reviewer physically inspect five ZIPs, all 70 public members and four
receipts for one 446,375-byte tarball, SHA-256
`54069bb0ddfe4dfe72bde0f711627cc915647fce970d748bb8b94c7f24d7ec8e`.
Current Linux/macOS/Windows and exact Node 22.0.0 consumers each record 177 bootstrap
controls and eight installed cases. These predecessor successes do not accept the
correction. The earlier `dcc23cfb` CI is cancelled by the superseding push; its
completed platform results retain that source, as do every earlier failed Windows
result and unknown initiating cause.

R1–R15 remain NONCLEAN. Two NEW complete cumulative CLEAN rounds after the last
material fix, a NEW separate clean security sitting and fresh full CI plus all
four same-artifact consumers remain required. Steps 9–19 have not started. No
credential, provider capture, billing, production archive recipient or user
decision is pending; implementation continues automatically on `development`.


### Wave 3 Step 8d sixteenth cumulative review and compaction-delivery correction — 2026-10-17

**R16 is complete and NONCLEAN; Step 8d and whole Step 8 remain open.** Seven NEW
reviewers personally cover the complete cumulative `d9625ff0` → `71a91042` range:
**319 paths / 1,744 hunks** in seven disjoint groups. Root reads every original
report and independently verifies every physical body, complete U0 diff and hunk.
Large normative/register/generated files retain their explicit changed-section
and surrounding-context qualifications. Inventory SHA-256 is
`5551022806d84ab5d4e08909ccbb64fbaa27949a0ed24bf4a6f48e0c1416a9a9`;
aggregate SHA-256 is
`95fd0fdc8fa34e96ff12657967adccbea894448fd33304b14027a8a8715e31c0`.
Opening and closing freezes match across 1,750 tracked blobs, 21,165 physical
dependency files, 1,215 lexical symlinks and 466 existing dist files. All seven
original reports, identities, actual runner joins, failed/corrected harness
attempts and the root reading receipt remain local and Git-ignored. This complete
round supplies no clean-round, security or whole-step acceptance.

**High `R16-C1` is corrected at `ea996d6c`.** Core intentionally races compaction's
interactive disclosure wait against operation cancellation. The shared CLI session
runtime previously forwarded the surface callback without retaining its original
publication/flush operation. Cancelling manual compaction could therefore return
exit 4, close the shared store and retire every owner while an acknowledged native
write remained pending; a later failed callback still left exit 4. Root independently
reproduces two precise cancellation failures and two positive controls through
actual chat, session construction, SQLite and production `acknowledgeWrite`, with
zero explicit runner-reported unhandled errors and an actual exit-1 launcher join.
The output callback schedule, provider, driver and lifecycle ports are controlled;
this is neither an operator-TTY nor naturally occurring OS-error measurement.

The shared runtime now captures the callback and original host once, reserves its
root before callback entry, and retains the exact returned Promise, normalizing
only a void result. Core's prompt cancellation and no-post-cancel-summary admission
remain unchanged. The entered publication or visible-render flush stays owed until
actual settlement, and its late failure reaches the original owner before passive
recovery. A full host stop refuses notices that never entered; operation abort
still permits another turn. Fresh/resumed/clear/reseat and Home share this boundary.
Absent callbacks and ownerless embeddings retain compatibility; one-shot execution
gains no sink or enabled after-turn compaction. The
[canonical CLI contract](../../reference/cli/commands.md#cooperative-session-finalization-and-passive-notifications)
owns the behaviour. No new ADR, dependency, error code or provider seam is needed.

Ten new permanent actual fresh/resumed chat cases cover cancellation × native
acknowledgement success/failure, plus a subsequent admitted and durably persisted
turn while the cancelled disclosure is held. They assert actual SQLite closure,
original owner retention, late output disposition and no resumed old-summary
request. All ten pass on the correction; the identical suite with only the shared
runtime restored to immutable reviewed bytes yields **six precise ownership
assertion failures / four positive controls**. Four complete focused files pass
**99 tests**, with explicit zero-unhandled receipts and actual joined launchers.
The archive contains all 1,750 independently Git-verified predecessor blobs;
separate plain source copies introduce no branch/worktree/index or shared-source
mutation. Initial author harness resolution, escaped-error expectation and fixture
SQL mistakes remain retained and are neither product findings nor passing evidence.

**Applied author gates pass.** Workspace lint/typecheck/test passes 23 tasks
(20 cached), including **354 CLI files / 5,608 passing tests / ten established
skips**. Build passes six tasks (five cached). A separate post-build complete CLI
run has the same counts, an explicit zero-unhandled receipt and actual launcher
exit 0. Tools typecheck, formatting, fences, engine dependency and DB-sync checks
pass. All 549 acceptance-tool tests pass. Test isolation collects 733 files with
its existing ownership probes intact.
Compiled closure verifies 25 outputs / 410 inputs / 17 externals; the untouched
local Darwin / Node 22.23.1 bootstrap passes 177 controls and compiled workflow,
MCP signal-cleanup and budget CLI smoke passes. Original bounds and assertions
remain intact. Author checks do not replace independent review or current required
platform acceptance.

At the original reviewed `71a91042`, current Linux/macOS/Windows and exact Node
22.0.0 consumers pass. Root and an independent reviewer separately inspect five
ZIPs and all 70 public members/receipts for the same 446,408-byte tarball, SHA-256
`cf80bd3aa00b42996bde53b56d9a59aae515fec48116b573d3d2cbbd68b22740`.
Each consumer records 177 bootstrap controls and eight installed cases. The Node
22.13 workspace floor, Windows advisory, wire, usage, secrets and coverage jobs
also pass; when R16 closes, the filesystem causal family and final required job
have not completed. Root independently inspects the 41-control / 123-phase secrets
archive, its 745 files / 26,909,694 bytes, source/runtime/stdio/evaluation receipts
and explicit zero-error results. These predecessor passes do not accept the new
correction or imply an unobserved final CI result. Every failed, superseded or
cancelled run retains its own source and initiating-cause qualification.

R1–R16 remain NONCLEAN. Two NEW complete cumulative CLEAN rounds after the last
material fix, a NEW separate clean security sitting and fresh full CI plus all four
same-artifact consumers remain required. Steps 9–19 have not started. No credential,
provider capture, billing, production archive recipient or user decision is pending;
implementation continues automatically on `development`.
