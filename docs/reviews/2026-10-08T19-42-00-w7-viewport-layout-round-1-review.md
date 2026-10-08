# Review: W7 viewport layout acknowledgement, round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_ci_viewport_round1`
- **Subject**: `a2c727e1..34add71c`, three CLI paths on `development`
- **Outcome**: Approved

## Summary

The first fresh independent review finds no scoped defect. A deterministic actual-Ink
control proves removal of the passive-effect scheduling dependency during keyed reseat.
It does not reproduce the historical exact-head GitHub CI failure or establish its complete
root cause; current required CI remains necessary. A second fresh review follows.

## Findings

No findings: Blocker 0, High 0, Medium 0, Low 0. Geometry and re-windowing complete in layout;
zero-height clipping still publishes an empty displayed range. Geometry alone does not
acknowledge output: actual flush and writable-stream checks remain mandatory. Home retains
undisplayed evidence and permits a later successful activation.

## Coverage and verification

The reviewer used `gpt-6.1-sol`, high effort, and read all three changed files and surrounding
transcript acknowledgement, clipping, scroll geometry, activation and installed Ink
commit/flush behaviour. The CLI sources matched the reviewed commit.

- `CI=true`: five files / 146 tests pass.
- `CONTINUOUS_INTEGRATION=true`: three files / 73 tests pass.
- An in-memory `esbuild` control with actual Ink observes usable/clipped/restored windows
  `12..40`, `40..40`, `12..40` and matching layout geometry. Changing only the viewport hook
  to passive `useEffect` leaves all immediate windows empty and geometry stale.
- Existing production-mount driver controls include actual `debug:false` output, one-row
  evidence retention, fresh activation and output close/error.

Installed Ink computes Yoga before React layout effects. Its flush joins synchronous React
work, pending render/log output and the native stream callback. The in-memory control itself
uses testing-library/debug rendering; the existing driver supplies actual production-mode
wire controls. No new dependency, unsafe typing, seam violation or spec change is introduced.

Parent fresh verification passes 23 repository lint/typecheck/test tasks and six build targets,
plus the 69-test focused CI run. Implementation checks also passed both CI environments and
119 renderer tests. The reviewer did not run full repository or current GitHub checks, mutate
sources, access keys/network, or inspect unrelated in-progress LLM changes.

## Follow-ups

Obtain a fresh second scoped review, then verify exact-head required GitHub CI. Do not infer
whole-wave acceptance or the historical failure's complete cause from these deterministic checks.
