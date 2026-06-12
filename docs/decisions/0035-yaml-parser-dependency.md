# ADR-0035: YAML parser for the engine — the `yaml` package, confined to `@relavium/core`

- **Status**: Accepted
- **Date**: 2026-06-11
- **Related**: [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md), [ADR-0009](0009-git-native-workflow-yaml.md), [ADR-0011](0011-internal-llm-abstraction.md), [ADR-0020](0020-zod-runtime-schema-library.md), [ADR-0023](0023-strict-authored-yaml-validation.md), [ADR-0033](0033-strict-config-files-amends-0023.md), [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md), [architectural-principles.md](../standards/architectural-principles.md), [tech-stack.md](../tech-stack.md)

## Context

Workflows and agents are authored as **git-committable YAML** ([ADR-0009](0009-git-native-workflow-yaml.md)).
The engine's first workstream — `WorkflowYAMLParser` (1.L) — must turn a `.relavium.yaml`
**string** into a plain JS object before validating it against the strict `@relavium/shared`
`WorkflowSchema` ([ADR-0023](0023-strict-authored-yaml-validation.md)). `@relavium/shared`
deliberately validates **already-parsed objects only** (its round-trip test notes "YAML→object parsing
is `@relavium/core`'s responsibility" and round-trips a JS object, not a YAML string), so the
YAML-string→object step is unowned until 1.L — and it serves both the workflow parser and the future
**agent**-YAML parser, so the decode + syntax-error layer is authored to be document-agnostic.

There is **no YAML library pinned anywhere** in the workspace: `tech-stack.md` lists none, the pnpm
catalog has no entry, and no package depends on one (the only `yaml`/`js-yaml` entries in the lockfile
are dev-tooling transitives of ESLint/Prettier — not a sanctioned runtime dependency). Adding one is a
**new engine runtime dependency**, which the no-new-runtime-dependency-without-an-ADR rule
(CLAUDE.md non-negotiable #2; [architectural-principles.md](../standards/architectural-principles.md) §9)
requires be decided here, **before** any implementation — and paired in the same change with the
`tools/engine-deps/check.mjs` allowlist edit the guard demands.

Two constraints shape the choice. (1) **Engine purity** (CLAUDE.md rule #5, [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md),
[ADR-0011](0011-internal-llm-abstraction.md)): `@relavium/core` runs identically in Node, the Tauri
WebView, the VS Code extension host, and Bun, so the parser must be **pure-JS with zero native bindings**
— a native-addon YAML library would break the WebView surface and need a `pnpm.onlyBuiltDependencies`
install-script entry — and the decode must be **deterministic across surfaces** (the same file must
produce the same plain object in every runtime). (2) **Build-in-house targets
the core** (engine, LLM seam, schedulers), *not* interop-format plumbing — a YAML 1.2 tokenizer is
exactly the commodity, security-sensitive primitive the "never hand-roll, wrap a vetted library" rule
([ADR-0019](0019-cli-node-keychain-library.md) set the precedent) says to adopt rather than write.

## Decision

**We will parse authored YAML with the [`yaml`](https://eemeli.org/yaml/) package (eemeli/yaml), as a
runtime dependency of `@relavium/core` only, pinned through the pnpm `catalog:` — see
[tech-stack.md](../tech-stack.md) for the version.**

- The parser is configured with an explicit **hardened, deterministic profile**, not the library
  defaults. The default `parse(text)` resolves `!!timestamp`→`Date`, `!!binary`→`Buffer`/`Uint8Array`,
  YAML-1.1 `<<` merge keys, complex (non-string) map keys, and anchor/alias graphs — any of which would
  make the same file decode to **different objects on different surfaces** (Node vs WebView) and break
  checkpoint/export/serialization. The pinned options are `version: '1.2'`, `schema: 'core'` (a date- or
  binary-like scalar stays a **string** — no `Date`/`Buffer`), `resolveKnownTags: false`, `merge: false`,
  `uniqueKeys: true`, `stringKeys: true`, `maxAliasCount: 0` (**anchors/aliases are not part of the
  authored contract** — this forecloses the billion-laughs / recursive-alias expansion class outright),
  and `prettyErrors: false` + `logLevel: 'error'` (no source snippet in the message, no `console.warn` —
  the parser is a pure function). A `%YAML 1.1` directive is **not honoured**: the 1.2 core profile is
  pinned regardless. The decode is further guarded by a pre-parse source-size cap, and **every**
  parse-stage throw (a YAML fault, or the anchor/alias `ReferenceError` that `maxAliasCount: 0`
  raises) is normalized to a typed, secret-free `WorkflowSyntaxError` whose line/column come from a
  `LineCounter`, never the source text. With this
  profile the decode yields only plain JSON-like data, and **strict Zod then enforces the contract**
  ([ADR-0023](0023-strict-authored-yaml-validation.md) / [ADR-0033](0033-strict-config-files-amends-0023.md))
  on that data.
- The dependency is **confined to `@relavium/core`** — the document-agnostic decode + `WorkflowSyntaxError`
  layer serves the workflow parser today and the agent-YAML parser later. It is added to
  `ENGINE_ALLOWLISTS['packages/core']` in `tools/engine-deps/check.mjs` in this same change, is **not**
  added to `@relavium/shared` (which stays Zod-only), and needs **no** `onlyBuiltDependencies` entry (pure-JS).

Considered alternatives:

- **`js-yaml`** (rejected) — also pure-JS and viable; the choice is on measurable grounds. `yaml` ships a
  documented CST/AST and a `LineCounter` for precise, source-free diagnostics (which the field-named
  errors and the future VS Code language server need), exposes the alias-count, schema, and string-key
  controls the hardened profile above depends on, carries zero transitive runtime dependencies with a
  first-class browser build, and has a steadier recent release cadence. `js-yaml` would still need this
  same ADR + allowlist edit.
- **Hand-roll a YAML subset parser** (rejected) — YAML is a deceptively large, security-sensitive grammar
  (anchors, aliases, billion-laughs); hand-rolling buys no differentiation, adds a permanent
  spec-tracking burden, and is exactly the class of commodity primitive the build-in-house rule excludes.
- **Reuse the transitive `js-yaml` in the lockfile** (rejected) — it is dev-tooling, absent from the
  catalog, the engine allowlist, and the install allowlist; relying on it would bypass rule #2 and is
  precisely what the engine-deps guard exists to catch.
- **Parse YAML in `@relavium/shared`** (rejected) — `@relavium/shared` is the platform-free contract
  layer with Zod as its sole runtime dependency; the parse step belongs to the engine that consumes it.

## Consequences

### Positive

- 1.L gets a decided, pure-JS dependency before any code is written — no ad-hoc adoption inside a
  feature PR — and the engine stays runnable on every surface (Node, Tauri WebView, VS Code host, Bun).
- The library tracks YAML 1.2 for us and gives precise syntax positions; the strict Zod schema remains
  the single source of validation truth, so the parser maps faithful objects → field-named errors.
- The **hardened profile** makes the decode deterministic across surfaces (plain JSON-like data only),
  forecloses the alias-expansion DoS class (`maxAliasCount: 0` + a size cap), and keeps every parse
  failure a typed, secret-free `WorkflowSyntaxError` — so a cloned repo's file can neither crash the
  engine before Zod runs nor leak its content into an error.
- The dependency is quarantined to `@relavium/core`'s manifest and asserted by the engine-deps guard;
  `@relavium/shared` stays Zod-only.

### Negative

- A new runtime dependency in the engine — mitigated by it being pure-JS, catalog-pinned, confined to
  the one package the guard enforces, and a commodity the build-in-house rule explicitly excludes from
  "core".
- The profile deliberately rejects YAML features authors might expect from other tools — anchors/aliases,
  `<<` merge keys, `%YAML 1.1`, `!!`-tagged Dates/binaries. Accepted: these add cross-surface
  non-determinism or a DoS surface for no authoring benefit; authored Relavium files are small and
  hand-written, and a rejected file fails fast with a typed, field-named error.
