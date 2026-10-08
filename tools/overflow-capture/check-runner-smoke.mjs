/** Native failure regressions for the same runner used by the offline capture smoke. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createCaptureCheckRunner } from './check-runner.mjs';

export async function checkCaptureRunnerFailures() {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-capture-runner-check-'));
  const loader = join(directory, 'loader.mjs');
  const main = join(directory, 'waiting-child.mjs');
  writeFileSync(loader, '// No network, key access or provider code.\n');
  writeFileSync(main, 'setInterval(() => {}, 1000);\n');
  try {
    for (const fault of ['spawn', 'readiness', 'filesystem', 'setup', 'stdin']) {
      const marker = join(directory, `${fault}-transport`);
      const raceReady = join(directory, `${fault}-ready`);
      const out = join(directory, `${fault}-missing-output`);
      if (fault === 'filesystem') writeFileSync(raceReady, 'ready');
      const sentinel = new Error(`synthetic ${fault} failure`);
      let child;
      let close;
      let hasClosed = false;
      let nativeError;
      const unhandled = [];
      const onUnhandled = (error) => unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      try {
        const run = createCaptureCheckRunner({
          args: [],
          loader,
          main,
          key: 'synthetic-native-runner-key',
          out,
          marker,
          raceReady,
          raceRelease: join(directory, `${fault}-release`),
          spawnProcess: (command, args, options) => {
            child = spawn(command, args, {
              ...options,
              cwd: fault === 'spawn' ? join(directory, 'missing-cwd') : directory,
            });
            close = new Promise((resolve) => {
              child.once('error', (error) => {
                nativeError = error;
              });
              child.once('close', () => {
                hasClosed = true;
                resolve();
              });
            });
            // Fault injection uses actual native piped children, never fake child objects.
            if (fault === 'setup')
              child.stdout.setEncoding = () => {
                throw sentinel;
              };
            if (fault === 'stdin')
              child.stdin.end = () => {
                throw sentinel;
              };
            return child;
          },
        });
        let failure;
        try {
          await run([], 'cleanup-race');
        } catch (error) {
          failure = error;
        }
        const closedBeforeSettlement = hasClosed;
        // Join even a regressed implementation before asserting, so a failing check leaves no child.
        if (!hasClosed) child.kill('SIGKILL');
        await close;
        await setImmediate();
        assert.ok(failure, `${fault}: expected failure was lost`);
        assert.equal(closedBeforeSettlement, true, `${fault}: runner settled before native close`);
        assert.equal(unhandled.length, 0, `${fault}: unhandled native-spawn rejection`);
        if (fault === 'spawn') {
          assert.equal(failure, nativeError, 'native spawn error identity changed');
          assert.equal(failure.code, 'ENOENT');
        } else if (fault === 'readiness') {
          assert.equal(failure.code, 'ERR_ASSERTION');
          assert.equal(failure.message, 'cleanup race never reached a terminal or stat');
        } else if (fault === 'filesystem') {
          assert.equal(failure.code, 'ENOENT');
          assert.equal(failure.path, out);
        } else {
          assert.equal(failure, sentinel, `${fault}: primary failure changed`);
        }
      } finally {
        if (child !== undefined && !hasClosed) child.kill('SIGKILL');
        await close;
        process.off('unhandledRejection', onUnhandled);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
