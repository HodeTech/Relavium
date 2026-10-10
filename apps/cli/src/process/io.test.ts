import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { OwnedTtyOutput } from '../test-support.js';
import { processIo } from './io.js';

class DelayedOutput extends OwnedTtyOutput {
  complete: ((error?: Error) => void) | undefined;
  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : typeof chunk === 'string'
        ? chunk
        : '';
    this.complete = (error) => {
      this.complete = undefined;
      if (error === undefined) this.frames.push(text);
      callback(error);
    };
  }
}

function ioFor(stderr: NodeJS.WritableStream) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
  if (descriptor === undefined) throw new Error('expected stderr descriptor');
  try {
    Object.defineProperty(process, 'stderr', { configurable: true, get: () => stderr });
    return processIo();
  } finally {
    Object.defineProperty(process, 'stderr', descriptor);
  }
}

const released = async (stderr: NodeJS.WritableStream): Promise<void> => {
  await vi.waitFor(() => {
    expect(stderr.listenerCount('error')).toBe(0);
    expect(stderr.listenerCount('close')).toBe(0);
  });
};

describe('native diagnostic acknowledgement (ADR-0098)', () => {
  it('waits for native delivery and writes to the exact captured stderr after process binding changes', async () => {
    const stderr = new DelayedOutput();
    let acknowledged = false;
    try {
      const done = ioFor(stderr)
        .writeErrAcknowledged('notice\n')
        .then(() => {
          acknowledged = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acknowledged).toBe(false);
      expect(stderr.frames).toEqual([]);
      stderr.complete?.();
      await done;
      expect(stderr.frames).toEqual(['notice\n']);
      await released(stderr);
    } finally {
      stderr.destroy();
    }
  });

  it.each(['callback', 'destroy', 'close'] as const)(
    'rejects pending native write failure (%s) without an unhandled error',
    async (kind) => {
      const stderr = new DelayedOutput();
      try {
        const done = ioFor(stderr).writeErrAcknowledged('notice\n');
        const assertion = expect(done).rejects.toMatchObject({
          code: 'internal',
          message: 'The diagnostic output could not be acknowledged.',
        });
        if (kind === 'callback') stderr.complete?.(new Error('SECRET_NATIVE_FAILURE'));
        else stderr.destroy(kind === 'destroy' ? new Error('SECRET_NATIVE_FAILURE') : undefined);
        await assertion;
        expect(stderr.frames).toEqual([]);
        await released(stderr);
      } finally {
        stderr.destroy();
      }
    },
  );

  it('retains an owned error sink through pending file-stream destruction and releases it after close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-io-ack-'));
    const stderr = createWriteStream(join(root, 'stderr.txt'));
    try {
      let opened: () => void = () => undefined;
      let failed: (error: Error) => void = () => undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          opened = resolve;
          failed = reject;
          stderr.once('open', opened);
          stderr.once('error', failed);
        });
      } finally {
        stderr.removeListener('open', opened);
        stderr.removeListener('error', failed);
      }
      const io = ioFor(stderr);
      stderr.destroy(new Error('SECRET_FILE_FAILURE'));
      await expect(io.writeErrAcknowledged('notice\n')).rejects.toMatchObject({ code: 'internal' });
      await released(stderr);
      expect(stderr.closed).toBe(true);
    } finally {
      stderr.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an already-closed native stream without writing or leaking listeners', async () => {
    const stderr = new OwnedTtyOutput();
    stderr.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(ioFor(stderr).writeErrAcknowledged('notice\n')).rejects.toMatchObject({
      code: 'internal',
    });
    expect(stderr.frames).toEqual([]);
    await released(stderr);
  });
});
