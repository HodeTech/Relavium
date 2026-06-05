# Configuration Specification

- **Status**: Stable
- **Scope**: Where Relavium reads configuration from, and how global and per-project settings are merged.
- **Related**: [workflow-yaml-spec.md](workflow-yaml-spec.md), [agent-yaml-spec.md](agent-yaml-spec.md), [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md), [../cli/commands.md](../cli/commands.md), [../../architecture/local-first-and-security.md](../../architecture/local-first-and-security.md)

Relavium uses a two-level configuration model that mirrors VS Code's **user vs. workspace** split: a **global** config in the user's home directory, and a **per-project** config committed alongside the code. The per-project layer overrides the global layer. A directory the user opens *is* the workspace — there is no separate "project" concept; the filesystem directory is the unit of organization, which makes git integration trivial.

## Locations

### Global — `~/.relavium/`

Created on first launch. Holds user-wide preferences and the registry of MCP servers.

```
~/.relavium/
  config.toml        # global preferences, MCP server registrations, update channel
  ipc.json           # desktop loopback server discovery (port, authToken, pid) — see ipc-contract.md
  history.db         # cross-project run history (SQLite, encrypted at rest) — see desktop/database-schema.md
  secrets.enc        # OPTIONAL encrypted-file key fallback (headless/CI) — see keychain-and-secrets.md
  tmp/               # scratch space agents may write to under the sandbox tier
```

> API keys are **not** stored in `config.toml`. By default they live in the OS keychain; `secrets.enc` is an opt-in fallback only. See [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md).

### Per-project — `<projectRoot>/.relavium/`

Committed to git (minus secrets) so a team shares the same workflows and agents.

```
<projectRoot>/.relavium/
  project.toml                       # project-level defaults and overrides
  workspace.toml                     # OPTIONAL shared variables (default model, shared tool configs)
  workflows/*.relavium.yaml          # workflow definitions
  agents/*.agent.yaml                # agent definitions
  runs.db                            # OPTIONAL project run metadata (summaries only, no event logs)
  .relaviumignore                    # which .relavium/ files git should ignore (e.g. secrets, runs.db)
```

Opening a workspace loads every `*.relavium.yaml` and `*.agent.yaml` under `<projectRoot>/.relavium/`. An optional `workspace.toml` can declare shared variables (default model, shared tool configs) inherited by all workflows in that workspace.

## Resolution order

For any single setting, the **last writer wins**, evaluated in this order:

```mermaid
flowchart LR
  G["~/.relavium/config.toml\n(global)"] --> W["<projectRoot>/.relavium/workspace.toml\n(workspace)"]
  W --> P["<projectRoot>/.relavium/project.toml\n(project)"]
  P --> CLI["CLI flag / env var\n(per-invocation)"]
```

1. **Global** (`~/.relavium/config.toml`) — lowest precedence; user defaults.
2. **Workspace** (`workspace.toml`) — shared, committed variables for everything in the directory.
3. **Project** (`project.toml`) — project-specific overrides.
4. **Per-invocation** — a CLI flag or environment variable for a single run; highest precedence. See [../cli/commands.md](../cli/commands.md).

MCP server registrations follow the same merge: globally registered servers (`config.toml`) plus any project-scoped servers. See [../shared-core/mcp-integration.md](../shared-core/mcp-integration.md).

## `config.toml` (global) — keys

```toml
update_channel = "stable"          # stable | beta

[preferences]
default_model = "claude-sonnet-4-6"
theme = "dark"

[[mcp_servers]]                    # repeatable
name = "filesystem"
transport = "stdio"                # stdio | http
command = "npx -y @modelcontextprotocol/server-filesystem"
args = ["--root", "~/projects"]
autostart = true
# url = "http://localhost:4000"    # for transport = http
# env = { TOKEN = "..." }
```

## `project.toml` / `workspace.toml` (project) — keys

```toml
[defaults]
model = "claude-sonnet-4-6"        # default model for agents that omit one
fs_scope = "sandboxed"             # sandboxed | project | full (see filesystem tiers)

[variables]                        # available to all workflows in this workspace
focus_area = "security and type safety"

[chat]                             # agent-session (chat-mode) defaults — see contracts/agent-session-spec.md
default_model = "claude-sonnet-4-6"   # model for a chat session that names none
fs_scope = "sandboxed"             # SAME tier enum as [defaults].fs_scope above (not re-listed here)
max_messages = 200                 # session-history cap before older turns are trimmed/summarized
```

> The `[chat]` block sets defaults for the **agent-first** chat entry point
> ([agent-session-spec.md](agent-session-spec.md), [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)),
> distinct from `[defaults]` (which governs **workflow** runs). It does **not** define its own command
> allowlist: a chat session reuses the workflow `allowedCommands` policy whose canonical home is
> [workflow-yaml-spec.md](workflow-yaml-spec.md#tool-policy-spectools) (empty/absent ⇒ `run_command`
> disabled). Session history persists in the existing `history.db` — there is no separate `sessions.db`.

## Secrets are out of band

No config file contains plaintext secrets. Keys resolve at call time from:

- **Desktop** — OS keychain (`tauri-plugin-keychain`), with an optional `secrets.enc` fallback.
- **CLI** — OS keychain via `@napi-rs/keyring` (not the archived `keytar`; see [ADR-0019](../../decisions/0019-cli-node-keychain-library.md)).
- **VS Code** — `vscode.SecretStorage`.

Non-key secrets (e.g. an MCP server's `GITHUB_TOKEN`) are stored the same way and referenced
from workflow/agent/MCP-server fields by name with **`{{secrets.<name>}}`** interpolation,
resolved from the store at run time — never written into the workflow file, a checkpoint, or
any event payload (see [../shared-core/mcp-integration.md](../shared-core/mcp-integration.md)
and the masking rule in [sse-event-schema.md](sse-event-schema.md)).

This is covered in full in [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md) and [../../architecture/local-first-and-security.md](../../architecture/local-first-and-security.md).

## Schema versioning

The workflow and agent files inside `.relavium/` carry their own `schema_version` (see [workflow-yaml-spec.md](workflow-yaml-spec.md)). Because the entire `.relavium/` directory is committed and shared, both the config files and the workflow/agent files are treated as stable, versioned, public formats — breaking changes require a migration path, never a silent reinterpretation of existing keys.
