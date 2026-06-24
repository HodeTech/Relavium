# ADR-0051: CLI distribution — an engine-inlined ESM bundle that externalizes every third-party dependency

- **Status**: Accepted
- **Date**: 2026-06-24
- **Related**: [ADR-0047](0047-cli-framework-commander-ink-clack.md) (commander/ink/`@clack/prompts` + `tsup` single-bundle — this ADR finalizes the bundle boundary 0047 deferred to 2.L), [ADR-0019](0019-cli-node-keychain-library.md) (`@napi-rs/keyring`), [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md) (`better-sqlite3`), [ADR-0027](0027-expression-sandbox.md) (the quickjs JS sandbox), [ADR-0011](0011-internal-llm-abstraction.md) (the in-house `@relavium/llm` this protects)

## Context

Workstream 2.L publishes the CLI to public npm as `relavium` so that `npm i -g relavium`
yields a working binary on macOS, Linux, and Windows — the last Phase-3 go/no-go exit
criterion. [ADR-0047](0047-cli-framework-commander-ink-clack.md) pins the bundler (`tsup`, a
single ESM `bin`) and provisionally assumed pure-JS deps would be inlined, **explicitly
deferring the exact inline-vs-external set to 2.L**; this ADR settles it. Getting the boundary
wrong is a post-publish surprise (a binary that won't start, or an IP leak), so it must be
predictable and verifiable before the first publish.

Three hard constraints shape it:

1. **The engine packages are proprietary and unpublished.** `@relavium/shared` / `@relavium/llm`
   / `@relavium/core` / `@relavium/db` are all `private: true` (the repo's proprietary LICENSE).
   They must **not** reach public npm as packages, yet the CLI needs them at runtime. A public
   `npm i -g` therefore cannot resolve them as ordinary dependencies — the CLI must carry the
   engine itself, inside the artifact.
2. **Native addons cannot be bundled.** `better-sqlite3` ([ADR-0021](0021-node-sqlite-driver-better-sqlite3.md))
   and `@napi-rs/keyring` ([ADR-0019](0019-cli-node-keychain-library.md)) load a platform-specific
   `.node` binary via a runtime `require`; a bundler that inlines their JS wrapper breaks on that
   require (verified — see Decision). Both ship **prebuilt** binaries (better-sqlite3 via a
   `prebuild-install` install-script with a `node-gyp` fallback; `@napi-rs/keyring` via per-platform
   `optionalDependencies`), so installed normally they need no compiler.
3. **Several third-party libraries are bundler-hostile.** `quickjs-emscripten-core` /
   `@jitl/quickjs-singlefile-mjs-release-sync` (the JS sandbox, [ADR-0027](0027-expression-sandbox.md))
   load their own WASM; the vendor provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`)
   read their own `package.json` and use conditional/dynamic requires; `ink`/`react` are runtime UI
   libraries. Inlining these is fragile and risks breakage that only surfaces at run time.

## Decision

**We will publish the CLI as an _engine-inlined_ ESM bundle: `tsup` inlines ONLY the proprietary
`@relavium/*` engine packages; every third-party dependency is externalized and declared in the
published `package.json` `dependencies` (the full runtime closure), installed normally by npm.**
("Thin" relative to third-party code — the *engine* is fully inlined; the bundle carries no
third-party libraries.) The native addons stay external and install their prebuilt binaries; the
proprietary engine ships transpiled-and-inlined and is never published as a separate package.

Mechanics 2.L implements (named here so the boundary is unambiguous):

- **Bundler.** `tsup` with `noExternal: [/^@relavium\//]` and an explicit `external` list naming the
  third-party closure below; `target: node20`, ESM, shebang banner.
- **No source/sourcemap in the published artifact.** The publish build sets `sourcemap: false` and
  `minify: true` — a sourcemap would embed the inlined engine's **original TypeScript source** into
  the tarball (`files: ["dist"]` would ship `dist/index.js.map`), defeating the very point of not
  publishing the engine. The engine therefore ships as minified JS: protected by the LICENSE and by
  practical obfuscation, **not** by secrecy (a transpiled engine is inherently readable to a
  determined reader — this is the accepted, deliberate posture for a proprietary CLI on public npm).
- **Engine packages move to `devDependencies`.** `@relavium/*` are `workspace:*` and `private`; left
  in `dependencies` a `pnpm publish` would rewrite them to a concrete `@relavium/core@0.0.0` the
  published manifest declares but npm cannot resolve (install fails). As `devDependencies` they are
  available at build time for `tsup` to inline yet are **absent** from the published runtime deps.
- **The published `dependencies` are exactly the third-party closure** (15 packages): the CLI's own
  `commander`, `ink`, `react`, `@clack/prompts`, `smol-toml`, `zod`, `@napi-rs/keyring` (native), plus
  the engine's transitive runtime deps that 2.L hoists into the CLI manifest — `better-sqlite3`
  (native), `drizzle-orm`, `yaml`, `quickjs-emscripten-core`, `@jitl/quickjs-singlefile-mjs-release-sync`,
  `@anthropic-ai/sdk`, `openai`, `@google/genai`. Versions stay pinned by the pnpm `catalog:`.
- **Publish with `pnpm publish`.** Only pnpm's pack resolves `catalog:`/`workspace:*` to concrete
  versions in the published manifest; `npm publish` would leave the literal protocol strings and break
  the install. The CLI `package.json` (`apps/cli/package.json`) also drops `private: true` (the four
  engine packages **remain** `private: true` and are never published), declares a `license` field
  (the repo's proprietary terms), `engines.node >= 20.12.0` (per [tech-stack.md](../tech-stack.md)),
  starts pre-1.0, and keeps `files: ["dist"]`.

Alternatives weighed:

- **Fat bundle — inline everything except the native addons** (`noExternal: [/.*/]`). *Rejected,
  empirically.* The build fails: esbuild inlines `@napi-rs/keyring`'s JS wrapper and then cannot
  resolve its internal `require('./keyring.<triple>.node')`. Even forcing the natives external,
  inlining the quickjs WASM loader, the vendor SDKs (version self-reads / dynamic requires), and
  `react`/`ink` is fragile and moves failures from build time to a user's machine. The only upside —
  a smaller install — does not justify the unpredictability.
- **A hybrid — inline `@relavium/*` plus whatever bundles cleanly, externalize the rest.** *Rejected.*
  The boundary is then decided by esbuild's heuristics (in the spike it inlined `yaml` but externalized
  `drizzle-orm`), so it drifts silently and is impossible to reason about. Declaring the **whole**
  third-party closure is explicit and stable.
- **Publish the engine packages to npm** (public, or a private registry). *Rejected.* A public publish
  exposes the proprietary engine as a standalone package, defeating `private: true`; a private registry
  breaks `npm i -g relavium` for end users, who would need registry credentials just to install the
  CLI's dependencies. The engine must travel **inside** the CLI artifact.
- **`bundledDependencies` — ship the engine's built `node_modules` inside the tarball** instead of
  inlining via tsup. *Rejected.* It bloats the tarball with the engine's full (transitive) `node_modules`,
  keeps the per-OS native-addon problem unsolved (the bundled tree pins one platform's binaries), and
  is harder to verify than a single inlined bundle plus a declared third-party closure.

**Publish & verification model.** The actual `pnpm publish` is a **maintainer-gated** action (the
maintainer holds the `NPM_TOKEN`; publish runs with `--provenance` + 2FA, integrity pinned by the
lockfile), triggered by a `v*` release tag — mirroring the live branch-protection obligation. It is
**gated on a cross-OS install-smoke matrix** (ubuntu / macOS / Windows GitHub runners) that installs
the packed tarball globally and asserts `relavium --help`, `relavium provider list`, and a fixture
`relavium run … --json` with the correct exit code. These exercise both prebuilt native binaries —
`--help` loads the bundle (which imports `@napi-rs/keyring`), `provider list` constructs the keychain
accessor (loading `@napi-rs/keyring`) and reads the SQLite catalog, and `run --json` opens
`better-sqlite3` — **without touching the OS credential store** (no key get/set), so the Windows leg is
headless-safe in CI. The reusable release flow is **written into**
[release-a-surface.md](../runbooks/release-a-surface.md) **by 2.L** (today a stub), to serve as the
intended precedent for the desktop (`.dmg`) and VS Code (`.vsix`) surfaces.

## Consequences

### Positive

- **Predictable, reproducible artifact.** The bundle's direct external import specifiers equal the
  declared `dependencies` exactly — no esbuild surprises. Every third-party library (vendor SDKs,
  `ink`/`react`, the quickjs WASM, the prebuilt natives) runs exactly as its authors intend.
- **The proprietary engine stays unpublished yet ships in the product** — inlined and minified in the
  bundle, never a separate npm package, never accompanied by a source map.
- **`npm i -g relavium` works cross-OS with no compiler toolchain** — the native addons resolve their
  prebuilt `.node` binaries (better-sqlite3's install-script / keyring's platform `optionalDependencies`);
  nothing is compiled at install time (a `--ignore-scripts` install is the documented exception).
- **A reusable release precedent.** The tag → smoke-matrix → maintainer-publish flow is intended as the
  template the desktop and VS Code surfaces inherit.

### Negative

- **The CLI `package.json` mirrors the engine's third-party runtime closure** (15 deps), duplicating
  declarations that live in the engine packages — if an engine package adds a runtime dependency, the
  CLI must add it too. This is the same drift the rejected hybrid had; the difference is it is **made
  explicit and guarded**. *Mitigation:* 2.L adds a **build-time check** — a script (in the
  `tools/engine-deps/check.mjs` family, e.g. `tools/bundle-closure/check.mjs`) that scans the built
  bundle for its external (bare-specifier) imports and fails the build if that set differs from the
  declared `dependencies`; the pnpm `catalog:` pins versions centrally, so only the **list** is
  mirrored, never the versions.
- **A larger install footprint** than a fully-inlined single file (npm pulls the full dep trees).
  Acceptable for a developer/CI tool; the win is correctness over byte count.
- **The publish and the Windows leg of verification cannot run from the dev environment** — they are a
  maintainer/CI obligation, recorded by 2.L in [release-a-surface.md](../runbooks/release-a-surface.md)
  and the [roadmap](../roadmap/phases/phase-2-cli.md) live obligations, gated on the smoke matrix so a
  red leg blocks the release.
- **The distribution model needs propagation to its canonical homes** — 2.L updates
  [tech-stack.md](../tech-stack.md), the [commands.md Install section](../reference/cli/commands.md), and
  references this ADR from [phase-2-cli.md §2.L](../roadmap/phases/phase-2-cli.md) so the model is not
  ADR-only.
