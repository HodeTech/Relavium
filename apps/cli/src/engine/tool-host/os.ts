import { spawn } from 'node:child_process';

import type { NotifyInput, OsCapability } from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

import { OsCapabilityError, throwIfAborted as throwIfAbortedShared } from './errors.js';

/**
 * The Node host **mechanism** half of the `ToolHost.os` capability arm (2.5.E Step 3, [ADR-0057](../../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)) —
 * it backs the engine's `read_clipboard` + `notify` tools. Each is a thin spawn of a FIXED, host-chosen
 * platform binary (`pbpaste` / `osascript` / `notify-send` / `powershell` / `wl-paste` / `xclip` / `xsel`) —
 * **never a model-chosen command**, unlike the `process` arm. The model controls only the notify title/body,
 * which are passed **exclusively as process ARGV or env** (`shell: false`) — never interpolated into a shell,
 * AppleScript, or PowerShell **script string** — so there is no command/script-injection surface.
 *
 * Because the binary is fixed and the model's input never reaches anything that *evaluates* it (an AppleScript
 * `system attribute` / a PowerShell `$env:` read / a positional `notify-send` arg are all DATA), the spawn
 * inherits the ambient env — desktop integration genuinely needs it (`DISPLAY`, `WAYLAND_DISPLAY`,
 * `DBUS_SESSION_BUS_ADDRESS`, `XAUTHORITY`). This is the deliberate distinction from the `process` arm, which
 * runs *model/workflow-allowlisted arbitrary* commands and therefore MUST minimize the env.
 *
 * Clipboard text is **untrusted** model-facing data; a failure names a REASON only (the I3 boundary) and maps
 * to the retryable `tool_failed` via {@link OsCapabilityError} — a desktop service can be transiently
 * unavailable (no `DISPLAY`/DBUS yet), and a missing helper on one Linux box may have a sibling that works.
 */

/** A clipboard/notify spawn that exceeded its timeout — a {@link OsCapabilityError} the read loop can single
 * out from a missing-binary spawn error (a hung tool is a real failure worth surfacing; an absent one is not). */
class OsTimeoutError extends OsCapabilityError {}

const DEFAULT_TIMEOUT_MS = 10_000;
/** A 1 MiB clipboard-read cap (the model-facing result is further bounded by the registry). */
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/** Env var names the platform notify scripts read title/body from (DATA, never interpolated into the script). */
const NOTIFY_TITLE_ENV = 'RELAVIUM_NOTIFY_TITLE';
const NOTIFY_BODY_ENV = 'RELAVIUM_NOTIFY_BODY';

/**
 * The Windows notification: a fixed script LITERAL (no model input interpolated) that reads the title/body from
 * `$env:` as string data and shows a balloon tip. The brief `Start-Sleep` keeps the host process alive long
 * enough for the async balloon to fire before `Dispose`.
 */
const WINDOWS_NOTIFY_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  'Add-Type -AssemblyName System.Windows.Forms;',
  'Add-Type -AssemblyName System.Drawing;',
  '$n = New-Object System.Windows.Forms.NotifyIcon;',
  '$n.Icon = [System.Drawing.SystemIcons]::Information;',
  `$n.BalloonTipTitle = $env:${NOTIFY_TITLE_ENV};`,
  `$n.BalloonTipText = $env:${NOTIFY_BODY_ENV};`,
  '$n.Visible = $true;',
  '$n.ShowBalloonTip(5000);',
  'Start-Sleep -Milliseconds 250;',
  '$n.Dispose();',
].join(' ');

export interface NodeOsCapabilityConfig {
  /** Per-call timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Clipboard-read capture ceiling in bytes (default {@link DEFAULT_MAX_BUFFER_BYTES}). */
  readonly maxBufferBytes?: number;
  /** The platform key (defaults to the host `process.platform`) — injectable so the dispatch is unit-testable. */
  readonly platform?: NodeJS.Platform;
  /** Injectable spawn (defaults to node `child_process.spawn`) — faked in tests so no real GUI binary runs. */
  readonly spawnImpl?: OsSpawnFn;
}

/** The minimal child surface the os arm uses — a real node `ChildProcess` structurally satisfies it. */
export interface OsSpawnLike {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  on(event: 'error', listener: () => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(signal: 'SIGKILL'): void;
}
export type OsSpawnFn = (
  executable: string,
  args: readonly string[],
  options: { readonly shell: false; readonly windowsHide: true; readonly env: NodeJS.ProcessEnv },
) => OsSpawnLike;

const nodeSpawn: OsSpawnFn = (executable, args, options) => spawn(executable, [...args], options);

interface SpawnPlan {
  readonly executable: string;
  readonly args: readonly string[];
  /** An env OVERLAY merged over the ambient env (used to pass notify title/body as DATA). */
  readonly env?: Record<string, string>;
}

/**
 * Build a node-backed {@link OsCapability}. The returned object holds no ambient state beyond the immutable
 * config; the model never influences WHICH binary runs.
 */
export function createNodeOsCapability(config: NodeOsCapabilityConfig = {}): OsCapability {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const platform = config.platform ?? process.platform;
  const spawnImpl = config.spawnImpl ?? nodeSpawn;

  return {
    readClipboard: async (signal) => {
      throwIfAborted(signal);
      // Try each platform candidate in order (Linux: Wayland → X11); the first that runs and exits 0 wins. A
      // missing binary, a non-zero exit, or a timeout falls through to the next; an abort propagates
      // immediately. "no clipboard tool is available" stays the message when every candidate is simply absent
      // (the most likely cause — none installed); a candidate that RAN but exited non-zero, or one that existed
      // but HUNG (a timeout), upgrades the message so it is not misleading on a single-candidate platform.
      let lastError = new OsCapabilityError('no clipboard tool is available');
      for (const plan of clipboardReadPlans(platform)) {
        let result: CaptureResult;
        try {
          result = await spawnCapturing(spawnImpl, plan, { signal, timeoutMs, maxBufferBytes });
        } catch (error) {
          throwIfAborted(signal); // an abort wins; a missing/failed candidate falls through to the next
          // A timeout (the tool exists but hung) is a real failure worth surfacing; a spawn-start error is
          // most likely a missing binary, for which the default "no tool available" is the more helpful reason.
          if (error instanceof OsTimeoutError) lastError = error;
          continue;
        }
        if (result.exitCode === 0) return result.stdout;
        lastError = new OsCapabilityError('the clipboard could not be read');
      }
      throw lastError;
    },

    notify: async (input, signal) => {
      throwIfAborted(signal);
      const result = await spawnCapturing(spawnImpl, notifyPlan(platform, input), {
        signal,
        timeoutMs,
        maxBufferBytes,
      });
      if (result.exitCode !== 0) {
        throw new OsCapabilityError('the notification could not be delivered');
      }
    },
  };
}

/** The ordered clipboard-read candidates for a platform (Linux tries Wayland, then the two X11 helpers). */
export function clipboardReadPlans(platform: NodeJS.Platform): readonly SpawnPlan[] {
  switch (platform) {
    case 'darwin':
      return [{ executable: 'pbpaste', args: [] }];
    case 'win32':
      return [
        {
          executable: 'powershell',
          args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'],
        },
      ];
    default:
      return [
        { executable: 'wl-paste', args: ['--no-newline'] },
        { executable: 'xclip', args: ['-selection', 'clipboard', '-o'] },
        { executable: 'xsel', args: ['--clipboard', '--output'] },
      ];
  }
}

/**
 * The notify spawn plan for a platform. On macOS + Windows the title/body ride in via ENV (read by the script
 * as `system attribute` / `$env:` DATA); on Linux they are positional `notify-send` ARGS (`shell: false`) — in
 * EVERY case data, never interpolated into a script/shell string, so a `"` / `;` / `$()` in the body is inert.
 */
export function notifyPlan(platform: NodeJS.Platform, input: NotifyInput): SpawnPlan {
  switch (platform) {
    case 'darwin':
      return {
        executable: 'osascript',
        args: [
          '-e',
          `display notification (system attribute "${NOTIFY_BODY_ENV}") with title (system attribute "${NOTIFY_TITLE_ENV}")`,
        ],
        env: { [NOTIFY_TITLE_ENV]: input.title, [NOTIFY_BODY_ENV]: input.body },
      };
    case 'win32':
      return {
        executable: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_NOTIFY_SCRIPT],
        env: { [NOTIFY_TITLE_ENV]: input.title, [NOTIFY_BODY_ENV]: input.body },
      };
    default:
      // `--` terminates notify-send's GOption parsing, so a title/body that begins with `-`/`--` is treated as
      // positional DATA, never a flag (an argument-injection surface `shell:false` alone does not close).
      return { executable: 'notify-send', args: ['--', input.title, input.body] };
  }
}

interface CaptureResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Spawn a fixed host binary (`shell: false`), capturing bounded stdout, with a timeout + abort kill. */
function spawnCapturing(
  spawnImpl: OsSpawnFn,
  plan: SpawnPlan,
  opts: { signal: AbortSignalLike | undefined; timeoutMs: number; maxBufferBytes: number },
): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolvePromise, reject) => {
    let child: OsSpawnLike;
    try {
      child = spawnImpl(plan.executable, plan.args, {
        shell: false, // SECURITY: no shell — the binary is fixed and model input rides as argv/env data, not code
        windowsHide: true,
        env: plan.env === undefined ? process.env : { ...process.env, ...plan.env },
      });
    } catch {
      reject(new OsCapabilityError('the os command could not be started'));
      return;
    }

    const stdout = new BoundedBuffer(opts.maxBufferBytes);
    let settled = false;
    let aborted = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (opts.signal !== undefined) opts.signal.addEventListener('abort', onAbort);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', () =>
      finish(() => reject(new OsCapabilityError('the os command failed to run'))),
    );
    child.on('close', (code) =>
      finish(() => {
        if (aborted) {
          reject(new OsCapabilityError('the os command was aborted'));
        } else if (timedOut && code === null) {
          reject(new OsTimeoutError('the os command timed out'));
        } else {
          resolvePromise({ exitCode: code ?? 1, stdout: stdout.text() });
        }
      }),
    );
  });
}

/** A byte-bounded UTF-8 accumulator: appends until the cap, then drops the rest (clipboard memory guard). */
class BoundedBuffer {
  readonly #chunks: Buffer[] = [];
  readonly #max: number;
  #bytes = 0;
  constructor(max: number) {
    this.#max = max;
  }
  push(chunk: Buffer): void {
    if (this.#bytes >= this.#max) return;
    const room = this.#max - this.#bytes;
    const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.#chunks.push(slice);
    this.#bytes += slice.length;
  }
  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

/** Cooperative cancellation — reject before spawning if the run already aborted (shared reason-only helper). */
function throwIfAborted(signal: AbortSignalLike | undefined): void {
  throwIfAbortedShared(signal, 'the os command was aborted');
}
