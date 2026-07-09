# ADR-0047: CLI framework — `commander` + `ink` + `@clack/prompts`, confined to `apps/cli`

- **Status**: Accepted
- **Date**: 2026-06-22
- **Related**: [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md), [ADR-0011](0011-internal-llm-abstraction.md), [ADR-0019](0019-cli-node-keychain-library.md), [ADR-0035](0035-yaml-parser-dependency.md), [phase-2-cli.md](../roadmap/phases/phase-2-cli.md), [cli/commands.md](../reference/cli/commands.md), [architectural-principles.md](../standards/architectural-principles.md), [tech-stack.md](../tech-stack.md), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) (refines: `ink` 6→7)

> **Amended 2026-07-09 ([ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md)):** `ink`'s major is bumped **6 → 7** for the 2.6.F full-screen renderer (its native `alternateScreen` / `useWindowSize` / `usePaste`), gated on the Node `>=22` floor ([ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md)). `ink` **remains** the TUI framework and the confinement / framework-free-core discipline below is unchanged — [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) **refines**, it does not reverse, this decision. The `@clack/prompts` bracketed-paste role is likewise unchanged; the Home's hand-rolled paste migrates to `ink` 7's native `usePaste` per [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md).

## Context

Build phase 2 ships the `relavium` CLI (`apps/cli`) — the **first real consumer** of
the engine and its regression harness ([phase-2-cli.md](../roadmap/phases/phase-2-cli.md)).
The CLI needs three UX capabilities, each first used by a different workstream:

1. **Command + argument parsing** — the subcommand surface and the exit-code map (`0`–`4`)
   whose canonical home is [cli/commands.md](../reference/cli/commands.md) (`run`, `list`,
   `create`, …), plus the global flag set (`--json` / `--no-color` / `--cwd` / `--config` /
   `--verbose` / `--quiet`) specified in [phase-2-cli.md §2.A](../roadmap/phases/phase-2-cli.md).
   (`commands.md` documents `--json` today; 2.A finalizes the remaining global flags into it,
   its canonical home.) Workstream **2.A**.
2. **An interactive TUI** that renders the live `RunEvent` stream (per-node status, the
   active node's token stream, a cost footer) — workstream **2.E**.
3. **Setup wizards** for `create` and the interactive human-gate prompt — workstreams
   **2.J / 2.G**.

[tech-stack.md](../tech-stack.md) (line: "CLI") already *names* the stack — TypeScript +
`commander.js` + `ink`, with `@clack/prompts` wizards, bundled to a single ESM bundle with
`tsup` — but no ADR records the choice. The **no-new-runtime-dependency-without-an-ADR**
rule (CLAUDE.md non-negotiable #2; [architectural-principles.md](../standards/architectural-principles.md) §9)
requires the decision be recorded **before** adoption, exactly as the engine's YAML loader
was ([ADR-0035](0035-yaml-parser-dependency.md)) and the CLI keychain library was
([ADR-0019](0019-cli-node-keychain-library.md)).

Two constraints shape the choice:

- **These are surface dependencies, not engine dependencies.** They live in `apps/cli`,
  which the engine-deps allowlist guard (`tools/engine-deps/check.mjs`) **deliberately does
  not police** (it covers the engine packages; apps are host-bound by design, like
  `@relavium/db`). So the deliberate gate for the CLI is *this ADR + code review* (surface
  deps are a lower bar than engine deps but still justified —
  [code-review.md](../standards/code-review.md)). The hard guarantee — **no CLI framework
  type may cross into `@relavium/core` / `@relavium/shared` / `@relavium/llm`** (the engine
  stays platform-free, [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md) / CLAUDE.md
  rule #5; the seam stays vendor-free, [ADR-0011](0011-internal-llm-abstraction.md)) — is in
  addition backstopped automatically: adding any of these to an engine package's manifest
  trips the engine-deps guard, and a phantom import with no manifest entry fails typecheck.
- **The command logic stays framework-free.** Each command's core is a plain module
  (parsed args in → typed result out) importing neither `commander` nor `ink`; the CLI
  layer is thin wiring around it. This is what makes the TUI and the `--json` path two
  *renderers over one core* (the anti-drift requirement in
  [phase-2-cli.md](../roadmap/phases/phase-2-cli.md) Risks) and lets every command be
  unit-tested without a TTY.

## Decision

**We adopt `commander` for command/argument parsing, `ink` (React-for-terminals) for the
interactive TUI, and `@clack/prompts` for setup wizards — all runtime-needed libraries of
`apps/cli` only, pinned through the pnpm `catalog:` (see [tech-stack.md](../tech-stack.md)
for versions). `tsup` bundles the CLI to a single ESM `bin`.**

- Each library is added to the catalog **at the workstream that first needs it** —
  `commander` at 2.A, `ink` at 2.E, `@clack/prompts` at 2.J/2.G — and **each addition is its
  own §9a cooling-window review** ([architectural-principles.md §9a](../standards/architectural-principles.md#9a-dependency-bump-cooling-window)),
  since each is a separate `package.json`/catalog change. `tsup` is a **build tool**
  (toolchain), catalogued like `turbo`/`vitest`/`drizzle-kit` with **no separate ADR**; this
  ADR covers only the three runtime libraries. **React** enters **transitively via `ink`**
  (ink's peer dependency) — its major is `ink`'s to satisfy and is pinned alongside `ink` in
  the catalog at 2.E, not as a direct Relavium dependency.
- **Confinement + bundling.** `commander` / `ink` / `@clack/prompts` (and React, via `ink`)
  are imported **only under `apps/cli/src`** and never by an engine package; the command
  cores are framework-free modules, `commander` lives in the thin entry/wiring layer, and
  `ink` / `@clack/prompts` only in the renderer/wizard layers — so the JSON renderer (2.F)
  shares the command core with the TUI rather than forking it. These pure-JS libraries are
  **inlined by `tsup`** into the single published ESM bundle (so they may sit in
  `devDependencies` of the shipped manifest); the **native** CLI dependency
  (`@napi-rs/keyring`, 2.C — [ADR-0019](0019-cli-node-keychain-library.md)) is the exception
  that stays **external** in `dependencies` and is `tsup`-externalized. The exact
  inline-vs-external set is finalized in packaging (2.L); either placement is still a
  `package.json` change a reviewer sees and the §9a window covers.

Considered alternatives:

- **`oclif`** (rejected) — a full plugin-based CLI *framework* with its own project layout,
  command-discovery, and update tooling. It imposes structure the engine-proving CLI does not
  need and is heavier than a thin `commander` program over framework-free cores; it would also
  fight the "command core is a plain module" discipline.
- **`yargs` / `citty` / raw `process.argv`** (rejected) — `yargs` is viable but heavier and
  less ergonomically typed than `commander`; `citty` is younger with a smaller ecosystem; raw
  `process.argv` reinvents parsing/help/validation for no benefit. `commander` is the
  most widely-used, stable, well-typed, zero-ceremony option and maps cleanly onto the
  documented subcommand surface.
- **`blessed` / raw ANSI for the TUI** (rejected) — `ink` brings a React component model to
  the terminal, which matches the team's React skillset and the desktop UI mental model
  (`packages/ui`), and renders the high-frequency `agent:token` stream with a declarative
  diffing model rather than hand-managed cursor math.
- **`ink`'s own input components for the wizards** (rejected *for the wizard role*) —
  `@clack/prompts` provides purpose-built, validated, cancellable multi-step prompt flows
  (intro/outro, grouped prompts) that the `create` wizard and the gate prompt want, with far
  less hand-built form code than composing `ink` inputs. `ink` remains the **live-run
  renderer**; `@clack/prompts` is the **wizard/prompt** layer — distinct roles, not overlap.
- **A single mega-dependency (a batteries-included TUI+prompts+parser kit)** (rejected) —
  three focused, independently-maintained libraries keep each concern replaceable.

## Consequences

### Positive

- The CLI's UX stack is a recorded decision before any `apps/cli` code is written — no ad-hoc
  adoption inside a feature PR — and the libraries are catalog-pinned, surface-confined, and
  added per-workstream under the cooling window.
- Framework-free command cores make the TUI (2.E) and `--json` (2.F) paths two renderers over
  one core, directly serving the anti-drift requirement, and make commands unit-testable with
  no TTY.
- `ink`'s React model reuses the team's existing React skill and parallels the desktop UI,
  and absorbs high-rate token rendering declaratively.

### Negative

- Three runtime-needed libraries (plus React, transitively via `ink`) enter the CLI bundle —
  mitigated by: they are **bundled into the `apps/cli` ESM artifact alone** (never an engine
  package or another surface) and confined by an import discipline a reviewer checks and the
  engine-deps guard backstops. (React in particular is not meaningfully tree-shakeable, so the
  cost is the CLI binary's size alone — acceptable for a globally-installed dev tool.) None
  crosses into the engine or the seam.
- `ink` couples the CLI to React in the terminal — accepted: it is the chosen TUI model, its
  footprint is the CLI binary's alone, and the framework-free cores mean a future TUI swap
  would not touch command logic.
