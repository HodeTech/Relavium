import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

import type { ProcessCapability, ProcessResult } from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

import {
  HostCapabilityError,
  HostDeniedError,
  throwIfAborted as throwIfAbortedShared,
} from './errors.js';

/**
 * The Node host **mechanism** half of the `ToolHost.process` capability arm (2.5.A, [ADR-0055](../../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md);
 * the engine owns the policy — the allowlist-checked command — the host owns the spawn, [ADR-0037](../../../../../docs/decisions/0037-engine-tool-execution-boundary.md)).
 * It backs `git_status` (and, when a workflow allowlists commands, `run_command` / `git_commit`).
 *
 * The discipline is [built-in-tools.md](../../../../../docs/reference/shared-core/built-in-tools.md) §Subprocess
 * environment + [tool-registry.md](../../../../../docs/reference/shared-core/tool-registry.md):
 * - **`shell: false`** — no shell, so no metacharacter/quoting injection; the engine already allowlist-checked
 *   the command, the host never re-parses it.
 * - **Host-resolved executable** — the command is resolved to an absolute path against the **ambient** `PATH`
 *   (never the caller-`declaredEnv` `PATH`), so a declared `env.PATH` can never redirect *which* binary runs.
 * - **Platform-minimal base env** — a fixed audited allowlist of platform-essential vars (`PATH`, `HOME`, …),
 *   then the engine-supplied `declaredEnv` merged on top — **never** a blanket copy of `process.env` (which would
 *   hand every subprocess the host's secrets / `RELAVIUM_*_API_KEY` env).
 * - **Bounded + bounded-time** — stdout/stderr are capped (`maxBufferBytes`) and the run is killed past a
 *   timeout ceiling, so one tool call can neither exhaust memory nor hang the agent.
 *
 * stdout/stderr are **untrusted** model-facing data (the engine marks them). Errors name a **reason only**.
 */

/** Default per-call timeout when the tool config pins none (overridable up to {@link NodeProcessCapabilityConfig.maxTimeoutMs}). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Hard ceiling on a tool-config-supplied timeout — a misconfigured huge timeout can never hang the agent forever. */
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
/** Default per-stream capture ceiling — stdout and stderr are each truncated past this (memory DoS guard). */
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/** The audited platform-minimal base env: only these ambient keys reach a subprocess (never the full env). */
const POSIX_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TERM',
] as const;
const WINDOWS_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'ComSpec',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'OS',
] as const;

export interface NodeProcessCapabilityConfig {
  /** The session/run working directory (absolute) — the default spawn cwd when the tool pins none. */
  readonly workspaceDir: string;
  /** Default timeout (ms) when the tool config pins none (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly defaultTimeoutMs?: number;
  /** Hard ceiling on the tool-supplied timeout (default {@link DEFAULT_MAX_TIMEOUT_MS}). */
  readonly maxTimeoutMs?: number;
  /** Per-stream output ceiling in bytes (default {@link DEFAULT_MAX_BUFFER_BYTES}). */
  readonly maxBufferBytes?: number;
}

/**
 * A **transient** process-capability failure (a timeout, a spawn fault) naming a **reason only** — never a
 * command value / output / env (the I3 boundary). Maps to the retryable `tool_failed` (shared {@link HostCapabilityError}).
 */
export class ProcessCapabilityError extends HostCapabilityError {}

/**
 * A **deterministic host refusal** — an empty/not-found command, or a declared env var the host forbids —
 * mapping to the **fatal**, non-retryable `tool_denied` (the shared {@link HostDeniedError}): re-issuing the same
 * command re-fails identically, so it must NOT burn the node-retry budget (error-handling.md §tool-dispatch codes).
 */
export class ProcessDeniedError extends HostDeniedError {}

/**
 * Declared env vars the host **forbids** even from a workflow author: keys that would run attacker code in
 * the child (or a grandchild), or steer a tool's config/identity, regardless of the allowlisted binary —
 * the audit the spec mandates ([built-in-tools.md](../../../../../docs/reference/shared-core/built-in-tools.md)
 * §Subprocess environment names `NODE_OPTIONS` as a hijack vector). Categories: interpreter/loader option
 * injection (`NODE_OPTIONS`/`NODE_PATH`, `PYTHON*`, `PERL5*`, `RUBY*`, `JAVA_*`/`CLASSPATH`, the `LD_`/`DYLD_`
 * dynamic loaders, `BASH_ENV`/`ENV`/`IFS`), the entire `GIT_` namespace (`GIT_DIR`, `GIT_CONFIG_*`,
 * `GIT_SSH*`, `GIT_EXEC_PATH`, hooks via `core.hooksPath` → RCE), and **config-home redirection**
 * (`HOME`/`XDG_CONFIG_HOME`/`USERPROFILE` repoint a tool's `~/.gitconfig`/rc to attacker-controlled files).
 * `PATH` is rejected too — executable resolution deliberately ignores a declared `PATH`. Keys are matched
 * case-insensitively (Windows env names are case-insensitive). A declared var is merged on top of the audited
 * base env; a stricter author-**opt-in allowlist** of permitted keys is the Phase-2.6 refinement (this profile's
 * `git_status` passes an empty `declaredEnv`, so the surface is only a power-user `run_command` `env` config).
 */
const FORBIDDEN_DECLARED_ENV: ReadonlySet<string> = new Set([
  // interpreter / loader option + module-path injection
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_V8_COVERAGE',
  // (every `PYTHON*` var is covered by the `PYTHON` prefix below — listed by name for nothing, so omitted)
  'PERL5LIB',
  'PERL5OPT',
  'RUBYLIB',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'BASH_ENV',
  'ENV',
  'IFS',
  // config-home redirection (repoints ~/.gitconfig, rc files, …; APPDATA/LOCALAPPDATA are the Windows
  // per-user config roots — git reads %APPDATA%\Git\config, many tools read %APPDATA%\<tool>\)
  'HOME',
  'XDG_CONFIG_HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  // executable resolution ignores a declared PATH — reject it rather than mislead
  'PATH',
]);
/** Forbidden key prefixes: the dynamic loaders (`DYLD_*`, `LD_*`) and the ENTIRE git env namespace (`GIT_*`). */
// `PYTHON` (no trailing `_`) sweeps the whole interpreter-config namespace — `PYTHONHOME`/`PYTHONPATH`/
// `PYTHONINSPECT`/`PYTHONEXECUTABLE`/… — none of which carry an underscore after `PYTHON`, so a `PYTHON_`
// prefix would miss them all.
const FORBIDDEN_DECLARED_ENV_PREFIX = ['DYLD_', 'LD_', 'GIT_', 'PYTHON'] as const;

/**
 * Build a node-backed {@link ProcessCapability}. The returned object is the value a host wires onto
 * `ToolHost.process`; it holds no ambient state beyond the immutable config.
 */
export function createNodeProcessCapability(
  config: NodeProcessCapabilityConfig,
): ProcessCapability {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  return {
    spawn: async (command, args, declaredEnv, opts, signal) => {
      throwIfAborted(signal);
      assertSafeDeclaredEnv(declaredEnv);
      const executable = await resolveExecutable(command);
      const timeoutMs = Math.min(opts.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs);
      const cwd = await jailCwd(config.workspaceDir, opts.cwd);
      return runChild({
        executable,
        args: [...args],
        env: { ...minimalBaseEnv(), ...declaredEnv },
        cwd,
        timeoutMs,
        maxBufferBytes,
        signal,
      });
    },
  };
}

interface RunChildOptions {
  readonly executable: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
  readonly signal: AbortSignalLike | undefined;
}

/** Spawn the resolved child (`shell:false`), wiring the timeout + abort kill and the bounded output capture. */
function runChild(opts: RunChildOptions): Promise<ProcessResult> {
  const start = Date.now();
  return new Promise<ProcessResult>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.executable, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false, // SECURITY: no shell — no metacharacter/quoting injection (the command is pre-allowlisted)
        windowsHide: true,
        // POSIX: make the child a process-group leader so a timeout/abort can SIGKILL the WHOLE group (the
        // child AND any grandchildren it forked) — a single-pid kill would leak a forking subprocess. Not
        // unref'd: we await `close`. Windows has no POSIX groups, so kill falls back to the single child.
        detached: process.platform !== 'win32',
      });
    } catch {
      reject(new ProcessCapabilityError('the command could not be started'));
      return;
    }

    const stdout = new BoundedBuffer(opts.maxBufferBytes);
    const stderr = new BoundedBuffer(opts.maxBufferBytes);
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };
    if (opts.signal !== undefined) opts.signal.addEventListener('abort', onAbort);

    const cleanup = (): void => {
      clearTimeout(timer);
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A spawn-time failure (e.g. ENOENT if the executable vanished after resolution) arrives as 'error'.
    child.on('error', () =>
      finish(() => reject(new ProcessCapabilityError('the command failed to run'))),
    );
    child.on('close', (code) => {
      finish(() => {
        // `code === null` ⇒ the process was signal-killed. A timeout/abort kill lands here with null code; a
        // process that exited NATURALLY at the same tick the timer fired keeps its real `code`, so gate the
        // timeout label on a null code — a same-tick natural exit is reported with its true exit code, not a
        // spurious timeout.
        if (aborted) {
          reject(new ProcessCapabilityError('the command was aborted'));
        } else if (timedOut && code === null) {
          reject(new ProcessCapabilityError(`the command timed out after ${opts.timeoutMs}ms`));
        } else {
          // Reap the whole process group on a NORMAL exit too — a backgrounded grandchild the command forked
          // must not outlive the tool call. killTree is idempotent on an already-exited group (the ESRCH is
          // swallowed), so this is a no-op when nothing survives and a clean reaping when something does.
          killTree(child);
          resolvePromise({
            // An (external) signal-kill exit has `code === null` — report a conventional non-zero so the model
            // sees a failure exit rather than a misleading `0`.
            exitCode: code ?? 1,
            stdout: stdout.text(),
            stderr: stderr.text(),
            durationMs: Date.now() - start,
          });
        }
      });
    });
  });
}

/** SIGKILL the child and (on POSIX) its whole process group, so a forked grandchild can't survive the kill. */
function killTree(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid ⇒ the process group (the detached child is its leader)
      return;
    } catch {
      // The group is already gone, or the kill is not permitted — fall back to the single child below.
    }
  }
  child.kill('SIGKILL');
}

/** A byte-bounded UTF-8 accumulator: appends until the cap, then drops the rest and marks the output truncated. */
class BoundedBuffer {
  readonly #chunks: Buffer[] = [];
  readonly #max: number;
  #bytes = 0;
  #truncated = false;
  constructor(max: number) {
    this.#max = max;
  }

  push(chunk: Buffer): void {
    if (this.#bytes >= this.#max) {
      this.#truncated = true;
      return;
    }
    const room = this.#max - this.#bytes;
    if (chunk.length <= room) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.length;
    } else {
      this.#chunks.push(chunk.subarray(0, room));
      this.#bytes = this.#max;
      this.#truncated = true;
    }
  }

  text(): string {
    const body = Buffer.concat(this.#chunks).toString('utf8');
    return this.#truncated ? `${body}\n…[output truncated at ${this.#max} bytes]` : body;
  }
}

/**
 * Resolve `command` to an absolute executable path against the **ambient** `PATH` (POSIX: `X_OK`; Windows:
 * each `PATHEXT`), so the engine-allowlisted command name maps to a real binary independent of any
 * caller-`declaredEnv` `PATH`. An explicit path (absolute or containing a separator) is returned as-is. A name
 * that resolves nowhere fails-closed — the engine already authorized it, so a miss is an environment gap.
 */
async function resolveExecutable(command: string): Promise<string> {
  if (command === '') {
    throw new ProcessDeniedError('the command is empty'); // deterministic — fatal, never retried
  }
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command; // an explicit path — spawn fails cleanly if it is missing / not executable
  }
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? '';
  const dirs = pathVar.split(delimiter).filter((d) => d !== '');
  let exts: string[];
  if (process.platform === 'win32') {
    const pathExts = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter((e) => e !== '');
    // If the command ALREADY carries a recognized PATHEXT extension (e.g. `node.exe`), try the bare name first —
    // otherwise every candidate would be `node.exe.EXE` etc. and the real binary would never be found.
    const upper = command.toUpperCase();
    const hasExt = pathExts.some((e) => upper.endsWith(e.toUpperCase()));
    exts = hasExt ? ['', ...pathExts] : pathExts;
  } else {
    exts = [''];
  }
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here / not executable — keep searching
      }
    }
  }
  throw new ProcessDeniedError('the command was not found on PATH'); // deterministic — fatal, never retried
}

/** Reject a declared env var the host forbids (injection / config-steering) — case-insensitive, fail-closed. */
function assertSafeDeclaredEnv(declaredEnv: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(declaredEnv)) {
    const k = key.toUpperCase(); // Windows env names are case-insensitive; normalize so `node_options` can't slip past
    if (
      FORBIDDEN_DECLARED_ENV.has(k) ||
      FORBIDDEN_DECLARED_ENV_PREFIX.some((p) => k.startsWith(p))
    ) {
      throw new ProcessDeniedError('a declared environment variable is not permitted');
    }
  }
}

/**
 * Resolve the spawn cwd against the workspace and confine it there (a config `cwd` may not escape the sandbox
 * root). The workspace root is **realpath**-canonicalized once (mirroring the fs arm's `realScopeRoots`) so the
 * jail boundary is expressed in REAL paths — on macOS the workspace usually lives under a symlinked prefix
 * (`/var`→`/private/var`, `/tmp`→`/private/tmp`), and a purely lexical root would reject every realpath'd child
 * spuriously. The candidate is checked against that canonical root both lexically (cheap, catches an obvious
 * `../` escape) and after its own `realpath` (a symlink inside the workspace pointing outside passes the lexical
 * test but resolves beyond the jail at spawn time). Absent ⇒ the workspace root.
 */
async function jailCwd(workspaceDir: string, cwd: string | undefined): Promise<string> {
  // Canonicalize the root through realpath; if it does not resolve (missing dir) fall back to the lexical resolve
  // so both branches still produce an absolute, trailing-sep-stripped boundary.
  const resolvedRoot = resolve(workspaceDir);
  const root = await realpath(resolvedRoot).catch(() => resolvedRoot);
  if (cwd === undefined) return root;
  // Guard the trailing separator (mirrors fs.ts buildScopeChecker): a filesystem/drive root (`/`, `C:\`) keeps
  // its trailing sep, so a bare `root + sep` would double it and reject a valid child.
  const prefix = root.endsWith(sep) ? root : root + sep;
  const inRoot = (p: string): boolean => p === root || p.startsWith(prefix);
  const lexical = resolve(root, cwd);
  if (!inRoot(lexical)) {
    throw new ProcessDeniedError('the working directory is outside the workspace');
  }
  // Realpath the resolved candidate and re-check against the SAME canonical root.
  const real = await realpath(lexical).catch(() => {
    throw new ProcessDeniedError('the working directory is not accessible');
  });
  if (!inRoot(real)) {
    throw new ProcessDeniedError('the working directory is outside the workspace');
  }
  return real;
}

/** The audited platform-minimal base env: only the allowlisted ambient keys (never the full `process.env`). */
function minimalBaseEnv(): Record<string, string> {
  const keys = process.platform === 'win32' ? WINDOWS_ENV_KEYS : POSIX_ENV_KEYS;
  const base: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return base;
}

/** Cooperative cancellation — reject before spawning if the run already aborted (shared reason-only helper). */
function throwIfAborted(signal: AbortSignalLike | undefined): void {
  throwIfAbortedShared(signal, 'the command was aborted');
}
