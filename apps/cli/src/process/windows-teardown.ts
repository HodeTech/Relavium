import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { RelaviumError } from '@relavium/shared/relavium-error';

export const WINDOWS_TEARDOWN_UNAVAILABLE_CODE = 'windows_teardown_unavailable';
export const WINDOWS_TEARDOWN_UNAVAILABLE_MESSAGE =
  'Windows subprocess teardown is unavailable. Restore the Windows system taskkill facility before retrying.';

/** Admission refusal only. The host maps this fact through its existing CLI error authority. */
export class WindowsTeardownUnavailableError extends RelaviumError {
  readonly code = WINDOWS_TEARDOWN_UNAVAILABLE_CODE;

  constructor(options?: { readonly cause?: unknown }) {
    super(
      WINDOWS_TEARDOWN_UNAVAILABLE_MESSAGE,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'WindowsTeardownUnavailableError';
  }
}

export interface WindowsTaskkillFacility {
  /**
   * Request only: the caller owns this exact helper's error/close and the target's actual close.
   * Immediately before entry, the caller must check creation ownership, root liveness and its
   * live remaining budget. This capability stores no PID, ownership or liveness decision.
   */
  readonly spawn: (pid: number) => ChildProcess;
}

interface WindowsFileKind {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface WindowsTaskkillSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: 'ignore';
}

/** Explicit native ports for simulated Windows tests; product callers use the defaults. */
export interface WindowsTaskkillVerificationPorts {
  readonly platform: NodeJS.Platform;
  readonly systemRoot: string | undefined;
  readonly lstat: (path: string) => Promise<WindowsFileKind>;
  readonly realpath: (path: string) => Promise<string>;
  readonly access: (path: string, mode: number) => Promise<void>;
  readonly spawn: (
    executable: string,
    argv: readonly string[],
    options: WindowsTaskkillSpawnOptions,
  ) => ChildProcess;
}

/**
 * Lazily verify the fixed SystemRoot/System32/taskkill.exe facility before native admission.
 * Rejects with WindowsTeardownUnavailableError, with a fixed content-free public message.
 * There is no import-time OS work, cache, listener or subprocess. The launching SystemRoot
 * and installation are trusted; canonical checks do not defeat same-user filesystem races
 * or attest an OS binary. Windows X_OK is equivalent to F_OK; native execution can still fail.
 */
export async function verifyWindowsTaskkillFacility(
  ports: WindowsTaskkillVerificationPorts = nativePorts(),
): Promise<WindowsTaskkillFacility> {
  try {
    const root = ordinaryWindowsPath(ports.systemRoot);
    if (ports.platform !== 'win32' || root === undefined)
      throw new WindowsTeardownUnavailableError();

    const canonicalRoot = await verifyPath(root, 'directory', ports);
    const systemDirectory = win32.join(canonicalRoot, 'System32');
    const canonicalSystemDirectory = await verifyPath(systemDirectory, 'directory', ports);
    const executable = await verifyPath(
      win32.join(canonicalSystemDirectory, 'taskkill.exe'),
      'file',
      ports,
    );
    await ports.access(executable, constants.X_OK);

    // Retain only the verified fixed path and this native port, never the mutable input object.
    const spawnHelper = ports.spawn;
    return Object.freeze({
      spawn: (pid: number): ChildProcess => {
        // Integers outside the safe range would stringify ambiguously; no coercion or selectors.
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new WindowsTeardownUnavailableError();
        return spawnHelper(executable, ['/PID', pid.toString(10), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
      },
    });
  } catch (error) {
    if (error instanceof WindowsTeardownUnavailableError) throw error;
    // Native detail remains an internal cause; it is never interpolated into the public refusal.
    throw new WindowsTeardownUnavailableError({ cause: error });
  }
}

function nativePorts(): WindowsTaskkillVerificationPorts {
  return {
    platform: process.platform,
    systemRoot: process.env['SystemRoot'],
    lstat,
    realpath,
    access,
    spawn,
  };
}

async function verifyPath(
  expected: string,
  kind: 'directory' | 'file',
  ports: WindowsTaskkillVerificationPorts,
): Promise<string> {
  const metadata = await ports.lstat(expected);
  if (
    metadata.isSymbolicLink() ||
    (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())
  )
    throw new WindowsTeardownUnavailableError();
  const canonical = ordinaryWindowsPath(await ports.realpath(expected));
  // Exact component equality also rejects in-root redirection and prefix lookalikes. Windows
  // ordinarily compares these installation paths case-insensitively; preserve realpath's spelling.
  if (canonical === undefined || canonical.toLowerCase() !== expected.toLowerCase())
    throw new WindowsTeardownUnavailableError();
  return canonical;
}

/** Drive-absolute ordinary paths only: no UNC/device namespace, traversal, ADS or Win32 aliases. */
function ordinaryWindowsPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = value.replaceAll('/', '\\');
  if (!/^[a-z]:\\/i.test(path)) return undefined;
  const components = path.slice(3).split('\\');
  if (components.at(-1) === '') components.pop();
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        /[<>:"|?*]/u.test(component) ||
        Array.from(component).some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/u.test(component) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component),
    )
  )
    return undefined;
  return win32.normalize(path).replace(/(?<!:)\\$/u, '');
}
