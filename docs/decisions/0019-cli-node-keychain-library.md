# ADR-0019: Node-side OS-keychain access for the CLI — a maintained library, not the archived `keytar`

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md) (keychain decision this implements for the CLI), [0018-desktop-execution-and-rust-egress.md](0018-desktop-execution-and-rust-egress.md) (per-host key handling), [../tech-stack.md](../tech-stack.md), [../reference/cli/commands.md](../reference/cli/commands.md), [../reference/desktop/keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md)

## Context

[ADR-0006](0006-os-keychain-for-api-keys.md) stores provider API keys in the OS keychain, accessed on the **desktop** from the Tauri Rust backend (`tauri-plugin-keychain`). The **CLI**, however, is a plain Node.js process with no Rust backend; per [ADR-0018](0018-desktop-execution-and-rust-egress.md) the Node-style surfaces resolve the key at call time inside their one trusted process. The CLI therefore needs a **Node-side accessor** to the same OS keychains (macOS Keychain, Windows Credential Manager, Linux libsecret / Secret Service). The **VS Code** extension does not need one — it uses the host's `vscode.SecretStorage` API.

Several Phase-1 docs pinned **`keytar`** for this. `keytar` is **archived and unmaintained** — the upstream project (formerly Atom) was archived, with no further releases, security fixes, or prebuilt binaries for current Node ABIs. Provider keys are the most sensitive data the product handles, so an archived native credential module is exactly the supply-chain surface the project's rules exist to prevent: CLAUDE.md **rule 2** forbids a new runtime dependency without an ADR, and **rule 3** forbids hand-rolling security-critical primitives and requires *vetted* ones. The dependency was also never recorded in [tech-stack.md](../tech-stack.md), despite [ADR-0006](0006-os-keychain-for-api-keys.md) stating pinned versions live there.

## Decision

**The CLI accesses the OS keychain through `@napi-rs/keyring`** — a maintained N-API library that wraps the same platform backends (macOS Keychain, Windows Credential Manager, Linux libsecret / Secret Service) — **wrapped behind a small Relavium `KeychainStore` interface**, never the archived `keytar`. Desktop key access is unchanged (`tauri-plugin-keychain`, [ADR-0006](0006-os-keychain-for-api-keys.md)); VS Code uses `vscode.SecretStorage`. All three surface accessors implement the same internal `KeychainStore` interface and the same `service`/`account` naming (see [keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md) and [config-spec.md](../reference/contracts/config-spec.md)), so `@relavium/core`/`@relavium/llm` stay storage-agnostic.

The load-bearing decision is **"do not ship the archived `keytar`; use a maintained OS-keychain library behind a Relavium interface."** `@napi-rs/keyring` is the concrete pick; because it sits behind the interface it can be swapped via a follow-up ADR without touching callers.

Considered options:

1. **`keytar`** — the originally-pinned module. *Rejected:* archived/unmaintained, no prebuilt binaries for current Node, a stale native attack surface for the product's most sensitive data — violates rules 2 and 3 in spirit.
2. **`@napi-rs/keyring`** — actively maintained, N-API (ABI-stable) with prebuilt binaries, same three OS backends. *Chosen.*
3. **Hand-rolled FFI to each platform credential API** — *rejected:* reinvents a security primitive (rule 3) for no benefit over a vetted wrapper.
4. **Encrypted-file fallback only** — the passphrase-protected file from [ADR-0006](0006-os-keychain-for-api-keys.md) already exists for headless/CI; it is the escape hatch where no keychain exists, **not** a replacement for the OS keychain on an interactive CLI.

Pinned version lives in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- The CLI's key storage uses a **maintained, vetted** credential library — no archived native module in the dependency graph guarding the most sensitive data; rules 2 and 3 are satisfied and the dependency now has a recorded decision behind it.
- Same OS keychains as the desktop, under the same `service`/`account` scheme, so a key stored by one local surface is reachable by another on the same machine.
- The `KeychainStore` seam keeps the engine and adapters storage-agnostic and lets the concrete library be swapped without touching callers.

### Negative

- A native (N-API) dependency in the CLI: prebuilt-binary coverage per platform/arch must be verified in CI, and the headless/CI **encrypted-file fallback** ([ADR-0006](0006-os-keychain-for-api-keys.md)) remains the escape hatch where no keychain is available.
- Three keychain accessors now sit behind the one interface (Rust `tauri-plugin-keychain` on desktop, `@napi-rs/keyring` in the CLI, `vscode.SecretStorage` in VS Code); acceptable because each is the platform-correct store and all honor the same naming.
