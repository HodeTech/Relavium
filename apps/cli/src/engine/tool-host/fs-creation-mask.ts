import { spawn } from 'node:child_process';

import type { AbortSignalLike } from '@relavium/shared';

import type { NativeProcessController } from '../../process/native-process-owner.js';

import { HostDeniedError } from './errors.js';

// The child inherits the actual kernel mask. Its process.umask() query cannot
// change the host's mask; no model input is interpolated into this program.
const MASK_QUERY = "process.stdout.write(process.umask().toString(8).padStart(4,'0')+'\\n')";
const MASK_QUERY_TIMEOUT_MS = 2_000;

/** Skip the child only when the native profile can query the mask itself. */
export async function captureRequiredCreationMask(
  processes: NativeProcessController,
  required: boolean,
  signal?: AbortSignalLike,
): Promise<number | undefined> {
  return required ? captureCreationMask(processes, signal) : undefined;
}

/** Joined, fixed-purpose creation-mask observation for macOS before native work. */
export async function captureCreationMask(
  processes: NativeProcessController,
  signal?: AbortSignalLike,
): Promise<number> {
  const aborted = (): boolean => signal?.aborted === true;
  const reservation = await processes.reserve('pid').catch(() => {
    throw new HostDeniedError('filesystem creation policy unavailable');
  });
  let child: ReturnType<typeof spawn>;
  try {
    reservation.assertAdmitting();
    if (aborted()) throw new HostDeniedError('filesystem creation policy unavailable');
    child = spawn(process.execPath, ['-e', MASK_QUERY], {
      env: {},
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    reservation.bindChild(child);
  } catch {
    reservation.abandon();
    throw new HostDeniedError('filesystem creation policy unavailable');
  }
  let output = '';
  let invalid = false;
  let exitCode: number | null = null;
  let stop: Promise<void> | undefined;
  const terminate = (): void => {
    invalid = true;
    stop ??= reservation.stop();
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    if (output.length + chunk.length > 5) {
      terminate();
      return;
    }
    output += chunk.toString('ascii');
  });
  child.on('error', terminate);
  child.on('close', (code) => {
    exitCode = code;
  });
  signal?.addEventListener('abort', terminate);
  const timeout = setTimeout(terminate, MASK_QUERY_TIMEOUT_MS);
  try {
    if (signal?.aborted === true) terminate();
    await reservation.whenClosed;
    if (stop !== undefined) await stop;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', terminate);
  }
  if (invalid || exitCode !== 0 || !/^[0-7]{4}\n$/u.test(output)) {
    throw new HostDeniedError('filesystem creation policy unavailable');
  }
  return Number.parseInt(output, 8);
}
