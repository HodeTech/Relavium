# Filesystem policy causal controls

`pnpm check:fs-mutations` runs the bounded ADR-0105 mechanism-removal matrix on
physical byte copies outside the checkout. `--mechanism <declared-id>` supports
local diagnosis and never reports whole-matrix completion.

Each declared mechanism requires fixed/red/restored runs, identical complete named
case inventories, an exact single source anchor, and the declared semantic assertion
marker in its named regression. Import, setup, signal and timeout failures cannot
certify removal. Shared ancestor controls must fail through both the real tool host
and DB `save_to` ports. The compact control-only case file complements the ordinary
native regression suites; it does not claim every filesystem operation is mutated.

The runner reuses the existing usage-control physical source fence and runtime
body-evaluation witnesses. Every workspace seam resolves to the copied current
source, including `@relavium/shared` and `@relavium/db`; installed dependencies are
linked for reads and verified unchanged. Source/HEAD/index digests are checked after
the run, so run this against a stable checkout. Tests never mutate developer sources.
No Windows-only test is selected; native Windows evidence has its separate gate.

`RELAVIUM_ACCEPTANCE_EVIDENCE=/absolute/directory` retains bounded JSON/JSONL/log
metadata under `filesystem/`, outside authored source. It excludes the copied graph,
cache, native databases and dependency bytes. Scratch copies are removed even on
failure. A passing matrix supplies causal evidence; independent implementation
review and the full required gates remain separate obligations.
