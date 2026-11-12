# Phase 2.6 — Conversational Authoring and the First-Class CLI

> Status: **In progress** — **2.6.F** (platform floor + full-screen TUI, PR #74) and **2.6.C** (reseat
> transcript-carry + `/cost`, PR #75) are ✅ **Done**, and **2.6.Q P1–P5** landed with PR #76 (2026-07-26).
> Joint Wave 2 prerequisites and corrections merged in PR #94 (2026-10-15); the [merge checkpoint](phase-2.5.5-hardening-and-remediation.md#wave-2-merge-checkpoint--2026-10-15) records their exact scope. Full M/N lifecycle and remaining workstreams stay open.
> **CLI MVP first (2026-11-04):** the MVP order in [../current.md](../current.md#next-work--the-cli-mvp) takes slices of
> 2.6.A/B/D/E/G/H/I/J/K/M/Q ahead of the rest of the phase; new MVP items are defined under
> [CLI MVP additions](#cli-mvp-additions--2026-11-04). The phase scope, exit criteria and milestones are unchanged.
> Live progress is canonical in [../current.md](../current.md); the rest of the phase follows. Depends on the Phase 2.5
> spine (the wired tool-environment and the per-tool approval / mode system), which is **complete** (M2.5-4,
> PR #69, 2026-07-08), so this phase is unblocked.
>
> **Rewritten 2026-07-08**, last revised **2026-07-09** (child-session orchestration split into
> **2.6.N / 2.6.O / 2.6.P** along a safety gradient; the artifact-directory two-root model + the
> `schema_version` 1.1 additive-migration decision finalized; UX polish, syntax highlighting, expanded
> locales, Home mockup — after the Phase-2.5 close), expanding the original authoring-and-parity scope
> into the phase that makes the CLI a **first-class, Home-centric product**. The rewrite folds three
> inputs: the maintainer's CLI-experience findings, a competitor research pass (opencode, Claude Code,
> Codex CLI, Gemini CLI, Temporal/`gh run`-class run tooling, Aider/Goose/Amp/Cursor/Copilot), and a
> line-by-line triage of [../deferred-tasks.md](../deferred-tasks.md) (the now-doable items are pulled in
> below, each mapped to a workstream). Workstreams **2.6.A–E keep their original identities** (they are
> referenced by ADR-0058/0059/0060 and the deferred-tasks doc); **2.6.F–P were added**
> (child-session orchestration moved from Phase 3 by maintainer decision 2026-07-08, then split N/O/P
> on 2026-07-09).
>
> **Note (2026-07-07):** **2.6.C**'s mid-session `/models` model **reseat shipped early in 2.5.G** (ADR-0059,
> PR #66, merged 2026-07-07); 2.6.C is retained for the residual per-model cost-breakdown read and as the
> cross-reference home.

> **Authority (until Phase 2.5.5 and Phase 2.6 close):** [`current.md`](../current.md) is canonical for
> live progress and execution order; the phase documents stay canonical for scope and acceptance. Ordering
> differences between the two are deliberate. `current.md` may override recommended ordering — it may **not**
> redefine a security boundary, a scope line, or a milestone acceptance criterion.

- **Related**: [../README.md](../README.md), [phase-2.5-cli-consolidation.md](phase-2.5-cli-consolidation.md), [phase-2-cli.md](phase-2-cli.md), [phase-3-desktop.md](phase-3-desktop.md), [phase-5-managed-inference.md](phase-5-managed-inference.md), [node-runtime-upgrade.md](node-runtime-upgrade.md), [../deferred-tasks.md](../deferred-tasks.md), [../../reference/cli/commands.md](../../reference/cli/commands.md), [../../reference/cli/home.md](../../reference/cli/home.md), [../../reference/cli/chat-session.md](../../reference/cli/chat-session.md), [../../reference/shared-core/built-in-tools.md](../../reference/shared-core/built-in-tools.md), [../../reference/contracts/config-spec.md](../../reference/contracts/config-spec.md), [../../reference/contracts/workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md), [../../reference/contracts/agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md), [../../decisions/README.md](../../decisions/README.md) (ADR-0058–0060 + the new ADRs below)

The second half of the consolidation work begun in
[phase-2.5-cli-consolidation.md](phase-2.5-cli-consolidation.md), now widened into the phase that finishes
the CLI as a product. It realizes the tagline — *"Start as an agent. Ship the workflow. Own every run."* —
**entirely inside the terminal**: a conversation authors a standards-valid workflow, agents spawn sub-agents
and invoke workflows for complex tasks, the Home starts and monitors runs, the run history is drillable to
per-node detail. Every management task (providers, models, MCP, settings, gates) is doable from the Home
without dropping to a shell subcommand. The chat renders syntax-highlighted code blocks; the CLI ships in
English and Turkish over an n-locale catalog. When this phase closes, `relavium` in a terminal is a first-class experience on par with the
best agentic CLIs — while keeping the postures they lack: OS-keychain-only secrets, a fail-closed approval
floor, and git-committable YAML artifacts.

## TL;DR

Phase 2.6 makes bare `relavium` a **full-screen, Home-centric** product. Key outcomes in 7 milestones:

- **Conversational authoring** — a free-text request produces a strict-valid `.relavium.yaml`,
  authored and run from the Home; `{{ctx.*}}` interpolation and `agent run --input` land.
- **Everything managed from the Home** — providers, MCP servers, agents, workflows, runs, and
  run-ops (budget/gate resume) with no shell subcommand required.
- **Drillable, attributed run history** — list → run → node drill-down with per-node model/agent/cost
  attribution, bounded tool traces, and cross-process live watch.
- **Competitor-toolbelt parity** — `edit_file`, `search_files`, `find_files`, `todo`, `ask_user`,
  working `web_search`, wired `invoke_agent`; syntax-highlighted code blocks in chat — each
  YAML-selectable and mode-gated.
- **Agent orchestration** — chat agents autonomously spawn sub-agents and invoke workflows for
  complex sub-tasks; workflows call workflows via `subworkflow` nodes; standardized I/O contracts;
  parent-child lineage tracking; auto-cleaned artifacts.
- **Settings, theming, localization** — `/settings` over the config-write contract; three built-in
  themes (default / high-contrast / colorblind-safe); i18n shipping **`en` + `tr`** with CI key-parity, the
  catalog architected for n locales (`es`, `fr`, `de` staged).
- **Onboarding v2** — two auth paths: BYOK (live) + Relavium-account stub (disabled, Phase 5).
- **17 workstreams** (2.6.A–Q), substrate-first: 2.6.F (full-screen TUI + Node 22 floor) runs first;
  agent orchestration is split by safety gradient into 2.6.N (safe mechanism) → 2.6.O (model-generated
  execution, own security review) + 2.6.P (`subworkflow` node + schema v1.1).

## Goal

Make the bare `relavium` invocation a **full-screen, Home-centric** surface from which the entire product
is used and managed; close the **tool-breadth gap** against competitor CLIs (edit, search, find, todo,
ask-user, working web search) under the existing governance floor; land **conversational authoring** on the
shared `@relavium/authoring` core; give runs a **three-level drill-down** (list → run → node) over durable,
attributed history; enable **agent orchestration** — chat agents spawning sub-agents, workflows invoking
workflows, standardized I/O, and on-the-fly agent generation; and ship **settings, theming, localization,
and syntax-highlighted rendering** — all without breaking the `--json` / CI / non-TTY contract
([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)) or any existing subcommand.

## Outcomes (Definition of Done)

- `relavium` on a TTY opens a **full-screen** (alternate-screen) Home with a scroll/auto-follow viewport;
  the inline renderer remains as an escape hatch; `--json` / `CI` / non-TTY behavior is byte-identical to
  today (regression-harness proven).
- **Everything is manageable from the Home**: provider + key CRUD, model picking, MCP server CRUD +
  status, settings (theme/language/preferences), workflow start/monitor/history with node-level
  drill-down, agent start (any catalog agent) + session resume, gate resolution (human **and** budget),
  and authoring (wizard + conversational). No routine task requires a shell subcommand; subcommands stay
  first-class for scripting/CI and are never removed.
- A `@relavium/authoring` package is the shared authoring core; a conversational request produces a
  strict-valid, catalog-validated `.relavium.yaml`, written only under approval, offered to run it in-place.
- The **toolbelt** reaches competitor breadth — `edit_file`, `search_files`, `find_files`, todo/plan,
  `ask_user`, an actually-working `web_search`, and `invoke_agent` (wired for chat) — each engine-pure,
  YAML-selectable, mode-gated, and rendered first-class (collapsible detail, diffs at the approval
  prompt, syntax-highlighted code blocks) behind a security-reviewed render contract.
- Session `{{ctx.*}}` interpolation lands (ADR-0060) and `agent run --input` is unblocked.
- Run history is **attributed and drillable**: per-node model/agent/cost durable, a bounded secret-free
  tool trace, gate-resolve TOCTOU closed at the store, crashed runs reconciled, cross-process runs
  watchable live at node granularity.
- The CLI speaks **`en` and `tr`** over an n-locale string catalog with CI key-parity (`es`, `fr`, `de`
  staged behind the same catalog, not shipped this phase), and ships a real theme system
  (default + high-contrast + colorblind-safe) with the color-free path staying legible.
- An agent in a chat session can **autonomously spawn sub-agents and invoke workflows** for complex
  sub-tasks, with standardized I/O contracts, parent-child lineage tracking, hierarchical cost
  attribution, and auto-cleaned temporary artifacts in `~/.relavium/artifacts/` — closing the
  largest deliberate parity gap. Workflows can invoke other workflows via `subworkflow` nodes.
- The onboarding wizard offers **two auth paths** — BYOK (live) and *Sign in with a Relavium account*
  (visible, disabled, honestly labeled as coming with managed inference) — behind an Accepted
  forward-design ADR.

## Scope

### In scope

The workstreams below: the authoring spine (2.6.A/B/D), the platform + full-screen TUI foundation (2.6.F),
the Home management surfaces (2.6.G/H/I/J/K), the experience arms (2.6.C residual, 2.6.E, 2.6.L, 2.6.M),
the **child-session and nested execution spine** (2.6.N foundation / 2.6.O generation + parallel /
2.6.P `subworkflow` node + schema v1.1),
and the deferred-tasks items each workstream absorbs (mapped in the
[pull-in table](#deferred-tasks-pulled-into-this-phase)).

### Explicitly out of scope (→ Phase 3 / later)

- The **`read_media` D12 cluster** (host `MediaReadAccess`, scope population, the result-shape contract)
  and `@`-mention of media files — the dedicated, security-reviewed follow-up stands.
- **Full-fidelity reseat tool-context** (the 1.X/1.Z persister/schema extension) — the reseat keeps its
  text-only-transcript notice.
- **File-snapshot undo** (opencode-style revert of a message *and its file changes*) — 2.6.E ships
  conversation-level `/rewind`/`/fork` only.
- **retry-from-node** ([ADR-0040](../../decisions/0040-node-retry-budget-above-the-chain.md) Part B — needs the
  run-attempt model). The 2.6.G run-detail browser must be designed so a later "retry from this node"
  action slots in without rework, but the engine work is Phase 3.
- The **workflow-run `egress`/`os` arms** stay unwired (the recorded 2.5.E design boundary:
  `build-engine.ts` wires `fs`+`process` only). Revisiting that boundary requires its own ADR — it is not
  quietly reopened here.
- A multi-pane dashboard (desktop canvas territory), `output_schema` deep JSON-Schema conformance (new
  validator dependency), the `plugin` ToolSource loader, and cursor pagination for the read commands
  (scale-gated). Tracked in [../deferred-tasks.md](../deferred-tasks.md).

### In-window maintenance obligations (not workstreams)

Two items from [deferred-tasks.md](../deferred-tasks.md) fall inside the likely phase window and should be
actioned during it (maintainer calls, not workstreams): the **OpenAI Sora 2 shutdown (2026-09-24)** —
retarget or disable the 1.AH A3 Sora adapter arm before the date — and **enabling the live-nightly
conformance lane** (CI provider keys), which also unblocks the deferred media-in conformance fixtures.
Both stay tracked in their canonical [deferred-tasks.md](../deferred-tasks.md) entries.

## Work breakdown

### 2.6.A — `@relavium/authoring` package promotion + catalog-aware pre-flight

Unchanged from the original plan. The authoring core exists in-tree (`apps/cli/src/authoring/authoring.ts`,
landed with 2.J) and is promoted to a shared `@relavium/authoring` package so desktop
([phase-3-desktop.md](phase-3-desktop.md)) and VS Code ([phase-4-vscode.md](phase-4-vscode.md)) can consume
the same core.

**Tasks:**

- Scaffold `packages/authoring` — pure TS, platform-free — and **extract-and-decouple** the existing core
  (it is **not** a free move: `CliError`, `discoverCatalog`, and `findProjectConfigDir` are `apps/cli`
  imports a package may not take — a forbidden `packages → apps` back-edge). Replace `CliError` with a
  platform-free typed error the CLI maps to exit codes at the boundary; keep catalog **discovery** and
  `findProjectConfigDir` CLI-side and pass the catalog **in**. Add an import-zone lint fence banning
  `packages/authoring → apps/cli`. Follow
  [.claude/skills/add-package/SKILL.md](../../../.claude/skills/add-package/SKILL.md).
- Expose a single `validateAuthoredWorkflow(yaml, catalog)` = `parseWorkflow` **+**
  `validateWorkflowWithCatalog`, and **back-port** it into `create`/`import`/`export` (today those are
  parse-only; only the run path catalog-validates), so `create` can never accept a model/modality the run
  path rejects. Confirmed as a live gap by the review — `create`/`import`/`export` still parse-only today.
  Also expose the agent-shaped sibling **`validateAuthoredAgent(yaml, catalog, parentGrants?)`** =
  `parseAgent` **+** model/catalog validation **+** tool-ID validity **+** a caller-supplied parent-grant
  clamp. The authoring *commands* do not need it (they author for a human to review), but **2.6.O's
  model-generated agents execute behind it** — parse success proves none of catalog compatibility, tool
  validity, or permission containment, and 2.6.O's clamp cannot live only at spawn if the artifact is
  persisted. Unit-test its reject paths.
  *(L · `apps/cli/src/authoring/`; #2)*
- **`nodeCatalogIssue` never resolves the agent's own model, only a node-level override** *(review
  finding, pre-existing bug in the function this workstream promotes):* `validate-catalog.ts`'s
  `nodeCatalogIssue` reads a node-level model *override* but never the resolved agent's own `model:`, so
  the catalog pre-flight is silently dead for the canonical, documented authoring pattern — declaring the
  model once on the `agents:` block. Fix early in this workstream, since the acceptance criterion
  ("`create`, `import` and `export` all run the same run-equivalent catalog pre-flight") depends on this
  function being correct.
  *(M · `packages/core/src/validate-catalog.ts`; #88)*
- **Run-path tool pre-flight for the unwired egress/os arms:** `build-engine.ts` always assembles the tool
  host at `profile: 'workflow-read-write'`, and `assemble.ts`'s `wireEgressOs` only wires
  `host.egress`/`host.os` when `profile === 'chat-read-write'` — so a workflow agent node granted
  `web_search`, `http_request`, `read_clipboard`, or `notify` is a permanent, by-design `tool_unavailable`
  on `relavium run`, with nothing validating the authored `tools:` grants against this before the run
  starts. Add a sibling check inside `validateAuthoredWorkflow`'s catalog pre-flight, and correct
  [`built-in-tools.md`](../../reference/shared-core/built-in-tools.md) /
  [`workflow-yaml-spec.md`](../../reference/contracts/workflow-yaml-spec.md), which currently document
  these tools as unconditionally available. Does **not** wire the arms themselves — that stays out of
  scope per the recorded 2.5.E design boundary (Phase 3+). **Ruled 2026-11-05 (maintainer, MVP-1):** the
  pre-flight refuses such a workflow before the run starts (exit `2`), naming the tool; MCP-discovered tools are
  exempt. Until MVP-6 back-ports `validateAuthoredWorkflow`, the check is `validateWorkflowToolArms`, beside
  `validateWorkflowWithCatalog`, and `relavium run` calls it before any key is read. **Landed 2026-11-05 (MVP-1
  1a)**; its limits ($ref grants, `mcp_call` without a server, resumes) are in
  [built-in-tools.md](../../reference/shared-core/built-in-tools.md#the-built-in-tools).
  *(M · `apps/cli/src/engine/build-engine.ts`, `apps/cli/src/engine/tool-host/assemble.ts`; #37, G29)*
- **Catalog-aware `max_tokens` pre-flight** *(manual-test finding 2026-07-11):* extend
  `validateWorkflowWithCatalog` so `create`/`import`/`export` reject-or-clamp a `max_tokens` that exceeds the
  target model's known **output ceiling** (`MODEL_PRICING[model].maxOutputTokens` today; the live-catalog
  `limit.output` once **2.6.Q** lands) — the authoring-surface complement to 2.6.Q's run-path clamp, since
  today `max_tokens` is validated
  only as a bare positive int and an over-ceiling value 400s opaquely at the wire. Leave an unknown-ceiling
  model (custom `base_url`) as pass-through. No new ADR (rides ADR-0058).
- Add direct unit tests for `detectAndParse` / `buildAuthored` — today only their command wrappers are
  tested — and for the new `validateAuthoredWorkflow` this workstream introduces (it does not exist yet;
  only its `validateWorkflowWithCatalog` half ships today). Confirmed by the review as a real coverage gap
  in the core this workstream extracts. *(M · `apps/cli/src/authoring/authoring.ts`; #6)*

**Acceptance:** `@relavium/authoring` builds and imports **only** `@relavium/core` + `@relavium/shared`
(lint-fence enforced); the CLI consumes it with `create`/`import`/`export` round-tripping **unchanged**
(regression-tested); **all three of `create`, `import` and `export`** run the same run-equivalent catalog
pre-flight (`validateAuthoredWorkflow`, defined in the task above) that `relavium run` uses, so no authoring
entrypoint can accept a **workflow** the run path would reject; the core is directly unit-tested. (All three
commands also accept `.agent.yaml` via `detectAndParse` → `parseAgent`; the authoring *commands* keep the
workflow-shaped pre-flight, but the package also exports the agent-shaped `validateAuthoredAgent`,
unit-tested on its reject paths — it is 2.6.O's execution gate, not a command-surface one.) **Required ADR:** [ADR-0058](../../decisions/0058-relavium-authoring-package-and-conversational-authoring.md)
(Proposed → Accepted when this workstream begins).

### 2.6.B — Conversational + wizard authoring in the Home

The original conversational-authoring workstream, plus the in-Home wizard surface and two absorbed
deferred items.

**Tasks:**

- **Conversational authoring** (unchanged): an authoring agent (an `--agent` profile or a `/author` mode)
  whose system prompt references a **product-side knowledge pack derived — never restated** — from
  [node-types.md](../../reference/shared-core/node-types.md),
  [workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md),
  [agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md) and the Zod schemas (one minimal
  example per node type; a no-duplication check gates acceptance; never under `.claude/` — the product
  agent does not read repo-development skills). Self-correct loop: model → YAML → `detectAndParse` /
  `validateAuthoredWorkflow` → field-named, secret-free error → model fixes. The artifact is written only
  under accept-edits/auto with the scope-tiered host, then the surface offers *"Run it now?"* — closing
  author → run on one screen.
- **In-Home authoring wizards**: bring `relavium create`'s wizard into the Home/chat palette (`/create` →
  an ink-native agent/workflow wizard over the same injectable prompter seam), so authoring starts from
  the Home, not only from a shell command.
- **Wizard TTY prompts don't normalize input** *(review finding):* `create-prompter.ts`'s free-text prompts
  return the typed value verbatim, so accidental leading/trailing whitespace reaches `CreateSpec`. Fix per
  field rather than blanket-trimming, in the same prompter seam this task brings into the Home's `/create`
  wizard. `gather()` collects `kind`, `name`, `provider`, `model`, `systemPrompt` and `tools`; the three
  free-text fields are:
  - **`model`** — the material case: trim, and **reject** a value still containing interior whitespace, since
    a model id is a single token. A trailing space breaks catalog lookup and currently 400s at the wire.
  - **`name`** — trim. It feeds both the display name and `toSlug()`.
  - **`systemPrompt`** — trim leading/trailing, preserve interior formatting so a multi-line prompt
    round-trips unchanged.

  Two guarantees already hold and must not be re-implemented: `required()` rejects whitespace-only input for
  every field, and `tools` is already trimmed per element. `toSlug()` also already normalizes whitespace
  (`my agent` → `my-agent`), so there is no slug prompt to police. Cover each policy with a prompter test,
  with interior whitespace in `model` and a multi-line `systemPrompt` as the boundary cases.
  *(S · `apps/cli/src/authoring/create-prompter.ts`; #5)*
- **`AgentParseError` reaches the chat surfaces** *(deferred pull-in)*: a malformed `.agent.yaml` on
  `chat --agent` / `agent run` currently collapses to a generic exit-1 internal error; resolve the design
  call (wrap into `CliError('invalid_invocation')` at `resolveChatAgent`, or teach the top-level renderer
  to render a typed `AgentParseError` as an exit-2 invocation fault), revise the pinned test deliberately,
  and relativize the echoed source path. The conversational self-correct loop depends on these diagnostics
  being visible.
- ~~**Import consent gate**~~ — **moved and re-scoped.** The consent half landed in **2.6.5 `CR-16`**
  ([ADR-0084](../../decisions/0084-consent-before-a-local-mcp-spawn.md)), and provenance turned out to be the
  wrong axis: a `git pull` changes a committed artifact with no import step, so the gate covers **every**
  stdio server on every path, not an imported one. The `npx` version/integrity pinning half stays open with
  its own scheduling in [deferred-tasks.md](../deferred-tasks.md). Nothing is owed here.
- **Discoverability of the UVP** (unchanged): the proactive, dismissible, config-opt-out *"turn this
  session into a workflow with `/export`"* hint.

**Acceptance:** a free-text request yields a strict-valid `.relavium.yaml` passing the same pre-flight as
`relavium run`; an invalid draft is corrected via the secret-free loop; files are written only with
approval; `/create` works from the Home; a malformed agent YAML surfaces its field-named, positioned
diagnostic on every surface; the untrusted-import consent gate holds; a security review of the write
surface + the secret-taint gate + the import gate passes. **Required ADR:** shared with 2.6.A (ADR-0058).

### 2.6.C — Mid-session model reseat — residual + transcript-carry fix — ✅ **Done (PR #75, merged 2026-07-13)**

> **Shipped early in 2.5.G** (ADR-0059, PR #66, 2026-07-07): the `/models` mid-chat reseat, per-message
> `modelId` attribution, and the context-loss notice. Retained for the residual below and as the
> cross-reference home.
>
> **Status:** ✅ **Done — merged to `main` 2026-07-13 (PR #75)**. Both tasks shipped, plus the residual that turned
> out to need its own ADR.
> The reseat now carries the rendered conversation (F1), with the switch marker landing beneath it; and `/cost` shows
> a per-model breakdown backed by a new durable `session_costs` table
> ([ADR-0070](../../decisions/0070-durable-per-model-session-cost-attribution.md) — the per-message `model_id` this
> ADR originally planned to derive it from **cannot** represent a turn whose tool loop billed two models). Two
> append-only notes were added to [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) (the
> limitation its own alt-screen default created) and [ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md)
> (the notice's new shape; and the perf harness it claimed existed, which did not — now delivered).

**Tasks:**

- **Preserve the on-screen transcript across a reseat** *(manual-test finding 2026-07-11, HIGH —
  near-hotfix, do not wait for M2.6-5).* A `/models` mid-session switch builds a **fresh view store seeded
  header-only**, so the prior conversation **vanishes** from the full-screen alt-screen viewport — which
  2.6.F made the default (`render-mode.ts` `DEFAULT_ALT_SCREEN = true`) and whose alt buffer has **no native
  scrollback** to fall back on, unlike the inline `<Static>` path (which is unaffected). The durable DB
  transcript and the switched model's context are **intact** — only the *rendered* scrollback is dropped, so
  it reads as catastrophic data loss on a headline feature. Fix: extend `SessionViewSeed`
  (`session-view-model.ts`) with an optional `transcript`, seed `initialSessionViewState` from it instead of
  the hardcoded `[]`, and thread the OLD store's rendered transcript
  (`old.store.getSnapshot().state.transcript`) through `deps.reseatChat` into the reseat store construction
  on **both** the Home (`drive-home.tsx`) and standalone (`chat.ts` `seedResumedWiring`) paths; append the
  switch notice **after** the carried transcript as an inline "model changed X → Y" marker (the maintainer's
  requested shape). Keep the inline `<Static>` path byte-identical. Regression test: the reseated store's
  initial transcript equals the prior turns followed by the notice (today the reseat tests assert only
  turn-count / cost / notice). Carried entries are already-sanitized rendered projections — no key/secret and
  no [ADR-0030](../../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)
  reasoning signature enters the store. **No new ADR** (store-construction fix under the Accepted ADR-0059).
- The per-model **cost breakdown** read (`/cost` gains a per-model section over the shipped attribution
  columns); verify the context-loss notice covers the whole `chat-resume` family.

**Acceptance:** a mid-session reseat keeps the full prior conversation **visible** in the alt-screen
viewport with an inline switch marker (regression-tested on both the Home and standalone paths); `/cost`
shows per-model spend for a reseated session; the notice is asserted on resume surfaces. **Required ADR:**
none (ADR-0059 is Accepted).

#### Implementation record (moved from current.md on 2026-11-04)

Driven by two maintainer manual-test findings. **F1:** a mid-session `/models` reseat **blanked the alt-screen
viewport** — the reseat builds a fresh view store, and on the full-screen renderer (the TTY default since 2.6.F, with
no native scrollback behind it) that store *is* the scrollback, so the whole conversation vanished the moment a user
switched models. The durable transcript and the new model's context were never at risk; the loss was the view. The
reseat now carries the rendered conversation, gated to full-screen (a seeded **inline** store would re-print the
conversation over the copy ink's `<Static>` already put in the terminal's scrollback), and the switch notice lands
**beneath** it as an inline `⇄ model changed <old> → <new>` marker, keeping ADR-0059's bound disclosure clause.

**`/cost`** now shows where the money went, behind a new
[ADR-0070](../../decisions/0070-durable-per-model-session-cost-attribution.md): a durable `session_costs` table with the
invariant **`SUM(rows) == agent_sessions.total_cost_microcents`**, true by construction. ADR-0059 had planned to
derive the breakdown from the per-message `model_id`, which **cannot work** — one row holds one model, but a turn
whose tool loop fails over bills two. Along the way it closed a **live bug**: `total_cost_microcents` was being SET
blindly by five writers, so two `chat-resume` processes could permanently corrupt a session's total. It now has a
single owner. `session_messages`' never-written token/cost columns were dropped rather than left as a second, wrong,
zero-valued source.

Four adversarial review rounds ran over the work and each found something real — including that a tripwire I shipped
was **armed in production** and **swallowed by ink** (so it could never fail), that a perf harness measured a
**pointer assignment** while its ADR note claimed it verified an O(n) bound, and that the `/cost` DB read — the
step's central change — had **zero test coverage** at any layer. All folded, each with a break-verified regression.

**Open obligations carried out of 2.6.C:**

- **`chat-resume` opens on an empty viewport** — it has never repainted prior turns, in any mode or version (nothing
  projects `session_messages` into rendered entries). Not a 2.6.F regression; tracked in
  [deferred-tasks.md](../deferred-tasks.md).
- **Reported spend is a systematic under-estimate of the provider's invoice** — an egress that streamed content but
  ended without a usage chunk, and a mid-stream failure, are recorded as 0 on *both* sides of the invariant. That is
  a usage-capture gap in the seam, filed against **2.6.Q** (ADR-0070 §3) as its
  [usage-capture item](#26q--dynamic-model-catalog-enrichment-modelsdev-per-model-capability-matrix--pricing-long-tail---p1p5-landed-pr-76-2026-07-26-p6-and-the-settings--models-toggle-open).
- **Cross-turn tool-call memory** — a "the reseat forgets tool calls" report turned out to be an *engine* property,
  not a reseat one: tool pairs never cross **any** turn boundary (ADR-0062 §6). Deferred behind a default-off toggle,
  but **three already-live bugs gate it** (no pre-egress context-window check; overflow is a fatal, non-retryable
  `bad_request`; the budget gate prices only output tokens) — see [deferred-tasks.md](../deferred-tasks.md).
- **The CLI e2e suite migrates the developer's real `~/.relavium/history.db`** — verified, and it is what let a
  broken migration reach real data while staying invisible to CI. Tracked in [deferred-tasks.md](../deferred-tasks.md).

### 2.6.D — Session `{{ctx.*}}` prompt interpolation

Unchanged in intent; one absorbed deferred item makes the security mandate explicit.

**Tasks:** resolve `{{ctx.*}}` in the session system prompt per
[ADR-0060](../../decisions/0060-session-ctx-prompt-interpolation.md) — template substitution only, with the
**per-variable provenance/taint marker** on `SessionContext` (`--input`-derived values are untrusted by
provenance and never resolve in system position); unblock `agent run --input k=v`. *(Deferred pull-in:)*
land the **parse-time gate on system-bound fields** — when trusted `{{inputs}}`/`{{ctx}}` are admitted into
system positions, untrusted `run.outputs`/`read_file` references there are rejected at parse (the analyze/
collect gate), preserving the existing secret-taint protection.

**Acceptance:** `{{ctx.*}}` resolves in a session prompt with the taint rule enforced and tested;
`agent run --input` is accepted and reaches the prompt; the ADR-0060 mandatory security review passes.
**Required ADR:** ADR-0060 (Proposed → Accepted).

### 2.6.E — Chat & input parity polish

The competitor-parity chat ergonomics (the theme system moved to 2.6.L; tool-call rendering moved to
2.6.M). Everything here is TTY-interactive-only; the non-interactive contract is untouched.

**Tasks:**

- **Markdown + code-block rendering + syntax highlighting** in the transcript: a minimal in-house
  markdown renderer (code fences, inline code, bold/italic, headings, lists, blockquotes) with
  **`ink-syntax-highlight`** for first-class syntax highlighting in code blocks. `ink-syntax-highlight`
  is a thin ink-native wrapper around `highlight.js` + `cli-highlight` — it outputs native ink
  `<Text color>` elements (integrates with the 2.6.L theme system), supports 190+ languages with
  automatic detection, and tree-shakes to specific languages for bundle control. This requires a
  dedicated ADR (new dependency — `highlight.js` + `cli-highlight`; evaluated over the in-house
  alternative on breadth, maintenance burden, and bundle impact), a catalog entry in
  `pnpm-workspace.yaml`, and a tree-shaken language set (a curated default set for the built-in
  agent; additional languages load on demand). The
  markdown-to-ink component maps rendered nodes to ink's `<Text>` / `<Box>` primitives under the
  existing `stripTerminalControls` sanitization floor.
- **Advanced `@`-injection**: glob / directory expansion respecting ignore files (the ADR-0061 follow-up;
  the in-house matcher from the 2.5 close is the substrate).
- **`/rewind` + `/fork`** at conversation level: rewind truncates to a chosen prior message and continues
  (via the `/clear`-style host-swap + `reconstructSessionState` machinery); fork branches a session into a
  new `sessionId` preserving the original. File-change revert is explicitly out (see out-of-scope).
  **Analysis gate:** the interaction with child sessions must be decided during implementation —
  (a) `/rewind` past a point where sub-agents were spawned: are in-flight children cancelled? are
  completed children's results retained in the truncated transcript? (b) `/fork` of a session that
  spawned children: does the fork include the child lineage or start clean? The answer affects the
  `reconstructSessionState` machinery and the parent-child DB model; a dedicated design spike during
  2.6.E implementation will resolve both cases before the feature lands.
- **Type-ahead message queue**: messages typed while a turn runs are queued (navigate/edit the queue), sent
  on turn end — with a steer-now affordance considered (send-as-interrupt).
- **Input history search**: `Ctrl+R` reverse search over per-project prompt history.
- **`$EDITOR` compose** (`Ctrl+G`): edit the pending prompt in the external editor.
- **`/copy`**: copy the last assistant reply to the system clipboard. Additionally,
  **copy-on-select**: text selected with the mouse in the terminal copies to the clipboard
  automatically when the terminal supports it; no explicit command needed. The `/copy` command
  remains for keyboard-only workflows and terminals without clipboard support.
- **`/help` v2**: a full-screen, sectioned help screen (commands, keybindings, modes) replacing the flat
  text list, once 2.6.F's renderer lands. Supplemented by a **quick-reference cheat sheet** overlay
  (`Ctrl+O` or `?` — a half-screen modal summarizing current-context keybindings: the mode-aware
  approval keys, the browser nav keys, the chat input keys — dismissible with any key). The footer
  hint-bar remains the primary discoverability surface; the cheat sheet is the deliberate-lookup
  companion.
- **Transcript search** (`Ctrl+F` / `/find`): incremental text search within the visible chat
  transcript — type to jump to the first matching assistant turn, Enter for next match, Esc to
  dismiss. Scoped to the loaded transcript viewport (not a DB query); a full-history search is
  deferred (scale-gated, needs the transcript-index follow-up).

**Acceptance:** each affordance works in chat and the in-Home chat; `--json`/plain surfaces reject or
ignore them exactly as the ADR-0049 contract requires; the message queue and rewind have reducer-level
tests. **Required ADR:** `ink-syntax-highlight` dependency + markdown rendering architecture.

### 2.6.F — Platform floor + the full-screen TUI foundation — ✅ **Done (PR #74, 2026-07-11)**

> **Status:** ✅ **Done (PR #74, 2026-07-11)** — merged to `main` behind
> [ADR-0067](../../decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md) (Node `>=22` floor,
> `better-sqlite3` re-affirmed), [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md)
> (ink 7 + the hand-built alt-screen renderer + the `ink-testing-library` harness) and
> [ADR-0069](../../decisions/0069-string-width-for-the-cli-renderer.md) (`string-width`, Accepted on the merge).
> The shipped inventory (incl. the `✓ Copied` copy-on-select toast), the two adversarial review rounds, and the
> open obligations carried out (short-terminal Home overflow → 2.6.G; `relavium run` stays inline; themes → 2.6.L)
> are in the implementation record at the end of this section, moved from current.md on 2026-11-04. Its release
> clause (v0.2.0) is still open: it lands with the CLI MVP's MVP-10 ([current.md](../current.md#next-work--the-cli-mvp)).

The substrate workstream — it runs **first** because the browsers (2.6.G), settings screens (2.6.L), and
render-v2 (2.6.M) all build on it.

**Tasks:**

- **Node dev/CI bump now**: `.nvmrc` 22 → 24 (Active LTS) — one line, non-breaking, no ADR.
- **Supported-floor decision** *(maintainer decision, recommended: take it early in-phase)*: raise the
  published floor 20.12 → `>=22` — a breaking release for `relavium` (pre-1.0 → a 0.x MINOR bump, e.g. `0.2.0`, per [ADR-0067](../../decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md)) that restores `better-sqlite3` prebuild
  coverage (Node 20 is EOL) and unlocks ink 7 / `node:sqlite` / eslint 10 / vitest 5. Full analysis:
  [node-runtime-upgrade.md](node-runtime-upgrade.md). This **supersedes
  [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md)** → its own governed PR behind a
  superseding ADR. Ink 7 is evaluated in the same governed PR but adopted only if the floor is raised to
  `>=22`; otherwise the renderer ships on the current ink major.
- **Full-screen renderer**: an alternate-screen (DECSET 1049) mode for the Home + chat with a real
  viewport — scrollback inside the app (PgUp/PgDn, wheel where supported), **auto-follow** that pauses when
  the user scrolls up and resumes at bottom, and the input pinned to the bottom row. This structurally
  fixes the current bug where long responses clip/truncate content beyond the terminal height — scrolling
  up must reveal the full response from the beginning without top-truncation. The inline (scrollback)
  renderer is **retained** and byte-identical for non-TTY/CI; an explicit escape hatch (`--no-alt-screen`
  or a config key) keeps the inline mode available on a TTY. If the full-screen renderer is deferred or
  the inline mode is active, a separate inline-viewport fix must backfill the scrollback-preservation
  behavior for long responses so that content above the visible area is never lost. Renderer choice is
  orthogonal to session state (switching relaunches the view in place, conversation intact). The run TUI's
  persistent plain-text exit summary is preserved on unmount.
- **Branded Home banner** — ✅ **shipped in 2.6.F Step 5g**. `show_banner` is spec'd in
  [config-spec.md](../../reference/contracts/config-spec.md) and its behaviour in
  [home.md](../../reference/cli/home.md); this entry does not restate them. Two deviations from the plan
  above, recorded in [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md)'s dated
  amendments: the **"first five Home opens"** counter became an **empty-Home** trigger (a durable counter
  would need a `history.db` migration or a `config.toml` auto-write per open — the wrong trade for a
  cosmetic element), and **themes** moved to **2.6.L**, so 5g ships colour + `NO_COLOR` only.
- **TUI component test harness** *(deferred pull-in)*: the first CLI component-render harness (a new
  devDependency — part of this workstream's ADR), so render-cadence bugs (the 2.5.H frozen-clock class)
  get regression tests; add performance regression thresholds (frame time / render count) for the
  full-screen frame loop.
- Resize/degrade behavior and the documented screen-reader constraint (raw-mode TUI) with the non-TTY
  fallback — carried from the original 2.6.E and owned here. The full-screen alternate-screen mode
  (DECSET 1049) is inherently inaccessible to screen readers; the **`--no-alt-screen`** escape hatch
  and the config key `[preferences].alt_screen` provide an explicit path back to the inline renderer
  where the terminal emulator's own accessibility support applies. A dedicated accessibility note in
  the user-facing docs will document this trade-off and the escape hatch.

**Acceptance:** bare `relavium` on a TTY opens the full-screen Home; scroll + auto-follow work; the
`--json` / CI / non-TTY paths are byte-identical to today (harness-proven); the floor-bump ADR is Accepted
and released as a breaking 0.x MINOR bump (e.g. `0.2.0`, per ADR-0067) with migration notes; the component harness runs in CI with at least the
frozen-clock regression pinned. **Required ADRs:** the ADR-0021-superseding floor ADR + a full-screen
renderer & TUI-harness ADR.

#### Implementation record (moved from current.md on 2026-11-04)

The first 2.6 workstream. Behind [ADR-0067](../../decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md)
(Node `>=22` published floor, `>=22.13.0` dev-install floor; `better-sqlite3` re-affirmed),
[ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) (`ink` 7 + a hand-built alternate-screen
renderer + the `ink-testing-library` harness), and
[ADR-0069](../../decisions/0069-string-width-for-the-cli-renderer.md) (`string-width` for display width — **Accepted**
on the PR #74 merge, the CLAUDE.md rule-2 approval it gated).

Shipped: `ink` 6→7 and the component-render harness; the alt-screen lifecycle with restore nets on every
termination path; a hand-built transcript **viewport** (grapheme-aware wrapping, windowing, scroll + auto-follow, a
per-entry wrap cache) and the inter-session alt-buffer **hoist**; the **`/scrollback`**, **`/edit`** and **`/copy`**
copy-and-search hatches over a `suspendFullScreen` primitive; **in-app mouse text selection with copy-on-select over
OSC 52** on both surfaces, with edge auto-scroll, a frozen auto-follow and a transient **`✓ Copied` toast** so the
otherwise-silent copy is confirmed; `--no-mouse` /
`[preferences].{alt_screen,mouse,copy_on_select,show_banner}`; a branded Home banner; and DEC-2026 synchronized
output — which `ink` 7 turned out to already emit, so the step **pins** it rather than building the planned
`stdout` Proxy.

The full-screen renderer is now the **default on a TTY**; `--no-alt-screen` and a machine / non-TTY / `--json` / CI
path stay on the byte-identical inline renderer.

Two adversarial review rounds (one per step, one over the whole phase) drove the last third of the work. The
whole-phase round found that **the caps-lift ADR-0068 exists to deliver was never implemented** — a name collision
with the Step-4b-3 wrap cache — so a >4000-character answer was still clipped in the very viewport built to scroll
it; that `displayWidth` under-counted 8 539 code points against `ink`'s own width function; and that a keyboard
Ctrl-C during a Home hatch stranded mouse reporting on the user's shell. All folded, each with a break-verified
regression test.

**Open obligations carried out of 2.6.F:**

- **The Home landing can overflow a short terminal** — a populated "Attention required" section pushes the top off,
  and the alt buffer has no scrollback to recover it. Predates 2.6.F (the strip is 2.5.B); **2.6.G**'s management
  browsers replace the strip wholesale, which is the right place to fix it.
- **`relavium run`'s TUI stays inline** (a deliberate 2.6.F scope cut); its retained-scrollable-history is tracked.
- **Themes** (beyond colour / `NO_COLOR`) are deferred to **2.6.L**, per the maintainer's Step-5 decision.
- Real-TTY signal paths (double-Ctrl-C, `kill -TERM`/`-HUP`/`-QUIT`, a hatch under `tmux`) remain a **manual PR-time
  check** — the unit tests pin the orchestration around injected seams, not the kernel.

### 2.6.G — Home management browsers: workflows, runs, agents

The interactive browsers that make the Home the management center. The interaction model follows the
proven three-level drill-down (list → detail → step detail) with `gh run`-style progressive disclosure
(every screen hints the next action) and picker-on-omitted-id semantics. The maintainer's separate-command
sketch (`/active-workflows`, `/workflow-run-history`, …) is **deliberately simplified** into two tabbed
browsers with argument deep-links — same reach, fewer commands.

The post-2.6 full-screen Home renders with the branded banner, the management strip, and the chat prompt
in a single viewport:

```text
╔══════════════════════════════════════════════════════════════╗
║  relavium                                v0.2.0 · en · ask  ║  ← banner (dismissed after 5 opens)
╚══════════════════════════════════════════════════════════════╝

  /workflows  /agents  /providers  /mcp  /settings  /permissions   ← tab bar (^T / click)

  ═══ Defined ─── Active ─── History ────────────────────────────
  ▶ deploy · last run 3h ago · ✓ completed                [Run] [Export]
    code-review · last run 1d ago · ✗ failed — Node 3     [Run] [Detach]
    nightly-build · invalid — unknown model "claude-5"          [Fix]

  ⭐ Pinned ─────────────────────────────────────────────────────
  ★ deploy · completed 3h ago · $0.04

  —————————————————————————————————————————————————————————————
  Enter drill-down · p pin · q Home · /filter · ↑↓ navigate
```

The **tab bar** provides one-key access to every management surface — `/workflows`, `/agents`,
`/providers`, `/mcp`, `/settings`, `/permissions`. `Ctrl+T` cycles tabs; each tab remembers its
last drill-down position.

> **Design note:** the ASCII mockup above illustrates the `/workflows` browser as a representative
> example. Every management tab (`/workflows`, `/agents`, `/providers`, `/mcp`, `/settings`,
> `/permissions`) will be designed with the same interaction model (drill-down navigation, breadcrumb
> header, loading states, pinned items where applicable) but with surface-specific content and
> actions. The exact visual design — layout, column widths, color assignments, status glyphs,
> action-button placement — will be developed during implementation through a multi-alternative
> evaluation (ASCII-art vs Unicode box-drawing, compact vs spacious, light vs dark, etc.) across
> the three built-in themes, with the chosen design applied uniformly to all tabs. The mockup
> above is a design *direction*, not a pixel-accurate spec.

**Tasks:**

- **`/workflows` browser** (Home + chat): tabs **Defined | Active | History**, deep-linkable as
  `/workflows [defined|active|history]`.
  - *Defined*: the disk catalog (slug, name, node count, last-run status/age; invalid files flagged) with
    actions — **Run** (foreground: graduate into the live run view), **Run detached** (print the runId,
    stay in Home), **Export**, reveal path. Starting a run from the Home is new — `run` stays shell-first
    for scripting, but the Home can now launch.
  - *Active*: live runs (status, current node, attempt, elapsed, cost) — including runs owned by **other
    processes** via a poll-based `run_events` tail (seq + WAL make this feasible today), disclosed as
    node-boundary granularity; a gate-/budget-blocked run shows the resolve affordance inline. Esc detaches
    without killing; cancel is offered with its cooperative semantics.
  - *History*: finished runs (status glyph, short id, workflow, relative start, duration, **cost** — the
    differentiator no competitor CLI lists) with keystroke filters (status/workflow) — no query DSL. Enter
    → **run detail**: header (status, timing, totals, entry point) + node table (per-node status, duration,
    attempt, tokens, cost) + a "jump to first failed node" key. Enter on a node → **node detail**: the
    input / output / duration / tokens / error quintet plus the bounded tool-trace and event timeline
    (Scheduled/Started/Completed triplets collapsed into one expandable row).
  - **Navigation**: Enter drills down (list → run detail → node detail); **Backspace** or **Esc**
    returns to the previous level; `q` returns to the Home strip from any level. The current
    level and parent breadcrumb are shown in the header row of every screen. The browser
    **preserves drill-down position** — returning from the Home to the browser restores the
    last-viewed screen rather than resetting to the top-level list.
  - **Loading states**: drill-down reads from `history.db` may encounter cold-cache latency;
    each navigation shows a bounded `Loading…` spinner (with Esc to cancel). A read that exceeds
    2s shows the elapsed time; a failed read surfaces a one-line error notice rather than a
    white screen.
  - **Bookmarking**: any run or workflow can be **pinned** from its detail screen (`p` key —
    persisted to `history.db`). Pinned items appear in a **⭐ Pinned** section at the top of the
    History tab, above the chronological list. Un-pin with `p` again. Pins survive across
    sessions.
- **`/agents` browser** (Home + chat): tabs **Defined | Sessions**. *Defined*: the agent catalog with
  **"start a chat with this agent"** (closing the Home's built-in-agent-only gap). *Sessions*: recent +
  in-progress sessions — Enter resumes **in place**, **with the prior transcript repainted** — the `session_messages` →
    `TranscriptEntry` projection into the 2.6.C view seed, including the policy for rows a `/compact`/`/trim`
    dropped and the decision on whether the inline renderer repaints too (the in-Home chat machinery), with a detail view
  (transcript summary, cost, model attribution). Child sessions spawned by a parent agent are shown
  **indented beneath their parent** with a `└─` tree-drawing prefix and the sub-agent's name; a
  collapsed parent hides its children (toggle with `Space`). A filter (`/sessions --roots`) shows
  only root (user-initiated) sessions, hiding children.
- **Actionable Home strip**: the Attention/Continue rows become focusable — a gate row opens an inline
  resolve card (approve / reject / input, via 2.6.K's shared resume core), a failed run opens its detail,
  a session row resumes, a run row opens detail. The strip refreshes on an idle tick while the Home is
  open (today it is snapshot-static).
- **Permission management** *(new — script execution + tool grants via slash commands)*: when an agent
  issues a `run_command` for a not-yet-allowlisted command (e.g. `python analyze.py`, `node build.js`,
  `curl -s https://...`), the interactive surface prompts the user with a typed, informative approval
  card — not a generic allow/deny, but one that names the exact command and offers three grant scopes:
  **(a) once** (this turn only), **(b) this session** (in-memory, gone on `/exit`), **(c) this project**
  (writes to `.relavium/project.toml` `[chat].allowed_commands` via the ADR-0063 config-write contract).
  A **global grant** (writes to `~/.relavium/config.toml`) is available via an explicit `/permissions`
  slash command in the Home and chat. The `/permissions` command opens a management screen listing all
  active grants (command allowlist, domain allowlist, MCP servers, egress endpoints) with add/remove
  actions — the single pane for the user to audit and revoke what an agent has been granted. A
  **`once`-granted** command is never persisted; a **session/project/global** grant writes the
  appropriate config layer atomically. An allowlist whose *only* entry is default-approved (like the
  curl/wget research item in 2.6.M) is surfaced here as a built-in grant that can be revoked.
- **Liveness**: wire `engine.reconcile()` (never invoked today) on Home open and the browser/status reads,
  so crashed runs settle `run:failed{internal}` instead of showing as zombie `running` rows; expired gates
  settle per their timeout policy via 2.6.K's re-arm. Confirmed live by the review — `engine.reconcile()`
  is tested in `packages/core` but called from nowhere in `apps/cli` today, so a killed/crashed run stays
  `'running'` forever. *(S · `packages/core/src/engine/engine.ts` (`reconcile`), `apps/cli`; #229)*
  **Wired 2026-11-05 (MVP-1 1b):** `run`, `gate` and `budget resume` call `engine.reconcile()` at start, and the
  Home calls it on open, before its first read of the runs; `status` stays read-only, and the browser reads come
  with the browsers. Wiring it exposed a second-terminal race (a reconcile between a run's `run:started` and its
  lease acquire), so the store now refuses a second terminal
  ([database-schema.md](../../reference/shared-core/database-schema.md#concurrency--transaction-behavior)).
  Expired gates settling through 2.6.K's re-arm remain open.
- Non-interactive parity: extend the read *commands* minimally (`relavium list --runs`, `status <runId>`
  for finished runs, `logs --follow/--failed`) so scripting keeps pace with the TUI —
  [ADR-0049](../../decisions/0049-cli-machine-output-contract.md)-conformant. **`list --runs` and `status <runId>`
  landed 2026-11-05 (MVP-1 1a)**; `logs --follow/--failed` remain open.
- **Detached-run notification**: when a run is started as "Run detached" from the Home and completes
  (or fails), surface a notification on the Home's next idle tick — an `Attention required` row with
  the outcome, linked to the run detail. For a chat that remains open with a detached run in the
  background, surface a one-line `notice` in the transcript on completion. This hooks into the
  existing `notify` tool's desktop-notification path only when the OS-native notifier is configured;
  the Home-side notice is the reliable default.

**Acceptance:** every action above works from the Home without a shell command; the three-level drill-down
is complete over 2.6.H's data; a run started in another terminal is watchable live at node granularity;
zombie runs reconcile; the browsers degrade at <80×24; the machine-output contract is untouched
(harness-proven). **Required ADR:** management browsers + run drill-down contract (shared with 2.6.H). A session resumed from the browser or `chat-resume` opens with its prior transcript **visible** (or the inline renderer's behaviour is documented as a deliberate difference), restores its agent/model identity and continues — asserted by extending the existing resume chain in `apps/cli/src/harness/session-chain.e2e.test.ts`, with a long-transcript and an alt-screen case.

### 2.6.H — Durable run detail: the history data layer

The store/engine half that 2.6.G's browsers read. Today the durable record is node-boundary-only and
unattributed (step rows never carry agent/model/input; `run_costs.modelId` is always NULL; the firehose is
never persisted; several consistency gaps are recorded in the deferred doc). This workstream makes the
durable record complete enough for a first-class drill-down — additively.

**Tasks:**

- **Step attribution**: populate `step_executions.agentId/agentSnapshot/modelId/inputJson` and
  `run_costs.modelId` from the events the engine already has — `run_costs.modelId` is a **shipped dead column**
  (never written), the workflow-side twin of the session-side gap [ADR-0070](../../decisions/0070-durable-per-model-session-cost-attribution.md)
  closes; that ADR deliberately leaves it here rather than widening its own scope; give `node:skipped` a step row (thread
  `nodeType` additively); widen the `StepRecord` projection (output/error/tokens) + a step-detail read.
- **Exact per-node cost**: an optional `nodeCostMicrocents` on `node:completed` — an additive run-event
  schema field amending [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)
  append-only (optional for backward-compat with existing `--json` consumers; when present, the per-node
  cost is exact, not a cumulative-delta approximation) — so parallel fan-out attributes exactly instead of
  via cumulative deltas; carry final totals on `run:failed` / `run:cancelled` (closing the documented
  undercount). Confirmed independently by two review rounds: today `runs.total_cost_microcents` for a
  failed/cancelled run falls back to the last `node:completed` cumulative cost because `RunFailedEvent`/
  `RunCancelledEvent` carry no total-cost field of their own — `sum(run_costs) == total` only holds because
  both sides undercount together. *(M · `packages/core/src/engine/engine.ts`, run-event schema; #118, #232)*
- **Exhaustiveness guard on `applyDerived`'s `RunEvent` switch** *(review finding):* `run-history-store.ts`'s
  `applyDerived` switch over `RunEvent` has no `const exhaustive: never` guard, unlike the identical pattern
  already added to `engine.ts` after the EA6 `agent:reasoning`-omission bug — a new `RunEvent` variant could
  silently fail to update `runs.status`/`total_cost_microcents`. Add the same guard `engine.ts` already
  uses. *(S · `packages/db/src/run-history-store.ts`; #114)*
- **Resilient parse for a corrupted `history.db` event row** *(review finding, HIGH):* `loadRunStateEvents`
  (bare-invocation Home) and `loadRunEvents` (`relavium logs`/`status`) both do an unguarded
  `RunEventSchema.parse(JSON.parse(...))` with no try/catch — a single corrupted row anywhere in
  `history.db` crashes the entire read with a generic internal error. Fix once at the
  `run-history-store.ts` choke point with a `safeParse` + skip-and-report posture so both call sites
  benefit. *(M · `packages/db/src/run-history-store.ts`; #277, #282)*
- **Batch `loadRunEvents` instead of one query per run** *(review finding):* `relavium gate list` issues
  one `loadRunEvents(runId)` call per paused run instead of a single batched query, and
  `commands/status.ts` independently N+1s the full unbounded token-event firehose per active run instead
  of using the lighter `loadRunStateEvents` API that `home-store.ts` already established for
  `pendingHumanGates()`. Apply the same batching fix to both call sites.
  *(S · `apps/cli/src/commands/gate.ts`, `apps/cli/src/commands/status.ts`; G12, #273)*
- **Bounded durable tool trace** *(ADR decision)*: persist secret-free per-step tool **summaries** —
  toolId, the sanitized approval-preview target, outcome (ok/denied/failed), duration — never args or
  result bytes; the token/reasoning firehose stays unpersisted (the ADR-0036 posture holds). This is what
  the node-detail screen shows as "tool activity".
- **Store-level gate uniqueness** *(deferred pull-in)*: a uniqueness constraint on `human_gate:resumed`
  per `(runId, gateId)`, closing the cross-process gate-resolve TOCTOU window at the store.
- **Consistency fixes** *(deferred pull-ins)*: wrap the run-resume reconstruction reads
  (`loadRun` + `loadRunEvents` + `loadStepExecutions`) in one read transaction; make the chat persister's
  per-turn writes atomic (`BEGIN IMMEDIATE` per turn); the **content-level workflow-identity guard** on
  resume over the frozen `runs.workflow_definition_snapshot`.
- **Run-submission idempotency** *(deferred pull-in)*: a dedup guard for Home-launched runs (double-Enter
  must not start two runs).

**Acceptance:** a finished run's detail (attribution, exact per-node cost, tool summaries, skipped nodes)
is fully reconstructable from `history.db`; a failed/cancelled run's persisted total cost matches actual
spend incurred through its last event; the TOCTOU constraint holds under a concurrent two-process
test; a corrupted `history.db` event row degrades to a skip-and-report notice instead of crashing
`loadRunStateEvents`/`loadRunEvents`; the schema/event changes are additive and `--json` consumers are
unaffected; migration provided. **Required ADR:** shared with 2.6.G (browsers + durable run-detail; amends
ADR-0036 additively).

### 2.6.I — Provider & MCP management from the Home

Closing the two biggest "must drop to shell / must hand-edit TOML" gaps: provider/key CRUD outside the
onboarding wizard, and MCP servers, which today are managed **only** by hand-editing `[[mcp_servers]]`
config (there is no `relavium mcp` command at all; the only runtime visibility is `/doctor --deep`).

**Tasks:**

- **`/providers`** (Home + chat palette): list providers with key status + redacted live verify; add a
  provider (SSRF-validated base URL rules unchanged); set key (masked, keychain-only — the wizard's tested
  `set-key` path); remove key (confirmed destructive); test. All over the existing `runProviderCommand`
  cores — no new key-handling code paths.
- **New-provider model-visibility default** *(manual-test finding 2026-07-11):* settle what a freshly-added
  provider contributes to the curated **`models_in_use`** set (2.6.L). Recommended policy: while the set is
  **empty/unset**, `/models` shows all (nothing to do); once the user **has** curated, a newly-added
  provider's models are **not** auto-added to the curated view — instead `/providers add` surfaces a hint
  ("N new models from `<provider>` — curate via `/settings`"), so the picker never silently re-floods after
  the user has deliberately narrowed it. Decide here, since `/providers add` is where a provider's live
  model list first lands.
- **`/mcp`** (Home + chat palette): list registered servers with a **read-only** status report (the
  `/doctor --deep` machinery — never connects/spawns on open); add / edit / remove server registrations
  (stdio + `http`/`sse`/`websocket` behind the existing SSRF floor); named secrets set via a masked prompt
  into the isolated `mcp-secret:*` keychain namespace — **never** into TOML (env placeholders only).
- **`relavium mcp list/add/remove/test`** shell family for scripting parity (`--json`-conformant).
- **Config-write extension** *(ADR)*: extend the
  [ADR-0063](../../decisions/0063-cli-config-write-contract.md) typed-setter contract to structured
  `[[mcp_servers]]` writes (which config file owns a tool-written registration, the comment-loss caveat,
  atomicity, secret-incapability by construction).
- **Deferred MCP cluster** *(pull-ins)*: the durable cross-invocation **tool-list cache** (~1h TTL,
  transport-covering key — startup latency); **network header auth**
  (`Authorization: Bearer {{secrets.<name>}}` via the SDK transport's headers, resolved from
  `mcp-secret:*`, never logged/serialized — [ADR-0052](../../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §6);
  **mid-call abort propagation** (the engine's `AbortSignalLike` forwarded to the in-flight `tools/call`,
  so a mid-turn Esc cancels an MCP call instead of only tearing down); optionally the generalized
  `SecretResolver` seam alongside header auth.

**Acceptance:** providers and MCP servers are fully manageable from the Home and the shell; a network
server with header auth connects with its secret resolved from the keychain; discovery startup is
measurably faster with the cache; Esc aborts an in-flight MCP call; the mandatory security review of the
secret handling + config-write surface passes. **Required ADR:** MCP management surface + config-write
extension (extends ADR-0063; sits on ADR-0052/0053).

### 2.6.J — Onboarding v2: two auth paths + the Relavium-account stub

The first-run wizard gains the product's future shape without pulling Phase 5 forward.

**Tasks:**

- **Auth-path select** as the wizard's first step:
  - **(a) Connect a provider (bring your own API key)** — the existing, live flow (provider select →
    masked key → live validation with cause-aware retry → keychain → starter default model), unchanged.
  - **(b) Sign in with a Relavium account** — **visible but disabled** ("coming with managed inference"),
    rendered dimmed with an honest one-line note. Discoverable from day one, selectable never (this
    phase).
- **The account-auth forward-design ADR** (Accepted in this phase; **implemented in Phase 5**,
  [phase-5-managed-inference.md](phase-5-managed-inference.md), riding
  [ADR-0012](../../decisions/0012-managed-inference-dual-mode.md)–[ADR-0015](../../decisions/0015-managed-mode-data-handling-and-compliance.md)).
  It records the decided shape so the stub is honest:
  - The account API key **determines entitlement server-side** — an individual subscription or an
    organization membership activates automatically from what the key is provisioned for; the user never
    picks at login.
  - **No-subscription UX is a first-class state, never a dead end**: a typed, actionable message with the
    BYOK path offered on the same screen.
  - **BYOK always coexists**: a signed-in user with no (or an exhausted) subscription keeps full BYOK
    provider use; at-limit degrades gracefully (finish the turn → wait/upgrade → BYOK fallback).
  - Mechanics reserved for Phase 5: key-paste first (copy from the account portal), browser OAuth +
    device-code later; keychain storage; plan-gated features; org-forced login method.
- Optional wizard polish once 2.6.L lands: a theme step; the outro points at `/help` + `/models`.

**Acceptance:** a keyless first run shows both paths with (b) disabled and honestly labeled; path (a) is
regression-proven unchanged; the forward-design ADR is Accepted with Phase-5 ownership explicit.
**Required ADR:** onboarding auth paths + Relavium-account forward design.

### 2.6.K — Run-ops: the resume-path follow-up (secret re-provide, gate lifecycle; budget resume moved to 2.6.5 `W7`)

The focused follow-up the 2.5 close deliberately deferred — both headline items refactor the
security-sensitive `gate.ts` cross-process resume path, so they land together with fresh context.

**Tasks:**

- **Extract a shared cross-process resume core** from `gate.ts` (snapshot reload → checkpoint reconstruct →
  `resumeFromCheckpoint` → drive) that the gate command, the budget command, and 2.6.G's inline resolve
  card all consume.
- **Validate the gate decision shape against `gateType` before resume** *(review finding, HIGH):*
  `decisionFromFlags` (`apps/cli/src/gate/decision.ts`) and `gateCommand` build a `GateDecision` purely
  from `--approve`/`--reject`/`--input` before the pending gate's `gateType` is even looked up, and
  `WorkflowEngine#resume` never cross-checks the decision kind against `gate.gateType` either —
  `relavium gate <runId> --input` against an `approval` gate silently writes the wrong decision shape with
  no error. Add `assertDecisionMatchesGateType` in `gate/decision.ts`, with `WorkflowEngine#resume` gaining
  the same check as defense-in-depth, as part of the shared resume core this task extracts.
  *(M · `apps/cli/src/gate/decision.ts`, `packages/core/src/engine/engine.ts` (`resume`); #0)*
  **Ruled 2026-11-05 (maintainer, MVP-1):** an `approval` or `review` gate accepts `approved` or `rejected`; an
  `input` gate accepts `input_provided` or `rejected`. The engine reads the gate type from the workflow
  definition's `gate_type`, since the checkpoint does not carry it.
- **`relavium budget resume`** — **MOVED to Phase 2.6.5 `W7` on 2026-09-18.**
  [ADR-0097](../../decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md) makes an approval a
  shown, frozen allowance, and the inline `run` prompter is the only way to approve a budget gate today — so
  without this command the ADR's shown-amount and cross-process guarantees have no surface a script or a
  non-TTY run can reach. It lands with the rendering code `W7` writes anyway, as
  `relavium budget resume <runId> --approve-amount <microcents> | --abort`. What stays here: the **Home
  affordance** on budget-paused rows, which reuses the same amount rendering.
- **Secret re-provide on resume** *(deferred pull-in, security)*: let the operator re-supply a
  `secret`-typed input on a cross-process resume (stdin-only, `provider set-key` discipline; or keychain
  re-resolution keyed by the input `ref` (its stable identifier in the workflow YAML)),
  relaxing today's fail-closed `MaskedSecret` exit-2 — behind a
  **mandatory security review** (this deliberately relaxes a fail-closed guarantee into
  allow-with-re-provisioning).
- ✅ **DONE — closed in Phase 2.6.5 `CR-22` (2026-08-27), ahead of this workstream.** **Gate timeout re-arm on rehydration** *(deferred pull-in)*: re-arm a still-pending gate's persisted
  `expiresAt`/`timeoutAction` against a real clock on reconcile/resume, so a crash-while-paused run's
  deadline is honored.
- **Exit-code fidelity** *(deferred pull-in)*: distinguish a gate park from a media-only park on
  `run:paused` (media parks are reachable since 2.S) in the human message and, if decided, the exit code —
  documented in [commands.md](../../reference/cli/commands.md).
- **Session budget pause/resume** *(deferred pull-in, engine)*: the chat cost-cap `pause_for_approval`
  rides the EA4 pause/resume machine (today it settles the turn loudly) — the ADR-0028 session arm.

**Acceptance:** a budget-paused run is resumable from the CLI and the Home; a secret-bearing run is
resumable via re-provide with the security review passed; timers re-arm; a chat hitting its cost cap can
pause-and-approve instead of failing the turn; a decision whose kind mismatches the pending gate's
`gateType` is rejected (CLI + `WorkflowEngine#resume` both enforce it), never silently written; the shared
resume core is the only resume path (no duplication). **Required ADR:** none new (rides ADR-0028/ADR-0006);
the security review is the gate.

### 2.6.L — `/settings`, the theme system, and localization

The personalization arm: a settings surface over an extended config-write contract, a real theme system,
and the first localized agentic CLI (a genuine differentiator — competitor i18n is white space).

**Tasks:**

- **Theme system**: a palette abstraction replacing the hardcoded literal ink colors; named built-ins —
  `default`, `high-contrast`, `colorblind-safe` (the accessibility pair carried from the original 2.6.E),
  and a terminal-respecting `ansi` theme (`NO_COLOR`/`--no-color` overrides every theme identically: all
  color codes dropped, semantic markers degraded — the `ansi` theme is not a color-free bypass);
  `[preferences].theme` (schema-present, read by nothing today) finally read; **`/theme`** switcher with
  live preview. Semantic markers (`✓`/`✗`/`⏸`) survive `--no-color`/`NO_COLOR` and degrade to ASCII
  (`[v]`/`[x]`/`[||]`) without Unicode.
- **Close five `NO_COLOR`/ASCII-degrade gating gaps in the render layer** *(review findings):* `bold` (an
  SGR code) is never gated by the `color` flag at 5 call sites, unlike every other style prop (the
  `colorProps`/`dimProps` pattern) — add a shared `boldProps()` helper alongside them (#68, high). Status/
  warning glyphs have no ASCII fallback under `NO_COLOR`, unlike `banner.ts`'s already-solved pattern
  (#70). An attachment-bar pictographic emoji renders unconditionally, contradicting the render layer's
  own documented no-pictographic-emoji rule (#59, near-duplicate #71). `NO_COLOR=''` (present-but-empty)
  is treated as absent, diverging from the no-color.org contract (#72).
  *(M · render-layer style helpers (`colorProps`/`dimProps`), `banner.ts`, the attachment-bar component;
  #59, #68, #70, #71, #72)*
- **`/doctor`'s glyph constants have no ASCII fallback** *(review finding):* `/doctor`'s `GLYPH` constants
  render Unicode check/cross marks unconditionally, with no ASCII-degrade path when `NO_COLOR`/non-ANSI
  output is active — unlike the semantic-marker degrade this workstream is standardizing everywhere else.
  Fix `/doctor`'s glyph rendering as part of the same rollout. *(S · `apps/cli/src/chat/doctor.ts`; #9)*
- **`/settings`** (Home + chat): a sectioned screen (appearance / language / chat defaults / models in use
  / update channel) over the **extended** [ADR-0063](../../decisions/0063-cli-config-write-contract.md)
  typed-setter (new keys: `theme`, `language`, `models_in_use`, `show_pricing`; still
  global-preferences-only, atomic, secret-incapable by construction — project files stay hand-authored).
- **Curated "models in use" list** *(manual-test finding 2026-07-11):* a `/settings` section where the user
  picks which catalog models are "in use", so **`/models` shows only the curated set** instead of the whole
  merged catalog — today `/models` lists **every** reachable model from **every** provider and only a live
  text filter narrows it, so adding a provider **floods** the picker (choice overload). Persist the set as
  the new `[preferences].models_in_use` key; the picker reads it purely as a **display filter**, never a
  capability gate — an uncurated model stays reachable by exact id / `--model`, and an **empty/unset set
  shows everything** (back-compatible, so nothing hard-blocks). The **default for a newly-connected
  provider** (seed all / none / a starter subset) is owned by **2.6.I** (see there). No new ADR beyond the
  ADR-0063 key addition.
- **Price-visibility toggle** *(picker display preference, same shape as "models in use"):* a `/settings`
  switch for whether the `/models` picker renders each model's `$/MTok` badge
  (`formatModelPrice`, `apps/cli/src/render/tui/model-picker.ts:357`). **Default OFF** — a user picking a
  default model has not spent anything yet, so a wall of per-token prices up front reads as sticker shock
  rather than useful information; showing it is a deliberate ask, not the first thing a new user sees.
  Persisted as `[preferences].show_pricing` (boolean, default `false`) via the same extended ADR-0063
  setter as `models_in_use`/`theme`. Scope precisely, so this stays cosmetic and never safety-relevant:
  - Gates the **picker's** price column only — never `/cost` (a session's *already-incurred* spend) or
    `models pricing` (an explicit, user-requested price lookup): those are post-commitment or
    explicitly-asked-for moments, not the "before I've tried this" moment the toggle protects.
  - A model with **no known price at all** (`priceKnown: false` — the ADR-0028 cost cap will not apply to
    it) keeps that warning visible regardless of the toggle: it is a safety disclosure, not a price
    display, and hiding it would let a user select an unprotected model without knowing.
  - Interactive-only, mirroring the i18n stance below: `--json`/machine output is unaffected either way
    ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)) — a script always gets full data.
  - The onboarding wizard's first model pick (2.6.J) reuses this same picker, so default-OFF applies there
    too with no extra wiring — the exact moment the sticker-shock concern is about.

  No new ADR beyond the ADR-0063 key addition.
- **i18n foundation**: an in-house string catalog (data ≠ code — zero conditional logic in translation
  data; no runtime dependency expected, else ADR); `[preferences].language`; the catalog is architected for
  **n locales** but only **`en` + `tr`** ship in-phase (maintainer ruling, 2026-07-26 — `es`, `fr`, `de` are
  staged: their key files may land empty/partial, they are not offered in `/settings` until complete);
  a CI **key-parity test** (fails on missing/extra keys across the shipped locales)
  + a dead-string lint — landing the deferred i18n standard as a `docs/standards/` entry. Both shipped
  locales are **Latin-script**, so in-phase rendering needs only accent-safe (valid Unicode, no special
  handling) and combining-character-safe layout; full **IME composition** and **wide-character / bidi**
  handling are **not** in-phase acceptance gates. The catalog architecture stays CJK/RTL-ready (data ≠ code,
  no hardcoded width assumptions) so a future CJK or RTL locale needs no re-architecture — a deliberate
  forward-compat posture, not an in-phase deliverable.
  - **`tr` is the locale that actually exercises the seams**, and it is in acceptance scope: Turkish takes
    **no plural suffix after a numeral** ("3 çalıştırma", never "3 çalıştırmalar"), so the pluralization
    helper must select by locale rule rather than assume the English count-based form; and Turkish's
    dotless/dotted `ı`/`i` makes any locale-sensitive `toLowerCase`/`toUpperCase` or `localeCompare` on an
    identifier a live defect — the same hazard 2.5.5.G's `compareIdentifiers` sweep (`#258`, `#259`) closes
    for sorting. Neither needs new architecture; both need a test.
  - **`es`, `fr`, `de` are staged, not acceptance scope.** Their accented characters are valid Unicode and
    need no special handling, and German/French plural forms are already expressible in the same
    count-variant helper — so completing them later is catalogue work, not a re-design.
- **i18n-foundation scope inputs — hand-rolled `Intl` formatting and the cost-locale question** *(review
  findings, planning inputs for the task above, not separate work):* onboarding and the Home chrome
  currently hand-roll `toLocaleString('en-US')`/relative-time/pluralization strings (~228 unindirected
  literals) instead of `Intl.NumberFormat`/`Intl.RelativeTimeFormat`/`Intl.PluralRules`, and
  `[preferences].language` does not exist in config yet — both fold directly into the i18n foundation task
  above. Decide and record in the i18n architecture ADR whether `$`/period cost formatting stays fixed
  (English/US) under a `tr`/`es`/`fr`/`de` locale, or localizes too.
  *(S · onboarding + Home chrome string literals, `config-spec.md`; #73, #261, #262, #263)*
- Diagnostics/`--json` output stays English-stable (machine contract); localization applies to the
  interactive surfaces.

**Acceptance:** `/settings` edits persist atomically and round-trip; the curated `models_in_use` set
filters `/models` to the chosen models (unset ⇒ all, back-compatible); `show_pricing` defaults off and
hides only the picker's `$/MTok` badge (never `/cost`, never `models pricing`, never an unpriced-model
safety warning, never `--json` output); themes switch live incl. the
accessibility pair; the color-free path stays legible; `NO_COLOR` gating is consistent across every style
prop including `bold`, `NO_COLOR=''` is honored as set, every status/warning glyph (including `/doctor`'s)
has an ASCII-degrade form, and no pictographic emoji renders unconditionally; interactive surfaces run
fully in the shipped locales (`en`, `tr`) with CI-enforced key parity across every catalog key; diagnostics and `--json` remain English-stable per
[ADR-0049](../../decisions/0049-cli-machine-output-contract.md); the machine-output contract is
character-for-character unaffected. **Required ADR:** i18n +
theming architecture.

### 2.6.M — The first-class toolbelt: breadth + rendering

Closing the tool gap against competitor CLIs. Today the registry has 13 built-ins with **no** file
edit/patch, **no** content search, **no** find, **no** todo, **no** ask-user, and a dormant `web_search`
(needs an unwired credential resolver). Every addition is engine-pure (Zod args, `llmVisibleParams`,
policy class, bounded results), documented in
[built-in-tools.md](../../reference/shared-core/built-in-tools.md), selectable in agent/workflow YAML, and
sits under the existing governance floor (advertise-filter + fail-closed approval + protected-path/
sensitive-read floors).

**Tasks:**

- **`edit_file`** — exact old→new string replacement (+ `replace_all`, uniqueness guard, read-before-edit
  safety), `fs_write`-governed with a **diff preview** at the approval prompt. The single biggest gap.
- **`search_files`** — bounded in-house content search (workspace-jailed, sensitive-read floor,
  ignore-file-respecting; linear matcher — no regex-DoS surface), idempotent.
- **`find_files`** — glob file finding across the tree (mtime-sorted, bounded), idempotent — promoting the
  current read_file/list_directory glob options into a first-class discovery tool.
- **Todo/plan tool** — a structured, session-scoped task list the model maintains, rendered as a live TUI
  checklist (persists across compaction); ungoverned (no host arm).
- **`ask_user`** — a structured mid-turn question (options + free text) on interactive surfaces via a
  keyboard-owning overlay; typed `tool_unavailable` on non-interactive surfaces; workflows keep
  `human_gate`. When the agent emits `ask_user` mid-turn, the engine **pauses the turn** (stops
  streaming, holds the in-flight state), renders the overlay, waits for user input, then **resumes**
  the turn with the user's answer injected as the tool result — so there is no keyboard-ownership
  race between streaming tokens and the overlay. A turn paused on `ask_user` shows
  `Waiting for your input…` in the transcript; a timeout (configurable, default 5min) auto-dismisses
  the overlay with a `timed_out` error the agent can handle.
- **`web_search` activation** *(deferred pull-in)*: wire the `egressCredentialResolver` from the keychain
  (today a configured search 401s) and document the config-pinned provider contract; `http_request`
  unchanged.
  - **Architecture note:** `web_search` is a **Relavium-engine-side HTTPS GET** to a config-pinned search
    API endpoint (Brave Search / SearXNG / etc.). It does **not** use the LLM provider's built-in web
    search feature — no provider SDK call, no model-side quota consumption. Search API credentials are
    resolved from the OS keychain via the same `egressCredentialResolver` seam as `http_request`, never
    stored in config files or YAML. The credential resolver plumbing already exists in
    `apps/cli/src/engine/tool-host/egress.ts` but is **not wired** by any production caller (no
    `egressCredentialResolver` is passed in `session-host.ts` or `build-engine.ts`). The Phase 2.6 task
    is to: (a) add a per-provider search-API key store (keychain namespace `search:*`), (b) wire the
    resolver in the **chat-session and Home-chat** tool-environment factories **only** — the workflow-run
    factory (`build-engine.ts`) keeps its `fs`+`process` boundary, which
    [Explicitly out of scope](#explicitly-out-of-scope--phase-3--later) and `build-engine.ts`'s own comment
    both call permanent and ADR-gated, so wiring it here would breach it silently, (c) surface search-provider
    configuration in `/providers` and the onboarding wizard, and (d) document the config-pinned provider
    contract in `built-in-tools.md`.
- **`http_request` has no config path to ever populate `allowedDomains` for chat** *(review finding,
  structurally the same gap as the `web_search` activation above):* `http_request` is advertised to chat
  agents (`wireEgressOs=true` for `chat-read-write`), but only `allowed_commands`/`allowed_command_globs`
  are threaded into `chatToolPolicy` (`session-host.ts`) — there is no config path to ever populate
  `allowedDomains`, so every `http_request` call deterministically fails `domain_not_allowed` before the
  approval prompt even renders, defeating the ADR-0057 approval-floor investment. Wire an `allowed_domains`
  config path alongside the credential-resolver activation above — the same fix pattern.
  *(S · `apps/cli/src/chat/session-host.ts` (`chatToolPolicy`); G30)*
  *(pulled forward, 2026-10-19)*: G30 is not 2.6.M work any more. The approved Wave 3 plan lands it in
  [Phase 2.5.5 execution row 13](phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments) under
  Accepted [ADR-0112](../../decisions/0112-chat-network-grants-and-onboarding-state-are-operator-owned.md): a
  global-only `[chat_http].allowed_domains` with live narrowing authority, explicitly **not** coupled to the
  credential-resolver or `web_search` activation above. The prescription in this bullet is historical.
- **`extra_roots`** *(pulled forward, 2026-10-12)*: invocation grants and committed narrowing selectors are accepted in [Wave 2 Step 2](phase-2.5.5-hardening-and-remediation.md#step-2-acceptance--2026-10-12). Config never grants authority.
- **Tool-call rendering v2** (with 2.6.F's renderer): keep the collapsed one-line annotation as the
  default, add a **details view** (a `/details` toggle or transcript overlay) revealing *sanitized,
  bounded* target/arg previews and result summaries, and **diff rendering** (width-adaptive stacked /
  side-by-side) for `edit_file`/`write_file` at the approval prompt and in details. This deliberately
  revises 2.5's never-render-args posture — it is sanctioned only via the ADR + a security review (every
  string through the shared sanitize floor; secrets structurally excluded; bounded).
  - **`write_file`'s approval flow has no diff/preview and is silent in `auto` mode** *(review finding,
    high — a real blind spot on the highest-consequence built-in tool)*: `write_file`'s approval card
    shows no diff or content preview of what will be written, produces no post-write trace event, and is
    silent end-to-end when running in `auto` accept-edits mode. Close it as part of render v2's diff
    rendering, even though `write_file` predates this workstream.
    *(M · built-in tool registry (`write_file`), the render-v2 diff component; #305)*
- **Target-scoped approval cache** *(deferred pull-in)*: key `[a]lways` grants by `(toolId, target class)`
  (path prefix / host / MCP server) instead of tool id alone, and give `mcp_call`/`web_search` a structured
  `{server, tool}`/query preview so their blank-preview once-only downgrade becomes a real reviewable
  grant.
- **Dynamic `invoke_workflow` from within a workflow agent node** — **not a 2.6.M deliverable, and not a
  2.6.P one either.** It is tracked *alongside* 2.6.P (workflow composition), whose `subworkflow` node and
  nested-run event namespace are its natural home, but the capability itself is **deferred past Phase 2.6**
  (D57): 2.6.P's ADR records the deferral and its rationale rather than implementing it. (`invoke_agent` is
  wired for chat in 2.6.N — agent spawning is separate from workflow composition.)
- **Default chat agent grant review**: widen the built-in agent's grant to the new idempotent read tools
  (search/find/todo); write/exec/egress stay opt-in via mode + approval.
  *Direction set 2026-11-04 (D62, see [MVP-A14](#cli-mvp-additions--2026-11-04)):* the built-in agent also gets
  `write_file`/`edit_file` and `run_command` under the approval card; this lands only with its ADR-0057 amendment and
  security review.
- **Curl/wget as web-search substrate** *(research item)*: evaluate whether `curl` / `wget` / `httpie` /
  `xh` should be **default-allowed** in the built-in chat agent's `allowed_commands` as an alternative
  web-search path — the model can already use `web_search` (once credential-resolved), but a
  `run_command`-backed `curl` gives the model raw HTTP access under the existing `shell: false`,
  allowlist-exact-match, and mode-gated approval floor. The research must weigh: (a) the UX benefit of a
  no-config web path vs (b) the security implications of a default-allowlisted network command (even
  with `shell: false`, arg injection through the model is a concern), and (c) whether the answer differs
  for the built-in agent vs explicitly-authored agents. Record the decision as an amendment to 2.6.M's
  acceptance criteria or as a deferred Phase 2.6 follow-up.

**Acceptance:** the toolbelt covers read / edit / search / find / exec / web / todo / ask-user /
`invoke_agent` (now wired for chat — 2.6.N); each tool
is YAML-selectable and correctly mode-gated on every **surface that wires its capability arm** — egress/OS
tools on the chat surfaces only, with 2.6.A's pre-flight rejecting an egress/OS grant in an authored workflow
rather than shipping a permanent `tool_unavailable`; render v2 ships with diffs and the details
toggle behind a passed security review, including `write_file`'s approval card (content diff/preview, a
post-write trace event, and visibility in `auto` mode); a chat `http_request` call reaches the approval
prompt instead of deterministically failing `domain_not_allowed`; the approval cache is target-scoped; the
tool-gap table in the research record is closed or explicitly deferred per item. **Required ADR:** toolbelt
additions + tool-render/approval-preview contract (extends ADR-0029/ADR-0057 posture).

### 2.6.N — Child-session foundation: catalog spawn, standardized I/O, lineage

Close the largest deliberate parity gap — in three workstreams (**2.6.N / 2.6.O / 2.6.P**, split from a
single over-large 2.6.N on 2026-07-09 along a safety gradient: **N is the safe mechanism**, **O the
high-risk model-generated-and-executed half** with its own security review, **P the schema-versioned
workflow-composition half**). 2.6.N is the foundation: let a chat session spawn a **catalog-resolved**
sub-agent — user-initiated or model-driven — with a standardized I/O contract, parent-child lineage, cost
roll-up, abort propagation, and the host artifact-store substrate. **On-the-fly generation is deliberately
NOT here** (2.6.O); **the authored `subworkflow` node is NOT here** (2.6.P). Requires a dedicated ADR
before implementation.

**Tasks:**

- **Child-session ADR (foundation)**: record the architecture for parent-child execution relationships —
  the child spawn lifecycle (start → run → collect → cleanup), the `parentSessionId` / `parentRunId`
  schema additions to `agent_sessions` and `runs`, the cost-attribution model (child costs roll up to the
  parent), the abort/cancel propagation contract (parent cancel cascades to children; child failure
  surfaces in parent without killing the parent), and the context-sharing model (a child agent receives the
  parent's task description as a system prompt, never the full transcript). Extends ADR-0024 (AgentSession)
  and ADR-0036 (event bus); amends the database schema additively.
  **Analysis gate:** the child's intermediate steps (tool calls, reasoning, partial outputs) must be
  visible to the parent in some form — the ADR must decide whether the parent sees a real-time stream of
  child events (inline in the parent transcript), a terminal summary only, or a collapsible detail panel.
  The trade-off is UX richness vs transcript noise.
- **Standardized agent/workflow I/O contract**: define a canonical I/O contract that every agent and
  workflow honors — a structured input (task description + optional context and file references) and a
  structured output (result text + optional artifact references + optional error). The exact schema is
  authored once in `@relavium/shared`, consumed by the engine's `invokeAgent` delegate, and documented in
  its **one canonical reference spec** under `docs/reference/` (the phase doc never restates it). Existing
  workflow `inputs`/`outputs` map to this contract: a workflow's declared `inputs` schema is the validation
  gate; its `output_mapping` shapes the result. Agents without declared schemas get a free-form text
  contract. Standardized I/O means any agent can invoke any other without ad-hoc prompt engineering — the
  contract is the interop surface, and it is the seam 2.6.O's generation and 2.6.P's `subworkflow` node both
  target.
- **Engine: `invokeAgent` delegate wired for chat — catalog-resolved only**: inject `ctx.invokeAgent` into
  the `AgentSession`'s tool dispatch context. When an agent calls `invoke_agent` (or the model emits it
  autonomously for a complex sub-task) naming an agent slug/path in the catalog (`.relavium/agents/` or the
  built-in set), the engine: (1) resolves the catalog agent; (2) creates a child `AgentSession` (or child
  `WorkflowEngine` run) with `parentSessionId`/`parentRunId` set; (3) injects the standardized input as the
  child's first message; (4) runs the child to completion, collecting its output; (5) returns the
  standardized result to the parent turn as a tool result; (6) records the child in `history.db` with full
  lineage. The parent sees structured output and continues. **Generation of a NEW one-off agent when no
  catalog agent matches is 2.6.O** — in 2.6.N a no-match is a clean typed error, never a silent generation.
  Spawn in 2.6.N is **sequential** (one child at a time); parallel fan-out is 2.6.O.
- **Ephemeral artifact management — the two-root model + the host artifact-store port** *(resolved
  2026-07-09 by the artifact-directory analysis; foundational infra 2.6.O/2.6.P build on)*: Relavium keeps
  **two distinct artifact roots**, split by ownership, not convenience:
  - **Project `.relavium/`** (walk-up-discovered) — the **user-facing, committable** artifacts (authored
    workflows/agents the user reviews and commits). Unchanged.
  - **A central device-level ephemeral root** under `~/.relavium/` — the **machine-scoped agent-harness**
    artifacts (per-session memory, tool/agent intermediate outputs, harness scratch; and, in 2.6.O,
    model-generated one-off YAML). Per-session isolation (`<parentSessionId>/`), `0700`, cleaned up on
    parent session end (`/exit` / `/cancel` / process exit); a crashed session's dir is aged out by a GC
    pass on the `engine.reconcile()` path (2.6.F). **Never** in the project directory.
  - **Core-purity (rule #5):** `packages/core` cannot know `~/.relavium/` or do filesystem I/O. The engine
    defines an **artifact-store port** (write/read/list/cleanup keyed by `parentSessionId`); the **CLI
    host** implements it against the central root, injected like the `MediaStore` / `Checkpointer` ports.
    "Relavium-core's central dir" is therefore a host-provided port, not an engine path.
  - **fs-floor prerequisite (L605; pulled forward 2026-10-12):** the [Wave 2 Step 2 acceptance](phase-2.5.5-hardening-and-remediation.md#step-2-acceptance--2026-10-12) records the exact host-issued private scratch descriptor/factory and removes automatic global tmp provisioning. It replaces the historical inert `FsHostConfig.tmpDir` prerequisite; no basename or general home-anchor exemption is granted. Lexical/canonical containment, pinned identities, POSIX private-directory checks and nested floors apply; Windows retains the owner-controlled profile/ACL assumption. Independent Step 2 review and platform gates are accepted. This supplies no ordinary-chat allocator or child lifecycle: production provisioning, per-parent isolation, join, cleanup and recovery remain 2.6.N obligations.

- **Chat UX for sub-agent spawn (foundation)**:
  - **Model-driven spawn**: the agent autonomously calls `invoke_agent` — the transcript shows an inline
    status indicator: `→ delegated to "code-reviewer" · running… (12s)` then
    `✓ code-reviewer · completed (23s, $0.04)` or `✗ code-reviewer · failed — type mismatch in output`.
  - **User-driven spawn**: `/spawn <agent> <task>` — manually start a catalog sub-agent from the chat
    prompt; its result returns as a notice in the transcript.
  - **Child result panel**: the child's full output is available in a collapsible detail panel (the
    `/details` toggle from 2.6.M's render v2); the parent transcript carries a one-line summary.
  - **Permission model + hard guardrails (bind everything, incl. 2.6.O)**: an auto-spawned sub-agent
    inherits the parent's mode and approval cache — a child never escalates beyond the parent's grant (a
    child whose parent denied `run_command` cannot run commands; a child cannot switch to `auto` if the
    parent is in `ask`). A user `/spawn` runs under the current chat mode. Two engine-enforced limits, one fixed and one
    tunable: maximum nesting depth is **3** (parent → child → grandchild; a grandchild cannot spawn further)
    and is **not configurable**; maximum concurrent children per turn is a **configurable ceiling**
    (default **5**). Fixing the depth bound — and giving the concurrency ceiling a known default — lets
    downstream UX (error messages, history tree views, cost indentation) design against stable limits from day one.
    **Analysis gate:** stress-test the inheritance model — (a) a child switching modes via its own `/mode`
    (denied — mode is inherited, not child-ownable); (b) a child requesting escalation, surfaced to the
    parent's approval prompt **with the child's identity** so the user knows who is asking. The ADR records
    the resolved policy per case. *(The generated-agent self-grant case is 2.6.O.)*
- **Cost attribution**: child run costs (tokens, tool usage) roll up to the parent's `cost:updated` event
  with a `childRunId` discriminator. `/cost` shows a hierarchical breakdown (parent total, then per-child
  contributions indented); the 2.6.H run-history drill-down includes child runs as expandable rows.
- **Child abort / partial output**: when a child is cancelled (parent `/cancel`, `Esc`, or timeout), the
  engine captures the child's **partial output** (tool results + intermediate text before the abort) and
  returns it to the parent as `{ result: "<partial>", error: { code: "cancelled", message: "child was
  aborted" } }`. The parent can inspect the partial work and retry, continue differently, or report.
  Partial output is bounded (the standard tool-result ceiling) and sanitized.

**Acceptance:** a chat agent resolves a complex request by spawning a **catalog** sub-agent and
incorporates its result; `/spawn code-reviewer "review the last change"` works inline; child session/run
records carry full parent lineage in `history.db`; a parent cancel propagates to children; child cost
rolls up to the parent; the artifact-store port + central ephemeral root are wired (host-side) with the
fs-floor home-anchoring fix landed; the depth-3 / concurrency-ceiling guardrails hold. On-the-fly
generation and parallel fan-out are explicitly out (2.6.O). **Required ADR:** child-session foundation
(new — extends ADR-0024/ADR-0036; the artifact-store port + standardized I/O + lineage schema).

### 2.6.O — On-the-fly generation + parallel orchestration (highest-risk)

The two highest-value, highest-risk orchestration capabilities, split out of the foundation because each
carries a security surface the safe mechanism does not: the model **generating and immediately executing**
a one-off agent/workflow, and **parallel** sub-agent fan-out. Gated behind 2.6.N (the spawn mechanism) and
2.6.B (the authoring loop generation reuses), and behind a **dedicated security review** before the
generation capability ships.

**Tasks:**

- **On-the-fly agent/workflow generation**: extend 2.6.N's `invokeAgent`/`invokeWorkflow` so that when the
  model describes a task with **no matching catalog agent** (e.g. "analyze this CSV and find outliers"),
  the engine uses the 2.6.B conversational-authoring infrastructure to generate a valid `.agent.yaml` (or
  one-off `.relavium.yaml`) on the fly — written to the central ephemeral root (2.6.N's artifact-store
  port, `<parentSessionId>/agents/<uuid>.agent.yaml`), **validated before it can execute** —
  `validateAuthoredAgent` for a generated `.agent.yaml`, `validateAuthoredWorkflow` for a one-off
  `.relavium.yaml` (both from 2.6.A), with the parent-grant clamp enforced **inside the validator**, not
  only at spawn — then spawned. The model is not limited to
  pre-existing catalog agents — it **composes tooling on demand**.
- **Generation security review (mandatory, dedicated — the plan's highest-risk surface):** generating and
  running model-authored agents is a **prompt-injection → code-execution** path. Untrusted content in the
  parent's context (a tool result, a fetched web page, a read file) can steer the model to generate an
  agent whose **system prompt itself** — model-controlled persistent instruction text — becomes a new
  injection surface, beyond "is the YAML schema-valid." The review must cover: (a) schema validity is
  necessary but not sufficient; (b) a generated agent's `tools:` list is **clamped to the parent's granted
  set** (narrow-only, never escalated — validator-enforced); (c) generated agents **never** carry secrets;
  (d) the generated system-prompt-as-injection-vector explicitly, with the untrusted-content provenance
  boundary (ADR-0060's taint model is the relevant precedent). This is the gate the capability ships behind.
  **Analysis gate:** measure (a) generation success rate on a representative task corpus, (b) that
  malformed generated YAML never reaches execution (the pre-flight is the gate), (c) generation latency
  acceptable for an interactive turn.
- **Parallel sub-agent spawn**: when the parent issues multiple `invoke_agent` calls in one turn (e.g.
  "review frontend" + "review backend" + "audit db schema"), the engine runs them **concurrently** — each
  child starts independently, streams status into the parent transcript as parallel inline indicators
  (`⏳ 3 agents running · code-reviewer (12s) · security-audit (8s) · db-check (15s)`), and the turn
  completes when the last finishes (or per the error policy). The concurrency ceiling (2.6.N's guardrail,
  default 5) bounds fan-out. This is the primary orchestration differentiator over sequential spawn.
  **Analysis gate:** the exact `fail_fast` semantics (cancel in-flight siblings? wait-but-discard? expose
  partial sibling results?) and the `error_policy` surface (`fail_fast` vs `collect_all` vs
  `timeout_per_child`) are decided during implementation.

**Acceptance:** a chat agent with no suitable catalog agent **generates** a valid one-off agent, which
passes the pre-flight and runs, its result folded into the parent turn — with the generation security
review passed; a generated agent never escalates tools or carries a secret; **a generated agent naming an
unknown tool, an uncatalogued model, or a grant wider than its parent's is rejected by
`validateAuthoredAgent` before spawn, reject-path tested**; a parent fans out to multiple
children concurrently under an explicit error policy and collects their results in one turn. **Required
ADR:** on-the-fly generation + parallel orchestration security (new — the generation-as-codegen threat
model, tool-grant clamping, the parallel error-policy contract; sits on ADR-0060's taint precedent).

### 2.6.P — Workflow composition: the `subworkflow` node + `schema_version` 1.1

Authored **workflow-in-workflow** composition — a workflow invokes another as a sub-graph via the
`subworkflow` node — plus the additive schema-version bump that makes it authorable. Separable from the
chat-side orchestration (N/O) because it is a **YAML-surface, schema-versioned** change with its own
migration story; depends on 2.6.N for the parent-child lineage substrate.

**Tasks:**

- **Wire the `subworkflow` node + `schema_version` 1.1** *(mechanics + decision finalized 2026-07-09 by
  the schema-version analysis)*: the `subworkflow` engine node type is **already reserved**
  ([node-types.md](../../reference/shared-core/node-types.md) — `subworkflow_config` =
  `{workflow_id, input_mapping, output_mapping}` is spec'd; it is in `ENGINE_NODE_TYPES` but not the
  authored `WORKFLOW_NODE_TYPES`). Promote it to the authored surface behind **`schema_version` 1.1** — a
  **first-of-its-kind, additive, opt-in** bump. **Finalized decisions:**
  - **Additive / opt-in, never force-migrated.** `WorkflowSchema.schema_version` (`z.literal('1.0')` today)
    becomes version-aware (accepts `'1.0'` **or** `'1.1'`); `subworkflow` authoring gates on `>= 1.1`. **1.1
    is a strict superset of 1.0** (adds an authorable type, changes nothing existing) — so **existing 1.0
    files stay valid as 1.0 and are NOT force-migrated**; a file declares 1.1 only when it uses a 1.1
    feature. This is the only design consistent with "workflows are versioned, git-committable public-API
    objects" — old files must keep working (the `workflow.ts` comment already anticipates "evolution across
    `schema_version`s … via the version literal and a migration path"). A 1.0 file using `subworkflow` is
    **rejected** (must declare 1.1) — the strict-validation contract (ADR-0023) holds.
  - **1.1 promotes `subworkflow` ONLY — NOT `loop`.** The invariant is **authored surface == executable
    surface**: a reserved engine slot graduates to authorable only in the version that **also ships its
    handler**. `subworkflow` ships an executable handler here, so it graduates; `loop` has no handler in
    Phase 2.6, so promoting it would create a "parses under 1.1 but fails at runtime" trap — exactly the
    anti-pattern reserved-rejected-at-parse avoids. `loop` stays a reserved engine slot, promoted to
    authorable only in the future version that ships its handler (a later 1.2). This keeps `schema_version`
    an honest capability marker.
  - Establishes the **first version-migration path** in the codebase (there is none today): the parser
    accepts both versions, the [workflow-yaml-spec](../../reference/contracts/workflow-yaml-spec.md) grows a
    v1.1 section, and a migration note documents "1.0 files need no change."
- **The `subworkflow` handler + nested-run events**: a `subworkflow` node references another `.relavium.yaml`
  by path or catalog id, passes mapped inputs, and collects mapped outputs — like a `tool` node routes
  data, but executing a full nested workflow DAG. The child run is recorded with `parentRunId` (2.6.N's
  lineage); its `run:*` events nest under a `run:child_*` namespace (or the bus carries a `parentRunId`
  discriminator — decided in the ADR). This enables **arbitrary workflow composition** — pipelines built
  from smaller, independently testable units without the engine knowing any workflow's domain.
- **Dynamic `invoke_workflow` from a workflow agent node — DEFERRED past Phase 2.6** *(decision D57,
  recorded in [current.md](../current.md#wave-gating-decisions))*: a running workflow's agent node selecting
  a sub-workflow at runtime by model judgment is exactly the unauthored composition that 2.6.P's
  *authored surface == executable surface* invariant exists to prevent, and it has no cost-governance
  boundary yet. **2.6.P ships the authored `subworkflow` node only.** Its ADR records the deferral and the
  rationale rather than deciding the design; reopening it needs its own ADR + security review covering
  (a) target selection, (b) the nested-run event namespace, and (c) cost/resource governance. Tracked in
  [../deferred-tasks.md](../deferred-tasks.md).

**Acceptance:** a workflow invokes another via an authored `subworkflow` node under `schema_version: '1.1'`;
existing `schema_version: '1.0'` files parse **unchanged** (no forced migration); a 1.0 file using
`subworkflow` is rejected with a version-hint error; the child run carries `parentRunId` lineage and its
events attribute to the parent; the parser/spec/migration-note establish the reusable version-migration
path. **Required ADR:** `subworkflow` node + `schema_version` 1.1 additive migration (new — the
first versioned-schema bump; the nested-run event namespace; the recorded deferral of dynamic `invoke_workflow`).

### 2.6.Q — Dynamic model-catalog enrichment (models.dev): per-model capability matrix + pricing long-tail — 🟡 **P1–P5 landed (PR #76, 2026-07-26); P6 and the `/settings` → `/models` toggle open**

Added **2026-07-11** from three maintainer manual-test findings that share one root cause — **Relavium has no
per-model economics or capability data beyond a ~12-entry hand-maintained registry**, and no provider API
returns either. The full design analysis (five alternatives, the recommended hybrid, the security surface, and
six open ADR questions) is in
[models-dev-dynamic-catalog-enrichment-2026-07-11.md](../../analysis/models-dev-dynamic-catalog-enrichment-2026-07-11.md);
this workstream is its execution. Scope is **enrichment, not extensibility** — it attaches richer data to the
models the four shipped adapters can **already** call and to ADR-0065 custom endpoints; it adds **no**
`ProviderId` (the enum stays closed). The three findings resolve into **two separable payloads**:

- **Capability matrix** (fixes findings **F3 + F4**, near-zero risk — *ship first*): today reasoning-effort
  capability is a provider-global **binary** (does the model reason at all?), never a per-model set of
  *accepted* tiers, so the `/effort` picker offers all five tiers to every reasoning model and the adapter
  attaches the chosen tier with **no clamp** — a model that rejects it returns an HTTP 400 that collapses to an
  opaque `error: validation` on the chat surface. The same blind spot leaves `max_tokens` unclamped against any
  per-model output ceiling. models.dev supplies `reasoning_options.values` (accepted tiers), `limit.output`,
  `temperature`, `structured_output`, `modalities` — the data to **clamp-or-reject before the wire**.
- **Pricing long-tail** (fixes finding **F5**, HIGH safety — *guardrailed, second*): any live-listed id absent
  from the static `MODEL_PRICING` gets `priceKnown: false`, and the pre-egress budget governor then **catches
  `UnknownModelError` and returns `{ kind: 'allow' }`** — so `max_cost_microcents`, a *safety* control, is
  **silently skipped on every check** for a reachable-but-unpriced model, and realized cost is swallowed too.
  models.dev's `cost.*` fills the long tail so the cap can enforce.

**Tasks:**

- **Cost-cap safety hardening** *(F5, data-source-INDEPENDENT — ship FIRST, before any fetch).* At the
  pre-egress governor (`packages/core/src/engine/budget-governor.ts`), distinguish a genuinely-unpriced
  self-hosted model (custom `base_url` — keep the deliberate allow-degrade, H4: never hard-fail a valid run)
  from a **reachable first-party** model the registry simply hasn't caught up to, and gate the latter behind a
  **strict-cap mode** so the blanket `UnknownModelError → allow` is not the only guard; re-enable realized-cost
  visibility (`fallback-chain.ts` no longer swallows the record once the id is priced). This closes the safety
  hole even before the models.dev tier lands.
- **Per-model capability payload** *(F3 + F4 — ONE work item).* Widen `ModelCatalogEntry` / `ModelPricing` and
  `modelSupportsReasoning` from a boolean to an **accepted-effort-tier set** plus `limit.output` and the
  temperature/structured-output/modality flags. Clamp-or-reject **before the wire**: the OpenAI adapter
  (`OPENAI_REASONING_EFFORT` / `buildCommonBody`) and the engine gate (`packages/core/src/engine/reasoning-effort.ts`)
  coerce/drop a tier the target model does not accept; `resolveGenKnobs` (`agent-runner.ts`) and the session
  path (`agent-session.ts`) clamp `max_tokens` to the model's output ceiling (mirroring the adjacent
  `gateReasoningEffort`), leaving an unknown ceiling as provider-default. Fix the OpenAI adapter to emit
  `max_completion_tokens` (not legacy `max_tokens`) for reasoning-capable ids. The `/effort` picker
  (`effort-picker.ts`) offers only the model's accepted tiers.
- **Non-opaque param errors** *(F3, near-term).* Before the full matrix lands, add a static accepted-tier
  bridge table for the known OpenAI reasoning ids to clamp, **and** stop rendering a bare `error: validation`
  for a param-400 (`chat-projection.ts`) — a static actionable hint mirroring `looksLikeContextOverflow`
  ("this model rejected the reasoning-effort tier — pick another via `/effort`"), weighing the deliberate
  privacy exclusion of provider `validation` text.
- **The models.dev pricing tier** *(F5).* Add a `'models-dev'` `PricingSource` and tier to the **pure**
  `mergeModelCatalog` (`packages/llm/src/model-catalog.ts`) with precedence **`registry > user > models-dev >
  none`** — the tier may fill unknowns but must **never** lower `priceKnown` or override a verified/user price.
  Surface a "community price — verify" provenance annotation in the picker.
- **Host-side fetch + bundled floor** *(F5).* Fetch `https://models.dev/api.json` **host-side**, extending
  `ModelRefreshService` (`apps/cli/src/engine/model-refresh.ts`) — **never** in `packages/core` or the pure
  parts of `packages/llm` ([CLAUDE.md](../../../CLAUDE.md) #5); TLS-only, unauthenticated GET carrying **no**
  keychain secret / prompt / model selection; the JSON normalized to Relavium types **before** the pure merge
  (no vendor type crosses the [ADR-0011](../../decisions/0011-internal-llm-abstraction.md) seam). Bundle a
  pinned snapshot floor (+ a committed CI regeneration script) as the offline/first-run default and the
  integrity fallback; integrity-validate the payload (reject non-object / empty / below-floor-count /
  shrank-past-ratio → last-known-good); ship a **disable-able** egress switch (local-first honesty).
- **The ADR** *(extends [ADR-0064](../../decisions/0064-live-model-catalog.md)).* Record the hybrid
  (bundled-floor + host-side runtime fetch), capability-first / pricing-second, the precedence + integrity
  rules, the disable-able egress, the SSRF floor if the URL is ever made configurable (rides
  [ADR-0065](../../decisions/0065-provider-economics-and-extensibility.md)), the new capability fields' canonical
  home, and resolve the six open questions — chiefly the **default egress posture** (on-by-default *fresh* vs
  opt-in *local-first*) and **clamp vs reject**. It closes the `error: validation` gap in
  [ADR-0066](../../decisions/0066-normalized-reasoning-effort-control.md). A **mandatory security review** of
  untrusted-community-pricing-into-a-safety-control is a co-gate.
- **Usage capture for streams that end without usage** *(added 2026-11-04, after the MVP; 2.6.C's open
  obligation, [ADR-0070](../../decisions/0070-durable-per-model-session-cost-attribution.md) §3 exceptions
  1–2).* Since W8, an egress that streamed content but ended without a usage chunk, and a mid-stream
  failure, carry `missing` or `partial` usage evidence
  ([ADR-0104](../../decisions/0104-unknown-provider-usage-is-durable-cost-uncertainty.md)): their realized
  money stays 0, and the money surfaces already qualify the total ("usage unknown for N calls") without
  inventing a quantity. What remains is capture: where a provider does report usage that an adapter still
  drops, if any, read it at the seam so the realized total stops under-reporting, and ADR-0070 §3's
  exceptions narrow with it. An estimate is out of scope here: it would need an ADR amending ADR-0104's
  rule that missing evidence contains no invented quantities. A PR #96 review found 2.6.C's "filed against
  2.6.Q" with no item here; the maintainer ruled this phase owns it, and the D64 round-1 review narrowed it
  to what W8 left (2026-11-04).
- **Tests:** an over-ceiling `max_tokens` is clamped per model; an OpenAI reasoning id uses
  `max_completion_tokens`; an out-of-range effort never reaches the wire and the picker offers only accepted
  tiers; a reachable-but-unpriced id gets a models-dev price so the cap applies (or is refused under
  strict-cap); a param-400 renders a non-opaque chat line; integrity validation rejects a shrunk/empty payload
  and falls back to last-known-good; a lint-fence + purity test prove the fetch never enters the pure packages.

**Acceptance:** a live-listed but registry-absent first-party model gets a models-dev price so
`max_cost_microcents` enforces (or is refused under strict-cap) — **F5 closed**; selecting **any** listed model
with **any** offered effort tier never produces an opaque `error: validation` (the picker offers only accepted
tiers; the adapter/engine clamps-or-rejects before the wire with a legible message) — **F3 closed**; an
over-ceiling `max_tokens` is clamped per model and OpenAI reasoning ids use `max_completion_tokens` — **F4
closed**; the fetch runs host-side in `apps/cli` only (proven by lint-fence + purity test), is disable-able,
integrity-validated, with a bundled snapshot floor; `ProviderId` stays the four adapters; no vendor type
crosses the `@relavium/llm` seam; precedence never lowers `priceKnown` or overrides a verified/user price; the
mandatory security review passes. **Required ADR:** Dynamic model-catalog enrichment (models.dev) — **new**,
extends ADR-0064; rides ADR-0065 (SSRF / user-pricing precedent) and ADR-0066 (the effort-capability payload);
[ADR-0011](../../decisions/0011-internal-llm-abstraction.md)-respecting (host-side data source, not a
`listModels` call). Mandatory security review is a co-gate.

## CLI MVP additions — 2026-11-04

The CLI MVP (decision D58, milestone M3.5, v0.2.0) is ordered in [current.md](../current.md#next-work--the-cli-mvp).
Most of its items already have a home in a workstream above. This section is the one home for the items that had
none, found by the 2026-11-04 review of the code at `5a328bca` and ruled by the maintainer
([priority reset](phase-2.5.5-hardening-and-remediation.md#mvp-priority-reset--2026-11-04)). Each belongs to the
workstream named in its row and follows that workstream's ADR and security gates. MVP-A24 to MVP-A30 were added
on 2026-11-08, when MVP-2 was re-planned around the Home
([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md),
[MVP-2 plan](#mvp-2-plan--home-first-2026-11-08)).

| ID | Workstream | Item and acceptance |
|---|---|---|
| MVP-A1 | 2.6.G | **Human run output.** `relavium run` and `logs` print the workflow's outputs on the human surfaces, bounded and through the shared sanitize floor; `--json` is unchanged. |
| MVP-A2 | 2.6.G | **The run id is visible.** The TTY run view and its final summary show the run id that `logs`, `status` and `gate` accept. |
| MVP-A3 | 2.6.B | **`/export` writes where workflows live.** It writes into `.relavium/workflows/` with a slug from the session title (no UUID file in the working directory) and offers to run the result. |
| MVP-A4 | 2.6.J | **The default model follows the stored key.** With no configured default, the chat model comes from a provider that has a key, and a missing key yields the actionable "no API key … `provider set-key`" error instead of an opaque credential failure. |
| MVP-A5 | 2.6.J | **`relavium chat` offers onboarding** when no key exists, without re-running the wizard on every launch when the keychain is unavailable (#55's loop stays fixed in its own row). **Home-first (2026-11-08):** the offer is the Home's in-TUI setup (MVP-A28), and the keychain-unavailable case is handled by MVP-A27 in MVP-2 itself ([MVP-2 plan](#mvp-2-plan--home-first-2026-11-08)). |
| MVP-A6 | 2.6.J | **Standard provider environment variables** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`) are read after the `RELAVIUM_*` variables, never logged or echoed; [config-spec.md](../../reference/contracts/config-spec.md) is updated with the code. Key-custody review. **Settled 2026-11-08:** a standard variable is never applied to a provider with a custom `base_url`; interactive surfaces ask once before using one, and non-interactive paths use it directly ([MVP-2 plan](#mvp-2-plan--home-first-2026-11-08), decision 2). |
| MVP-A7 | 2.6.Q | **Interactive output budget.** No implicit 4,096-token cap on interactive Anthropic chat: the default is the catalog ceiling (not clamped: the chat's per-attempt deadline scales with it instead, ADR-0101 2026-11-06; chat surfaces only), with a `[chat].max_tokens` key; the budget estimate's interplay (ADR-0101) is checked. Recorded as a dated amendment to ADR-0101 (maintainer, 2026-11-05). |
| MVP-A8 | 2.6.M | **Truthful tool rows.** A failed tool call shows a failure mark, not ✓, and the assistant's text between tool calls stays visible. **Split 2026-11-08:** MVP-2 ships the mark; the text between tool calls lands with MVP-3's tool-call rendering v2. |
| MVP-A9 | 2.6.M | **Ranged reads.** `read_file` takes line or byte ranges and bounded output spills to a wired `ToolHost.outputStore`; its model-visible description matches the CLI's binary refusal. |
| MVP-A10 | 2.6.M | **Denials reach the model.** A user or guardrail denial returns to the model as a `tool_result` instead of ending the turn (ADR-0057 amendment, D67). |
| MVP-A11 | 2.6.M | **Configurable, finite ceilings.** Tool rounds, correction attempts and the session turn limit are configurable with conservative defaults and stay finite (ADR-0086). |
| MVP-A12 | 2.6.E | **One keymap.** Ctrl+C interrupts the running turn, a second Ctrl+C ends the session, and Ctrl+C at a pending approval rejects it before anything else (keymap ADR, D68; supersedes the 2026-10-19 `/cancel` wording; approval-path sitting). |
| MVP-A13 | 2.6.M | **`[chat].default_mode`.** The starting mode is configurable (default `ask`), with a one-time hint that Shift+Tab changes it (ADR-0057 amendment, D62). |
| MVP-A14 | 2.6.M | **Default grant (D62).** The built-in agent gets the read, search and find tools, `write_file` and `edit_file` (hidden in ask/plan, per-call diff approval in accept-edits) and `run_command` under MVP-A15; egress stays opt-in. Lands only after the approval diff; ADR-0057 amendment and security review. |
| MVP-A15 | 2.6.G | **`run_command` approval card (D63).** A non-allowlisted command prompts once / for the session / to remember; remembered grants live outside the repository, in operator-owned configuration keyed by project root; accept-edits keeps prompting for allowlisted commands; headless paths stay fail-closed; `!` uses the same card. New ADR amending ADR-0029(a)/0061/0063, and a security sitting. |
| MVP-A16 | 2.6.D | **Project instructions.** A project instructions file (`AGENTS.md`) and an environment block enter the system prompt under explicit provenance rules (new ADR; independent of ADR-0060's `{{ctx.*}}`). |
| MVP-A17 | 2.6.E | **Session entry flags.** `relavium chat --model/--provider` and a one-shot prompt mode; headless stays fail-closed; both follow ADR-0110's compatibility rules. |
| MVP-A18 | 2.6.B | **A minimal `relavium init`** scaffolds `.relavium/` instead of being a dead command. **Home-first (2026-11-08):** `/init` in the Home shares its core and shows what it will create before writing; the search for a project's `.relavium/` stops treating the global `~/.relavium` as a project folder ([MVP-2 plan](#mvp-2-plan--home-first-2026-11-08), decision 9). |
| MVP-A19 | 2.6.B | **Starter content.** Two or three starter workflows and agents a new user can run unchanged. |
| MVP-A20 | 2.6.I | **Masked `provider set-key` on a TTY** instead of refusing an interactive terminal. Secret-input sitting. |
| MVP-A21 | 2.6.I | **Registered MCP servers reach the default agent**, under ADR-0084 spawn consent and ADR-0088's untrusted tool definitions. |
| MVP-A22 | 2.6.F | **Upgrade from `0.1.1`.** A populated `0.1.1` home (history.db with migrations 0000–0004, config.toml, keychain entries) upgrades through v0.2.0, with a seeded-then-migrated test. |
| MVP-A23 | 2.6.F | **Release prerequisites for v0.2.0.** The D59 release ADR and guard change; version and CHANGELOG including the Node ≥22 break; npm token, 2FA, provenance and the `v*` ruleset verified; the publish credential scoped to the release job, either npm trusted publishing (OIDC, no long-lived token) or the `release` deployment environment with a `v*`-tag deployment policy and a required reviewer holding `NPM_TOKEN`, with the repository-level secret deleted (PR #96 review, 2026-11-04; chosen in the D59 release ADR); the interactive Home and chat checked on a real Windows terminal; a manual three-provider end-to-end turn; first-read docs (README, npm README, tutorials, runbooks) describing what ships. |
| MVP-A24 | 2.6.G | **Actionable Continue rows (first slice of the actionable strip).** At an empty Home prompt, Down moves focus into the recent sessions; Up and Down move, Enter resumes, Esc returns to the prompt. Run and gate rows stay display-only until the hub milestone. A row from another directory shows that directory and, on Enter, how to open it there. The focused row and the keyless row always stay on screen at 80×24, until MVP-3's row budget replaces this rule. Keyboard-first, inline parity ([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §4). |
| MVP-A25 | 2.6.G | **`/resume` session picker.** In the Home and the in-Home chat: this directory's sessions by default, one key for every directory, type to filter, rows show title and age (and directory when widened). `relavium chat resume` without an id on a TTY shows the same picker before the chat host mounts, then resumes the chosen session as `chat resume <id>` does; `relavium chat --continue` resumes this directory's latest session; non-TTY still requires an id. The standalone `relavium chat` palette does not list `/resume` ([MVP-2 plan](#mvp-2-plan--home-first-2026-11-08), decision 14). |
| MVP-A26 | 2.6.I | **`/providers`, keys slice.** Lists the four providers with key status and key source (keychain, `RELAVIUM_*` variable or a standard variable, never the value), and connects or replaces a key through MVP-A28's masked field. Its description names connecting, logging in and API keys, so the palette (which matches descriptions) finds it by any of those words; the slash set stays alias-free (ADR-0056). Removing and testing keys, custom providers and MCP stay with MVP-9. Key-custody sitting. |
| MVP-A27 | 2.6.J | **Typed key availability** (ADR-0112's approved observation, pulled out of row 16b). A provider's key is usable, missing, unavailable, or found only in a standard variable that the TUI has not been allowed to use (MVP-A6). A locked keychain therefore shows guidance once instead of re-running setup on every launch (#55). Availability is computed when the Home opens and after a key change, never on each strip read. |
| MVP-A28 | 2.6.E | **A native in-TUI prompt host.** Select, confirm, text and masked fields inside the ink tree, abortable, with [ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §7's overlay keys. It can also run on its own before a standalone host mounts. A secret never enters React state, input history, the transcript, the copy hatches or error text. The first-run setup moves onto it from clack-before-mount; its flow logic is unchanged. |
| MVP-A29 | 2.6.E | **In-TUI discoverability and remedies.** Every command MVP-2 adds is in the Home palette with a description and an argument hint; a remedy shown inside the TUI names the in-TUI action, while plain, `--json` and shell output keep the subcommand ([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §6, §9). |
| MVP-A30 | 2.6.E | **The way back on exit.** When the process exits after a session with at least one turn, it prints that session's resume line. |

**Done:** MVP-A1, MVP-A2, MVP-A3, MVP-A4 and MVP-A7 shipped with MVP-1, accepted 2026-11-06 and on `main` since
PR #97 (merged 2026-11-07); the acceptance record is [current.md](../current.md#next-work--the-cli-mvp) item 1.

## MVP-3 plan — Editing, search and reviewable effects (2026-11-11)

**Status: Accepted plan (maintainer, 2026-11-11); implementation in progress.**
Baseline: `6c8a89e1` on `development`, after MVP-2 merged through PR #98.
This is the one home for MVP-3's implementation plan; the existing MVP-2 records
below remain historical. No new branch, dependency, release or history migration
is proposed. Implementation follows `/implement-task`; approval covers the
cross-package public API changes and new in-TUI views listed here.

### Documentation preflight and decisions

The author and three read-only Sol/Terra preflight agents compared the relevant
existing documents with current authority, filesystem/dispatch and both chat
hosts. This was design review, not implementation acceptance. The governing
documents reviewed were ADRs 0029, 0033, 0037, 0055, 0057, 0059, 0062, 0063,
0068, 0069, 0080, 0083, 0086, 0087, 0094, 0095, 0098, 0102, 0105, 0112,
0113, 0116, 0120, 0122 and 0123; the built-in-tool, registry, config, chat,
Home and accessibility references; the relevant standards; 2.6.M, MVP-A8/A9/
A13/A14 and the recorded Wave 3 row 15c split. The ADR corpus was inventoried
in numerical order; this is not a claim that every unrelated ADR or entire
historical phase register received a new full review.

| Confirmed gap or ambiguity | Proposed disposition and canonical home |
|---|---|
| Global mode key, layer precedence, model-writable `--config`, headless mode | [ADR-0116 proposal refinement](../../decisions/0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md#proposal-review--2026-11-11), [config contract](../../reference/contracts/config-spec.md#proposed-starting-chat-mode--mvp-3): explicit global preference, repository `auto` refusal, invocation ceiling and trusted picker. |
| Home clear currently synthesizes a new built-in agent instead of preserving its bound snapshot | Correct to existing ADR-0062 same-agent contract; preserve authored and legacy built-in grants across clear/resume/reseat. Never infer built-in provenance from its id. |
| A ranged/truncated read does not prove the model saw the whole file; prior-turn tool content is not carried | [File-tool contract](../../reference/shared-core/built-in-tools.md#proposed-edit-search-and-ranged-reads--mvp-3): bounded current-turn observed intervals tied to unchanged source bytes. |
| Current approval happens before host write preparation; append can mutate in place | [Registry contract](../../reference/shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3): read-only preparation, exact-byte binding, effect barrier, final gates and atomic publication. |
| Wholly masked changes and Unicode policy were explicitly open | [ADR-0120 proposal refinement](../../decisions/0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md#proposal-review--2026-11-11): deliberate inspection of masked changes, conservative span provenance and escaped/code-point view; separate implementation security sitting remains mandatory. |
| Optional general details timing was unset; full approval view was already mandatory | Include both in Step 2, sharing inspection primitives; no details-browser deferral. |
| Native setup has flushed-frame consent evidence, legacy chat approvals do not | Reuse the acknowledgement/ownership pattern on both chat hosts; dimensions alone never authorize hidden input. |
| Restore currently omits tool rows and budgets only conversation entries | [Chat contract](../../reference/cli/chat-session.md#proposed-mvp-3-interaction-contract): bounded content-free groups, safe call-id correlation and explicit omission counts; no preamble/content restoration. |
| Protected-path prompt wording can imply authority; preview copying can reach disk hatches | Approval cannot override the host's hard denial; keep previews/reveal buffers out of history/export/editor hatches and provide masked in-view copy. |
| Consent zero-width ledger still says excluded from MVP-3 | Correct its scheduling to the mandatory ADR-0120 preview work; shared `[c]` extraction stays with paused Step 14b. |

Two additional independent proposal reviews (GPT-6.1 Sol/high and GPT-6.1
Terra/high) covered the complete nine-document proposal diff and checked its
authority, preview/resource and UI contracts against current code. Verified
corrections distinguished the pre-build design sitting from post-implementation
security, existing authored writes from new grant activation, and intentional
diff pagination from clipped consent controls; revealed masked spans require
acknowledged display. Neither reviewer reported a remaining blocker after those
corrections. Author validation checked all newly added relative links/anchors,
documentation hygiene and unchanged executable inputs; lint/typecheck passed.
This is approval-ready proposal review, not a passed implementation, source-bound
runtime CI or completed pre-build security design sitting.

**Maintainer acceptance — 2026-11-11:** the maintainer directed verification and
correction of two supplied reviews, followed by acceptance of the documents and
continued implementation without another approval stop. Both ADRs, the linked
reference designs and this three-step plan are accepted together. No new ADR
number is needed. Backward-compatibility adapters/migrations are not required
for the unused development product; preserving frozen grants remains a security
rule, not an old-version compatibility promise.

| Supplied finding | Verified disposition |
|---|---|
| Startup-auto admission could survive deliberate narrowing | Fixed in ADR-0116/config contract: shared revocable live authority; narrower reads, errors and confirmed non-auto defaults revoke before replacement/persistence. Failed/stale hosts cannot restore it; explicit current-mode auto is separate. |
| Synthetic whitespace/ending marks could equal literal source | Fixed: all approval tokens share reserved `<...>` syntax; every source `<` is escaped once, with no color dependency. Test literal token/dot/tab pairs on both sides and narrow layouts. |
| Missing final newline unspecified | Fixed: final ending is LF/CRLF/none, explicit unterminated marker, empty/new-file states, newline-only add/remove tests. |
| Expected edit preconditions could end a chat without useful feedback | Fixed: a closed content-free correction refusal is eligible only at the proven read-only pre-effect preparation cut; existing recovering chat paths/budgets apply. User/guardrail denials and uncertain effects remain fatal; MVP-4 denial recovery stays separate. |
| Repository authority claim too broad | Corrected: a repository may request prompting and advertise writes; it cannot choose startup auto or approve for the operator. |
| ADR-0059 reseat forward note missing | Added alongside dated 0037/0055/0057/0062/0063/0105/0112 notes and the security-standard refinement. |
| Built-in id collision and accidental/reflex approval concerns | Step 3 requires an authored `relavium-chat` id negative control; mounted tests verify no implicit/default affirmative and visible current-mode/scope disclosures. No claim that automated tests measure human reflex behavior. |
| Rich preview channel ambiguous | Fixed in registry contract: optional third in-process hook context, separate from closed `ToolApprovalRequest.preview` and durable events; correlated live observer covers auto/read traces. |
| Unicode property availability | Verified locally on Node 22.23.1 and 24.22.2: 14 positive/negative vectors each for C, Z and Default_Ignorable_Code_Point. This supports language-runtime feasibility, not visual or implementation acceptance. |
| Restore stats, MCP preview, related links and command timing | Diff stats explicitly not restored; unaudited MCP previews remain name-only; related decisions/security references added; default command grant explicitly MVP-4. Existing custom-agent command tests remain possible, without activating the new MVP-4 card. |

A separate **pre-build security design sitting** must first
confirm the masked-change/reveal policy and Unicode/inspection contract on the
final approved documents. The general preflight is not a substitute. Its ruling
is recorded here before any approval-card implementation; the later per-step
security sitting tests the actual code as well.

**Pre-build security design sitting — 2026-11-11:** a separate GPT-6.1 Terra/high
review of the corrected accepted documents and existing dispatch/filesystem,
sanitizer and native acknowledgement mechanisms found no blocking design
finding. It confirmed the conservative reveal/acknowledgement rules, single-pass
reserved token alphabet, EOF/empty states, bounded Unicode/code-point inspection,
no universal visual guarantee, exact prepared-byte and journal binding, ephemeral
sinks and shared revocable startup-auto authority. Step 2 card implementation
may proceed under those contracts; existing in-place append, span-losing masking
and legacy approval routing must actually be replaced. SSRF/command/keychain/IPC
changes are outside this sitting. No implementation test or post-code security
acceptance is claimed. A separate Sol/high authority/correction check found no
substantive gap; its remaining stale acceptance/rollback/compatibility wording
was corrected, and this later acceptance is linked from the dated MVP-2 checkpoint.

### Three cohesive implementation steps

The boundaries are dependency and security boundaries. Combining all three would
make filesystem, consent/rendering and startup authority difficult to inspect;
splitting individual tools or screens would repeat reviews of the same seams.
Step 2 deliberately keeps editing, preview, input custody and trace rendering
together: no newly offered edit may exist without its reviewable effect path.

| Step | Deliverable | Principal code and canonical docs |
|---|---|---|
| **1 — Bounded reading, search and session output** | Ranged `read_file`, current-turn read evidence, literal `search_files`, glob `find_files`, visible directory/discovery caps and private bounded output-store provisioning/read/cleanup/sweep. Freeze measured resource limits before tool registration. Keep the built-in default grant unchanged. | Core `tools/types.ts`, `builtins.ts`, `registry.ts`, `bounding.ts`; CLI `engine/tool-host/fs.ts`, `fs-policy.ts`, `assemble.ts`, new focused traversal/output-store modules and session-owner wiring; promote the relevant [file-tool contract](../../reference/shared-core/built-in-tools.md#proposed-edit-search-and-ranged-reads--mvp-3). |
| **2 — Reviewable editing and truthful tool presentation** | After the pre-build design sitting: prepared atomic `edit_file`/`write_file`; typed live previews, bounded in-house diff, full review/reveal and general details; target/diff-stat traces, ordered live assistant segments and safe restored structural groups; both-chat 80×24/input guard and Home row budget. New `edit_file` and the later built-in write grant are enabled only with their complete approval path. Existing authored `write_file` gains that path in this same step; no unrelated workflow/headless grant is removed. | Core engine-side `ToolDef`/dispatch/host capability and curated exports; CLI prepared filesystem writer, preview/diff projection, shared views/reducers/acknowledgement, `session-view-model.ts`, `chat-store.ts`, `chat-ink.tsx`, `home-controller.ts`, `home-app.tsx`, `home-view.tsx`, `restored-transcript.ts` and hatches. Promote [registry](../../reference/shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3) and [chat](../../reference/cli/chat-session.md#proposed-mvp-3-interaction-contract) contracts; update Home/accessibility and view command references. |
| **3 — Enable the built-in agent and startup-mode UX** | Add read/search/find/write/edit grant only after Step 2; truthful prompt; strict mode/hint keys and resolver; shared mode/default picker and writer; invocation ceiling, first-frame mode, headless clamp; fresh/resume/clear/reseat parity and same-agent Home clear correction. Complete integrated milestone verification and documentation. | Shared `config.ts` and curated schema exports; CLI `config/load.ts`, `resolve.ts`, `write.ts`, `chat/default-agent.ts`, mode/session-host owners, `commands/chat.ts`, Home wiring and REPL manifest/palette/help. Promote [config](../../reference/contracts/config-spec.md#proposed-starting-chat-mode--mvp-3), grant/mode and CLI contracts; update roadmap, first-read docs and adjacent ADR notes. |

File lists identify owned seams, not a requirement to edit every named file.
Keep new helpers focused and shared between hosts; do not decompose unrelated
god files or activate paused work merely because a caller is nearby. Core stays
platform-pure; no new runtime dependency or vendor type crosses the LLM seam.
Additive exported capability/preview types, config schemas and curated index
exports are covered by the accepted plan. Missing capability paths fail closed;
no legacy preview/write bypass is retained. Provider wire tool normalization is
reused, not redesigned.

Step 2 also owns the [ADR-0124 replay refinement](../../decisions/0124-inspect-retained-run-effects-before-file-preparation.md):
shared `run.ts`, a shared retained-envelope schema/decoder and curated exports;
core `execution-host.ts`, `engine.ts`, `effect-receipt-health.ts` and registry;
DB `effect-journal-store.ts` and its port; CLI durability forwarding and explicit
test doubles. This remains one cohesive step with prepared writes, not a fourth
increment. Strict evidence validation must gate node scheduling independently
of model regeneration; exact invocation/mapping comparison belongs at replay.
The scoped proposal and supplied-review disposition below govern acceptance.

### Interaction ledger

| Surface | Intended change and boundary |
|---|---|
| Bare Home and its chat | Mode/default settings and live tool details are in the palette; native diff review stays in the app. Geometry changes do not activate run/gate/agent management. |
| Standalone interactive chat/resume | Same mode/settings, approval and details views, inline/no-color parity and safe restoration; no new Home-only management palette items. |
| `/mode` | Bare interactive form becomes a picker; direct name/Shift+Tab remain unsaved per-turn changes. Home bare form configures startup only. Exact semantics live in the chat contract. |
| `/details` | New interactive, read-only view; unavailable historical preview is labelled. Non-TTY/JSON has no overlay or new raw-content dump. |
| New file tools | YAML-selectable through the existing tool registry; no new top-level shell command. Existing read/write arguments keep their meaning; range/edit/search arguments and finite bounds are documented in their single reference home. |
| Headless/JSON and workflow execution | No interactive startup-mode grant or richer display event payload. Headless chat remains `ask`; workflow author trust/effect semantics stay separate. Test existing machine fixtures rather than assuming an in-TUI change cannot leak there. |
| Resume/clear/reseat | Mode is newly resolved; per-instance approvals/read evidence/spills reset. Frozen agent grants remain frozen; starting a new built-in conversation is the upgrade path. |
| Development compatibility | No older-binary migration, alias or compatibility adapter is required; authority floors, frozen grants and current machine-output discipline remain. |

### Acceptance and review loop

Each step is a D64 security-tier increment. The maintainer requested two fresh
independent review rounds per step; that is the chosen process even though the
standing tier's minimum is one clean cumulative round. For each step:

1. Implement with direct negative/failure-path tests; self-review the cumulative
   milestone diff, seams, resource ownership and changed canonical contracts.
2. Run author gates (`pnpm run ci` and `pnpm coverage:enforced`), commit the
   coherent implementation, then launch round 1 with fresh Sol/Terra reviewers.
   Partition the whole cumulative scope into explicit, overlapping-risk-aware
   assignments; do not substitute unrelated sampled files for full coverage.
3. Reproduce/verify findings, fix those that hold, run affected checks and commit.
   Give skipped findings a concrete reason. Run round 2 with new reviewer agents
   over the final cumulative scope, repeat verified fixes and commit.
4. Perform a separate scoped security sitting. An unresolved blocker/high/medium
   or material correction requires fresh complete validation/review of the
   affected cumulative scope; two rounds are not a license to leave a defect.
   No verified MVP-3 issue is deferred merely to save a review. Keep local review
   reports ignored and put concise source-bound acceptance in this register.
5. Push the accepted increment on `development`, observe its CI and automatically
   continue to the next step. Do not switch branches. Stop only for an actual
   blocker or a new decision outside the approved contract.

Required evidence includes real filesystem and host paths, not only mocks:

- Step 1: ranges/UTF-8, binary/secret/symlink/hardlink floors; huge nonmatching
  trees/files/ignore data, finite work and abort; exact skipped/omitted reporting;
  native concurrent-session spill isolation, partial writes, producer shutdown
  and crash sweep, with live/unknown-owner preservation.
- Step 2: unique/replace-all/observed-range rules; replace/append/createDirs and
  stale/retargeted file refusal; journal/dispatch ordering and zero mutations
  on reject/abort; same prepared bytes shown/written. Test masked code/whole
  changes, Unicode/line endings, budget refusal, no-color/code-point inspection,
  all preview sinks, auto/always traces, ordered segments and historical caps.
  Drive both mounted hosts through resize, backpressure, stale-card ownership,
  paste/coalesced input, hidden affirmatives and inline/full-screen parity.
  Include literal marker collisions, empty/new files and final-newline-only
  changes; pin the chosen diff algorithm and finite work/memory budgets.
  Exercise a real SQLite post-settle/pre-checkpoint edit replay with zero file
  preparation/publication or second settle; strict shared decoder and SQLite/
  memory gate parity, including malformed valid JSON before any model execution,
  valid absent values, missing old evidence, same-presence mapping replacement,
  changed destination keys, key-order equivalence and absent versus empty mapping.
  Test saved-result confirmation without new mutation cache authority, both
  replay entry points, projection refusal before lookup, inspection-fault no
  retry/recovery, fencing/producer joins, atomic miss/prepare races and different
  regenerated calls/order without claiming deterministic redelivery.
- Step 3: actual fresh/resume/clear/reseat construction matrix for both hosts,
  authored/legacy agents, strict-layer precedence including shadowed `auto`,
  writable-config escalation, explicit operator auto, failed/stale builds,
  headless/JSON, first-frame footer/policy agreement, approval cache resets,
  hint acknowledgement and preference publication/durability failures.
  Include authored-agent id `relavium-chat`, startup-auto → narrower default →
  model file rewrite to auto, retained old hosts, failed/stale replacements and
  explicit current-mode auto as a separate control. No implicit/default approval.

Use causal negative controls on security gates and deterministic work counters
for complexity; wall-clock evidence supplements them. Keep existing deadlines,
coverage floors and test populations. Re-run the complete combined author/CI
gates at milestone closure, plus applicable native filesystem/secret/Windows
and packaged-consumer gates for the changed surfaces. Do not represent offline
transport tests as a live-provider or physical Windows terminal check.

The failure glyph already shipped in MVP-2. Default `run_command`, new command
approval/denial recovery, interrupt persistence/keymap and finite-ceiling config
remain MVP-4; web is MVP-7, hub content MVP-8, MCP MVP-9, npm release MVP-10.
Todo/`ask_user`, target-scoped approval caching, shared `[c]` extraction and the
rest of paused Wave 3 retain their existing owners. These are existing scope
boundaries, not newly deferred MVP-3 work. At the end, update delivered docs and
open the `development` → `main` PR for maintainer review; do not merge or publish.

### Step 1 delivery and review record (2026-11-11)

The first increment implements bounded ranged reads, literal search, glob
discovery and explicit directory/discovery limits. Native read observations are
staged only for exact, untruncated model-facing results and promoted after the
next model response; same-response sibling calls cannot borrow unseen evidence.
Scopes are private engine identities and are released on every turn outcome.
The built-in chat grant is unchanged; editing remains Step 2.

Native chat/one-shot builders provision isolated private output stores. Opaque
references remain instance-local; store shutdown seals admission, joins actual
I/O and removes only pinned owned entries. Bounded startup maintenance preserves
live, reused and uncertain owners. Partial initialization rolls back only proven
owned entries and reports cleanup uncertainty. Fresh/resume/clear/reseat and
Home teardown share the owning lifecycle, including abandoned builds.

The original author gates cover the executable inputs committed as `9f148c70`:
the complete `pnpm run ci` passes with all 32 changed TypeScript files unchanged
throughout the run. Workspace tests include 7,466 CLI and 4,992 core
passes; the 11 existing CLI and 11 LLM skips retain their platform/provider
conditions. Build/format, isolation, package/bootstrap/CLI/media smokes, 1,031
acceptance-tool tests and the wire, 23 usage, 115 filesystem and 130 secret
mutation controls pass. Fixed/restored runs pass and their negative controls
detect the intended semantic failures. No deadline, population or coverage
floor was reduced. The source-worker import uses strip-compatible TypeScript;
asynchronous host fixtures use isolated homes and explicit readiness.

`pnpm coverage:enforced` also passes on the same unchanged TypeScript inputs;
the existing package-floor scope is unchanged. The required two fresh
independent review rounds and separate implementation security sitting are
pending. Author implementation agents and
the earlier design sitting do not count as those reviews. This entry records
delivered scope, not Step 1 acceptance or whole-MVP-3 completion. Native Windows
CI and real-terminal acceptance are not claimed from the local macOS run.

**Independent round 1 — `3c4211cd..9f148c70`:** three fresh reviewers covered
the entire increment: GPT-6.1 Terra/high on native filesystem behavior,
GPT-6.1 Sol/high on private storage, and a separate Sol/high on core/lifecycle
and canonical docs. Four findings were independently verified; none was skipped.

| Verified finding | Correction |
|---|---|
| Scoped discovery treated a nested ignore file as workspace-root input | Compare its canonical directory with the canonical workspace root, independent of the requested walk's depth; test both ignore names and both discovery tools. |
| A candidate open failure aborted `find_files` | Return the bounded partial result with unreadable/incomplete metadata, preserving cancellation precedence. |
| Initial temp `fstat` failure leaked uncounted files and allowed further admission | Track exclusive creation separately; seal the instance, retain reservations and report uncertainty when no inode pin exists. Never delete an unpinned file. |
| Scratch section claimed native chat had no allocator | Distinguish the implemented session-output lifecycle from the still separate child-artifact foundation. |

Root native probes reproduced both discovery defects and the store quota
failure before correction. Four new regression cases failed on the reviewed
production code and pass after the fixes; the focused native/filesystem/host
matrix passes 329 tests with three existing platform skips. Workspace
lint/typecheck, build/format, test isolation, compiled CLI/bootstrap smokes and
finite bundle closure pass. The fresh second round and separate security
sitting are still pending; Step 1 is not accepted.

**Independent round 2 — `3c4211cd..fc35776a`:** fresh Terra/high reviewed native
filesystem/core/assembly and a fresh Sol/high reviewed private storage and every
lifecycle/caller boundary. The latter was clean (37 focused tests); the former
passed 35 CLI and 236 core tests but found one further completeness defect:
an unsupported ignore file in an ancestor above the selected directory was not
visited. Root independently reproduced `src/.gitignore` with a `src/sub` walk
for both discovery tools; the finding was accepted, not deferred.

The correction checks only admitted ancestors, stops at workspace/grant/confidentiality
boundaries and caps additional ancestor inspection at 32 directories. Nested
ignore presence is checked before directory enumeration, using the filesystem's
actual name resolution rather than guessing filename case. Four regressions
failed before correction and now pass, including extra-root authority and the
depth limit. An additional boundary control caught and corrected an intermediate
scratch-root regression before commit: its protected parent is a boundary, not
an input to inspect or a reason to hide the explicitly granted scratch subtree.
The native discovery suite now has 20 passing tests; the combined native/host
matrix passes 334 tests with three existing platform skips. Workspace
lint/typecheck, build/format, compiled CLI smoke and bundle closure pass. A
fresh clean cumulative round remains due before the separate security sitting
and Step 1 acceptance.

**Independent round 3 — `3c4211cd..04b02024`:** fresh Terra/high covered native
filesystem/private storage and fresh Sol/high covered core/lifecycle/docs. The
latter was clean after 783 tests across 14 suites. The native review found one
cancellation defect: the root-ignore read catch could return incomplete results
after abort. Root reproduced all eight find/search cancellation cuts. The catch
now rechecks abort before error classification, and discovery rechecks before
returning a partial/final result. Eight regressions failed on the reviewed code
and pass after correction; the native/host matrix passes 342 tests with three
existing platform skips. The engine's independent cancellation floor is
unchanged. Workspace lint/typecheck, build/format and compiled CLI smoke pass.
A fresh cumulative review and the separate security sitting remain due;
Step 1 is not accepted.

**Independent round 4 — `3c4211cd..e5ca8a4d`:** a fresh Sol/high reviewer
covered all 35 changed files, their real callers and persistence boundaries;
928 tests across all 17 changed suites passed. Two native-probed medium
findings remained: anchored ignore matching used the lexical workspace alias,
and an existing dangling root ignore link was treated as an absent input.
Root independently reproduced both for find/search. Matching now uses the
canonical workspace root; fixed-name absence is distinguished from resolution
failure after `lstat` proved presence. Four regressions failed before correction
and now pass; the native/host matrix passes 346 tests with three existing
platform skips. Workspace lint/typecheck, build/format and compiled CLI smoke
pass. A fresh clean cumulative review and separate security sitting are still
required before Step 1 acceptance.

**Independent round 5 — `3c4211cd..7f6f2398`:** a fresh Terra/high reviewer
completed all 35 changed files and their persistence/export/ownership callers;
216 focused tests passed. One medium finding remained: late-detected binary or
invalid UTF-8 candidates consumed source reads without charging the search byte
budget. Root independently measured 21,135,360 actual bytes for twenty 1 MiB
late-invalid candidates while the result claimed zero bytes and a complete scan.

Every search descriptor read now observes a shared remaining budget, including
binary probing and failed decoding. Whole-file reads reuse the probe rather than
reading its prefix twice. Three regressions failed before correction and pass
afterward; the native/host matrix passes 349 tests with three existing platform
skips. An independent native descriptor probe now measures exactly 16,777,216
bytes, matching the returned count and explicit `incomplete`/`bytes` limit.
Workspace lint/typecheck, build/format and compiled CLI smoke pass. A fresh clean
cumulative review and separate security sitting remain due before acceptance.

**Step 2 design gate (opened 2026-11-11; closed below on 2026-11-12):**
[ADR-0124](../../decisions/0124-inspect-retained-run-effects-before-file-preparation.md)
was Proposed pending explicit maintainer approval. The existing retained-run
replay path needs a read-only inspection before file preparation to survive the
post-settle/pre-checkpoint crash window without reusing old read evidence or
creating a journal row on an edit precondition refusal. Its independent proposal
review found no blocker; this is not an implementation security sitting. Step 1
continued independently; no Step 2 source change preceded approval.

**Independent round 6 — `3c4211cd..5f35fb1b` (2026-11-12):** a fresh Sol/high
reviewer completed all 37 changed files (including the separately Proposed
ADR-0124/index) and surrounding callers; all 17 changed suites passed 935 tests.
One medium finding remained in glob reads: full-source UTF-8/NUL validation
returned a binary skip before aggregate charging. Root independently measured
20,971,520 candidate bytes read while returning only ten valid text bytes.

Glob admission now charges fully read skipped sources independently of returned
text size. The existing bounded prefix-only binary skip remains separate; the
opened descriptor's size must fit the remaining budget before a full read.
Two new regressions failed before correction, and an in-budget positive control
preserves accurate returned text size. The native/host matrix passes 352 tests
with three existing platform skips. The same native probe now refuses at the
8 MiB aggregate limit after 7,348,224 candidate bytes (including the final
bounded probe); the search probe still stops at exactly 16 MiB. Workspace
lint/typecheck, build/format and compiled CLI smoke pass.

A separate Terra/high implementation security sitting at `5f35fb1b` reported no
security finding after 333 tests. It predates the later glob correction and
does not accept the final increment. A fresh complete cumulative round and a
fresh affected security sitting are required before Step 1 acceptance.

### MVP-3 Step 1 local acceptance (2026-11-12)

The executable Step 1 source at `7df16ec2496877ae3c361aaeaf4d5ce1f018b483`
has completed the requested review/fix cycle with no unresolved finding and no
new deferral. All verified findings from rounds 1–6 were corrected; the original
author gates and their source binding are recorded above. Post-correction
workspace lint/typecheck, build/format, native/host tests and compiled CLI smoke
pass. Test isolation remains intact; no deadline, test population or coverage
floor was weakened.

**Fresh complete cumulative round 7:** Terra/high independently reviewed all
37 changed files and relevant callers, ownership, persistence/export and
canonical contracts. It found zero findings; all 17 changed suites passed
938 tests. Native descriptor probes independently confirmed the glob refusal
and exact 16 MiB search ceiling. The reviewed files remained unchanged.

**New separate implementation security sitting:** a fresh Sol/high independently
reviewed that same final cumulative source, including the glob correction.
It found zero findings after 22 complete suites/1,475 passing tests, zero skips,
and independent native controls for budgets, prefix-only limits, read-receipt
identity/lifetime, private-store permissions, actual producer joins and cleanup.
Its source/caller/sink audit covers the affected security boundaries; unchanged
provider, SSRF, desktop IPC and live keychain paths are not newly recertified.
The prior `5f35fb1b` sitting is historical and does not substitute for this one.

This is local implementation acceptance. Push the checkpoint on `development`
and observe its applicable CI before the next step; native Windows evidence
comes from that CI, not these local macOS tests. Physical-terminal and live
provider/keychain execution are not claimed. Step 2/3 remain unimplemented, the
built-in default grant is unchanged. At this local acceptance, ADR-0124's
separate approval gate remained open; the later design acceptance below closes
it. This does not complete MVP-3 or authorize a merge or publication.

### ADR-0124 review and design acceptance (2026-11-12)

The maintainer supplied two reviews and explicitly directed verification,
necessary corrections, acceptance and continued implementation; no older-binary
compatibility obligation applies. Root and two independent source audits
verified the findings against the current implementation, not their assumed
exploitation scenarios. Read-only runtime probes reproduced the inherited
SQLite/memory gate and registry mapping defects. No Step 2 source was changed.

| Supplied concern | Verified disposition |
|---|---|
| Valid JSON with unusable replay structure passes the node gate | Confirmed in SQLite and memory with `{}`/unknown-version results. One strict shared decoder now belongs in the accepted contract for the gate and both replay entry points; block before model execution, preserving valid explicitly absent values. |
| Mapping presence is weaker than mapping identity | Confirmed directly at the public registry: changed source paths with mapping still present returned the old projection. Bind the exact admitted mapping snapshot and distinguish absent/empty; no migration or guessed old evidence. |
| Claimed CLI YAML-edit impact | Narrowed: current production callers do not supply `outputMapping`, and frozen workflow verification already rejects covered workflow drift. The registry contract defect still warrants correction in this same step. |
| Universal replay/redelivery implication | Corrected: improvement is conditional on reproduced correlation/slot/tool, journal arguments and mapping; different regenerated calls/order retain current bounded guarantees, not logical exactly-once execution. |
| Skip active confirmation on replay | Recommendation rejected: retain existing hook/mode/deny floors with an explicit saved-result delivery card, no current diff and no new mutation-cache authority. Existing actual-dispatch hook remains skipped only because no dispatch occurs. |
| Inspection and post-hit errors | New inspection storage faults are explicitly non-recoverable/non-retryable; conflicts remain effect attention. Preserve cancel/fence precedence and prohibit typed or generic post-hit errors from re-enabling retries. This does not relabel every existing pre-prepare store fault. |
| Session present row should be a miss | Recommendation rejected: a present identity conflicts under ADR-0098; absence alone is a miss. A normal content-free row is not corruption and its result column is never consumed. |
| Signature, eligibility, stable projection and forwarding unspecified | Canonical protocol now owns required miss/replay signature, first-party prepared-hook plus journaled-tier eligibility, prelookup unsettled refusal and projection reuse, explicit fenced/lifetime/receipt/durability wrappers and doubles. |
| Missing related links, reference order and public-API scope | Added ADR-0075/0079/0083 links, dated ADR-0080/0120 notes, shared/DB/core/CLI Step 2 scope, dispatch diagram, exact evidence protocol, current roadmap and regression matrix. The existing map/bound/settle order is accurately recorded. |

A **fresh Sol/high corrected-design/security review** inspected all five
substantive corrected documents and actual source boundaries. It found no
unresolved blocker/high/medium design finding. Its checks specifically include
legitimately absent mapped results and atomic prepare discovering replay after
ordinary approval; the latter must replace the card and must not let delivery
seed/expand mutation `always` authority. This is a design/source inspection,
not runtime evidence for unimplemented behavior or the later implementation
security sitting.

ADR-0124 and its linked public-contract expansion are **Accepted** under the
maintainer's instruction. The original three-step boundary is unchanged; all
replay/evidence corrections belong to Step 2 alongside prepared writes.
Its implementation begins after the Step 1 CI checkpoint. No further design
approval is required for these verified corrections; ordinary implementation,
two fresh review rounds, affected fixes and a separate security sitting remain.

### MVP-3 Step 1 source checkpoint CI (2026-11-12)

The pushed checkpoint `7889737c776f6891f2af046307a3fce06f490556` passed
[CI run 43100476225](https://github.com/HodeTech/Relavium/actions/runs/43100476225):
all 18 jobs succeeded, including all required contexts, complete causal-control
families, exact packed CLI consumers, Windows and the advisory floor/peer jobs.
The primary job verified complete causal/packed/map evidence before workspace
execution, then passed lint/typecheck, every workspace, native DB diagnostics,
build/format, isolation, fences, bundle closure and compiled/offline smokes.
Workspace tests include 7,492 CLI passes/12 existing platform skips and 4,992 core
passes. Coverage independently passed all 860 files, 18,003 tests/23 existing
platform skips, under the unchanged llm/mcp thresholds and measured core scope.

All 15 reviewed production files remain byte-identical to `7df16ec2` through
the later documentation and test/CI-only extension. That extension's affected
local validation and actual Windows execution supplement this complete source
checkpoint; its initial Windows pass does not claim the two newly selected
suites ran. Step 2 follows closure of the native validation clause below.

### MVP-3 Step 1 Windows validation extension (2026-11-12)

The initial pushed checkpoint's Windows job passed its selected existing
filesystem suites, but its explicit selection did not include the new
`fs-mvp3.test.ts` and `session-output-store.test.ts`. Add both to that same
serialized step, retaining all previous cases, failure guards and deadlines.
The expanded command passes locally: 14 suites, 402 tests and ten existing
platform skips. This macOS result is not Windows execution evidence.

A fresh Sol/medium selection review identified one source-backed fixture
portability defect: a self-killed Windows child reports exit 1 with no POSIX
signal, so the unconditionally expected `SIGKILL` was incorrect. Root verified
the installed Node runtime's upstream libuv implementation. The fixture now
requires synchronous post-publication readiness, no spawn error or stderr,
and the strict platform-specific termination result. Actual crashed-owner
reclamation and live-owner preservation remain unchanged and unmocked.

A new Luna/high review found no issue in the corrected test/CI scope. The two
complete native suites pass 63 tests; workspace lint/typecheck, build/format
and the final expanded 14-suite selection pass. Application production sources
remain identical to `7df16ec2`; no population, coverage floor or case/job timeout
was weakened and no new skip was introduced.

**Native validation closed:** on `ee50195b56f2b313e19acec1d574d8e9c2d70bb1`,
the [extended Windows job](https://github.com/HodeTech/Relavium/actions/runs/43110550553/job/130825105102)
passed its complete 14-suite selection: 393 tests and 19 existing platform
skips. This explicitly includes all 25 output-store tests and 37 native
MVP-3 filesystem passes with its one declared POSIX-permission skip. The job's
other native suites and headless smoke also pass. These are actual Windows
results, separate from the local counts above.

Together with the complete 18-job source checkpoint, this closes Step 1's
implementation/review/security and affected CI validation. Application sources
were unchanged between those checkpoints. The later full CI repetition at
`ee50195b` completed with the actual Windows extension green, but six causal
jobs stopped before their controls because the exact Windows scheduling guard
still expected twelve files; the dependent primary job consequently skipped
its workspace checks. Commit `e82a4a95` aligns that guard with all fourteen
intentionally selected files, preserving exact equality, existing cases and
bounds. Its seven scheduling tests, lint and formatting pass locally; two new
independent reviews (Terra/medium, Luna/high) found no issue in that exact
guard-only correction. Replacement CI is required; the failed repetition is not recorded
as green causal or workspace evidence. Step 2 source work continues on
`development`; whole-MVP-3 acceptance, final combined CI and PR review remain open.

**CI repetition and bounded diagnostics:** the full repetition at `e82a4a95`
completed with sixteen jobs passing. Filesystem causal shard 2 stopped at
`invocation-forward`'s mutated phase because the runner reported two unhandled
errors; the dependent primary job did not run its workspace checks. Intended
semantic mutation failures alone do not satisfy that control. The retained
receipt exposed only the error count, so the original Linux/Node 24.22.2 cause
remains unknown. Isolated fixed/mutated/restored repetitions on macOS and
Linux/Node 24.22.3 did not reproduce those errors; they are not equivalent to
the original CI population.

Commit `2d9c3a42` adds bounded allowlisted error kinds and manifest-owned source
locations to forensic stderr, with no raw message, cause, stack or private
root. Its synchronous sink cannot leave a late write error after the receipt.
The strict completion protocol and zero-unhandled gate remain unchanged.
Invocation fixtures now always terminate and join in `finally`, including
assertion failures; that verified cleanup gap is not attributed as the cause
of the original errors. All 194 tool tests and 19 invocation tests pass
locally. New independent Sol/high and Luna/high reviews and a separate
Sol/high security sitting found no issue in the six-file increment. The
[replacement CI](https://github.com/HodeTech/Relavium/actions/runs/43128764609)
then correctly refused three stale coordinator-test assertions that still
required empty stderr. Its causal controls did not run. Commit `cbf4f2f4`
asserts the exact allowlisted diagnostic, fixture-owned source frame and
absence of raw markers/private fixture prefixes, preserving receipt refusal,
hash restoration and cleanup assertions. An isolated committed-source copy
with physically installed frozen dependencies passes all 1,037 acceptance-tool
tests, with no skips; scoped lint/formatting pass. Fresh independent
Terra/medium and Luna/high reviews are clean. The
[new repetition](https://github.com/HodeTech/Relavium/actions/runs/43131456310)
completed all eighteen jobs successfully at `cbf4f2f4`, including both
filesystem shards, all causal families, coverage, Windows and the four installed
consumers. This validates that committed checkpoint, not the later Step 2
implementation. The original two unhandled-error identities remain unknown;
the passing repetition does not establish their cause.

### MVP-3 Step 2 implementation start (2026-11-12)

The three-step boundary stays unchanged. Parallel authors own coherent backend,
native filesystem and shared UI areas within this one increment, with root
integrating CLI/session/command wiring. Core preparation/preview types are
agreed first. The UI reuses the existing `@relavium/llm/scrub-secrets` rule
authority through an additive original-mask-range helper; no second credential
rule set, runtime dependency or LLMProvider wire/type change is introduced.
Always answers remain provisional through atomic replay resolution, using a
narrow in-process approval-decision lifecycle rather than making the preview
or display observer an authorization channel. These are implementations of the
accepted span-preservation and replay-cache floors, not a new product decision.

**New metadata design gate:** a separate source/security audit reproduced an
ACL-denied append becoming a successful mode/uid/gid-only replacement, with ACL,
quarantine and custom-xattr loss on macOS. Historical overwrite behavior is not
authority for that new append behavior. The prototype is not native-security
accepted. [ADR-0125](../../decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md)
and its proposed metadata contract define a preserve-or-refuse host-native
boundary and explicit native-source/build/packaging exception for maintainer
review. No Rust/native package implementation precedes approval. Backend/UI and
other independent integration work can continue; metadata-dependent publication,
Step 2 author acceptance and the Step 3 grant remain gated.

The corrected proposal received a separate Sol/high read-only review with no
finding blocking maintainer direction approval. It explicitly limits effective
access checks, metadata visibility, native dependency families and delivery
targets; Windows replacement candidates cannot bypass the existing atomicity
contract by relabeling known partial failures as uncertainty. This is proposal
review only: exact supported profiles, pinned/audited inputs, actual native and
packaging proofs, fresh implementation reviews and a separate native security
sitting remain due after approval.

### ADR-0125 supplied review and design acceptance (2026-11-12)

The maintainer instructed verification/correction of the supplied reviews,
then design acceptance and continued implementation, with no compatibility
obligation for the unaccepted prototype. ADR-0125 and its canonical metadata
contract are **Accepted** under that instruction; native implementation and
whole-Step-2 acceptance are separate and remain open.

- **Durable overwrite uncertainty:** source inspection confirmed overwrite/new
  `write_file` calls had no row. Every variant now requires tier-3 durability in
  the accepted design, including empty/unchanged content. Existing strict-v2
  inspection/resume and session non-replay apply; no adapter journal or guessed
  old receipt is added. Missing-journal embedding paths refuse. A stale source
  comment is not evidence of a registered `--no-history` CLI flag.
- **Creation and recovery:** bind/revalidate OS-derived destination inheritance,
  parent/default ACL/group/mask/credential inputs and admitted parent creation.
  Named stages require bounded private ownership evidence before payload,
  exclusive safe orphan cleanup and preservation of live/unknown owners. The
  canonical contract defines timing, budgets and operator recovery. Owner-only
  OS permissions also require an enforceable cross-host/process model-filesystem
  exclusion for stages and aliases; otherwise placement refuses.
- **Delivery/governance corrections:** lazy loading, original path/scope floors,
  non-root ownership refusal, quarantine/Zone.Identifier, Cargo cooling review
  and guide/principle forward notes are explicit. The new adapter is the third
  native component. Its no-compile/no-extra-download rule does not describe
  SQLite's existing prebuild/node-gyp or keyring's optional-package installation.
  Eight targets are the new component's proof obligation, not an inferred
  historical CLI support list. The unsafe prototype is no fallback obligation.
  Node-API 8 is conservative; 9 also supports the exact Node 22.0.0 floor.
- **Evidence scope:** the tracked developer probe was independently rerun by
  root on non-root macOS arm64/Node 22.23.1. It verifies direct append refusal
  and metadata loss under historical replacement/copy algorithms. Earlier
  inline probes were likewise OS/algorithm experiments, not complete-host or
  native adapter tests. No successful flags or Windows execution is inferred.
  The [canonical receipt](../../reference/cli/native-filesystem-metadata.md#baseline-reproduction)
  owns the reproducible command and exact observation limits.

A fresh Sol/high complete design review found no remaining material issue.
An independent Terra/high authority review found the named-stage model-access
gap; after the explicit exclusion/refusal and consumer-proof correction, its
affected re-review was clean. These are design reviews only. Concrete native
profiles/allowlists, pinned/audited inputs, actual native and exact-artifact
proofs on all enabled targets, two fresh implementation rounds and a separate
native security sitting remain required. No native component was implemented
before this design approval.

### MVP-3 Step 2 author checkpoint (2026-11-12)

The implementation now joins prepared edits/writes, strict retained-result
inspection, native metadata-preserving publication and the shared approval/detail
views in one increment. Every model `write_file` variant and `edit_file` claims
tier-3 evidence before directory/stage creation or publication. Resume rejects
unusable retained results before node execution, and replay binds the exact
mapping configuration. Saved-result delivery preserves policy/confirmation floors
without inventing a current diff or granting future mutation approval.

Both chat hosts use engine-call-correlated live rows, preserve assistant text
between calls and offer the same bounded full-review/details view. Inspection
tracks original spans and actually flushed frames, including masked-only changes;
raw/revealed previews remain in process memory and are sealed on departure.
Restored tool groups retain structural outcomes rather than preview content.
The new default editing grants and starting-mode work remain Step 3.

The [native metadata contract](../../reference/cli/native-filesystem-metadata.md)
owns the frozen platform profiles, creation inheritance, staging/index proof,
operator recovery, dependency audit and evidence limits. Local native execution
covers macOS arm64/APFS (28 Rust parent cases, three parent-owned child fixtures
and eleven Node lifecycle cases) and non-root Linux arm64 GNU/musl profile runs.
The real workflow/SQLite/native regression cohort has 23 cases covering claims,
publication/settlement cuts, saved results, malformed evidence, identity changes
and provisional `always` decisions. Native-unit kill cuts separately exercise
partial metadata and payload; they are not whole-workflow cuts inside the native
producer. Windows cross-checking is not Windows runtime proof.

Author verification passed workspace lint/typecheck and all 18,303 tests, with
22 existing skips; build/formatting, test isolation, DB sync, seam/dependency
fences, bundle closure and compiled CLI/bootstrap/media/overflow/budget smoke
also passed. The permanent usage cohort grows from 449 to 452 only because
`chat.test.ts` adds one plain `/details` case and a two-case interactive/plain
integration table; its 71 native children and deadlines are unchanged.
Required coverage/Windows contexts explicitly fail when native production fails,
rather than becoming dependency-skipped successes.
All 1,068 root acceptance-tool tests pass without skips; final tools typecheck,
lint and focused formatting checks pass as well.

The source remains unaccepted. The running complete coverage gate, final
two fresh implementation review rounds, separate native
security sitting, all eight actual native target receipts and all four exact
installed-tarball consumers remain to be closed. A current-host development
asset is not a complete release inventory and cannot pass packing. The existing
publication guard remains in force. No Step 3 grant or whole-MVP-3 completion
is implied by this author checkpoint.

### MVP-3 Step 2 first implementation review corrections (2026-11-12)

The author checkpoint is `4ba04e1f`. Fresh Sol/Terra agents reviewed backend,
native/delivery and UI areas. Their reports are review evidence, not authority;
root checked the actionable cases against the implementation before changing it.
The native read did not claim a complete security verdict. The following verified
issues are corrected together, without changing the three-step plan:

| Finding | Correction and evidence |
|---|---|
| Empty inheritance templates could escape ownership on normal pre/post-move or adoption failures | A held-identity guard owns each exclusively created template immediately; a trusted synchronous callback transfers ownership before post-move validation. Exact empty-object cleanup is tested through 132 repeated failures; links, swaps and uncertain cleanup preserve evidence. Three additional parent controls run on every native profile. |
| Approval cards omitted the governed tool and action | Both shared views measure escaped mandatory identity/action rows, including saved-result delivery, and refuse incomplete identity evidence. Undeclared tools still expose name-only previews, never enumerated arguments. |
| External suspension could revive prior frame/reveal evidence | Actual suspend entry and reclaim invalidate review state; custody loss discards acknowledged and pending frame evidence. Held-redraw tests exercise both real host wrappers. |
| Explicit review copy inherited mouse-selection preferences | An independent review clipboard capability remains wired in inline/no-mouse/disabled-selection modes; automatic copy preferences keep their original meaning. |
| A retained summary was inaccessible after absent/evicted preview | Summary-only details explicitly disclose the unavailable preview and retain masking, bounded selection and truthful outcome/identity. |
| An output-root alias could write staging index evidence | The captured index boundary now rejects lexical/canonical descendants before creation and opened index/record/lock identities. Actual `createCliHost`/DB writes preserve the lock and refuse new records/directories while ordinary writes succeed. |
| Diff chunk yields stayed entirely in the microtask queue | A host `yieldControl` capability supplies a real event-loop turn. Missing capability refuses and releases preparation. Actual timer cancellation and joined release tests prove no approval, claim or dispatch occurs after cancellation. |

The first complete coverage run reached all 873 files but failed one existing
surface-acquisition test: it expected the second close after one `setImmediate`,
before asynchronous host teardown necessarily joined. An isolated repetition
failed the same assertion on another surface. The fixture now waits for the exact
second attempt within its existing wait bound; native-open, owner, signal,
finite-exit and unsettled-result assertions remain unchanged. All 38 related
tests pass. A complete final-source coverage run is still required; this failed
run is not coverage acceptance.

The [author-source CI](https://github.com/HodeTech/Relavium/actions/runs/43142517047)
executed six macOS/Linux native profiles successfully. Both Windows builds and
protocol probes succeeded, but the first selected native Rust case failed; its
exact stage was not retained by that version of the validator. Dependent
controls did not run, and the required aggregate/coverage/Windows contexts
correctly failed instead of passing by skip. The validator now emits bounded
fixed case/checkpoint/source-coordinate diagnostics without raw child output.
Source inspection separately confirmed a documented access mismatch:
directory handles later passed to `FlushFileBuffers` lacked its required write
access. Corrected opens retain inspection rights and request that OS-checked
access without mutating directories or ignoring failed flushes. A native
Windows parent test now includes actual flush and denial checks. This correction
does not establish the cause of the previous failure or prove NTFS durability;
both actual Windows legs remain required.

The local macOS profile now passes 31 parents plus eleven Node lifecycle cases,
with three child fixtures exercised by their parents. Non-root Linux GNU/musl
cleanup controls pass; Windows source cross-checking supplies no runtime proof.
The Windows source cohort also grows from fourteen to twenty serial files to
exercise the new prepared writes, mask helper, inventory/namespace guards,
workflow replay cuts and actual host output guard. Deadlines and old cases are
unchanged. The permanent usage cohort grows from 452 to 455 solely for three
explicit-copy command regressions; all 71 native children remain required.

After these corrections, workspace lint/typecheck and all 18,335 tests pass.
The 23 skips comprise the prior 22 plus the new Windows-only index-spelling
control on the local macOS run; that control is included in the expanded
Windows cohort. Build/formatting, 874-file isolation, DB sync, tools
typecheck/lint and seam/dependency fences pass. The original UNC-before-I/O
controls also remain strict: raw input is rejected before the newly captured
trusted-home canonical path is resolved.
All 1,072 acceptance-tool tests pass on the frozen source. Bundle closure,
177 compiled bootstrap controls and the real compiled workflow write/journal
smoke pass with the current-host native artifact. This is source/build evidence,
not a complete eight-target or installed-tarball acceptance.

Fresh complete affected reviews, the separate security sitting and final
combined/native/installed-consumer evidence remain open. Step 2 is not accepted,
and Step 3 grants are not enabled.

## MVP-2 plan — Home-first (2026-11-08)

On 2026-11-08 the maintainer set the CLI's direction (D73): the user types `relavium`, lands in the full-screen
Home and does everything there; subcommands stay for scripts.
[ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) records it. This section is the one home
for MVP-2's scope, slices, decisions and acceptance under that direction.

**Completion receipt — 2026-11-11:** all four approved steps, review corrections
and combined verification are complete and merged to `main` through PR #98;
see the [merge checkpoint](#mvp-2-merge-checkpoint-2026-11-11).
The dated research, preflight and initial verification notes retain their
historical baseline; the acceptance records establish the delivered state.

The plan rests on three pieces of research:

- the [terminal agent CLI UX benchmark](../../analysis/cli-ux-benchmark-2026-11-08.md) of eleven current products;
- a map of what the Home can reach today: 3 of 25 leaf subcommands fully, 8 partly;
- a technical read of every MVP-2 item against the code at `0ef53496`.

The maintainer delegated the non-major decisions on 2026-11-08. Those taken are listed below with their evidence,
and the maintainer ruled the major ones the same day: D75 (the hub milestone runs right after MVP-4) and D76
(2a's tier), with ADR-0114 and ADR-0122 accepted. They are in [current.md](../current.md#wave-gating-decisions).

### What a user gets

1. **A first run that never ends in an error.**
   - With no key, `relavium` opens setup inside the TUI.
   - A provider key found in the environment is offered, not adopted silently.
   - Skipping setup leaves a persistent line on the Home that opens setup again.
   - A locked keychain gets one clear message, not a setup loop.
2. **Keys managed inside the TUI.** `/providers` shows each provider's key status and where the key comes from, and
   connects or replaces a key through a masked field.
3. **Sessions resumed inside the TUI.**
   - The Home's recent sessions can be opened with the keyboard.
   - `/resume` opens a picker for this directory.
   - A resumed session shows its conversation.
   - Leaving prints the way back.
4. **A project set up inside the TUI.** `/init` shows exactly what it will create and creates `.relavium/`.
5. **A readable transcript.** Markdown with tables, word wrap, tabs that keep the layout, and tool rows that show
   failure.
6. **Shell hygiene.** Extra arguments are refused, and `agent run` says when it is waiting for stdin.

### Scope

| Item | In-TUI form | Shell form | Slice |
|---|---|---|---|
| Typed key availability (MVP-A27) | One-time guidance when the keychain is unavailable | Same | 2b |
| Standard env-var keys (MVP-A6) | Ask-once card; source shown in `/providers` and `/doctor` | Used directly | 2b |
| Native prompt host (MVP-A28) | Select, confirm, text and masked fields | — | 2b |
| First-run setup (MVP-A5) | Setup on the prompt host, inside the Home | Interactive `relavium chat` with no key runs the same setup before the chat mounts | 2b |
| `/providers` keys slice (MVP-A26) | `/providers`, found in the palette by "connect", "login" or "key" | `provider` unchanged | 2b |
| Keyless nudge (#51, row 16b) | A row on the Home; Enter opens setup | — | 2b |
| Project init (MVP-A18) | `/init` with a confirm card | `relavium init` | 2b |
| Resume repaint (deferred `chat-resume` entry) | The resumed chat shows its conversation | `chat resume <id>` too | 2c |
| Session picker and continue (MVP-A25) | `/resume` | `chat resume` without an id shows the same picker before the chat mounts; `chat --continue` | 2c |
| Actionable Continue rows (MVP-A24) | Down, Enter on a recent session | — | 2c |
| Way back on exit (MVP-A30) | — | One resume line on exit | 2c |
| Markdown rendering (2.6.E, [ADR-0114](../../decisions/0114-in-house-markdown-rendering-for-the-chat-transcript.md)) | Transcript | — | 2a |
| Full-screen word wrap (#61) | Transcript | — | 2a |
| Tab expansion (#65, row 15a) | Transcript | — | 2a |
| Failure mark (MVP-A8, the mark only) | Tool rows | — | 2a |
| Excess positional arguments refused (row 10b) | — | Every non-variadic command | 2a |
| `agent run` stdin hint (#24, row 17a) | — | One stderr line on a TTY | 2a |
| Discoverability and remedies (MVP-A29) | Palette entries; messages name in-TUI actions | Unchanged | each slice |

### Slices and order

- **2a — A readable transcript.** The order is #65, then #61, then MVP-A8, then markdown, plus row 10b, #24 and
  the copy toast (decision 13).
  - #65 and #61 come first because ADR-0114's layout reuses their tab rule and word wrap.
  - ADR-0114 was accepted on 2026-11-08, so markdown can start once #65 and #61 have landed.
  - **Tier (D76, ruled by the maintainer 2026-11-08):** D64's milestone review, plus a scoped security sitting on
    the markdown parser's bounds, link display and sanitize order. The parser handles untrusted model text on every
    frame.
- **2b — First run in the Home.** The order is MVP-A27, MVP-A28, setup moved onto MVP-A28, MVP-A6, MVP-A26, #51,
  MVP-A5, then MVP-A18 with the project-folder fix (decision 9).
  - MVP-A6 comes after the prompt host, so no state on `development` ever adopts a standard variable silently.
  - **Tier:** D64's security tier (keys and secrets, filesystem writes), with one key-custody sitting covering
    both.
- **2c — Sessions in the Home.** The order is the transcript projection and repaint, MVP-A25, MVP-A24, then MVP-A30.
  - **Tier:** D64's security tier (the resume path).

2a has no dependency on 2b or 2c and goes first. 2b precedes 2c because a first run comes before a resume in the
user's journey.

### Decisions taken (2026-11-08)

1. **Every MVP-2 item gets an in-TUI form, re-hosting the same core** ([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md)).
   One-shot scripting commands (`agent run`) keep a shell-only fix.
2. **Credentials.**
   - **Order.** The resolution order stays as ruled: keychain, then `RELAVIUM_<PROVIDER>_API_KEY`, then the
     standard variable.
   - **Names.** Only the four names in MVP-A6 are read. `GOOGLE_API_KEY` is not read, because it commonly holds
     non-Gemini Google keys.
   - **Custom endpoints.** A standard variable is never applied to a provider configured with a custom
     `base_url`. Otherwise an ambient key could be sent to an arbitrary gateway.
   - **The TUI asks once** before using a standard variable. "The TUI" means the Home and an interactive chat
     session.
     - **The card.** It reads, for example: "Found ANTHROPIC_API_KEY in your environment. Use it for Anthropic?",
       with the choices use it, enter a different key, or not now.
     - **Where the rule is enforced.** In the key resolver, not only at the card. The TUI's resolver returns no key
       for a provider whose standard variable has not been allowed; MVP-A27 reports that provider as "found in the
       environment, not yet allowed". Every egress inside the TUI shares that resolver: chat, the `/models`
       refresh and `/doctor --deep`.
     - **The answer.** It is a global-only preference per provider, written through ADR-0063's config-write
       contract. It is never read from project or workspace configuration, so a cloned repository cannot grant
       it. It stores the variable's name, never its value. Extending ADR-0112's operator-owned onboarding state
       this way gets a dated note on ADR-0112 in slice 2b.
     - **Evidence.** Codex CLI and Gemini CLI pre-fill instead of authenticating silently, and Claude Code asks
       once. Codex and Claude Code were re-checked against source and docs; Gemini comes from a source read. A community issue on Claude Code's tracker reports users surprised
       by env-key billing (#9699).
   - **Subcommands use a standard variable directly.** That covers `run`, `agent run`, `models refresh`,
     `provider test`, and plain and `--json` chat: these are the scripting surface. `RELAVIUM_*` variables keep
     their direct use everywhere.
   - **Source shown.** `/providers` and `/doctor` show each key's source by name, never its value.
3. **Setup lives inside the TUI.**
   - The first-run wizard's flow logic stays as it is. It moves from clack-before-mount onto the native prompt host
     (MVP-A28).
   - That gives one look, works in the inline renderer, and lets `/providers` and the keyless row re-enter it.
   - The alternative, running clack under a suspended screen, was rejected. It is unproven on Windows, and the
     screen flips away and back.
4. **Key management in MVP-2 is a slice of `/providers`:** status, source, connect and replace. Removing and
   testing keys, custom providers and MCP stay in MVP-9; until then, `/doctor --deep` inside a chat tests keys.
   - **Name.** The command is `/providers`, and the slash set stays alias-free (ADR-0056).
   - **Discovery.** Its palette description names connecting, logging in and API keys. The palette filter already
     matches descriptions, so a user typing "connect", "login" or "key" finds it.
5. **Session scope.**
   - **Scope.** The picker shows sessions whose working directory is this directory, the default in Claude Code,
     Codex CLI, Kimi and Grok Build. One key widens to every directory. Typing filters titles.
   - **Rows** show the title and age, plus the directory when widened.
   - **`--continue`** resumes this directory's latest session. With none, it says so and exits 2.
   - **Non-TTY.** `chat resume` without an id still exits 2.
   - **Other directories.** Resuming another directory's session from inside the Home is not in MVP-2, because
     the Home's filesystem authority is anchored at launch. Applies to the picker and to the Home's Continue rows
     (MVP-A24), which list recent sessions from every directory.
     - Such a row shows its directory. On Enter, it shows how to open the session there.
     - `relavium chat resume` without an id is different: its picker runs before the standalone host mounts, and
       that host re-derives the session's own workspace authority, as `chat resume <id>` does today. Every
       directory's sessions can therefore be resumed from the shell.
     - In-Home re-anchoring is a recorded follow-up.
6. **Repaint.**
   - **Both renderers repaint.** The inline renderer gets a first-mount restore, because its `<Static>` cannot take
     the seed the full-screen renderer uses.
   - **What is shown:**
     - user prompts in their displayed form, where an attachment appears as its marker and never as the attached
       content;
     - assistant answers;
     - saved-context dividers following the [approved restore-display contract](../../reference/cli/chat-session.md#proposed-restored-transcript-display--mvp-2)
       (2026-11-09 qualification): archive, summary and later-trim regions are
       distinguished, and memory policy determines the next request. A trim may
       preserve an earlier summary; no blanket "earlier turns are unseen" claim.
   - **What is not shown:**
     - restored turns carry no per-turn usage line, because none is stored;
     - tool rows are not repainted in MVP-2; existing content-free structure is
       already stored. MVP-3 owns richer tool-row presentation.
   - **Bounds.** A resume restores at most the last 500 entries into the full-screen renderer and at most the last
     200 into the inline renderer. opencode's inline mode uses the same 200.
     - The first restored line counts the entries left out. They stay in `history.db`, and the model's context
       follows the existing restore rules, so nothing is lost.
     - Paging older entries in on scroll, as Codex does, is a follow-up.
     - **Qualified 2026-11-09:** the caps bound only the initial restored prefix,
       including notices/dividers/placeholders. New live entries append under
       existing behavior; caches track retained view entries. No permanent live
       store ceiling or archive byte bound is claimed.
   - **Shared rules, distinct projections (corrected 2026-11-09).** Archive
     display ignores the drop boundary, while model restore honors it and omits
     empty assistant terminal text. Both reuse shared turn rules and compatible
     legacy context. Verify their defined identity/order relationship before
     UI capping and request folding, then independently verify display substitution
     and the authored memory projection. No raw equality between the capped
     archive display and model context is required. Exact tests and dividers live
     in [chat-session.md](../../reference/cli/chat-session.md#proposed-restored-transcript-display--mvp-2).
7. **Actionable rows (MVP-A24).**
   - Down at an empty Home prompt focuses the recent sessions, Enter resumes, and Esc returns. The footer shows the
     key.
   - It is keyboard-first: mouse capture stays off on the landing, as [home.md](../../reference/cli/home.md) records.
   - Only session rows are actionable in MVP-2. The rows carry the session's working directory, so a row from
     another directory follows decision 5.
   - **Small terminals.** MVP-2's provisional Home budget keeps the prompt, the
     keyless row (#51) and the focused row visible at 80×24: management lists trim
     and scroll first, and long diagnostics page without source loss. The
     [Home reference](../../reference/cli/home.md#minimum-terminal-size) owns the
     delivered behavior. MVP-3 retains the wider strip/browser geometry work.
8. **The way back (MVP-A30).** On exit after a session with at least one turn, one line names both ways back: run
   `relavium` and use `/resume`, or `relavium chat resume <id>`. Crush and Gemini CLI print the same kind of line.
9. **Project init.**
   - **One core.** `/init` and `relavium init` share one core. It creates `.relavium/workflows/` and
     `.relavium/agents/` in the working directory.
   - **No files.** It writes no config file, because an empty `project.toml` has no effect.
   - **Safety.** It never overwrites, refuses a symlinked `.relavium`, and reports "already initialised" when the
     folder exists (exit 0).
   - **Confirm card.** In the TUI a card lists exactly what will be created before anything is written. The shell
     command is explicit, so it prints what it created.
   - **Nested projects.** Inside an existing project, `init` names that project's folder instead of nesting
     another.
   - **Pre-existing defect fixed here.** The upward search for a project's `.relavium/` reaches the global
     `~/.relavium` from any directory under the home folder that has no project folder of its own. It was
     verified on 2026-11-08 against `findProjectConfigDir`. The effects:
     - `/export`, `create` and `import` write workflows into the global folder;
     - `relavium list` shows them from every such directory;
     - a `workspace.toml` or `project.toml` there would load as project config everywhere.

     **The fix: the global configuration folder is never a project folder.**
     - The upward search stops before it.
     - The fallback that names `<cwd>/.relavium` does not apply when the working directory is the home folder
       itself. That fallback is used by `resolveProjectConfigDir` and the chat's `/export`.
     - At the home folder, `init`, `create`, `import` and `/export` refuse with a remedy: run them in a project
       directory.
     - Workflows and agents already authored into `~/.relavium/workflows/` or `agents/` are left in place and are
       no longer discovered from projects. `relavium list` and `/doctor` name the folder and say how to move its
       files into a project with `relavium import`, while it holds any. The product has no users yet (D72's
       reasoning), so no migration is built.

     Recorded in [deferred-tasks.md](../deferred-tasks.md).
   - **Not in MVP-2.** Writing an `AGENTS.md`, which most products' `/init` does with the model, belongs to MVP-5's
     project instructions (MVP-A16), which can extend `/init`. No unsolicited "initialise this project?" prompt:
     Relavium users often chat in directories that are not projects.
10. **Tool rows.** A success shows `✓` and a failure `✗`, by glyph as well as colour. The `agent:tool_result` event
    already carries `success`; the view ignores it today. An interrupted state needs persisted tool rows (MVP-3).
11. **Markdown** follows [ADR-0114](../../decisions/0114-in-house-markdown-rendering-for-the-chat-transcript.md)
    as revised on 2026-11-08. Tables render as a grid when they fit, and a streaming table is held back until it
    ends.
12. **Shell hygiene.**
    - **Excess arguments.** Every non-variadic command refuses extra positional arguments, and Commander's message
      names counts, not values. A mistyped subcommand keeps its error and never opens the Home.
    - **`agent run`.** With a TTY on stdin it writes one stderr line: "reading the prompt from stdin — finish with
      Ctrl-D (Ctrl-Z, Enter on Windows); for an interactive session run `relavium`".
13. **The copy toast tells the truth** ([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md)
    §8). Copying goes to the clipboard over OSC 52, which a terminal can drop without telling anyone. Today's
    `✓ Copied` toast therefore claims more than Relavium knows.
    - In 2a the toast wording says the copy was sent to the terminal's clipboard, not that it arrived.
    - A local write failure is reported as a failure.
    - Using a platform clipboard tool first, which can confirm the write (Kiro does this), is a follow-up.
14. **Where the new commands live.**
    - `/resume`, `/providers` and `/init` are Home-tree commands: they run in the Home and in a chat started from
      it.
    - The standalone `relavium chat` host does not list them. The registry gains a surface value that tells the
      in-Home chat from the standalone host. The research flagged this two-host risk: building every overlay twice
      is the cost the Home-first direction avoids.
    - The two shell entries that need these screens run the shared components before the standalone host mounts:
      setup for a keyless `relavium chat`, and the picker for `chat resume` without an id.
    - Whether the standalone host should become an entry into the Home tree is ADR-0122 §5's open consolidation.
      MVP-2 records the measured cost of keeping it: three commands missing from its palette.

### Contract changes in MVP-2

[ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §2 keeps every invocation a subcommand
accepts today byte-identical on its machine surface (`--json` and plain stdout, non-TTY behaviour, exit codes). MVP-2
changes the following, each under [ADR-0110](../../decisions/0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md)'s
compatibility rules. "TTY" means an interactive terminal on both stdin and stdout, without `--json` and outside CI:
the same gate that opens the Home.

| Change | Today | TTY | Non-TTY or CI | `--json` | Basis |
|---|---|---|---|---|---|
| `chat resume` without an id | Exit 2, missing argument | Shows the session picker, then resumes the chosen session as `chat resume <id>` does, with its exit codes | Unchanged: exit 2 | Unchanged: exit 2 | ADR-0122 §5 |
| `chat --continue` (new flag) | Unknown option, exit 2 | Resumes this directory's latest session | Same as `chat resume <id>` with the resolved id; exit 2 when none exists | Same as `chat resume <id> --json`; exit 2 when none exists | Additive |
| `relavium chat` with no usable key | Exit 2 with the MVP-A4 remedy | Runs setup before the chat mounts, then the chat; cancelling setup exits 2 with the same remedy | Unchanged | Unchanged | MVP-A5 |
| Extra positional arguments on a non-variadic command | Silently ignored, except `run` and `media prune-temporaries` | Exit 2 invocation error naming counts, not values | Same | Same | ADR-0110, "invalid grammar refuses" (row 10b, D65). **The one deliberate break for invocations accepted today** |
| `agent run` with a TTY on stdin | Waits silently | One stderr hint line, kept under `--quiet` (the Step 17 ruling) | No change: stdin is piped | Stdout unchanged; the hint is stderr | #24 |
| `relavium init` | "Not available yet" | Creates `.relavium/` and prints what it created; refuses at the home folder | Same | Its result shape is defined in commands.md with the code | MVP-A18 |
| `create`, `import`, `/export` with no project folder | Write into the global `~/.relavium/` when run under the home folder | Write into `<cwd>/.relavium/`; refuse at the home folder itself | Same | Same | Decision 9 (a defect fix) |
| The way back on exit | Nothing | One line after an interactive session ends | Never printed | Never printed | MVP-A30 |
| Remedies shown inside the TUI | Name subcommands | Name in-TUI actions | Unchanged | Unchanged | ADR-0122 §6 |

### Acceptance

**Every slice:**

- [ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §7: inline parity, colour off, 80×24,
  the overlay keys (Ctrl-C and Esc close and never confirm), the sanitize floor, bounded work, and secret safety
  for any screen that takes a secret. The full ADR-0115 keymap is MVP-4's, and MVP-2 does not depend on it.
- `pnpm run ci` and `pnpm coverage:enforced` green.
- The canonical docs updated in the same slice: [commands.md](../../reference/cli/commands.md),
  [home.md](../../reference/cli/home.md), [chat-session.md](../../reference/cli/chat-session.md),
  [config-spec.md](../../reference/contracts/config-spec.md), and a new `docs/reference/cli/markdown-rendering.md`
  for 2a.
- **Pinned test files.** Before adding a test to any file, run `grep -rln <file> tools/`. A `tools/` control that
  pins a file's test count or a witness title breaks CI when the file changes.
  - Pinned today, among others: `commands/chat.test.ts`, both `run.test.ts` files, `dispatch.test.ts`,
    `specs-forwarding.test.ts`, `fs-invocation.test.ts`, `chat-export.test.ts`, `create.test.ts`, `import.test.ts`,
    `gate.test.ts`, `format.test.ts` (by witness title) and `sanitize.test.ts`.
  - New tests go in new files. Implementing `init` replaces the three `init`-stub tests in `apps/cli/src/run.test.ts`
    one for one, keeping its count.
- Plain, `--json` and non-TTY output stay byte-identical for every invocation accepted today, except the
  [contract changes](#contract-changes-in-mvp-2) listed above, each tested in all three modes. The packaged chat
  smoke and the Windows headless smoke drive these paths.

**2a:**

- Every construct in ADR-0114's subset is tested, including adversarial and pathological input.
- Parsing stays linear.
- The one-row invariant holds with tabs, wide characters and tables.
- The cold-wrap performance guard still passes.
- A failed tool call shows `✗` in both renderers.
- The copy toast never claims a copy arrived.

**2b:**

- A key typed into the masked field never reaches React state, input history, the transcript, the hatches or any
  error text.
- A locked keychain never loops setup.
- A standard variable is never sent to a custom `base_url`.
- A standard variable the TUI has not been allowed to use reaches no egress inside the TUI: chat, the `/models`
  refresh and `/doctor --deep`.
- The ask-once answer survives a restart, stores no value, and is ignored in project and workspace configuration.
- `init` refuses a symlinked folder and never overwrites.
- The global folder is never treated as a project folder, including when the working directory is the home
  folder.

**2c:**

- The repaint shows no attachment content.
- The archive/retained projections satisfy the approved
  [structural identity and empty-terminal relationship](../../reference/cli/chat-session.md#proposed-restored-transcript-display--mvp-2),
  with safe display substitution and separately tested memory-policy requests.
  The earlier raw-equality acceptance wording is superseded by this 2026-11-09 correction.
- A Continue row from another directory never resumes inside the Home.
- At 80×24 the focused row and the keyless row stay on screen.
- A 5,000-turn session resumes with at most 500 restored entries (full-screen) and 200 (inline), and the
  left-out count is right.
- The cold-wrap performance guard covers a 500-entry restore.
- The picker pages instead of loading every session.
- The picker's scope and widening work.
- A picker that cannot read `history.db` shows the error and stays usable.

### Not in MVP-2 (recorded)

- **Resuming another directory's session inside the Home.** It needs in-Home re-anchoring.
- **Running a workflow, answering a gate, and reading status or logs inside the Home.** These belong to the hub
  milestone and its run-hosting ADR ([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §10).
- **Transcript search, and reprinting the transcript to the normal screen on exit.** Candidates under ADR-0122 §8.
- **The rest of `/providers`:** removing and testing keys, custom providers, and `/mcp`. These stay in MVP-9.
- **Picker extras:** preview, rename and delete.
- **Writing an `AGENTS.md` from `/init`.** This is MVP-A16.
- **Consolidating the standalone `relavium chat` host into the Home tree** ([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §5).
- **An "interrupted" tool-row state.** This is MVP-3.

### MVP-2 preflight and execution proposal — 2026-11-09

**Accepted execution plan — maintainer approval 2026-11-09.** This
preflight follows the maintainer's 2026-11-09 request to review existing documents,
settle decisions upfront, and implement on `development` through committed steps
with two fresh independent review rounds each. It refines the 2026-11-08 plan;
the maintainer authorized correcting supplied review findings, accepting the
corrected documents and continuing implementation. No product implementation or
milestone acceptance follows from design approval alone.

#### Document review and required actions

Three independent reviewers read ADRs 0001–0122 across their assigned numerical
ranges, the repository guide, relevant standards and the MVP-2 contracts. The
contract and UX reviewers also read the full Home/chat/config/accessibility
references and the benchmark; the security reviewer read the full security
standard. Code checks covered persistence, restore, rendering, setup, provider
resolution, config writing, project discovery and verification harnesses.

| Verified issue | Accepted resolution before implementation |
|---|---|
| The markdown ADR promises newline-stable parsing while tables need header lookahead and block-end conversion | Dated qualification in [ADR-0114](../../decisions/0114-in-house-markdown-rendering-for-the-chat-transcript.md); the new [markdown reference](../../reference/cli/markdown-rendering.md) defines the exact subset, fixed limits, geometry and incremental-work evidence |
| Stored user text contains expanded `@`/`!` context; the original compact view is not recorded | [ADR-0123](../../decisions/0123-restored-transcripts-use-host-recorded-display-text.md), display-only metadata in the [DB contract](../../reference/shared-core/database-schema.md#proposed-user-display-storage--mvp-2), and its [session relationship](../../reference/contracts/agent-session-spec.md#proposed-user-display-text--mvp-2) |
| The display/model string-equality test conflicts with hidden attachments, legacy prefixes and memory selection | Compare selected structural identities/order against real reconstruction, then test the separate safe display mapping; never claim display text equals model input |
| A later trim can retain an earlier compact summary | Policy-aware saved-context dividers distinguish summarized history, subsequently trimmed history and retained text; no blanket claim that all earlier text is unseen |
| The restore cap is described both as an initial limit and a permanent store ceiling | Bound only the initial restored prefix, including notices; select whole exchanges. New live entries append, full-screen reseat carries the current view, inline reseat does not reprint it, and clear starts empty |
| The plan says MVP-3 will store tool rows although content-free structure already persists | MVP-2 omits restored tool rows; MVP-3 owns richer/interrupted tool-row presentation. The durable content-free interruption marker remains MVP-4 under the separately Proposed ADR-0119 |
| New consent writes depend on shared-writer protections still assigned to paused row 16a | Pull only final-symlink refusal, safe typed recovery, existing-file comment-loss disclosure and truthful onboarding outcomes into step 2; row 16a's other obligations remain with their owner |
| Consent cancellation/write failure and old-binary recovery need exact semantics | Accepted, unimplemented [config contract](../../reference/contracts/config-spec.md#proposed-standard-environment-key-consent--mvp-2) and dated ADR-0063/0112 refinements, including pre-publication failure versus published-but-unconfirmed directory sync |
| The compaction overview repeats superseded triggers/fallbacks; the security skill claims an OS subprocess jail | Correct the existing chat reference and security skill to their accepted canonical contracts; no runtime policy change |
| The roadmap still lists MVP-1's repaired behavior as broken | Correct current status and qualify the historical Proposed-ADR list |

The supplied document reviews were independently checked against the implementation
before acceptance. Archive display uses all completed turns without the drop boundary;
model reconstruction still honors compact/trim boundaries and omits empty assistant
terminal text. Both contracts now state their selection relationship explicitly.
Markdown precedence distinguishes literal Setext pairs, rules and pipe tables and
specifies container indentation. The config contract distinguishes pre-rename failure
from published writes with unconfirmed directory sync, and separates the closed
operator-state writers from the three model-preference setters. Neighboring key-source
references qualify the accepted, unimplemented step-2 extension; ADR-0119 remains
Proposed with forward-compatible atomic display metadata requirements.

Two suggested mechanical corrections were rejected after verification: GitHub heading
anchors retain doubled hyphens around the removed em dash, and ADR-0112's authored
date differs legitimately from its later acceptance date. Approval marks the design
Accepted; it does not label unimplemented runtime behavior shipped.

The approved legacy display choice is explicit: an older
user row without recorded compact display becomes a neutral placeholder, including
an ordinary prompt without attachments. Assistant answers remain visible. Explain
once that original user text stays stored and may enter model context. No pattern
match, nonce or guessed frame parser establishes missing historical provenance;
there is no backfill. New user prompts restore their exact recorded display form.

#### Approved decisions and scope qualifications

- ADR-0123 and the linked metadata contract are accepted. Canonical
  `SessionMessage`, model restore, export and the LLM seam stay unchanged. A new
  nullable migration and bounded DB metadata read are needed; this is a public
  shared-metadata/DB API change, covered by this approval.
- The ADR-0114 clarification and markdown reference are accepted, including
  table/nesting bounds and literal fallbacks. The accepted in-house/no-dependency
  direction, source hatches and color-off source rendering remain.
- The ADR-0112/config refinement is accepted: only affirmative named-source consent
  persists after atomic publication; defer/cancel before publication grants nothing,
  and pre-publication failure requires a second explicit choice before ephemeral
  use. Directory-sync failure after rename is published with a truthful qualified
  durability notice, not an unsaved grant. The necessary row-16a writer floor moves
  into 2b before any new preference is written; unrelated HTTP activation stays
  with its recorded milestone.
- `chat --continue` rejects `--agent` and combinations with `resume`, `list` or
  `export` before history/key/provider/MCP work. Resume retains its saved bound
  agent; the new flag never silently overrides it. An omitted-id picker cancel
  exits 0 without starting a host; an empty picker offers cancel, with no automatic
  new session. Explicit resume IDs keep their current behavior.
- The initial restore budgets are entry-count limits, not a total archive byte
  bound or a permanent live-store ceiling. No silent truncation of a large
  restored message or live conversation is added. Measure representative and
  large-message workloads, and resolve a demonstrated unacceptable result before
  accepting the affected step rather than claiming performance from entry count.
- New Home-tree commands show disabled reasons when they cannot run, argument
  hints where needed, nearest-match typo guidance without auto-execution, and
  remedies suitable for the actual host. Standalone chat keeps its recorded
  three-command exclusion and names reachable alternatives.

These qualifications introduce no new runtime dependency or provider call.
The full ADR-0115 interrupt map remains MVP-4; Esc/Ctrl-C cancellation for the new
screens already binds under ADR-0122. The existing scope exclusions above remain,
including in-Home cross-directory re-anchoring and MVP-9's broader provider work.
Missing legacy display provenance is an explicitly disclosed historical limit,
not unfinished reconstruction work.

#### Implementation steps

**Revised and approved — 2026-11-09.** After the maintainer asked to reconsider review
and execution cost, the eleven implementation checklist items are consolidated
into **four steps**. The earlier list separated internal prerequisites into
review checkpoints even where they share one user journey, code path and
acceptance evidence. The four steps below replace that execution breakdown;
scope, accepted contracts, dependency order and security obligations are unchanged.

Each row delivers a complete behavior that can be exercised end to end. Internal
implementation order is a checklist, not another commit/review/acceptance loop.
Package-scope commits can still separate changes where appropriate; independent
reviews cover the entire step, including all its internal commits, once its
complete implementation is ready. Canonical contracts land with their behavior.

| Step | Slice | Complete deliverable | Internal implementation order | Required evidence beyond ordinary gates |
|---|---|---|---|---|
| 1 | 2a | Readable chat and truthful CLI feedback | Tab expansion and word wrap → tool failure glyphs/copy feedback → pure markdown parser/layout → streaming/render integration and source hatches; excess-argument refusal and the `agent run` stdin hint join this slice | Every markdown construct/fallback and exact/+1 limit; linear incremental-work evidence before live tailing; Unicode/tab/selection and one-row invariants including prefix exhaustion at widths 1/2; rich assistant cold-wrap; both renderers/color modes/80×24; local clipboard failure versus sent OSC52; grammar diagnostics without reflected values; machine snapshots; scoped parser security sitting; cumulative 2a acceptance |
| 2 | 2b, credentials | First run and provider keys managed inside the Home | Typed key availability and shared writer floor → native select/confirm/text/masked prompt host → rehosted setup → standard-env consent → `/providers`, persistent keyless row and keyless `chat` setup | Typed usable/missing/unavailable/pending/ineligible observations without per-frame key probes; symlink/dangling-link preservation before read/chmod; atomic publication with qualified crash durability, separately fault-injected file/directory sync and truthful failure/ephemeral outcomes; secret-free UI state/history/hatches/errors; bounded paste/input and cancellation/cleanup; actual resolver egress tests for chat/refresh/deep doctor; custom-endpoint and cross-layer refusals; restart/revocation behavior; palette discovery; separate credential/config security sitting |
| 3 | 2b, projects | Safe project initialization and discovery | Shared `init` core → `/init` confirmation and shell result → global-versus-project discovery fix across all consumers → existing-global-artifact remedies | All authoring/discovery consumers, home-folder refusal, no overwrite, symlink refusal, nested projects and existing global artifacts; shell/JSON contracts; inline/full-screen/color-off confirmation/cancel; separate filesystem security sitting and cumulative 2b acceptance, including interaction with step 2's config/setup paths |
| 4 | 2c | Find and resume a session with its safe visible history | Shared display metadata and additive migration → safe projection/repaint → indexed paged picker and `/resume`/omitted-id/`--continue` → actionable Continue rows/landing geometry → exit resume line | Metadata boundary/upgrade tests and every submit path; legacy placeholders, empty finals/prefixes, compact→trim and memory policies; unchanged model/export bytes and disclosure activation; 5,000-turn archive, restore budgets and rich cold-wrap; indexed SQL-side scope/filter/cursor tests; empty/error/retry and stale-result handling; shell grammar; original-workspace authority and no cross-directory Home resume; focused/keyless/prompt visibility at 80×24 in both renderers/color modes; separate resume security sitting and complete MVP-2 acceptance |

Step 1 combines the former items 1–4; step 2 combines 5–7; step 3 is the former
item 8; step 4 combines 9–11. No deliverable is dropped or moved past MVP-2.
Geometry/parser/draw and metadata/projection/picker are reviewed together, so
their integration is not repeatedly rediscovered in separate rounds.

Keep project initialization separate from credential setup: it changes project
discovery and authoring destinations across commands, has its own filesystem
failure cases, and can be validated without the setup UI. Combining them would
make the largest step cover two distinct behaviors and security scopes. Conversely,
separating a parser from its renderer or a session picker from safe resume would
add review overhead before the intended behavior can be exercised completely.

The baseline is therefore **eight independent review rounds instead of twenty-two**,
plus the required separate security sittings and any clean re-review D64 requires
after substantive fixes. This reduces repeated setup and context loading; it is
not a prediction that total implementation time or tokens falls by the same ratio.
Additional steps require a demonstrated independent risk/dependency or a review
scope that cannot be covered reliably; file count or an internal helper alone is
not a reason to split. Record the concrete reason before adding a checkpoint.

Core execution stays platform-pure. Only existing shared history selection is
reused; display metadata and picker/storage additions belong to shared validation,
DB and CLI, with no new model/runtime branch in the engine. Inspect exact export
surfaces before touching public APIs; the approval covers the narrowly described
metadata, paging and CLI additions, not unrelated API changes.

#### Commit, review and acceptance loop

For each of the four steps (not each internal checklist item or commit):

1. Implement and self-review against `/implement-task`; add meaningful regression
   and journey tests. Check `tools/` pinning before touching an existing suite;
   prefer new test files. Replace the three `init` stubs one for one as already
   required. Update canonical docs with that step.
2. Use targeted checks while implementing internal items. Before the implementation
   commit and step acceptance, run `pnpm ci:workspaces`, build/format, isolation,
   coverage and the applicable smoke/causal checks. Preserve the skill's
   lint/typecheck/test/build obligations; a failing applicable gate is not waived
   by review. Run the complete CI family on the final combined MVP-2 revision
   before merge, using the repository's declared shards for the large filesystem
   and secrets cohorts. Required remote CI remains mandatory. Commit the green
   implementation on `development` with truthful Codex trailers.
3. Run a fresh independent comprehensive round over that committed step and its
   affected existing paths: correctness/contracts, UX/accessibility/performance,
   and security/lifecycle where relevant. Validate every finding before fixing;
   commit fixes with appropriate regression evidence.
4. Run a second round with new reviewer agents over the entire cumulative step,
   including the fixes. Validate, fix, test and commit any confirmed findings.
   The second round is independent of the first, not its authors rechecking only
   their own comments.
5. Apply D64 as well as this two-round minimum. Security-tier steps need a new
   complete cumulative round with no blocker/high/medium after the last fixes,
   plus the separate applicable security sitting. If round 2 needs substantive
   fixes, obtain the necessary new clean round; do not mark an unreviewed fix
   accepted. Resolve in-scope lows rather than creating avoidable deferrals.
6. Record reviewed revisions, verified findings/resolutions, checks and remaining
   gates concisely in this register; detailed timestamped records stay local in
   `docs/reviews/`. Proceed to the next step automatically. Push the combined
   `development` revision for the final PR and observe all required CI; do not
   restart unrelated long native matrices for each intermediate review fix.

#### Step 1 acceptance (2026-11-10)

The readable-chat step is accepted on `development` at `b636be5f`. Round 12's
fresh independent parser and integration reviews and separate D76 security
sitting are clean over the cumulative diff from `6d1e7c40`. At that checkpoint,
steps 2–4 were unimplemented and proceeded in their approved order; this is not whole-MVP-2 or
release acceptance.

| Round | Reviewed revision | Verified corrections / result |
|---|---|---|
| 1 | `d7520833` | `3a86e653` |
| 2 | `3a86e653` | `e5ece476` |
| 3 | `e5ece476` | `5e07e083` |
| 4 | `5e07e083` | `8c88992c` |
| 5 | `8c88992c` | `cf8eb674` |
| 6 | `cf8eb674` | `0436af99` |
| 7 | `0436af99` | `7c7d27c2` |
| 8 | `7c7d27c2` | `9d255667` |
| 9 | `9d255667` | `f287fc43` |
| 10 | `f287fc43` | `b6f1aad7` |
| 11 | `b6f1aad7` | `b636be5f` |
| 12 | `b636be5f` | Clean cumulative reviews and separate security sitting |

The verified corrections cover physical/container ownership and literal
fallbacks; exact opaque targets; Unicode/tab geometry and invalid-width
acknowledgement; clipboard lifecycle; and indexed CPU/retention bounds. Detailed
timestamped evidence remains local in `docs/reviews/`. Round 12 independently
passed 88 parser tests and 15,000 mixed-block comparisons; 237 integration tests,
40 native startup-width cases and long-source/geometry/sanitizer probes; and
546 security tests plus hostile-control and resource probes. Finite measurements
establish neither an all-input proof nor a universal heap ceiling.

Exact-source gates pass: workspace lint/typecheck/tests (CLI 416 files, 6,852
passing and 11 existing skips), 737 Markdown tests, build, format, isolation
(803 files), finite bundle closure and compiled CLI smoke. Earlier failed timing
runs remain recorded: independent helper size/container cases were separated
without removing inputs, assertions or work bounds; each uses the default
five-second deadline. Aggregate scheduling/budget granularity changed, not
production performance. The R10 helper profile attributed most sampled time to
the full-source oracle; this does not turn the failed aggregate run green.

The package coverage floors previously passed and their production sources are
unchanged by this CLI-only step. Final combined coverage, the complete declared
CI families below and required remote checks remain due on the final MVP-2
revision. Native/headless fixtures do not replace the real Windows terminal
acceptance assigned to MVP-10.

#### Step 2 acceptance (2026-11-10)

The credential step is accepted on `development` at `85f0e691`. Round 4's fresh
independent correctness and native UX/lifecycle reviews and separate
credential/config security sitting are clean over the cumulative diff from
`5861f805`. Project initialization and safe history/resume remain steps 3 and 4;
this is not whole-MVP-2 or release acceptance.

| Round | Reviewed revision | Verified corrections / result |
|---|---|---|
| 1 | `60e6ecfc` | `0b60ee00`: saved-default recovery, fixed operator diagnostics, fresh catalog credential observations, exact visible native admission and Home remedy |
| 2 | `0b60ee00` | `280be241`: preserve model preferences during additional key maintenance, name usable sources, keep rejected-paste recovery visible |
| 3 | `280be241` | `85f0e691`: retain existing interactive keyless-resume recovery and native provider/context-specific action copy |
| 4 | `85f0e691` | Clean cumulative reviews and separate security sitting |

The native host shares one input owner with Home, retains its chat subtree and
checks the complete current card, raw geometry, actual flush and custody at
admission and again before config rename. Per-lookup credential authority, global
operator state, saved/unconfirmed/explicitly ephemeral outcomes and project
precedence remain distinct. [Home](../../reference/cli/home.md#first-run-onboarding-wizard-25g-s8)
and the [credential-source contract](../../reference/contracts/config-spec.md#proposed-standard-environment-key-consent--mvp-2)
own the behavior; detailed timestamped evidence stays local in `docs/reviews/`.

Round 4 independently passed 112 correctness tests; 194 native tests across 26
files plus four mounted Home recovery controls; and 467 security tests across 40
disjoint files plus 11 offline probes. The native run deliberately filtered two
broad Home suites (123 other cases were not run in that sitting); the author ran
the full workspace separately. Actual-command security probes retain resumed
workspace/MCP consent, refuse keyless sends and compaction without recording a
prompt, permit an explicitly granted source, block again after its removal and
close injected owners once. These finite offline checks do not certify physical
terminal/keychain behavior or real Windows-terminal acceptance.

Self-verification and review failures remain recorded. Fresh credential refusal
again precedes session-history acquisition, preserving the existing causal guard.
Existing Home write assertions await asynchronous settlement before the same
checks. The later-manual-save regression now removes the prior usable source
first; additional-key maintenance has its own unchanged-preference regression.
New native harness preconditions and one test mock's contextual type were fixed
without removing or weakening assertions, deadlines or causal controls. Baseline
in-memory old-module probes fail the new regression cases; no branch or worktree
switch, source restoration or paid provider call was used.

The accepted source passes full workspace lint/typecheck/tests (CLI 436 files,
7,036 passing, 11 existing skips), build, format, isolation, finite bundle closure,
compiled bootstrap/CLI smoke, seam/engine fences and DB sync. Initial enforced
coverage passed 815 files and 17,400 tests, with 22 existing skips and required
package floors. Later corrections changed CLI production sources only; those
required package sources are unchanged. Final combined coverage, complete declared
CI families below and mandatory remote checks remain due on the final MVP-2
revision. Steps 3 and 4 proceed automatically in their approved order.

#### Step 3 acceptance (2026-11-10)

Project initialization and global-state exclusion are accepted on
`development` at `ee49871d`. Three fresh cumulative rounds and a separate
filesystem sitting satisfy the required review gates. The [init contract](../../reference/cli/commands.md#relavium-init)
owns shell results, Home confirmation, existing/nested projects, final-marker
link refusal, partial cleanup and global-artifact remedies. Existing global
files are left in place. Safe display metadata and history/resume remain step 4.

The prepared core writes only the marker, workflows and agents directories.
Home uses the existing native owner with a default-No card and exact visible
admission at each directory publication; both renderers retain their chat view.
Cleanup removes only identified, invocation-created empty directories and reports
uncertainty without removing concurrent contents or replacements. These Node
path/identity checks retain the owner-controlled-ancestor assumption; they do not
claim race-free isolation from a hostile same-user process.

Shared discovery and automatic authoring destinations exclude home/global state
and canonical aliases. Unresolvable global boundaries refuse rather than silently
discarding a project's settings. `create` checks before prompting and again after
its asynchronous wizard. A new regression first demonstrated that a marker
changed to a global alias during that wait could otherwise publish there; the
corrected guard refuses it without a global write. Old-discovery in-memory probes
also fail the new configuration/consumer checks.

The initial workspace run found nine test-premise/metadata failures: old fixtures
used home as their project and registry expectations still advertised an init
stub. Fixtures now separate project and home; all original DB custody, notice-I/O,
native-close and precedence assertions remain. The immutable 24-entry legacy
manifest fixture is unchanged and still compared exactly, with the new init
entry checked separately. Three run-stub tests were replaced one for one; that
pinned suite remains 28 cases and its causal witness names are unchanged. Initial
native harness failures are retained: text-plus-CR was separated into the parser's
submit gesture, and half-column resize checks observe actual pending admission
rather than claiming a complete instruction can be painted there.

The initial implementation passed full workspace lint/typecheck/tests (CLI 440
files, 7,088 passing, 11 existing skips), build, format, isolation, finite bundle
closure, compiled CLI/bootstrap smoke, seam/engine fences, DB sync and tooling
typecheck. Native coverage includes
Home/Home-chat, both renderers and colour modes, No/Esc/Ctrl-C, bracketed paste,
post-flush resize/recovery/cancel and retained inline history. Actual CLI, driver
and config/create/import/export/list/doctor journeys pass offline. This entry
does not replace the required independent reviews or final combined gates.
Required production package sources remain unchanged by this CLI-only step;
final combined coverage remains due under the scheduling rule below.

R1 verified actual catalog-directory/file aliases that could admit global reads
or forced writes, plus missing local `/init` typo guidance. `5d4af759` fixed them.
R2 verified automatic project/workspace config-file aliases, including the
invocation-default reread, and default portable/session export targets that could
write global files. `ee49871d` applies the shared actual-target boundary there,
including default session export from home/global directories. Explicit selected
config, input files and output paths retain their existing contracts. Baseline
module controls fail the new regressions before each fix. Only the earlier safe
export-refusal message expectations changed in two existing tests; their error
codes, test counts and preservation assertions remain.

Fresh R3 reviews at `ee49871d` found no verified findings across the whole step:
correctness/contracts (78 independent tests), native UI/lifecycle/performance
(246 tests), and the separate filesystem security sitting (97 tests plus 12
compiled disposable-home probes). The final source passes workspace
lint/typecheck/tests (CLI 443 files, 7,116 passing, 11 existing skips), build,
format, isolation, seam/engine fences, tooling typecheck, finite bundle closure
and compiled CLI/bootstrap smoke. Whole-MVP-2 gates remain due; step 4 proceeds
with safe display metadata, history projection and session discovery/resume.

#### Step 4 implementation (2026-11-10)

The approved metadata/migration, safe archive projection, shared native picker,
Home `/resume` and Continue navigation, canonical chat shell entries and exit
resume hint were implemented on `development` at `22994112`. This subsection
records the initial author evidence; the final cumulative review and acceptance
follow below. No new design or dependency was introduced beyond ADR-0123 and the
approved four-step plan.

Author verification passes all workspace lint/typecheck/tests (CLI: 451 files,
7,182 passing, 11 existing skips), build/format, isolation and required coverage
(842 files, 17,669 passing, 22 existing skips). After coverage, only CLI UI hints,
their existing native tests and Windows test scheduling/profile changed; measured
package production sources did not. Current UI and full workspace checks pass.
The packaged local CLI passes 177 controls and 10 smoke scenarios; compiled
bootstrap/CLI, media, overflow, budget replay, map controls and 1,031 acceptance-tool
tests pass. No seam, engine-dependency or unsafe-any escape was introduced.

Two misleading UI hints are corrected: empty Home does not advertise Continue,
and rejected search input offers editing rather than an unavailable Enter retry.
A mounted renderer control fails with the old footer substituted in memory;
the corrected view passes the complete renderer matrix; the developer source is unchanged by that control.
The original pinned 449-case/71-child usage cohort and Commander-opacity source
anchor remain intact; new restore cases live in a separate file. Initial failed
runs remain recorded locally rather than being counted as acceptance.

The preceding remote revision exposed Windows timing failures: the 200-pair NTFS
identity diagnostic completed but exceeded its implicit five-second default;
an unchanged retry passed it and instead timed out parallel media publication
and migration setup. The diagnostic now uses the existing 15-second native
profile with all 200 pairs/assertions retained. Windows media runs the same eight
files serially; media case/hook, causal-phase/evidence and job bounds remain unchanged.
The exact workflow invocation is checked by the existing scheduling guard.
Required Windows verification on the final combined revision remains due.

#### Step 4 acceptance (2026-11-10)

The complete session-discovery and safe-restoration step is accepted on
`development` at `cecb6191`. Round 4's fresh complete correctness/contracts and
native/UX reviews and its **separate D64 security sitting** are clean over
`528eae0f..cecb6191`. They cover the entire step and its affected existing callers,
including all preceding corrections, rather than only the last patch.

| Round | Reviewed revision | Verified findings and resolution |
|---|---|---|
| 1 | `22994112` | Four medium findings: truncated Home diagnostics/remedies, hidden Home activation below minimum geometry, standalone post-await credential admission, and unsafe saved-ID recovery commands. Fixed in `60bfadbb`. |
| 2 | `60bfadbb` | Two medium findings: picker typing lost under native output backpressure and a Home post-build credential admission gap. Fixed in `14399d21`. |
| 3 | `14399d21` | Two distinct medium findings: pasted drafts retained Continue focus and were lost on Enter; local restoration cancellation failed to stop new MCP/key admissions. Native/security cancellation reports describe the same finding. Fixed in `cecb6191`. |
| 4 | `cecb6191` | Complete cumulative correctness, native/UX and separate security reviews: no actionable blocker, high, medium or low finding. |

The corrections preserve exact current-card acknowledgement for picker selection,
paging and scope changes while a previously visible editor retains filter input
during result repaint. Home restoration cancels only its pending replacement
owner, passes the supported MCP connect signal, retains actual work/cleanup and
keeps the old Home/chat. Only that owner's stopped identity is benign; an
independent infrastructure failure retains exit `9`. Typed and pasted edits both
leave Continue focus before submission. No in-scope finding is deferred.

The reviewed source passes full workspace lint/typecheck/tests (CLI: 457 files,
7,232 passing, 11 existing skips), build/format and isolation (848 collected
files). Permanent native backpressure, draft and cancellation tests include
landing/retained-chat, before/during-connect, post-build and independent-fault
controls. In-memory prior-source controls reproduce the repaired failures while
leaving the checkout unchanged. The final correctness reviewer independently
passed 452 scoped tests; the separate security reviewer passed 385 with zero
skips. Review totals overlap and are not added together.

A current-source representative layout probe at 80 columns wrapped 500 fresh
rich entries in 69–97 ms across five samples, and a 120 KB individual answer in
70 ms across 1,540 rows without source loss. These local, warmed-process/fresh-entry
measurements are exploratory functional evidence, not a cross-platform latency
or memory guarantee. The required cold-wrap/native guards remain CI gates.

All **four approved MVP-2 implementation steps and their independent review
loops are complete**. Required combined CI, coverage, the full declared causal
families and platform jobs gate the checkpoint PR, which records their final
source-bound results for the maintainer. This acceptance does not merge the PR,
publish npm, close the wider Phase 2.6 workstreams, or change the approved MVP-3…10
scope and release guard.

**Final CI verification — 2026-11-10.** At `9bbf42e1`, the push coverage
run passed all 848 files (17,718 tests and 23 existing Linux skips), while the
same-tree PR run exceeded the default five-second allowance in three markdown
test cases. A selective retry then exposed four markdown case timeouts in the
ordinary workspace run; two included the same grouped/scale workloads. Both PR
Node-22 compatibility attempts exhausted their 25-minute whole-job allowance.
These incomplete/failed runs are not checkpoint acceptance.

Independent focused measurements found no production defect: the 400-line
paragraph experiment passed its exact structural bounds, and all relevant
raw-marker/EOF cohorts passed under coverage. The verification correction
separates independent raw-marker size/prior, omitted-prefix and EOF chunk
variants into individual cases, preserving every input and assertion execution.
The inseparable 400-draw experiment retains all draws and operation limits with
an explicit 15-second test allowance; its 100/200-draw cases retain the default.
The four native quote tests get a 20-second outer allowance around their existing
15-second child deadline. Their 256 MB process heap cap, 128 MB retained-heap
assertion and causal limits are unchanged. This explicitly qualifies the earlier
unchanged-case scheduling statement for these newly introduced markdown tests;
security/native-media readiness, causal phase/evidence limits, pinned 449/71
inventories and coverage floors remain unchanged. Only the advisory Node-22
whole-job allowance increases to 35 minutes. No production behavior or dependency
changes, and the final checkpoint still requires source-bound CI results.


**Verification scheduling refinement — 2026-11-10.** The step-1 full local CI
invocation passed workspaces, build/format, package/bootstrap/smoke, acceptance
tools, wire and all 23 usage mutation controls. Its 115-control filesystem family
stopped at `media-temp-claim-identity/restored` without a completed report. The
isolated unchanged fixed/removal/restored retry passed all 23/22/23 cases with
source invariance verified; this does not make the interrupted family complete.
The repository's required CI already runs filesystem and secrets as two shards
with unchanged phase/case/evidence bounds and 60/75-minute job allowances.
Use scoped checks during the steps and complete those full declared families on
the final combined revision. No required merge gate, test inventory, deadline or
review round is removed; retain the incomplete-run record and do not call the
single interrupted `pnpm run ci` invocation green.

Use current available Sol/Terra models with high effort for parser, security,
storage and lifecycle review; Luna may cover a narrower low-complexity UX/docs
pass. Use no Astra unless the maintainer later explicitly requests it. Each round
uses fresh agents; no implementation author reviews its own work as independent.

Every new screen is checked in inline/full-screen, color on/off and 80×24, with
paste, Esc/Ctrl-C, resize, cancellation and recoverable failures. Package/Windows
headless smokes establish machine-contract compatibility only. Mounted Ink and
native-input tests establish the exercised interactive paths; a real Windows
terminal remains MVP-10's separately recorded acceptance check, never inferred
from headless success. Do not make paid provider calls or claim live validation
from offline fixtures.

The new markdown reference, accessibility/copy wording, command/Home/chat/config
references, metadata/DB contracts and their indexes are updated in their owning
steps. A final consistency pass updates current status, the phase acceptance and
deferred-task closures without prematurely claiming unrelated MVPs complete.
Then prepare the `development`→`main` PR for the maintainer's detailed review;
merge and publication are not part of this implementation instruction.

#### PR #98 supplied-review follow-up (2026-11-11)

The maintainer supplied two reports. The corrected report binds the actual PR to
`c04e6c13..3cae8c09` (250 files, +36,126/−1,045); the older 520-file report used a
stale local base. Its findings were still checked against the actual code and
accepted contracts. The following dispositions refer to those report-local IDs,
not to a new risk-acceptance decision. No new ADR, runtime dependency or seam
change is needed for these corrections.

| Supplied finding | Verified result and action |
|---|---|
| Corrected report 1 and 3: destination mismatch / missing standalone origin | Fixed. Both native hosts obtain safe destination copy from the same private endpoint snapshot as the actual adapter. A second-process SQLite registry edit cannot change the card independently of its request. Real Home and standalone tests exercise validation with a recording transport and verify a fresh resolver adopts the new endpoint. Invalid stored endpoints retain their refusing adapter and fixed safe copy. |
| Corrected report 2: quadratic email autolink rejection | Fixed with a single-pass predicate preserving the supported grammar. Differential and cold/split-live tests cover acceptance equivalence. Native cold wrapping and live final-`>` append regressions use 200,000 dots, a 256 MiB heap cap and a ten-second child deadline; the prior predicate times out on both paths. No provider or actual network request is used. |
| H1: conservative-commitment durability | Fixed the narrower verified latch inconsistency. Failed writes now set the existing sticky durability latch and retain the original rejection. A real governor/store/host regression proves later cached-key command dispatch refuses even after store recovery. The report's provider-budget-bypass claim was not established: the existing governor barrier and host accounting-failure latch already refuse later provider egress. |
| H2, M1: close at an exhausted cleanup deadline | No defect established. The promise acknowledges actual cleanup; the registry separately bounds its wait and reports unacknowledged owners. Calling `complete()` on deadline would falsely certify cleanup. |
| H3, M10: autolink control bytes / metadata | No reachable sanitizer bypass established. Actual cold/live display boundaries sanitize before parsing, and link metadata is not a navigation, fetch or OSC-8 sink. The accepted parser precondition remains in force. |
| H4, M9: oversized table/source retention | No defect established. Full-table literal fallback and source hatches require retaining the complete source; stream state resets at its existing ownership boundaries. Breaking early or dropping stabilized source would change that contract. |
| M2: effect-turn reservation | No unsafe dispatch or identity reuse established. Typed transactional reservation refusals happen before dispatch; successful keys are durable before issue. Applying the transcript/cost latch indiscriminately would turn typed refusals into a new sticky-failure policy. |
| M3: explicit export destination | Explicit `--out` is selected-file authority under the existing export contract. Automatic project targets keep their own boundary checks. No new project jail is introduced. |
| M4, M5: remembered consent / exported config primitive | Remembered global consent is accepted user authority, not an untrusted project grant. The atomic writer has typed production callers and a fault-test seam; no plaintext-key write or bypass was found. |
| M6: custom-adapter fetch injection | ADR-0065 assigns DNS-pinned transport to the host. The CLI always supplies its validated transport; no CLI SSRF bypass was established. Requiring a different package factory contract is not justified by this finding. |
| M7, M8: table padding / exhausted row width | Existing grid-width invariants and boundary tests contradict a negative-padding reproduction. Narrow positive geometry preserves source; true zero geometry already suspends interaction. Clamps or empty rows would hide an invariant failure or lose text. |
| L1–L4: zero geometry, picker cancellation, unresolved boundary, endpoint classification | Zero remains zero so hidden approvals cannot be enabled by an 80-column fallback. Picker active/generation guards discard cancelled reads. Unresolved boundaries intentionally fail closed. Host-based wire classification is the accepted factory policy, including normalization; displayed recipient origins now retain actual ports. |
| L5: own-export read | Existing link, descriptor identity and stat-size gates were already present. A narrower growth-after-`fstat` resource gap was reproduced and fixed: the admitted descriptor reader stops at the existing byte ceiling plus one sentinel. A real appended-file regression preserves the grown candidate and selects a new export name. |
| L6–L9: grapheme clipping, heading indices, position radix, astral words | No defect reproduced. Clipping finds the boundary across concatenated spans; headings consistently use UTF-16 offsets for ASCII markers; the radix pruning boundary is an exact power of two; the existing two-unit word window captures the preceding astral point. Per-span segmentation would break cross-style clusters. |
| L10–L12: ADR implementation wording | Existing dated implementation receipts already qualify historical proposal wording; the Markdown reference remains the canonical complete subset contract. No duplicate ADR amendment is necessary. |
| O1–O3: performance evidence and CI | Native resource regressions supplement structural-work assertions; timings alone do not prove linearity. Against the actual base, only the advisory Node-floor job allowance changed from 25 to 35 minutes. Coverage/secrets allowances and required Windows/dependent map controls predate this PR. Causal bounds, inventories and coverage floors remain intact. |

The original Sonar analysis at `3cae8c09` really failed reliability (C rather than
A): its three open BUG issues are two split synchronous/async promise-handler
warnings and a one-iteration loop. Targeted probes found no corresponding
behavioral failure. Small clarity refactors express awaited failure handling and
the single conditional directly, preserving same-dispatch owner admission, actual
work joins and safe failure copy. Permanent lifecycle tests additionally observe
unexpected presentation errors through the existing Home fatal path. No Sonar
suppression or external issue-status change was made; only a new analysis can
establish the corrected remote gate result.

**Initial follow-up state.** Post-correction cumulative reviews, a separate
security sitting and final combined verification were pending when this follow-up
opened. Earlier step acceptance did not accept the new corrections. The final
correction-review acceptance below supersedes this initial review status;
source-bound combined checks still gate the checkpoint's readiness.

**Cumulative correction round 1 — 2026-11-11.** Fresh native/storage/contracts
and renderer reviews account for all 258 changed paths in `c04e6c13..71aaca04`;
a separate D64 sitting finds no additional actionable security issue. The native
pass finds five stale reference descriptions (Home actions, `/resume`, operator
writer status and two CLI-index summaries), corrected in their canonical homes.
The renderer pass establishes a medium live-rendering defect: expiring a literal
bracket label at LF exposes its inner markers to enclosing delimiter queries.
Independent reduction confirms text/style/newline loss and incorrect tab geometry;
canonical source and finalization stay intact.

The correction retains multiline opaque label ownership. Expanded regressions
also isolate a preexisting query-liveness defect when a provisional thematic break
closes and then reopens a paragraph: cached fixed-scope queries keep an obsolete
end. Growing root flushes now advance that scope through the existing targeted
threshold queue, reactivating only affected owners instead of invalidating the
entire retained prefix. Thirty-three permanent cases cover four bracket forms, six
wrapper markers, split boundaries, clipped semantic suffixes, tab geometry and
two independent destination/reference reopen controls. A bounded view may rewrap
its clipped prefix; the tests compare wide-layout character/style/newline/tab
suffixes rather than asserting an unsupported cold/live row alignment.

A bounded mixed-input author probe then exposed stale inner-autolink decisions
when a literal enclosing group replaces an earlier opaque owner. The reduced
cases establish two further cache-custody faults: replacement notified newly
covered bytes but not existing owner-identity observers, and restoring a body
during gap/fill work could enqueue dirty work after the flush's initial drain.
Queries now subscribe to the actual opaque owner record, with disposal under the
existing observer lifetime; replacements wake those observers. Flush settles its
dirty/gap/fill phases iteratively before projection. This avoids a new global
answer index or retained-prefix scan. Existing nested-target, suspended-owner and
opaque-crossing work/retention bounds remain unchanged. The three additional
permanent cases cover crossing code, a reopened bare group and nested autolinks;
the isolated diagnosis includes a finite-scope interior true-to-false transition.

The bounded mixed-input replay also reduced a preexisting no-progress defect to
five UTF-16 units: an escaped backtick exposed inside an unfinished bracketed link.
The old live run index returns the start for that literal tick, producing a
zero-length item; an isolated `71aaca04` child reproduces nontermination. The live
run helper now consumes at least the current matching character and an adjacent
physical run, retaining growth observation and literal/code parity in constant
time. Two killable native whole/split cases cover multiple run lengths, heap and
unchanged indexed-work limits; both time out before the correction and pass after.
The final bounded 400-sample mixed-input author replay completes with zero
semantic/style/tab mismatches. This is supplementary evidence, not exhaustive
input coverage or an independent acceptance round.

A pre-final, uncommitted candidate's concurrent workspace run has 16 case
timeouts and five Vitest RPC timeouts while the exploratory probe is CPU-bound;
it is not a green gate. On this loaded local host, the replacement workspace
verification keeps every test and case deadline and passes `--maxWorkers=2` to
each Vitest task, with workspace concurrency one. Repository/CI commands and
timeouts remain unchanged. The installed Turbo package has no bundled `docs/`
directory; its version-matched `run --help` confirms argument forwarding. Final
source-bound results still gate acceptance.

Workspace checks and the native package/smoke/tooling gates passed on `71aaca04`.
An earlier map-control invocation correctly refused a concurrent HEAD change and
was rerun successfully on the frozen commit. Its later superseded coverage run
was intentionally stopped after the new renderer defect was verified; that run
is incomplete, not a green coverage receipt. A fresh cumulative round and final
combined source-bound gates remain required after these corrections.

**Cumulative correction round 2 — 2026-11-11.** Fresh native/storage and
renderer/TUI reviewers complete the 261-path cumulative assignment at `168aaef0`
without an actionable finding in those scopes. Their independent runs pass
266 and 169 cases respectively; the renderer also checks 1,928 bounded input
prefixes. These overlapping cohorts are not added to a test total.
The separate D64 sitting passes 384 focused cases and establishes one medium
finding: both accounting writers resolve model-catalog identity outside their
common durability latch. A real `makeCatalogIdResolver` with an injected native
catalog-query failure rejects an actual missing-usage or complete-usage turn,
but a later cached-key command still dispatches in an optional-owner host.
The finding does not establish a later provider-budget bypass or a bypass of
production-owner termination.

Both once-only catalog lookups now run inside the existing durable-write wrapper.
Two permanent actual-turn regressions use real SQLite, the production catalog
resolver, governor, persister and journal; they prove native query failure sets
the original sticky error and blocks subsequent dispatch even after recovery.
Both fail before the correction. The later superseded coverage invocation at
`168aaef0` was intentionally stopped after this verified finding and is incomplete.
No coverage, causal or CI acceptance is inferred from it. The final writer
correction needs fresh independent correctness and security review; unchanged
renderer code retains its source-bound round-2 review evidence.

The writer candidate's two-worker local CLI run completes with three timeout
failures (one existing native crash deadline and two existing Markdown timing
cases), without a semantic assertion failure. The unchanged 200-cycle sibling
passes after the 50/100-cycle timeouts. This run is not accepted as green. Repeat
the entire CLI suite with one file worker, retaining every case and deadline;
the other five workspace suites and their source identities are unchanged.
The complete one-worker CLI repeat passes all 466 files / 7,424 cases, with the
same 11 existing skips; build/format also pass. Together with current workspace
lint/typecheck, isolation and the unchanged five package suites, this completes
the author gate without raising a deadline. Independent writer review and final
combined acceptance are still pending.

##### Final correction review acceptance (2026-11-11)

The corrected source is accepted on `development` at `2e57e10a`. Fresh round-3
correctness review and its separate D64 security sitting are clean for the final
accounting increment and complete affected cumulative accounting/session flows.
SEC-R2-01 is closed for both usage kinds. The previously completed round-2 native
and renderer reviews remain bound to exact unchanged source: all 257 paths outside
the final four-file increment match `168aaef0`, including all 114 renderer paths.
The independently recomputed renderer identity digest is
`a46b2b9ab4be7be853a713b52e0af104c10779af592fc5c3f243eeb3e139f1f4`.
This retains reviewed immutable code rather than claiming a third fresh renderer
audit or treating the round-2 security finding as a clean result.

Round 3 independently passes 199 correctness cases and 277 security cases, plus
nine bounded accounting scenarios and two late-dispatch races. They establish
original-error identity, once-only catalog reads, missing-catalog success,
catalog/UUID/time fault latching, sticky refusal after recovery, refusal after
approval/preparation and discard of a prepared claim. Constructor and event-only
projection reads are distinguished from durable money operations. Review cohorts
overlap and are not added to a test total; the finite evidence is not universal
proof or a real-provider/keychain/terminal certification.

All verified in-scope supplied and subsequent findings are fixed; none is deferred.
No new ADR, dependency, seam, authority grant, deadline increase or floor change
was needed. Canonical references and status summaries are reconciled. Author
verification includes current workspace lint/typecheck, the unchanged five package
suites, the complete one-worker CLI run (466 files / 7,424 passes / 11 existing
skips), build/format and isolation (857 collected files).

This completes correction review, not the combined CI gate. Final enforced
coverage, complete declared wire/usage/filesystem/secrets families, package/smoke
and platform checks bind the checkpoint source; their actual outcomes and run
links belong in [PR #98](https://github.com/HodeTech/Relavium/pull/98). Its draft
state is removed only after those results are verified for maintainer review.
Earlier incomplete/failed runs above remain incomplete/failed. The published CLI,
release guard and wider MVP-3…10 scope retain their existing status.

##### Final CI harness follow-up (2026-11-11)

At `dfcf108b`, local enforced coverage passed all 857 files (17,911 cases,
22 existing Darwin skips), and the complete wire/usage/filesystem/secrets controls
passed with retained source/restoration and runtime evidence. The first final-source
[PR CI](https://github.com/HodeTech/Relavium/actions/runs/43009284696) and
[push CI](https://github.com/HodeTech/Relavium/actions/runs/43009275434) coverage jobs
remain failed: respectively one and seven five-second renderer case overruns, plus
two unhandled Vitest task-update RPC timeouts each. Their outcomes are not replaced
by the local passing run or by successful sibling jobs.

Independent diagnosis reproduced the RPC failure with the installed Vitest 3.2.6
on both Node 22.23.1 and CI's Node 24.22.2: 100 synchronous 650-ms cases all pass
their unchanged five-second budgets, but the 65-second file starves an update reply.
The identical workload with an `afterEach` event-loop yield passes without the RPC
error on both versions. The two long synchronous Markdown suites now yield between
cases. Separately, the anchored-inline fixture measures its invariant Unicode body
once and subtracts independently measured complete units, avoiding a quadratic
reference calculation. All 1,920 former oracle values were checked for equivalence;
every factory operation, assertion, counter bound, size and deadline is retained.

The focused Node-22 run and Node-24 V8 diagnostic each pass the unchanged 256-case
four-file cohort; they are not replacements for full enforced coverage. Other
streaming case overruns are not attributed to the inline oracle or RPC failure
without evidence.

Two fresh independent source reviews accept the test-only correction at
`f73ea504`. Round 1 verifies all 1,920 exact old/new oracle expressions on both
Node versions and all 2,004 unchanged tree entries outside the five-file delta.
Round 2 independently verifies oracle equivalence and passes all 223 cases in
the three affected files. Both reviews confirm unchanged test bodies, workloads,
structural assertions and deadlines, and explicitly retain the unresolved
individual CI overruns as a required verification gate. These overlapping
cohorts are not added to the full-suite test total. All production, tooling,
configuration and security sources retain their accepted identities; this does
not claim a fresh production security sitting. Only this acceptance/status record
changes after the reviewed test commit. Final combined source-bound CI and
maintainer review still gate the checkpoint PR.

#### MVP-2 merge checkpoint (2026-11-11)

**Complete and merged to `main`.** The maintainer merged
[PR #98](https://github.com/HodeTech/Relavium/pull/98) on 2026-11-11 at
`0db4c9408853f8770ea1ceb5c0cf27d515931ec0`. Its Git tree,
`907c5e303b5e5a122a3da43bc4523f3ea1156fd9`, is identical to reviewed and tested
head `81416f0d` and PR merge candidate `5868a8db`. `development` was fast-forwarded
to the merge commit before this documentation close-out, without switching branches.

- [x] [Step 1](#step-1-acceptance-2026-11-10): readable Markdown, wrapping/tabs and truthful CLI feedback.
- [x] [Step 2](#step-2-acceptance-2026-11-10): native provider setup, typed key availability and source consent.
- [x] [Step 3](#step-3-acceptance-2026-11-10): shared Home/shell initialization and global/project separation.
- [x] [Step 4](#step-4-acceptance-2026-11-10): safe visible history, indexed discovery, `/resume`, Continue and exit hints.
- [x] Verified supplied and subsequent findings resolved; required cumulative reviews and separate security sittings complete.
- [x] Test-only fairness/oracle correction accepted after two fresh independent source reviews.
- [x] Final source-bound verification and maintainer review/merge complete.

The final [PR CI](https://github.com/HodeTech/Relavium/actions/runs/43017944352)
and [development push CI](https://github.com/HodeTech/Relavium/actions/runs/43017937579)
each passed all **18 jobs**, including the declared causal families, the Node-22
floor, Windows native checks, all four installed-package consumers, and the main
lint/typecheck/test/build/smoke gate. Each full Linux coverage run passed
**857 files / 17,910 tests / 23 existing skips**, with no RPC errors. Final local
build and enforced coverage passed at `81416f0d` (**17,911 tests / 22 existing
Darwin skips**); SonarCloud's final-head quality gate passed. The merged PR retains
the detailed checks, source identities and earlier failed/incomplete attempts;
this closure does not relabel those attempts as successful.

This checkpoint closes MVP-2's implementation, correction, CI and maintainer gates,
including the MVP-2 splits pulled from paused Wave 3. No verified MVP-2 finding is
deferred. Pending-gate wording in the dated step and correction records above is
historical and is superseded by this checkpoint.

MVP-3 is next under [the existing execution order](../current.md#next-work--the-cli-mvp).
ADRs [0116](../../decisions/0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)
and [0120](../../decisions/0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md)
remain Proposed and require acceptance before implementation. Their implementing
increments retain the prescribed security review and D64 acceptance bar.
> **Later update — 2026-11-11:** the maintainer subsequently accepted corrected
> ADR-0116/0120 and their implementation plan; the [MVP-3 record](#mvp-3-plan--editing-search-and-reviewable-effects-2026-11-11)
> owns that acceptance and implementation progress. The Proposed wording above
> preserves this earlier merge-checkpoint state.

Phase 2.6, Phase 2.5.5 and milestone M3.5 remain open. npm
still serves `0.1.1`; the D59 release guard and MVP-10 release gates remain in force.

## Deferred-tasks pulled into this phase

The [deferred-tasks.md](../deferred-tasks.md) triage (2026-07-08) mapped these confirmed-open items into
workstreams — each stays checked off **only** in the PR that lands it:

| Deferred item (deferred-tasks.md) | Lands in |
|---|---|
| Node floor: dev/CI bump + supported-floor decision (EOL Node 20) | 2.6.F |
| CLI render-layer (ink component) test harness | 2.6.F |
| `AgentParseError` invisible on `chat --agent` / `agent run` | 2.6.B |
| MCP `stdio` consent gate ([ADR-0084](../../decisions/0084-consent-before-a-local-mcp-spawn.md)) — **closed in 2.6.5 `CR-16`**; the `npx` pinning half stays in [deferred-tasks.md](../deferred-tasks.md) | ~~2.6.B~~ → 2.6.5 |
| Parse-time gate on system-bound fields (trusted `{{ctx}}`) | 2.6.D |
| `@`-glob / directory expansion (ADR-0061) | 2.6.E |
| `chat-resume` opens on an empty viewport (`session_messages` → `TranscriptEntry` projection) | 2.6.G |
| Cross-process gate-resolve TOCTOU (store uniqueness) | 2.6.H |
| Run-resume torn-read wrap · chat-persister turn atomicity | 2.6.H |
| Content-level workflow-identity guard on resume | 2.6.H |
| Run-submission idempotency / double-submit dedup | 2.6.H |
| MCP tool-list cache · network header auth (§6) · mid-call abort | 2.6.I |
| `relavium budget resume` command — implemented and merged in PR #90 | Phase 2.6.5 `W7` (moved from 2.6.K, 2026-09-18) |
| Re-provide `secret`-typed inputs on cross-process resume | 2.6.K |
| Re-arm a still-pending gate's timeout on rehydration | ~~2.6.K~~ → 2.6.5 (closed in 2.6.5 `CR-22`, 2026-08-27) |
| `run:paused` gate-park vs media-park exit distinction | 2.6.K |
| Session budget pause/resume (EA4 ride; 1.V follow-up) | 2.6.K |
| i18n CI key-parity + data/code separation standard | 2.6.L |
| Live `web_search`/`http_request` egress credential resolver | 2.6.M |
| `project`-tier invocation roots/config selectors — complete on main (PR #94) | [Wave 2 Step 2 acceptance](phase-2.5.5-hardening-and-remediation.md#step-2-acceptance--2026-10-12) |
| Exact host-issued scratch floor prerequisite — complete on main (PR #94); production lifecycle remains 2.6.N | [Wave 2 Step 2 acceptance](phase-2.5.5-hardening-and-remediation.md#step-2-acceptance--2026-10-12) / 2.6.N |
| Target-scoped approval cache + structured MCP preview | 2.6.M |
| Approval-consent-line zero-width hardening · shared `[c]` reducer | 2.6.M (with render v2) |

Items evaluated and **kept deferred** (Phase-3/1.AH homes, SDK-blocked, accepted residuals, or
scale-gated) remain in [deferred-tasks.md](../deferred-tasks.md) with their reasons — notably the
`read_media` D12 cluster, retry-from-node, the desktop tool host, and the media/seam 1.AH cluster.

## Review findings folded into this phase (2026-07-19)

A 377-finding multi-agent code review of `HEAD f88b0e8` (373 findings survived two-lens adversarial
verification, against a green toolchain throughout) triaged 27 confirmed findings — 16 work items, one per row
below — into this phase's still-open workstreams, folded directly into the `**Tasks:**`/`**Acceptance:**` text
above. Listed here for traceability; each row's fix is already merged into its workstream's task list, not a
separate backlog.

| Finding(s) | Issue | Lands in |
|---|---|---|
| #2 | `create`/`import`/`export` run parse-only validation while `relavium run` additionally runs the catalog pre-flight (`validateWorkflowWithCatalog`), so an authored file can pass `create` and still be rejected at `run`. | 2.6.A |
| #6 | The in-tree authoring core (`apps/cli/src/authoring/authoring.ts`) that this phase extracts into `packages/authoring` has no direct unit tests for `detectAndParse`/`buildAuthored`/`validateAuthoredWorkflow` — coverage today is incidental, via command-level integration tests only. | 2.6.A |
| #88 | `nodeCatalogIssue` (`packages/core/src/validate-catalog.ts`) only reads a node-level model *override*, never the resolved agent's own `model:`, so the catalog pre-flight is silently dead for the canonical pattern of declaring a model once on the `agents:` block. | 2.6.A |
| #37, G29 | A workflow agent node granted `web_search`, `http_request`, `read_clipboard`, or `notify` is a permanent, silent `tool_unavailable` on `relavium run` — `build-engine.ts` never wires the egress/os host arms for the `workflow-read-write` profile, nothing validates the authored `tools:` grants against that fact before the run starts, and the docs claim these tools are unconditionally available. | 2.6.A |
| #5 | The onboarding/`create` wizard's TTY prompts (`create-prompter.ts`) never `.trim()` typed input, so accidental leading/trailing whitespace silently corrupts an authored value. | 2.6.B |
| #229 | `engine.reconcile()` is tested in `packages/core` but is called from nowhere in `apps/cli` — a killed or crashed run's `runs` row stays `'running'` forever, with no PID/heartbeat mechanism to detect it. | 2.6.G |
| #118, #232 | A failed or cancelled run's persisted `total_cost_microcents` silently undercounts real spend, because `RunFailedEvent`/`RunCancelledEvent` carry no total-cost field of their own and fall back to the last `node:completed` cumulative figure. Found independently by two review rounds. | 2.6.H |
| #114 | `run-history-store.ts`'s `applyDerived` switch over `RunEvent` has no `const exhaustive: never` guard, unlike the identical pattern already added to `engine.ts` — a new `RunEvent` variant could silently fail to update `runs.status`/`total_cost_microcents`. | 2.6.H |
| #277, #282 | `loadRunStateEvents` (bare-invocation Home) and `loadRunEvents` (`relavium logs`/`status`) both do an unguarded `RunEventSchema.parse(JSON.parse(...))` with no try/catch — a single corrupted row anywhere in `history.db` crashes the entire read with a generic internal error. | 2.6.H |
| G12, #273 | `relavium gate list` issues one `loadRunEvents(runId)` query per paused run instead of a single batched query, and `commands/status.ts` independently N+1s the full unbounded token-event firehose per active run instead of the lighter `loadRunStateEvents` API `home-store.ts` already established. | 2.6.H |
| #0 | `decisionFromFlags`/`gateCommand` (`apps/cli/src/gate/decision.ts`) build a `GateDecision` purely from `--approve`/`--reject`/`--input` before the pending gate's `gateType` is even looked up, and `WorkflowEngine#resume` never cross-checks the decision kind against it either — `relavium gate <runId> --input` against an `approval` gate silently writes the wrong decision shape with no error. | 2.6.K |
| #9 | `/doctor`'s `GLYPH` constants render Unicode check/cross marks unconditionally, with no ASCII-degrade path when `NO_COLOR`/non-ANSI output is active. | 2.6.L |
| #73, #261, #262, #263 | Onboarding and the Home chrome hand-roll `toLocaleString('en-US')`/relative-time/pluralization strings (~228 unindirected literals) instead of `Intl.NumberFormat`/`Intl.RelativeTimeFormat`/`Intl.PluralRules`, and `[preferences].language` does not exist in config yet; an open design question on cost-formatting-under-locale needs a recorded decision. | 2.6.L |
| #59, #68, #70, #71, #72 | Five `NO_COLOR`/ASCII-degrade gating gaps in the render layer: `bold` is never gated by the `color` flag at 5 call sites (unlike every other style prop); status/warning glyphs have no ASCII fallback under `NO_COLOR`; an attachment-bar pictographic emoji renders unconditionally; `NO_COLOR=''` (present-but-empty) is treated as absent. | 2.6.L |
| #305 | `write_file`'s approval card shows no content diff/preview of what will be written, produces no post-write trace event, and is silent end-to-end when running in `auto` accept-edits mode — a blind spot on the highest-consequence built-in tool. | 2.6.M |
| G30 | `http_request` is advertised to chat agents (`wireEgressOs=true` for `chat-read-write`), but no config path ever populates `allowedDomains` for chat — every call deterministically fails `domain_not_allowed` before the approval prompt renders. | 2.6.M |

## Milestones

| In-phase | Completed by | Outcome |
|----------|--------------|---------|
| M2.6-1 Foundation | 2.6.F | Node floor decided/shipped; full-screen renderer + TUI harness — the substrate for every arm *(met except the v0.2.0 release clause, which closes with the CLI MVP's MVP-10)* |
| M2.6-2 Authoring core shared | 2.6.A | `@relavium/authoring` + catalog-aware pre-flight |
| M2.6-3 Conversational authoring | 2.6.B + 2.6.D | "define a workflow…" → valid YAML in the Home; `{{ctx.*}}` lands |
| M2.6-4 The Home-managed CLI | 2.6.G + 2.6.H + 2.6.I + 2.6.J + 2.6.K | Every management task doable from Home; drillable, attributed run history; onboarding v2 |
| M2.6-5 First-class experience | 2.6.C + 2.6.E + 2.6.L + 2.6.M + 2.6.Q | Toolbelt parity + settings/theme/i18n + chat polish + per-model capability matrix (effort/output-limit clamp) & models.dev pricing long-tail closing the cost-cap safety hole and the opaque `error: validation` |
| M2.6-6 Orchestration foundation | 2.6.N | Catalog child-session spawn + standardized I/O + lineage + the artifact-store substrate |
| M2.6-7 Nested execution & generation | 2.6.O + 2.6.P | On-the-fly generation (security-reviewed) + parallel fan-out + the authored `subworkflow` node (schema v1.1) — **phase close** |

> The **F5 cost-cap safety subset** of **2.6.Q** (the data-source-independent budget-governor hardening) is a
> candidate to pull earlier into **M2.6-4** given its severity — a safety control silently off, and it needs
> no models.dev fetch. The full capability-matrix + pricing enrichment stays in M2.6-5.

## Sequencing & parallelization

### Dependency matrix

→ = "must land before"; empty = independent (can start immediately).

| Workstream | Depends on | Blocks |
|------------|-----------|--------|
| **2.6.A** | — | 2.6.B |
| **2.6.B** | 2.6.A, 2.6.D | 2.6.O (generation path) |
| **2.6.C** | — | — (residual, any time) |
| **2.6.D** | — | 2.6.B |
| **2.6.E** | 2.6.F, 2.6.L (theme) | — |
| **2.6.F** | — | 2.6.E, 2.6.G, 2.6.L, 2.6.M (render-v2), 2.6.N (chat UX) |
| **2.6.G** | 2.6.F, 2.6.H, 2.6.K | — |
| **2.6.H** | — | 2.6.G, 2.6.N (lineage), 2.6.P (lineage) |
| **2.6.I** | — | — |
| **2.6.J** | — | — |
| **2.6.K** | — | 2.6.G (shared resume core) |
| **2.6.L** | 2.6.F | 2.6.E (theme integration) |
| **2.6.M** | 2.6.F (render-v2), 2.6.N (invoke_agent wiring) | — |
| **2.6.N** | 2.6.H (lineage), 2.6.F (chat UX) | 2.6.O, 2.6.P, 2.6.M (invoke_agent acceptance) |
| **2.6.O** | 2.6.N (spawn mechanism), 2.6.B (generation) | — (phase close) |
| **2.6.P** | 2.6.N (lineage) | — (phase close) |
| **2.6.Q** | — | — |

2.6.Q (model-catalog enrichment) is **Day-1 independent** — the pure `mergeModelCatalog` and the host
`ModelRefreshService` it extends already exist, and it does **not** need 2.6.F. It **soft-enhances** 2.6.C
(the reseat `/effort` sub-step), 2.6.I (`/providers` per-model annotations), 2.6.L (`/settings` "models in
use"), and 2.6.E's effort UX, but **hard-gates none** of them; the F5 cost-cap safety subset is standalone.

### Critical path

```text
2.6.F ──────────────────────────────→ 2.6.M (render-v2) ──────────────→ phase close
   │                                                                       ↑
   ├─→ 2.6.L → 2.6.E                                                       │
   ├─→ 2.6.G (via H + K)                                                   │
   └─→ 2.6.N (chat UX) ┐                                                   │
                       ├─→ 2.6.N (foundation) ─→ 2.6.O (generation+parallel) ┤
2.6.H (lineage) ───────┘                     └─→ 2.6.P (subworkflow + v1.1) ─┘
2.6.A → 2.6.D → 2.6.B ─────────────────────────→ 2.6.O (generation path) ───┘
```

**2.6.F is the bottleneck** — the full-screen renderer gates 5 workstreams (E, G, L, M render-v2, N chat UX). Ship it first, unblock the rest. The **orchestration spine is now three-stage along a safety gradient**: 2.6.N (foundation — needs only F + H) → 2.6.O (generation + parallel — needs N + B) **and** 2.6.P (`subworkflow` + schema v1.1 — needs N), the two closing the phase (M2.6-7). The **authoring spine** (A → D+B) feeds 2.6.O's generation, and the **data spine** (H → G) runs in parallel with F. **2.6.M (render-v2)** depends only on F (the details view / diff rendering need the viewport, not the browser data); **2.6.M (invoke_agent acceptance)** gates on 2.6.N (catalog invoke_agent), not on O/P.

### Parallelization tracks

Eight independent streams (2.6.Q joins as Day-1 independent — it does not need 2.6.F):

| Track | Workstreams | Starts when | Produces |
|-------|------------|-------------|----------|
| **Substrate** | 2.6.F | Day 1 | Full-screen Home, Node 22 floor, TUI harness |
| **Data** | 2.6.H | Day 1 | Attributed run history, tool traces, gate uniqueness |
| **Authoring core** | 2.6.A | Day 1 | `@relavium/authoring` package |
| **Run-ops** | 2.6.K | Day 1 | Shared resume core, secret re-provide (budget resume moved to 2.6.5 `W7`) |
| **Ctx** | 2.6.D | Day 1 | `{{ctx.*}}` interpolation, `agent run --input` |
| **Toolbelt engine** | 2.6.M (tools only) | Day 1 | `edit_file`, `search_files`, `find_files`, `todo`, `ask_user`, `web_search` |
| **Catalog enrichment** | 2.6.Q | Day 1 | models.dev capability matrix + pricing long-tail; cost-cap safety; effort/`max_tokens` clamp |
| **Management** | 2.6.I, 2.6.J | Any time | Provider/MCP mgmt, onboarding v2 |

Once their deps land:

| Track | Workstream | Starts when | Produces |
|-------|------------|-------------|----------|
| **Authoring** | 2.6.B | A + D landed | Conversational YAML authoring, /create wizard |
| **Browsers** | 2.6.G | F + H + K landed | /workflows, /agents, actionable strip, permissions |
| **Orchestration foundation** | 2.6.N | F + H landed | Catalog child-session spawn, standardized I/O, artifact-store port + central root, lineage, cost roll-up, guardrails |
| **Chat UX** | 2.6.E | F + L landed | Syntax highlighting, rewind/fork, message queue, /copy, cheat sheet |
| **Theme/i18n** | 2.6.L | F landed | Theme system, /settings, n-locale catalog (`en`+`tr` shipped) |
| **M render-v2** | 2.6.M (render half) | F landed | Tool-call details view, diff rendering |

Final integration (last to land — **phase close**):

| Track | Workstream | Depends on | Produces |
|-------|------------|-----------|----------|
| **Generation + parallel** | 2.6.O | N + B landed | Model-generated agents/workflows (**security-reviewed**), parallel fan-out + error policy |
| **Workflow composition** | 2.6.P | N landed | Authored `subworkflow` node, `schema_version` 1.1 (additive), nested-run events |
| **Toolbelt final** | 2.6.M (invoke_agent) | N landed | invoke_agent acceptance |
| **Residual** | 2.6.C | Any time | /cost per-model breakdown |

```mermaid
flowchart LR
    subgraph Day1["Independent (start Day 1)"]
        F["2.6.F<br/>full-screen foundation"]
        H["2.6.H<br/>run-detail data"]
        A["2.6.A<br/>authoring package"]
        K["2.6.K<br/>run-ops resume"]
        D["2.6.D<br/>ctx interpolation"]
        M_t["2.6.M<br/>tools (<i>engine-pure</i>)"]
        I["2.6.I<br/>provider + MCP mgmt"]
        J["2.6.J<br/>onboarding v2"]
        C["2.6.C<br/>reseat transcript-carry + /cost"]
        Q["2.6.Q<br/>catalog enrichment<br/>(capability + pricing)"]
    end

    subgraph AfterF["After 2.6.F (+ deps)"]
        L["2.6.L<br/>settings · theme · i18n"]
        G["2.6.G<br/>browsers"]
        E["2.6.E<br/>chat polish"]
        N["2.6.N<br/>orchestration foundation<br/>(catalog spawn)"]
    end

    subgraph AfterA["After 2.6.A"]
        B["2.6.B<br/>conversational authoring"]
    end

    subgraph Final["Final integration — phase close"]
        O["2.6.O<br/>generation + parallel<br/>(security-reviewed)"]
        P["2.6.P<br/>subworkflow + schema v1.1"]
        M_r["2.6.M<br/>render-v2 + invoke_agent"]
    end

    F --> L
    F --> G
    F --> E
    F --> N
    H --> G
    K --> G
    A --> B
    D --> B
    H --> N
    L --> E
    N --> O
    N --> P
    B --> O
    N --> M_r
    M_t -. part of .-> M_r
```

## Dependencies

- **Phase 2.5** complete — specifically 2.5.A (the wired tool-environment), 2.5.E (per-tool approval /
  modes), 2.5.B/C (the Home + the two-registry command model), and ADR-0063 (config-write) — all met.
- **2.J** (the in-tree authoring core 2.6.A promotes) — landed.
- **2.6.N** (orchestration foundation) needs only **2.6.F** (chat UX) + **2.6.H** (lineage) — catalog-only
  spawn does **not** depend on the authoring package. **2.6.O** (on-the-fly generation) additionally
  requires **2.6.B**'s authoring loop; **2.6.P** (`subworkflow` node) requires **2.6.N**'s lineage
  substrate. So the orchestration spine is F+H → N → {O (with B), P}.
- **2.6.H** (durable run detail) — required by 2.6.N/2.6.P for parent-child lineage in `history.db`.
- The Node supported-floor decision (2.6.F) gates the ink-7 evaluation but **not** the rest of the phase
  (every workstream must land on the current floor if the maintainer defers the bump).

## Exit criteria (go / no-go → Phase 3)

1. `relavium` on a TTY opens the **full-screen Home**; `--json` / CI / non-TTY behavior is byte-identical
   (regression-harness proven); the inline renderer remains available.
2. **The Home manages everything**: providers/keys, models, MCP servers, settings, workflow
   start/monitor/history with node-level drill-down, agent start/resume (a resumed session repaints its transcript, restores its agent/model identity, and continues), gate + budget resolution, and
   authoring — no routine task requires a shell subcommand. (Subcommands and the ADR-0049 machine surface
   are untouched and permanent; whether to de-emphasize interactive duplicates in `--help` is a phase-end
   review decision, never a removal.)
3. A conversational request produces a strict-valid, catalog-validated `.relavium.yaml`
   (pre-flight-proven, security-reviewed); the knowledge pack is derived, not restated; `{{ctx.*}}` lands
   and `agent run --input` is unblocked.
4. The **toolbelt** ships (`edit_file`, `search_files`, `find_files`, todo, `ask_user`, working
   `web_search`, `invoke_agent` wired for chat) — YAML-selectable, mode-gated, rendered with diffs,
   details, and syntax-highlighted code blocks behind a passed security review.
5. Run history is attributed and drillable (list → run → node with the quintet + tool summaries); the
   gate TOCTOU is store-closed; crashed runs reconcile; cross-process live watch works.
6. `/settings`, the theme system (incl. the accessibility pair), and **`en` + `tr`** localization ship with
   CI key-parity.
7. **Orchestration ships across the safety gradient**: (2.6.N) a chat agent spawns a **catalog** sub-agent
   — `/spawn <agent> <task>` and model-driven — with standardized I/O, full parent lineage in `history.db`,
   cost roll-up, and parent-cancel propagation, over the host artifact-store port + central ephemeral root
   (the fs-floor home-anchoring fix landed); (2.6.O) the model **generates and runs** a one-off agent when
   no catalog agent matches — **behind a passed dedicated generation security review** (tool-grants clamped
   to the parent, secrets excluded) — and fans out to parallel children under an explicit error policy;
   (2.6.P) a workflow calls another via an authored `subworkflow` node under `schema_version: '1.1'` while
   existing `1.0` files parse unchanged. Auto-generated artifacts live in the central ephemeral root under
   `~/.relavium/`, **never** in the project directory.
8. The required ADRs are Accepted, and every touched spec's canonical home
   ([commands.md](../../reference/cli/commands.md), [home.md](../../reference/cli/home.md),
   [chat-session.md](../../reference/cli/chat-session.md),
   [built-in-tools.md](../../reference/shared-core/built-in-tools.md),
   [config-spec.md](../../reference/contracts/config-spec.md),
   [database-schema.md](../../reference/shared-core/database-schema.md)) is updated — no docs-debt carried
   out of the phase.

## Required ADRs

> **This table is the canonical tracker for ADR status, owning workstream, and disposition across
> the phase.** Workstream sections reference it rather than restating ADR details.

| # | ADR | Topic | Status | Workstream |
|---|-----|-------|--------|------------|
| 1 | [ADR-0058][] | `@relavium/authoring` + conversational authoring | Proposed | 2.6.A / 2.6.B |
| 2 | [ADR-0059][] | Mid-session model reseat | **Accepted** (shipped 2.5.G) | 2.6.C (residual) |
| 2b | [ADR-0070][] | Durable per-model session cost attribution | **Accepted** | 2.6.C |
| 3 | [ADR-0060][] | Session `{{ctx.*}}` interpolation | Proposed | 2.6.D |
| 4 | [ADR-0067][] | Node supported-floor `>=22` (supersedes ADR-0021) | **Accepted** | 2.6.F |
| 5 | [ADR-0068][] | Full-screen TUI renderer + component test harness | **Accepted** | 2.6.F |
| 5b | [ADR-0069][] | `string-width` for the CLI renderer | **Accepted** | 2.6.F |
| 6 | *(new)* | Management browsers + durable run detail (amends ADR-0036) | Drafted when 2.6.G starts | 2.6.G / 2.6.H |
| 7 | *(new)* | MCP management surface + config-write extension (extends ADR-0063) | Drafted when 2.6.I starts | 2.6.I |
| 8 | *(new)* | Onboarding auth paths + Relavium-account forward design (rides ADR-0012–0015) | Drafted when 2.6.J starts | 2.6.J |
| 9 | [ADR-0120](../../decisions/0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md) (part 1) | Toolbelt additions + tool-render/approval-preview contract (extends ADR-0029/ADR-0057); `ask_user` mid-turn pause is a separate later ADR | **Accepted** with corrected MVP-3 plan, 2026-11-11; implementation/security gates open. The split of 2026-11-04 is unchanged. | 2.6.M |
| 9b | [ADR-0116](../../decisions/0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md) | Built-in chat editing/search grant and configurable starting mode (D62, amends ADR-0057) | **Accepted** with corrected MVP-3 plan, 2026-11-11; implementation/security gates open. | 2.6.M |
| 10 | *(new)* | i18n + theming architecture | Drafted when 2.6.L starts | 2.6.L |
| 11 | *(new)* | Syntax highlighting dependency (`highlight.js` + `cli-highlight` via `ink-syntax-highlight`) + markdown rendering architecture | Drafted when 2.6.E starts *Split 2026-11-04 for the MVP: part 1 is an in-house markdown/code-block renderer with no dependency (MVP-2); the highlighter decision follows the MVP.* | 2.6.E |
| 12 | *(new)* | Child-session **foundation** (extends ADR-0024/ADR-0036; parent-child lineage schema, standardized I/O contract, the **host artifact-store port** + central ephemeral root + fs-floor home-anchoring, catalog spawn, cost roll-up, abort propagation, depth/concurrency guardrails) | Drafted when 2.6.N starts | 2.6.N |
| 13 | *(new)* | On-the-fly **generation + parallel orchestration security** (the generation-as-codegen threat model, schema-valid≠safe, tool-grant clamping, the parallel error-policy contract; sits on ADR-0060's taint precedent) — **mandatory security review is the ship-gate** | Drafted when 2.6.O starts | 2.6.O |
| 14 | *(new)* | `subworkflow` node + **`schema_version` 1.1** additive migration (the first versioned-schema bump — additive/opt-in, subworkflow-only not `loop`; the nested-run event namespace; the recorded deferral of dynamic `invoke_workflow`) | Drafted when 2.6.P starts | 2.6.P |
| 15 | [ADR-0071][] | models.dev as the model-metadata source | **Accepted** | 2.6.Q |
| 15b | [ADR-0072][] | Model metadata in the DB behind a generated offline floor | **Accepted** | 2.6.Q |

[ADR-0058]: ../../decisions/0058-relavium-authoring-package-and-conversational-authoring.md
[ADR-0059]: ../../decisions/0059-cli-mid-session-model-reseat.md
[ADR-0060]: ../../decisions/0060-session-ctx-prompt-interpolation.md
[ADR-0067]: ../../decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md
[ADR-0068]: ../../decisions/0068-full-screen-tui-renderer-ink7-harness.md
[ADR-0069]: ../../decisions/0069-string-width-for-the-cli-renderer.md
[ADR-0070]: ../../decisions/0070-durable-per-model-session-cost-attribution.md
[ADR-0071]: ../../decisions/0071-models-dev-as-the-model-metadata-source.md
[ADR-0072]: ../../decisions/0072-model-metadata-in-the-db-behind-a-generated-offline-floor.md

> **Deferred:** A future validator-dependency ADR will be needed for `output_schema` deep JSON-Schema
> conformance (currently out of scope for this phase; tracked in
> [deferred-tasks.md](../deferred-tasks.md)).

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **Scope breadth** — seventeen workstreams invite drift | Milestone gating (M2.6-1..7); the additive arms (E/L parts, M render-v2, 2.6.Q enrichment) can defer individual items without breaking the spine; the pull-in table keeps deferred-tasks as the single overflow home |
| **Generation-as-codegen** — the model authors and runs agents (2.6.O) | Split out of the safe foundation (2.6.N) with its **own dedicated security review** as a ship-gate; schema-valid ≠ safe (the generated system-prompt is an injection surface); tool grants clamped to the parent's set, never escalated; secrets structurally excluded; sits on ADR-0060's taint precedent |
| Full-screen renderer performance/fragility on ink | The floor bump unlocks ink 7; the component harness carries performance regression thresholds; the inline renderer is retained as a first-class fallback, and non-TTY paths never change |
| Child-session cascade failure — a sub-agent failure kills the parent turn | Child failure surfaces as a structured error in the parent's tool result, never a crash; the parent agent can recover (retry with a different agent, rephrase the task, report to user); the `tool_failed` recovery path (2.5.H) handles the child-error class explicitly |
| Rendering args/diffs leaks sensitive data (reverses a 2.5 posture) | Sanctioned only by the toolbelt-additions ADR + a mandatory security review; every string passes the shared sanitize floor; bounded previews; secrets structurally excluded (keychain-only, never in tool args by construction) |
| Secret re-provide relaxes a fail-closed guarantee | stdin-only discipline, keychain re-resolution preferred, mandatory security review, and the shared resume core keeps one audited path |
| Authoring knowledge drifts from the specs (restate) | Derived from the Zod schemas / reference docs; a no-duplication check is an acceptance gate |
| Authored YAML smuggles secrets | The `parseWorkflow` secret-taint gate + the write-surface security review |
| Browser complexity balloons | Hard cap at the three-level drill-down; keystroke filters, no query DSL; tabs + deep-links instead of six commands; the desktop canvas stays the rich escape hatch |
| i18n churn destabilizes strings | Data ≠ code catalog; CI key-parity + dead-string lint land **with** the first locale, not after |
| Syntax highlighting bundle size (highlight.js is large untrimmed) | Tree-shake to the built-in agent's curated default set; lazy-load the rest on first use; the `ink-syntax-highlight` ADR gates the cost decision |
| ADR load stalls the phase | ADRs are drafted per-workstream as Proposed when the workstream starts (the 2.5 pattern), not all up front |
| Competitor-copy erodes Relavium's posture | Patterns are stolen, postures are not: keychain-only secrets, fail-closed approval, YAML-first artifacts, and the ADR-0049 machine contract are non-negotiable filters on every borrowed idea |

Part of [roadmap/](../README.md). Carry-over hardening lives in [../deferred-tasks.md](../deferred-tasks.md).
## Status record moved from current.md — 2026-11-04

> Moved verbatim from `docs/roadmap/current.md` as it stood at `5a328bca` by the
> [PR #96 review correction](phase-2.5.5-hardening-and-remediation.md#moved-by-the-pr-96-review-correction--2026-11-04).
> Only relative links were rewritten for this directory and heading levels lowered by one.

### Not started yet

The rest of **Phase 2.6 — Conversational Authoring and the First-Class CLI**
([phase-2.6-conversational-authoring.md](phase-2.6-conversational-authoring.md), in progress —
**2.6.F is done**,
unblocked by the 2.5 close and **re-scoped 2026-07-08** from maintainer UX findings + a competitor
research pass + the deferred-tasks triage): a full-screen, Home-managed CLI (browsers for
workflows/runs/agents, provider + MCP + settings management, onboarding v2 with the Relavium-account
stub), competitor-breadth tools under the governance floor, settings/theming/`en`+`tr` localization,
the run-ops resume follow-up — plus the original spine: the shared `@relavium/authoring` package and
a chat that **authors** standards-valid `.relavium.yaml`. Then the surfaces and the cloud —
everything after the engine critical path: the desktop app (Phase 3) and the VS Code extension (Phase 4), then **Product Phase 2** — first **managed
inference** ([phase-5-managed-inference.md](phase-5-managed-inference.md), the opt-in
`managed` gateway, engine still local), then the **cloud execution layer and web portal**
([phase-6-cloud-execution-portal.md](phase-6-cloud-execution-portal.md)), the two
decoupled per Option B. See the [phase index](../README.md#phase-index) and the
[milestone spine](../README.md#global-milestone-spine) (M3 onward).
