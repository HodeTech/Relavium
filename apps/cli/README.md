# relavium

![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.12-339933?logo=nodedotjs&logoColor=white)
![Local-first](https://img.shields.io/badge/local--first-BYOK-0aa)
![License](https://img.shields.io/badge/license-proprietary-555)

> **Start as an agent. Ship the workflow. Own every run.**

`relavium` is the command-line surface of **[Relavium](https://github.com/HodeTech/Relavium)** — a
local-first, multi-model AI agent platform from **[HodeTech](https://github.com/HodeTech)**. Begin in a
conversational **agent session** in your terminal, graduate it into a git-committable, multi-agent
`.relavium.yaml` **workflow**, and run it anywhere — all on the same pure-TypeScript engine that powers
the Relavium desktop and VS Code surfaces. Every step is debuggable, every token and dollar tracked, and
nothing leaves your machine unless you choose it.

## Install

```bash
npm install -g relavium
```

Requires **Node.js ≥ 20.12**. The package is an engine-inlined bundle that installs prebuilt native
binaries — no C/C++ toolchain, no Python sidecar.

## Quick start

```bash
# 1 · Point Relavium at a provider — your key goes to the OS keychain, never a file or argv
relavium provider add anthropic
echo "$ANTHROPIC_API_KEY" | relavium provider set-key anthropic

# 2 · Start as an agent — a streaming, multi-turn session in your terminal
relavium chat
#     …converse until a flow proves itself, then run /export inside the REPL
#     to ship the session to a git-committable .relavium.yaml

# 3 · Own every run — execute the workflow, streaming live (or --json for CI)
relavium run ./my-workflow.relavium.yaml --input file=./src/index.ts
relavium run ./my-workflow.relavium.yaml --json
```

Prefer authoring directly? `relavium create` scaffolds an agent or a minimal single-agent workflow from
an interactive wizard.

## Why relavium

- **One engine, every surface.** The terminal, desktop, and VS Code run the _identical_ engine — a
  workflow behaves the same on your laptop and in CI.
- **A chat-to-workflow continuum.** Sessions are persistent and resumable; one command — `/export` —
  turns a proven conversation into a reviewed, committed workflow.
- **Multi-model with fallback chains.** Route across Anthropic, OpenAI / DeepSeek, and Gemini behind one
  seam; a run survives a provider outage by failing over (`[claude → gpt-4o → gemini]`).
- **Local-first, keys in your OS keychain.** BYOK, no account, no telemetry — keys never touch a file, a
  log, an argv, or `--json` output.
- **Live _and_ scriptable.** A rich streaming TUI on a TTY; a stable NDJSON `RunEvent` stream with
  deterministic exit codes under `--json` for CI.
- **Extensible and multimodal.** Agents consume external **MCP** tools (stdio + `http` / `sse` /
  `websocket`, behind an SSRF floor); image / audio / video flow through as both input and output.

## Commands

#### Agent sessions

| Command                                       | Purpose                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `relavium chat [--agent <ref>]`               | Start an interactive multi-turn agent session (the REPL).   |
| `relavium chat-resume <sessionId>`            | Reload and continue a persisted session.                    |
| `relavium chat-list`                          | List past sessions (id, agent, last activity).              |
| `relavium chat-export <sessionId>`            | Export a session to a `.relavium.yaml` workflow scaffold.   |
| `relavium agent run <agent> [--fixture <p>]`  | Run a single agent one-shot, non-interactively (CI-ready).  |

#### Workflows & authoring

| Command                              | Purpose                                                            |
| ------------------------------------ | ----------------------------------------------------------------- |
| `relavium run <workflow> [--input k=v]` | Execute a workflow — live TUI, or `--json` NDJSON for CI.       |
| `relavium create`                    | Scaffold a new agent or a minimal workflow from a wizard.         |
| `relavium import <path>`             | Import an external `.relavium.yaml` / `.agent.yaml` into the project. |
| `relavium export <id>`               | Write a portable, share-safe copy (no secret material).           |

#### History & human gates

| Command                                              | Purpose                                              |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `relavium list [--agents]`                           | List discovered workflows (or agents) + last-run status. |
| `relavium logs <runId>`                              | Replay a past run's event stream (raw under `--json`). |
| `relavium status`                                    | Show active / paused runs and their per-node status. |
| `relavium gate <runId> --approve\|--reject\|--input …` | Resolve a pending human gate.                       |
| `relavium gate list [<runId>]`                       | List pending human gates across runs.                |

#### Providers & keys

| Command                          | Purpose                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `relavium provider list`         | Registered providers and whether a key is set.             |
| `relavium provider add <id>`     | Register a provider.                                        |
| `relavium provider set-key <id>` | Store a key in the OS keychain (read from **stdin**).       |
| `relavium provider remove-key <id>` | Delete a key from the keychain.                          |
| `relavium provider test <id>`    | Verify a key with a minimal live request.                  |

The global flags `--json`, `--cwd`, `--config`, and `--no-color` apply throughout. Run `relavium --help`
or `relavium <command> --help` for the full surface.

## Exit codes

Deterministic, for CI:

| Code | Meaning                                                                |
| ---- | --------------------------------------------------------------------- |
| `0`  | Completed successfully                                                 |
| `1`  | Workflow failed (a node errored and exhausted retries / fallbacks)     |
| `2`  | Invalid invocation (bad arguments, not found, schema error)            |
| `3`  | Run paused at a human gate (non-interactive) — resume with `relavium gate` |
| `4`  | A `relavium chat` session ended (`/exit`, `/cancel`, or input EOF)     |

Under `--json`, stdout stays a pure NDJSON `RunEvent` stream and all diagnostics go to stderr.

## Keys & configuration

Provider keys resolve **OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error** — no plaintext
fallback, and only a 4-character hint is ever displayed. Configuration layers from `~/.relavium/`
(global) and a project `.relavium/`, with CLI flags and env vars overriding. Run history persists locally
to `~/.relavium/history.db`.

## Documentation

The full command reference, the `--json` machine-output contract, and the CI guide live in the Relavium
docs: **[docs/reference/cli/commands.md](https://github.com/HodeTech/Relavium/blob/main/docs/reference/cli/commands.md)**.

## License

Proprietary — © HodeTech, all rights reserved. Not open source; no rights are granted except as expressly
stated. See **[LICENSE](https://github.com/HodeTech/Relavium/blob/main/LICENSE)**.
