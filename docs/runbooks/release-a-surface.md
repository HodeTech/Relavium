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

To be expanded. Will cover: building `apps/cli`, the npm publish flow, and verifying the
`relavium` binary post-publish.

## VS Code extension (Marketplace)

To be expanded. Will cover: packaging the `.vsix` (the extension bundles
`@relavium/core` in-process), publishing to the Marketplace, and the post-publish
smoke test (right-click a file → run a workflow).

## Post-release

To be expanded. Will cover: tagging the release in git, updating the download/install
instructions, and the rollback procedure per surface.
