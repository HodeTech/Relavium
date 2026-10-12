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

Each phase retains the existing 90-second joined process and 15-second case/hook
bounds, one fork and a combined decoded-output limit of 8,388,608 UTF-16 code units.
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
JSONL. The stdio envelope contains two 32-bit byte lengths followed by the exact
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
case inventories remain in each Vitest result and phase summary; the duplicate
control-only `cases.json` is omitted. Export excludes graph/cache/home and unrelated
binary files; only the bounded evaluation archives and exact per-phase `stdio.bin`
are retained. It cannot overwrite an existing destination or enter the repository or
scratch tree through a symlink. The bound includes the final export record: at most
2,000 retained files and 64 MiB. Export and cleanup failures preserve the earlier
failure.
Selected runs never claim complete-matrix acceptance. Source HEAD and working-tree
capture attribution describe the execution actually performed.

The permanent coordinator integration guard runs two bounded actual captures.
Each family proves synthetic fixed/red/restored execution before a real assertion
or import failure; the import run also refuses export. It checks actual restored
hashes, main-thread body evaluations, complete identical inventories, removed
scratch and unchanged developer bytes/HEAD/index. The synthetic target/cases are
owned tooling fixtures selected only by this guard, outside product/workspace
inventories. Failure restoration receipts remain in the coordinator summary.
