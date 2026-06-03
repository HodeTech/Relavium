# Local Dev Setup

> Last updated: 2026-06-03

This runbook gets the Relavium monorepo building on your machine. Relavium is a
**Turborepo + pnpm** TypeScript monorepo with a thin Rust layer for the Tauri desktop
app. The golden rule is **engine-first**: the shared packages build and test before any
surface, because every surface is a shell over the engine in `packages/core` (see
[architectural-principles.md](../standards/architectural-principles.md) §1).

For the full package layout this runbook references, see
[project-structure.md](../project-structure.md). For pinned tool versions, see
[tech-stack.md](../tech-stack.md) — this runbook does not restate version numbers.

## Prerequisites

| Tool | Why | Notes |
|------|-----|-------|
| Node.js (LTS) | Runs the TypeScript engine and all surfaces | Use the version pinned in [tech-stack.md](../tech-stack.md). |
| pnpm | Monorepo package manager | `corepack enable` is the simplest install path. |
| Rust toolchain (`rustup`, `cargo`) | Builds the Tauri v2 desktop backend | Only needed to build `apps/desktop`. The engine, CLI, and tests do not need Rust. |
| Tauri OS prerequisites | Native WebView + build deps | macOS: Xcode Command Line Tools. Windows: WebView2 + MSVC build tools. Linux: WebKitGTK + libsecret dev packages. See the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/). |
| Git | Workflows and agents are git-native YAML | — |

> You can do meaningful work on the engine and CLI **without** the Rust/Tauri
> toolchain. Install Rust only when you start on `apps/desktop`.

## 1. Clone and install

```bash
git clone <relavium-repo-url> relavium
pnpm install        # run from the repo root; installs the whole workspace
```

pnpm resolves the workspace from the root `pnpm-workspace.yaml`, and Turborepo wires the
task graph across `apps/*` and `packages/*`.

## 2. Build the engine first

Build the three foundation packages in dependency order before touching any surface:

```bash
pnpm --filter @relavium/shared build   # Zod schemas + TypeScript types
pnpm --filter @relavium/llm   build    # provider adapters over the official provider SDKs
pnpm --filter @relavium/core  build    # WorkflowEngine, DAG runner, checkpoints, event bus
```

Turborepo also lets you build everything in dependency order with a single command:

```bash
pnpm build          # turbo builds packages before the apps that depend on them
```

Run the engine's unit tests before relying on it — the engine targets full coverage:

```bash
pnpm --filter @relavium/core test
```

## 3. Run a surface

Once the engine is green, bring up a surface. Build order is CLI → desktop → extension
(see [architectural-principles.md](../standards/architectural-principles.md) §1).

**CLI (fastest feedback loop):**

```bash
pnpm --filter relavium dev
# then, against a committed workflow file:
relavium run ./workflows/<name>.relavium.yaml --input topic=<value>
```

**Desktop app (Tauri v2, needs the Rust toolchain):**

```bash
pnpm --filter @relavium/desktop tauri dev
```

This starts the Vite + React 19 frontend and the Rust backend together with hot reload.

**VS Code extension:**

```bash
pnpm --filter @relavium/vscode-extension build
# then press F5 in VS Code on apps/vscode-extension to launch an Extension Host
```

## 4. Add a provider key for local runs

Local runs need at least one LLM provider key in the OS keychain. Follow
[add-a-provider-key.md](add-a-provider-key.md) — keys are never stored in plaintext or
in the repo.

## Build-order summary

| Step | Build | Depends on |
|------|-------|------------|
| 1 | `packages/shared` | — |
| 2 | `packages/llm` | `shared` |
| 3 | `packages/core` | `shared`, `llm` |
| 4 | `apps/cli` | `core` |
| 5 | `apps/desktop` + `packages/ui` | `core` |
| 6 | `apps/vscode-extension` | `core`, `ui` |
| 7 | `apps/api` + `apps/portal` | `core`, `ui` — **Phase 2 (cloud) only** |

## Troubleshooting

- **Tauri build fails on missing native deps.** Re-check the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS;
  on Linux the libsecret dev package is required for keychain access.
- **A surface fails to find an engine type.** Rebuild the foundation packages — a
  surface must never be built against a stale engine.
- **Keychain prompts on first run.** Expected; the OS gates keychain access. See
  [keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md).
