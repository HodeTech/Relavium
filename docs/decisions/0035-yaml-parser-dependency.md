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

### Amendment note — 2026-11-23

The `uniqueKeys: true` option named in the hardened profile above is partly historical. Since commit
`d0f69bef`, the duplicate-key check for a source of more than 2048 characters is a linear, per-map
`Set` comparator in `packages/core/src/yaml-decode.ts`: the library's own `uniqueKeys` check compares every key
with every earlier one, which let a file of tens of thousands of distinct keys freeze the process. The library's
own check remains for a shorter source. The outcome, the error code and the position of every error are unchanged: a
341,547-document differential run against the previous profile found 0 differences. The decision itself, the
parser, its pinned options and its dependency status, is not changed.

### Amendment note — 2026-11-24 (PR #102 review)

Two changes to the decode profile, neither of which touches the parser choice, its pinned options or its dependency status.

- **A key budget.** The linear duplicate-key check above makes the library build one `DUPLICATE_KEY` error for every key it is asked about, to be dropped afterwards, so the work and the memory of one decode grew with the keys: a hostile 2 MiB block map took about 1.95 s and 575 MB of heap, and a catalog scan decodes up to eight such files one after the other on the Home's UI thread. For a source of more than 2048 characters, a mapping is now refused once it holds more than 100,000 keys (`MAX_MAP_KEYS` in `packages/core/src/yaml-decode.ts`; a key counts only when another key of its map comes before it), with a `YAMLParseError` of code `RESOURCE_EXHAUSTION` and the fixed message `the document has more than 100000 mapping keys`, before the library builds another error for it. The same hostile map measured about 1.16 s and 273 MB after. The budget bounds **one decode, not a scan**: the total cost of a catalog scan of several such files has no deterministic bound yet, which is a maintainer decision, registered. A source of at most 2048 characters is unaffected (it cannot hold that many keys).
- **A typed invariant error.** When the duplicate-key bookkeeping stops matching the parser's own errors (a library change, or a bug here), the decode fails closed with `YamlDecodeInvariantError`, a `RelaviumError` with a fixed, source-free message, where it used to throw a bare `Error`. A caller can tell it from a syntax fault; the two parsers file it as "not valid YAML".

### Amendment note — 2026-11-24 (PR #102 review, third security sitting: the key budget is replaced by a token budget)

This note corrects the note above, whose first bullet, "A key budget", **is no longer true**. It reverses no decision here: the parser, its pinned options and its dependency status are unchanged, and the typed `YamlDecodeInvariantError` of that note's second bullet stays.

- **Why the key budget went.** `MAX_MAP_KEYS` (100,000) bounded the number of keys the duplicate check answered, and the cost of a decode does not follow the keys: it follows the number of nodes. The third security sitting measured a flow sequence of maps (`[{a,b},{a,b},…]`) at 2 MiB, with the key budget in place, at about 4 s of CPU and 1.2 GB idle and up to 9 s under load, and a catalog scan of eight such files at 51 s and 2.75 GB on the Home's UI thread. The same bytes of prose cost 0.2 to 0.4 s. A character cap and a key cap bound neither. The constant and its `RESOURCE_EXHAUSTION` refusal for a key (`the document has more than 100000 mapping keys`) no longer exist (commit `33266015`).
- **What replaced it.** `decodeHardenedYaml` (`packages/core/src/yaml-decode.ts`) now counts the source's structural characters before the library composes anything: every line break (`\n`, `\r`), `,`, `:`, `-`, `[` and `{`, in one linear pass of about 3 ms for 2 MiB (`countYamlTokens`, which stops as soon as it passes the limit). A token is not a node; it is an over-count, so a sound upper bound on the nodes the library builds (every map entry after the first needs a line break or a comma before it, every sequence item a `-`, every flow collection a `[` or `{`, and a hyphen or a comma inside a scalar is counted too, which only over-counts). A source with more than `MAX_YAML_TOKENS = 120,000` is refused with a `YAMLParseError` of code `RESOURCE_EXHAUSTION`, the fixed message `the document is too large to read safely`, and no line or column; both parsers file a position-less fault without them. Every key after the first of its map needs a line break or a comma before it, so the same bound also bounds the duplicate check's per-key errors that the key budget was written for. Both names are exported from `@relavium/core`.
- **The scan.** The catalog scan (`apps/cli/src/workflows/catalog.ts`) charges the same count per scan against `MAX_CATALOG_SCAN_TOKENS = 200,000`, in file-name order, before a file is parsed. A file over the per-file cap is refused with the fixed reason `too large to read safely`, charged nothing and never parsed; the first file that would take the total past 200,000 is skipped with `skipped: the catalog is too large to read safely; move some files out of .relavium/<kind>/`, and so is every later file, unread. That closes the earlier note's open point, that the total cost of a scan had no deterministic bound.
- **The numbers.** Eight hostile 2 MiB files cost 26.8 s and 2.7 GB before and 10 ms and 115 MB after. One decode at the bound costs 0.2 to 0.5 s of CPU and 150 to 240 MB (3 to 7 microseconds a token, up to 17 under load), and a scan at its bound one to two seconds at the most. A legitimate file is far below the cap: the repo's own workflows and agents are 66 to 223 tokens, a workflow at every admission ceiling (500 nodes, 2,000 edges) is about 16,000, and the largest legitimate documents of the parser, graph, limits and engine tests are 26,048. Ordinary prose is 3.5 to 5.3 tokens in 100 characters, so a prompt of the full 2 MiB character cap passes; a source denser than about 5.7% structure (a long list of short items) does not.
- **If a legitimate file ever exceeds it,** raising `MAX_YAML_TOKENS` (and, with it, `MAX_CATALOG_SCAN_TOKENS` if the scan must hold several such files) is a one-constant change; the cost figures above scale linearly with it.
