# ADR-0008: Local-first Phase 1, cloud Phase 2

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0005-sqlite-drizzle-local-postgres-cloud.md](0005-sqlite-drizzle-local-postgres-cloud.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0009-git-native-workflow-yaml.md](0009-git-native-workflow-yaml.md), [product-constraints.md](../product-constraints.md), [tech-stack.md](../tech-stack.md)

## Context

Relavium has to decide *where workflows run* and *what the product depends on to function* — and it has to decide this before any storage, secrets, or engine-hosting choice is locked, because those choices all cascade from it. An execution model is the hardest thing to change later: build for the cloud first and you bake a server, an account system, and a network round-trip into the core; build for local first and you risk a second, painful re-architecture if cloud execution is ever needed.

Two product facts settle the stakes. First, the audience is developers who value privacy and want to try a tool with zero friction — no sign-up, no server, no data leaving their machine. Second, the long-term vision genuinely needs cloud execution for 24/7 automation, team sharing, and mobile triggers (see [vision.md](../vision.md)). So the question is not "local *or* cloud" but "which first, and how to keep the door open for the other." The hard product constraints are recorded in [product-constraints.md](../product-constraints.md).

## Decision

**Phase 1 is local-first with zero cloud dependency and no account. Phase 2 adds cloud execution behind the same engine interface.** The engine is built once to run in both modes via a clean hosting boundary; Phase 1 must never be designed in a way that *requires* the cloud.

In Phase 1:

- Workflows execute on the user's own machine; LLM API calls go directly from that machine to the providers (see [ADR-0011](0011-internal-llm-abstraction.md)) using the user's own keys from the OS keychain (see [ADR-0006](0006-os-keychain-for-api-keys.md)).
- No account is required and no Relavium server is contacted to run a workflow. Privacy is a feature, not a setting.
- Run history and cost data live in a local encrypted SQLite file (see [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)).

In Phase 2 (cloud — explicitly *not* shipped in Phase 1): cloud execution workers run workflows server-side for 24/7 automation, team sharing, and remote triggers, backed by PostgreSQL 16 + Redis 7 + BullMQ (see [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)) and account/auth via Better Auth. The Phase-2 design lives in [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md).

Considered options:

1. **Local-first Phase 1, cloud Phase 2, one engine behind a hosting interface** — ship privacy and zero-friction now, keep cloud reachable later. *Chosen.*
2. **Cloud-first / SaaS from day one** — server-side execution, accounts, hosted runs from the start.
3. **Local-only forever** — never build cloud execution.

Local-first wins because it directly serves the audience and the differentiators: no account, no server, keys and data never leave the machine. It is also the lower-risk *first* build — there is no infrastructure to operate, secure, or pay for to get the product into a developer's hands. Cloud-first (Option 2) would contradict the privacy promise, gate first use behind sign-up, and force us to operate execution infrastructure before validating the product. Local-only (Option 3) forecloses the 24/7-automation and team-sharing value the vision depends on.

What makes "Phase 2 reachable" real rather than aspirational is that the engine is **pure TypeScript with no platform-specific imports** (see [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md)): the *same* `packages/core` that runs in the local Tauri app, CLI, and VS Code extension also runs unchanged inside a Phase-2 cloud worker. The local-vs-cloud difference is a hosting/interface switch around the engine — not a fork of it. The storage layer is built the same way: one Drizzle schema targets both local SQLite and cloud Postgres (see [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)). Pinned versions live in [tech-stack.md](../tech-stack.md).

A number of capabilities are deliberately **out of scope for Phase 1** because they belong to the cloud/team story: multi-user and team features, billing/subscription, a cloud execution queue, the web portal, scheduled/webhook triggers, and OAuth. The full list is in [product-constraints.md](../product-constraints.md).

## Consequences

### Positive

- Zero-friction first use: no account, no server, install-and-run — exactly what the developer audience expects, and a credible privacy story (data and keys never leave the machine).
- No infrastructure to operate, secure, or fund to ship Phase 1; the team validates the product before taking on the cost and risk of running execution servers.
- The engine is written once and runs in both modes, so Phase 2 is an additive hosting layer rather than a rewrite — enabled by the pure-TS engine ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md)) and the one-schema storage choice ([ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)).
- A clear scoping rule: anything that needs a server, an account, or always-on execution is Phase 2 and is marked as such throughout the docs (see [product-constraints.md](../product-constraints.md)).

### Negative

- Phase-1 automation is bounded by the user's machine being on and awake; 24/7 and remote triggers genuinely wait for Phase 2, and some users will want them sooner.
- Maintaining a clean local/cloud hosting boundary is ongoing discipline: any Phase-1 shortcut that assumes a server (a hidden network call, a server-only assumption in the engine) would quietly break the local-first guarantee and must be caught in review.
- Two execution and storage profiles (embedded local vs concurrent cloud) mean more total surface area across the product's life; accepted because neither alone serves both phases.
- Local run history does not automatically appear in the cloud — Phase-2 sync of historical local runs is an explicit, opt-in concern documented in [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md), not an implicit migration.
