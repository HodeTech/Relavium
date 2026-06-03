# ADR-0006: OS keychain for API keys

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0001-tauri-v2-over-electron.md](0001-tauri-v2-over-electron.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0005-sqlite-drizzle-local-postgres-cloud.md](0005-sqlite-drizzle-local-postgres-cloud.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0013-managed-key-vault-and-pools.md](0013-managed-key-vault-and-pools.md) (complements: Relavium's own keys in managed mode), [tech-stack.md](../tech-stack.md)

## Context

In Phase 1, Relavium calls LLM providers directly from the user's machine using the user's own API keys (see [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md) and [ADR-0011](0011-internal-llm-abstraction.md)). Privacy is a stated feature. Those provider keys are the most sensitive secrets the product handles — a leaked key is a direct financial liability for the user.

Two non-negotiable rules apply: keys are **never stored in plaintext**, and keys are **never sent to the frontend**. The frontend (the ReactFlow canvas and config UI in the WebView) only ever sees that a key *exists* for a provider, never its value. The full secret-handling design is documented in [reference/desktop/keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md); this ADR records the decision and its drivers.

## Decision

**API keys are stored in the OS keychain** — macOS Keychain (Security.framework), Windows Credential Manager, or libsecret / GNOME Keyring on Linux — accessed from the Tauri Rust backend. A passphrase-protected encrypted file is the explicit, opt-in fallback for headless/CI environments only.

Considered options:

1. **OS keychain, per-platform, accessed from the Rust backend** — hardware-backed where available, integrated with the OS lock screen. *Chosen as default.*
2. **App-managed AES-256-GCM encrypted file** with a key derived from a machine secret + a user passphrase — works everywhere, including headless.
3. **Plaintext or app-config storage** — rejected outright; violates the hard constraint.

The OS keychain is the default because it is the platform-standard secret store: on macOS it is hardware-backed (Secure Enclave on M-series), it integrates with the OS lock screen, and on every platform it keeps secrets out of our own files and out of any backup of the app's data directory. The Tauri Rust backend is the only component that touches keychain entries; the frontend reaches it only through narrow IPC commands that return existence/metadata, never the secret (see the [IPC contract](../reference/contracts/ipc-contract.md)). Each key is stored as a separate entry keyed by provider and key id. When the engine needs a key, the backend reads it and hands it to the `@relavium/llm` adapter ([ADR-0011](0011-internal-llm-abstraction.md)); it does not cross the IPC boundary to the WebView.

The encrypted-file fallback exists only for environments without a keychain (headless CI, some Linux setups): an AES-256-GCM file whose key is derived from a stable machine-specific secret combined with a user-set master passphrase. The passphrase is never persisted — it is prompted and held in process memory only. This fallback is opt-in via config, never the default. Note this is a *different* concern from encrypting run history at rest, which SQLCipher handles per [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md). Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- Keys are stored in the platform-standard, hardware-backed-where-available secret store and never written to our own files in plaintext — privacy is a real feature, not a slogan.
- The frontend never receives a key value; it only learns a key exists, sharply limiting the blast radius of any WebView/XSS issue (see [reference/desktop/keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md)).
- Keychain access is gated by the OS lock screen and (on macOS) the Secure Enclave, adding a hardware trust boundary for free.
- A documented, opt-in encrypted-file fallback keeps headless/CI usage possible without weakening the desktop default.

### Negative

- Keychain APIs and their UX differ per platform (prompts, access-control semantics), so the Rust backend must handle three implementations and their failure modes; the unification work is described in [reference/desktop/keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md).
- The encrypted-file fallback adds a second secret path that must be kept equally safe (machine-secret derivation, passphrase-in-memory-only) and tested.
- Because the master passphrase for the fallback is never stored, a forgotten passphrase means re-entering keys; this is an accepted security/usability trade-off for headless mode.
- Phase-2 cloud execution introduces a separate secret model (provider keys injected into cloud workers from a server-side secret store); that is explicitly out of scope here and lives in [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md).
