# Shared causal execution

The filesystem and secrets entry points call one `runControls` implementation.
Only these two evidence families and their exact shared/family tool roots are
admitted. Mechanisms and workloads remain family declarations; the established
usage/wire runners are unchanged.

Each control executes fixed, mutated and restored physical source with identical
complete case inventories. An exact single-site anchor, named completed semantic
`AssertionError` carrying the declared marker, copied target body evaluation and
source/dependency fences are required. Native child targets additionally require
their target and fixture body records in the same child PID, a parent-process link,
and that child's pinned dependency-load receipts. Setup/import failures, skips,
empty inventories, timeouts, signals, output overflow, plain marker-bearing runtime
errors and unjoined children cannot establish removal. Additional consumer witnesses
are declarative, including both ancestor ports and deletion GC.
Before the first fixed phase, the coordinator checks every selected anchor against
the copied, pinned source graph. A stale later declaration therefore stops the
whole selection without completing earlier mechanisms; mutation-time exact checks
remain in place as a second integrity check.

Each phase retains the existing 90-second joined process and 15-second case/hook
bounds, one fork and a combined decoded-output limit of 8,388,608 UTF-16 code units.
An owned Vitest setup hook checks each collected case's effective timeout and
refuses `vi.setConfig` test/hook overrides above 15 seconds. A copied-source
TypeScript syntax preflight refuses over-budget or dynamic direct hook timeouts,
which Vitest does not expose through the test context. These are admission checks
on the selected cohorts; arbitrary hook registration through unreviewed aliases
is outside the structural check. Phase timeout and process join remain separate.
POSIX process groups are owned and killed/joined. Windows retains the existing
limitation: child-process closure is joined but descendant tree ownership is not
asserted.

The filesystem environment stays byte-for-byte equivalent to its predecessor.
Secrets use a small operational environment with scratch HOME and no inherited
credentials. Both generic and selected-family directories are captured physically;
new, deleted, changed or symlinked tooling entries refuse. Phase manifest, runtime,
configuration and dependency metadata must remain unchanged. Every target needs
real body evaluation, not just transformation.

Evidence retains JSON/JSONL metadata, one bounded binary `stdio.bin` per completed
phase, and lossless gzip archives of native and parent source/dependency evaluation
JSONL and exact phase source manifests. The stdio envelope contains two 32-bit byte lengths followed by the exact
original UTF-8 stdout and stderr log bytes; `process.json` retains each stream's byte
length and SHA-256. The standalone verifier reconstructs both streams, checks the
lengths, hashes and decoded process-output bound, and refuses a missing, redirected,
truncated or overlong envelope. This replaces two per-phase log files without
diluting the unchanged 2,000-file or 64-MiB retained ceilings. Each evaluation
archive index retains every original
receipt name, PID/thread/stage record byte, offset, length and digest. Its bounded
verifier checks paths, segment continuity, counts, hashes, and decompression length;
raw receipts also have independent 64 MiB input, 2,000-file and 1,024-byte relative
path bounds before encoding. Receipt directory enumeration is streamed up to that
file cap. Index entries have a running byte budget before the
final JSON serialization. The standalone receipt verifier bounds its own index plus
archive bytes; the exporter separately enforces the whole evidence-tree cap. Complete
phase manifests are packed only during export into `source-manifests.json.gz` and
`source-manifest-index.json`. The latter records each original portable phase path,
contiguous offset, byte length and SHA-256, plus archive raw/compressed lengths and
hashes. The standalone decoder reconstructs the exact original JSON bytes, checks
every source pin, joins each retained runtime hash and completed-summary phase, and
rejects trailing gzip data or a second member. Completed summary IDs must be unique
and have all three physical, hash-joined runtime records. A complete summary permits
no unreported phase tail. An incomplete summary may contain at most one additional
control, whose indexed phases form a contiguous fixed → mutated → restored prefix.
Every predecessor needs its physical, hash-joined runtime; only the last attempted
phase may lack one after interruption before runtime creation. All three attempted
phases may remain unreported if failure precedes the completed-mechanism record.
This checks local phase structure, not the external cohort's natural control order
or its exact declaration inventory; independent acceptance audit still supplies
those joins. Raw manifest input,
index assembly and decompression have independent 64-MiB, 2,000-file and
1,024-byte-path bounds; the unchanged whole-export 2,000-file/64-MiB limit also
counts the archive, index and final `export.json`. A complete 99-control filesystem
matrix projects 1,789 retained files: 99 × 21 + 5 minus 297 individual manifests
plus two archive records. This is capacity arithmetic, not a completed capture.
Complete
case inventories remain in each Vitest result and phase summary; the duplicate
control-only `cases.json` is omitted. Export excludes graph/cache/home and unrelated
binary files; only the bounded evaluation archives and exact per-phase `stdio.bin`
are retained. It cannot overwrite an existing destination or enter the repository or
scratch tree through a symlink. The bound includes the final export record: at most
2,000 retained files and 64 MiB. Export and cleanup failures preserve the earlier
failure.
Selected runs never claim complete-matrix acceptance. Source HEAD and working-tree
capture attribution describe the execution actually performed.

The permanent coordinator integration guard runs three bounded actual captures.
Each family proves synthetic fixed/red/restored execution before a real assertion
or import failure. Both failed-prefix exports retain and decode every created phase
manifest with its original bytes and runtime hash. The integration checks actual restored
hashes, main-thread body evaluations, complete identical inventories, removed
scratch and unchanged developer bytes/HEAD/index. The synthetic target/cases are
owned tooling fixtures selected only by this guard, outside product/workspace
inventories. A third secrets capture forces export refusal after the import failure
and verifies primary-failure precedence, scratch cleanup and source restoration.
Failure restoration receipts remain in the coordinator summary.
Additional bounded negative captures prove that a stale second anchor starts no
phase and that both effective case and configured hook overrides above 15 seconds
fail before they can be treated as causal evidence.
