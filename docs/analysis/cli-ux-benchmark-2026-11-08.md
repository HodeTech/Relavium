# Terminal CLI UX design notes — 2026-11-08

- **Status**: Historical research conclusions; not a runtime contract.
- **Editorial revision**: 2026-11-15, at the maintainer's request. External product comparisons and names are removed; Relavium requirements and the dated internal reach inventory are retained.
- **Related**: [ADR-0122](../decisions/0122-the-home-is-the-interactive-product.md), [ADR-0114](../decisions/0114-in-house-markdown-rendering-for-the-chat-transcript.md), [MVP-2 plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-plan--home-first-2026-11-08)

## Purpose and evidence boundary

The maintainer's 2026-11-08 direction makes the Home the interactive product.
Users should be able to start with `relavium` and discover routine tasks inside
it, while subcommands preserve scripting contracts. These notes retain the
resulting usability requirements, not an external implementation or security
comparison. The inventory below describes source `0ef53496` on its stated date;
it is not the current implementation status. Use the [current roadmap](../roadmap/current.md)
and canonical [CLI contracts](../reference/cli/README.md) for that.

## Retained design requirements

- Keep onboarding, provider setup, sessions and model controls discoverable in
  the interactive surface. Missing credentials should lead to a bounded native
  setup flow. Show credential provenance without silently adopting an external
  secret or exposing its value.
- Preserve inline operation, copy, scrollback, transcript access and terminal
  restoration. Full-screen rendering has to supply the affordances it replaces;
  terminal probes must be bounded and cancellation must leave no live producer.
- Scope session discovery to the current directory by default, with an explicit
  way to widen it. Search, title, age and directory should make the selected
  session clear. Bound transcript restoration and print a usable resume command.
- Render markdown tables only from sufficiently complete structure. Clamp
  untrusted terminal content and retain usable layouts at the supported minimum
  size. Huge histories need viewport and memory bounds, not full-history paint.
- Derive tool status from actual outcomes. Distinguish success, error, denial,
  cancellation and not-run; preserve bounded target details and expose approval
  consequences before dispatch. A visible UI tool row is distinct from evidence
  carried into the next model request.
- Palettes should show descriptions and argument hints, preserve the draft and
  explain unavailable actions. Never execute an unrelated closest match for a
  misspelled command. Credentials must never enter ordinary prompt history.
- Maintain one cancellation/approval keymap. An interruption key never approves;
  a second-stage exit must first join producers. Queued input must remain visible
  and must not accidentally become an approval response.
- Keep project initialization and instruction generation distinct. Show planned
  writes before publication and respect the existing milestone/ADR gates.
- Remembered permissions belong to the operator and project identity. A
  subprocess has ambient authority distinct from file-tool path checks; command
  runner availability does not imply shell syntax or OS sandboxing.

These requirements informed the linked decisions. They do not advance later
milestones or retrospectively establish current test acceptance.

## Appendix — Relavium's Home reach on 2026-11-08

What a bare `relavium` can do for each leaf subcommand at `0ef53496`, from the internal analysis. "Partly" means the
Home covers part of the task (for example, it lists recent runs but cannot open one).

| Subcommand | Task | In the Home today | Planned in-TUI form |
|---|---|---|---|
| `run <workflow>` | Run a workflow and watch it | No | Hub milestone (run-hosting ADR) |
| `chat` | Chat with an agent | Yes, default agent only; `--agent` not reachable | `/agents` (hub milestone) |
| `chat resume <id>` | Continue a session | No | `/resume`, actionable rows (MVP-2) |
| `chat list` | Find a session | Partly: eight recent sessions, read-only | `/resume` picker (MVP-2) |
| `chat export <id>` | Turn a session into a workflow | Partly: `/export` of the live session | Session actions (hub milestone) |
| `create` | Scaffold an agent or workflow | No | `/create` (MVP-6) |
| `export <id>` | Copy a workflow or agent as YAML | No | `/workflows` actions (hub milestone) |
| `import <path>` | Bring in a YAML file | No | Not yet planned |
| `agent run <agent>` | One-shot from stdin | No, by design | Stays shell-only |
| `gate <runId>` | Answer a human gate | No: shown under Attention only | Gate card (hub milestone) |
| `gate list` | See pending gates | Partly: Attention lists them | Actionable rows (hub milestone) |
| `budget resume` | Approve a budget gate | No | Budget card (hub milestone) |
| `models` | Pick a model | Yes: `/models` | Done |
| `models refresh` | Refresh the catalog | Yes: inside `/models` | Done |
| `models pricing` | Enter a model's price | No | Not yet planned |
| `provider list` | See providers and keys | Partly: `/doctor` | `/providers` (MVP-2) |
| `provider add` | Register a custom provider | No | `/providers` (MVP-9) |
| `provider set-key` | Store a key | Partly: first-run wizard only | `/providers` (MVP-2) |
| `provider remove-key` | Delete a key | No | `/providers` (MVP-9) |
| `provider test` | Check a key | Partly: `/doctor --deep` in a chat | `/providers` (MVP-9) |
| `media prune-temporaries` | Maintenance | No, by design | Stays shell-only |
| `list` | List workflows and runs | Partly: recent runs | `/workflows` (hub milestone) |
| `logs <runId>` | Read a run's events | No | Run detail (hub milestone) |
| `status [runId]` | Read run status | Partly: Attention and Continue | Run detail (hub milestone) |
| `init` | Create `.relavium/` | No (not implemented) | `/init` (MVP-2) |
