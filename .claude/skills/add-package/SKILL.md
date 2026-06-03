---
name: add-package
description: >
  Scaffold a new workspace package under packages/ or an app under apps/ in the Relavium Turborepo: package.json (@relavium/<x>, workspace:* deps), a tsconfig extending the base, shared ESLint, Vitest config, a curated src/index.ts, a test skeleton, and turbo wiring — with the import boundaries and no-circular-deps rule enforced. USE FOR: adding a new shared package or a new app surface to the monorepo. DO NOT USE FOR: adding a provider adapter inside the existing packages/llm (use ../add-llm-adapter/SKILL.md), recording the decision to add a package or dependency (use ../write-adr/SKILL.md), or authoring a spec (that has one canonical home in docs/reference/).
---
# Add a workspace package or app

## Purpose
Create a new `packages/<x>` or `apps/<x>` workspace that is born consistent with the rest of the monorepo: the right `@relavium/<x>` name, `workspace:*` internal deps, a `tsconfig` that extends the strict base, the shared root ESLint/Prettier, a Vitest config, a curated `src/index.ts`, and a `*.test.ts` skeleton, wired into Turborepo so `pnpm turbo run lint typecheck test build` picks it up automatically. The skill exists so a new workspace never drifts from the strict-TS, no-`any`, no-circular-deps, no-vendor-leak posture the rest of the repo holds. It assumes you have read `CLAUDE.md`, `docs/project-structure.md`, and `docs/standards/code-style-typescript.md`.

## When to use
- You need a new shared package under `packages/` (e.g. a focused utility the engine and a surface both consume).
- You are standing up a new app surface under `apps/` that consumes the engine.
- You are scaffolding a Phase-2 app (`apps/api`, `apps/portal`) ahead of its phase — mark it clearly as Phase 2 and do not wire Phase-2 deps into the Phase-1 build.

## When not to use
- You are adding a provider adapter — that lives inside the existing `packages/llm` behind the seam; use ../add-llm-adapter/SKILL.md.
- The work is *deciding* to add the package, a new runtime dependency, or a new seam — that needs an ADR first (../write-adr/SKILL.md), then this skill.
- You are writing a concrete spec (YAML schema, SSE event, IPC, DDL) — it has one canonical home under `docs/reference/`, not a new package.

## Inputs
| Input | Description |
|-------|-------------|
| Kind | `package` (shared, under `packages/`) or `app` (surface, under `apps/`). |
| Slug | kebab-case dir name (`run-history`); the package name is `@relavium/<slug>` for packages. Apps use a plain name (`relavium` for the CLI, `relavium.relavium` for the extension) — match `docs/project-structure.md`. |
| Internal deps | Which `@relavium/*` workspaces it depends on. Must not create a cycle (see Workflow step 2). |
| Platform target | Does it run only in Node, only in a browser/WebView, or everywhere? Engine-adjacent code must stay platform-free. |
| Phase | Phase 1 (shipped) or Phase 2 (cloud) — Phase-2 packages are marked and excluded from the Phase-1 build/release. |

## Workflow
1. **Confirm an ADR isn't owed first.** A genuinely new package, a new seam, or any new *runtime* dependency requires an ADR (architectural-principles §9). If one is owed, stop and run ../write-adr/SKILL.md, then return here. Dev-only tooling shared from the root does not need an ADR.
2. **Fix the dependency direction before writing a line.** The allowed edges are `shared → llm → core → apps`, plus `shared → core`, `db → {desktop,cli,api}`, `ui → {desktop,vscode,portal}` (see the graph in `docs/project-structure.md`). Two hard rules:
   - **No cycles.** A new package may only depend on packages *upstream* of it. If you find yourself wanting an upstream package to import your new one, the boundary is wrong.
   - **The engine (`packages/core`) has ZERO platform-specific imports.** If your package will be imported by `packages/core`, it must be pure TypeScript — no `node:*`, no `fs`, no Tauri, no DOM, no provider SDK. Platform code belongs in an app or in a leaf package the engine does *not* import.
3. **Create the directory and the source/test skeleton.**
   ```bash
   PKG=run-history   # your slug
   mkdir -p /Users/dev/Documents/Projects/Agent-Organizer/packages/$PKG/src
   ```
   Resulting tree for a shared package:
   ```text
   packages/run-history/
   ├── package.json
   ├── tsconfig.json
   ├── eslint.config.js        # re-exports the root flat config
   ├── vitest.config.ts
   └── src/
       ├── index.ts            # curated public surface — NOT export *
       ├── run-history.ts      # implementation (kebab-case files)
       └── run-history.test.ts # colocated test skeleton
   ```
   (For an app, swap `apps/<slug>/` and the app's own entry, e.g. `src/extension.ts` for the VS Code extension or a `commander` entry for the CLI — see `docs/project-structure.md` for each surface's entry file.)
4. **Write `package.json`.** Name it `@relavium/<slug>`, `"private": true`, ESM (`"type": "module"`), and declare internal deps with the `workspace:*` protocol. Scripts delegate to the shared tooling so Turborepo can fan out:
   ```jsonc
   {
     "name": "@relavium/run-history",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "main": "./src/index.ts",
     "types": "./src/index.ts",
     "exports": { ".": "./src/index.ts" },
     "scripts": {
       "lint": "eslint .",
       "typecheck": "tsc --noEmit",
       "test": "vitest run",
       "build": "tsc -p tsconfig.json"
     },
     "dependencies": {
       "@relavium/shared": "workspace:*"   // only upstream packages; never a cycle
     },
     "devDependencies": {}                  // dev tooling is hoisted from the root
   }
   ```
   Never use `npm`/`yarn` or a `^`/`~` range for an internal package — always `workspace:*`.
5. **Write `tsconfig.json` extending the strict base.** Do not loosen `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, or `noImplicitOverride` (code-style §Strictness). Set the `lib` to match the platform target — engine-adjacent packages do **not** add the `dom` lib.
   ```jsonc
   {
     "extends": "@relavium/tsconfig/base.json",
     "compilerOptions": { "outDir": "dist", "rootDir": "src" },
     "include": ["src"]
   }
   ```
6. **Wire ESLint and Vitest.** `eslint.config.js` re-exports the root flat config so the boundary and `no-explicit-any` rules apply unchanged. If this package will be imported by `packages/core`, add it to the import-boundary zone that forbids platform/vendor imports (the same mechanism that fences the LLM seam — code-style §Module boundaries). `vitest.config.ts` extends the root preset.
7. **Curate `src/index.ts`.** Export the public surface explicitly — named exports only, **never `export *`** of internals (code-style §Code shape). The index is the package's contract; everything not exported here is private.
8. **Add the test skeleton.** A colocated `*.test.ts` with at least one real assertion (not a placeholder), so the package is in the coverage baseline from commit one. Engine-adjacent packages target the high `core`/`llm` bar (testing.md §Coverage); surfaces get smoke + critical-journey coverage.
9. **Register it with the workspace and Turborepo.**
   - Confirm the glob in `pnpm-workspace.yaml` already covers `packages/*` / `apps/*` (it does — no edit needed unless you used a non-standard path).
   - If the package needs a non-default task pipeline (e.g. `build` depends on an upstream `build`), add/extend its entry in `turbo.json`; otherwise it inherits the root pipeline.
   ```bash
   pnpm install   # links the new workspace and resolves workspace:* deps
   ```
10. **Verify the whole graph still builds in dependency order.**
    ```bash
    pnpm turbo run lint typecheck test build
    ```
    Turborepo runs in topological order; a cycle or a stray platform/vendor import fails here, which is the point.
11. **Commit** with ../commit-and-pr/SKILL.md, scoped to the package: `chore(run-history): scaffold @relavium/run-history package` (reference the ADR if step 1 produced one).

## Outputs
- A new `packages/<slug>/` or `apps/<slug>/` workspace with `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, a curated `src/index.ts`, and a colocated `*.test.ts`.
- The workspace linked by `pnpm install` and picked up by `pnpm turbo run …` in correct dependency order.

## Done criteria
- [ ] Package name is `@relavium/<slug>` (packages) or the canonical app name from `docs/project-structure.md` (apps); `private: true`.
- [ ] Internal deps use `workspace:*`; the dependency direction is downstream-only — `pnpm turbo run build` proves no cycle.
- [ ] `tsconfig.json` extends the strict base and does not loosen any strict flag; no `any`.
- [ ] If imported by `packages/core`: zero platform-specific imports (no `node:*`, fs, DOM, Tauri, vendor SDK) and it's in the import-boundary zone.
- [ ] ESLint + Vitest wired to the shared root config; `src/index.ts` is a curated named-export surface (no `export *`).
- [ ] At least one real test asserts behavior; the package is in the coverage baseline.
- [ ] `pnpm turbo run lint typecheck test build` is green across the workspace.
- [ ] Phase-2 packages are marked Phase 2 and not pulled into the Phase-1 build/release.

## Common pitfalls
- Importing a platform API or a provider SDK into a package the engine consumes — breaks the zero-platform-imports rule and the LLM seam at once.
- A circular dependency from letting an upstream package import the new one; fix the boundary, do not paper over it with a re-export.
- Using `export *` from `index.ts`, leaking internals into the public surface.
- A `^`/`~` version range for an internal dep instead of `workspace:*`.
- Loosening `strict`/`noUncheckedIndexedAccess` in the package `tsconfig` to make code compile.
- Forgetting `pnpm install` after creating the dir, so Turborepo never sees the workspace.
- Scaffolding a package that should have been an ADR first (new seam / new runtime dependency).

## Related
- Monorepo layout & dependency graph: ../../../docs/project-structure.md
- Strict TS, no-`any`, module boundaries, curated exports: ../../../docs/standards/code-style-typescript.md
- Build-in-house / when a dependency needs an ADR: ../../../docs/standards/architectural-principles.md (§9)
- Test discipline & coverage bar: ../../../docs/standards/testing.md
- Pinned stack & tooling: ../../../docs/tech-stack.md
- Sibling skills: ../add-llm-adapter/SKILL.md, ../write-adr/SKILL.md, ../commit-and-pr/SKILL.md
