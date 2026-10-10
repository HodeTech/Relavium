# W7 inert request graph foundation — round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_inert_graph_round1`; parent `/root`
- **Subject**: complete `19f56067..8dbf0286`, internal graph foundation for Accepted ADR-0102
- **Outcome**: Changes requested — two High and one Medium verified and corrected; fresh round 2 required

## Findings and corrections

1. **High — ordinary array length reads execute caller code.** The initial helper reads
   `source.length`. A transparent array proxy can execute its ordinary-read trap even when
   reflection exposes inert descriptors. Parent confirms the defect and now captures the own
   length data descriptor once, validates its numeric bounds and uses that captured value.
   Empty and dense proxy controls require zero ordinary reads and baseline serialization.
2. **High — changed prototypes hide unsupported boxed native brands.** A boxed Boolean with
   null prototype is serialized natively as `true`, but the original helper captures `{}`.
   Parent confirms this and related boxed/Date cases. Captured intrinsic receiver-brand probes
   refuse these values without consulting caller getters or conversion hooks. Explicit controls
   cover null and ordinary replacement prototypes. This does not claim arbitrary custom-class
   origin detection after its observable prototype/shape has been replaced, or a hostile-host
   JavaScript sandbox.
3. **Medium — mutable working aliases lacked their own discriminating control.** The original
   test asserts only the frozen capture alias. It now checks equality and mutation through both
   working schema paths, while the owned graph and a second working copy remain unchanged.

## Review and verification

The reviewer (`gpt-6.1-sol`, `high`) reads all three changed files and all 381 added lines,
Accepted ADR-0102 including dated qualifications, the reviewer protocol and relevant standards.
Its fresh focused execution passes 28/28 before these additional regressions; it independently
verifies the two defects. Parent reads the complete report, confirms the mechanisms, implements
corrections and extends the focused suite to 36 passing cases.

Three separate Parent causal removals fail the intended controls: ordinary length access fails
both proxy cases; removing intrinsic brand refusal fails five native-brand cases (boxed String
also refuses through its unsupported non-enumerable length); removing only mutable-copy alias
memoization fails the cross-field working-copy control. Exact source restoration is byte-checked:
`a214eb2a9cde9cf571821f75b266fa4d0f144e54bea51e47aaf243aa7c876a82`.
The restored focused suite passes. Parent full lint/typecheck/test passes 23/23 tasks (15 fresh,
eight cached); build passes six/six (one fresh, five cached). The offline overflow smoke also
passes while the independent capture increment is staged. Initial local test parameterisation,
strict-type and lint failures are corrected; they are not counted as passing verification.

Within this foundation the reviewer clears iterative active-cycle/completed-alias handling,
null-prototype data, generated array shadows, undefined/nonfinite values, caller mutability,
Map/Set ignored entries, key refusal and fixed error privacy. No dependency, vendor type,
platform import, unsafe cast, `any`, log or key access is introduced.

## Limits

This increment is internal and not yet wired into request capture, chain/adapters, core round
handoffs or media resolution. It does not close ADR-0102, the ownership High or SDK acceptance.
Fresh corrected-foundation review is required before proceeding to that integration. ADR-0103,
Steps 7–8/12, required red-CI investigation, Sonar and full W7 acceptance remain open. No live
call is required by or performed for this graph review; provider evidence is a separate workstream.
