# Tech Stack

- **Status**: Version-of-record
- **Related**: [project-structure.md](project-structure.md), [decisions/README.md](decisions/README.md)

This is the single source of truth for Relavium's pinned technology **choices**.
Architecture Decision Records ([decisions/](decisions/README.md)) reference this
file rather than restating choices, so a change happens in one place. The stack was
adversarially reviewed by a 10-agent workflow before being locked.

> **Where the numeric version pins live.** Exact dependency versions are pinned in the
> pnpm **`catalog:`** in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) (the single place
> every package's `catalog:` range resolves from), not in this file — this page is the
> version-of-record for the *choices*, the catalog for the *numbers*. A bump is a one-line
> catalog edit.

## Final Stack

| Layer | Decision | Key reason |
|-------|----------|-----------|
| Desktop framework | **Tauri v2** (Rust backend + OS WebView) | 2–5 MB bundle vs Electron's 85–120 MB; all required plugins exist. See [ADR-0001](decisions/0001-tauri-v2-over-electron.md). |
| Frontend (all surfaces) | **Vite + React 19 + TanStack Router** | Not Next.js — SSE streaming + ReactFlow canvas are incompatible with RSC / edge runtime. See [ADR-0002](decisions/0002-vite-react-tanstack-not-nextjs.md). |
| Multi-LLM | **Internal `@relavium/llm` abstraction** over official provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`; DeepSeek via the OpenAI-compatible adapter) | No 3rd-party framework, no Vercel, no Python sidecar; an owned provider-agnostic seam gives unified streaming + tool calling + cost across Anthropic / OpenAI / Gemini / DeepSeek with no vendor lock-in. See [ADR-0011](decisions/0011-internal-llm-abstraction.md). |
| Orchestration engine | **Pure TypeScript** (`packages/core`) | No LangGraph-Python; the same concepts are implementable in TS. Engine is framework-agnostic and runs identically on every surface. |
| YAML parser (engine) | **`yaml`** (eemeli/yaml — pure-JS, confined to `packages/core`) | Decodes an authored `.relavium.yaml` string to a plain JS object for the strict `WorkflowSchema`; pure-JS (no native binding) preserves the zero-platform-imports invariant (Tauri WebView / Bun), and strict Zod does all schema enforcement. The engine's first runtime dependency, landed with the 1.L parser and pinned in the `catalog:`. See [ADR-0035](decisions/0035-yaml-parser-dependency.md). |
| Expression sandbox (engine) | **QuickJS compiled to WebAssembly** — via `quickjs-emscripten-core` + a single-file **sync** variant (candidate `@jitl/quickjs-singlefile-mjs-release-sync`), instantiated via the standard `WebAssembly` global from embedded bytes; **never** the default `getQuickJS()` loader (it imports `node:fs`). Confirmed + version-pinned in the `catalog:` by the 1.AB perf spike. | Deterministic, resource-capped evaluation of `condition` / `transform` / `merge_fn` JS expressions that runs in **every** host the engine runs in, including the Tauri WebView. `isolated-vm` (native binding) and Node `vm` (`node:vm`) are rejected for breaking the zero-platform-imports invariant; `new Function` / `eval` are rejected on **sandbox-safety** grounds — they evaluate with full host access (no isolation, no determinism, no resource caps), so they cannot provide the sandbox's guarantees regardless of portability. The engine's second runtime dependency (after the `yaml` loader). See [ADR-0027](decisions/0027-expression-sandbox.md) (and its 2026-06-12 contract addendum) and the canonical contract in [expression-sandbox-spec.md](reference/shared-core/expression-sandbox-spec.md). |
| Database (local, Phase 1) | **SQLite + Drizzle ORM** | Tauri plugin available; the **desktop** store is encrypted at rest with SQLCipher. Node-side consumers (CLI, `@relavium/db` tests) use the **`better-sqlite3`** driver ([ADR-0021](decisions/0021-node-sqlite-driver-better-sqlite3.md), re-affirmed under the `>=22` floor by [ADR-0067](decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md)); the **CLI** store is **unencrypted at rest** — guarded by `0600`/`0700` owner-only permissions + the OS keychain, no credentials stored ([ADR-0050](decisions/0050-cli-history-db-at-rest-posture.md)). |
| Database (cloud, Phase 2) | **PostgreSQL 16 + Redis 7 + BullMQ** | *Phase 2 only.* Same Drizzle schema, different driver. |
| API key storage | **OS keychain**, one `KeychainStore` interface with a per-surface accessor — desktop `tauri-plugin-keychain` (Rust), **CLI `@napi-rs/keyring`** (Node; *not* the archived `keytar`, see [ADR-0019](decisions/0019-cli-node-keychain-library.md)), VS Code `vscode.SecretStorage` | macOS Keychain / Windows Credential Manager / libsecret. Never plaintext, never sent to the frontend. See [ADR-0006](decisions/0006-os-keychain-for-api-keys.md). |
| CLI | **TypeScript + commander.js + ink** (`@clack/prompts` setup wizards; bundled to a single ESM `bin` with `tsup`) | Same language as the engine; React for the TUI. **Distribution** ([ADR-0051](decisions/0051-cli-distribution-thin-bundle-private-engine.md)): an *engine-inlined* bundle — the proprietary `@relavium/*` is inlined, every third-party dep (incl. prebuilt native addons) is externalized + declared; published to npm as `relavium` via a tag-triggered, cross-OS-smoke-gated `Release CLI` workflow. |
| MCP client (inbound) | **`@modelcontextprotocol/sdk`** — the official Model Context Protocol TypeScript SDK, confined to **`@relavium/mcp`** | Agents consume external MCP servers' tools. The SDK + `node:child_process` (its stdio transport) are fenced inside `@relavium/mcp`, which surfaces outward only Relavium `ToolDef`s + an `McpCapability`; `packages/core` never imports it (engine purity). The discovered-tool arg validator is **in-house, dependency-free** (no `ajv`). See [ADR-0034](decisions/0034-mcp-client-sdk-dependency.md) (the dependency + slot) and [ADR-0052](decisions/0052-inbound-mcp-client-package-lifecycle-registration.md)/[ADR-0053](decisions/0053-mcp-network-transport-egress-security.md) (the implementation shape + network-transport security). Pinned in the `catalog:`. |
| VS Code extension | **Standard VS Code Extension API** | Bundles `@relavium/core` in-process — no desktop app required. |
| API framework (`apps/api`, Phase 2) | **Hono** | *Phase 2 only.* Lightweight, web-standard `Request`/`Response`, streaming-first; wraps `@relavium/core`, runs on Bun + Node. See [ADR-0016](decisions/0016-api-framework-hono.md). |
| API runtime (`apps/api`, Phase 2) | **Bun** | *Phase 2 only.* Runtime for the cloud/gateway API; the engine's **zero platform-specific imports** guarantee must hold on Bun (no Bun-only APIs in `packages/core`/`packages/llm`). See [ADR-0017](decisions/0017-cloud-runtime-bun.md). |
| Auth (portal, Phase 2) | **Better Auth v1** | Framework-agnostic; Drizzle adapter. |
| State (frontend) | **Zustand v5** | ReactFlow nodes are NOT in React Context — direct Zustand subscriptions prevent O(n) re-renders during streaming. See [ADR-0010](decisions/0010-zustand-direct-subscriptions-for-reactflow.md). |
| Master-key vault (managed, Phase 2) | **KMS / secrets-manager** (cloud KMS or HashiCorp Vault) | *Phase 2, managed inference only.* Stores Relavium's own provider keys / key pools — never the frontend, never plaintext. See [ADR-0013](decisions/0013-managed-key-vault-and-pools.md). |
| Billing rail (managed, Phase 2) — **primary** | **Merchant-of-record: Paddle / Lemon Squeezy** | *Phase 2, managed only.* **Legal seller-of-record** and the billing rail — absorbs VAT/sales-tax, chargebacks, disputes. The internal `usage_events` ledger meters consumption and feeds invoicing through it. Default rail given tax/chargeback absorption; launch-blocking precondition. See [ADR-0014](decisions/0014-managed-metering-quota-and-billing.md), [ADR-0015](decisions/0015-managed-mode-data-handling-and-compliance.md). |
| Billing rail (managed, Phase 2) — **alternative** | **Stripe** (direct PSP / subscription engine) | *Phase 2, managed only.* The direct-PSP alternative — subscriptions + prepaid credits + metered overage — used **only if not going through an MoR**. **Mutually exclusive** with the MoR rail, never layered with it. See [ADR-0014](decisions/0014-managed-metering-quota-and-billing.md). |
| Metering store (managed, Phase 2) | **Redis 7** | *Phase 2, managed only.* Real-time usage metering, quota enforcement, and rate-limit/cooldown state for the inference gateway. |

## Notes on the Choices

- **Multi-LLM, not single-provider.** One unified streaming + tool-calling +
  cost interface across providers is provided by Relavium's own `@relavium/llm`
  adapters — thin hand-rolled adapters over each provider's official TS SDK,
  behind a provider-agnostic seam that no vendor type ever crosses. Per-agent
  fallback chains (`[claude → gpt-4o → gemini]`) are a first-class feature. No
  3rd-party LLM framework (no Vercel AI SDK, no LangChain); LiteLLM and any
  Python sidecar are explicitly out. See
  [ADR-0011](decisions/0011-internal-llm-abstraction.md) and the seam contract
  in [reference/shared-core/llm-provider-seam.md](reference/shared-core/llm-provider-seam.md).
- **One engine, every surface.** `packages/core` has zero platform-specific
  imports, so it runs identically inside the Tauri WebView, the VS Code
  extension host, the Node.js CLI, and (Phase 2) a Bun API server. This is the
  decision that makes cross-surface consistency real rather than aspirational.
- **Local-first storage.** SQLite locally (SQLCipher-encrypted on desktop;
  unencrypted with owner-only permissions on the CLI, [ADR-0050](decisions/0050-cli-history-db-at-rest-posture.md));
  the same Drizzle schema ports to PostgreSQL for the Phase 2 cloud layer. See
  [reference/desktop/database-schema.md](reference/desktop/database-schema.md)
  and the SQLite-vs-Postgres porting notes there.
- **Keys never touch the frontend.** API keys live only in the OS keychain,
  resolved at call time, and never in the WebView renderer or any log/checkpoint.
  On the **desktop** the keychain read and the LLM HTTPS egress are delegated to
  the **Rust core** (`llm_stream`), so the raw key is used only in Rust and never
  enters the WebView; on **CLI / VS Code / Bun** the key is resolved inside the
  single trusted process at call time. See
  [reference/desktop/keychain-and-secrets.md](reference/desktop/keychain-and-secrets.md)
  and [architecture/desktop-architecture.md](architecture/desktop-architecture.md).

## Supporting Tooling

- **Node.js runtime**: **Node 24** (Active LTS) for dev + CI (pinned in [`.nvmrc`](../.nvmrc)); the supported floor is **`>=22`** per the root + `apps/cli` `package.json` `engines.node`, with a CI leg pinned to the exact floor (`22.0.0`) so the published minimum stays proven. The TypeScript engine and every Node surface (CLI, the `@relavium/db`/`@relavium/llm` test runs, Phase-2 Bun parity) target this range. _(The floor rose **20.12 → `>=22`** at Phase 2.6.F — [ADR-0067](decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md): Node 20 is EOL and shipped no `better-sqlite3` prebuild (forcing a C++ source build), and `ink` 7 (the full-screen renderer) hard-requires `>=22`. A **breaking release** for the published binary; `better-sqlite3` re-affirmed over `node:sqlite`. `@types/node` (dev) is pinned to the floor `^22`.)_
- **Monorepo**: Turborepo + pnpm workspaces (see [project-structure.md](project-structure.md))
- **UI**: shadcn/ui + Radix on Tailwind, shared via `packages/ui`
- **Canvas**: ReactFlow (custom node types in `packages/ui`)
- **Schemas / types**: Zod (shared via `packages/shared` — `@relavium/shared`'s only runtime dependency) — see [ADR-0020](decisions/0020-zod-runtime-schema-library.md)
- **Testing**: Vitest (unit), Playwright (e2e)

> Phase-2-only rows (PostgreSQL/Redis/BullMQ, Better Auth) are marked explicitly.
> They are not part of the shipped Phase 1 stack. The **managed-inference** rows
> (KMS/secrets-manager, the merchant-of-record/Stripe billing rail, Redis metering)
> are also Phase-2-only and gate the *managed* mode specifically — they do not touch
> the BYOK-local Phase-1 path. See
> [decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md)
> and [architecture/managed-inference.md](architecture/managed-inference.md).
