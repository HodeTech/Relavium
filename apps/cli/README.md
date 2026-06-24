# relavium

> Run agent workflows from your terminal — a product of [HodeTech](https://github.com/HodeTech).

`relavium` is the command-line surface of the [Relavium](https://github.com/HodeTech/Relavium)
local-first AI agent platform. It runs git-committable `.relavium.yaml` workflows on the same
pure-TypeScript engine as the desktop and VS Code surfaces — every step debuggable, every token and
dollar tracked, nothing leaving your machine unless you choose it.

## Install

```bash
npm install -g relavium
```

Requires **Node.js ≥ 20.12**. The package ships an engine-inlined bundle and installs prebuilt native
binaries, so no C/C++ toolchain is needed.

## Quick start

```bash
# run a workflow, streaming live progress in the terminal
relavium run ./workflows/code-review.relavium.yaml --input file=./src/index.ts

# CI / scripting: a stable NDJSON RunEvent stream, deterministic exit codes
relavium run ./workflows/code-review.relavium.yaml --input file=src/index.ts --json

# store a provider key in the OS keychain (read from stdin, never argv)
echo "$ANTHROPIC_API_KEY" | relavium provider set-key anthropic
```

## Commands

| Command | Purpose |
|---|---|
| `relavium run <workflow> [--input k=v]` | Execute a workflow; streams progress (or `--json` NDJSON). |
| `relavium list [--agents]` | List discovered workflows (or agents) with last-run status. |
| `relavium logs <runId>` | Replay a past run's event stream. |
| `relavium status` | Show active/paused runs and their per-node status. |
| `relavium gate <runId> --approve\|--reject\|--input …` | Resolve a pending human gate. |
| `relavium gate list [<runId>]` | List pending human gates. |
| `relavium provider <list\|add\|set-key\|remove-key\|test>` | Manage providers + API keys (OS keychain). |

**Exit codes** (CI-friendly): `0` completed · `1` failed · `2` invalid invocation · `3` paused at a
human gate. Provider keys resolve from the OS keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error.

## Documentation

The full command reference, the `--json` machine contract, and the CI guide live in the
[Relavium docs](https://github.com/HodeTech/Relavium/tree/main/docs/reference/cli/commands.md).

## License

Proprietary — © HodeTech, all rights reserved. See [LICENSE](./LICENSE).
