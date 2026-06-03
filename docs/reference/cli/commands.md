# CLI Command Reference (`relavium`)

> Last updated: 2026-06-03

- **Status**: Reference (partial — surface defined, exact flags to be finalized as the CLI is built)
- **Surface**: CLI (`relavium`)
- **Scope**: Phase 1, local-first. Same `@relavium/core` engine as every other surface.
- **Related**: [../vscode/extension-api.md](../vscode/extension-api.md), [../desktop/routes-and-screens.md](../desktop/routes-and-screens.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../../tutorials/cli/run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md), [../../runbooks/add-a-provider-key.md](../../runbooks/add-a-provider-key.md)

The `relavium` CLI is the terminal surface of the platform and the fastest way to run a workflow non-interactively (scripts, CI/CD). It embeds the **same** `@relavium/core` engine as the desktop app and VS Code extension — there is no separate "CLI engine," so behavior is identical across surfaces (see [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)). The CLi is built **second** (right after the engine) and serves as the engine's canonical integration-test harness.

## Install & distribution

- **Package**: published to npm as `relavium`, installed globally.
- **Build**: TypeScript bundled with `tsup` to a single ESM bundle.
- **Stack**: `commander.js` for argument parsing, `ink` (React for terminals) for the interactive TUI, `@clack/prompts` for setup wizards.
- **API keys**: stored in the OS keychain via `keytar` (macOS Keychain / Windows Credential Manager / Linux libsecret) — never plaintext (see [add-a-provider-key.md](../../runbooks/add-a-provider-key.md)).
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
| `relavium list` | List discovered workflows (and, with a flag, agents) in the current project. |
| `relavium create` | Scaffold a new workflow or agent YAML via an interactive wizard. |
| `relavium import <path>` | Import an external `.relavium.yaml` / `.agent.yaml` into the project. |
| `relavium export <id>` | Export a workflow/agent to a portable YAML file (secret references stripped). |
| `relavium logs <runId>` | Print the persisted event/log stream for a past run. |
| `relavium status` | Show active runs and their per-node status. |
| `relavium gate <runId>` | Resolve a pending human gate (approve / reject / provide input). |
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
- On a `human_gate` node the run **pauses**: in interactive mode it prompts inline; in CI mode it exits with the gate-paused code (`3`, see [Exit codes](#exit-codes)) and can be resumed with `relavium gate`.

### `relavium list`

Lists workflows discovered under `.relavium/`, grouped by tag, with last-run status. A flag extends it to list agents.

### `relavium create`

Interactive scaffolder (`@clack/prompts`) that writes a new `.relavium.yaml` or `.agent.yaml` from answers (name, model, system prompt, tools). The result is a plain YAML file ready to commit.

### `relavium import` / `relavium export`

`import` brings an external YAML into the project's `.relavium/`. `export` writes a portable copy with all secret references stripped/placeholdered (see [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md)) — safe to share via PR. This is the "workflow file is the invite" distribution mechanism.

### `relavium logs`

Prints the persisted event/log stream for a past run (the same data the desktop run-detail screen replays). Accepts a flag to emit raw [RunEvent](../contracts/sse-event-schema.md) JSON.

### `relavium status`

Shows currently active runs and their per-node status. Useful while a long workflow runs in another terminal or was launched detached.

### `relavium gate`

Resolves a pending human gate from the terminal — the surface-agnostic resume path for [`human_gate:paused`](../contracts/sse-event-schema.md):

```bash
relavium gate <runId> --approve
relavium gate <runId> --reject --comment "Too risky"
relavium gate <runId> --input '{"api_key": "..."}'   # for gate_type=input
```

## Exit codes

CI relies on deterministic exit codes:

| Code | Meaning |
|------|---------|
| `0` | Workflow completed successfully |
| `1` | Workflow failed (a node errored and exhausted retries/fallbacks) |
| `2` | Invalid invocation (bad arguments, workflow not found, schema validation error) |
| `3` | Run paused at a human gate (CI/non-interactive mode) — resume with `relavium gate` |

> Exit code `3` lets CI distinguish a pause-for-approval (a `human_gate:paused` event in non-interactive mode) from a hard failure. This is the canonical home for the gate-paused code; other docs reference it as `3`.

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
