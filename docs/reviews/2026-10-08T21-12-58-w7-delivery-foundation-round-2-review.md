# Review: W7 delivery and receipt-lifetime foundation, round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0103_foundation_r2_authority`, `/root/adr0103_foundation_r2_joins`
- **Subject**: Cumulative `7adec7fb..352c139e`, excluding the unrelated Sonar record
- **Outcome**: Accepted within the internal foundation scope; no new findings

## Complete independent review

Two fresh reviewers inspect the eight original foundation paths, the native-observer
correction, lifecycle documentation, round-1 record and its index entry. Authority uses
`gpt-6-astra`, xhigh; joins uses `gpt-6.1-sol`, xhigh. Both report zero Blocker, High,
Medium and Low findings. Uncommitted Step 7 work is excluded.

Registration precedes factories; raw Promise identity, independent entered-work/child
lifetimes, original rejection values and quiescence rechecks hold. Captured native
observation bypasses overridden `then`. Constructor/species observation failure retains
pending lifetime and authority with sticky content-free diagnosis, even if another
observer subsequently sees settlement. Earlier native reactions may enter work before
the registry reaction; that entered work remains joined within the documented observable
completion boundary. This does not promise synchronous Promise-state introspection.

Publication precedes offering. Buffered pulls and waiting handoffs advance actual delivery
synchronously; passive observers, empty pulls, concurrent-pull refusal, closure and return
cannot acknowledge delivery. Gap and early abandonment remain sticky after draining.
Execution-local counts do not derive authority from durable sequence numbering. Existing
backpressure, run filtering, terminal and session compatibility controls remain intact.
Neither reviewer finds a scoped dependency, platform/vendor import, unsafe type escape,
secret or durable-schema violation.

## Independent verification and limits

Each reviewer independently passes **75 tests across seven actual suites under `CI=true`**:
registry, primary delivery, event stream, run handle, terminal handling, session handle
and event bus. Both pass scoped ESLint, pinned formatting and committed-range diff checks.

Authority passes twelve frozen-source in-memory scenarios / forty-five assertions and
two additional predecessor controls reproducing false completion through overridden
`then` and constructor failure. Joins passes fifteen positive frozen-source scenarios,
twelve separate causal removals and a fresh restored run. Its removals target publication,
both delivery paths, gap, abandonment, root/entered/child registration, authority
retirement, quiescence rechecks, native observation and observation-fault retention.
These JavaScript controls are not shipping engine, SQLite or CLI integration tests.

Joins additionally typechecks seven frozen source/test roots against the actual core
configuration origin and four production roots against the purity configuration with
`types: []`; both have zero diagnostics. An initial mutation-harness assertion inside a
factory induced an unhandled rejection; moving the assertion outside corrects the harness.
An initial virtual typing setup omitted the configuration origin and could not resolve
Node types; supplying it corrects the setup. Only corrected successful runs are counted.

Neither reviewer runs full CI/coverage, edits shared source, switches branches, calls a
provider or reads private/key data. Parent's subsequent composed working-tree
`CI=true pnpm run ci` passes, including tests, lint/typecheck, build/format, database checks,
fences and all three offline smokes. That includes separately uncommitted Step 7 work;
it is not an exact-commit whole-wave acceptance claim or a GitHub CI result.

## Remaining work

The corrected internal foundation is accepted. Departure, engine producer retirement,
retained ownership, ordered late writers, final receipt disposition, checkpoint timing,
CLI input acknowledgement and host closure remain unimplemented. The paused-host lifecycle
High, production request ownership, Step 7 reviews, Step 8 and whole-wave Step 12 remain
open. No complete ADR-0103 or W7 acceptance is claimed.
