# ADR-0049: CLI machine-output contract (`--json` NDJSON stream + stderr diagnostics)

- **Status**: Accepted
- **Date**: 2026-06-22
- **Related**: [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md), [ADR-0047](0047-cli-framework-commander-ink-clack.md), [sse-event-schema.md](../reference/contracts/sse-event-schema.md), [commands.md](../reference/cli/commands.md), [error-handling.md](../standards/error-handling.md)

## Context

Workstream 2.F formalizes the CLI's machine-readable path — the contract a CI job
pipes and asserts on. The `relavium run` command (2.D) already streams a workflow's
[`RunEvent`](../reference/contracts/sse-event-schema.md)s through a `RunRenderer`
seam, with a minimal NDJSON renderer and the terminal-event→exit-code mapping in
place. What was **not** yet pinned is the *contract*: exactly what appears on stdout,
where a pre-run CLI fault goes, and when NDJSON engages. Three forces frame it:

- **2.F's acceptance bar** (phase-2-cli.md §2.F): "every line is a schema-valid
  `RunEvent` in `sequenceNumber` order; stdout contains no non-JSON bytes."
- **The event envelope is already canonical** (sse-event-schema.md): each event
  carries `type` / `runId` / `timestamp` / `sequenceNumber`, stamped by the bus;
  the stream is "versioned by additive evolution," with no wrapper or version field.
- **2.D writes a `{ type: 'error', code, message }` envelope for a pre-run CLI fault**
  (bad arguments, workflow-not-found, missing key) to **stdout** under `--json`. That
  object is *not* a `RunEvent` (no `runId`/`sequenceNumber`; `type: 'error'` is outside
  the union) yet shares the `type` discriminant — so it both pollutes a "pure RunEvent"
  stdout and lets a consumer keying on `type` confuse it with a stream event.

This contract is what 2.K asserts on and 2.G / 2.R consume, so an ambiguous shape
would be baked into every CI integration and is expensive to change later.

## Decision

**Under `--json`, stdout carries ONLY the run's `RunEvent` NDJSON stream (one serialized
event per line, in `sequenceNumber` order); stderr carries ALL diagnostics, including the
structured `{ type: 'error' }` CLI-fault envelope; and the process exit code is derived
from the terminal event.** Concretely:

1. **stdout = the RunEvent NDJSON stream, verbatim.** Each line is one `RunEvent`
   serialized as-is — no wrapper, no stream header, no version line (the envelope is
   already stable per sse-event-schema.md). Every event the bus emits flows through
   unfiltered (including `cost:updated`, `node:retrying`, `budget:*`, `media_job:*`, and
   both `human_gate:paused` and the aggregate `run:paused`). Secret-typed values are
   already masked by the engine (`MaskedSecret`); the renderer passes them through and
   never unwraps them.
2. **The terminal `run:completed` event *is* the "final result line."** It already
   carries `outputs` + `totalTokensUsed` + `totalCostMicrocents` + `durationMs`; we do
   **not** emit a separate, non-`RunEvent` summary line. (A `run:failed` terminal carries
   `error` + `partialOutputs`, and `run:cancelled` carries only the base envelope — so for
   those a consumer reads run totals from the last `cost:updated.cumulativeCostMicrocents`,
   not from a terminal-line total.)
3. **A pre-run CLI fault's `{ type: 'error' }` envelope is written to stderr** (it was on
   stdout in 2.D). stdout stays pure `RunEvent`s — or empty when the run never started;
   under `--json` the fault is emitted as JSON on stderr, as human text otherwise.
4. **NDJSON is `--json`-gated.** A non-TTY or `CI=true` environment disables the
   interactive TUI (a TTY-only affordance, 2.E) but does not by itself switch stdout to
   NDJSON; without `--json`, a non-interactive run uses the plain line-per-event human
   renderer.
5. **Exit code from the terminal event:** `run:completed`→`0`, `run:failed`/
   `run:cancelled`→`1`, a non-interactive `run:paused`→`3` (the run's aggregate suspension
   event — a human/approval/budget gate in the non-interactive path; the CLI reacts to
   `run:paused`, not the per-gate `human_gate:paused`); a pre-run CLI fault is `2` (invalid
   invocation). The canonical table is [commands.md](../reference/cli/commands.md#exit-codes).
6. **Scope — the contract governs a workflow *run* (`relavium run --json`).** `--help`,
   `--version`, and a bare no-command invocation are exit-`0` *meta-operations*: they produce
   no run and no event stream, and print their human text (usage / version string) to stdout
   per the Unix convention, `--json` notwithstanding. `--json` selects the machine RUN-output
   format; it is not a global "emit JSON for everything" switch. (A future machine-readable
   `--help` is a separate, non-gating candidate noted in commands.md.)

Considered **keeping the `{ type: 'error' }` envelope on stdout** with a renamed
discriminant (e.g. `kind: 'cli_error'`) so a consumer could still tell it apart —
rejected: it keeps a non-`RunEvent` line on the "pure" stream, contradicts 2.F's purity
acceptance, and forces every consumer to special-case two top-level shapes on one stream.
Considered **auto-engaging NDJSON under `CI=true` / no-TTY** (the literal 2.F task
wording) — rejected: it conflates "no TUI" with "machine format" and surprises a human
who pipes a run (`relavium run wf | tee log`); `--json` is the unambiguous opt-in and
matches the commands.md Output-modes table. Considered a **separate synthetic summary
line** for totals — rejected: `run:completed` already carries them, and a synthetic line
breaks the schema-valid-line invariant. The choice aligns with
[error-handling.md](../standards/error-handling.md) (errors surfaced *through* a run use
`run:failed`/`node:failed`, never a `type: 'error'`), so `type: 'error'` is by
construction only ever a CLI-boundary diagnostic.

## Consequences

### Positive

- stdout is a single, uniform, schema-valid `RunEvent` NDJSON stream — a CI consumer
  parses every line identically and never filters noise; faults travel out-of-band via
  the exit code + stderr.
- No new envelope, no `@relavium/shared` change, no new exit code: the contract reuses
  the already-canonical `RunEvent` envelope and the existing exit-code table, realizing
  (not changing) ADR-0036's terminal-event invariant and ADR-0047's
  renderer-over-one-bus topology.
- `type: 'error'` can never collide with a `RunEvent` `type` on stdout, because it is
  confined to stderr.
- Machine output is explicit (`--json`), so the default piped/CI experience is
  unsurprising and the NDJSON contract is produced only when asked for.

### Negative

- Moving the CLI-fault envelope from stdout to stderr **reverses a shipped (2.D), tested
  behavior**: the 2.F implementation rewrites the affected boundary-test assertions, and
  any consumer reading the fault envelope from stdout must read stderr instead. Mitigation:
  2.D shipped days earlier with no external consumers; the new contract is the one 2.F
  documents and tests going forward, and the exit code (`2`) already signals the fault
  unambiguously.
- A `--json` consumer that wants the structured fault detail must read stderr, not stdout.
  Mitigation: 2.F documents this in commands.md + the CI tutorial; the exit code is the
  primary fault signal and an empty stdout on a fault is itself a clear indicator.
- `--json`-gating diverges from the literal 2.F task prose ("auto-engage under no-TTY /
  CI=true"). Mitigation: this ADR realigns the phase-2-cli.md §2.F task to the
  `--json`-gated rule, and 2.F refines the commands.md Output-modes table to state it
  explicitly, so spec and behavior agree.
