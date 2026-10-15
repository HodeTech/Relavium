// Native child cuts/locks; only the caller's exclusive test database and built package are used.
/* global process */
import { error as logError } from 'node:console';
import { appendFileSync, writeSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';

const [, , distUrl, dbPath, mode] = process.argv;
const started = performance.now();
const initialCpu = process.cpuUsage();
const destination = process.env['RELAVIUM_DB_NATIVE_DIAGNOSTICS'];
let diagnosticFailed = false;
/** @param {string} stage @param {object} [detail] */
function diagnose(stage, detail = {}) {
  if (destination === undefined || diagnosticFailed) return;
  const cpu = process.cpuUsage(initialCpu);
  try {
    appendFileSync(
      destination,
      `${JSON.stringify({
        source: 'child',
        stage,
        callerPid: process.ppid,
        pid: process.pid,
        mode,
        elapsedMs: Math.round(performance.now() - started),
        atMs: Date.now(),
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        ...detail,
      })}\n`,
    );
  } catch {
    diagnosticFailed = true;
    logError('Native DB diagnostic journal unavailable.');
  }
}
// Monitor without swallowing the native failure or publishing error messages/payloads.
process.on('uncaughtExceptionMonitor', (error) => {
  const code =
    'code' in error && typeof error.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code)
      ? error.code
      : undefined;
  diagnose('uncaught-error', { name: error.name.slice(0, 64), code });
});
diagnose('import-start', {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  availableParallelism: availableParallelism(),
});
// eslint-disable-next-line no-restricted-syntax -- a native worker uses built files, not Vitest TS resolution
const { createClient, createSessionStore, createSessionUsageStore } = await import(distUrl);
diagnose('import-complete');
diagnose('open-start');
const client = createClient(dbPath);
diagnose('open-complete');
try {
  if (mode === 'readiness-timeout-control') {
    // The parent proves a loaded native worker can remain unready, then kills and joins it.
    // This is deliberately NOT a CUT/LOCKED readiness barrier.
    process.stdin.resume();
    diagnose('not-ready', { kind: 'WAITING' });
    writeSync(1, 'WAITING\n');
    await new Promise(() => {});
  }
  if (mode === 'lock-release' || mode === 'lock-hold') {
    diagnose('transaction-start');
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
            process.stdin.setEncoding('utf8').once(
              'data',
              /** @param {string} token */ (token) => {
                clearTimeout(timeout);
                process.stdin.pause();
                if (token === 'RELEASE\n') resolve(undefined);
                else reject(new Error('invalid session usage lock release token'));
              },
            );
          })
        : new Promise((resolve) => setTimeout(resolve, 10_000));
    diagnose('barrier-write', { kind: 'LOCKED' });
    writeSync(1, 'LOCKED\n');
    await release;
    client.sqlite.exec('COMMIT');
    diagnose('transaction-complete');
  } else {
    const cut = () => {
      diagnose('barrier-write', { kind: 'CUT' });
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
    diagnose('transaction-start');
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
    diagnose('transaction-complete');
    if (mode.endsWith('after-commit')) cut();
    else throw new Error('crash fixture escaped its cut');
  }
} finally {
  client.sqlite.close();
  diagnose('database-close');
}
