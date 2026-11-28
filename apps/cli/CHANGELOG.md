# Changelog

All notable changes to the `relavium` CLI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release procedures and the
publication guard are documented in
[release-a-surface.md](../../docs/runbooks/release-a-surface.md).

## [Unreleased]

MVP-2 is implemented and independently reviewed, and MVP-11 (one surface language for
the CLI) is built on `development` through unit 9 with its close-out pending; the
published version is still `0.1.1`. Publication remains guarded until the accepted D59
release path replaces the interim guard. Checkpoint evidence is recorded in the
[MVP-2 acceptance register](../../docs/roadmap/phases/phase-2.6-conversational-authoring.md#step-4-acceptance-2026-11-10)
and, for MVP-11, in its [implementation log](../../docs/roadmap/phases/mvp-11/implementation-log.md).

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

### MVP-11 (one surface language)

The Home, the chat and the cards, pickers and reports inside them now share one palette
order, one key-hint grammar, one glyph set and one surface per kind of interaction. No
`--json` stream, NDJSON event or exit code changes; the few human-text changes on scripted
paths are listed under Changed.

#### Added

- Slash palette ordered by intent: Work, Set up, Check, End on the Home; Model and
  behaviour, Context, Inspect, Take away, End in a chat. `/exit` is last in the order and
  `/help` is now listed.
- A command that cannot act is shown dim with its reason (`/clear` with no conversation,
  `/resume` with nothing saved) instead of being hidden; a keyless Home lists `/providers`
  first.
- A command typed where the surface does not offer it answers one line naming the surface
  that has it (`/providers is available from the Home.`).
- Popups for what you ask for. Reports, settings, forms and pickers (`/doctor`, `/cost`,
  `/agent`, `/workflows`, `/help`, `/models`, `/effort`, `/mode`, `/permissions`,
  `/export`; on the Home also `/providers`, `/init`, `/import`, `/pricing`, `/resume`,
  `/run`, `/agents`) open as a centred box over a dimmed screen, or as a framed block in
  place of the body in the inline renderer. `Esc` steps back or closes, `[c]` copies a
  report, and every legend names its keys. Plain, `--json` and one-shot chats print the
  same text as before.
- `/doctor` popup with a provider-keys row (presence only), `[r]` run again and `[c]` copy.
  `[d]` runs the deep check only after a line that names the origins a key would be sent
  to, answered with `Ctrl+Y`. `/doctor --deep` now works on the Home.
- `/cost` popup with the per-model report; `[r]` releases held estimates behind a `Ctrl+Y`
  confirmation, and `/cost --release` opens on that confirmation.
- `/mode` is one list in a chat and on the Home, with the state words `this chat` and
  `startup` and the highlighted mode's whole effect shown before any key. In a chat `Enter`
  uses the mode (or keeps it) and `[s]` saves it as the startup default behind a `Ctrl+Y`
  confirmation; on the Home `Enter` sets the startup default behind the same confirmation.
- `/models` and `/effort` close with `Already ...` instead of asking when nothing would
  change.
- System-asked questions (approval, the agent's question, the continue checkpoint, the run
  gate, the budget gate, the exit guard) wear one frame: a heavy rule with the label and a
  wait clock (`waiting 0:41`, then `2m`, `1h 07m`; inline a static `waiting since 14:05`
  with nothing repainting on a timer). Keys held by a lockout read `(wait)`.
- Inspection popup for `[v]` and `/details`; `Esc` or `[b]` steps back and never rejects,
  `Ctrl+C` stops the turn.
- A calm Home landing: the `R E L A V I U M` wordmark, a rail, a prompt with an example
  that `Tab` fills in, one status line and one hint. `Enter` on an empty prompt now says
  how to start.
- A work page behind `↓` (`Esc` or `↑` goes back, the draft stays): Attention required,
  then Sessions, Runs and Agents of this directory, with a true `▼ N more`. The landing
  names the most urgent item.
- `r` on a run's detail in History runs that workflow again; the inputs are asked again and
  nothing starts without `Ctrl+Y`.
- Runs screen (Active and History) of this directory, with `[a] all` or `[a] here`. It opens
  from a run row, from `[h]` in `/workflows`, and from a last run in the workflow detail.
- `/workflows` popup: catalogue, then a detail with description, inputs, node chain, file
  and the last three runs; `[r]` run, `[x]` export, `[p]` pin, `[h]` Runs screen.
- `/agents` popup: list and detail; `[c]` starts a chat bound to that agent.
- A read-only card names why a stored run cannot be read.
- `@` file picking on the Home prompt.
- First run as a `Connect a provider` popup (Provider, Key, Done) in the Home's first
  frame. It says where the key is stored and where it is sent before you paste it, offers
  `Retry the check` first on a network failure, and never pre-selects `Save it anyway`.
- A message typed before a key exists is kept in the prompt and not sent. A draft that
  looks like an API key is never kept or recorded.
- `Esc` on the first-run popup skips; the skip is remembered
  (`[preferences].first_run_setup_skipped`) when no config file exists yet.
- One starter model per provider (Anthropic `claude-haiku-5-5`, OpenAI `gpt-5.4-mini`,
  Gemini `gemini-2.5-flash`, DeepSeek `deepseek-v4-flash`) for the first-run default and
  the key check.
- The chat has a header (wordmark and session title), one status line
  (`provider · model · mode · effort · turns · cost · ctx`) and a hint that names the way
  back to the Home.
- The chat draws on the Home's grid: a margin that belongs to the host and a content
  column (68 columns at 80). `›` in the margin marks your turn, a tool call is one row
  with `▸`, a wrapped line hangs under its text, and one blank row precedes each of your
  turns and each reply.
- The inline renderer says who spoke in the margin: `you`, `agent`, `tool`, `note`.
- With colour off every status glyph has a plain ASCII form (`ok`, `x`, `||`, `~`), the
  prompt cursor stays visible, and the selected row stays bold and inverse.
- Mode changes and `/cost` releases are kept as content-free session records (not drawn,
  not sent to the model).
- `/help` lists the keys that work in the surface you are in, and the Home's `/help` is one
  page of Keys and Commands.

#### Changed

- The zero-config chat model is the provider's starter model (`claude-haiku-5-5` for
  Anthropic); it was `claude-sonnet-4-6`.
- The model catalog snapshot was regenerated: 27 models added, 23 retired ones removed, 9
  prices moved. A configured model that left the catalog is not an error; it runs with an
  unknown price.
- Status and gate text: `⏸` is `‖`, and the Home's running row uses `◐` where it used `▶`.
  Amounts read `Budget allowance: $0.0420` (was `Frozen allowance: N microcents`), and
  prices read `$3 per M`.
- `/init` and `/run` confirm with `Ctrl+Y` (`Ctrl+N` or `Esc` writes or starts nothing).
  They were a Yes/No select that defaulted to No.
- A chat's `/export` is a confirmation popup; nothing is written to the transcript.
- `show_banner` is `true` or absent: the landing's block; `false`: a one-line wordmark. It
  used to appear only while the Home was empty.
- The Home lists this directory's sessions and runs only; `/resume`, `/workflows` and the
  Runs screen (`[a] all`) reach the rest.
- A chord card (`Ctrl+Y`) ignores a key held down for the first two seconds after it
  appears.
- The screen draws a few kinds of ordinary text differently so it can never be wider than
  the layout counted: skin tones are not drawn, nine text-default emoji gain a variation
  selector, Thai and Lao are drawn decomposed, and `›`, `▸`, `⇄` in a reply show as a
  space. `/copy`, `/edit`, `/scrollback` and the session file keep every byte.
- The text column is narrower: 68 columns at 80.
- Human text on scripted paths: `models pricing` echoes `$3 per M`; `status` prints `‖`;
  `--help` says `NO_COLOR (non-empty ⇒ off)`; the plain run renderer prints
  `retry ... in 1.5s`; `/help` and the unknown-slash hint in plain, `--json` and one-shot
  chats follow the new palette order.
- `history.db` gains an additive migration (record columns on `session_messages`); an older
  `relavium` reads a record as an inert system row. A config that contains
  `first_run_setup_skipped` is rejected by `relavium@0.1.1`.

#### Fixed

- `/` then `Enter` no longer ends the session; typing `/rel` or `/res` no longer
  highlights `/exit` or `/clear`.
- With no key, `Enter` no longer drops your message or cuts the failure at 80 columns.
- A pasted slash-led key is no longer echoed as `Unknown command`.
- `/doctor` on a keyless Home no longer reports all checks passed without checking keys.
- `Ctrl+Z` then `fg` no longer ends an idle Home or chat.
- The Home's first full-screen frame is no longer drawn at the shell's cursor row.
- A selected row is no longer told apart by its marker alone when colour is off.

#### Removed

- The Defined, Permissions, agents and Sessions tabs of the Home's tab host, the docked
  `/agent` and `/permissions` sheets, the Home's help screen, and the `Ctrl+R` refresh key
  of the model picker (a refresh row replaces it).
- The `Welcome to Relavium` block, the plaque banner, the busy row
  `Waiting for your answer ...`, and the clack first-run wizard.
- `⏸` and the Home's `▶`.

#### Security

- A held `Ctrl+Y` can no longer answer the next card: every chord card locks from the
  moment it appears.
- A draft that looks like an API key is cleared and never sent, kept or written to history.
- The MCP consent card refuses (does not show) a program path holding hidden characters,
  on the shell as well.
- The approval card writes width-risk characters as `<U+XXXX>`, and the question card
  escapes labels that would draw alike.
- `--cwd` is made absolute and "this directory" uses the canonical path. `relavium run`
  refuses a workspace at or inside `<repo>/.relavium` and a credential-store alias, as chat
  does.

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
