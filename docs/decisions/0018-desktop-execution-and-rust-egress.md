# ADR-0018: Desktop execution model — engine in the WebView, Rust-delegated LLM egress

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [0001-tauri-v2-over-electron.md](0001-tauri-v2-over-electron.md), [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0032-desktop-rust-media-de-inline-amends-0018.md](0032-desktop-rust-media-de-inline-amends-0018.md), [../reference/contracts/ipc-contract.md](../reference/contracts/ipc-contract.md), [../architecture/local-first-and-security.md](../architecture/local-first-and-security.md)

> **Amended 2026-06-08 by [ADR-0032](0032-desktop-rust-media-de-inline-amends-0018.md)** (a refinement,
> not a reversal): for **media-output** turns the Rust `llm_stream` egress command gains a bounded,
> audited media-detect-and-store step — it writes inline media bytes to a Rust-side CAS and forwards only
> a handle on the `Channel<StreamChunk>`, so multi-MB media never transits the WebView↔Rust channel
> (ADR-0031's invariant I3). Text/tool/reasoning chunks are still framed verbatim; the engine, the seam
> types, and the key-handling below are unchanged.

## Context

[ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)/[ADR-0011](0011-internal-llm-abstraction.md)
established that the engine (`@relavium/core`) and the LLM adapters (`@relavium/llm`)
are pure TypeScript with **zero platform-specific imports** and run identically on
every surface. On the **desktop** (Tauri v2, [ADR-0001](0001-tauri-v2-over-electron.md))
that runtime is the **WebView's JS runtime** — there is no Node backend (a Tauri
WebView has no backing Node context; that is an Electron concept).

That creates a tension the earlier ADRs left implicit and that several docs resolved
two incompatible ways: if the engine + adapters run in the WebView, and the adapter
makes the provider HTTP call, then the **raw API key would have to enter the WebView's
JS runtime** — which violates [ADR-0006](0006-os-keychain-for-api-keys.md)'s "keys
never reach the frontend." The WebView is also the least-trusted in-process component
(it renders untrusted model output). This ADR settles where the engine runs, how the
key reaches the provider, and what crosses the IPC boundary.

## Decision

**On the desktop, the engine + adapters run in the WebView, but the authenticated LLM
HTTP egress is delegated to a Rust command. The raw key never enters the WebView.**

Considered: (A) move the whole engine into Rust on desktop — rejected: it breaks the
"one pure-TS engine, zero platform imports, identical on every surface" invariant
([ADR-0011](0011-internal-llm-abstraction.md)) and would fork the engine. (B) let the
WebView adapter hold the key and call the provider directly — rejected: it puts raw
key material in the least-trusted JS runtime, violating [ADR-0006](0006-os-keychain-for-api-keys.md).
(C, chosen) keep the engine in the WebView and **delegate only the egress to Rust**.

The model, canonically specified in [../reference/contracts/ipc-contract.md](../reference/contracts/ipc-contract.md):

- The WebView adapter invokes the Tauri command **`llm_stream`** with the normalized
  request shape and a **key *reference*** (the keychain account id) — never the raw key.
- **Rust** reads the actual key from the OS keychain, sets the `Authorization` header,
  performs the streaming HTTPS request, and streams normalized **`StreamChunk`** frames
  back over a **`Channel<StreamChunk>`**. The raw key value is resolved and used only
  inside Rust; it never enters the WebView's JS runtime, and is never persisted or logged.
- The engine's **`RunEventBus` runs WebView-side**. Run events (`node:started`,
  `agent:token`, …) are produced and consumed in the WebView; they do **not** cross the
  IPC boundary as `RunEvent`s. The only Rust→WebView channel on the LLM hot path is the
  `Channel<StreamChunk>`; the WebView adapter folds those chunks into `agent:token`
  run events locally.
- On the **Node-style surfaces** (CLI, VS Code extension host, Phase-2 Bun API) there
  is no separate backend: the same adapter uses a direct `fetch`/SDK transport inside
  the one trusted process, resolving the key at call time and never persisting or
  logging it. The adapter's HTTP transport is **injected**, so `@relavium/core` and
  `@relavium/llm` stay platform-agnostic — the desktop wires the Rust-delegated
  transport, the Node surfaces wire a direct one.

This refines the *mechanism* of [ADR-0006](0006-os-keychain-for-api-keys.md) (keychain
storage is unchanged) and the host-handling of [ADR-0011](0011-internal-llm-abstraction.md)
(the seam's `key` parameter is a resolved key on Node hosts and a key *reference* on
desktop; the seam **types are unchanged**). It does not change the keychain decision or
the seam contract — only how egress and key handling are wired per host.

> Cloud mode (Phase 2) is a separate concern: it switches the **`ExecutionHost`** (the
> whole engine relocates to a cloud worker), not the `LLMProvider`. Only `local` and
> `managed` are selected behind the `LLMProvider` seam.

## Consequences

### Positive

- "Keys never reach the frontend" ([ADR-0006](0006-os-keychain-for-api-keys.md)) becomes
  literally true on the desktop — the raw key lives only in the OS keychain and Rust.
- The engine stays a single pure-TS package that runs identically everywhere
  ([ADR-0011](0011-internal-llm-abstraction.md)); only the injected HTTP transport differs.
- The untrusted WebView never handles secrets or makes privileged network calls; the
  privileged surface (keychain read + egress) is the small, auditable Rust command.
- Most run events never cross IPC, so the desktop run-event path has no per-event IPC cost.

### Negative

- The desktop adds a Rust `llm_stream` command (and a `Channel<StreamChunk>`) that the
  Node surfaces do not need — a per-host transport wiring to maintain.
- Streaming-usage capture and cancellation must be threaded through the Rust egress on
  desktop (the `AbortSignal` maps to aborting the Rust request), a small extra seam.
- Docs that predated this decision described an engine-in-Rust or adapter-attaches-the-key
  model and had to be reconciled to this one.
