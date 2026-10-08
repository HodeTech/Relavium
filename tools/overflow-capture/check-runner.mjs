// Private offline smoke runner, shared with its native failure regressions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function createCaptureCheckRunner({
  args,
  loader,
  main,
  key,
  out,
  marker,
  raceReady,
  raceRelease,
  spawnProcess = spawn,
}) {
  async function run(argv = args, mode = 'safe', input = key, interrupt = false) {
    rmSync(marker, { force: true });
    const child = spawnProcess(
      process.execPath,
      ['--import', pathToFileURL(loader).href, main, ...argv],
      {
        env: {
          ...process.env,
          CAPTURE_PROBE_MODE: mode,
          CAPTURE_PROBE_MARKER: marker,
          CAPTURE_PROBE_OUT: out,
          CAPTURE_PROBE_RACE_READY: raceReady,
          CAPTURE_PROBE_RACE_RELEASE: raceRelease,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let spawnError;
    let hasClosed = false;
    const closed = new Promise((resolve) => {
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (code, signal) => {
        hasClosed = true;
        resolve({ code, signal });
      });
    });
    let timer;
    try {
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin.on('error', () => {}); // Early argument refusal may close the pipe before our synthetic write.
      child.stdin.end(input);
      timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      if (mode === 'cleanup-race') {
        for (let i = 0; i < 400; i += 1) {
          if (hasClosed || existsSync(raceReady)) break;
          await sleep(5);
        }
        assert.ok(
          hasClosed || existsSync(raceReady),
          'cleanup race never reached a terminal or stat',
        );
        if (existsSync(raceReady)) {
          rmSync(out);
          writeFileSync(out, 'replacement user file');
          writeFileSync(raceRelease, '1');
        }
      }
      if (interrupt) {
        for (let i = 0; i < 200 && !existsSync(marker); i += 1) await sleep(10);
        assert.ok(existsSync(marker), 'child never reached the mocked transport');
        child.kill('SIGTERM');
      }
      const result = await closed;
      if (spawnError !== undefined) throw spawnError;
      assert.ok(!(stdout + stderr).includes(key), 'key escaped to command output');
      assert.equal(result.signal, null, 'command hung or terminated without its cleanup');
      return {
        ...result,
        stdout,
        stderr,
        calls: existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0,
      };
    } finally {
      clearTimeout(timer);
      if (!hasClosed) child.kill('SIGKILL');
      await closed;
    }
  }
  return run;
}
