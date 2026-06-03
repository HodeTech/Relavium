# ADR-0001: Tauri v2 over Electron for the desktop app

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0002-vite-react-tanstack-not-nextjs.md](0002-vite-react-tanstack-not-nextjs.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0007-desktop-is-not-an-ide.md](0007-desktop-is-not-an-ide.md), [tech-stack.md](../tech-stack.md)

## Context

The Relavium desktop app is the primary surface: a visual agent-management center that hosts a ReactFlow workflow canvas, agent configuration, run monitoring, and cost tracking (see [ADR-0007](0007-desktop-is-not-an-ide.md)). In Phase 1 it runs the workflow engine locally and talks to LLM providers directly from the user's machine (see [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)).

That role imposes five non-negotiable native requirements on whatever shell we pick:

1. Filesystem access — read/write git-committed `.relavium.yaml` / `.agent.yaml` files (see [ADR-0009](0009-git-native-workflow-yaml.md)).
2. Child-process spawning — launch MCP server processes.
3. A loopback HTTP server — so the VS Code extension can discover and connect to a running desktop app.
4. Local SQLite — for run history and cost tracking (see [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)).
5. OS keychain access and a system tray — for secret storage (see [ADR-0006](0006-os-keychain-for-api-keys.md)) and background run monitoring.

The product targets developers, for whom **bundle size and memory footprint are an explicit concern**. Getting the shell wrong is expensive: it determines install size, RAM overhead, the language of all system-level glue code, and the code-signing / distribution pipeline.

## Decision

**We use Tauri v2** (Rust backend + OS-native WebView) for the desktop app.

Considered options:

1. **Tauri v2** — Rust backend, frontend runs in the OS-native WebView (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). *Chosen.*
2. **Electron** — bundles Chromium + Node.js; the largest, most predictable ecosystem.
3. **Wails v2** — Go backend with an OS-native WebView, similar in spirit to Tauri.

Tauri v2 wins decisively. All five native requirements are first-class via its plugin ecosystem (`tauri-plugin-fs`, `tauri-plugin-shell`, `tauri-plugin-sql`, `tauri-plugin-notification`, `tauri-plugin-global-shortcut`, `tauri-plugin-tray`, plus keychain access — see [reference/desktop/tauri-plugins.md](../reference/desktop/tauri-plugins.md)). The ReactFlow canvas is pure React/TypeScript running in the WebView, which is environmentally identical to a browser — no framework-specific integration is needed, which dovetails with the SPA decision in [ADR-0002](0002-vite-react-tanstack-not-nextjs.md).

The killer advantage over Electron is footprint: a Tauri app ships at **2–5 MB versus Electron's 85–120 MB**, because it uses the OS-native WebView instead of bundling a full Chromium, with a corresponding RAM saving (Electron carries ~200 MB of overhead). For a developer-facing tool where size is a stated value, this is decisive.

Wails v2 (Go) is eliminated because its plugin registry has no equivalent of Tauri's, it lacks a native keychain plugin, its SQLite bindings (`mattn/go-sqlite3`) require CGo (complicating cross-compilation), its Windows child-process management is weaker, and Go offers no advantage over Rust for this workload. Electron is retained only as a documented fallback if cross-platform WebView rendering consistency ever becomes a blocking issue.

Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- A 2–5 MB install and far lower RAM use than Electron — directly serving the developer audience and the local-first promise.
- Every required native capability (fs, shell, SQL, keychain, tray, notifications, global shortcuts) exists as a maintained Tauri v2 plugin; see [reference/desktop/tauri-plugins.md](../reference/desktop/tauri-plugins.md).
- 90% of business logic stays in TypeScript in the WebView; Rust is confined to thin system-level glue, and the canvas runs in a plain browser-like environment.
- Tauri v2's capability/permission manifest (`src-tauri/capabilities/`) makes the app's native attack surface explicit and auditable.
- The shell is decoupled from the VS Code integration: it talks to the extension over a loopback HTTP protocol (see the [IPC contract](../reference/contracts/ipc-contract.md)), so a future shell swap would not break that surface.

### Negative

- The OS-native WebView means CSS/JS rendering can differ slightly across platforms (WKWebView vs WebView2); edge-case canvas CSS must be verified on each target. Electron's single bundled Chromium would avoid this.
- A Rust learning curve for the backend glue and any custom Tauri commands, versus an all-JavaScript Electron stack.
- Windows requires the WebView2 Runtime; the installer must bootstrap it, and the launch flow must be tested on a clean Windows 10 VM (it is preinstalled on Windows 11).
- Tauri IPC is JSON message-passing (`invoke`/`emit`), not direct function calls, so raw streams cannot cross the boundary directly — solved with Tauri v2 channels for streaming run events (see the [IPC contract](../reference/contracts/ipc-contract.md)).
- macOS distribution requires code-signing and notarization (Apple Developer Program enrollment, `APPLE_CERTIFICATE` in CI) or Gatekeeper quarantines the app; budget release time accordingly (see [runbooks/release-a-surface.md](../runbooks/release-a-surface.md)).
