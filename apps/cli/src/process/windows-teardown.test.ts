import { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { RelaviumError } from '@relavium/shared/relavium-error';
import { describe, expect, it, vi } from 'vitest';

import {
  verifyWindowsTaskkillFacility,
  WINDOWS_TEARDOWN_UNAVAILABLE_CODE,
  WINDOWS_TEARDOWN_UNAVAILABLE_MESSAGE,
  WindowsTeardownUnavailableError,
  type WindowsTaskkillVerificationPorts,
} from './windows-teardown.js';

const ROOT = 'C:\\Windows';
const SYSTEM_DIRECTORY = `${ROOT}\\System32`;
const EXECUTABLE = `${SYSTEM_DIRECTORY}\\taskkill.exe`;

type FileKind = 'directory' | 'file' | 'symlink' | 'other';

/** Windows paths/filesystem/spawn are explicitly simulated. No native taskkill executes here. */
function simulatedWindows() {
  const kinds = new Map<string, FileKind>([
    [ROOT, 'directory'],
    [SYSTEM_DIRECTORY, 'directory'],
    [EXECUTABLE, 'file'],
  ]);
  const canonicalPaths = new Map<string, string>();
  const helper = new ChildProcess();
  const spawn = vi.fn<WindowsTaskkillVerificationPorts['spawn']>(() => helper);
  const stat = vi.fn<WindowsTaskkillVerificationPorts['lstat']>((path) => {
    const kind = kinds.get(path);
    if (kind === undefined) return Promise.reject(new Error('simulated missing file'));
    return Promise.resolve({
      isDirectory: () => kind === 'directory',
      isFile: () => kind === 'file',
      isSymbolicLink: () => kind === 'symlink',
    });
  });
  const realpath = vi.fn<WindowsTaskkillVerificationPorts['realpath']>((path) =>
    Promise.resolve(canonicalPaths.get(path) ?? path),
  );
  const access = vi.fn<WindowsTaskkillVerificationPorts['access']>(() => Promise.resolve());
  const ports: WindowsTaskkillVerificationPorts = {
    platform: 'win32',
    systemRoot: ROOT,
    lstat: stat,
    realpath,
    access,
    spawn,
  };
  return { ports, kinds, canonicalPaths, helper, spawn, stat, realpath, access };
}

describe('Windows taskkill facility (simulated Windows native ports)', () => {
  it('imports lazily without filesystem access, helper spawn or process listeners', async () => {
    const nativeAccess = vi.fn();
    const nativeLstat = vi.fn();
    const nativeRealpath = vi.fn();
    const nativeSpawn = vi.fn();
    const processEvents: EventEmitter = process;
    const events = processEvents.eventNames();
    const listeners = events.map((event) => [event, processEvents.listeners(event)]);
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      access: nativeAccess,
      lstat: nativeLstat,
      realpath: nativeRealpath,
    }));
    vi.doMock('node:child_process', () => ({ spawn: nativeSpawn }));
    try {
      const imported = await import('./windows-teardown.js');
      expect(nativeAccess).not.toHaveBeenCalled();
      expect(nativeLstat).not.toHaveBeenCalled();
      expect(nativeRealpath).not.toHaveBeenCalled();
      expect(nativeSpawn).not.toHaveBeenCalled();
      expect(processEvents.eventNames()).toEqual(events);
      expect(events.map((event) => [event, processEvents.listeners(event)])).toEqual(listeners);
      const simulated = simulatedWindows();
      await imported.verifyWindowsTaskkillFacility(simulated.ports);
      expect(simulated.stat).toHaveBeenCalledTimes(3);
      expect(simulated.spawn).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('verifies the fixed installation path before producing an inert frozen capability', async () => {
    const simulated = simulatedWindows();
    const facility = await verifyWindowsTaskkillFacility(simulated.ports);
    expect(simulated.stat.mock.calls).toEqual([[ROOT], [SYSTEM_DIRECTORY], [EXECUTABLE]]);
    expect(simulated.realpath.mock.calls).toEqual([[ROOT], [SYSTEM_DIRECTORY], [EXECUTABLE]]);
    expect(simulated.access).toHaveBeenCalledExactlyOnceWith(EXECUTABLE, constants.X_OK);
    expect(simulated.spawn).not.toHaveBeenCalled();
    expect(Object.isFrozen(facility)).toBe(true);
    expect(Object.keys(facility)).toEqual(['spawn']);
  });

  it('uses only absolute taskkill, one decimal PID and fixed shell-free ignored-output options', async () => {
    const simulated = simulatedWindows();
    const facility = await verifyWindowsTaskkillFacility(simulated.ports);
    expect(facility.spawn(1234)).toBe(simulated.helper);
    expect(simulated.spawn).toHaveBeenCalledExactlyOnceWith(
      EXECUTABLE,
      ['/PID', '1234', '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    // The exact unmodified helper is returned. Neither request success nor error claims target close.
    expect(simulated.helper.eventNames()).toEqual([]);
  });

  it('captures the verified executable and spawn port, without retaining mutable env/port decisions', async () => {
    const simulated = simulatedWindows();
    const facility = await verifyWindowsTaskkillFacility(simulated.ports);
    const replacement = vi.fn();
    Object.defineProperty(simulated.ports, 'systemRoot', { value: 'D:\\hostile-root' });
    Object.defineProperty(simulated.ports, 'spawn', { value: replacement });
    facility.spawn(1);
    facility.spawn(4321);
    expect(simulated.spawn.mock.calls.map(([path, argv]) => [path, argv])).toEqual([
      [EXECUTABLE, ['/PID', '1', '/T', '/F']],
      [EXECUTABLE, ['/PID', '4321', '/T', '/F']],
    ]);
    expect(replacement).not.toHaveBeenCalled();
    expect(simulated.stat).toHaveBeenCalledTimes(3);
  });

  it.each([
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '123 /IM *',
    '123',
    null,
    undefined,
    {},
    [],
    1n,
    Symbol('pid'),
  ])('refuses malformed PID %s before any helper spawn', async (pid) => {
    const simulated = simulatedWindows();
    const facility = await verifyWindowsTaskkillFacility(simulated.ports);
    expect(() => {
      Reflect.apply(facility.spawn, undefined, [pid]);
    }).toThrow(WindowsTeardownUnavailableError);
    expect(simulated.spawn).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '',
    'Windows',
    '\\Windows',
    'C:Windows',
    '\\\\server\\Windows',
    '\\\\?\\C:\\Windows',
    '\\\\.\\C:\\Windows',
    'C:\\Windows\\..\\elsewhere',
    'C:\\Windows\\.',
    'C:\\Windows:stream',
    'C:\\Windows ',
    'C:\\Windows.',
    'C:\\Windows\\\\child',
    'C:\\Windows\\NUL',
    'C:\\Windows\\COM1.txt',
    'C:\\Windows\u0000',
    'C:\\Windows\\*',
  ])('rejects nonordinary installation root %s before filesystem work', async (systemRoot) => {
    const simulated = simulatedWindows();
    await expect(
      verifyWindowsTaskkillFacility({ ...simulated.ports, systemRoot }),
    ).rejects.toBeInstanceOf(WindowsTeardownUnavailableError);
    expect(simulated.stat).not.toHaveBeenCalled();
    expect(simulated.spawn).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin'] satisfies NodeJS.Platform[])(
    'rejects %s platform without filesystem work or spawning',
    async (platform) => {
      const simulated = simulatedWindows();
      await expect(
        verifyWindowsTaskkillFacility({ ...simulated.ports, platform }),
      ).rejects.toBeInstanceOf(WindowsTeardownUnavailableError);
      expect(simulated.stat).not.toHaveBeenCalled();
      expect(simulated.spawn).not.toHaveBeenCalled();
    },
  );

  it('accepts normal Windows casing and separators while preserving canonical executable spelling', async () => {
    const simulated = simulatedWindows();
    simulated.canonicalPaths.set(ROOT, 'c:\\WINDOWS');
    simulated.kinds.set('c:\\WINDOWS\\System32', 'directory');
    simulated.canonicalPaths.set('c:\\WINDOWS\\System32', 'C:\\Windows\\SYSTEM32');
    simulated.kinds.set('C:\\Windows\\SYSTEM32\\taskkill.exe', 'file');
    simulated.canonicalPaths.set('C:\\Windows\\SYSTEM32\\taskkill.exe', EXECUTABLE.toUpperCase());
    const facility = await verifyWindowsTaskkillFacility({
      ...simulated.ports,
      systemRoot: 'C:/Windows/',
    });
    facility.spawn(2222);
    expect(simulated.spawn.mock.calls[0]?.[0]).toBe(EXECUTABLE.toUpperCase());
  });

  it.each([
    [ROOT, 'C:\\Elsewhere'],
    [SYSTEM_DIRECTORY, 'C:\\Windows\\RedirectedSystem32'],
    [SYSTEM_DIRECTORY, 'D:\\Windows\\System32'],
    [EXECUTABLE, 'C:\\Windows\\taskkill.exe'],
    [EXECUTABLE, 'C:\\Windows-other\\System32\\taskkill.exe'],
    [EXECUTABLE, 'C:\\Windows\\System32\\other.exe'],
    [EXECUTABLE, '\\\\?\\C:\\Windows\\System32\\taskkill.exe'],
    [EXECUTABLE, 'C:\\Windows\\System32\\taskkill.exe:stream'],
  ])('rejects redirected/nonordinary canonical path for %s', async (path, canonical) => {
    const simulated = simulatedWindows();
    simulated.canonicalPaths.set(path, canonical);
    await expect(verifyWindowsTaskkillFacility(simulated.ports)).rejects.toBeInstanceOf(
      WindowsTeardownUnavailableError,
    );
    expect(simulated.spawn).not.toHaveBeenCalled();
  });

  it.each([
    [ROOT, 'file'],
    [ROOT, 'symlink'],
    [SYSTEM_DIRECTORY, 'file'],
    [SYSTEM_DIRECTORY, 'symlink'],
    [EXECUTABLE, 'directory'],
    [EXECUTABLE, 'symlink'],
    [EXECUTABLE, 'other'],
  ] satisfies [string, FileKind][])(
    'rejects nonordinary file kind at %s (%s)',
    async (path, kind) => {
      const simulated = simulatedWindows();
      simulated.kinds.set(path, kind);
      await expect(verifyWindowsTaskkillFacility(simulated.ports)).rejects.toBeInstanceOf(
        WindowsTeardownUnavailableError,
      );
      expect(simulated.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([ROOT, SYSTEM_DIRECTORY, EXECUTABLE])(
    'refuses missing %s without spawning',
    async (path) => {
      const simulated = simulatedWindows();
      simulated.kinds.delete(path);
      await expect(verifyWindowsTaskkillFacility(simulated.ports)).rejects.toBeInstanceOf(
        WindowsTeardownUnavailableError,
      );
      expect(simulated.spawn).not.toHaveBeenCalled();
    },
  );

  it.each(['lstat', 'realpath', 'access'] as const)(
    'wraps %s failure with a fixed public refusal while retaining internal cause identity',
    async (operation) => {
      const simulated = simulatedWindows();
      const cause = new Error('secret-path argv env native-cause-stack');
      Object.defineProperty(simulated.ports, operation, {
        value: vi.fn().mockRejectedValue(cause),
      });
      const error: unknown = await verifyWindowsTaskkillFacility(simulated.ports).catch(
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(RelaviumError);
      expect(error).toBeInstanceOf(WindowsTeardownUnavailableError);
      if (!(error instanceof WindowsTeardownUnavailableError))
        throw new Error('missing typed refusal');
      expect(error.code).toBe(WINDOWS_TEARDOWN_UNAVAILABLE_CODE);
      expect(error.message).toBe(WINDOWS_TEARDOWN_UNAVAILABLE_MESSAGE);
      expect(error.message).not.toContain('secret');
      expect(error.cause).toBe(cause);
      expect(simulated.spawn).not.toHaveBeenCalled();
    },
  );

  it('leaves synchronous native spawn failures to the caller without inventing helper or target close', async () => {
    const simulated = simulatedWindows();
    const cause = new Error('simulated native spawn failure');
    simulated.spawn.mockImplementation(() => {
      throw cause;
    });
    const facility = await verifyWindowsTaskkillFacility(simulated.ports);
    expect(() => facility.spawn(3456)).toThrow(cause);
    expect(simulated.spawn).toHaveBeenCalledTimes(1);
    expect(simulated.helper.eventNames()).toEqual([]);
  });
});

describe('Windows taskkill facility (actual host verification only)', () => {
  it.skipIf(process.platform !== 'win32')(
    'verifies the real launching installation with a hostile PATH shim never consulted',
    async () => {
      const savedPath = process.env['PATH'];
      const savedPathExt = process.env['PATHEXT'];
      try {
        // The real FS verifier must succeed without PATH/PATHEXT. This executes no taskkill and
        // targets no PID. Owned-child/helper-close integration belongs to the native owner suite.
        process.env['PATH'] = 'Z:\\relavium-hostile-taskkill-shim';
        process.env['PATHEXT'] = '.CMD;.BAT';
        const facility = await verifyWindowsTaskkillFacility();
        expect(Object.isFrozen(facility)).toBe(true);
      } finally {
        if (savedPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = savedPath;
        if (savedPathExt === undefined) delete process.env['PATHEXT'];
        else process.env['PATHEXT'] = savedPathExt;
      }
    },
  );
});
