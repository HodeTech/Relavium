import { type ChildProcess, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import type { ProcessCapability, ProcessResult } from '@relavium/core';
import { isForbiddenDeclaredEnvKey, type AbortSignalLike } from '@relavium/shared';

import { findOnPath } from '../find-on-path.js';

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
 * The declared-environment rule lives in `@relavium/shared`'s `isForbiddenDeclaredEnvKey` — one predicate,
 * consumed here and by the two MCP stdio entry points
 * ([ADR-0084](../../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §4).
 *
 * The list is deliberately NOT restated here. It was, in the docblock this replaces, and that copy had
 * already drifted: it claimed `PERL5*`, `RUBY*` and `JAVA_*` were prefixes when only the exact names are.
 * A stale restatement of a security control reads as complete and is not, which is why the ADR names the
 * predicate as the list's one home.
 */

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
  // The walk itself moved to `find-on-path.ts` when ADR-0084's consent gate became a second caller; the
  // POLICY around it stays here, because the two callers differ on it. This one returns an explicit path
  // unresolved (the spawn resolves it inside the jail) and fails closed on a miss with its own typed error.
  const found = await findOnPath(command);
  if (found === undefined) {
    throw new ProcessDeniedError('the command was not found on PATH'); // deterministic — fatal, never retried
  }
  return found;
}

/** Reject a declared env var the host forbids (injection / config-steering) — case-insensitive, fail-closed. */
function assertSafeDeclaredEnv(declaredEnv: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(declaredEnv)) {
    // The list moved to `@relavium/shared` when ADR-0084 §4 made the MCP stdio path a second consumer. It was
    // here, and only here, while the other host that spawns a program a shared artifact names passed every
    // declared variable through untouched — two hosts, one rule, so it lives where both can reach it.
    if (isForbiddenDeclaredEnvKey(key)) {
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
