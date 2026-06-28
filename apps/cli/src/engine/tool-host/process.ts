import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

import { ToolDispatchError, type ProcessCapability, type ProcessResult } from '@relavium/core';
import type { AbortSignalLike, ErrorCode } from '@relavium/shared';

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
const POSIX_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM'] as const;
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
 * command value / output / env (the I3 boundary). Maps to the retryable `tool_failed`.
 */
export class ProcessCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessCapabilityError';
  }
}

/**
 * A **deterministic host refusal** — an empty/not-found command, or a declared env var the host forbids. It is
 * a {@link ToolDispatchError} (passed through by the registry) mapping to the **fatal**, non-retryable
 * `tool_denied`: re-issuing the same command re-fails identically, so it must NOT burn the node-retry budget
 * (error-handling.md §tool-dispatch codes). Mirrors the fs arm's `FsScopeDeniedError`.
 */
export class ProcessDeniedError extends ToolDispatchError {
  readonly code = 'tool_denied';
  readonly runErrorCode: ErrorCode = 'tool_denied';
  readonly retryable = false;
  constructor(message: string) {
    super(message, undefined, undefined);
    this.name = 'ProcessDeniedError';
  }
}

/**
 * Declared env vars the host **forbids** even from a trusted workflow author: code/library **injection**
 * vectors that would run attacker code in the child (or a grandchild) regardless of the allowlisted binary.
 * `PATH`/`Path` are rejected too — executable resolution deliberately ignores a declared `PATH`, so accepting
 * one would only mislead. A declared var is merged on top of the audited base env; this is the audit
 * (built-in-tools.md §Subprocess environment names `NODE_OPTIONS` as a hijack vector).
 */
const FORBIDDEN_DECLARED_ENV = new Set([
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'BASH_ENV',
  'ENV',
  'IFS',
  'PYTHONPATH',
  'PERL5LIB',
  'RUBYLIB',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'PATH',
  'Path',
]);
/** Dynamic-loader prefixes (`DYLD_INSERT_LIBRARIES`, `LD_*`) — any declared key starting with one is forbidden. */
const FORBIDDEN_DECLARED_ENV_PREFIX = ['DYLD_', 'LD_'];

/**
 * Build a node-backed {@link ProcessCapability}. The returned object is the value a host wires onto
 * `ToolHost.process`; it holds no ambient state beyond the immutable config.
 */
export function createNodeProcessCapability(config: NodeProcessCapabilityConfig): ProcessCapability {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  return {
    spawn: async (command, args, declaredEnv, opts, signal) => {
      throwIfAborted(signal);
      assertSafeDeclaredEnv(declaredEnv);
      const executable = await resolveExecutable(command);
      const timeoutMs = Math.min(opts.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs);
      const cwd = jailCwd(config.workspaceDir, opts.cwd);
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
    child.on('error', () => finish(() => reject(new ProcessCapabilityError('the command failed to run'))));
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
  #bytes = 0;
  #truncated = false;
  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    if (this.#bytes >= this.max) {
      this.#truncated = true;
      return;
    }
    const room = this.max - this.#bytes;
    if (chunk.length <= room) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.length;
    } else {
      this.#chunks.push(chunk.subarray(0, room));
      this.#bytes = this.max;
      this.#truncated = true;
    }
  }

  text(): string {
    const body = Buffer.concat(this.#chunks).toString('utf8');
    return this.#truncated ? `${body}\n…[output truncated at ${this.max} bytes]` : body;
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
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e !== '')
      : [''];
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

/** Reject a declared env var the host forbids (injection vectors / `PATH`) — fail-closed and visible (the audit). */
function assertSafeDeclaredEnv(declaredEnv: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(declaredEnv)) {
    if (FORBIDDEN_DECLARED_ENV.has(key) || FORBIDDEN_DECLARED_ENV_PREFIX.some((p) => key.startsWith(p))) {
      throw new ProcessDeniedError('a declared environment variable is not permitted');
    }
  }
}

/** Resolve the spawn cwd against the workspace and confine it there (a config `cwd` may not escape the sandbox root). */
function jailCwd(workspaceDir: string, cwd: string | undefined): string {
  if (cwd === undefined) return workspaceDir;
  const resolved = resolve(workspaceDir, cwd);
  const prefix = workspaceDir.endsWith(sep) ? workspaceDir : workspaceDir + sep;
  if (resolved !== workspaceDir && !resolved.startsWith(prefix)) {
    throw new ProcessDeniedError('the working directory is outside the workspace');
  }
  return resolved;
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

/** Cooperative cancellation — reject before spawning if the run already aborted. */
function throwIfAborted(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted === true) {
    throw new ProcessCapabilityError('the command was aborted');
  }
}
