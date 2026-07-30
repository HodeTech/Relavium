// A child process for the ADR-0073 / #99 two-process migration race (migrate-lock.e2e.test.ts). It opens a
// FRESH, UNMIGRATED `history.db` via the BUILT `@relavium/db` and runs `runMigrations` against it. Two of these
// starting together exercise the real cross-process race a single Node process cannot reproduce: drizzle's
// migrator decides what to apply in a `SELECT` outside its own transaction, so without the lock both children
// conclude the full set is pending, one commits, and the other dies on a duplicate `CREATE TABLE`.
//
// It prints `OK` on success and nothing on failure (the non-zero exit is the signal), so the parent can assert
// that BOTH children succeeded rather than just that one did.
//
// argv: [node, thisFile, <abs path to @relavium/db dist index.js>, <shared db path>]
/* global process -- a Node child-process fixture (not TS source); it uses only this Node global. */
const [, , distPath, dbPath] = process.argv;

let client;
try {
  // test-harness mechanism: the child cannot use vitest's source resolution, so it imports the BUILT
  // @relavium/db by an argv-provided abs path. Not a seam bypass — @relavium/db carries no provider SDK.
  // eslint-disable-next-line no-restricted-syntax
  const { createClient, runMigrations } = await import(distPath);
  client = createClient(dbPath);
  // The whole point: `dbPath` is what engages the cross-process lock. Omitting it here would make the test
  // pass for the wrong reason on a fast machine and fail intermittently on a slow one.
  runMigrations(client.db, { dbPath: client.path });
  process.stdout.write('OK');
} finally {
  client?.sqlite.close();
}
