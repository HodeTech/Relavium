# Archive — Provenance Map

> Frozen. Never edit the files in this folder.

This folder holds the **raw analysis JSONs** that seeded the entire Relavium `docs/`
tree. They are kept verbatim as a historical record of where the living documentation
came from. The relationship is strictly **one-way**: the archive seeds the living docs;
the living docs never write back into the archive, and the archive is never updated to
match later decisions.

When the archive and a living doc disagree, **the living doc wins** — it reflects the
current vision; the archive reflects the analysis at a point in time.

## Why two JSONs, and why one is partially outdated

The two files capture two phases of the same project's thinking:

| File | Phase captured | Stance |
|------|----------------|--------|
| `deep-analysis-raw.json` | The **earlier**, SaaS-first / cloud-first architectural exploration. | **Partially outdated.** It assumes Next.js, a Hono executor, Postgres-first storage, and a single web-SaaS surface. Cite only its still-true cross-cutting artifacts (DB column designs, cross-provider tool normalization, the node-type catalog, the SSE event schema, store shapes). Never reintroduce its Next.js / Hono-executor / SaaS-first / "desktop IDE" framing. |
| `synthesis-raw.json` | The **current** multi-surface, local-first pivot. | **Authoritative for the pivot.** It establishes Tauri v2 desktop, the four surfaces, local-first Phase 1, OS-keychain secrets, and git-native YAML workflows. |

> Note on filenames: the content predates the file naming. `deep-analysis-raw.json`
> contains the earlier deep architectural analysis (backend/frontend/database/
> orchestrator/ux/roadmap/critiques/masterPlan); `synthesis-raw.json` contains the
> later product pivot (desktop/vscode/cli/corePortal/strategy/synthesis). Read by
> content, cite by filename.

Two further frozen files capture process provenance (not product analysis):
`docs-structure-plan.json` is the provenance of the **docs tree itself** — the
inventory + information-architecture design that decided which folders and files exist
and which raw section seeds each. `foundation-review-result.json` is the provenance of
the **multi-LLM pivot and foundation review** — the four-option LLM analysis, the
decision to build the internal `@relavium/llm` abstraction (recorded live in
[ADR-0011](../../decisions/0011-internal-llm-abstraction.md)), and the per-directory
review findings that drove the fixes. Both are meta-provenance, useful if the tree or a
core decision is ever revisited, and follow the same frozen, one-way rules.

Three more frozen files are **review snapshots** — the raw outputs of the multi-agent
review rounds the corpus was hardened against, kept as audit provenance, never living
docs: `deep-review-result.json` and `deep-review-gap-result.json` are the first deep
multi-agent review and its gap pass (whose dominant finding became
[ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md) and the propagation
sweep), and `final-review-result.json` is the final comprehensive review (the keytar /
ADR-amendment / canonical-home findings, which became
[ADR-0019](../../decisions/0019-cli-node-keychain-library.md), the §7 amend rule, and the
seam/engine-entry-point reconciliations). They record *what the reviews found and when*;
the living docs already carry the fixes, so cite these only to trace a fix's origin.

## Provenance — `deep-analysis-raw.json` → living docs

This is the earlier analysis. **Only its cross-cutting, still-true artifacts** flowed
into the tree; its SaaS/Next.js/LangGraph framing was deliberately dropped.

| Frozen section | Seeded living doc(s) |
|----------------|----------------------|
| `database` (13-table schema, `workflowDefinitionJSONSchema`, SQLite-vs-Postgres differences, partitioning DDL) | [reference/desktop/database-schema.md](../../reference/desktop/database-schema.md), [reference/contracts/workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md), [architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md) |
| `frontend` (5 Zustand store shapes, 9 canvas node types, SSE event schema, ReactFlow performance footguns) | [reference/shared-core/store-shapes.md](../../reference/shared-core/store-shapes.md), [reference/shared-core/node-types.md](../../reference/shared-core/node-types.md), [reference/contracts/sse-event-schema.md](../../reference/contracts/sse-event-schema.md), [architecture/state-management.md](../../architecture/state-management.md) |
| `backend` (cross-provider `ToolNormalizer`, RunEvent contract, 22-endpoint REST surface, BullMQ job types) | [architecture/multi-llm-providers.md](../../architecture/multi-llm-providers.md), [reference/contracts/sse-event-schema.md](../../reference/contracts/sse-event-schema.md), [architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md) — REST/BullMQ marked **Phase 2 only** |
| `orchestrator` (8 system-prompt sections, agent-as-tool schema, 10 failure modes, parallel merge strategies) | [architecture/execution-model.md](../../architecture/execution-model.md), [architecture/shared-core-engine.md](../../architecture/shared-core-engine.md) — concepts only; the Python/LangGraph idiom was dropped per [ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md) |
| `masterPlan` (final tech-stack reconciliation, RunEvent union, simplest-orchestrator blueprint, security checklist) | [tech-stack.md](../../tech-stack.md), [architecture/shared-core-engine.md](../../architecture/shared-core-engine.md), [architecture/local-first-and-security.md](../../architecture/local-first-and-security.md) — re-grounded from Postgres/server-keys to SQLite/OS-keychain |
| `ux` (design system, 24 keyboard shortcuts, node visual states, critical UX decisions) | [reference/desktop/routes-and-screens.md](../../reference/desktop/routes-and-screens.md) |
| `roadmap` (phased plan, risk matrix) | [roadmap/README.md](../../roadmap/README.md) — re-grounded to the engine→CLI→desktop build order |
| `critiques` (adversarial verdicts: Next.js-as-executor danger, LangGraph overkill, CanvasContext O(n) re-renders, server-side-keys) | Baked into [decisions/](../../decisions/README.md): [ADR-0002](../../decisions/0002-vite-react-tanstack-not-nextjs.md), [ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md), and the ReactFlow/Zustand decision |

## Provenance — `synthesis-raw.json` → living docs

This is the current-vision pivot and the **primary** source for most of the tree.

| Frozen section | Seeded living doc(s) |
|----------------|----------------------|
| `desktop` (Tauri v2 decision, local data architecture, 12 built-in tools, IPC, MCP, platform gotchas) | [decisions/0001-tauri-v2-over-electron.md](../../decisions/0001-tauri-v2-over-electron.md), [architecture/desktop-architecture.md](../../architecture/desktop-architecture.md), [reference/desktop/tauri-plugins.md](../../reference/desktop/tauri-plugins.md), [reference/shared-core/built-in-tools.md](../../reference/shared-core/built-in-tools.md), [reference/shared-core/mcp-integration.md](../../reference/shared-core/mcp-integration.md), [reference/contracts/ipc-contract.md](../../reference/contracts/ipc-contract.md), [reference/desktop/keychain-and-secrets.md](../../reference/desktop/keychain-and-secrets.md) |
| `vscode` (7 capabilities, Model C hybrid connection, LSP design, extension API) | [reference/vscode/extension-api.md](../../reference/vscode/extension-api.md), [tutorials/vscode/trigger-from-vscode.md](../../tutorials/vscode/trigger-from-vscode.md) |
| `cli` (null in the raw JSON — CLI facts reconstructed from `synthesis`) | [reference/cli/commands.md](../../reference/cli/commands.md), [tutorials/cli/run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md) |
| `corePortal` (Workflow YAML Spec v1.0, complete example, engine API, plugin API, MCP, local-vs-cloud mode, portal pages) | [reference/contracts/workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md), [reference/contracts/agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md), [architecture/shared-core-engine.md](../../architecture/shared-core-engine.md), [reference/portal/api-reference.md](../../reference/portal/api-reference.md), [architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md) |
| `strategy` (7-competitor analysis, UVP, go-to-market, workflow-as-code, pricing) | [analysis/competitive-landscape-2026-06-03.md](../competitive-landscape-2026-06-03.md), [uvp.md](../../uvp.md), [vision.md](../../vision.md) |
| `synthesis` (product identity, locked tech choices, monorepo, phasing, day-one DX, killer features, build order, top risks) | [vision.md](../../vision.md), [tech-stack.md](../../tech-stack.md), [project-structure.md](../../project-structure.md), [roadmap/README.md](../../roadmap/README.md), [architecture/overview.md](../../architecture/overview.md), the [tutorials/](../../tutorials/README.md) |

## Rules

1. **Frozen.** Do not edit, reformat, or "update" these JSONs. They are a snapshot.
2. **One-way.** Provenance flows archive → living. Never copy a current decision back in.
3. **Living wins on conflict.** If a JSON says Next.js/Postgres/SaaS and the living tree
   says Tauri/SQLite/local-first, the living tree is correct (see the current vision in
   [vision.md](../../vision.md) and [product-constraints.md](../../product-constraints.md)).
4. **Cite, don't carry.** When a living doc draws on the archive, it should cite the
   reusable artifact — never reintroduce the dead-end framing around it.
