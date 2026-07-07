// A child process for the 2.5.I two-process contention smoke (concurrency.e2e.test.ts). It opens a SHARED,
// already-migrated `history.db` via the BUILT `@relavium/db` and writes a burst of provider `upsert`s — the
// BEGIN IMMEDIATE + `withBusyRetry` write path (ADR-0064 §5). Two of these racing the same file exercise the
// REAL cross-process WAL write-lock contention that a single process (synchronous better-sqlite3) cannot
// reproduce. It writes distinct provider names, so success = every write of BOTH children landed with no
// escaped `SQLITE_BUSY` and no lost/corrupt row (the parent asserts the union).
//
// argv: [node, thisFile, <abs path to @relavium/db dist index.js>, <shared db path>, <name prefix>, <count>]
/* global process, console -- a Node child-process fixture (not TS source); it uses only these Node globals. */
const [, , distPath, dbPath, prefix, countArg] = process.argv;
const count = Number(countArg);

let client;
try {
  // test-harness mechanism: the child can't use vitest's source resolution, so it imports the BUILT
  // @relavium/db by an argv-provided abs path. Not a seam bypass — @relavium/db carries no provider SDK
  // (ADR-0011); the fence targets vendor-SDK smuggling in the LLM seam.
  // eslint-disable-next-line no-restricted-syntax
  const { createClient, createProviderStore } = await import(distPath);
  // The parent migrated the file before spawning, so children never race the migrator — they only write.
  client = createClient(dbPath);
  let uuidN = 0;
  const providers = createProviderStore(client.db, {
    // Per-child UUID namespace (the `prefix` first char) so two children never collide on a row PK.
    uuid: () => `${prefix}0000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`,
    now: () => 1_700_000_000_000,
  });
  // Signal readiness (the import + the connection are up) so the parent releases the held write lock only
  // once we are about to write — a deterministic handshake that forces real cross-process contention every
  // run, independent of Node/import startup latency (which can exceed a fixed parent-side timer).
  process.stdout.write('READY\n');
  for (let i = 0; i < count; i += 1) {
    providers.upsert({
      name: `${prefix}-${i}`,
      displayName: `provider ${prefix} ${i}`,
      baseUrl: 'https://api.example/v1',
    });
  }
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
} finally {
  client?.sqlite.close();
}
