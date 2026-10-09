# W7 raw provider round-2 custody correction

- **Type**: Code + Security
- **Date**: 2026-10-09
- **Reviewer(s)**: @codex — Parent audit of the lifecycle reviewer's separately sealed correction
- **Scope**: Verification custody only; the accepted [round-2 record](2026-10-09T03-25-00-w7-raw-producer-round-2-review.md) remains unchanged
- **Decision**: Retain scoped acceptance and explicitly withdraw the helper's direct-tool proof credit

The lifecycle reviewer acknowledges the Parent-discovered nested package-manager call in the
unchanged DB-sync helper. Its success path invoked `pnpm`, and the retained private cache
contains 1,140 Corepack entries including pnpm 9.12.3. The original assertion of no
pnpm/Corepack/network calls is withdrawn. No original executable/PATH resolution, initial
external-cache inventory, subprocess transcript or network trace exists; the final cache
does not reconstruct these missing receipts. The helper also ignored Git's exit status in
this private archive without `.git`, so its success log alone does not prove a Git drift check.

Parent reads the complete separate addendum and independently verifies its bound retained
inputs, cache subset and unchanged original seal. Addendum SHA-256:
`21fd81679a26931b316a683ec9458ced81eb217f61842eec462df29cb473dbec`;
inspection receipt:
`9a84b23ceee8b2fd10af8e1b8510fe4f1c810403a1dc1df7cb77b4958a0e5f2c`;
retained Corepack subset:
`68ec5f9b9b592438d64800ab3e869a9a2c2c911224cb9969ad716437c96e2e3a`;
addendum seal:
`be313865721c4f98d113c77f9362a993d7cefd6b6ac95cdf4bd4a33e7f628d89`.
Evidence is outside the original sealed root at
`/tmp/relavium-c1-r2-lifecycle-correction-wr9o12d5`; the Parent audit is
`/tmp/relavium-c1-r2-lifecycle-addendum-root-audit.json`.

The original 7,853-entry lifecycle inventory, complete report and seal remain intact.
Independent source/export restoration and whole shared-tree equality still hold; all 38
private drizzle entries also remain identical in bytes and metadata. Neither the helper
result nor Parent's separate main CI is substituted for the missing reviewer receipt.
The correction changes no product finding and grants no additional ADR-0103, Step 8,
Step 12, W7 or PR acceptance. The next HTTP increment has its own fresh review rounds.
