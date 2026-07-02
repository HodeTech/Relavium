import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { EgressCapabilityError } from './errors.js'; // sibling check: the os errors live in the same module
import {
  clipboardReadPlans,
  createNodeOsCapability,
  notifyPlan,
  type OsSpawnFn,
  type OsSpawnLike,
} from './os.js';
import { OsCapabilityError } from './errors.js';

/** One scripted result per spawn call: a stdout payload + an exit code, or a synchronous spawn `throw`. */
interface ScriptedCall {
  readonly stdout?: string;
  readonly code?: number | null;
  readonly throwOnSpawn?: boolean;
  readonly emitError?: boolean;
}

interface RecordedCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/** A deterministic fake `spawn`: replays `script` calls in order, recording each (executable, args, env). */
function fakeSpawn(script: readonly ScriptedCall[]): {
  spawnImpl: OsSpawnFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const spawnImpl: OsSpawnFn = (executable, args, options) => {
    const scripted = script[index] ?? {};
    index += 1;
    calls.push({ executable, args, env: options.env });
    if (scripted.throwOnSpawn === true) throw new Error('ENOENT');
    const child = new EventEmitter() as EventEmitter & OsSpawnLike;
    const stdout = new EventEmitter();
    Object.defineProperty(child, 'stdout', { value: stdout });
    Object.defineProperty(child, 'kill', { value: () => undefined });
    queueMicrotask(() => {
      if (scripted.emitError === true) {
        child.emit('error');
        return;
      }
      if (scripted.stdout !== undefined && scripted.stdout.length > 0) {
        stdout.emit('data', Buffer.from(scripted.stdout, 'utf8'));
      }
      child.emit('close', scripted.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

/**
 * A spawn whose children stay "running" — they never emit `close` on their own, so a timeout timer or an
 * abort handler is what ends them. `kill('SIGKILL')` models the real OS: it bumps `killCount` and then emits
 * `close` with a NULL code (a signal-killed process has no natural exit code), which is exactly what
 * spawnCapturing's timeout/abort branches key on.
 */
function controllableSpawn(): {
  spawnImpl: OsSpawnFn;
  calls: RecordedCall[];
  killCount: () => number;
} {
  const calls: RecordedCall[] = [];
  let killCount = 0;
  const spawnImpl: OsSpawnFn = (executable, args, options) => {
    calls.push({ executable, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & OsSpawnLike;
    const stdout = new EventEmitter();
    Object.defineProperty(child, 'stdout', { value: stdout });
    Object.defineProperty(child, 'kill', {
      value: () => {
        killCount += 1;
        queueMicrotask(() => child.emit('close', null)); // SIGKILL ⇒ death ⇒ close with a null code
      },
    });
    return child; // never emits close on its own — only a timeout/abort kill ends it
  };
  return { spawnImpl, calls, killCount: () => killCount };
}

describe('notifyPlan — the per-platform spawn plan (injection-free arg/env construction)', () => {
  const input = { title: 'Done', body: 'evil"; rm -rf / #$(whoami)' } as const;

  it('macOS: osascript reads title/body from env via `system attribute` — NEVER in argv', () => {
    const plan = notifyPlan('darwin', input);
    expect(plan.executable).toBe('osascript');
    expect(plan.env?.['RELAVIUM_NOTIFY_TITLE']).toBe('Done');
    expect(plan.env?.['RELAVIUM_NOTIFY_BODY']).toBe(input.body);
    // The dangerous body never appears in the script argv — it is read as `system attribute` DATA.
    expect(plan.args.join('\n')).not.toContain(input.body);
    expect(plan.args.join('\n')).toContain('system attribute');
  });

  it('Windows: powershell reads title/body from $env: — the body is NEVER interpolated into the script', () => {
    const plan = notifyPlan('win32', input);
    expect(plan.executable).toBe('powershell');
    expect(plan.env?.['RELAVIUM_NOTIFY_BODY']).toBe(input.body);
    expect(plan.args.join('\n')).not.toContain(input.body);
    expect(plan.args.join('\n')).toContain('$env:RELAVIUM_NOTIFY_BODY');
  });

  it('Linux: notify-send takes title + body as positional ARGS after `--` (flag-injection safe, no env overlay)', () => {
    const plan = notifyPlan('linux', input);
    expect(plan.executable).toBe('notify-send');
    // The `--` end-of-options marker means a title/body starting with `-` is DATA, never a parsed flag.
    expect(plan.args).toEqual(['--', 'Done', input.body]);
    expect(plan.env).toBeUndefined();
  });

  it('Linux: a `-`-prefixed title is still positional (behind `--`), not parsed as a notify-send flag', () => {
    const plan = notifyPlan('linux', { title: '--help', body: '-x' });
    expect(plan.args).toEqual(['--', '--help', '-x']);
  });
});

describe('clipboardReadPlans — per-platform candidate order', () => {
  it('macOS is pbpaste; Windows is Get-Clipboard; Linux tries Wayland then X11 (xclip, xsel)', () => {
    expect(clipboardReadPlans('darwin').map((p) => p.executable)).toEqual(['pbpaste']);
    expect(clipboardReadPlans('win32').map((p) => p.executable)).toEqual(['powershell']);
    expect(clipboardReadPlans('linux').map((p) => p.executable)).toEqual([
      'wl-paste',
      'xclip',
      'xsel',
    ]);
  });
});

describe('createNodeOsCapability — readClipboard', () => {
  it('returns the clipboard text from the first successful candidate', async () => {
    const { spawnImpl, calls } = fakeSpawn([{ stdout: 'hello clip', code: 0 }]);
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl });
    expect(await os.readClipboard()).toBe('hello clip');
    expect(calls[0]?.executable).toBe('pbpaste');
  });

  it('falls through a missing Linux candidate to the next that works (wl-paste absent → xclip)', async () => {
    const { spawnImpl, calls } = fakeSpawn([
      { throwOnSpawn: true }, // wl-paste not installed
      { stdout: 'from xclip', code: 0 }, // xclip succeeds
    ]);
    const os = createNodeOsCapability({ platform: 'linux', spawnImpl });
    expect(await os.readClipboard()).toBe('from xclip');
    expect(calls.map((c) => c.executable)).toEqual(['wl-paste', 'xclip']);
  });

  it('throws OsCapabilityError (retryable tool_failed) when no clipboard tool is available', async () => {
    const { spawnImpl } = fakeSpawn([
      { throwOnSpawn: true },
      { throwOnSpawn: true },
      { throwOnSpawn: true },
    ]);
    const os = createNodeOsCapability({ platform: 'linux', spawnImpl });
    const err = await os.readClipboard().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OsCapabilityError);
    expect((err as OsCapabilityError).message).toBe('no clipboard tool is available');
  });

  it('treats a non-zero exit as a read failure (falls through, then surfaces a read error)', async () => {
    const { spawnImpl } = fakeSpawn([{ code: 1 }]);
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl });
    await expect(os.readClipboard()).rejects.toBeInstanceOf(OsCapabilityError);
  });

  it('does not run any candidate when the signal is already aborted', async () => {
    const { spawnImpl, calls } = fakeSpawn([{ stdout: 'x', code: 0 }]);
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl });
    const ac = new AbortController();
    ac.abort();
    await expect(os.readClipboard(ac.signal)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });
});

describe('createNodeOsCapability — notify', () => {
  it('spawns the platform notifier and resolves on exit 0, passing title/body via env (macOS)', async () => {
    const { spawnImpl, calls } = fakeSpawn([{ code: 0 }]);
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl });
    await os.notify({ title: 'Title', body: 'Body' });
    expect(calls[0]?.executable).toBe('osascript');
    expect(calls[0]?.env['RELAVIUM_NOTIFY_TITLE']).toBe('Title');
    expect(calls[0]?.env['RELAVIUM_NOTIFY_BODY']).toBe('Body');
  });

  it('rejects with OsCapabilityError when the notifier exits non-zero', async () => {
    const { spawnImpl } = fakeSpawn([{ code: 2 }]);
    const os = createNodeOsCapability({ platform: 'linux', spawnImpl });
    await expect(os.notify({ title: 't', body: 'b' })).rejects.toBeInstanceOf(OsCapabilityError);
  });

  it('rejects with OsCapabilityError when the notifier fails to spawn (error event)', async () => {
    const { spawnImpl } = fakeSpawn([{ emitError: true }]);
    const os = createNodeOsCapability({ platform: 'linux', spawnImpl });
    await expect(os.notify({ title: 't', body: 'b' })).rejects.toBeInstanceOf(OsCapabilityError);
  });

  it('rejects with OsCapabilityError when the notifier binary is not installed (synchronous spawn throw)', async () => {
    // The single most likely real-world notify failure: `notify-send` simply absent (ENOENT at spawn).
    const { spawnImpl } = fakeSpawn([{ throwOnSpawn: true }]);
    const os = createNodeOsCapability({ platform: 'linux', spawnImpl });
    const err = await os.notify({ title: 't', body: 'b' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OsCapabilityError);
    expect((err as OsCapabilityError).message).toBe('the os command could not be started');
  });

  it('merges the notify env OVERLAY over the ambient env (so DISPLAY/DBUS survive)', async () => {
    const { spawnImpl, calls } = fakeSpawn([{ code: 0 }]);
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl });
    await os.notify({ title: 't', body: 'b' });
    // The ambient PATH is still present alongside the injected notify vars.
    expect(calls[0]?.env['PATH']).toBe(process.env['PATH']);
    expect(calls[0]?.env['RELAVIUM_NOTIFY_TITLE']).toBe('t');
  });
});

describe('createNodeOsCapability — timeout + mid-spawn abort + the bounded buffer (the SIGKILL paths)', () => {
  it('SIGKILLs a hung clipboard candidate past timeoutMs and rejects with the timeout reason', async () => {
    const { spawnImpl, killCount } = controllableSpawn();
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl, timeoutMs: 10 });
    const err = await os.readClipboard().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OsCapabilityError);
    expect((err as OsCapabilityError).message).toBe('the os command timed out'); // not the misleading default
    expect(killCount()).toBeGreaterThanOrEqual(1); // the timer SIGKILLed the hung child
  });

  it('SIGKILLs a hung notify spawn past timeoutMs and rejects', async () => {
    const { spawnImpl, killCount } = controllableSpawn();
    const os = createNodeOsCapability({ platform: 'linux', spawnImpl, timeoutMs: 10 });
    await expect(os.notify({ title: 't', body: 'b' })).rejects.toBeInstanceOf(OsCapabilityError);
    expect(killCount()).toBeGreaterThanOrEqual(1);
  });

  it('aborts an IN-FLIGHT clipboard spawn and does NOT probe the next candidate', async () => {
    const { spawnImpl, calls, killCount } = controllableSpawn();
    const os = createNodeOsCapability({ platform: 'linux', spawnImpl }); // 3 candidates (wl-paste, xclip, xsel)
    const ac = new AbortController();
    const pending = os.readClipboard(ac.signal);
    await Promise.resolve(); // let the first candidate spawn + register its abort listener
    ac.abort(); // onAbort ⇒ SIGKILL ⇒ close(null) with aborted=true ⇒ reject; the loop must NOT fall through
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1); // ONLY wl-paste — the abort stopped the loop; xclip/xsel never spawned
    expect(killCount()).toBeGreaterThanOrEqual(1);
  });

  it('caps clipboard output at maxBufferBytes (the memory guard)', async () => {
    const { spawnImpl } = fakeSpawn([{ stdout: 'hello world', code: 0 }]); // 11 bytes
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl, maxBufferBytes: 5 });
    expect(await os.readClipboard()).toBe('hello'); // capped to the first 5 bytes
  });
});

describe('os errors share the host taxonomy', () => {
  it('OsCapabilityError and EgressCapabilityError are distinct transient host errors', () => {
    expect(new OsCapabilityError('x')).toBeInstanceOf(OsCapabilityError);
    expect(new OsCapabilityError('x')).not.toBeInstanceOf(EgressCapabilityError);
  });
});
