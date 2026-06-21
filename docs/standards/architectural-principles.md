# Architectural Principles

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [tech-stack.md](../tech-stack.md), [product-constraints.md](../product-constraints.md), [security-review.md](security-review.md), [documentation-style.md](documentation-style.md)

These are the binding engineering principles for Relavium. They are derived from the
finalized tech-stack decisions (see [tech-stack.md](../tech-stack.md) and the
[decisions/](../decisions/README.md) ADRs) and from the hard
[product-constraints.md](../product-constraints.md). A proposal that breaks one of
these principles needs an ADR that supersedes the principle — not a quiet exception.

Where a principle has a concrete spec or contract, it links **down** to the one
canonical home for that artifact rather than restating it (see
[documentation-style.md](documentation-style.md) §6).

## 1. Engine-first

The pure-TypeScript workflow engine in `packages/core` is the critical path, and every
surface is a thin shell over it. The build order is fixed:

1. `packages/shared` + `packages/llm` + `packages/core` — the engine, with full unit
   test coverage, before any surface exists.
2. `apps/cli` — the fastest feedback loop; it proves the engine under real conditions
   with no UI complexity.
3. `apps/desktop` (Tauri v2) + `packages/ui` — the main surface.
4. `apps/vscode-extension` — reuses the proven engine and UI components.
5. `apps/api` + `apps/portal` — the Phase-2 cloud layer, only after Phase 1 is
   battle-tested.

**Applied rule:** never build or design surface code before the core engine it depends
on is tested. The CLI exists in part to keep the engine's APIs honest — they must be
ergonomic for a scripted caller, with no hidden assumptions about a browser
environment.

## 2. One language — TypeScript

The engine, all adapters, the CLI, the desktop frontend, the VS Code extension, and
(Phase 2) the API and portal are TypeScript. There is **no Python sidecar** and **no
LangGraph-Python** dependency: multi-LLM streaming goes through Relavium's own
`@relavium/llm` abstraction over the official provider SDKs (Anthropic, OpenAI, Google,
DeepSeek) behind a vendor-type-free seam, and orchestration is implemented directly in
TypeScript. No vendor SDK type ever crosses that seam. One language means the engine is
shared verbatim across every surface, not reimplemented per host. See
[ADR-0011](../decisions/0011-internal-llm-abstraction.md) (which supersedes the earlier
Vercel AI SDK decision recorded under ADR-0004).

## 3. Local-first by default

Phase 1 has zero cloud dependency and requires no account. Agents run on the user's
machine; LLM API calls go directly from the user's machine to the provider. Privacy is
a feature, not a setting. Design Phase 1 so it never *requires* cloud, and keep the
engine behind a clean execution interface so the same workflow runs locally (Phase 1)
or on cloud workers (Phase 2) without an architectural rewrite. See
[product-constraints.md](../product-constraints.md) and
[roadmap/README.md](../roadmap/README.md) for the phasing.

## 4. The desktop app is not an IDE

The desktop app is an **agent-management center**: workflow canvas, agent
configuration, run monitoring and history, provider/key management, and cost tracking.
It has **no** code editor, file browser, or terminal — that is the VS Code extension's
job. Any feature proposal for the desktop app must stay within agent-management scope.
Code-adjacent work belongs to the extension.

## 4a. A conversational agent is a first-class engine entry point

A multi-turn chat **`AgentSession`** is a first-class entry point into the engine —
**alongside** `WorkflowEngine`, never a second code path bolted on. It **reuses** the
same substrate: the planned `AgentRunner`, the `ToolRegistry`, the `@relavium/llm` seam,
the `RunEventBus`, and the engine's security envelope (keychain custody, fs-scope tiers,
the tool allowlist). It does **not** fork the core for "chat vs workflow"; a session is a
conversation that wraps the same runner a workflow agent node uses, so a hardening or fix
in the substrate is inherited by both entries with no second implementation to keep in
sync. The session runtime contract has one canonical home in
[agent-session-spec.md](../reference/contracts/agent-session-spec.md).

**Applied rule:** never branch the runner, tool-dispatch, or security checks on whether
the caller is a session or a workflow. New conversational behavior is built on the shared
substrate, not on a parallel chat-only path; a chat-only fork of `AgentRunner`,
`ToolRegistry`, or the event bus is a design violation. See
[ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md) and
[ADR-0025](../decisions/0025-agent-surface-refines-desktop-scope.md) (which refines, not
reverses, principle 4 and [ADR-0007](../decisions/0007-desktop-is-not-an-ide.md)).

## 5. Git-native, version-controllable workflows

Workflows and agents are YAML files (`.relavium.yaml` / `.agent.yaml`) designed to be
committed, PR'd, code-reviewed, and reverted like any other source. The workflow file —
not a session or a vendor database — is the durable, auditable record of how a team
uses AI. Schemas have one canonical home:
[workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) and
[agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md).

## 6. Secrets never touch disk or the frontend

API keys live in the OS keychain (macOS Keychain / Windows Credential Manager /
libsecret), never in plaintext and never sent to the frontend. The canonical flow is in
[keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md); the operational
how-to is [add-a-provider-key.md](../runbooks/add-a-provider-key.md).

## 7. One canonical home; no duplicated specs

Every spec (YAML schema, SSE event shape, IPC contract, DB DDL, node-type catalog, tool
list, route list) lives in exactly one `reference/` file and is cited everywhere else by
relative link. Duplicated specs drift; a drifted spec is worse than none. This is the
engineering side of [documentation-style.md](documentation-style.md) §6.

## 8. Born-compliant documentation

Documentation is part of the deliverable, not an afterthought. New docs follow
[documentation-style.md](documentation-style.md) from the first commit — there is no
"fix the formatting later" pass. New non-trivial decisions are recorded as ADRs from
[adr-template.md](adr-template.md) when they are made, not reconstructed later.

## 9. Build in-house; minimize third-party dependencies

Relavium is a **first-class product**, and the core differentiating layers are built
in-house rather than assembled from heavy frameworks. We **own the seams that matter** —
the multi-LLM abstraction (`@relavium/llm`), the workflow engine, orchestration, and
run/state — and write our own, deliberately better implementations for them rather than
adopting a framework that imposes its own concepts or creates lock-in. Every new
third-party dependency is a liability to justify, not a default to reach for; a new
runtime dependency in the core path requires an [ADR](../decisions/README.md).

**Performance and security are first-class, not afterthoughts.** Every design choice
must be defensible on performance, security, and zero-bloat grounds, and we prefer
measuring over assuming.

**But never reinvent security-critical or battle-tested low-level primitives.** We stand
on the OS, Tauri/WebView, the language runtime, React, and SQLite, and we **never
hand-roll cryptography, TLS, or OS-keychain primitives** — rolling your own crypto is the
opposite of high security. We use vetted implementations (the OS keychain, platform AES,
the runtime's TLS) and wrap them tightly behind our own interface. The in-house rule is
about owning the *product* layers; it is not a license to re-implement vetted security
foundations. See [security-review.md](security-review.md) and
[ADR-0011](../decisions/0011-internal-llm-abstraction.md).

## 9a. Dependency-bump cooling window

A new dependency version is not trusted the day it ships. Supply-chain attacks land
through freshly published versions of otherwise-reputable packages, and a brand-new
release has had no time to be audited by anyone. So when adding a dependency or bumping
one, **prefer a version that has been public for a while over the just-released latest**.
**Concrete bar:** a minor or patch bump should be at least **7 calendar days** old before
it enters the lockfile; a **major** bump (larger change surface, more time for the
ecosystem to surface regressions) at least **14 days**; anything **under 72 hours** old is
bleeding-edge and is blocked unless the PR justifies it. Treat these as the default review
bar, not rigid math — a version a day or two under the line can still pass on reviewer
judgement with a stated reason. This is a review posture, not a license to fall behind: a
security or CVE fix is the explicit exception — it may skip the window entirely, with the
reason recorded in the PR. The rule targets *unvetted novelty*, not staying current.

**Applied rule:** when a `package.json` diff adds or raises a dependency, the reviewer
checks the chosen version's publish age against the bar above — blocking an under-72h pin
and flagging a still-uncooled one (< 7 days, or < 14 for a major) absent a recorded
security justification; the safe default is the newest version that has cleared the
cooling window and been exercised by the ecosystem. This matters most for the
dependency-heavy surfaces (the CLI's `commander`/`ink`/`@clack/prompts`/`tsup`, the
keychain and MCP bindings) where the new-dependency count is highest. Adding a dependency
at all still needs the principle-9 bar (an [ADR](../decisions/README.md) for a new runtime
dependency in the core path); this principle governs *which version* of an approved
dependency to take. Native CI enforcement of the cooling window is deferred (it needs a
tooling step that does not yet exist); until then it is a human review check.

## 10. Clean execution-mode interface — local, cloud, managed

A run executes in one of three **execution modes**, all behind the single
`LLMProvider`/`ExecutionHost` seam: **local** (BYOK, the engine runs in the host
process and LLM calls go straight to the provider — the Phase-1 default), **cloud**
(BYOK-central, Phase 2 — the same run lifecycle runs on cloud workers and events stream
over HTTP SSE instead of IPC), and **managed** (Phase 2 — the engine still runs locally
but LLM egress is redirected through Relavium's metered gateway on Relavium's own key).
The surfaces see identical `RunEvent` objects in every mode, so the choice of mode is a
deployment concern, never an engine rewrite.

**Applied rule:** mode is selected at the seam, not threaded through the engine. The
`packages/core` run lifecycle (parse → plan → walk → checkpoint) is byte-for-byte the
same across all three modes; adding cloud execution adds a worker host, and managed adds a
`ManagedGatewayProvider`, but neither changes how a node runs. Design any
mode-sensitive code so a fourth mode could be added by implementing the seam, not by
editing the engine. See [execution-model.md](../architecture/execution-model.md),
[managed-inference.md](../architecture/managed-inference.md), and
[ADR-0012](../decisions/0012-managed-inference-dual-mode.md).

## 11. Checkpoint-based resume is a first-class engine capability

State is persisted at **every node boundary**, not only at the end of a run. After each
node completes, the engine writes a checkpoint capturing run status, per-node states, the
completed/pending node IDs, and (for an orchestrator) its message history. This is the
mechanism — not an add-on — behind three guarantees: **resume after crash** (the host
reconciles in-flight runs from the last checkpoint on startup), **retry-from-node** (a
user re-runs from any node without replaying completed upstream work), and **idempotency**
(re-executing a node uses a stable key derived from `runId + nodeId + retryCount`, so a
retry never double-applies a side effect).

**Applied rule:** treat the checkpoint shape as a contract, not an implementation detail.
The same checkpoint is what Phase-1 local SQLite persistence and the Phase-2 cloud layer's
durable execution both consume, so a node must be written to be safely re-runnable from its
last boundary. Never introduce run state that lives only in memory and cannot be
reconstructed from the checkpoint. See
[shared-core-engine.md](../architecture/shared-core-engine.md#checkpoint-and-resume) and
[execution-model.md](../architecture/execution-model.md).

## 12. Cross-provider tool normalization is the `packages/llm` ↔ `packages/core` boundary

The four providers describe tool/function calling differently (Anthropic `input_schema`,
OpenAI/DeepSeek `function.parameters`, Gemini `functionDeclarations` over an OpenAPI
subset), and a workflow author must never have to care. The **`ToolNormalizer`** lives in
`packages/llm`, on the Relavium side of the seam: it takes Relavium's single canonical tool
definition (built-in and MCP tools alike), translates it into each provider's required
shape on the way out, and normalizes the provider's tool-call response back into one shape
on the way in. The engine-side `ToolRegistry` and dispatch live in `packages/core` and see
only the canonical shape — they never pattern-match a vendor tool format.

**Applied rule:** the canonical-tool ↔ wire translation belongs in `packages/llm` and
nowhere else; the engine speaks only the canonical tool shape. This is what lets the same
agent definition run unchanged against any provider and makes cross-provider fallback
chains possible (switching providers mid-chain needs no re-encoding of tools). A vendor
tool format leaking into `packages/core` is a seam violation, exactly as a leaked vendor
SDK type is (principle 9, [ADR-0011](../decisions/0011-internal-llm-abstraction.md)). See
[multi-llm-providers.md](../architecture/multi-llm-providers.md#tool-normalization) and
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md).

## 13. Zustand direct subscriptions for the ReactFlow canvas

The desktop canvas drives its state from **Zustand with direct, selector-based store
subscriptions — not React Context**. ReactFlow renders many nodes that update
independently and at high frequency during a run (streaming tokens, status changes, cost
ticks); a Context provider would re-render the whole subtree on every state change. Direct
store subscriptions let each node component subscribe to only the slice it paints, so a
token arriving on one node face does not re-render the rest of the graph.

**Applied rule:** read canvas/run state via fine-grained Zustand selectors, never by
threading a Context value through the node tree, and keep selectors narrow so a high-rate
update touches the minimum component set. This is a binding performance boundary for the
canvas, not a stylistic preference. See
[ADR-0010](../decisions/0010-zustand-direct-subscriptions-for-reactflow.md) and
[state-management.md](../architecture/state-management.md).
