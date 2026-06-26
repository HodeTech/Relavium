# CLI Command Reference (`relavium`)

> Last updated: 2026-06-26

- **Status**: Reference (partial — surface defined, exact flags to be finalized as the CLI is built)
- **Surface**: CLI (`relavium`)
- **Scope**: Phase 1, local-first. Same `@relavium/core` engine as every other surface.
- **Related**: [../vscode/extension-api.md](../vscode/extension-api.md), [../desktop/routes-and-screens.md](../desktop/routes-and-screens.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../../tutorials/cli/run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md), [../../runbooks/add-a-provider-key.md](../../runbooks/add-a-provider-key.md)

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

`--no-color` does **not** change the mode — the interactive TUI stays active and only ANSI color/dim
are suppressed (plain output without a renderer swap). A swap to the Plain renderer happens only on
no-TTY / `CI=true`, and to NDJSON only on `--json`.

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

The command set below is the confirmed surface. Commands ship **per workstream**: `run` (2.D), `gate` + `gate list` (2.G/2.I), `provider` (2.C), the read commands `list` / `logs` / `status` (2.I), and the whole agent-first chat family — **`chat`** (2.M), **`chat-resume`** (2.N), **`chat-list`** (2.O), **`chat-export`** (2.P), and **`chat --json` + `agent run`** (2.Q) — are all **live**; the authoring commands (`create` / `import` / `export`) land at **2.J**, and `budget resume` is a [tracked follow-up](../../roadmap/deferred-tasks.md). Invoking a not-yet-shipped command exits with a clean "not available yet (lands in …)" message. Subcommands marked _(planned)_ are intended but not yet locked.

| Command | Purpose |
|---------|---------|
| `relavium run <workflow> [--input k=v]` | Execute a workflow. Streams progress; resolves with the workflow output. |
| `relavium chat [--agent <ref>]` | Start an interactive [agent session](../contracts/agent-session-spec.md) (the agent-first REPL). See [chat-session.md](chat-session.md). |
| `relavium chat-resume <sessionId>` | Reload a persisted session from `history.db` and continue the conversation. |
| `relavium chat-list` | List past agent sessions (id, agent, last activity), the way `relavium list` lists workflows. |
| `relavium chat-export <sessionId>` | Export a session to a `.relavium.yaml` scaffold for review ([ADR-0026](../../decisions/0026-session-export-to-workflow.md)). |
| `relavium agent run <agent> [--fixture <path>] [--json]` | Run a single agent **one-shot** (non-interactive) on the same AgentSession infra — the prompt is read from stdin, one turn, then exit. See [`relavium agent run`](#relavium-agent-run) and [agent-run-fixture.md](agent-run-fixture.md). |
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
| `relavium provider <subcommand>` | Manage providers and API keys in the OS keychain (`list` / `add` / `set-key` / `remove-key` / `test`). |

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
- On a `human_gate` node the run **pauses**: in interactive mode it prompts inline; in CI mode it exits with the gate-paused code (`3`, see [Exit codes](#exit-codes)) and can be resumed with `relavium gate`. The emitted `human_gate:paused` event carries the `runId` + `gateId` needed for the resume (`relavium gate <runId> --gate <gateId>`); with `--json` they are on the NDJSON event line, otherwise the plain/TUI renderer prints them inline (`paused at gate <gateId> (<type>)`, also echoed in the final summary). (`relavium status`, `relavium logs <runId>`, and `relavium gate list` also surface pending `gateId`s, 2.I.)

> **Implementation status (as of workstream 2.G).** `run` is wired to the `@relavium/core` engine: path/id resolution, `--input` coercion, the full lifecycle event stream, exit codes `0`/`1`/`2`/`3`, SIGINT→cancel, and the stable `--json` NDJSON machine contract (stdout = pure RunEvent stream, diagnostics → stderr; see [above](#the---json-machine-output-contract)) are live. The interactive **`ink` TUI** (2.E) renders the live run on a TTY — per-node status + spinners, the active node's streaming tokens, a running cost/duration footer, and a persistent final summary. Under `--no-color` it keeps the TUI but suppresses ANSI color; it falls back to the plain line renderer when no TTY is attached or `CI=true`, and to NDJSON under `--json` (the three renderers are one `onEvent` seam over one bus). Provider keys resolve from the **OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error** (2.C; manage them with `relavium provider`), and runs persist to durable history (2.H). The **interactive human-gate prompt** + out-of-band [`relavium gate`](#relavium-gate) resume are live (2.G): on a TTY a `human_gate` node renders a `@clack/prompts` card inline (approve / reject + comment / input) and the run continues; under `--json`/CI/no-TTY there is no prompt and the run exits `3`, resumable later by `relavium gate <runId>`. Built-in tools that need a host capability (filesystem, process, egress) are **fail-closed** (unavailable) pending a security-reviewed capability workstream.

### `relavium list`

Lists the workflows discovered under the project `.relavium/workflows/`, **grouped by tag**, each annotated with its **last-run status** from durable history (the latest run per workflow — a SQLite `ROW_NUMBER() OVER (PARTITION BY workflow_id …)` pick, since SQLite has no `DISTINCT ON`). `--agents` lists the agents under `.relavium/agents/` instead (agents carry no tags or run history, so they list flat). Disk is the catalog source of truth, distinct from run history — a discovered file that fails to parse is listed and flagged `(invalid: <reason>)` rather than hidden. Outside a `.relavium/` project this is reported clearly and exits `0` (an empty catalog is not a fault).

Under `--json`, each entry is one NDJSON record — `{ kind, slug, name, tags, path, valid, error?, lastRun }`, where `name` is `null` when the file declares none, `error` is a short, secret-free parse-failure reason present **only** when `valid` is `false`, and `lastRun` is `{ runId, status, completedAt }` or `null` for a never-run workflow (and is omitted entirely for agents). See [Read-command `--json` output](#read-command---json-output).

### `relavium create`

Interactive scaffolder (`@clack/prompts`) that writes a new `.relavium.yaml` or `.agent.yaml` from answers (name, model, system prompt, tools). The result is a plain YAML file ready to commit.

### `relavium import` / `relavium export`

`import` brings an external YAML into the project's `.relavium/`. `export` writes a portable copy with all secret references stripped/placeholdered (see [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md)) — safe to share via PR. This is the "workflow file is the invite" distribution mechanism.

### `relavium logs <runId>`

Replays a past run's persisted `run_events` in `seq` order (the same data the desktop run-detail drawer replays) — a terse line per event in human mode. Under `--json` it emits each **raw [RunEvent](../contracts/sse-event-schema.md) as one NDJSON line** — the same `RunEvent` data `relavium run --json` streamed (this is the "raw RunEvent JSON" the run-detail replay consumes — no separate `--raw` flag). For a run paused at a gate, the `human_gate:paused` event surfaces the **`gateId`** to copy into `relavium gate <runId> --gate <gateId>`. An unknown `runId` is an invalid invocation (exit `2`).

### `relavium status`

Shows the currently active/paused runs (from `runs` + `step_executions`) and each one's per-node status. Useful while a long workflow runs in another terminal or was launched detached. For any run paused at a human gate it also prints the **pending `gateId`(s)** (with gate type and node id), so a CI author can pass the right one to `relavium gate <runId> --gate <gateId>` — required when a run has more than one gate pending at once. It takes **no argument** (it lists every active run; a terminal run is not shown — inspect one with `relavium logs <runId>`). Under `--json` each active run is one NDJSON record — `{ runId, workflowId, status, startedAt, steps, pendingGates }`, where each `steps` entry is `{ nodeId, nodeType, status, attemptNumber, startedAt, completedAt, durationMs, costMicrocents }` and each `pendingGates` entry is `{ gateId, nodeId, gateType, message, expiresAt? }` (the same pending-gate shape [`gate list`](#relavium-gate-list) emits).

### Read-command `--json` output

The non-streaming read commands (`list` / `status` / `gate list` / `chat-list`, and `logs`) keep the CLI to **one machine-output idiom**: `--json` emits **one result record per line** (NDJSON, `jq`-friendly, stdout-pure with diagnostics on stderr) — the same line-oriented shape `relavium run --json` uses for its `RunEvent` stream ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). For `logs --json` the records ARE raw `RunEvent`s — the same `RunEvent` data the run streamed (re-serialized from the persisted log, so the field order may differ from the live `run --json` bytes); for the others they are the per-command result records documented above. An unknown `runId` (`logs` / `gate list`) is the structured pre-run fault on stderr with exit `2`, stdout empty — exactly as for `run`. (`chat-export --json` is **not** a read command — it emits a single `session:exported` **event**, not a result record, since the export is a session-lifecycle action.)

### `relavium gate`

Resolves a pending human gate from the terminal — the surface-agnostic resume path for [`human_gate:paused`](../contracts/sse-event-schema.md):

```bash
relavium gate <runId> --approve
relavium gate <runId> --reject --comment "Too risky"
relavium gate <runId> --input '{"region": "us-east-1"}'      # for gate_type=input
relavium gate <runId> --gate <gateId> --approve            # disambiguate when >1 gate is pending
```

- Exactly **one** of `--approve` / `--reject` / `--input` is required and they are mutually exclusive; `--comment <text>` annotates an approve/reject rationale and is invalid with `--input` (which carries the payload). A bad combination is an invalid invocation (exit `2`).
- `--input <value>` is parsed as **JSON when it parses** (`'{"k":1}'` / `'42'` / `'true'` → a structured payload), else kept as the **raw string** (`--input some-token` → `"some-token"`); the result becomes the gate node's output. (The interactive prompt for a `gate_type=input` gate takes the typed value as a raw string.)
- **Do not pass secrets via `--input`.** The value reaches the durable event log (`human_gate:resumed.payload`) and the `--json` stream, and argv itself leaks into `ps` / shell history / CI logs — exactly the exposure `relavium provider set-key`'s stdin-only rule avoids. Use a non-secret gate input; supply secrets through the OS keychain / env (`RELAVIUM_<PROVIDER>_API_KEY`), never a gate payload.
- `--gate <gateId>` selects **which** pending gate to resolve. The resume contract is `engine.resume(runId, gateId, decision)` — `gateId` is mandatory on the resume path (it is carried on the `human_gate:paused` event; see [sse-event-schema.md](../contracts/sse-event-schema.md) and `resume_run` in [ipc-contract.md](../contracts/ipc-contract.md)). `--gate` is **optional on the CLI**: when exactly one gate is pending the CLI fills it in automatically; when **more than one** gate is pending it is **required**, and omitting it is an invalid invocation (exit `2`) listing the pending `gateId`s.
- Read the pending `runId` + `gateId` from the run's own output: the `human_gate:paused` event line under `--json`, or the `paused at gate <gateId> (<type>)` line the plain/TUI renderer prints. [`relavium gate list`](#relavium-gate-list), `relavium status`, and `relavium logs <runId>` (2.I) also surface them out-of-band.
- **Idempotent.** A doubled decision — the run already finished, or the named gate was already resolved — is a clean exit-`0` no-op, never a double-advance (it leans on the engine's checkpoint/gate-state idempotency). An unknown `runId` is exit `2`. Idempotency is **per gate**, though: on a *sequential* multi-gate workflow a blind repeat *without* `--gate` (after the first decision advanced the run and it re-paused at the **next** gate) auto-fills and resolves *that* gate — so an automated retry-until-exit-`0` loop should **pin `--gate <gateId>`** to avoid resolving later gates unattended.

> **Implementation status (2.G).** `relavium gate` runs in a **fresh process** from the original `run`: it reloads the run's frozen `WorkflowDefinition` + inputs from the durable history snapshot (2.H), reconstructs the paused checkpoint from the persisted event log, and calls `engine.resumeFromCheckpoint` over the same store — then drives the resumed run to its terminal (exit `0` complete / `1` failed / `3` paused again at a later gate). The recorded `decidedBy` is the constant `cli` (a deterministic, non-PII marker; the desktop/portal supply a real user id). Budget-cap pauses (`budget:paused`, [ADR-0028](../../decisions/0028-workflow-resource-governance.md)) are **not** resolved here — that is the separate `relavium budget resume` surface ([deferred-tasks](../../roadmap/deferred-tasks.md)). A run that declares a **`secret`-typed input** cannot be resumed cross-process: secrets are never persisted in plaintext (only a masked placeholder is, ADR-0006/0036), so `relavium gate` **fails closed (exit `2`)** rather than resume with a value it cannot restore — re-run the workflow instead (re-providing secret inputs on resume is a [tracked follow-up](../../roadmap/deferred-tasks.md)). The [`relavium gate list`](#relavium-gate-list) multi-gate listing is live (2.I).

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
- **Not persisted** — a stateless invoke (no `history.db` row), unlike the REPL. The exit code is the **turn's outcome**: `0` on success, `1` on a turn error; an invocation fault is `2`. It is **never** `4` (that is the interactive REPL's session-ended code).

### `relavium provider`

Registers LLM providers and manages their API keys in the **OS keychain** (workstream 2.C; `@napi-rs/keyring`,
[ADR-0019](../../decisions/0019-cli-node-keychain-library.md)). The **key value never leaves the keychain**:
the `llm_providers` row stores only the keychain `account` ref, display shows only a hint (last 4 chars), and a
key is read solely at LLM-call time. Known providers: `anthropic`, `openai`, `gemini`, `deepseek`.

```bash
relavium provider list                                  # registered providers + whether a key is set
relavium provider add anthropic                         # register a provider (its default base URL)
echo "$ANTHROPIC_API_KEY" | relavium provider set-key anthropic   # store a key (read from STDIN, never argv)
relavium provider test anthropic                        # verify the key with a minimal live request
relavium provider remove-key anthropic                  # delete the key from the keychain
```

- **`set-key` reads the key from stdin**, never a CLI argument (argv leaks into `ps`, shell history, and CI
  logs); pipe it or use a heredoc. The key is stored in the OS keychain under the canonical entry-naming
  scheme ([keychain-and-secrets.md](../desktop/keychain-and-secrets.md#entry-naming)).
- **`add` / `set-key`** auto-register the provider row. `--base-url <url>` on `add` records a custom endpoint (validated as an **HTTPS** URL); it is **not yet honored by request routing** — adapters use their built-in endpoints today. Wiring a custom base URL to outbound requests lands later **with** the full SSRF base-URL gate (HTTPS-only; private/loopback/metadata ranges blocked) per [security-review.md](../../standards/security-review.md), before any key is attached to it.
- **`test`** does a 1-token `generate` through `@relavium/llm`; `--model <id>` overrides the cheap default. A bad
  key fails cleanly (exit `2`) without echoing the key.
- **Key resolution** (used by `run` + `test`): **OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error**.
  The env var is the headless/CI source; the `secrets.enc` encrypted-file fallback is deferred past v1.0
  ([keychain-and-secrets.md](../desktop/keychain-and-secrets.md)). An unavailable keychain (locked / no Linux
  Secret Service) surfaces a clean error — never a silent plaintext fallback.

## Exit codes

CI relies on deterministic exit codes:

| Code | Meaning |
|------|---------|
| `0` | Workflow completed successfully |
| `1` | Workflow failed (a node errored and exhausted retries/fallbacks) |
| `2` | Invalid invocation (bad arguments, workflow not found, schema validation error) |
| `3` | Run paused at a human gate (CI/non-interactive mode) — resume with `relavium gate` |
| `4` | A chat session ended — via `/exit`, `/cancel` (or Ctrl-C in TTY mode), or an input-stream EOF — a user-initiated end of a `relavium chat` REPL — see [chat-session.md](chat-session.md) |

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
