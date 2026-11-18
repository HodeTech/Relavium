# Concurrency probes for the native allocation claim

Developer tools, not run in CI. They drive the **built** native addon (`node tools/native-fs/build.mjs` first)
with several writers on one operator home, as [ADR-0135](../../../docs/decisions/0135-concurrent-processes-on-one-operator-home-wait-for-the-allocation-claim.md)
describes. The writers run in one process on separate file descriptions, which conflict under `flock` exactly as
separate processes do; they are not a multi-process probe. Set `RELAVIUM_NATIVE_LOADER` to the `loader.cjs` of
another build (for example one kept from before a change) to compare two binaries.

| Script | What it does | With the claim waited for | With one nonblocking attempt |
|---|---|---|---|
| `writers.mjs [writers=2] [writesEach=30] [--recover]` | K writers, each doing M real prepare, stage, publish, release writes (optionally beside a recovery loop) | `ok` equals `total` | about half of the writes of two writers fail at stage (`changed:not_needed`), a few end `possibly_published:uncertain` |
| `recover-churn.mjs [fillers=120] [passes=200] [--no-churn]` | recovery passes while a lock-less churner creates and removes `.reserved` entries (what a pin does to its reservation) | `fail` is 0 | about half of the passes fail under churn, none without it |
| `pool-stall.mjs [writers=4]` | N writers wait for a claim a `perl` process holds forever; times `fs.stat`, `dns.lookup` and `crypto.randomBytes` 200 ms later (POSIX only) | 0 ms up to four writers, about 0.1 s with six, 0.3 s with eight | the first, unlimited wait stalled them 1.8 s with four writers and 3.8 s with eight |

Each script prints one JSON line (and `pool-stall.mjs` one line per writer). The numbers vary from run to run and
from machine to machine; they were measured on macOS with the default worker pool of four.
