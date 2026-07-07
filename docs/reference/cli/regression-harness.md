# Engine Regression Harness (2.K)

> Last updated: 2026-07-08

- **Status**: Reference (Living) — the canonical home for the harness fixture + scenario format.
- **Surface**: CLI (`relavium`), adopted as the engine's end-to-end regression gate.
- **Scope**: Phase 2, build workstream **2.K** (completes milestone **M3** with 2.D + 2.F); **extended by Phase 2.5.I** with concurrency, session-chain, and query-shape coverage + a Windows lane.
- **Related**: [commands.md](commands.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../desktop/database-schema.md](../desktop/database-schema.md), [../../decisions/0049-cli-machine-output-contract.md](../../decisions/0049-cli-machine-output-contract.md), [../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md), [../../decisions/0064-live-model-catalog.md](../../decisions/0064-live-model-catalog.md) (§5 concurrent-process write requirement), [../../decisions/0050-cli-history-db-at-rest-posture.md](../../decisions/0050-cli-history-db-at-rest-posture.md), [../../standards/testing.md](../../standards/testing.md), [../../tutorials/cli/run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md)

## What it is

The CLI is the engine's **canonical end-to-end regression harness**: every change to
`@relavium/core` / `@relavium/llm` / `apps/cli` is exercised by running committed example
workflows through the real `relavium run … --json` path and asserting on the resulting NDJSON
[RunEvent](../contracts/sse-event-schema.md) stream + exit code. Because the run goes through the
same engine, renderer, and exit-code mapping as a production run, a regression in the engine's
run loop, the [`--json` machine-output contract](commands.md#the---json-machine-output-contract)
([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)), or the exit codes fails the
harness. This is the agreed regression gate for Phases 3–6 — extend it, don't re-invent it.

It grows from the Phase-1 `m2-e2e-harness` (the 1.U end-to-end engine harness); it lifts that
suite's discipline (`assertGapFreeSeq`, canonical-schema validation, the event signature) onto the
CLI surface.

## Where it lives

| Artifact | Path |
|----------|------|
| Fixture workflows (committed `.relavium.yaml`) | `apps/cli/src/harness/fixtures/` |
| The `run`-fixture suite (in-process vitest e2e) | `apps/cli/src/harness/regression.e2e.test.ts` |
| Concurrency e2e — a run + a chat share one `history.db`; a real two-process contention smoke (2.5.I S3) | `apps/cli/src/harness/concurrency.e2e.test.ts` (+ its child `fixtures/concurrent-writer.mjs`) |
| Session-chain e2e — Home→chat→resume→export over a real file-backed db (2.5.I S4) | `apps/cli/src/harness/session-chain.e2e.test.ts` |
| Query-shape perf budgets — `EXPLAIN QUERY PLAN` of the hot reads (2.5.I S5) | `apps/cli/src/harness/perf-budget.e2e.test.ts` |

The harness is an **in-process** suite: it drives the CLI's `runCommand` boundary with a captured
`CliIo` through the **default engine** (the standard node executor + expression sandbox over the real
`createCliHost`), exactly as a real `relavium run --json` invocation does (the same
`createJsonRenderer` produces byte-identical NDJSON). It does **not** spawn the built binary — that
would add a build dependency and process flakiness for no fidelity gain. It runs inside the standard
`pnpm turbo run test` task, so it is part of the required CI gate on every push/PR
(`.github/workflows/ci.yml`).

The per-fixture cases enter at the `runCommand` boundary (the engine-fidelity entry point). One
additional case re-runs a fixture through the **full `run(argv)` CLI shell** — `argv` →
`extractGlobalOptions` → `commander` → the `run <workflow>` subcommand action → `runCommand` → the
terminal exit code — and asserts the **identical** NDJSON stream + exit code. That proves the
argv-parsing glue wires a real workflow run faithfully (the positional workflow, repeatable `--input`,
the position-independent `--json` global), so the shell is covered end-to-end for a real run — not only
for the meta-op (`--help`/`--version`) and fault (exit 2) paths that [`run.test.ts`](../../../apps/cli/src/run.test.ts)
already covers.

## What is asserted (and what is not)

For each fixture the harness runs `relavium run <fixture> --json` and reduces each event to a
**`type:nodeId` signature** (a node-bearing event becomes `type:nodeId`, otherwise just `type`), then
asserts:

- **Exit code** — `0` success, `1` failure, `3` gate-paused (the frozen [exit-code table](commands.md#exit-codes)).
- **stdout is a pure NDJSON `RunEvent` stream** — every line round-trips to **exactly** a canonical
  `RunEvent` (`RunEventSchema.parse(line)` deep-equals the raw line, so a stray field is caught), and
  stderr is empty on a clean run.
- **`sequenceNumber` is gap-free** — exactly `0..n-1`, the bus's exactly-once guarantee (ADR-0036).
- **The signature sequence** — keyed by node, so a wrong-**branch** / wrong-**node** regression is
  caught (e.g. a `condition` routing to the wrong arm changes which node is `node:skipped`), not just a
  dropped/extra/wrong-type event. For a deterministic fixture the **exact ordered** signature sequence
  is asserted; the `parallel` `fan-out` fixture asserts the signature **multiset** + the anchors
  (`run:started` first, the last-emitted event last), because its branch events legitimately interleave
  by async (sandbox) completion timing.

It deliberately does **not** assert `runId`, `timestamp`, cost, or duration — those are per-run (the
real CLI host uses a wall clock + random UUIDs). It also does not check transform/merge **output
values** (that is the engine's own unit-test concern); the harness gates the run's stream topology +
routing + exit code end-to-end through the CLI.

## The fixture suite (first cut)

All fixtures are **non-agent**, so runs are fully deterministic and **offline** on every PR — no LLM,
no provider key, no network. Together they cover every authorable non-agent node type and all three
run exit codes (`0` / `1` / `3`).

| Fixture | Covers | Exit |
|---------|--------|------|
| `sequential.relavium.yaml` | input → transform → output (the simplest chain) | `0` |
| `fan-out.relavium.yaml` | `parallel` split + `merge` (`object_merge`) — fan_out/fan_in | `0` |
| `conditional.relavium.yaml` | `condition` branch + `node:skipped` skip-propagation (run **both** arms: `n=3`→`lo`, `n=15`→`hi`) | `0` |
| `human-gate.relavium.yaml` | `human_gate` pause → `run:paused` → gate-paused exit; **and** (2.G) the cross-process **resume**: run to exit `3` against a durable db, then `relavium gate --approve` → `run:completed` | `3` → `0` |
| `failure.relavium.yaml` | a transform throws → `node:failed` → `run:failed` (downstream skipped) | `1` |

## Adding a fixture

1. Author a committed `.relavium.yaml` under `apps/cli/src/harness/fixtures/` (schema:
   [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)).
2. Add a `Scenario` entry to `regression.e2e.test.ts` with its `input`, expected `exit`, the expected
   `type:nodeId` signature list, and `parallel: true` only if the fixture has a `parallel` node.
   **Capture** the real signatures by running the fixture once — never hand-guess them — then pin them.

## §2.5.I extensions — concurrency, the session chain, and query-shape budgets

Phase 2.5.I extended the harness beyond the `run`-fixture stream contract, to the parts a single
`relavium run` cannot exercise: two `relavium` processes sharing one `history.db`, the chat→resume→export
journey, and the read-path query shapes. These are additive `.e2e.test.ts` suites under
`apps/cli/src/harness/`, run by the same `pnpm turbo run test` gate.

- **Concurrency e2e** (`concurrency.e2e.test.ts`, 2.5.I S3) — proves a `run` and a `chat` share one
  `history.db` safely ([ADR-0064](../../decisions/0064-live-model-catalog.md) §5). Two scenarios: an
  **in-process two-connection** coexistence case (the real `runCommand` + a real `SessionStore` interleave
  on one file — proves coexistence, not lock contention, since a single synchronous `better-sqlite3` process
  can't overlap two transactions), and a **real two-process** case where the parent holds the WAL write lock
  and releases it only after a **READY handshake** from both children, forcing genuine cross-process
  busy-wait every run. The child (`fixtures/concurrent-writer.mjs`) imports the **built** `@relavium/db` by a
  `file://` URL — so this case is skipped, visibly, when the dist is absent. The *precise* clause-guards for
  the `BEGIN IMMEDIATE` + `withBusyRetry` write path are the deterministic white-box tests in `@relavium/db`
  (`provider-store.test.ts` / `retry.test.ts`); this suite is a cross-process safety/coexistence smoke.
- **Session-chain e2e** (`session-chain.e2e.test.ts`, 2.5.I S4) — the Home→chat→resume→export journey a
  single `run` fixture cannot cover: a fresh cassette-driven session persists a turn, a `chat-resume` on a
  **fresh connection** to the same file continues it (asserting the reconstructed transcript threads into the
  resumed turn's provider request + the totals accumulate), and `exportSession` serializes it. The
  interactive ink Home/chat TUI is out of scope (no render-test dependency); this drives the session-host +
  persister + export seam the Home graduates into.
- **Query-shape perf budgets** (`perf-budget.e2e.test.ts`, 2.5.I S5) — `EXPLAIN QUERY PLAN` asserts the hot
  reads (`listSessions` / `listRuns` / `loadFull`'s messages) are **index-served with no filesort** (no
  `USE TEMP B-TREE`, no full-table SCAN) — the shape the store docs claim, not a flaky wall-clock. The store
  query sites back-reference this budget so a store `ORDER BY` edit trips the reviewer. (The sibling §2.5.I
  perf item, the 80×24 narrow-terminal degrade, is asserted in `render/tui/home-projection.test.ts`.)

### The Windows lane (2.5.I S6)

An advisory `windows-concurrency` job in [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) runs
the `@relavium/db` concurrency suite + the CLI concurrency/perf/session-chain harness on `windows-latest`
(the WAL locking, the retry's `Atomics.wait` sleep, the two-process child spawn + `file://` import, and the
native `better-sqlite3` addon are the parts most likely to diverge), plus a headless no-TTY smoke. It is a
**separate, advisory** job — the required check stays the ubuntu `ci` job. POSIX `0600`/`0700` permission
assertions are a documented Windows no-op ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md))
and are not exercised there; `release.yml` separately smokes the built binary across ubuntu/macOS/Windows.

## Deferred (scope-split in [phase-2-cli.md §2.K](../../roadmap/phases/phase-2-cli.md))

- ~~**Gate-*resume* scenario** (`relavium gate --approve` → completion)~~ — **landed with 2.G**: the
  harness runs the `human-gate` fixture to exit `3` against a durable (in-memory) history db, then resumes
  it from a fresh-process `relavium gate --approve` (reload snapshot + reconstruct checkpoint +
  `resumeFromCheckpoint`) and asserts `run:completed`. This closed 2.K's deferred half.
- **Agent fixtures via recorded-LLM replay** — the `@relavium/llm` `conformance/replay.ts` substrate
  (a recorded-`fetch` override that refuses secret bodies) can drive an agent workflow offline through
  the injectable `ProviderResolver`; deferred so the first cut stays non-agent. Agent dispatch is
  already covered by the `packages/core` agent-runner tests and the `@relavium/llm` conformance suites.
- **Nightly live-provider lane** — a scheduled, secret-gated lane that runs the agent fixtures above
  against real providers. It activates **alongside** the reserved per-provider-conformance `live-api`
  job in `.github/workflows/ci.yml` (`on: schedule`, keys from secrets) — that reserved job runs the
  `@relavium/llm` conformance suites, not the CLI harness, but the maintainer decision (deferred-tasks)
  is to enable both together. It never gates a PR.
