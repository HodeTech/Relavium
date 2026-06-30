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

  it('Linux: notify-send takes title + body as positional ARGS (shell:false data, no env overlay)', () => {
    const plan = notifyPlan('linux', input);
    expect(plan.executable).toBe('notify-send');
    expect(plan.args).toEqual(['Done', input.body]);
    expect(plan.env).toBeUndefined();
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

  it('merges the notify env OVERLAY over the ambient env (so DISPLAY/DBUS survive)', async () => {
    const { spawnImpl, calls } = fakeSpawn([{ code: 0 }]);
    const os = createNodeOsCapability({ platform: 'darwin', spawnImpl });
    await os.notify({ title: 't', body: 'b' });
    // The ambient PATH is still present alongside the injected notify vars.
    expect(calls[0]?.env['PATH']).toBe(process.env['PATH']);
    expect(calls[0]?.env['RELAVIUM_NOTIFY_TITLE']).toBe('t');
  });
});

describe('os errors share the host taxonomy', () => {
  it('OsCapabilityError and EgressCapabilityError are distinct transient host errors', () => {
    expect(new OsCapabilityError('x')).toBeInstanceOf(OsCapabilityError);
    expect(new OsCapabilityError('x')).not.toBeInstanceOf(EgressCapabilityError);
  });
});
