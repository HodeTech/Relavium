// A child process for the ADR-0079 two-process run-ownership test (`run-lease.e2e.test.ts`). It opens an
// EXISTING, migrated `history.db` via the BUILT `@relavium/db`, tries to acquire one run's lease, and then —
// on the parent's command — attempts a guarded durable write under the fence it holds.
//
// Two OS processes are required, and a single Node process genuinely cannot substitute. `better-sqlite3` is
// synchronous, so two in-process owners are serialized by construction: the interleaving where one process
// still BELIEVES it owns a run another has taken over — the whole reason a fencing token exists rather than a
// bare CAS — only exists across real processes with their own SQLite connections.
//
// The protocol is a HANDSHAKE, not a race, so the test is deterministic rather than timing-dependent:
//
//   parent → child : (spawn)                     child → parent : `ACQUIRED <generation>` | `REFUSED`
//   parent → child : `write\n` on stdin          child → parent : `WROTE` | `FENCED` | `ERR <name>`
//
// argv: [node, thisFile, <abs path to @relavium/db dist index.js>, <db path>, <runId>, <ownerId>, <ttlMs>, <seq>]
/* global process -- a Node child-process fixture (not TS source); it uses only this Node global. */
import { randomUUID } from 'node:crypto';

const [, , distPath, dbPath, runId, ownerId, ttlMs, seq] = process.argv;

/** Emit one protocol line. Newline-terminated so the parent can read line-at-a-time without framing. */
const say = (line) => process.stdout.write(`${line}\n`);

let client;
try {
  // test-harness mechanism: the child cannot use vitest's source resolution, so it imports the BUILT
  // @relavium/db by an argv-provided abs path. Not a seam bypass — @relavium/db carries no provider SDK.
  // eslint-disable-next-line no-restricted-syntax
  const { createClient, createRunHistoryStore } = await import(distPath);
  client = createClient(dbPath);
  const store = createRunHistoryStore(client.db, {
    uuid: () => randomUUID(),
    now: () => Date.now(),
    workflow: { slug: 'lease-e2e', name: 'lease-e2e', definitionJson: '{}' },
  });

  const lease = store.leases.acquire(runId, ownerId, Number(ttlMs));
  if (lease === undefined) {
    say('REFUSED');
    process.exit(0);
  }
  say(`ACQUIRED ${String(lease.generation)}`);

  // Block until the parent says to write. This is the barrier that makes the ordering deterministic: the
  // parent has, by then, done whatever it needed to do to the lease from the OTHER process.
  await new Promise((resolve) => {
    process.stdin.once('data', () => resolve(undefined));
  });
  // The parent keeps its end of this pipe open, so from here on stdin alone would hold the event loop open
  // forever and the parent's `await done` would never resolve. Nothing more is read from it.
  process.stdin.pause();

  try {
    await store.persistEvent(
      {
        type: 'node:started',
        runId,
        sequenceNumber: Number(seq),
        timestamp: '2026-01-01T00:00:00.000Z',
        nodeId: `n-${ownerId}`,
        nodeType: 'input',
      },
      { fence: { ownerId, generation: lease.generation } },
    );
    say('WROTE');
  } catch (error) {
    // The name, not the message: the parent asserts on the TYPE of refusal, because "the write failed" and
    // "the write was fenced" are different claims and only one of them is this test's subject.
    say(
      error instanceof Error && error.name === 'LeaseFencedError'
        ? 'FENCED'
        : `ERR ${String(error)}`,
    );
  }
} finally {
  client?.sqlite.close();
}
