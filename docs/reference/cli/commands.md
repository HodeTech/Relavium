# CLI Command Reference (`relavium`)

> Last updated: 2026-06-29

- **Status**: Reference (partial — surface defined, exact flags to be finalized as the CLI is built)
- **Surface**: CLI (`relavium`)
- **Scope**: Phase 1, local-first. Same `@relavium/core` engine as every other surface.
- **Related**: [home.md](home.md), [chat-session.md](chat-session.md), [../vscode/extension-api.md](../vscode/extension-api.md), [../desktop/routes-and-screens.md](../desktop/routes-and-screens.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../../tutorials/cli/run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md), [../../runbooks/add-a-provider-key.md](../../runbooks/add-a-provider-key.md)

The `relavium` CLI is the terminal surface of the platform and the fastest way to run a workflow non-interactively (scripts, CI/CD). It embeds the **same** `@relavium/core` engine as the desktop app and VS Code extension — there is no separate "CLI engine," so behavior is identical across surfaces (see [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)). The CLI is built **second** (right after the engine) and serves as the engine's canonical integration-test harness.

## Install & distribution

- **Package**: published to npm as `relavium`, installed globally. The artifact is an **engine-inlined ESM bundle** — the proprietary `@relavium/*` engine is bundled in; every third-party dependency (including the prebuilt native addons) installs normally ([ADR-0051](../../decisions/0051-cli-distribution-thin-bundle-private-engine.md)). A global install needs no compiler toolchain.
- **Build**: TypeScript bundled with `tsup` to a single ESM `bin`; released via the `Release CLI` workflow (pack → cross-OS install-smoke on macOS/Linux/Windows → npm publish with provenance), see [release-a-surface.md](../../runbooks/release-a-surface.md).
- **Stack**: `commander.js` for argument parsing, `ink` (React for terminals) for the interactive TUI, `@clack/prompts` for setup wizards.
- **API keys**: stored in the OS keychain via `@napi-rs/keyring` (macOS Keychain / Windows Credential Manager / Linux libsecret) — never plaintext, and never the archived `keytar` (see [ADR-0019](../../decisions/0019-cli-node-keychain-library.md) and [add-a-provider-key.md](../../runbooks/add-a-provider-key.md)).
- **Workflow discovery**: reads workflows from the `.relavium/` directory in the project root, or from an explicit path argument.

```bash
npm install -g relavium
relavium run ./workflows/code-review.relavium.yaml --input file=./src/index.ts
```

## Output modes

The CLI auto-detects its environment and switches presentation accordingly:

| Mode | When | Behavior |
|------|------|----------|
| **Interactive TUI** | TTY attached, no `--json` | `ink`-rendered live view: animated per-node status, streaming token output for the active node, final cost/duration summary |
| **Plain** | No TTY or `CI=true` (and no `--json`) | The TUI is disabled; a terse line-per-lifecycle-event human renderer writes to stdout |
| **NDJSON** | `--json` (anywhere on the command line) | The machine contract: stdout is a pure NDJSON stream — [RunEvent](../contracts/sse-event-schema.md)s for `run` / `gate`, or [SessionEvent](../contracts/sse-event-schema.md#session-event-namespace)s for `chat` / `agent run` — and all diagnostics go to stderr. See [The `--json` machine-output contract](#the---json-machine-output-contract) |

NDJSON is engaged **only** by `--json` (the explicit machine opt-in); a non-TTY or `CI=true`
environment disables the interactive TUI but does not by itself switch stdout to NDJSON
([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). Exit codes are CI-friendly
(see [Exit codes](#exit-codes)).

`--no-color` (and `--color`) do **not** change the mode — the interactive TUI stays active and only ANSI
color/dim are suppressed (plain output without a renderer swap). A swap to the Plain renderer happens only on
no-TTY / `CI=true`, and to NDJSON only on `--json`.

**Color precedence.** ANSI styling is orthogonal to the output mode above, resolved with this precedence:
an explicit `--color` / `--no-color` flag > the `NO_COLOR` env var (**any** non-empty value ⇒ off, the
[no-color.org](https://no-color.org) accessibility contract) > the `FORCE_COLOR` env var (`0`/`false` ⇒ off,
the `supports-color` convention) > **on** by default. `NO_COLOR` intentionally beats `FORCE_COLOR` — a user
who opts out of color wins over a tool/CI that opts in. (A `--json`/CI/no-TTY stream carries no ANSI regardless
— that is the separate output-mode selection above.)

### The `--json` machine-output contract

**Every record is serialized with `stringifyJsonLine`, not a bare `JSON.stringify`.** The wire contract is
unchanged — `JSON.parse` round-trips to the identical string, which is exactly why the escape was chosen over
a strip — but what reaches a terminal differs: `JSON.stringify` escapes `ESC` and leaves `DEL`, the C1 block
(including `U+009B`, a working escape-sequence introducer) and the Trojan-Source bidi family RAW in content
the model, a tool, or an imported artifact controls. Enforced by lint rather than review; the reasoning and
the one allowlisted exception live in
[security-review.md](../../standards/security-review.md#cli-terminal-render-safety--interactive-approval).

Under `relavium run --json`, the CLI emits a stable machine contract a CI job can pipe and assert
on ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). The contract covers a workflow
**run**; `--help`, `--version`, and a bare no-command invocation are exit-`0` meta-operations that
print their human text (usage / version) to stdout as usual, `--json` notwithstanding. (On a genuine
interactive TTY a bare `relavium` instead opens the **interactive Home** — see [home.md](home.md) for
the gate; the help + exit-`0` meta-op is preserved byte-for-byte on every non-interactive path: `--json`,
a pipe/redirect, or `CI`.)

- **stdout is a pure NDJSON stream of [RunEvent](../contracts/sse-event-schema.md)s** — one event
  serialized verbatim per line, in `sequenceNumber` order. The line *is* the stable envelope
  (`type` / `runId` / `timestamp` / `sequenceNumber` per the schema); there is no wrapper, stream
  header, or version line. Every event the run emits appears, unfiltered.
- **The terminal `run:completed` event is the final result line** — it already carries `outputs` +
  `totalTokensUsed` + `totalCostMicrocents` + `durationMs`, so there is no separate summary line. A
  `run:failed` terminal carries `error` + `partialOutputs`; a `run:cancelled` carries only the
  envelope (read run totals for those from the last `cost:updated.cumulativeCostMicrocents`).
- **All diagnostics go to stderr, never stdout.** A pre-run CLI fault (bad arguments, workflow not
  found, missing key) is written to stderr as a structured `{ "type": "error", "code", "message" }`
  envelope (distinct from the run stream's `run:failed`/`node:failed`) and exits `2`; stdout stays
  empty. A pipe consumer reads stdout for events and uses the exit code + stderr for faults.
- **Secret-typed values stay masked** — the engine masks them as `{ "secret": true, "ref": … }`
  before any renderer sees them; the NDJSON carries that masked shape, never a raw secret.

Exit codes are CI-friendly (see [Exit codes](#exit-codes)).

> **Agent-readable command surface — now realized by the command manifest.** Because Relavium's own
> thesis is that work starts in an agent, the CLI is a natural *tool surface for other agents*. The two
> affordances once proposed here — a **machine-readable help mode** (`--help` emitting the command/flag
> surface as JSON, so an agent can discover the CLI without scraping prose) and a per-command **`effect`
> annotation** (`read` / `write` / `destructive`) so an agent's tool policy can gate destructive commands
> behind approval — are delivered by the [command manifest](#command-manifest)
> ([ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md), 2.5.C). Approval
> **enforcement** of a `destructive` entry is owned by [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md) (2.5.E).

## Global options

These flags are **position-independent** — they may appear anywhere on the command line, so
`relavium run wf --json` and `relavium --json run wf` are equivalent (the CLI extracts them
before parsing the subcommand).

| Flag | Effect |
|------|--------|
| `--json` | Emit machine-readable NDJSON output (disables the TUI) — see [Output modes](#output-modes). |
| `--color` | Force colored (ANSI) output on. |
| `--no-color` | Disable colored (ANSI) output. |
| `--cwd <dir>` | Run as if started in `<dir>` (project discovery and relative paths resolve from here). |
| `--config <path>` | Use an explicit global config file instead of `~/.relavium/config.toml` — the project `.relavium/` layers still apply ([config-spec.md](../contracts/config-spec.md)). |
| `--no-alt-screen` | Keep the byte-identical inline renderer for the bare Home + `relavium chat` (no full-screen alternate screen) — the screen-reader fallback. Overrides `[preferences].alt_screen`; a non-TTY / `--json` / CI path is always inline regardless ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md)). |
| `--no-mouse` | Disable terminal mouse reporting (DECSET 1002+1006) inside the full-screen renderer. The wheel stops scrolling the transcript (PgUp/PgDn + Ctrl+Home/Ctrl+End still page), in-app selection and copy-on-select go with it, and the emulator's own click-drag selection works again without a modifier. Overrides `[preferences].mouse`, and forces `[preferences].copy_on_select` off. Ignored outside the alt screen ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e, [accessibility.md](accessibility.md)). |
| `-v, --verbose` | Print verbose diagnostics to stderr. |
| `-q, --quiet` | Suppress non-essential output. (`--verbose` and `--quiet` cannot be combined → exit `2`.) |
| `-V, --version` | Print the version and exit `0`. |
| `-h, --help` | Print help for the program or a subcommand and exit `0`. |

## Commands

The command set below is the confirmed surface. Commands ship **per workstream**: `run` (2.D), `gate` + `gate list` (2.G/2.I), `provider` (2.C), the read commands `list` / `logs` / `status` (2.I), the whole agent-first chat family — **`chat`** (2.M), **`chat-resume`** (2.N), **`chat-list`** (2.O), **`chat-export`** (2.P), and **`chat --json` + `agent run`** (2.Q) — and the YAML-lifecycle authoring commands **`create`** / **`import`** / **`export`** (2.J) are all **live**; `budget resume` is a [tracked follow-up](../../roadmap/deferred-tasks.md). Invoking a not-yet-shipped command exits with a clean "not available yet (lands in …)" message. Subcommands marked _(planned)_ are intended but not yet locked.

| Command | Purpose |
|---------|---------|
| `relavium run <workflow> [--input k=v] [--allow-mcp-stdio <digest>]` | Execute a workflow. Streams progress; resolves with the workflow output. |
| `relavium chat [--agent <ref>]` | Start an interactive [agent session](../contracts/agent-session-spec.md) (the agent-first REPL). See [chat-session.md](chat-session.md). |
| `relavium chat-resume <sessionId>` | Reload a persisted session from `history.db` and continue the conversation. |
| `relavium chat-list` | List past agent sessions (id, agent, last activity), the way `relavium list` lists workflows. |
| `relavium chat-export <sessionId>` | Export a session to a `.relavium.yaml` scaffold for review ([ADR-0026](../../decisions/0026-session-export-to-workflow.md)). |
| `relavium agent run <agent> [--fixture <path>] [--json] [--allow-mcp-stdio <digest>]` | Run a single agent **one-shot** (non-interactive) on the same AgentSession infra — the prompt is read from stdin, one turn, then exit. See [`relavium agent run`](#relavium-agent-run) and [agent-run-fixture.md](agent-run-fixture.md). |
| `relavium list` | List discovered workflows (and, with a flag, agents) in the current project. |
| `relavium create [--force]` | Scaffold a new agent or a minimal single-agent workflow YAML via an interactive wizard (schema-validated before write). |
| `relavium import <path> [--force]` | Import an external `.relavium.yaml` / `.agent.yaml` into the project, validated + slug-deduplicated. |
| `relavium export <id> [--out <path>] [--force]` | Export a workflow/agent to a portable, canonical YAML copy (re-serialized from the validated AST — no provider key by construction, comments dropped; MCP `env` secrets preserved faithfully, so author them as `{{secrets.*}}`). |
| `relavium logs <runId>` | Print the persisted event/log stream for a past run. |
| `relavium status` | Show active runs and their per-node status. |
| `relavium gate <runId>` | Resolve a pending human gate (approve / reject / provide input). |
| `relavium gate list [<runId>]` | List pending human gates (all active runs, or one run) — the multi-gate subcommand for resolving one of several concurrently-pending gates. |
| `relavium budget resume <runId> [--approve\|--abort]` | Resume a run suspended at a budget cap (`budget:paused`, `on_exceed: pause_for_approval`) — approve to continue or abort. The non-interactive operator path for [ADR-0028](../../decisions/0028-workflow-resource-governance.md). |
| `relavium init` _(planned)_ | Initialize a `.relavium/` directory in the current project. |
| `relavium agent <subcommand>` _(planned)_ | Manage agents (list / create / test). |
| `relavium models` | List the cached model catalog (refreshes on first run if the cache is empty). See [`relavium models`](#relavium-models). |
| `relavium models refresh` | Re-fetch **both axes**: each connected provider's live model list (availability) **and** the models.dev catalog (price, ceilings, reasoning tiers). Reports per-source outcomes. |
| `relavium models refresh --providers` | Availability only — the provider lists. ADR-0064's original behaviour. |
| `relavium models refresh --catalog` | Metadata only — the models.dev catalog. **Needs no provider key.** |
| `relavium models pricing <model>` | Hand-enter a user price for a model the registry does not know, so the cost cap enforces it. See [`relavium models`](#relavium-models). |
| `relavium provider <subcommand>` | Manage providers and API keys in the OS keychain (`list` / `add` / `set-key` / `remove-key` / `test`). |

## Command manifest

> **Canonical home** for the command manifest ([ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md), 2.5.C). The runtime form lives in `apps/cli/src/commands/manifest.ts` (a **CLI-only** contract — no other surface consumes a CLI command list).

The **command manifest** is the one source the **shell** command surfaces derive from — the `commander` parser, the `executeCommand` dispatch table (`apps/cli/src/commands/dispatch.ts`), and `relavium --help --json` — so they can **never diverge**. (The in-REPL `/` palette + slash commands are a separate, curated registry — see [In-REPL slash commands](#in-repl-slash-commands) below.) The set is deliberately **small and alias-free**; every entry is canonical by construction (there is no per-entry alias flag). Each entry is:

```text
{
  id          // stable id; a subcommand is dotted — `provider.set-key`, `agent.run`, `gate.list`
  label       // a short human label — "Run workflow", "Set provider key"
  description // the one-line help; MUST match commander's .description() (the --help --json text)
  args?       // [{ name, type: 'string'|'number'|'boolean', required?, description? }]; name is the camelCase CommandInput key
  effect      // 'read' | 'write' | 'destructive'  (see below)
  modeScope?  // chat modes a command is available in; omit ⇒ all modes
}
```

- **`effect`** is a forward-looking annotation: `read` never mutates, `write` creates/modifies, `destructive` irreversibly removes (today only `provider.remove-key`). It is **marked** for agent discoverability now; approval **enforcement** of a `destructive` entry is owned by [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md) (workstream 2.5.E), not here.
- **`modeScope`** lists the chat modes a command appears in (omit ⇒ all). The mode values (`ask` / `plan` / `accept-edits` / `auto`) are defined in [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md) (2.5.E); 2.5.C ships the field with `omit = all`.
- A `manifest ↔ commander` drift guard (a unit test) asserts every real `commander` command has an entry with the **same description** (command + each option), so `commander`, the `executeCommand` table, and `--help --json` stay byte-consistent.

| Example entry | `effect` |
|---------------|----------|
| `run` | write |
| `list` | read |
| `provider.set-key` | write |
| `provider.remove-key` | destructive |

### In-REPL slash commands

The interactive `/` palette + slash commands inside the **Home and chat** are a SEPARATE, **curated** surface ([ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md) amendment, 2.5.C) — the runtime registry is `apps/cli/src/commands/repl-commands.ts` (`REPL_COMMANDS`), the single source for the palette, the `/help` list, and the unknown-slash hint. It surfaces only the commands that make sense in a live REPL: lifecycle (`/exit`, `/cancel`, `/export`, `/clear`), info/discovery (`/help`, `/workflows`, `/cost`, `/doctor`), and — in a chat — `/mode`, `/effort`, `/thinking` (also `Ctrl+T`), the ADR-0062 context commands (`/compact`, `/trim`), `/models`, and the [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e copy-and-search hatches `/scrollback`, `/edit` + `/copy`. **Their in-chat behavior is spec'd in [chat-session.md](chat-session.md) and its ADRs** — the `/models` live-reseat vs bare-Home write-default and its reasoning-effort sub-step + picker UX ([ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md) reseat, [ADR-0064](../../decisions/0064-live-model-catalog.md)/[ADR-0063](../../decisions/0063-cli-config-write-contract.md) catalog+write), `/effort`'s per-turn override ([ADR-0066](../../decisions/0066-normalized-reasoning-effort-control.md)), and `/thinking`'s panel toggle (2.5.H) — this reference does not restate them. The heavy, session-starting shell commands (`run`, `chat`, `provider`, …) are **never** in-REPL slashes — they stay shell-only (`relavium <cmd> …`). A bare `/` at an **empty** prompt opens the filterable palette (the footer hint-bar surfaces `/ for commands` there, 2.5.C S6); an unknown slash — or an undeclared argument on a known command (`/exit now`) — prints a sanitized, secret-free hint. A command may declare flags (`/doctor --deep`) or a single positional value (`/mode plan`); the palette runs the bare form, so a flag/value is opt-in by typing it. There is no separate `/shortcuts` command — the palette's own nav hints (`↑/↓ · Enter · Esc`) + the footer keep keys discoverable in context.

### `relavium run`

Runs a workflow end-to-end. The argument is a path to a `.relavium.yaml` file (or a workflow id/slug resolvable inside `.relavium/`).

```bash
# interactive
relavium run ./workflows/code-review.relavium.yaml --input file=./src/index.ts

# CI: machine-readable event stream
relavium run ./workflows/code-review.relavium.yaml --input file=./src/index.ts --json
```

- `--input k=v` (repeatable, one distinct key per input) supplies typed workflow inputs (see the `inputs` block in [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)). Each value is coerced to the input's declared type; an unknown key, a repeated key, a missing required input, or a value that does not coerce is an invalid invocation (exit `2`).
- `--json` switches to NDJSON [RunEvent](../contracts/sse-event-schema.md) output.
- `Ctrl-C` (SIGINT) requests a cooperative cancel; the run drains to `run:cancelled` and exits non-zero (`1`).
- A missing API key for an inline agent's **primary** provider is caught **pre-flight** as an invalid invocation (exit `2`) naming the `RELAVIUM_<PROVIDER>_API_KEY` to set, before the run starts. The pre-flight is a strict subset of the keys a run may touch, so it never blocks a valid run: a `fallback_chain` provider's key (read only if the chain fails over to it) and a `$ref`-resolved external agent's key (until `$ref` resolution lands, 2.M–2.Q) are conditional and instead surface mid-run as a run failure (exit `1`).
- `--allow-mcp-stdio <digest>` (repeatable) authorizes a **local MCP program** for this invocation only, when there is no one to prompt. A workflow declaring a `stdio` MCP server that has not been approved on this machine exits `2` before anything spawns — see [Local MCP servers need consent](#local-mcp-servers-need-consent).
- On a `human_gate` node the run **pauses**: in interactive mode it prompts inline; in CI mode it exits with the gate-paused code (`3`, see [Exit codes](#exit-codes)) and can be resumed with `relavium gate`. The emitted `human_gate:paused` event carries the `runId` + `gateId` needed for the resume (`relavium gate <runId> --gate <gateId>`); with `--json` they are on the NDJSON event line, otherwise the plain/TUI renderer prints them inline (`paused at gate <gateId> (<type>)`, also echoed in the final summary). (`relavium status`, `relavium logs <runId>`, and `relavium gate list` also surface pending `gateId`s, 2.I.)

> **Implementation status (as of workstream 2.G).** `run` is wired to the `@relavium/core` engine: path/id resolution, `--input` coercion, the full lifecycle event stream, exit codes `0`/`1`/`2`/`3`, SIGINT→cancel, and the stable `--json` NDJSON machine contract (stdout = pure RunEvent stream, diagnostics → stderr; see [above](#the---json-machine-output-contract)) are live. The interactive **`ink` TUI** (2.E) renders the live run on a TTY — per-node status + spinners, the active node's streaming tokens, a running cost/duration footer, and a persistent final summary. Under `--no-color` it keeps the TUI but suppresses ANSI color; it falls back to the plain line renderer when no TTY is attached or `CI=true`, and to NDJSON under `--json` (the three renderers are one `onEvent` seam over one bus). Provider keys resolve from the **OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error** (2.C; manage them with `relavium provider`), and runs persist to durable history (2.H). The **interactive human-gate prompt** + out-of-band [`relavium gate`](#relavium-gate) resume are live (2.G): on a TTY a `human_gate` node renders a `@clack/prompts` card inline (approve / reject + comment / input) and the run continues; under `--json`/CI/no-TTY there is no prompt and the run exits `3`, resumable later by `relavium gate <runId>`. Built-in tools that need a host capability (filesystem, process, egress) are **fail-closed** (unavailable) pending a security-reviewed capability workstream.

### `relavium list`

Lists the workflows discovered under the project `.relavium/workflows/`, **grouped by tag**, each annotated with its **last-run status** from durable history (the latest run per workflow — a SQLite `ROW_NUMBER() OVER (PARTITION BY workflow_id …)` pick, since SQLite has no `DISTINCT ON`). `--agents` lists the agents under `.relavium/agents/` instead (agents carry no tags or run history, so they list flat). Disk is the catalog source of truth, distinct from run history — a discovered file that fails to parse is listed and flagged `(invalid: <reason>)` rather than hidden. Outside a `.relavium/` project this is reported clearly and exits `0` (an empty catalog is not a fault).

Under `--json`, each entry is one NDJSON record — `{ kind, slug, name, tags, path, valid, error?, lastRun }`, where `name` is `null` when the file declares none, `error` is a short, secret-free parse-failure reason present **only** when `valid` is `false`, and `lastRun` is `{ runId, status, completedAt }` or `null` for a never-run workflow (and is omitted entirely for agents). See [Read-command `--json` output](#read-command---json-output).

### `relavium create`

Interactive scaffolder (`@clack/prompts`) that asks **kind** (an **agent** → `.agent.yaml`, or a **minimal single-agent workflow** → `.relavium.yaml`, i.e. an `input → agent → output` scaffold wrapping one inline agent), then **name → provider → model → system prompt → tools** (comma-separated, optional). The id is the slugified name; the file lands at `.relavium/agents/<id>.agent.yaml` or `.relavium/workflows/<id>.relavium.yaml`.

The answers are assembled into a typed definition and **validated against the appropriate `@relavium/shared` schema before any write** — the [agent schema](../contracts/agent-yaml-spec.md) for an `.agent.yaml`, the [workflow schema](../contracts/workflow-yaml-spec.md) for a `.relavium.yaml` — so a bad model/provider/name is the same clean exit-`2` fault a `run` would raise (a name with no usable id characters is rejected up front). The id must be unique **across both catalogs** (see [`import`/`export`](#relavium-import--relavium-export) below): a same-kind clash needs `--force`, a cross-kind clash is always rejected. The wizard needs an interactive terminal on **both** ends (a TTY stdout to draw the prompt and a TTY stdin to read keys), so it **fails loud** (exit `2`) under `--json` or a non-TTY pipe; a cancel (Ctrl-C / ESC) writes nothing and exits `0`. The result is a plain YAML file ready to commit — pure file I/O, no keychain, no run state.

### `relavium import` / `relavium export`

Both are **surface-agnostic** git-native YAML operations — they read/write `.relavium/` files only, never the keychain or run state. A document's kind is detected from its filename suffix (`.agent.yaml` / `.relavium.yaml`), falling back to a content sniff; a file that is neither a valid workflow nor a valid agent is a clean exit-`2` fault naming both parse failures.

- **`import <path> [--force]`** copies an external `.relavium.yaml` / `.agent.yaml` into the project after validating it against the schema. It writes the **re-serialized canonical form** to `.relavium/<workflows|agents>/<slug>.<suffix>`. Ids are unique **across both catalogs** (a bare id resolves project-globally, so `export <id>` stays unambiguous): a **same-kind** slug collision is exit `2` unless `--force` overwrites it; a **cross-kind** collision (the id already names the other kind) is exit `2` always — rename one, since `--force` would leave both files in place.
- **`export <id> [--out <path>] [--force]`** resolves `<id>` across **both** catalogs (an id naming neither is exit `2`; an id that is *both* a workflow and an agent is exit `2`, "rename one"), re-validates it, and writes a portable copy. The default destination is `./<id>.<suffix>` in the cwd (a copy to share, outside the catalog); `--out` overrides it. Under `--json` it emits a single `{ id, kind, path }` record, where `path` is **cwd-relative** (the same shape `import --json` emits — no absolute filesystem path is printed in either mode).

**Why it is safe to share** (see [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md)): a **provider API key is never in the file by construction** — there is no schema field that holds a key value (keys live in the OS keychain, referenced by account id, and are resolved only at run time). MCP-server secrets are referenced via `{{secrets.*}}` placeholders **by convention** — the `env` map accepts arbitrary strings, so `export`/`import` **re-serialize faithfully** (they preserve whatever is authored; they do not scrub): author secrets as `{{secrets.*}}`, never inline a literal. The re-serialize from the validated AST also **drops all free-form comments** (where a stray secret might otherwise hide), and the exported file re-imports cleanly. This is the "workflow file is the invite" distribution mechanism.

### `relavium logs <runId>`

Replays a past run's persisted `run_events` in `seq` order (the same data the desktop run-detail drawer replays) — a terse line per event in human mode. Under `--json` it emits each **raw [RunEvent](../contracts/sse-event-schema.md) as one NDJSON line** — the same `RunEvent` data `relavium run --json` streamed (this is the "raw RunEvent JSON" the run-detail replay consumes — no separate `--raw` flag). For a run paused at a gate, the `human_gate:paused` event surfaces the **`gateId`** to copy into `relavium gate <runId> --gate <gateId>`. An unknown `runId` is an invalid invocation (exit `2`).

Two rows the replay may not be able to read, and it says which is which ([ADR-0074](../../decisions/0074-durable-conservative-budget-commitments.md) §5):

- a row written by a **newer Relavium** — an event `type` this binary does not know — is **skipped**, and a bounded `note:` naming the affected `seq` numbers goes to **stderr** (in both modes, so `--json`'s stdout stays a pure `RunEvent` stream). Without the note the event count and the `[seq]` column would present a short log with a gap as a complete one, which is exactly what [the event contract](../contracts/sse-event-schema.md#transport-notes) tells consumers to read as data loss. Upgrade to read them.
- a **damaged** row — unreadable JSON, or a `type` this binary knows whose body does not parse — **fails** the command (exit `1`), naming the run and the row's `seq`. It is never silently dropped. Other runs stay listable: `logs`/`status`/`gate list` isolate a damaged run so one bad row cannot blank the whole listing.

### `relavium status`

Shows the currently active/paused runs (from `runs` + `step_executions`) and each one's per-node status. Useful while a long workflow runs in another terminal or was launched detached. For any run paused at a human gate it also prints the **pending `gateId`(s)** (with gate type and node id), so a CI author can pass the right one to `relavium gate <runId> --gate <gateId>` — required when a run has more than one gate pending at once. It takes **no argument** (it lists every active run; a terminal run is not shown — inspect one with `relavium logs <runId>`). A run whose event log is damaged is still listed, without its gate detail, rather than aborting the listing ([ADR-0074](../../decisions/0074-durable-conservative-budget-commitments.md) §5). Under `--json` each active run is one NDJSON record — `{ runId, workflowId, status, startedAt, steps, pendingGates }`, where each `steps` entry is `{ nodeId, nodeType, status, attemptNumber, startedAt, completedAt, durationMs, costMicrocents }` and each `pendingGates` entry is `{ gateId, nodeId, gateType, message, expiresAt? }` (the same pending-gate shape [`gate list`](#relavium-gate-list) emits).

### `relavium models`

The live model catalog (2.5.G, [ADR-0064](../../decisions/0064-live-model-catalog.md)). The catalog is a **local cache** in `history.db` (`model_catalog`) that records which model ids each connected provider key can currently reach; the static registry ([pricing.ts](../../../packages/llm/src/pricing.ts)) stays the pricing authority, so the cache holds **no price** and **no API key**.

```bash
relavium models              # list the cached catalog
relavium models refresh      # force a live re-fetch of every connected provider
relavium models pricing my-custom-model --provider openai --input 3 --output 9   # hand-enter a price
```

- **`relavium models`** (no subcommand) lists the cached catalog (read-only). On the **very first run** — when the cache is empty — it does one minimal **blocking** refresh, then lists; an empty result stays a clean exit `0` (an empty catalog is not a fault, like `relavium list`). Human output is one line per model (`<modelId>  <provider>  ctx=<n>  [<source>]`).
- **`relavium models refresh`** re-fetches **two axes**, because *"refresh what I know about models"* is one intent, not two ([ADR-0071](../../decisions/0071-models-dev-as-the-model-metadata-source.md) §4a): the **provider lists** say which models a key can reach, and the **catalog** says what they cost and which reasoning tiers they take. `--providers` and `--catalog` address one axis each; neither flag (or both) means both.

  The provider half is **per-provider isolated**: one provider's failure (bad key, network, endpoint drift) or a provider without a list endpoint **never** fails the whole command — that provider is reported `failed` / `skipped` and the others still refresh. A per-provider failure is therefore **not** a command failure (exit `0` with the report). An explicit `--providers` refresh with **zero** providers connected (no key at all) is a clean exit `2` naming how to add a key, because nothing could be fetched.

  The catalog half needs **no key at all** — which is what makes `--catalog` the form a user with no provider configured yet can still run to see what things cost. A failed catalog fetch is a **note on stderr, never an error**: the shipped snapshot still answers, so a refresh can never leave Relavium knowing less than it shipped knowing. Under `--json`, each source emits its own record (`{ provider, … }` per provider, then `{ source: 'catalog', status, models, added }`).

- **The catalog is EMBEDDED and answers offline.** Relavium ships a generated models.dev snapshot — every price, ceiling and reasoning control — so a fresh install with no network prices every model it ships. `[catalog] auto_refresh` (**default `false`**) governs whether a bare `relavium models` refreshes it first; an explicit `models refresh` fetches regardless, because a command the user typed **is** consent. A local-first tool does not contact a third party unless asked.
- **`relavium models pricing <model> --provider <slug> --input <usd> --output <usd> [--cached <usd>]`** hand-enters the per-million-token price of a model. It MAY be a model the generated catalog (`packages/llm/src/catalog/`) already prices — **the USER outranks the catalog** ([ADR-0071](../../decisions/0071-models-dev-as-the-model-metadata-source.md) §5): a negotiated rate, an enterprise discount, or a price the snapshot has not caught up with wins over the shipped one (2.5.G S10, [ADR-0065](../../decisions/0065-provider-economics-and-extensibility.md) §1–2). Prices are **USD per million tokens** (`--input` prompt, `--output` completion, `--cached` cache-read; stored as integer micro-cents, `usd × 1e8`, never a float). The row is written as `source='user'` and a live `models refresh` **never** clobbers it. Overriding a catalog price is **not silent**: the command echoes the catalog price it replaces, so the divergence is stated at set-time (ADR-0071 §5). This also **closes the cost-cap gap** ([ADR-0064](../../decisions/0064-live-model-catalog.md) §6) for a model the catalog does NOT price: before, an unknown model had no price, so `budget.max_cost_microcents` / `[chat].max_cost_microcents` **degraded to allow** for it; once user-priced, the cap is enforced (pre-egress **and** realized) on `run`, a `run` resumed via [`relavium gate`](#relavium-gate), `chat` / `chat-resume` (incl. a `/clear` rebuild, re-read fresh), the Home chat, and one-shot `agent run`. `--clear` retires the override; the model falls back to the catalog price, or to unpriced if the catalog has none. Guards (each a clean exit `2`, nothing written): an **unregistered provider** is refused (register it first with `relavium provider add`); a **negative / non-finite / implausibly-large** price is refused; a price under a provider the catalog does **not** anchor the model to is refused (it would never apply); and the **same model id already user-priced under a *different* provider** is refused (the overlay keys by model id, so a second provider's price could not be distinguished — use a distinct id or re-price under that provider).
- **Security.** A provider key is read only to make the live request (over the bounded, abortable, secret-free `listModels` seam) and is **never** logged, persisted (the cache holds no key), or placed in the report / `--json` payload / any error message. A failing provider surfaces only the seam's already-redacted message (or a generic `refresh failed`), never a raw cause. `models pricing` writes only a model id + provider + integer prices — no key, ever.
- **`--json`** ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)) emits **one NDJSON record per line**, stdout-pure, key-free:
  - `relavium models --json` — one record per model: `{ provider, modelId, displayName, contextWindowTokens, maxOutputTokens, source, lastRefreshedAt, deprecationDate }` (`null` for an absent optional; `source` ∈ `static | live | user`; `lastRefreshedAt` is epoch-ms).
  - `relavium models refresh --json` — the **two axes** each emit their own record (§4a). A per-**provider** record: `{ provider, status, added, updated, deactivated, error }`, where `status` ∈ `refreshed | skipped-no-key | skipped-unsupported | failed`, the three counts are the model ids added / refreshed-in-place / soft-deactivated (`null` unless `status` is `refreshed`), and `error` is a short, secret-free reason (`null` unless `failed`). And, when the catalog axis ran, exactly one **catalog** record: `{ source, status, models, added, reason? }` — `source` is always the literal `'catalog'`; `status` ∈ `refreshed | failed`; `models` is the total the refreshed catalog describes and `added` the count the shipped snapshot did **not** carry (both `0` on a failure — the snapshot still answers); `reason` is present **only** on `failed` and is a short, secret-free sentence (never a raw fetch error, which can carry a URL).
  - `relavium models pricing --json` — one record: `{ model, provider, source, inputCostPerMtokMicrocents, outputCostPerMtokMicrocents, cachedInputCostPerMtokMicrocents }` (the stored integer micro-cents; `source` is always `user`).

### Read-command `--json` output

The non-streaming read commands (`list` / `status` / `gate list` / `chat-list` / `models` / `provider list`, and `logs`) keep the CLI to **one machine-output idiom**: `--json` emits **one result record per line** (NDJSON, `jq`-friendly, stdout-pure with diagnostics on stderr) — the same line-oriented shape `relavium run --json` uses for its `RunEvent` stream ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). For `logs --json` the records ARE raw `RunEvent`s — the same `RunEvent` data the run streamed (re-serialized from the persisted log, so the field order may differ from the live `run --json` bytes); for the others they are the per-command result records documented above. An unknown `runId` (`logs` / `gate list`) is the structured pre-run fault on stderr with exit `2`, stdout empty — exactly as for `run`. (`chat-export --json` is **not** a read command — it emits a single `session:exported` **event**, not a result record, since the export is a session-lifecycle action.)

### `relavium gate`

Resolves a pending human gate from the terminal — the surface-agnostic resume path for [`human_gate:paused`](../contracts/sse-event-schema.md):

```bash
relavium gate <runId> --approve
relavium gate <runId> --reject --comment "Too risky"
relavium gate <runId> --input '{"region": "us-east-1"}'      # for gate_type=input
relavium gate <runId> --gate <gateId> --approve            # disambiguate when >1 gate is pending

# a run with `secret`-typed inputs: re-supply them on stdin, never in argv
printf 'api_key=%s\n' "$API_KEY" | relavium gate <runId> --approve --secret-stdin
```

- Exactly **one** of `--approve` / `--reject` / `--input` is required and they are mutually exclusive; `--comment <text>` annotates an approve/reject rationale and is invalid with `--input` (which carries the payload). A bad combination is an invalid invocation (exit `2`).
- `--input <value>` is parsed as **JSON when it parses** (`'{"k":1}'` / `'42'` / `'true'` → a structured payload), else kept as the **raw string** (`--input some-token` → `"some-token"`); the result becomes the gate node's output. (The interactive prompt for a `gate_type=input` gate takes the typed value as a raw string.)
- **Do not pass secrets via `--input`.** The value reaches the durable event log (`human_gate:resumed.payload`) and the `--json` stream, and argv itself leaks into `ps` / shell history / CI logs — exactly the exposure `relavium provider set-key`'s stdin-only rule avoids. Use a non-secret gate input; supply secrets through the OS keychain / env (`RELAVIUM_<PROVIDER>_API_KEY`), never a gate payload.
- `--gate <gateId>` selects **which** pending gate to resolve. The resume contract is `engine.resume(runId, gateId, decision)` — `gateId` is mandatory on the resume path (it is carried on the `human_gate:paused` event; see [sse-event-schema.md](../contracts/sse-event-schema.md) and `resume_run` in [ipc-contract.md](../contracts/ipc-contract.md)). `--gate` is **optional on the CLI**: when exactly one gate is pending the CLI fills it in automatically; when **more than one** gate is pending it is **required**, and omitting it is an invalid invocation (exit `2`) listing the pending `gateId`s.
- Read the pending `runId` + `gateId` from the run's own output: the `human_gate:paused` event line under `--json`, or the `paused at gate <gateId> (<type>)` line the plain/TUI renderer prints. [`relavium gate list`](#relavium-gate-list), `relavium status`, and `relavium logs <runId>` (2.I) also surface them out-of-band.
- **`--secret-stdin` re-supplies the run's `secret`-typed inputs** ([ADR-0083](../../decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md) §6). A `secret` is never persisted — the durable record holds only a masked `{ secret: true, ref }` slot — so a secret-bearing run cannot resume without the value being handed back. Each is one **`name=value` line on stdin**; blank lines are ignored, and anything else is an invalid invocation (exit `2`).
  - **Values never travel through argv**, which is why this is a boolean flag and not `--secret <name=value>`: a credential on a command line leaks to `ps`, shell history and CI logs — the same rule `relavium provider set-key` follows. The *name* in the line is not a secret, and carrying it there rather than in a repeated flag removes the ordering dependency that would silently swap two credentials.
  - **Every masked slot must be supplied and nothing else may be.** A missing slot, a name the run has no slot for, a repeated name, and an **empty or all-whitespace value** are each exit `2`. A value may contain `=` (the split is on the first one); it may not contain a newline. The **name** is trimmed; the **value is taken verbatim** after the first `=`, so leading and trailing spaces are part of the credential — only a CRLF carriage return is removed. (An earlier version trimmed the whole line, which silently stripped a trailing space from a pasted key and surfaced hours later as an opaque `401`.)
  - **`--secret-stdin` makes the invocation non-interactive.** Reading the credential drains stdin, so a resumed run that reaches a *second* human gate cannot prompt: it exits `3` and is resolvable by another `relavium gate`, exactly as a `--json` or CI resume does.
  - Without the flag, a secret-bearing resume is refused (exit `2`) and the message names the slots and this remedy. With the flag on a run that has **no** secrets, the command refuses rather than blocking on a pipe nobody attached.
  - What this proves is the **slot**, not the credential: the engine verifies that the same named `secret` input was re-supplied and cannot tell whether the value is the same key or a rotated one. ADR-0083 §6 states that limit rather than implying more.
- **Idempotent.** A doubled decision — the run already finished, or the named gate was already resolved — is a clean exit-`0` no-op, never a double-advance (it leans on the engine's checkpoint/gate-state idempotency). An unknown `runId` is exit `2`. Idempotency is **per gate**, though: on a *sequential* multi-gate workflow a blind repeat *without* `--gate` (after the first decision advanced the run and it re-paused at the **next** gate) auto-fills and resolves *that* gate — so an automated retry-until-exit-`0` loop should **pin `--gate <gateId>`** to avoid resolving later gates unattended.

> **Implementation status (2.G).** `relavium gate` runs in a **fresh process** from the original `run`: it reloads the run's frozen `WorkflowDefinition` + inputs from the durable history snapshot (2.H), reconstructs the paused checkpoint from the persisted event log, and calls `engine.resumeFromCheckpoint` over the same store — then drives the resumed run to its terminal (exit `0` complete / `1` failed / `3` paused again at a later gate). The recorded `decidedBy` is the constant `cli` (a deterministic, non-PII marker; the desktop/portal supply a real user id). Budget-cap pauses (`budget:paused`, [ADR-0028](../../decisions/0028-workflow-resource-governance.md)) are **not** resolved here — that is the separate `relavium budget resume` surface ([deferred-tasks](../../roadmap/deferred-tasks.md)). A run that declares a **`secret`-typed input** is resumed by re-supplying it on stdin with `--secret-stdin` (above); without the flag `relavium gate` still **fails closed (exit `2`)**, because secrets are never persisted in plaintext (only a masked placeholder is, ADR-0006/0036) and there is nothing to restore. The engine enforces the same rule independently — it refuses a resume whose masked slot was not filled, and refuses the placeholder itself as a value. The [`relavium gate list`](#relavium-gate-list) multi-gate listing is live (2.I).

### `relavium gate list`

Lists the pending human gates so an operator can pick the `gateId` to resolve — the multi-gate discovery surface the [`gate`](#relavium-gate) command's `--gate` requirement points at.

```bash
relavium gate list             # every paused run's pending human gates
relavium gate list <runId>     # just one run's
```

- With no argument it scans **every paused run**; with a `<runId>` it lists just that run's pending gates (an unknown `runId` exits `2`). Budget-cap pauses (`budget:paused`) are **excluded** — those are the separate `relavium budget resume` surface ([ADR-0028](../../decisions/0028-workflow-resource-governance.md)).
- It rests on the **same** persisted-event reconstruction the [`gate`](#relavium-gate) resume path uses, so the listing and the resume can never disagree on what is pending.
- Human output is one line per gate (`<runId>  <gateId>  <gateType>  node=<nodeId>  "<message>"`); under `--json` each pending gate is one NDJSON record — `{ runId, gateId, nodeId, gateType, message, expiresAt? }` (see [Read-command `--json` output](#read-command---json-output)).

### `relavium chat-list`

Lists past [agent sessions](../contracts/agent-session-spec.md) from durable `history.db`, most-recently-updated first — the session counterpart of `relavium list`. Human output is one line per session (`<id>  <agentSlug>  [<status>]  <updatedAt>  "<title>"`); an empty history is reported clearly (exit `0`). Under `--json` each session is one NDJSON record — `{ sessionId, agentSlug, title, status, modelId, createdAt, updatedAt, totalCostMicrocents }`, where `title` / `modelId` are `null` when absent (see [Read-command `--json` output](#read-command---json-output)). Soft-deleted sessions are excluded.

### `relavium chat-export`

Exports a persisted session to a `.relavium.yaml` **scaffold** for review before commit ([ADR-0026](../../decisions/0026-session-export-to-workflow.md)) — the same contract the in-REPL `/export` drives. Writes `<sessionId>.relavium.yaml` in cwd by default (the file name is keyed on the unique session id, so two sessions never collide); `--out <path>` overrides, `--force` overwrites an existing target. The session row is marked `exported` with the written path. Under `--json` it emits a single `session:exported` event (`{ type, sessionId, timestamp, sequenceNumber, workflowPath }`). An unknown sessionId or an existing target without `--force` exits `2`; success is exit `0`.

### `relavium agent run`

Runs a single agent **one-shot** (non-interactive) on the same `AgentSession` infra as `relavium chat` — a session with one turn, then exit. The agent-first headline as a scriptable, CI-friendly primitive.

```bash
echo "summarize ./README.md" | relavium agent run code-reviewer
echo "review it" | relavium agent run ./agents/coder.agent.yaml --json
echo "review it" | relavium agent run code-reviewer --fixture ./fixtures/review.cassette.json --json
```

- The `<agent>` argument is required — a `.agent.yaml` path or a `.relavium/`-discoverable agent id (resolved by the same strict parser `relavium chat --agent` uses). An unknown agent is an invalid invocation (exit `2`).
- **The prompt is read from stdin** (the `echo … | relavium agent run` idiom); an empty stdin is an invalid invocation (exit `2`).
- `--input k=v` is **reserved** — currently **rejected** (exit `2`): a session does not yet interpolate `{{ctx.*}}` into the agent's prompt (the engine passes `system_prompt` verbatim), so the flag is failed loud rather than exposed as an inert no-op. It re-opens when session prompt interpolation lands (a tracked engine follow-up, [deferred-tasks.md](../../roadmap/deferred-tasks.md)).
- `--fixture <path>` replays a recorded LLM **cassette** so the run is deterministic and fully offline (no key, no network, no keychain) — the format is documented in [agent-run-fixture.md](agent-run-fixture.md). A malformed cassette exits `2`.
- `--json` emits the [`SessionEvent`](../contracts/sse-event-schema.md#session-event-namespace) NDJSON stream on stdout (the same shape `chat --json` produces); otherwise the assistant reply streams in human form.
- `--allow-mcp-stdio <digest>` (repeatable) authorizes a **local MCP program** for this invocation only. `agent run` is the one-shot, pipeline-facing member of the chat family — its stdin carries the prompt, so it can never prompt for consent, and an agent declaring an unapproved `stdio` MCP server exits `2` before anything spawns. See [Local MCP servers need consent](#local-mcp-servers-need-consent).
- **The transcript is not persisted** — a stateless invoke (no session/message row), unlike the REPL. It does still **open `history.db`** to attach the effect journal ([effect-journal.md](../shared-core/effect-journal.md)): an external effect is carried forward by the target, not by the run, so an unattached journal would refuse every effectful tool on this surface. The rows it writes are never read back. A `history.db` that cannot be opened fails the invocation.
- The exit code is the **turn's outcome**: `0` on success, `1` on a turn error; an invocation fault is `2`. It is **never** `4` (that is the interactive REPL's session-ended code).

### `relavium provider`

Registers LLM providers and manages their API keys in the **OS keychain** (workstream 2.C; `@napi-rs/keyring`,
[ADR-0019](../../decisions/0019-cli-node-keychain-library.md)). The **key value never leaves the keychain**:
the `llm_providers` row stores only the keychain `account` ref, display shows only a hint (last 4 chars), and a
key is read solely at LLM-call time. Known providers: `anthropic`, `openai`, `gemini`, `deepseek`.

```bash
relavium provider list                                  # registered providers + whether a key is set
relavium provider add anthropic                         # register a provider (its default base URL + pricing page)
relavium provider add openai --pricing-url https://example.com/prices   # override the pricing reference page
echo "$ANTHROPIC_API_KEY" | relavium provider set-key anthropic   # store a key (read from STDIN, never argv)
relavium provider test anthropic                        # verify the key with a minimal live request
relavium provider remove-key anthropic                  # delete the key from the keychain
relavium provider list --verify                         # + a live key-verification probe per provider
```

- **`set-key` reads the key from stdin**, never a CLI argument (argv leaks into `ps`, shell history, and CI
  logs); pipe it or use a heredoc. The key is stored in the OS keychain under the canonical entry-naming
  scheme ([keychain-and-secrets.md](../desktop/keychain-and-secrets.md#entry-naming)).
- **`list`** shows each registered provider, its base URL, and whether a key is set — a fast, **offline** read (no
  key is read; the status is derived from the stored keychain ref). **`--verify`** (2.5.G S11, [ADR-0065](../../decisions/0065-provider-economics-and-extensibility.md) §6) additionally runs a **bounded, key-redacted live probe** per provider — the SAME `validateProviderKey` seam `provider test` + `/doctor --deep` use — and reports `verified` / `failed — <redacted reason>` / `no key` in the status column. A provider with **no resolvable key** (keychain → env both empty) is reported `no key` and **never probed** (so `--verify` never hangs on a keyless provider); the key is **never** echoed. `list` honors **`--json`** ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)): one key-free NDJSON record per provider — `{ name, baseUrl, keySet, verified, verifyDetail }`, where `verified` is `null` without `--verify` (else `true`/`false`) and `verifyDetail` is a short reason — a **redacted** failure message, or `"no key"` when a probed provider has no resolvable key, else `null` (so a `verified: null` record with `verifyDetail: "no key"` is a probed-keyless provider, distinct from the un-probed `verifyDetail: null`). The `--verify` probes run **concurrently** (each timeout-bounded), so verifying N providers costs one timeout, not N.
- **`add` / `set-key`** auto-register the provider row. `--base-url <url>` on `add` records a custom endpoint that **is now actually used at request routing** (2.5.G S9, [ADR-0065](../../decisions/0065-provider-economics-and-extensibility.md) §3–4 — the earlier "dead-config" gap is closed): the resolver rebinds that provider's adapter to the custom endpoint and routes **all** its egress (streaming `generate`/`stream` + the `models.list` refresh) through the shared **SSRF-validated** hop (`connectValidated` — HTTPS-only, no embedded credentials, every resolved IP range-blocked, connect pinned to the validated IP for DNS-rebinding safety). Custom endpoints are **OpenAI-compatible only** this round (`openai` / `deepseek`); a `--base-url` on `anthropic` / `gemini` is **refused** with a clear message (exit `2`), as is a non-HTTPS / private-loopback / credential-bearing URL, or one carrying **terminal-control / bidirectional characters** (fail-fast at `add`, so the stored value is terminal-safe on every surface). The provider-id set stays **closed** — a custom endpoint reuses the `openai` / `deepseek` id (ADR-0065 §6).
- **`--pricing-url <url>`** on `add` overrides the seeded `pricing_reference_url` — the public pricing page where you find a model's price to hand-enter via [`relavium models pricing`](#relavium-models) (2.5.G S10, ADR-0065 §1). Each known provider is seeded with its default pricing page; the `add` confirmation echoes it. It is a **display-only pointer**, **never fetched** (not an egress target), so — unlike `--base-url` — it needs no SSRF gate; it is validated as an HTTPS URL with no embedded credentials and stored normalized (control bytes percent-encoded, so it is terminal-safe). Omitting the flag on a re-`add` preserves a previously-set custom pointer.
- **`test`** does a 1-token `generate` through `@relavium/llm`; `--model <id>` overrides the cheap default. A bad
  key fails cleanly (exit `2`) without echoing the key.
- **Key resolution** (used by `run` + `test`): **OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error**.
  The env var is the headless/CI source; the `secrets.enc` encrypted-file fallback is deferred past v1.0
  ([keychain-and-secrets.md](../desktop/keychain-and-secrets.md)). An unavailable keychain (locked / no Linux
  Secret Service) surfaces a clean error — never a silent plaintext fallback.

### Local MCP servers need consent

Every command that can open an **MCP-bearing artifact** — `relavium run`, `relavium chat`,
`relavium chat-resume`, `relavium agent run`, and the bare-invocation Home — passes through the same gate
before any local program starts ([ADR-0084](../../decisions/0084-consent-before-a-local-mcp-spawn.md)). An
agent or workflow with a `stdio` MCP server declares a **program on your machine**; the artifact chooses it,
so the decision is yours. Network transports (`http`, `sse`, `websocket`) need no consent — there is no local
process — and a server already approved on this machine is not asked about again.

The prompt asks **once per server**, showing the resolved executable, each argument on its own line, the
environment (a secret shows as a `<secret:NAME>` marker, never its value), the working directory, the artifact
that declared it, and the fingerprint. It **defaults to No**, and Ctrl-C is a refusal. A refused server means
the invocation stops before anything spawns.

Approval is recorded per machine in `~/.relavium/mcp-consent.ndjson`. It covers the exact declaration — a
changed executable, argument, environment value or working directory is a different program and is asked about
again.

**Asking requires all four of**: a TTY stdout, a TTY stdin, no `--json`, and no CI environment. Missing any of
them — a pipeline, a piped stdin, a machine-readable stream — the invocation **refuses with exit `2`** rather
than prompting into a stream nobody reads or hanging a job on a question nobody answers. The refusal prints
each unapproved server and its digest on stderr:

```
  fs: /usr/local/bin/npx  v1:9f2c…
```

The digest is a hash of the declaration, **not a secret**. To authorize those servers for a non-interactive
invocation, review each one and pass it back:

```bash
relavium run pipeline.relavium.yaml --allow-mcp-stdio v1:9f2c… --allow-mcp-stdio v1:41ab…
```

`--allow-mcp-stdio` is repeatable, authorizes **only that invocation**, and **writes no grant** — a CI runner
does not accumulate standing trust. It exists on `relavium run` and `relavium agent run`, the two commands a
pipeline invokes; the interactive chat family answers at the prompt instead.

## Exit codes

CI relies on deterministic exit codes:

| Code | Meaning |
|------|---------|
| `0` | Workflow completed successfully |
| `1` | Workflow failed (a node errored and exhausted retries/fallbacks) |
| `2` | Invalid invocation (bad arguments, workflow not found, schema validation error) |
| `3` | Run paused at a human gate (CI/non-interactive mode) — resume with `relavium gate` |
| `4` | A chat session ended — via `/exit`, `/cancel` (or Ctrl-C in TTY mode), or an input-stream EOF — a user-initiated end of a `relavium chat` REPL — see [chat-session.md](chat-session.md) |
| `5` | The run **produced** a terminal, but whether it reached the durable log is **not known** ([ADR-0078](../../decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §5). The terminal is held in the outbox and retried on the next start |
| `6` | The run is owned by **another process** — either refused before starting, or fenced out mid-flight and stopped without claiming an outcome ([ADR-0079](../../decisions/0079-cross-process-run-ownership-lease-and-fencing-token.md) §5, §7). The only **transient** code: retry shortly |
| `7` | An external **effect** from a prior attempt of this run is unresolved, so the run stopped for a human ([ADR-0080](../../decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md) §2b; [effect-journal.md](../shared-core/effect-journal.md) §4, §8). The only code whose remedy is **do not retry** — check the target, then clear the row (the resolving command is a named follow-up; today the row is cleared out of band); resuming re-enters the same gate |

> Codes `5` and `6` are both "the run's record is not what you might assume", and they differ in what to do next: `5` means a terminal exists and the CLI will retry writing it for you, so re-check after the next invocation; `6` means another process owns the run and is recording it, so there is nothing local to retry — read `relavium logs <runId>` for the truth (`relavium status` takes no argument and lists only ACTIVE runs, so it will not show a run another process has already finished). A run that produced no terminal at all is always `6`, never `5`.
>
> Exit code `7` is the one code a retry can make WORSE. Every other non-zero code either fails identically forever (`2`), resolves on its own (`6`), or describes a run that can be re-run (`1`). A `7` means an external effect — a filed ticket, a sent webhook, a started payment — may already have landed and nothing recorded what the target did. Retrying it is how one effect becomes two. An automation loop must surface a `7` to a person, never re-invoke on it.
>
> Exit code `6` is the one refusal worth retrying unchanged. Every other invocation fault (`2`) is a mistake in the call and fails identically forever, while `6` means another `relavium` process holds a live lease on the run and resolves on its own when that process finishes or its lease expires. An automation loop should back off and retry on `6`, and never on `2`.
>
> Exit code `3` lets CI distinguish a pause-for-approval (a `run:paused` event — the run's aggregate suspension, a human/approval/budget gate — in non-interactive mode) from a hard failure. This is the canonical home for the gate-paused code; other docs reference it as `3`.
>
> Under `--json`, a pre-run fault (exit `2`) writes its structured `{ "type": "error", … }` detail to **stderr** while stdout stays empty ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)) — the exit code is the primary fault signal; read stderr for the detail.
>
> Exit code `4` is the canonical **chat-session-ended** code: it marks a deliberate `/exit` (or its `--json` equivalent, a final `session:cancelled`/end event) from the `relavium chat` REPL, kept distinct from a successful workflow run (`0`) and a hard failure (`1`) so a wrapper script can tell "the user quit the chat" apart from either. Other docs reference it as `4`.
>
> Exit code `5` is **durability-uncertain**, and it is deliberately neither `0` nor `1`. The run may well have COMPLETED — the outputs are in the delivered terminal — and only its durable record is missing, so reporting success would be as wrong as reporting failure. The terminal is held in the host's terminal outbox (`~/.relavium/terminal-outbox.ndjson`, beside `history.db` and deliberately not inside it) and retried on the next `relavium` start. A script seeing `5` should treat the run as done-but-unrecorded and re-check `relavium status <runId>` after a subsequent invocation. Other docs reference it as `5`.
>
> The bare-invocation **interactive Home** (2.5.B, [home.md](home.md)) is a long-lived mode whose **clean exit is `0`** (Ctrl-C / Ctrl-D on an empty prompt). A chat launched from inside the Home has its own exit code `4`, which the **Home loop consumes** — a chat ending returns to the Home, never leaked. An external signal to the Home runs teardown then exits the conventional `128+signo` (**`130`** SIGINT / **`143`** SIGTERM) so a pipeline still detects the interruption.

## CI/CD usage

The CLI is designed to run inside pipelines. A typical pattern: install globally, provide the API key via the OS keychain or an environment variable, and run with `--json` for parseable output.

```yaml
# illustrative CI step
- run: npm install -g relavium
- run: relavium run .relavium/code-review.relavium.yaml --input file=src/index.ts --json
```

A workflow whose agents declare a **`stdio` MCP server** will not spawn one in a pipeline: there is no one to
ask, so it exits `2` and prints each server's digest. Review each program, then authorize it per invocation —
see [Local MCP servers need consent](#local-mcp-servers-need-consent).

```yaml
- run: >
    relavium run .relavium/code-review.relavium.yaml --input file=src/index.ts --json
    --allow-mcp-stdio v1:9f2c…
```

For a complete walkthrough (key handling, gates, artifacts, exit-code checks), see [run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md).

## Phase 2 note

> In Phase 2, `relavium` gains cloud-mode commands (e.g. `relavium auth login` via OAuth Device Flow, and switching execution to the cloud). The engine interface is identical in both modes — the CLI requires no code changes to target cloud execution. See [../portal/api-reference.md](../portal/api-reference.md) and [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md).
