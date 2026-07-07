# ADR-0048: TOML parser for config files — `smol-toml`, confined to the `apps/cli` config loader

- **Status**: Accepted
- **Date**: 2026-06-22
- **Related**: [ADR-0020](0020-zod-runtime-schema-library.md), [ADR-0023](0023-strict-authored-yaml-validation.md), [ADR-0033](0033-strict-config-files-amends-0023.md), [ADR-0035](0035-yaml-parser-dependency.md), [config-spec.md](../reference/contracts/config-spec.md), [phase-2-cli.md](../roadmap/phases/phase-2-cli.md), [architectural-principles.md](../standards/architectural-principles.md), [tech-stack.md](../tech-stack.md), [ADR-0063](0063-cli-config-write-contract.md) (**extends this parser to the config *writer***)

> **Amended 2026-07-05 by [ADR-0063](0063-cli-config-write-contract.md)** (append-only — this body is unchanged): `smol-toml`'s use extends from the config **loader** to the config **writer**. ADR-0063 reuses `smol-toml.stringify` (already present — **no new dependency**) for a minimal, atomic, secret-incapable write of the global `~/.relavium/config.toml`, confined to the same `apps/cli/src/config` boundary this ADR drew. The parser choice and its confinement are unchanged.

## Context

Relavium's configuration is **TOML**: a global `~/.relavium/config.toml` and a per-project
`project.toml` / `workspace.toml` ([config-spec.md](../reference/contracts/config-spec.md)).
Workstream **2.B** (config resolution) must turn each config file **string** into a plain JS
object before validating it against the strict `@relavium/shared` config schemas
(`GlobalConfigSchema`, `ProjectConfigSchema`), which are `.strict()` so a typo'd key fails
loudly ([ADR-0033](0033-strict-config-files-amends-0023.md), amending [ADR-0023](0023-strict-authored-yaml-validation.md)).

`@relavium/shared` validates **already-parsed objects only** — it has Zod as its sole runtime
dependency and does no file IO. And the engine (`@relavium/core`) is **platform-free** (no
`node:*`; CLAUDE.md rule #5), so it cannot read the filesystem either. Config **loading**
(path discovery + file read + TOML decode + merge) is therefore a **host/surface** concern,
not an engine or contract-layer one — exactly the split [ADR-0035](0035-yaml-parser-dependency.md)
drew for the YAML→object step (the decode belongs to the consumer, not to `@relavium/shared`).
For build phase 2 the consumer is the CLI, so the config loader lives in `apps/cli`.

There is **no TOML library pinned anywhere** in the workspace: [tech-stack.md](../tech-stack.md)
lists none, the pnpm catalog has no entry, and no package depends on one. Adding one is a
**new runtime dependency**, which the no-new-runtime-dependency-without-an-ADR rule (CLAUDE.md
non-negotiable #2; [architectural-principles.md](../standards/architectural-principles.md) §9)
requires be decided here, before implementation. `apps/cli` is **not** an engine package, so
the engine-deps allowlist guard (`tools/engine-deps/check.mjs`) does not police it — the gate
is this ADR + code review.

Two constraints shape the choice. (1) **Pure-JS, deterministic.** The merge/resolution logic
is designed to be reusable by the later VS Code Node host, so the parser must be pure-JS with
**zero native bindings** (no `pnpm.onlyBuiltDependencies` entry) and decode the same file to
the same object everywhere. (2) **Precise, secret-free diagnostics.** A malformed config layer
must fail with a typed, **file-attributed** error (path + line/column where available) and exit
code `2`, never a raw library stack trace and never echoing a config value — the config files
are committed, shared, versioned formats.

## Decision

> **Amended 2026-06-22 (2.B implementation):** the implemented error type is named
> **`ConfigError`** (not `ConfigSyntaxError`), because it covers the whole load surface —
> unreadable file, over-size, TOML-syntax, **and** schema-invalid — not syntax alone; it
> carries `filePath` and maps to exit `2`. Additionally, the schema-invalid detail is derived
> from the Zod issue's **code + schema-side data** (expected type, allowed options, unknown key
> names), never `issue.message`/`issue.received` (which can embed the received value) — so the
> "never the source text/value" guarantee below holds for the schema path too, not just TOML
> syntax. The hardening guarantees are otherwise unchanged.

**We will parse config TOML with [`smol-toml`](https://github.com/squirrelchat/smol-toml), a
runtime dependency of `apps/cli` only, pinned through the pnpm `catalog:` — see
[tech-stack.md](../tech-stack.md) for the version (added under the §9a cooling window).**

- The parser is wrapped in a **hardened, defensive loader**, not called raw: a size cap
  checked via `statSync` **before** the file is read into memory, and **every** load fault —
  unreadable, oversize, malformed TOML, or schema-invalid — normalized to a typed, secret-free
  **`ConfigError`** carrying the file path (and the TOML line/column when present), never the
  source text or a config value. The strict Zod config schemas ([ADR-0033](0033-strict-config-files-amends-0023.md))
  remain the **single source of validation truth** on the parsed object; the parser's only job
  is string → plain data. Relavium config files are **TOML 1.0**
  ([config-spec.md](../reference/contracts/config-spec.md)); `ConfigError` is a CLI-local typed
  error (the loader is CLI-local) and would be promoted to a shared error only if the loader is
  later extracted.
- **Confinement.** The dependency lives in `apps/cli`'s config loader. It is **not** added to
  `@relavium/shared` (which stays Zod-only) and needs **no** `onlyBuiltDependencies` entry
  (pure-JS). Adding `smol-toml` to an engine package's manifest would in addition trip the
  engine-deps guard (`tools/engine-deps/check.mjs`), and a phantom import with no manifest entry
  fails typecheck — so the surface confinement is automatically backstopped, not review-only.
  The **pure merge/resolution** function (parsed Global → Workspace → Project → per-invocation
  → a resolved config, **last-writer-wins** across the four layers per
  [config-spec.md](../reference/contracts/config-spec.md)) is a framework-free module, authored
  so it can later be **extracted to a shared package** if the desktop / VS Code hosts warrant one
  (a future ADR). Until then, [config-spec.md](../reference/contracts/config-spec.md) stays the
  single canonical home for the **resolution order**, so the precedence semantics cannot drift
  across surfaces even while the implementation is CLI-local.

Considered alternatives:

- **`@iarna/toml`** (rejected) — long the popular choice, but CommonJS-first and on a stale
  maintenance cadence; `smol-toml` is ESM-native, TOML 1.0.0-compliant, zero-runtime-dependency,
  actively maintained, and faster, with structured parse errors that carry position.
- **`@ltd/j-toml`** (rejected) — capable (TOML 1.0/1.1) but with a quirkier, less idiomatic
  API surface and optional-feature flags that invite cross-surface non-determinism if set
  differently; `smol-toml` is the simpler, single-behavior fit.
- **The `toml` package** (rejected) — older and less complete against the current TOML spec.
- **Hand-roll a TOML subset parser** (rejected) — TOML is a real, evolving grammar; hand-rolling
  buys no differentiation, adds a permanent spec-tracking burden, and is exactly the commodity,
  interop-format primitive the build-in-house rule excludes from "core" — the same reasoning
  [ADR-0035](0035-yaml-parser-dependency.md) applied to YAML.
- **Parse config in `@relavium/shared`** (rejected) — `@relavium/shared` is the platform-free,
  Zod-only contract layer; the file read + decode belongs to the host that consumes it, mirroring
  the YAML decision.

## Consequences

### Positive

- 2.B gets a decided, pure-JS TOML parser before any code is written — no ad-hoc adoption inside
  the feature PR — and the strict Zod config schemas stay the single validation truth.
- The decode is deterministic and quarantined to `apps/cli`; `@relavium/shared` stays Zod-only,
  and the pure merge function is positioned for later extraction without rework, with
  [config-spec.md](../reference/contracts/config-spec.md) guarding precedence semantics in the
  meantime.
- A malformed cloned-repo config fails fast with a typed, file-attributed, secret-free error
  and exit `2`, never a library stack trace or a leaked value.

### Negative

- A new surface runtime dependency — mitigated by it being pure-JS, catalog-pinned, confined to
  the one app that consumes config, needing no install-script allowlist, and a commodity the
  build-in-house rule excludes from "core".
- The config loader is **CLI-local for now**; if the desktop and VS Code hosts later need the
  same resolution, the pure merge module is extracted to a shared package (a future ADR). Accepted:
  building a shared config package before a second consumer exists is speculative generality, and
  [config-spec.md](../reference/contracts/config-spec.md) already single-homes the precedence rules
  that matter for cross-surface consistency.
