# ADR-0050: CLI run-history `history.db` is unencrypted at rest, guarded by OS file permissions

- **Status**: Accepted
- **Date**: 2026-06-23
- **Related**: [0005-sqlite-drizzle-local-postgres-cloud.md](0005-sqlite-drizzle-local-postgres-cloud.md) (refines its at-rest framing for the Node/CLI surface), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md) (same), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0021-node-sqlite-driver-better-sqlite3.md](0021-node-sqlite-driver-better-sqlite3.md), [0036-run-loop-substrate-event-bus-and-execution-host.md](0036-run-loop-substrate-event-bus-and-execution-host.md), [../reference/shared-core/database-schema.md](../reference/shared-core/database-schema.md), [../reference/desktop/keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md), [../reference/contracts/config-spec.md](../reference/contracts/config-spec.md), [../roadmap/phases/phase-2-cli.md](../roadmap/phases/phase-2-cli.md) (workstream 2.H)

## Context

Phase-2 workstream **2.H** wires durable CLI run history to `~/.relavium/history.db`
through `@relavium/db`, which on the Node/CLI side uses the `better-sqlite3` driver
([ADR-0021](0021-node-sqlite-driver-better-sqlite3.md)). This forces a decision the corpus
has not yet made for the CLI surface: **is that file encrypted at rest, and if so how?**

The existing record points two ways and must be reconciled:

- [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md) set the local store as "SQLite +
  Drizzle, **encrypted with SQLCipher**" — but its mechanism is the **desktop's**
  `tauri-plugin-sql` Rust path, with the passphrase derived in the Tauri setup hook.
  [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md) restated this as "run history and
  cost data live in a local **encrypted** SQLite file."
- [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md) then chose `better-sqlite3` for the
  Node-side consumers (tests now, the CLI later) and was explicit that it decided "**only
  the underlying driver**," that it "does **not** touch the desktop's encrypted
  `tauri-plugin-sql` path," and that the Phase-2 CLI run-history reader is a Node consumer.
  `better-sqlite3` is the standard (non-SQLCipher) build: it provides **no** transparent
  at-rest encryption. So the CLI cannot inherit the desktop's SQLCipher mechanism, and the
  Node-side at-rest posture was left **open**.

A decisive scoping fact bounds the stakes: **`history.db` holds no credentials.** API keys
live only in the OS keychain ([ADR-0006](0006-os-keychain-for-api-keys.md)) and are resolved
at LLM-call time, never persisted; and the engine **masks secret-typed inputs and tool I/O
at the `RunEventBus` before persistence** ([ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md)),
so `run_events` / `step_executions` / `runs` carry `{ secret: true, ref }` placeholders, never
raw key material. The at-rest question is therefore about protecting run **content** —
prompts, model outputs, token/cost data — i.e. **defense in depth**, not the credential
boundary (which the keychain and bus-masking already own).

Getting this wrong cuts both ways: silently shipping an unencrypted file would contradict the
"encrypted" framing of 0005/0008 with no record (the drift the decisions corpus exists to
prevent); over-engineering — pulling application-layer crypto and its key management forward —
would bloat 2.H, add an encrypt cost to every event write on the persistence hot path, and
couple this feeder to the not-yet-built keychain workstream (2.C), all for a local,
single-user CLI.

## Decision

**The CLI's `~/.relavium/history.db` is unencrypted at rest and guarded by restrictive OS
file permissions: `~/.relavium/` is set to `0700` and `history.db` (with its `-wal` / `-shm`
sidecars) to `0600` — owner-only — applied with an explicit `chmod` (umask-independent, and
applied even to a pre-existing directory, since `mkdir(mode)` is umask-masked and does not
re-permission an existing dir). We do not add application-layer encryption to the Phase-2 CLI.**
On **Windows**, POSIX mode bits do not apply (`chmod` is effectively a no-op); protection there
falls to the per-user `%USERPROFILE%` NTFS ACL — a known cross-platform divergence from `0600`,
not a uniform mechanism. This closes the open question [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md)
left for the Node surface; it does **not** change the desktop.

Considered options:

1. **Unencrypted + `0700`/`0600` OS permissions.** *Chosen.* The proportionate at-rest
   control for a local single-user CLI: the file carries no credentials (keychain + bus
   masking), so owner-only filesystem permissions adequately protect the remaining run
   **content**. It unblocks 2.H with no dependency on the 2.C keychain work and adds no
   crypto to the per-event write path.
2. **Application-layer AES-256-GCM, key in the OS keychain (`@napi-rs/keyring`).** *Rejected
   for now.* The strongest at-rest protection, but it (a) couples 2.H to the unbuilt
   provider/keychain workstream (2.C), (b) adds an encrypt/decrypt step to **every** event
   write — and the engine awaits `RunStore.persistEvent` *before* delivering the event, so it
   is squarely on the run's hot path, and (c) makes `history.db` opaque to ad-hoc inspection
   and `relavium logs` debugging. A future ADR may adopt it if the threat model warrants;
   this records it as a **named** follow-on, not silent debt.
3. **Ship unencrypted with no ADR.** *Rejected.* Would leave the "encrypted" framing of
   0005/0008 contradicted with no record — exactly the silent drift the corpus forbids.

**Scope.** This decides only the **CLI / Node surface**. The **desktop** keeps its
SQLCipher-encrypted `tauri-plugin-sql` path ([ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md),
[ADR-0001](0001-tauri-v2-over-electron.md), [ADR-0018](0018-desktop-execution-and-rust-egress.md))
unchanged; the Phase-2 cloud history store (PostgreSQL) is out of scope.

**Cross-surface coexistence — a named Phase-3 follow-on.**
[database-schema.md](../reference/shared-core/database-schema.md) previously described a single
`~/.relavium/history.db` opened with SQLCipher by *every* host (desktop, CLI, VS Code), so a
session written on one surface opens on another. Making the CLI's copy **unencrypted** breaks
that: a standard `better-sqlite3` build cannot open a SQLCipher file (nor vice-versa), so the
desktop (SQLCipher) and the CLI (unencrypted) **cannot share one file at that path**. In Phase 2
this is **not** a live conflict — the desktop does not exist yet (Phase 3) and the CLI is the sole
writer of `history.db`. **Reconciling the cross-surface shared-path posture is therefore a named
Phase-3 obligation**: when the desktop lands, its ADR decides among (i) a uniformly-unencrypted
shared store (OS permissions across surfaces), (ii) per-surface separate files (dropping
single-file cross-surface resume), or (iii) a CLI/Node SQLCipher-capable build. Until then there is
**no** cross-surface shared session/run store, and [database-schema.md](../reference/shared-core/database-schema.md)
is updated to say so. (The per-project `runs.db` is unaffected — it is already unencrypted and
git-committed, holding only non-sensitive metadata.)

**Companion obligation (no new decision).** The 2.H history writer is **pass-through** for
secrets: it never re-masks (the engine already masked at the bus) and adds no runtime
secret-detection (infeasible on opaque JSON). The no-raw-secret invariant on the unsafe columns
— `run_events.payload_json`, the `step_executions` input/output/error JSON, `run_costs`, and
`runs.workflow_definition_snapshot` — is the engine's upstream masking guarantee
([ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md),
[ADR-0006](0006-os-keychain-for-api-keys.md)), regression-guarded by the package's secrets
fixture; it is recorded in [database-schema.md](../reference/shared-core/database-schema.md), and
is not a new decision.

## Consequences

### Positive

- **Unblocks 2.H now** with no dependency on the 2.C keychain work and no per-write crypto on
  the persistence hot path (`persistEvent` is awaited before delivery).
- `history.db` stays **inspectable** for debugging and `relavium logs` without a decrypt step.
- The **no-credentials-at-rest** guarantee is preserved independently of file encryption, by
  the OS keychain ([ADR-0006](0006-os-keychain-for-api-keys.md)) and bus-masking
  ([ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md)).
- The 0005/0008 framing is **reconciled on the record** (dated amendment notes pointing here),
  so there is no silent contradiction in the corpus.

### Negative

- Run **content** (prompts, model outputs, token/cost data) is unencrypted on disk: anyone
  with read access past the OS permissions — a stolen unlocked disk, an unencrypted backup,
  another local process running as the same user — can read it. Mitigations: owner-only
  `0600`/`0700` permissions; the file holds no credentials; OS full-disk encryption remains
  the user's first line; the posture is documented in
  [keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md). Option 2
  (app-layer AES via the keychain) is the named upgrade path if a future threat model needs it.
- A deliberate **divergence from the desktop** (SQLCipher) and a partial divergence from the
  original "encrypted local SQLite" intent of 0005/0008 — accepted knowingly, scoped to the
  CLI surface, and recorded rather than silent.
