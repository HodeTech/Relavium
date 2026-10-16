import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';

export const maxOutputBytes = 256 * 1024;
/** Bound bytes and wall time, kill only this owned process group, and wait for close. */
export function spawnBounded(
  args,
  options,
  { timeoutMs = 10000, outputBytes = maxOutputBytes } = {},
) {
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, args, {
      ...options,
      detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0,
      timedOut = false,
      outputExceeded = false,
      spawnError;
    function kill() {
      if (grouped && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch (error) {
          if (error.code !== 'ESRCH') spawnError ??= error.message;
        }
      }
      child.kill('SIGKILL');
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    for (const name of ['stdout', 'stderr'])
      child[name].on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > outputBytes) {
          outputExceeded = true;
          kill();
        } else output[name].push(chunk);
      });
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      kill();
      resolve({
        code,
        signal,
        timedOut,
        outputExceeded,
        spawnError,
        joined: true,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      });
    });
  });
}
