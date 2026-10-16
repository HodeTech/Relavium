/** Native tooling boundary. Never starts a shell or inherits credentials/config/preloads. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

export function isolatedEnvironment(home) {
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    CI: 'true',
    NO_COLOR: '1',
    TERM: 'dumb',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/** Resolve reviewed pnpm JS shims or the action's standalone executable, without cmd.exe. */
export function resolvePnpm(path = process.env.PATH ?? '', platform = process.platform) {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    if (!isAbsolute(directory)) continue;
    const candidates =
      platform === 'win32'
        ? [
            'pnpm.exe',
            'pnpm.cjs',
            'pnpm.js',
            '../pnpm/bin/pnpm.cjs',
            '../lib/node_modules/pnpm/bin/pnpm.cjs',
          ]
        : ['pnpm', 'pnpm.cjs'];
    for (const name of candidates) {
      const candidate = join(directory, name);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const target = realpathSync(candidate);
      if (platform === 'win32' && extname(target).toLowerCase() === '.exe')
        return { command: target, prefix: [] };
      if (
        /\.(?:c?js|mjs)$/u.test(target) ||
        readFileSync(target)
          .subarray(0, 128)
          .toString('utf8')
          .match(/^#![^\n]*\bnode\b/u)
      )
        return { command: process.execPath, prefix: [target] };
    }
  }
  throw new Error('PACKED_CLI_PINNED_PNPM_NOT_FOUND');
}

export function runCommand(command, args, options = {}) {
  const { timeoutMs = 300_000, maxBytes = 8 * 1024 * 1024, ...spawnOptions } = options;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0);
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: grouped,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0,
      fault,
      closed = false,
      killer,
      killerTimer;
    const output = { stdout: [], stderr: [] };
    function stop() {
      if (closed || child.pid === undefined) return;
      if (grouped) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') fault ??= error;
        }
      } else {
        const systemRoot = process.env.SystemRoot;
        if (systemRoot && isAbsolute(systemRoot)) {
          // Tool-owned installer children only. Product owner adapters are a separate Step 8 gate.
          killer ??= spawn(
            join(systemRoot, 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { shell: false, stdio: 'ignore' },
          );
          killer.once('error', () => child.kill('SIGKILL'));
          killerTimer ??= setTimeout(() => {
            killer.kill('SIGKILL');
            child.kill('SIGKILL');
          }, 3000);
        } else child.kill('SIGKILL');
      }
    }
    const timer = setTimeout(() => {
      fault ??= new Error('PACKED_CLI_CHILD_TIMEOUT');
      stop();
    }, timeoutMs);
    for (const sink of ['stdout', 'stderr'])
      child[sink].on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          fault ??= new Error('PACKED_CLI_CHILD_OUTPUT_BOUND');
          stop();
        } else output[sink].push(chunk);
      });
    child.once('error', (error) => {
      fault ??= error;
    });
    child.once('close', async (code, signal) => {
      closed = true;
      clearTimeout(timer);
      if (killer && killer.exitCode === null && killer.signalCode === null)
        await new Promise((done) => killer.once('close', done));
      clearTimeout(killerTimer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      };
      if (fault || code !== 0 || signal !== null) {
        const error = new Error(`PACKED_CLI_CHILD_FAILED: ${fault?.message ?? code ?? signal}`);
        error.result = result;
        reject(error);
      } else resolve(result);
    });
  });
}

export async function runPnpm(args, options) {
  const pnpm = resolvePnpm();
  return runCommand(pnpm.command, [...pnpm.prefix, ...args], options);
}
