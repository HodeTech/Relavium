# Usage coverage causal controls

This offline required-CI and author/reviewer command exercises ADR-0104's eight acceptance groups against
physical copied sources. It supplements ordinary package tests; a successful invocation
is not independent review, provider evidence, an invoice claim or whole-W8 acceptance.

```sh
pnpm check:usage-mutations
```

A targeted diagnosis can run one declared mechanism with
`pnpm check:usage-mutations --mechanism native-whole-zero`. The result explicitly records that
selection; it is not a complete eight-group result. No test-name filtering is used.

## Execution and evidence

The runner captures tracked and nonignored authored untracked source, fixtures, migrations,
configuration and current replay tools into physical OS-temp files. It compares the complete
source inventory, HEAD and logical index before and after capture and execution. Concurrent
source edits invalidate the invocation. The developer checkout, installed dependencies and
frozen replay bytes are never mutated. Keep the source stable while running this command.

Each entry in [mutations.mjs](mutations.mjs) removes one declared accounting mechanism in the
copy. Its fixed, mutated and byte-exact restored phases run the same whole files in fresh
processes with independent caches and reports. The runner retains complete case identities,
statuses and diagnostics. A nonzero exit alone never establishes causality: the declared
semantic assertion must fail at its predeclared whole-file case identity and fixed signature in
[causal-witnesses.mjs](causal-witnesses.mjs). An unrelated assertion, even in the same file, cannot
certify removal. Negative orchestration controls reject unrelated markers/cases, runtime failures,
empty inventories and failed or absent positive controls. Import, collection, readiness and timeout failures invalidate the
control. The exact-query mutation is deliberately outcome preserving: only the native SQL
`USAGE_QUERY_NOT_EXACT_IDENTITY` guard fails; the whole activation file stays positive.

Node and Vite share six exact workspace mappings: shared, llm, llm/adapters, core, db and mcp.
Unknown workspace subpaths and unowned physical source/dist targets are refused. Every admitted
installed external file is pinned by physical package, size and SHA-256; Node's CommonJS entry
also checks the real resolved target before executing it. Native SQLite uses the installed
platform ABI, with captured bytes, rather than claiming a portable historical native binary.

Source instrumentation records module-body entry, not execution of a particular mutated branch.
Behavioral causality comes from the separate fixed/removal/restored semantic case and signature.
Source instrumentation inserts a synchronous call into the evaluated module body without
rewriting physical product files. It preserves TypeScript source maps and the hashbang. The
runtime record includes the actual PID/thread, physical source path, original raw-source SHA,
manifest SHA and fixed/mutated/restored identity. Loader/transform activity is preparation only.
The exact native-test `ts-resolve-hook.mjs` helper has a separate loader-thread preparation
journal; all product-runtime witnesses require thread zero. An unexpected threaded source body
invalidates the run. Child commands own a POSIX process group so timeout cleanup kills descendants
and awaits close; Windows follows the existing single-child best-effort cleanup convention.
Native crash controls additionally require the actual invoked CUT, SIGKILL and joined close,
plus worker, database and mechanism module-body records from that child's PID.
The permanent cohort also pins exactly one loaded-but-unready startup control. It must
record spawn → WAITING (not a readiness barrier) → readiness timeout → joined SIGKILL
close in that order, with the same child/caller identity and actual DB/worker source-body
witnesses. Only that declared control may omit CUT/LOCKED; ordinary children still
require their real barrier. Direct negative controls reject missing/reordered/foreign
records, a normal exit or an undeclared child trying to use the exception.

The [frozen replay driver](../budget-replay-compat/README.md) independently owns its current and
predecessor source/dependency boundaries. Current producer bytes join this runner's manifest;
frozen bytes retain their Git/archive/supplement authority. The ordinary-gate predecessor runs
before the basis assertion. Session round trips exercise all eight old writer operations,
subsequent new writes and estimate release. Default required replay smoke assertions remain.

All raw evidence is retained under the printed `relavium-usage-controls-*` OS-temp directory,
including incomplete invocations. `summary.json` reports completion only after exact restoration,
identical case inventories and final source/dependency identity checks. The extracted native and
shared 100,000-case scale files run separately from repeated small mutation cohorts; permanent
crash, lock, receipt and scale tests remain part of ordinary package CI.

Each ordinary phase retains its five-minute outer watchdog. The one complete permanent
cohort pins 429 cases and 71 joined native children, including Wave 2's two DB readiness
controls. Its outer watchdog is calculated from the existing five-minute setup/general
allowance, 71 existing 20-second native-case bounds and the existing ten-minute DB scale
bound (38 minutes 40 seconds total). Individual test/readiness
bounds, both full 100,000-case scale controls and process-group cleanup remain in force.
The watchdog and exact case/native counts are recorded and checked; an incomplete or
shortened cohort cannot pass. The TypeScript compiler is physically verified on its first
load per owned runtime state and reused for that state's transforms; every product-source
transform still verifies its own physical bytes. Final dependency checks remain mandatory.

The governing contracts are [ADR-0104](../../docs/decisions/0104-unknown-provider-usage-is-durable-cost-uncertainty.md),
[usage evidence](../../docs/reference/shared-core/llm-provider-seam.md#6-usage),
[coverage events](../../docs/reference/contracts/sse-event-schema.md#the-runevent-union) and
[session persistence](../../docs/reference/shared-core/database-schema.md#session-usage-coverage-foundations--adr-0104).

## Required CI and bounded metadata retention

The complete command runs in its own offline `usage-mutations` job on the frozen installed
lockfile. The existing required `ci` job waits for it and the wire controls, and explicitly
rejects failure, cancellation, skipping or absent results. Local `pnpm run ci` runs both full
commands too. This arrangement requires no branch-protection setting change. Targeted diagnosis
never replaces the full 23-mechanism/eight-group command or its permanent native/100,000-scale cohort.

When `RELAVIUM_ACCEPTANCE_EVIDENCE` names an outside-source directory, the runner exports only
allowlisted reports, process diagnostics and module journals, including incomplete-run evidence.
Export is bounded to 20,000 files/256 MiB and never includes the copied graph, native databases,
caches or executable dependency archives. CI retains that metadata for seven days. The full raw
OS-temp evidence remains available locally; a failed export cannot replace the primary control
failure. A hard-killed process may leave incomplete metadata, which cannot certify acceptance.
