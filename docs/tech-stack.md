# Tech Stack

- **Status**: Version-of-record
- **Related**: [project-structure.md](project-structure.md), [decisions/README.md](decisions/README.md)

This is the single source of truth for Relavium's pinned technology choices.
Architecture Decision Records ([decisions/](decisions/README.md)) reference this
file for versions rather than restating them, so a version bump happens in one
place. The stack was adversarially reviewed by a 10-agent workflow before being
locked.

## Final Stack

| Layer | Decision | Key reason |
|-------|----------|-----------|
| Desktop framework | **Tauri v2** (Rust backend + OS WebView) | 2–5 MB bundle vs Electron's 85–120 MB; all required plugins exist. See [ADR-0001](decisions/0001-tauri-v2-over-electron.md). |
| Frontend (all surfaces) | **Vite + React 19 + TanStack Router** | Not Next.js — SSE streaming + ReactFlow canvas are incompatible with RSC / edge runtime. See [ADR-0002](decisions/0002-vite-react-tanstack-not-nextjs.md). |
| Multi-LLM | **Internal `@relavium/llm` abstraction** over official provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`; DeepSeek via the OpenAI-compatible adapter) | No 3rd-party framework, no Vercel, no Python sidecar; an owned provider-agnostic seam gives unified streaming + tool calling + cost across Anthropic / OpenAI / Gemini / DeepSeek with no vendor lock-in. See [ADR-0011](decisions/0011-internal-llm-abstraction.md). |
| Orchestration engine | **Pure TypeScript** (`packages/core`) | No LangGraph-Python; the same concepts are implementable in TS. Engine is framework-agnostic and runs identically on every surface. |
| Database (local, Phase 1) | **SQLite + Drizzle ORM** (SQLCipher) | Tauri plugin available; encrypted at rest with SQLCipher. |
| Database (cloud, Phase 2) | **PostgreSQL 16 + Redis 7 + BullMQ** | *Phase 2 only.* Same Drizzle schema, different driver. |
| API key storage | **OS keychain** (`tauri-plugin-keychain`) | macOS Keychain / Windows Credential Manager / libsecret. Never plaintext, never sent to the frontend. |
| CLI | **TypeScript + commander.js + ink** | Same language as the engine; React for the TUI. |
| VS Code extension | **Standard VS Code Extension API** | Bundles `@relavium/core` in-process — no desktop app required. |
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
- **Local-first storage.** SQLite + SQLCipher locally; the same Drizzle schema
  ports to PostgreSQL for the Phase 2 cloud layer. See
  [reference/desktop/database-schema.md](reference/desktop/database-schema.md)
  and the SQLite-vs-Postgres porting notes there.
- **Keys never touch the frontend.** API keys live in the OS keychain and are
  resolved by the backend at call time. See
  [reference/desktop/keychain-and-secrets.md](reference/desktop/keychain-and-secrets.md).

## Supporting Tooling

- **Monorepo**: Turborepo + pnpm workspaces (see [project-structure.md](project-structure.md))
- **UI**: shadcn/ui + Radix on Tailwind, shared via `packages/ui`
- **Canvas**: ReactFlow (custom node types in `packages/ui`)
- **Schemas / types**: Zod (shared via `packages/shared`)
- **Testing**: Vitest (unit), Playwright (e2e)

> Phase-2-only rows (PostgreSQL/Redis/BullMQ, Better Auth) are marked explicitly.
> They are not part of the shipped Phase 1 stack. The **managed-inference** rows
> (KMS/secrets-manager, the merchant-of-record/Stripe billing rail, Redis metering)
> are also Phase-2-only and gate the *managed* mode specifically — they do not touch
> the BYOK-local Phase-1 path. See
> [decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md)
> and [architecture/managed-inference.md](architecture/managed-inference.md).
