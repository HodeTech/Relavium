/** Native tooling boundary. Never starts a shell or inherits credentials/config/preloads. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { constants, devNull } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { clearTimeout, setImmediate, setTimeout } from 'node:timers';

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

/**
 * Git with no global or system configuration, for reading the original checkout: its own `.git/config`
 * and ignore rules still apply and a caller passes the developer's global excludes explicitly, but no
 * `.gitconfig`, `git/config`, `git/ignore` or `git/attributes` in a home, configuration or system
 * location is read — not even one inside the checkout itself.
 */
export function isolatedGitEnvironment() {
  return { ...isolatedEnvironment(devNull), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
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
        : ['pnpm', 'pnpm.cjs', '../pnpm/bin/pnpm.cjs', '../lib/node_modules/pnpm/bin/pnpm.cjs'];
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

/** Every child tree a `runCommand` call still owns, so that an interrupted tool can stop them first. */
const liveChildren = new Set();

/**
 * Synchronously kill every child tree that `runCommand` still owns: a POSIX process group, or a
 * Windows tree through taskkill. For a signal handler that must stop detached builds before it exits.
 */
export function stopLiveCommands() {
  for (const child of liveChildren) {
    if (child.grouped) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
      continue;
    }
    const systemRoot = process.env.SystemRoot;
    if (systemRoot && isAbsolute(systemRoot)) {
      spawnSync(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { shell: false, stdio: 'ignore' },
      );
    } else {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // The child already exited.
      }
    }
  }
  liveChildren.clear();
}

/** The interrupts after which a tool still stops its children and cleans up before it exits. */
const INTERRUPTS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * Let the event loop poll for I/O once more. Node hands a caught signal to its listener only when the
 * loop next polls, and work that ran from an I/O callback (a child's exit, a file read) can end its
 * first turn before that poll: a listener removed then drops the signal. After two turns the loop has
 * polled. A signal caught in the instant between that poll and the listener's removal is still lost;
 * Node offers no way to drain it.
 */
async function deliverCaughtSignals() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run `body` while SIGINT, SIGTERM and SIGHUP stop every child tree `runCommand` owns, run the
 * synchronous `interrupted` and end the process with 128 + the signal's number. The handlers stay
 * until the loop has polled once after `body` settled (`deliverCaughtSignals`), so an interrupt caught
 * during the body's synchronous tail or its own final cleanup is honoured, never dropped with its
 * listener. A process killed outright runs nothing.
 * @template T
 * @param {() => void} interrupted
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function exitOnInterrupt(interrupted, body) {
  const handler = (signal) => {
    stopLiveCommands();
    interrupted();
    process.exit(128 + (constants.signals[signal] ?? 0));
  };
  for (const signal of INTERRUPTS) process.on(signal, handler);
  try {
    return await body();
  } finally {
    await deliverCaughtSignals();
    for (const signal of INTERRUPTS) process.off(signal, handler);
  }
}

/**
 * While a tool waits on children that clean up after themselves (the producer, the consumer),
 * forward SIGINT, SIGTERM and SIGHUP to every child tree `runCommand` owns instead of dying first: a
 * detached child shares no terminal process group, so it would never receive the interrupt. On
 * Windows the children share the console and receive Ctrl-C themselves. The caller runs its own cleanup, awaits `dispose`
 * and exits with 128 + the number of the signal `received` reports.
 * @returns {{received: () => string | undefined, dispose: () => Promise<void>}}
 */
export function forwardInterrupts() {
  let received;
  const forward = (signal) => {
    received ??= signal;
    for (const child of liveChildren) {
      if (!child.grouped) continue;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group already exited.
      }
    }
  };
  for (const signal of INTERRUPTS) process.on(signal, forward);
  return {
    received: () => received,
    // An interrupt caught during the caller's cleanup is still recorded (`deliverCaughtSignals`).
    dispose: async () => {
      await deliverCaughtSignals();
      for (const signal of INTERRUPTS) process.off(signal, forward);
    },
  };
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
    const live = { pid: child.pid, grouped };
    if (child.pid !== undefined) liveChildren.add(live);
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
      liveChildren.delete(live);
      clearTimeout(timer);
      if (killer && killer.exitCode === null && killer.signalCode === null)
        await new Promise((done) => killer.once('close', done));
      clearTimeout(killerTimer);
      const result = {
        pid: child.pid,
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

/** Exercise the package manager's actual POSIX/Windows command shim in the owned installation. */
export async function exerciseInstalledCommand(home, version) {
  const shim = join(
    home,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'relavium.cmd' : 'relavium',
  );
  const stat = lstatSync(shim);
  assert.ok(stat.isFile() || stat.isSymbolicLink(), 'PACKED_CLI_INSTALLED_COMMAND_MISSING');
  const options = {
    cwd: home,
    env: isolatedEnvironment(home),
    timeoutMs: 30_000,
    maxBytes: 128 * 1024,
  };
  // pnpm exec supports the actual POSIX/Windows shim without substituting node <entry>.
  // The absolute shim path prevents an ambient PATH command from filling a broken installation.
  const actualVersion = await runPnpm(['exec', shim, '--version'], options);
  assert.equal(actualVersion.stdout, `${version}\n`, 'PACKED_CLI_INSTALLED_COMMAND_VERSION');
  assert.equal(actualVersion.stderr, '', 'PACKED_CLI_INSTALLED_COMMAND_VERSION_STDERR');
  const help = await runPnpm(['exec', shim, '--help'], options);
  assert.match(help.stdout, /^Usage: relavium/u, 'PACKED_CLI_INSTALLED_COMMAND_HELP');
  assert.equal(help.stderr, '', 'PACKED_CLI_INSTALLED_COMMAND_HELP_STDERR');
  return { help: true, version: true };
}
