import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';

export const maxProcessOutputUnits = 8 * 1024 * 1024;

/** Join the runner's close after bounded output/time enforcement and kill its owned POSIX worker group. */
export function spawnJoined(command, args, options, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const ownedProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      ...options,
      detached: ownedProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      spawnError,
      timedOut = false,
      outputExceeded = false;
    const killOwned = () => {
      if (ownedProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch (error) {
          if (error.code !== 'ESRCH') spawnError ??= { name: error.name, message: error.message };
        }
      }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killOwned();
    }, timeoutMs);
    child.once('error', (error) => {
      spawnError = { name: error.name, message: error.message };
    });
    function append(value, stream) {
      if (stdout.length + stderr.length + value.length > maxProcessOutputUnits) {
        outputExceeded = true;
        killOwned();
        return;
      }
      if (stream === 'stdout') stdout += value;
      else stderr += value;
    }
    child.stdout.setEncoding('utf8').on('data', (value) => append(value, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', (value) => append(value, 'stderr'));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      killOwned();
      resolve({
        pid: child.pid,
        code,
        signal,
        spawnError,
        timedOut,
        outputExceeded,
        ownedProcessGroup,
        joined: true,
        stdout,
        stderr,
      });
    });
  });
}
