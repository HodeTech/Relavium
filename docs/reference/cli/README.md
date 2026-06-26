# Reference — CLI

Specs for the `relavium` command-line tool — the surface for CI/CD pipelines,
scripting, and power users. Built with commander.js + ink, it exposes both engine
entry points on **one** `packages/core` engine: `relavium chat` (the agent-first
session REPL) and `relavium run` (the workflow runner) — identical to every other
surface.

Part of [reference/](../README.md).

| File | Reference |
|------|-----------|
| [commands.md](commands.md) | The full `relavium` command surface (run, chat, chat-resume/list/export, agent run, list, create, import, export, logs, gate, init, provider) plus interactive TUI vs CI JSON mode. |
| [chat-session.md](chat-session.md) | The `relavium chat` agent-session REPL — entry, agent/model selection, the multi-turn loop, streaming, tool availability, the `--json` session-event stream, and exit code 4. |
| [agent-run-fixture.md](agent-run-fixture.md) | The `relavium agent run --fixture` cassette format — a `StreamChunk[][]` JSON recording of an agent run's LLM stream, for deterministic offline replay. |
