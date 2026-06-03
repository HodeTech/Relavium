# Architectural Principles

> Status: draft — to be expanded

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

## To be expanded

The following are known principles to flesh out as the architecture docs land:

- Clean execution-mode interface (local vs cloud) — link to
  [execution-model.md](../architecture/execution-model.md) once written.
- Checkpoint-based resume as a first-class engine capability (retry-from-node).
- Cross-provider tool normalization as the boundary between `packages/llm` and
  `packages/core`.
- Zustand direct subscriptions for the ReactFlow canvas (no Context) — see
  [ADR-0010](../decisions/0010-zustand-direct-subscriptions-for-reactflow.md).
