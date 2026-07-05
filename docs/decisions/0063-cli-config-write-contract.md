# ADR-0063: CLI config-write contract — the first on-disk config writer, the global `[preferences].default_model` target, and the `resolveChat` global fallback

- **Status**: Accepted
- **Date**: 2026-07-05
- **Related**: [ADR-0048](0048-toml-config-parser.md) (`smol-toml`, confined to the CLI config loader — this ADR extends its use to the *writer*, same package boundary, no new dependency; **append-only top-note added there**) · [ADR-0033](0033-strict-config-files-amends-0023.md) (strict config — the written file must re-parse under `.strict()`) · [ADR-0023](0023-strict-authored-yaml-validation.md) · [ADR-0024](0024-agent-first-entry-point-agentsession.md) (the `[chat]` block + one-model-per-session) · [ADR-0006](0006-os-keychain-for-api-keys.md) (secrets live only in the keychain — never config) · [ADR-0049](0049-cli-machine-output-contract.md) (the write is a TTY-interactive action) · [ADR-0064](0064-live-model-catalog.md) + [ADR-0065](0065-provider-economics-and-extensibility.md) (the `/models` picker + onboarding wizard that drive this write). The config keys + resolution order are the canonical [config-spec.md](../reference/contracts/config-spec.md); the schemas live in [config.ts](../../packages/shared/src/config.ts).

## Context

The CLI config layer is **read-only**. [load.ts](../../apps/cli/src/config/load.ts) imports `smol-toml`
for `parse` only ([ADR-0048](0048-toml-config-parser.md) scoped it to "string → plain data"); no code
anywhere writes `config.toml` / `project.toml` / `workspace.toml`. Phase 2.5.G introduces the first need
to **persist** a user choice: the `/models` picker (Home) and the onboarding wizard
([ADR-0064](0064-live-model-catalog.md)) must set the model the next chat session binds, and the roadmap
names that target as `[chat].default_model`.

Two facts make the naive reading wrong, and are the reason this needs a recorded decision:

1. **`[chat]` is project/workspace-scoped only.** `resolveChat` ([resolve.ts](../../apps/cli/src/config/resolve.ts) L113)
   reads `[chat].default_model` from `project.toml`/`workspace.toml` and has **no global layer**; the bare
   Home ([ADR-0054](0054-cli-bare-invocation-interactive-home.md)) is frequently run **outside any project**,
   so there is no `[chat]` file to write. Meanwhile `GlobalConfigSchema.preferences.default_model`
   ([config.ts](../../packages/shared/src/config.ts) L138) already exists but today feeds only
   `resolveConfig.defaultModel` (the **workflow** default, resolve.ts L83) — chat ignores it.

2. **A config write is a read-modify-write of a hand-authored, git-committed, `.strict()`-validated TOML**
   ([ADR-0033](0033-strict-config-files-amends-0023.md)) that may hold cost caps, MCP registrations, and the
   `!`-shell allowlist. The failure modes are load-bearing: a **torn file** on a crash loses the user's whole
   config; a **secret** written into config violates the rule-6 non-negotiable ([ADR-0006](0006-os-keychain-for-api-keys.md));
   an **invalid** emission fails the next load (`ConfigError`, exit 2), locking the user out of their own config.

The stakes of getting this wrong are high precisely because it is the *first* writer — every later writer
(cost caps, provider settings) will inherit whatever primitive lands here.

## Decision

**We add a single, minimal, atomic, secret-incapable config-write primitive confined to
[apps/cli/src/config](../../apps/cli/src/config) (the sibling of `load.ts`), used to write the global
`~/.relavium/config.toml` only; `/models` and the wizard write `[preferences].default_model`, and
`resolveChat` gains a lowest-precedence global fallback layer to it.** No new dependency: `smol-toml`
([ADR-0048](0048-toml-config-parser.md)) already exports `stringify`.

### 1. Write target — global `[preferences].default_model`, plus a `resolveChat` global fallback

`/models` (and the wizard's default-model step) write **`[preferences].default_model`** in the always-present
global `~/.relavium/config.toml`, and `resolveChat` ([resolve.ts](../../apps/cli/src/config/resolve.ts) L113)
gains a **third, lowest-precedence layer**: `project.chat.default_model ?? workspace.chat.default_model ??
global.preferences.default_model`. This mirrors the global fallback the workflow path **already** has
(`resolveConfig.defaultModel`, resolve.ts L83), unifying the meaning of `[preferences].default_model` to
"my preferred model everywhere" while a project's `[chat]`/`[defaults]` still override per-context.

- **Considered — a new global `[chat]` block** (add `chat.default_model` to `GlobalConfigSchema`): rejected
  for 2.5.G as a larger `@relavium/shared` schema change + drift-pin, for the same end effect; the
  `[preferences]` fallback reuses an existing field.
- **Considered — write project `[chat]`, creating `.relavium/` in cwd when absent**: rejected — it drops a
  surprising, possibly git-committed `.relavium/` artifact into an unrelated directory and makes a
  project-less *global* preference impossible.
- **Behaviour change, disclosed:** an existing `[preferences].default_model` (today workflow-only) now also
  becomes the chat default when no project/workspace `[chat].default_model` overrides it. Chat previously
  had no global default at all (it fell to `DEFAULT_CHAT_MODEL`), so this is an additive, arguably-correcting
  change — a user's stated preferred model now applies to chat too — recorded here, not silent.

### 2. Mechanism — parse → set → re-validate → atomic `stringify` write

The writer reads the existing `~/.relavium/config.toml` (or an empty object when absent), sets the single
target key on the parsed object, **re-validates the whole object against `GlobalConfigSchema`**
([ADR-0033](0033-strict-config-files-amends-0023.md)) so the emission is provably schema-valid, `stringify`s
it, and writes **atomically**: a temp file created **`0600`** (owner-only) in the owner-only (`0700`)
`~/.relavium/` directory → `fsync` → `rename` over the target — the same at-rest posture the `history.db`
write uses ([ADR-0050](0050-cli-history-db-at-rest-posture.md); the `0700` dir mode is set by
`ensureGlobalConfigDir`, [paths.ts](../../apps/cli/src/config/paths.ts) L28). Note that
`ensureGlobalConfigDir` sets `0700` on `~/.relavium/` itself, **not** on its `tmp/` subdir, so the writer sets
the temp file's `0600` mode **explicitly** rather than relying on an inherited directory mode — an
implementation prerequisite. An interrupted write leaves the original file intact.

> **Comment/formatting loss is accepted for v1, and bounded.** `smol-toml.stringify` re-serializes the parsed
> object and **drops comments and key ordering**. We accept this for the **global** `config.toml` (the only
> file this writer touches): it is a small, largely tool-managed settings file, not the heavily-annotated
> *project* workflow config, and correctness (a guaranteed-valid, atomic, never-torn re-emission) outranks
> comment fidelity for the first writer. A **surgical, comment-preserving single-key editor** is named as a
> future refinement — it would be required before this primitive is ever pointed at a hand-curated
> `project.toml`. The write is confined to the **global** file precisely so that boundary is explicit.

### 3. Secret-free by construction

The writer only ever sets **schema-valid, non-secret** keys (here `default_model`) on a `GlobalConfigSchema`
object, then serializes that validated object. The writer only ever sets `default_model` (a non-secret) — there is **no
API-key field** in the config schema to write to, and API keys live only in the OS keychain
([ADR-0006](0006-os-keychain-for-api-keys.md)). The loader already rejects `api_key`-like keys
([load.ts](../../apps/cli/src/config/load.ts)); the writer's secret-free property is asserted directly in tests
(the config-write security review). A caller can never hand the
writer a free-form key/value — the surface is a typed setter (`setDefaultModel`), not a generic `writeKey`.

### 4. Interactive-only, like every other Home mutation

The `/models`-driven write is reached only through a TTY-interactive picker/wizard; it is never triggered
under `--json`/plain ([ADR-0049](0049-cli-machine-output-contract.md)), consistent with `/clear`
([ADR-0062](0062-context-compaction-and-cli-history-commands.md) §7). The primitive itself is surface-agnostic
and unit-tested with an injected home dir + fs, no TTY.

## Consequences

### Positive

- **A user's model choice persists** — `/models` and the wizard set a durable default the next session binds;
  `[preferences].default_model` becomes a coherent "preferred model everywhere" with per-project override intact.
- **No new dependency** — reuses `smol-toml.stringify` already present under [ADR-0048](0048-toml-config-parser.md);
  this is a pure contract decision, confined to the same `apps/cli` config boundary.
- **Safe by construction** — atomic `0600` temp+rename (never a torn config), re-validated against the strict
  schema before emission (never an unloadable file), and structurally secret-free (no key can reach disk).
- **A clean foundation** — the typed single-key setter is the primitive every later settings-writer reuses,
  rather than each command hand-rolling a TOML write.

### Negative

- **Comment/ordering loss on the global `config.toml`** — accepted and documented (§2); mitigated by atomicity
  and confinement to the global file; a comment-preserving surgical editor is named future work and is a
  prerequisite before writing any hand-curated `project.toml`.
- **A disclosed behaviour change** — an existing `[preferences].default_model` now also drives the chat default
  (§1); additive and arguably-correcting, but a change to document in `config-spec.md`.
- **First-writer surface area** — a new on-disk mutation path that must be security-reviewed (a dedicated
  security round: secret-free + atomicity + path handling) before it ships; its blast radius is deliberately
  minimized to one global file and one typed key.
- **Roadmap reconciliation** — the phase-2.5 §2.5.G text named `[chat].default_model` as the write target; this
  ADR refines that to global `[preferences].default_model` + a chat fallback layer. The phase-2.5 §2.5.G text is
  **already reconciled in this doc round**; the remaining `config-spec.md` update (the config-write contract +
  the `[preferences].default_model` chat fallback) lands in the implementing PR.
