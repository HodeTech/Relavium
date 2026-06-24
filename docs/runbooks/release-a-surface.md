# Release a Surface

> Status: draft — to be expanded

This runbook will describe how to cut a release for each Phase-1 Relavium surface. The
three surfaces ship through three different channels, but they all build on the same
engine packages, so a release always starts from a green engine build (see
[architectural-principles.md](../standards/architectural-principles.md) §1 and
[local-dev-setup.md](local-dev-setup.md)).

For the package layout referenced below, see
[project-structure.md](../project-structure.md). For pinned versions, see
[tech-stack.md](../tech-stack.md).

## Surfaces and channels

| Surface | Artifact | Channel |
|---------|----------|---------|
| Desktop (`apps/desktop`) | `.dmg` (macOS), platform installers (Windows/Linux) | Direct download / `brew install --cask relavium` |
| CLI (`apps/cli`) | npm package | `npm install -g relavium` |
| VS Code extension (`apps/vscode-extension`) | `.vsix` | VS Code Marketplace |

> **Phase 2 (cloud).** Releasing `apps/api` and `apps/portal` is out of scope for this
> Phase-1 runbook and will be added when the cloud layer ships.

## Pre-release gate (all surfaces)

To be expanded. The intended shape:

1. Engine packages (`packages/shared`, `packages/llm`, `packages/core`) build and pass
   tests.
2. Versions bumped consistently across the workspace; changelog updated.
3. `pnpm build` succeeds for the target surface and its dependencies via Turborepo.

## Desktop (`.dmg`)

To be expanded. Will cover: Tauri v2 bundling per platform, code signing /
notarization (macOS), the WebView2 expectation on Windows, and producing the download
artifacts referenced in the day-one DX.

## CLI (npm)

The CLI publishes to public npm as **`relavium`** (`npm install -g relavium`). The artifact is an
**engine-inlined ESM bundle** — `tsup` inlines only the proprietary `@relavium/*` engine and externalizes
every third-party dependency, which install normally (prebuilt native addons included). The full rationale
and the bundle boundary are [ADR-0051](../decisions/0051-cli-distribution-thin-bundle-private-engine.md).

**This is the first release flow; desktop and VS Code inherit its shape (pack → cross-OS smoke → publish).**

### What the build produces

- `apps/cli/dist/index.js` — the single ESM bin (shebang, minified, **no** source map: a map would ship the
  inlined engine's TypeScript, [ADR-0051](../decisions/0051-cli-distribution-thin-bundle-private-engine.md)).
- `apps/cli/drizzle/` — `@relavium/db`'s migration set, copied beside the bundle by the `tsup` build because
  the inlined db code resolves migrations relative to the bundle (`new URL('../drizzle', import.meta.url)`).
- The published `package.json` declares the third-party runtime closure only; `@relavium/*` are
  `devDependencies` (build-time inputs, inlined — never published). `tools/bundle-closure/check.mjs` fails the
  build if that closure and the declared `dependencies` ever drift.

### Release steps

1. **Pre-release gate.** A green `pnpm turbo run lint typecheck test build` on `main`; bump
   `apps/cli/package.json` `version` (semver; pre-1.0 today); update the CHANGELOG.
2. **Tag.** Push a `v<version>` tag (e.g. `v0.1.0`). This triggers the **`Release CLI`** workflow
   (`.github/workflows/release.yml`):
   - **`pack`** (ubuntu) — builds the engine + bundle, runs the bundle-closure guard, and `pnpm pack`s the
     tarball (resolving `catalog:`/`workspace:` to concrete versions). **Use `pnpm pack`, never `npm pack`** —
     only pnpm resolves those protocol strings; an `npm pack`ed manifest would keep literal `catalog:` and
     break every install.
   - **`smoke`** (ubuntu / macOS / Windows) — installs that exact tarball globally and asserts
     `relavium --help`, `provider list`, a fixture `run … --json` (exit 0), the human-gate fixture (exit 3),
     `gate list`, and an unknown `runId` (exit 2). This exercises both prebuilt native addons (better-sqlite3
     opens `history.db` against the shipped migrations; `@napi-rs/keyring`'s accessor loads) **without touching
     the OS credential store**, so the Windows leg is headless-safe.
   - **`publish`** (on the tag, gated on green smoke) — `npm publish <tarball> --provenance --access public`
     publishes the very artifact the matrix proved.

### Maintainer obligations (not in code)

- Add the **`NPM_TOKEN`** repo secret (an npm automation token for the `relavium` package); enable **2FA** on
  the npm account. The publish job is otherwise maintainer-gated by design — like the `ci` branch-protection
  obligation.
- A `workflow_dispatch` run executes `pack` + the cross-OS `smoke` **without** publishing — use it to verify a
  release candidate before tagging.

### Post-publish verification & rollback

- Verify: `npm install -g relavium@<version>` on a clean machine → `relavium --help` + a fixture
  `run … --json`. (The cross-OS smoke matrix is the gate; this is a final manual sanity check.)
- Rollback: npm disallows un-publishing a version that others may depend on after 72h. Prefer **`npm deprecate
  relavium@<bad> "use <good>"`** and publish a fixed patch; reserve `npm unpublish` for a same-day mistake.

## VS Code extension (Marketplace)

To be expanded. Will cover: packaging the `.vsix` (the extension bundles
`@relavium/core` in-process), publishing to the Marketplace, and the post-publish
smoke test (right-click a file → run a workflow).

## Post-release

To be expanded. Will cover: tagging the release in git, updating the download/install
instructions, and the rollback procedure per surface.
