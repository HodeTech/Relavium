// A child process for the 2.5.I two-process contention smoke (concurrency.e2e.test.ts). It opens a SHARED,
// already-migrated `history.db` via the BUILT `@relavium/db` and writes a burst of provider `upsert`s — the
// BEGIN IMMEDIATE + `withBusyRetry` write path (ADR-0064 §5). Two of these racing the same file exercise the
// REAL cross-process WAL write-lock contention that a single process (synchronous better-sqlite3) cannot
// reproduce. It writes distinct provider names, so success = every write of BOTH children landed with no
// escaped `SQLITE_BUSY` and no lost/corrupt row (the parent asserts the union).
//
// argv: [node, thisFile, <db dist file URL>, <shared db path>, <name prefix>, <count>, <mode?>]
// The optional fail-before-ready mode is a fixture refusal control; the normal mode always writes count rows.
/* global process, console -- a Node child-process fixture (not TS source); it uses only these Node globals. */
const [, , distPath, dbPath, prefix, countArg, mode = 'write'] = process.argv;
const count = Number(countArg);

// Await pipe acknowledgement before entering synchronous SQLite: no buffered readiness bytes are
// allowed to depend on the event loop that the first contended write is about to block.
const announce = (line) =>
  new Promise((resolve, reject) => {
    process.stdout.write(line + '\n', (error) => (error ? reject(error) : resolve()));
  });

const start = new Promise((resolve, reject) => {
  let command = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    command += chunk;
  });
  process.stdin.once('error', reject);
  process.stdin.once('end', () => {
    if (command === 'START\n') resolve();
    else reject(new Error('Concurrent writer did not receive START.'));
  });
});
// Startup may fail before this wait is reached; always observe the already-owned input task.
void start.catch(() => undefined);

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
  await announce('OPENED');
  await start;
  if (mode === 'fail-before-ready') throw new Error('synthetic refusal before READY');
  // The parent now holds the write lock. READY is positive evidence, never synthesized from child exit.
  await announce('READY');
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
  try {
    client?.sqlite.close();
  } finally {
    process.stdin.destroy();
  }
}
