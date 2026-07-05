# Node.js runtime upgrade — analysis & deferred decision (off Node 22 / floor 20.12)

> Status: **Analysis / deferred maintainer decision.** NOT scheduled into any phase; NOT part of
> Phase 2.5.F. This note captures the findings so the decision isn't lost — acting on it is a
> separate, governed change (see [§6 Governance](#6-governance--what-acting-on-this-requires)).
>
> Snapshot date: **2026-07-05.** Every version/EOL number below is a point-in-time fact from that
> day (live web + [`endoflife.date/nodejs`](https://endoflife.date/nodejs) + npm/GitHub). Node
> releases and dependency versions move — **re-verify at the PR that acts on this.**

- **Related**: [phase-2.5-cli-consolidation.md](phase-2.5-cli-consolidation.md) (the current
  workstream — untouched by this), [../deferred-tasks.md](../deferred-tasks.md) (the maintainer-decision
  index this is linked from), [../../tech-stack.md](../../tech-stack.md) (the canonical "Node.js runtime"
  bullet this would amend), [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md) (the
  `better-sqlite3` / `node:sqlite` decision a floor bump reopens), [ADR-0019](../../decisions/0019-cli-node-keychain-library.md)
  (`@napi-rs/keyring`), [ADR-0047](../../decisions/0047-cli-framework-commander-ink-clack.md) (ink / `@clack/prompts`).

## TL;DR

The repo carries **two Node numbers** that mean different things, and only one is a liability:

- **`.nvmrc` = 22** — the *dev/CI* version (what the team builds & tests on). Fine, but a version
  behind the newest LTS.
- **`engines.node >= 20.12` + catalog `@types/node ^20.12`** — the *supported floor* (what the
  published `relavium` CLI must run on for end users). **This is now the problem:** Node 20 reached
  **EOL on 2026-04-30**, and `better-sqlite3` ships **no prebuilt binary** for Node 20, so a fresh
  CLI install on the declared floor **already forces a C++ source build** — partially defeating
  [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md)'s "prebuilt so CI/users need
  no toolchain" rationale.

**So the reframe: the risk is *staying*, not upgrading.** Recommendation — do both, **staged and
decoupled**:

1. **Now, ~zero-risk, no ADR:** bump `.nvmrc` **22 → 24** (Active LTS). One line; both CI workflows
   already read `.nvmrc`; every pinned tool + native addon supports 24.
2. **Later, a governed breaking PR:** raise the supported floor **20.12 → ≥22**. This *restores*
   clean prebuilt coverage for the SQLite driver **and** unlocks the ecosystem's newer majors — ink 7 and
   vitest 5 gate on `≥22`, `node:sqlite` becomes eligible at `≥22.5` (experimental), and eslint 10 needs only
   `≥20.19` (so it is actually reachable a hair *below* 22). A `≥22` floor covers all of them. It is a
   **SemVer-major** for published `relavium` and **reopens ADR-0021**, so it needs a superseding ADR.

The published-CLI floor must **never** be Node *Current* (26) — pin it to an LTS.

## 1. Current Node landscape (verified 2026-07-05)

| Version | Status | Latest patch | EOL | Relevance here |
|---|---|---|---|---|
| **20** | **EOL** (2026-04-30, past) | 20.20.2 | **2026-04-30** | The repo's supported **floor** (20.12) sits here — EOL, and **no `better-sqlite3` prebuild** (NODE_MODULE_VERSION 115) |
| **22** | Maintenance LTS | 22.23.1 | 2027-04-30 | The repo's `.nvmrc` dev/CI pin |
| **24** | **Active LTS** | 24.18.0 | 2028-04-30 | **Newest stable LTS today** → the dev/CI target |
| **26** | Current (newest line; LTS promotion ~2026-10-20) | 26.4.0 | 2029-04-30 | "Truly current"; works, but bleeding edge |

Cadence: **even majors → LTS**, **odd majors → Current-only** (never LTS, short life). A project
should pin an **LTS**, not a Current. Today: newest **Active LTS = 24**; newest **line = 26**.

## 2. The key finding — the floor is the liability, not the upgrade

Two facts combine into the load-bearing insight:

1. **Node 20 is EOL** (2026-04-30) — the supported floor (`>=20.12.0`) now points at an end-of-life
   Node line (no security backports).
2. **`better-sqlite3` 12.x ships no prebuilt binary for Node 20** (it prebuilds NODE_MODULE_VERSION
   127/137/141/147 = Node 22/24/25/26, but **not** 115 = Node 20). So installing published `relavium`
   on the *declared minimum* Node already falls back to a **node-gyp / C++ source build** — the exact
   failure mode [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md) chose the driver
   to avoid.

**Consequence:** raising the floor to `≥22` is not a degradation — it **restores** clean prebuilt
coverage for the CLI's SQLite driver while dropping only EOL Node.

## 3. The two changes — very different blast radius

| | **(A) Dev/CI bump** | **(B) Supported-floor bump** |
|---|---|---|
| Files touched | `.nvmrc` (one line) | `package.json` `engines.node` **+** catalog `@types/node` (lockstep) |
| Changes what… | the team **builds & tests on** | end users can **run** published `relavium` |
| Breaking for users? | No (internal) | **Yes** — drops Node 20.x/21.x users → **SemVer-major** |
| ADR required? | No | **Yes** — reopens [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md) → superseding ADR |
| CI | `ci.yml` + `release.yml` already read `.nvmrc` → automatic | + a dedicated CI leg pinned to the **exact new floor** |
| Unlocks | — | ink 7 + vitest 5 (`≥22`), `node:sqlite` eligibility (`≥22.5`, experimental), eslint 10 (`≥20.19`) — a `≥22` floor covers all |

**Why `@types/node` moves in lockstep with (B):** it is *deliberately* pinned to the floor (^20.12),
not `.nvmrc`'s 22, so that using a Node-22+-only API (e.g. `node:sqlite`) is a **type error** rather
than a floor-runtime break. Bumping the floor without bumping `@types/node` would silently defeat that
guard. Leaving `@types/node` alone is exactly correct for **(A)**.

## 4. Dependency verdicts (as of 2026-07-05)

| Dependency (pinned) | Verdict | Detail |
|---|---|---|
| **`better-sqlite3`** ^12.10.0 → 12.11.1 | ✅ compatible | **Make-or-break #1, clears.** Prebuilds Node 22/24/25/26 (NMV 127/137/141/147); **no** prebuild for Node 20 (115) or 23 (131). Per-Node-**major** (NOT N-API) → each new major needs a fresh WiseLibs prebuild; stay on a caret range and confirm a prebuild exists before adopting anything newer than 26. (12.11.2 is GitHub-tagged 2026-07-03 but not yet on npm — do not exact-pin.) |
| **`@napi-rs/keyring`** ^1.3.0 | ✅ compatible | **Make-or-break #2, a non-issue.** N-API stable ABI with per-**platform** (not per-Node-major) binaries; one binary works across Node 22/24/25/26. Imposes **zero** Node constraint. |
| **`ink`** ^6.8.0 | 🔓 unlocks (only via B) | 6.x runs on the 20.12 floor **and** newest Node — no forcing function. **ink 7.1.0 hard-gates `engines.node >=22`** (native bracketed-paste `usePaste`, `useWindowSize`, `alternateScreen`, richer `Box`). **Not** adoptable via `.nvmrc` alone. **Breaking input semantics** if taken: Backspace → `key.backspace` (was `key.delete`), Escape no longer sets `key.meta` → needs a regression pass on Shift+Tab mode-cycle, the EA7 `Esc` mid-turn abort, the bare Home, and the 2.5.B/2.5.D bracketed-paste hand-roll (which `usePaste` could replace). |
| **`@clack/prompts`** ^1.6.0 | ✅ compatible | Latest 1.7.0 still declares `engines.node >=20.12.0` — no floor pressure. Optional in-range `^1.6.0 → ^1.7.0`. |
| **`react`** ^19.2.7 | ✅ compatible | No practical Node floor; already satisfies ink 7's `react >=19.2.0` peer. |
| **`@types/node`** ^20.12.0 | ⚠ bump only under B | Move `^20.12 → ^22`/`^24` **in lockstep** with the floor (the type-guard). Untouched for A. |
| **`typescript`** ^5.7.2, **`vitest`** ^3, **`turbo`** ^2.3, **`tsup`** ^8.5 / esbuild, **`eslint`** ^9.17 / typescript-eslint ^8.18, **`drizzle-orm`**/`drizzle-kit`, **`@modelcontextprotocol/sdk`** ^1.29, provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`) | ✅ compatible | All run cleanly on Node 24/26. `turbo` is a Node-version-independent Go binary; `tsup`/esbuild are Go/`>=18`. **Latent major-version debt** (vitest 4/5, TS 6, eslint 10) is real but **independent of the Node move** — each its own migration PR, not riding along. (eslint 10 wants `>=20.19`, vitest 5 + ink 7 want `>=22` — the ecosystem floor is visibly migrating to Node 22.) |

## 5. Migration plans

### Option A — dev/CI bump (recommended now)

1. Edit **`.nvmrc`**: `22` → `24` (Active LTS). *(Only source change. If truly "current" is wanted,
   `26` is also prebuild-covered — but 24-LTS is the more stable CI baseline; recommend 24.)*
2. Do **not** touch `engines.node` or catalog `@types/node` — floor + `node:sqlite` type-guard stay intact.
3. No workflow edit: `ci.yml` (L62/135/156) and `release.yml` (L50/91/149) already use
   `node-version-file: .nvmrc`.
4. `pnpm install` on the new Node → confirm `better-sqlite3` pulls the **prebuilt** binary (Node 24 = NMV
   137) with **no** node-gyp/C++ fallback, and `@napi-rs/keyring` loads its N-API binary.
5. `pnpm turbo run lint typecheck test build` green across all workspaces.
6. Push → CI + `release.yml` cross-OS install-smoke (macOS/Linux/Windows) exercise the new Node.
7. Amend the [tech-stack.md](../../tech-stack.md) "Node.js runtime" bullet: dev/CI = Node 24 (floor
   unchanged at 20.12). Optionally add a CI matrix leg at the **floor** (20.12/20.19) so the published-CLI
   contract stays tested even though the team builds on 24.
8. Commit (Conventional Commit; **no ADR** — dev/CI-only, non-breaking for users).

### Option B — supported-floor bump (governed, breaking)

1. **Decide the target:** `>=22.0.0` (recommended — widest non-EOL user base, all unlocks at the same
   threshold) vs `>=24.0.0` (floor = newest LTS, cleaner story, drops more users; **no extra unlock**).
2. **Governance (do first):** write a **superseding ADR** (via the `supersede-adr` skill) for
   [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md) — the floor bump removes its
   sole stated reason for rejecting `node:sqlite` (needs Node ≥22.5). The ADR must either **adopt**
   `node:sqlite` or **re-affirm** `better-sqlite3` under the new floor. ADR-0021 is Accepted +
   append-only: flip its status to "Superseded by", never edit its body; repoint live references.
3. Edit `package.json` `engines.node`: `>=20.12.0` → `>=22.0.0`.
4. Edit catalog `@types/node`: `^20.12.0` → `^22` **in lockstep**.
5. Update [tech-stack.md](../../tech-stack.md) ("Node.js runtime" bullet + the `@clack/prompts` floor
   comment) and reconcile the roadmap.
6. Bump `.nvmrc` to `24` too (folds A in — dev/CI at/above the new floor).
7. **Separate follow-up PRs (do NOT ride along):** ink `^6 → ^7` (budget the input-semantics audit +
   EA7/Shift+Tab/bare-Home regression), `@clack ^1.6 → ^1.7`, and eslint 9→10 / vitest 3→4→5 / TS 5.7→6
   on their own tracks.
8. `pnpm install`, rebuild native addons, `pnpm turbo run lint typecheck test build`.
9. Add a CI leg pinned to the **exact new floor** (e.g. Node 22.0.0), not just `.nvmrc`'s LTS.
10. Cross-OS install-smoke at the new floor + LTS; verify externalized `better-sqlite3` pulls a prebuild
    (no C++ build) on each OS.
11. Publish a **SemVer-major** of `relavium`; update CHANGELOG + [current.md](../current.md).

## 6. Governance — what acting on this requires

- **(A)** is a Conventional Commit, no ADR. It only amends [tech-stack.md](../../tech-stack.md)'s dev/CI
  line.
- **(B)** is a **decision** ([CLAUDE.md](../../../CLAUDE.md) #9): it needs a **superseding ADR** for
  [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md), a [tech-stack.md](../../tech-stack.md)
  amendment, a roadmap reconcile, and a published SemVer-major. The floor bump itself (a stack change)
  is recorded in that same ADR.

## 7. Recommendation

**Do both, staged and decoupled.**

- **Ship (A) now** — `.nvmrc 22 → 24`. Essentially zero-risk (every pinned tool + native addon supports
  24; one line both CI workflows already consume; non-breaking for users).
- **Then (B) in a separate ADR-governed breaking PR** — floor `20.12 → ≥22`. Prefer **`≥22`** over `≥24`
  for the floor (largest non-EOL user base; 24 unlocks nothing extra). Because the current floor is EOL
  **and** already forcing source builds, B is a **"when", not an "if"** — but it is a real SemVer-major
  that drops Node 20/21 users and reopens ADR-0021, so it is out of scope for 2.5.F and belongs in its
  own governed PR.

The maintainer's stated preference to "move to current" is well-founded here — but the *published-CLI
floor* must land on an **LTS (22/24), never Current (26)**; "current" is appropriate only for the local
dev/CI pin if desired.

## 8. Open questions for the maintainer

- **Floor target:** `>=22.0.0` (recommended) or `>=24.0.0`?
- **Dev/CI pin:** Node 24 (Active LTS, recommended for CI stability) or 26 (Current, honoring "move to
  current")?
- **On the reopened ADR-0021:** actually adopt Node's built-in `node:sqlite` (drop `better-sqlite3`), or
  just supersede ADR-0021 to re-affirm `better-sqlite3` under the new `≥22` floor? (Very different efforts.)
- **SemVer-major readiness:** OK to publish a breaking `relavium` major? Any signal on how many users are
  on Node 20/21?
- **ink 7:** take it now (native `usePaste` replacing the 2.5.B/2.5.D hand-roll, but a breaking
  input-semantics migration) or defer to a later PR?
- **Scope discipline:** confirm the Node PR does **not** also pull in vitest 4/5, TS 6, or eslint 10 —
  each its own migration.
- **Floor CI leg:** OK to add a CI job pinned to the exact new floor (e.g. 22.0.0) so the published-CLI
  minimum is continuously proven?
