# CLI Command Reference (`relavium`)

> Last updated: 2026-06-03

- **Status**: Reference (partial — surface defined, exact flags to be finalized as the CLI is built)
- **Surface**: CLI (`relavium`)
- **Scope**: Phase 1, local-first. Same `@relavium/core` engine as every other surface.
- **Related**: [../vscode/extension-api.md](../vscode/extension-api.md), [../desktop/routes-and-screens.md](../desktop/routes-and-screens.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../../tutorials/cli/run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md), [../../runbooks/add-a-provider-key.md](../../runbooks/add-a-provider-key.md)

The `relavium` CLI is the terminal surface of the platform and the fastest way to run a workflow non-interactively (scripts, CI/CD). It embeds the **same** `@relavium/core` engine as the desktop app and VS Code extension — there is no separate "CLI engine," so behavior is identical across surfaces (see [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)). The CLI is built **second** (right after the engine) and serves as the engine's canonical integration-test harness.

## Install & distribution

- **Package**: published to npm as `relavium`, installed globally.
- **Build**: TypeScript bundled with `tsup` to a single ESM bundle.
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
| **NDJSON** | `--json` (anywhere on the command line) | The machine contract: stdout is a pure [RunEvent](../contracts/sse-event-schema.md) NDJSON stream; all diagnostics go to stderr. See [The `--json` machine-output contract](#the---json-machine-output-contract) |

NDJSON is engaged **only** by `--json` (the explicit machine opt-in); a non-TTY or `CI=true`
environment disables the interactive TUI but does not by itself switch stdout to NDJSON
([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). Exit codes are CI-friendly
(see [Exit codes](#exit-codes)).

### The `--json` machine-output contract

Under `relavium run --json`, the CLI emits a stable machine contract a CI job can pipe and assert
on ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). The contract covers a workflow
**run**; `--help`, `--version`, and a bare no-command invocation are exit-`0` meta-operations that
print their human text (usage / version) to stdout as usual, `--json` notwithstanding.

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

> **Candidate (non-gating): an agent-readable command surface.** Because Relavium's own thesis is
> that work starts in an agent, the CLI is a natural *tool surface for other agents* — two cheap
> affordances are candidates for the build-phase-2 implementation, with neither gating M3: a
> **machine-readable help mode** (`--help` emitting the command/flag surface as JSON, so an agent
> can discover the CLI without scraping prose) and a per-command **`effect` annotation**
> (`read` / `write` / `destructive`) in that output, so an agent's tool policy can gate
> destructive commands behind approval the same way workflow tools are gated. If adopted, the
> shapes are locked here.

## Global options

These flags are **position-independent** — they may appear anywhere on the command line, so
`relavium run wf --json` and `relavium --json run wf` are equivalent (the CLI extracts them
before parsing the subcommand).

| Flag | Effect |
|------|--------|
| `--json` | Emit machine-readable NDJSON output (disables the TUI) — see [Output modes](#output-modes). |
| `--no-color` | Disable colored output. |
| `--cwd <dir>` | Run as if started in `<dir>` (project discovery and relative paths resolve from here). |
| `--config <path>` | Use an explicit global config file instead of `~/.relavium/config.toml` — the project `.relavium/` layers still apply ([config-spec.md](../contracts/config-spec.md)). |
| `-v, --verbose` | Print verbose diagnostics to stderr. |
| `-q, --quiet` | Suppress non-essential output. (`--verbose` and `--quiet` cannot be combined → exit `2`.) |
| `-V, --version` | Print the version and exit `0`. |
| `-h, --help` | Print help for the program or a subcommand and exit `0`. |

## Commands

The command set below is the confirmed surface. Subcommands marked _(planned)_ are intended but not yet locked.

| Command | Purpose |
|---------|---------|
| `relavium run <workflow> [--input k=v]` | Execute a workflow. Streams progress; resolves with the workflow output. |
| `relavium chat [--agent <ref>]` | Start an interactive [agent session](../contracts/agent-session-spec.md) (the agent-first REPL). See [chat-session.md](chat-session.md). |
| `relavium chat-resume <sessionId>` | Reload a persisted session from `history.db` and continue the conversation. |
| `relavium chat-list` | List past agent sessions (id, agent, last activity), the way `relavium list` lists workflows. |
| `relavium chat-export <sessionId>` | Export a session to a `.relavium.yaml` scaffold for review ([ADR-0026](../../decisions/0026-session-export-to-workflow.md)). |
| `relavium agent run <agent> [--input k=v]` | Run a single agent **one-shot** (non-interactive) on the same AgentSession infra — a chat session with one turn, then exit. |
| `relavium list` | List discovered workflows (and, with a flag, agents) in the current project. |
| `relavium create` | Scaffold a new workflow or agent YAML via an interactive wizard. |
| `relavium import <path>` | Import an external `.relavium.yaml` / `.agent.yaml` into the project. |
| `relavium export <id>` | Export a workflow/agent to a portable YAML file (secret references stripped). |
| `relavium logs <runId>` | Print the persisted event/log stream for a past run. |
| `relavium status` | Show active runs and their per-node status. |
| `relavium gate <runId>` | Resolve a pending human gate (approve / reject / provide input). |
| `relavium gate list [<runId>]` | List pending human gates (all active runs, or one run) — the multi-gate subcommand for resolving one of several concurrently-pending gates. |
| `relavium budget resume <runId> [--approve\|--abort]` | Resume a run suspended at a budget cap (`budget:paused`, `on_exceed: pause_for_approval`) — approve to continue or abort. The non-interactive operator path for [ADR-0028](../../decisions/0028-workflow-resource-governance.md). |
| `relavium init` _(planned)_ | Initialize a `.relavium/` directory in the current project. |
| `relavium agent <subcommand>` _(planned)_ | Manage agents (list / create / test). |
| `relavium provider <subcommand>` _(planned)_ | Manage providers and API keys in the OS keychain. |

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
- On a `human_gate` node the run **pauses**: in interactive mode it prompts inline; in CI mode it exits with the gate-paused code (`3`, see [Exit codes](#exit-codes)) and can be resumed with `relavium gate`. The emitted `human_gate:paused` event carries the `gateId` needed for the resume (`relavium gate <runId> --gate <gateId>`); with `--json` it is on the NDJSON event line, otherwise read it from `relavium status`/`relavium logs`.

> **Implementation status (as of workstream 2.F).** `run` is wired to the `@relavium/core` engine: path/id resolution, `--input` coercion, the full lifecycle event stream, exit codes `0`/`1`/`2`/`3`, SIGINT→cancel, and the stable `--json` NDJSON machine contract (stdout = pure RunEvent stream, diagnostics → stderr; see [above](#the---json-machine-output-contract)) are live. Still landing in later workstreams: the rich `ink` TUI (2.E — until then a minimal one-line-per-event human renderer), the interactive inline gate prompt and `relavium gate` resume (2.G/2.H — until then a `human_gate` node exits `3`), provider keys from the OS keychain (2.C — until then the `RELAVIUM_<PROVIDER>_API_KEY` environment fallback, the per-invocation key source in the [config-spec.md](../contracts/config-spec.md) precedence), and durable run history (2.H — until then runs are in-memory). Built-in tools that need a host capability (filesystem, process, egress) are **fail-closed** (unavailable) pending a security-reviewed capability workstream.

### `relavium list`

Lists workflows discovered under `.relavium/`, grouped by tag, with last-run status. A flag extends it to list agents.

### `relavium create`

Interactive scaffolder (`@clack/prompts`) that writes a new `.relavium.yaml` or `.agent.yaml` from answers (name, model, system prompt, tools). The result is a plain YAML file ready to commit.

### `relavium import` / `relavium export`

`import` brings an external YAML into the project's `.relavium/`. `export` writes a portable copy with all secret references stripped/placeholdered (see [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md)) — safe to share via PR. This is the "workflow file is the invite" distribution mechanism.

### `relavium logs`

Prints the persisted event/log stream for a past run (the same data the desktop run-detail screen replays). Accepts a flag to emit raw [RunEvent](../contracts/sse-event-schema.md) JSON. For a run paused at a gate, the rendered `human_gate:paused` event surfaces the **`gateId`** so a CI author can copy it into `relavium gate <runId> --gate <gateId>`.

### `relavium status`

Shows currently active runs and their per-node status. Useful while a long workflow runs in another terminal or was launched detached. For any run paused at a human gate it also prints the **pending `gateId`(s)** (with gate type and node id), so a CI author can pass the right one to `relavium gate <runId> --gate <gateId>` — required when a run has more than one gate pending at once.

### `relavium gate`

Resolves a pending human gate from the terminal — the surface-agnostic resume path for [`human_gate:paused`](../contracts/sse-event-schema.md):

```bash
relavium gate <runId> --approve
relavium gate <runId> --reject --comment "Too risky"
relavium gate <runId> --input '{"api_key": "..."}'          # for gate_type=input
relavium gate <runId> --gate <gateId> --approve            # disambiguate when >1 gate is pending
```

- `--gate <gateId>` selects **which** pending gate to resolve. The resume contract is `engine.resume(runId, gateId, decision)` — `gateId` is mandatory on the resume path (it is carried on the `human_gate:paused` event; see [sse-event-schema.md](../contracts/sse-event-schema.md) and `resume_run` in [ipc-contract.md](../contracts/ipc-contract.md)). `--gate` is **optional on the CLI**: when exactly one gate is pending the CLI fills it in automatically; when **more than one** gate is pending it is **required**, and omitting it is an invalid invocation (exit `2`) listing the pending `gateId`s.
- Get the pending `gateId`(s) from `relavium status` or `relavium logs <runId>` (both print them — see below).

## Exit codes

CI relies on deterministic exit codes:

| Code | Meaning |
|------|---------|
| `0` | Workflow completed successfully |
| `1` | Workflow failed (a node errored and exhausted retries/fallbacks) |
| `2` | Invalid invocation (bad arguments, workflow not found, schema validation error) |
| `3` | Run paused at a human gate (CI/non-interactive mode) — resume with `relavium gate` |
| `4` | A chat session ended via `/exit` (a clean, user-initiated end of an interactive `relavium chat` REPL) — see [chat-session.md](chat-session.md) |

> Exit code `3` lets CI distinguish a pause-for-approval (a `run:paused` event — the run's aggregate suspension, a human/approval/budget gate — in non-interactive mode) from a hard failure. This is the canonical home for the gate-paused code; other docs reference it as `3`.
>
> Under `--json`, a pre-run fault (exit `2`) writes its structured `{ "type": "error", … }` detail to **stderr** while stdout stays empty ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)) — the exit code is the primary fault signal; read stderr for the detail.
>
> Exit code `4` is the canonical **chat-session-ended** code: it marks a deliberate `/exit` (or its `--json` equivalent, a final `session:cancelled`/end event) from the `relavium chat` REPL, kept distinct from a successful workflow run (`0`) and a hard failure (`1`) so a wrapper script can tell "the user quit the chat" apart from either. Other docs reference it as `4`.

## CI/CD usage

The CLI is designed to run inside pipelines. A typical pattern: install globally, provide the API key via the OS keychain or an environment variable, and run with `--json` for parseable output.

```yaml
# illustrative CI step
- run: npm install -g relavium
- run: relavium run .relavium/code-review.relavium.yaml --input file=src/index.ts --json
```

For a complete walkthrough (key handling, gates, artifacts, exit-code checks), see [run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md).

## Phase 2 note

> In Phase 2, `relavium` gains cloud-mode commands (e.g. `relavium auth login` via OAuth Device Flow, and switching execution to the cloud). The engine interface is identical in both modes — the CLI requires no code changes to target cloud execution. See [../portal/api-reference.md](../portal/api-reference.md) and [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md).
