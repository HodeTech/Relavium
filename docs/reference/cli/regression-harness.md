# Engine Regression Harness (2.K)

> Last updated: 2026-06-22

- **Status**: Reference (Living) — the canonical home for the harness fixture + scenario format.
- **Surface**: CLI (`relavium`), adopted as the engine's end-to-end regression gate.
- **Scope**: Phase 2, build workstream **2.K**; completes milestone **M3** with 2.D + 2.F.
- **Related**: [commands.md](commands.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../../decisions/0049-cli-machine-output-contract.md](../../decisions/0049-cli-machine-output-contract.md), [../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md), [../../standards/testing.md](../../standards/testing.md), [../../tutorials/cli/run-a-workflow-in-ci.md](../../tutorials/cli/run-a-workflow-in-ci.md)

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
| The harness suite (in-process vitest e2e) | `apps/cli/src/harness/regression.e2e.test.ts` |

The harness is an **in-process** suite: it drives the CLI's `runCommand` boundary with a captured
`CliIo` through the **default engine** (the standard node executor + expression sandbox over the real
`createCliHost`), exactly as a real `relavium run --json` invocation does (the same
`createJsonRenderer` produces byte-identical NDJSON). It does **not** spawn the built binary — that
would add a build dependency and process flakiness for no fidelity gain. It runs inside the standard
`pnpm turbo run test` task, so it is part of the required CI gate on every push/PR
(`.github/workflows/ci.yml`).

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
| `human-gate.relavium.yaml` | `human_gate` pause → `run:paused` → gate-paused exit | `3` |
| `failure.relavium.yaml` | a transform throws → `node:failed` → `run:failed` (downstream skipped) | `1` |

## Adding a fixture

1. Author a committed `.relavium.yaml` under `apps/cli/src/harness/fixtures/` (schema:
   [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)).
2. Add a `Scenario` entry to `regression.e2e.test.ts` with its `input`, expected `exit`, the expected
   `type:nodeId` signature list, and `parallel: true` only if the fixture has a `parallel` node.
   **Capture** the real signatures by running the fixture once — never hand-guess them — then pin them.

## Deferred (scope-split in [phase-2-cli.md §2.K](../../roadmap/phases/phase-2-cli.md))

- **Gate-*resume* scenario** (`relavium gate --approve` → completion) — needs the `relavium gate`
  command (**2.G**) and durable run history (**2.H**); neither exists yet, so the CLI cannot reload and
  resume a paused run across processes. The run-to-gate → exit `3` half ships now; the approve →
  complete half lands with 2.G/2.H. (The engine's resume is already proven in `m2-e2e-harness`.)
- **Agent fixtures via recorded-LLM replay** — the `@relavium/llm` `conformance/replay.ts` substrate
  (a recorded-`fetch` override that refuses secret bodies) can drive an agent workflow offline through
  the injectable `ProviderResolver`; deferred so the first cut stays non-agent. Agent dispatch is
  already covered by the `packages/core` agent-runner tests and the `@relavium/llm` conformance suites.
- **Nightly live-provider lane** — a scheduled, secret-gated lane that runs the agent fixtures above
  against real providers. It activates **alongside** the reserved per-provider-conformance `live-api`
  job in `.github/workflows/ci.yml` (`on: schedule`, keys from secrets) — that reserved job runs the
  `@relavium/llm` conformance suites, not the CLI harness, but the maintainer decision (deferred-tasks)
  is to enable both together. It never gates a PR.
