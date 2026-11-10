# Changelog

All notable changes to the `relavium` CLI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release procedures and the
publication guard are documented in
[release-a-surface.md](../../docs/runbooks/release-a-surface.md).

## [Unreleased]

MVP-2 is implemented and independently reviewed on `development`; the published
version is still `0.1.1`. Publication remains guarded until the accepted D59
release path replaces the interim guard. Checkpoint evidence is recorded in the
[MVP-2 acceptance register](../../docs/roadmap/phases/phase-2.6-conversational-authoring.md#step-4-acceptance-2026-11-10).

### Added

- In-house assistant markdown rendering, Unicode/tab-aware word wrapping and
  source-preserving copy/edit/scrollback hatches in both interactive renderers.
- Native in-Home and standalone provider setup with masked input, typed key
  availability, eligible standard-environment source consent, `/providers` and a
  persistent keyless action.
- Shared `/init` and shell `init`, with directory preview/confirmation in Home,
  safe no-overwrite behavior and global/project artifact separation.
- Safe restored conversation display, additive optional user display metadata,
  indexed paged session discovery, Home `/resume`, actionable Continue,
  `chat resume/list/export`, `chat --continue` and durable-session exit hints.

### Fixed

- Failed-tool feedback and copy-request feedback report their actual result.
- Extra arguments on non-variadic commands refuse without reflecting values;
  a one-shot agent on TTY stdin explains how to provide its prompt.
- Global `~/.relavium` no longer acts as a project folder or authoring target.
- Native picker input survives output backpressure, pasted drafts leave Continue
  focus, diagnostics remain readable, and cancelled restoration stops new work
  while retaining actual cleanup and the existing conversation.

## [0.1.1] — 2026-06-28

Everything merged since the `v0.1.0` spine — the three additive lanes and the authoring
lifecycle — with the in-phase CLI now feature-complete (Phase 2 workstreams 2.A–2.S).

### Added

- **Authoring lifecycle (`create` / `import` / `export`)** (2.J, PR #58). `relavium create`
  is a `@clack/prompts` wizard that scaffolds either an **agent** (`.agent.yaml`) or a
  **minimal single-agent workflow** (`input → agent → output`, `.relavium.yaml`), validated
  against the kind-appropriate `@relavium/shared` schema before write. `relavium import <path>`
  copies an external workflow/agent into the project after schema validation; `relavium
  export <id>` writes a portable, share-safe copy **re-serialized from the validated AST**
  (canonical, comment-free; no provider key by construction). Ids are unique **project-globally**
  across both catalogs (a same-kind clash needs `--force`; a cross-kind clash is always
  rejected), so a bare `<id>` stays unambiguous for `export` / `run`.
- **Agent-first chat family** (2.M–2.Q, PR #54/#55). `relavium chat` — an interactive
  multi-turn REPL over `AgentSession` with streaming tokens, tool-call annotations, and the
  FS-scope tier + command allowlist honored (`/exit` returns exit code `4`); `relavium
  chat-resume <sessionId>`, `relavium chat-list`, and `relavium chat-export` (+ the in-REPL
  `/export`) to ship a session to a `.relavium.yaml` scaffold; a headless `relavium chat --json`
  `SessionEvent` stream; and a one-shot `relavium agent run <agent>` with a `--fixture` cassette
  for deterministic offline replay.
- **Inbound MCP client** (2.R, PR #56/#57). Agents consume external MCP servers' tools across
  `chat`, `run`, and `agent run` via the SDK-fenced `@relavium/mcp` package — `stdio` plus the
  `http` / `sse` / `websocket` network transports behind an SSRF pre-connect floor + a per-server
  `allow_local_endpoint` opt-in, with server credentials resolved from an isolated `mcp-secret:*`
  keychain namespace and injected only into the spawn-time `env`. Discovered tools surface under
  the `mcp_{server}_{tool}` namespace; a real-spawn end-to-end test proves the round-trip.
- **Media host-wiring** (2.S, PR #52). A generative media-output fixture runs end-to-end on the
  CLI — host `resolveMediaSurface` routing, content-addressed `MediaStore` de-inline to a
  `media://` handle, the SSRF-validated `EgressCapability.fetch` egress, a containment-checked
  `save_to` write port, and the produced-media render surface in both the TUI and `--json` paths.

### Changed

- `relavium export` / `import` re-serialize from the validated AST: the canonical form drops
  authored comments and emits cwd-relative paths in both human and `--json` output (no absolute
  filesystem path in any message or record).
- The `create` wizard requires an interactive terminal on **both** ends (TTY stdout + TTY stdin);
  it fails loud (exit `2`) under `--json` or a piped stream rather than hanging.

## [0.1.0] — 2026-06-24

The first published CLI — the engine-proving spine and the run/read surface.

### Added

- The `commander.js` CLI skeleton + process contract (output-mode detection, the deterministic
  exit-code map, global flags) (2.A) and two-level config resolution (`~/.relavium/` → project
  `.relavium/`) (2.B).
- `relavium run` wired to `@relavium/core` — workflow resolution, typed `--input` coercion, the
  live event stream, SIGINT→cancel, and the terminal-event→exit-code mapping (2.D).
- The `--json` CI machine-output contract: one `RunEvent` per line (NDJSON), pure stdout,
  diagnostics on stderr, deterministic exit codes (2.F).
- The `ink` streaming TUI — live per-node status, the active node's token stream, and a running
  cost/duration footer over the same event bus as `--json` (2.E).
- The interactive human-gate prompt + the out-of-band `relavium gate <runId>` cross-process
  resume (2.G).
- Durable local run history via `@relavium/db`, powering the read commands `list` / `logs` /
  `status` / `gate list` (2.H, 2.I).
- `relavium provider` commands storing API keys in the OS keychain via `@napi-rs/keyring`, with a
  `RELAVIUM_<PROVIDER>_API_KEY` env-var fallback for headless/CI hosts (2.C).
- The engine regression harness adopted as the CI gate (2.K), and packaging + cross-OS install
  verification — the `tsup` engine-inlined ESM bundle published as `npm i -g relavium` (2.L).

[0.1.1]: https://github.com/HodeTech/Relavium/releases/tag/v0.1.1
[0.1.0]: https://github.com/HodeTech/Relavium/releases/tag/v0.1.0
