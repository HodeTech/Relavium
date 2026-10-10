# Review: W7 viewport layout acknowledgement, round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_ci_viewport_round2`
- **Subject**: `a2c727e1..34add71c`, with the first-round record at `88d774de`
- **Outcome**: Approved

## Summary

The second fresh review accepts the narrow viewport scheduling correction. Geometry remains
separate from terminal-write acknowledgement. This does not establish the historical GitHub
failure's complete cause, current remote CI success, ADR-0103 acceptance or whole-wave acceptance.

## Findings

No findings: Blocker 0, High 0, Medium 0, Low 0. The zero-height seed and clipping checks are
preserved. Home retains undisplayed evidence, accepts later activation and refuses output
close/error. No public seam/specification, dependency or unsafe typing change is introduced.

## Coverage and verification

The reviewer used `gpt-6-astra`, high effort, and read all three changed files in full,
their first-round record and surrounding visibility/write acknowledgement, activation,
retention, scroll geometry and installed Ink commit/flush behaviour. Sources matched the commit.

- `CI=true`: eight actual files / 178 tests pass across two runs.
- `CONTINUOUS_INTEGRATION=true`, with `CI` unset: three files / 73 tests pass.
- Actual in-memory Ink with `debug:false`, `interactive:true` immediately reports usable,
  clipped and restored keyed windows. Changing only the hook to passive `useEffect` makes
  all three immediate windows empty.
- 100 same-key resize/footer transitions preserve frozen offsets and correct geometry,
  settling within four layout callbacks per update.
- Actual `useVisibleRenderFlush` stays pending while native writable callbacks are held,
  then resolves after release. Zero-capacity and scrolled-away notices refuse; restored
  tail-follow accepts a newly published notice.

Preliminary custom probes had an overly tight aggregate callback bound, omitted a synthetic
Socket's buffered `_writev` override, and used a shrinkable header that did not guarantee zero
capacity. Corrected controls pass; those harness failures are not product findings. These
probes use synthetic owned streams and an in-memory store stub; committed Home tests provide
native SQLite retention controls.

No files were edited, no branch switched and no full repository, network/key/provider or
paid operation was performed. Unrelated LLM/capture work was excluded.

## Follow-ups

Verify required GitHub CI on the exact pushed head. The scoped correction is accepted;
remaining ownership/lifecycle, provider evidence and W7 acceptance gates stay open.
