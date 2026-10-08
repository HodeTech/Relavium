/** Join actual native workers before publishing evidence, preserving the first worker failure. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { captureEvidenceFinalization, warnEvidenceFailure } from './evidence-retention.mjs';

export async function runReplayStage({ owned, stage, source, script, environment, processes }) {
  const args = ['--import', join(owned, 'register.mjs'), join(owned, script)];
  const child = spawn(process.execPath, args, {
    cwd: owned,
    env: { ...environment, COMPAT_SOURCE: source, COMPAT_LABEL: stage },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnFailed = false;
  let spawnError;
  child.on('error', (error) => {
    if (!spawnFailed) {
      spawnFailed = true;
      spawnError = error;
    }
  });
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 45000);
  let ended;
  try {
    ended = await closed;
  } finally {
    clearTimeout(timer);
  }
  const record = {
    stage,
    source,
    command: [process.execPath, ...args],
    cwd: owned,
    pid: child.pid ?? null,
    timedOut,
    ...ended,
    workerClosed: true,
    spawnFailed,
  };
  processes.push(record);
  let primaryFailed = false;
  let finalization = { failed: false };
  try {
    if (spawnFailed) throw spawnError;
    assert.equal(ended.code, 0, `${stage} failed; evidence ${owned}`);
    assert.equal(ended.signal, null);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    finalization = captureEvidenceFinalization(
      [
        () =>
          writeFileSync(
            join(owned, `logs/${stage}.process.json`),
            `${JSON.stringify(record, null, 2)}\n`,
          ),
        () => writeFileSync(join(owned, `logs/${stage}.stdout.log`), stdout),
        () => writeFileSync(join(owned, `logs/${stage}.stderr.log`), stderr),
        () => writeSync(1, stdout),
        () => {
          if (stderr) writeSync(2, stderr);
        },
      ],
      primaryFailed,
      () => warnEvidenceFailure('Replay stage evidence failed; primary worker failure retained.\n'),
    );
  }
  if (finalization.failed) throw finalization.error;
}
