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
| **Interactive TUI** | TTY attached (developer terminal) | `ink`-rendered live view: animated per-node status, streaming token output for the active node, final cost/duration summary |
| **CI / non-interactive** | No TTY, `--json`, or `CI=true` | Line-buffered, machine-readable output; `--json` emits one [RunEvent](../contracts/sse-event-schema.md) JSON object per line (NDJSON) for piping into other tools |

Exit codes are CI-friendly (see [Exit codes](#exit-codes)).

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

- `--input k=v` (repeatable) supplies typed workflow inputs (see the `inputs` block in [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)).
- `--json` switches to NDJSON [RunEvent](../contracts/sse-event-schema.md) output.
- On a `human_gate` node the run **pauses**: in interactive mode it prompts inline; in CI mode it exits with the gate-paused code (`3`, see [Exit codes](#exit-codes)) and can be resumed with `relavium gate`. The emitted `human_gate:paused` event carries the `gateId` needed for the resume (`relavium gate <runId> --gate <gateId>`); with `--json` it is on the NDJSON event line, otherwise read it from `relavium status`/`relavium logs`.

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

> Exit code `3` lets CI distinguish a pause-for-approval (a `human_gate:paused` event in non-interactive mode) from a hard failure. This is the canonical home for the gate-paused code; other docs reference it as `3`.
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
