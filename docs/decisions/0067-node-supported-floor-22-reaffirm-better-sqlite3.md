# ADR-0067: Node supported-floor `>=22` and re-affirmed `better-sqlite3` (supersedes ADR-0021)

- **Status**: Accepted
- **Date**: 2026-07-09
- **Related**: [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md) (**supersedes**), [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md), [ADR-0050](0050-cli-history-db-at-rest-posture.md), [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0051](0051-cli-distribution-thin-bundle-private-engine.md), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) (the ink-7 renderer this floor unblocks), [node-runtime-upgrade.md](../roadmap/phases/node-runtime-upgrade.md) (the full analysis), [tech-stack.md](../tech-stack.md), [phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) (workstream 2.6.F)

## Context

This supersedes [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md), which chose
`better-sqlite3` as the Node-side SQLite driver for `@relavium/db` and **rejected** Node's
built-in `node:sqlite` **specifically because** the supported floor was `>=20.12` — below
`node:sqlite`'s `>=22.5` requirement — and `node:sqlite` was flagged experimental with an
immature Drizzle adapter. That framing no longer holds unchanged, so the decision must be
re-recorded rather than silently relied on:

- **Node 20 is EOL** (2026-04-30) — the supported floor points at an end-of-life line with no
  security backports.
- **`better-sqlite3` ships no prebuilt binary for Node 20** (it prebuilds the current LTS lines —
  see [tech-stack.md](../tech-stack.md) / the pinned catalog and
  [node-runtime-upgrade.md §4](../roadmap/phases/node-runtime-upgrade.md#4-dependency-verdicts-as-of-2026-07-05)),
  so a fresh install of the published `relavium` CLI on the *declared* floor **would force a
  `node-gyp` C++ source build** — the exact failure mode ADR-0021 chose the driver to avoid. (The
  CLI's public npm publish is still the pending final maintainer step, so there is no live install
  hitting this yet — but the v0.1.1 artifact as cut would source-build on Node 20.)
- **`ink` 7 — the substrate for the 2.6.F full-screen renderer ([ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md))
  — hard-requires Node `>=22`.** The renderer cannot ship on the current floor.

So the floor **must** rise. Raising it removes ADR-0021's sole stated reason for rejecting
`node:sqlite` — materially withdrawing that decision's rationale — and it is itself a new,
breaking floor decision for the published binary. That is **more than a version bump**, so it is
recorded as a **supersession**, not an in-place amendment. (Contrast [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md),
which for its structurally-similar keep-the-incumbent change — bumping `ink`'s major while `ink`
stays the TUI framework — correctly *refines* ADR-0047 in place, because there no prior rationale
is withdrawn and no cross-cutting breaking decision is made. Here both conditions hold, so
supersede is the right instrument; see [node-runtime-upgrade.md §6](../roadmap/phases/node-runtime-upgrade.md#6-governance--what-acting-on-this-requires).)
The stakes: the floor is a **breaking release** for the published binary, and the driver choice
must preserve Drizzle's synchronous adapter and the `SQLITE_BUSY` busy-retry hardened in Phase
2.5.I — getting the driver wrong risks a write-resilience regression under concurrency.

## Decision

**We raise the published supported floor to Node `>=22` and, re-weighing the driver under that
floor, re-affirm `better-sqlite3` for `@relavium/db`.** Two coupled parts:

**1. The floor.** `engines.node` moves `>=20.12` → `>=22` in the root and `apps/cli` manifests;
the catalog `@types/node` moves to `^22` **in lockstep** (it is deliberately pinned to the floor
so a Node-22+-only API is a type error, not a runtime break); dev/CI `.nvmrc` moves `22 → 24`
(Active LTS); and CI gains a leg pinned to the **exact floor** (`22.0.0`) so the published minimum
stays continuously proven. `@types/better-sqlite3` is unaffected (it tracks the driver's API, not
the Node floor). Versions live only in [tech-stack.md](../tech-stack.md) / the catalog.

**2. The driver — re-affirm `better-sqlite3`.** With the floor at `>=22`, `node:sqlite` becomes
*eligible*, so it is re-weighed from scratch (facts below verified 2026-07-09; re-verify at the PR
per [node-runtime-upgrade.md](../roadmap/phases/node-runtime-upgrade.md)'s point-in-time discipline):

- **`better-sqlite3` under `>=22` (chosen).** The floor bump **restores** its clean prebuilt
  coverage on the supported LTS lines (Node 22/24/26), erasing the Node-20 source-build problem
  that motivated re-opening the question. (Odd Current lines admitted by `>=22` — e.g. 23, 25 — are
  not uniformly prebuilt and may still source-build; the practically-supported set is the even LTS
  lines, exercised by the CI floor leg.) It keeps the synchronous Drizzle adapter
  (`drizzle-orm/better-sqlite3` + its migrator), so the ~70 synchronous `.all/.get/.run` sites, the
  `BEGIN IMMEDIATE` write transactions, and the `SQLITE_BUSY`/`SQLITE_LOCKED` string-code busy-retry
  (2.5.I) are **unchanged** — zero churn, zero new risk.
- **`node:sqlite` (rejected).** Still a Release Candidate (Stability 1.2 as of Node 26, not
  Stable); **`drizzle-kit` ships no `node:sqlite` adapter** (drizzle-team/drizzle-orm#5471, closed
  unresolved) and Relavium's schema/migration pipeline is Drizzle-first; and its error identity
  differs (`ERR_SQLITE_ERROR` + a numeric `errcode`, not better-sqlite3's string `.code`), so
  `isRetryableLockError` would no longer match — the busy-retry would **stop retrying and rethrow
  on the first residual `SQLITE_BUSY`** (fail-loud, but a write-resilience regression under
  concurrency, against the ADR-0050 durability posture). Its one real win (no native module) is
  already mitigated by the restored prebuilds. Revisit only when **all** hold: `node:sqlite` reaches
  Stable, `drizzle-kit` adds an adapter, and the floor is `>=24`.
- **Floor target `>=24` (rejected).** A clean Active-LTS floor, but it drops Node 22 Maintenance-LTS
  users for **no extra unlock** (`ink` 7 and the prebuilds all land at `>=22`).

`vitest` 5 (needs `>=22.12`) becomes *eligible* at this floor but is **explicitly out of scope** —
an independent migration on its own PR, never riding this governed floor bump. (`eslint` 10 needs
only `>=20.19`, so it is reachable *below* this floor and is not newly unlocked by it; likewise its
own PR.) See [node-runtime-upgrade.md §5/§8](../roadmap/phases/node-runtime-upgrade.md#5-migration-plans).

> **Amended 2026-07-09 (effective floor + LTS terminology).** Two corrections to the text above; the DECISION —
> the Node **22 line** is the supported floor — is unchanged. **(a) The effective installable floor is `22.12.0`,
> not `22.0.0`.** A transitive dependency (`vite`, pulled by `vitest`) declares `engines.node`
> `^20.19.0 || >=22.12.0`, so `pnpm install` refuses Node 22.0.0 and the CI floor leg (which installs on the *exact*
> declared floor) fails. `engines.node` in the root + `apps/cli` manifests and the CI floor leg are therefore pinned
> to **`>=22.12.0` / `22.12.0`**. **(b) "supported LTS lines (Node 22/24/26)" above overstates 26.** At the time of
> writing, **22 and 24** are the LTS lines; **26 is a future line** that is not yet LTS. Read those passages as "the
> even (LTS-track) lines at or above 22" — 26 joins the supported set once it ships and enters LTS.

## Consequences

### Positive

- The published CLI installs from **prebuilt** `better-sqlite3` binaries on the supported LTS lines
  (22/24/26) with no C++ toolchain — restoring ADR-0021's original "prebuilt so users need no
  toolchain" guarantee, which Node-20 EOL had quietly broken.
- `ink` 7 (and thus the 2.6.F full-screen renderer) is unblocked; EOL Node 20 is dropped from the
  supported range.
- The persistence layer is **untouched**: Drizzle adapter, sync call sites, `BEGIN IMMEDIATE`
  transactions, and the 2.5.I busy-retry all keep working with no migration.

### Negative

- A **breaking release** for the published `relavium` binary — drops Node 20/21 users. Because the
  package is pre-1.0 (v0.1.1), the correct version increment under SemVer §4 is a **0.x MINOR bump
  (e.g. 0.2.0)**, not a 1.0.0 "major" (which would prematurely signal API stability); the exact
  version is a maintainer call at publish. Mitigated: Node 20 is EOL and the public npm publish is
  still pending, so there is no installed user base to break.
- `node:sqlite`'s zero-native-module simplification is deferred; the two SQLite bindings (Node
  `better-sqlite3` + the desktop Rust `tauri-plugin-sql`) still coexist, kept honest by the single
  Drizzle schema exactly as under ADR-0021.
- A dedicated CI floor leg (Node `22.0.0`) is added so the published minimum is proven, not just the
  dev/CI `.nvmrc` LTS — a small CI-time cost for a real correctness guarantee.
