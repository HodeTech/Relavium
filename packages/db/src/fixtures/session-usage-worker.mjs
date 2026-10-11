// Native child cuts/locks; only the caller's exclusive test database and built package are used.
/* global process */
import { writeSync } from 'node:fs';
import { clearTimeout, setTimeout } from 'node:timers';

const [, , distUrl, dbPath, mode] = process.argv;
// eslint-disable-next-line no-restricted-syntax -- a native worker uses built files, not Vitest TS resolution
const { createClient, createSessionStore, createSessionUsageStore } = await import(distUrl);
const client = createClient(dbPath);
try {
  if (mode === 'lock-release' || mode === 'lock-hold') {
    client.sqlite.exec(
      "BEGIN IMMEDIATE; UPDATE agent_sessions SET title = 'old-lock-writer' WHERE id = 's1'",
    );
    const release =
      mode === 'lock-release'
        ? new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('session usage lock release deadline')),
              5_000,
            );
            process.stdin.setEncoding('utf8').once('data', (token) => {
              clearTimeout(timeout);
              process.stdin.pause();
              if (token === 'RELEASE\n') resolve();
              else reject(new Error('invalid session usage lock release token'));
            });
          })
        : new Promise((resolve) => setTimeout(resolve, 10_000));
    writeSync(1, 'LOCKED\n');
    await release;
    client.sqlite.exec('COMMIT');
  } else {
    const cut = () => {
      writeSync(1, 'CUT\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      return 0;
    };
    if (mode.endsWith('before-ack') || mode.endsWith('after-ack')) {
      client.sqlite.function('test_crash_cut', cut);
      client.sqlite.exec(
        `CREATE TEMP TRIGGER test_crash_cut ${mode.endsWith('before-ack') ? 'BEFORE' : 'AFTER'} UPDATE OF usage_ack_revision ON agent_sessions BEGIN SELECT test_crash_cut(); END`,
      );
    }
    const store = createSessionStore(client.db);
    const session = store.loadSession('s1');
    if (session === undefined) throw new Error('missing fixture session');
    if (mode.startsWith('pending-')) {
      createSessionUsageStore(client.db).beginInvocation({
        sessionId: 's1',
        model: 'm',
        producerId: 'child',
        dispatchId: 'd',
        round: 0,
        chainAttempt: 1,
      });
    } else
      store.writeTurn({
        messages: [
          {
            message: {
              id: 'child-message',
              sessionId: 's1',
              sequenceNumber: 0,
              role: 'user',
              content: [{ type: 'text', text: 'committed exchange' }],
              timestamp: session.createdAt,
            },
          },
        ],
        session: { ...session, title: 'new-writer' },
      });
    if (mode.endsWith('after-commit')) cut();
    else throw new Error('crash fixture escaped its cut');
  }
} finally {
  client.sqlite.close();
}
