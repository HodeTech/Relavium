# Phase 2.6 — Conversational Authoring and Parity

> Status: Planned. Depends on the Phase 2.5 spine (the wired tool-environment and the per-tool
> approval / mode system). Spine: 2.6.A (`@relavium/authoring` package) → 2.6.B (conversational
> authoring agent). Additive: 2.6.C / D / E.

- **Related**: [../README.md](../README.md), [phase-2.5-cli-consolidation.md](phase-2.5-cli-consolidation.md), [phase-2-cli.md](phase-2-cli.md), [phase-3-desktop.md](phase-3-desktop.md), [phase-4-vscode.md](phase-4-vscode.md), [../../reference/contracts/workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md), [../../reference/contracts/agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md), [../../reference/shared-core/node-types.md](../../reference/shared-core/node-types.md), [../../decisions/README.md](../../decisions/README.md) (ADR-0058–0060)

The second half of the consolidation work, split out from
[phase-2.5-cli-consolidation.md](phase-2.5-cli-consolidation.md) because it is ADR-heavy and depends on
that spine. It realises the product's tagline — *"Start as an agent. Ship the workflow."* — at the
terminal: a conversation can now **author** a standards-valid Relavium workflow/agent, switch models
mid-session, and reach competitor-parity ergonomics.

## Goal

Let a `relavium chat` conversation produce a **standards-valid** `.relavium.yaml` from a free-text
request, promote the existing authoring core into a shareable `@relavium/authoring` package so every
surface can consume it, enable mid-session model switching, and close the remaining parity polish — all
on top of the Phase 2.5 tool-environment and approval system.

## Outcomes (Definition of Done)

- A `@relavium/authoring` package (`@relavium/authoring`) wraps parse / validate / serialize / scaffold
  for workflows and agents; the CLI's `create` / `import` / `export` consume it; desktop and VS Code can
  too.
- Every authored artifact passes a single `validateAuthoredWorkflow` pre-flight (parse **and** catalog
  validation); a failure returns a field-named, secret-free error the model self-corrects against.
- A conversational authoring agent turns a free-text request into a strict-valid `.relavium.yaml`, writes
  it only under accept-edits/auto with a scope-tiered host, and offers to `/run` it.
- `/models` switches the bound model **mid-session** (a host-side reseat), carrying cost/turn and
  persisting per-message model attribution — with an explicit tool-context-loss notice.
- Session `{{ctx.*}}` prompt interpolation lands, unblocking `agent run --input`; parity polish
  (`/rewind`, `/fork`, advanced `@`-injection, markdown render, `/theme`) ships.

## Scope

### In scope

- The `@relavium/authoring` package promotion + catalog-aware pre-flight back-port; the conversational
  authoring agent + its product-side knowledge pack; mid-session model reseat; session `{{ctx.*}}`
  interpolation; and the parity/polish lane.

### Explicitly out of scope (→ Phase 3 / later)

- `/compact` model-summarised compaction (no engine summarisation primitive); full-fidelity reseat
  tool-context (the persister/schema extension, 1.X/1.Z); `read_media` input (D12); in-app
  scrollback/pager; live provider `/v1/models` fetch; a multi-pane dashboard. Tracked in
  [../deferred-tasks.md](../deferred-tasks.md).

## Work breakdown

### 2.6.A — `@relavium/authoring` package promotion + catalog-aware pre-flight

The authoring core already exists in-tree (`apps/cli/src/authoring/authoring.ts`, landed with 2.J):
it wraps `parseWorkflow` / `serializeWorkflow` / `parseAgent` / `buildAuthored` / `detectAndParse` from
`@relavium/core` and drives the `create` / `import` / `export` commands. **Decision (maintainer):**
promote it to a shared `@relavium/authoring` package so desktop ([phase-3-desktop.md](phase-3-desktop.md))
and VS Code ([phase-4-vscode.md](phase-4-vscode.md)) can consume the same authoring core, not just the CLI.

**Tasks:**

- Scaffold `packages/authoring` (`@relavium/authoring`) — pure TS, platform-free (engine-purity holds)
  — and **extract-and-decouple** the existing `apps/cli/src/authoring/` core into it (it is **not** a free
  move: the core imports `CliError`, `discoverCatalog`, and `findProjectConfigDir` from `apps/cli`, which
  a package may not import — a forbidden `packages → apps` back-edge). Cut those three: replace `CliError`
  with a platform-free typed error the CLI maps to exit codes at the boundary; keep catalog **discovery**
  and `findProjectConfigDir` CLI-side and pass the catalog **in**. Add an import-zone lint fence (Phase-0
  seam-fence pattern) banning `packages/authoring → apps/cli`. Follow the add-package procedure
  ([.claude/skills/add-package/SKILL.md](../../../.claude/skills/add-package/SKILL.md)).
- Expose a single `validateAuthoredWorkflow(yaml, catalog)` = `parseWorkflow` **+**
  `validateWorkflowWithCatalog` pre-flight. The existing `create` / `import` / `export` pre-flight is
  **parse-only** (it does not call the catalog validator — only the run path does); **back-port** the
  catalog-aware pre-flight so wizard-authored and conversationally-authored artifacts share one front
  end and `create` can never accept a model/modality the run path rejects.
- Add direct unit tests for the authoring core (`detectAndParse` / `buildAuthored` /
  `validateAuthoredWorkflow`) — today only the command wrappers are tested.

**Acceptance:** `@relavium/authoring` builds and imports **only** `@relavium/core` + `@relavium/shared`
(lint-fence enforced — no `apps/cli` back-edge); the CLI consumes it with `create` / `import` / `export`
round-tripping **unchanged** (regression-tested); `create` runs the same catalog-aware pre-flight the run
path uses; the core is directly unit-tested. **Required ADR: `@relavium/authoring` package +
conversational-authoring pre-flight contract.**

### 2.6.B — Conversational workflow/agent authoring agent

A `relavium chat` request such as *"define a workflow with these agents…"* produces a strict-valid
`.relavium.yaml`. This is the sibling of `chat-export` (which **replays** a transcript into a workflow);
here the model **generates** the artifact.

**Tasks:**

- Add an authoring agent (an `--agent` profile or a `/author` mode) whose system prompt references a
  **product-side knowledge pack** — a model-readable cheat-sheet **derived from** the canonical specs
  ([node-types.md](../../reference/shared-core/node-types.md),
  [workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md),
  [agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md)) and the Zod schemas, plus a minimal
  valid example per node type. The knowledge is **derived, never restated** ([CLAUDE.md](../../../CLAUDE.md)
  #8); a check proves no schema is duplicated. It **must not** live under `.claude/skills/` — those are
  repo-development (Claude Code) procedures and the Relavium **product** agent never reads `.claude/`.
- The self-correct loop reuses the same `detectAndParse` / `validateAuthoredWorkflow` pre-flight: model →
  YAML → pre-flight → field-named, secret-free error → model fixes (improve `AgentParseError` to carry
  line/col, a Phase-2 follow-up).
- The artifact is written only under accept-edits/auto with the scope-tiered host (2.5.A/2.5.E), then the
  Home offers *"Run it now with `/run`?"* — closing the author → run loop on one screen.
- **Discoverability of the UVP (proactive, opt-out):** because *"Start as an agent. Ship the workflow."*
  is the product's promise, a chat that has run several tool turns or produced a reusable plan surfaces a
  quiet, dismissible hint — *"turn this session into a workflow with `/export`"* — so the tagline is
  discovered, not buried in a slash command. Opt-out via config; never interrupts a turn.

**Acceptance:** a free-text request yields a strict-valid `.relavium.yaml` that passes the same pre-flight
as `relavium run`; an invalid draft is corrected via the secret-free error loop; the file is written only
with approval; the proactive `/export` hint appears (and is dismissible); a knowledge-restate check passes.
A security review of the write surface + the authored artifact's secret-taint gate passes. **Required ADR:
shared with 2.6.A.**

### 2.6.C — Mid-session model reseat (`/models` mid-chat)

A session binds one model for its lifetime ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md);
the fallback plan is memoized). Switching the **model** mid-chat is therefore a host-side **reseat**:
reconstruct the transcript (`reconstructSessionState`) and start a new `AgentSession.resume` bound to the
new model/provider, carrying cost/turn. (Mode changes do **not** reseat — that is the reseat-less mode
system in 2.5.E.)

**Tasks:** mid-chat `/models` performs the reseat; persist per-message `modelId` (the `session_messages`
schema already has the column — only the CLI persister wiring is missing); surface an explicit, shared
notice on the `chat-resume` family that **prior tool calls and file contents are not carried to the new
model** (the transcript is text-only; full-fidelity tool-context is Phase 3); show a per-model cost
breakdown.

**Acceptance:** `/models` mid-chat continues the conversation on a new model from the next turn; cost/turn
carry; per-message model attribution persists; the context-loss notice is shown; "carries full context" is
never claimed. When [ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md) flips to Accepted, its
refinement of [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md) is recorded **in
place** on ADR-0024 with a dated `> Amended …` note + a Related forward-link (documentation-style §7), since
it refines without reversing. **Required ADR: mid-session reseat (model-only) — refines ADR-0024.**

### 2.6.D — Session `{{ctx.*}}` prompt interpolation

The agent system prompt is passed verbatim today (no template resolution), and `agent run --input` is
reserved/rejected until this lands. The conversational authoring agent and reseat both want session
context, so the Phase-2 deferral is pulled forward.

**Tasks:** resolve `{{ctx.*}}` in the session system prompt against session-scoped variables (an engine
follow-up); unblock `agent run --input k=v`.

**Acceptance:** `{{ctx.*}}` resolves in a session prompt; `agent run --input` is accepted and reaches the
prompt. **Required ADR: session `{{ctx.*}}` interpolation** (engine amendment).

### 2.6.E — Parity and polish

The competitor-parity ergonomics that are valuable but not on the spine: `/rewind` + `/fork` (the engine
already has per-node-boundary checkpoints to build on); advanced `@`-injection (glob/directory, respecting
ignore files); basic markdown + code-block rendering with a table layout (syntax highlighting is Phase 3;
a markdown dependency, if chosen, needs an ADR); `/theme` with at least one **high-contrast** and one
**colorblind-safe** theme (and semantic markers — `✓`/`✗`/`⏸` — that survive `--no-color`/`NO_COLOR`, so
the experience is not colour-dependent). Note any screen-reader limitations of the raw-mode TUI as a
documented constraint with a non-TTY fallback.

**Acceptance:** `/rewind`/`/fork` work over the checkpoint substrate; `@`-injection handles globs/dirs;
markdown/code-blocks render; `/theme` switches themes including the high-contrast and colorblind-safe
options; the colour-free path stays legible via semantic markers.

## Milestones

| In-phase | Completed by | Outcome |
|----------|--------------|---------|
| M2.6-1 Authoring core shared | 2.6.A | `@relavium/authoring` + catalog-aware pre-flight |
| M2.6-2 Conversational authoring | 2.6.B + 2.6.D | "define a workflow…" produces valid YAML; `{{ctx.*}}` lands |
| M2.6-3 Reseat + parity | 2.6.C + 2.6.E | Mid-session model switch + parity polish |

## Sequencing & parallelization

2.6.A first (the package + shared pre-flight). Then 2.6.B (conversational authoring, depends on A + the
2.5.E approval/write path) in parallel with 2.6.C (reseat) and 2.6.D ({{ctx.*}}); 2.6.E is additive
polish throughout.

## Dependencies

- **Phase 2.5** complete — specifically 2.5.A (the wired write-capable tool-environment) and 2.5.E
  (accept-edits per-tool approval), which gate the authoring write surface.
- **2.J** (the in-tree authoring core that 2.6.A promotes) — landed.

## Exit criteria (go / no-go)

1. `@relavium/authoring` is the shared authoring core; the CLI consumes it; `create` runs the catalog-aware
   pre-flight.
2. A conversational request produces a strict-valid `.relavium.yaml` (pre-flight-proven, security-reviewed);
   the knowledge pack is derived, not restated.
3. Mid-session `/models` reseat works with the context-loss notice and per-message attribution.
4. `{{ctx.*}}` interpolation lands and `agent run --input` is unblocked.
5. The required ADRs are Accepted.

## Required ADRs

Drafted as **Proposed** alongside this plan; each is reviewed and finalized (→ Accepted) when its
workstream begins.

1. [ADR-0058](../../decisions/0058-relavium-authoring-package-and-conversational-authoring.md) —
   `@relavium/authoring` package + conversational-authoring pre-flight contract (2.6.A/2.6.B).
2. [ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md) — mid-session model reseat;
   refines [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md) (2.6.C).
3. [ADR-0060](../../decisions/0060-session-ctx-prompt-interpolation.md) — session `{{ctx.*}}`
   interpolation, unblocking `agent run --input` (2.6.D).

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Authoring knowledge drifts from the specs (restate) | Derive from the Zod schemas / reference docs; a no-duplication check is an acceptance gate ([CLAUDE.md](../../../CLAUDE.md) #8) |
| Authored YAML smuggles secrets | The authored artifact passes the existing `parseWorkflow` secret-taint gate; the write surface is security-reviewed |
| Reseat sells a false promise | An explicit context-loss notice; full-fidelity tool-context is Phase 3 |
| Package promotion over-engineers a CLI-only need | The maintainer decision is multi-surface (desktop/VS Code also consume); the add-package ADR records the rationale |

Part of [roadmap/](../README.md). Carry-over hardening lives in [../deferred-tasks.md](../deferred-tasks.md).
