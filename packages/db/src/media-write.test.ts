import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFilesystemMediaWrite, MediaWriteError } from './media-write.js';
import type { CapturedMediaWriteGuard } from './media-write.js';

const BYTES = new Uint8Array([0x68, 0x69]); // "hi"

describe('createFilesystemMediaWrite (1.AF/D16, ADR-0044 §2 — save_to write port)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-saveto-'));
    outside = mkdtempSync(join(tmpdir(), 'relavium-outside-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writes the bytes to a nested relative path under the scope root, creating dirs', async () => {
    const write = createFilesystemMediaWrite(root);
    const result = await write('out/run-1/image.png', BYTES);
    expect(result).toEqual({ bytesWritten: BYTES.length });
    expect([...readFileSync(join(root, 'out/run-1/image.png'))]).toEqual([...BYTES]);
  });

  it('overwrites an existing regular file at the target', async () => {
    const write = createFilesystemMediaWrite(root);
    await write('a.bin', new Uint8Array([1, 2, 3]));
    await write('a.bin', BYTES);
    expect([...readFileSync(join(root, 'a.bin'))]).toEqual([...BYTES]);
  });

  it('rejects an absolute path, a drive letter, a UNC path, and a `..` traversal', async () => {
    const write = createFilesystemMediaWrite(root);
    await expect(write('/etc/passwd', BYTES)).rejects.toThrow(/relative/);
    await expect(write(String.raw`C:\win.png`, BYTES)).rejects.toThrow(/relative/);
    await expect(write('C:relative.png', BYTES)).rejects.toThrow(/relative/);
    await expect(write('z:relative.png', BYTES)).rejects.toThrow(/relative/);
    await expect(write(String.raw`\\server\share\x.png`, BYTES)).rejects.toThrow(/relative/);
    await expect(write('../escape/x.png', BYTES)).rejects.toThrow(/\.\./);
    await expect(write('a/../../escape.png', BYTES)).rejects.toThrow(/\.\./);
    await expect(write('', BYTES)).rejects.toThrow(/empty/);
  });

  it('fails closed when the scope root does not exist, as a reason-only MediaWriteError (no path leak)', async () => {
    const missingRoot = join(root, 'does-not-exist-secret-name');
    const write = createFilesystemMediaWrite(missingRoot);
    const error = await write('x.png', BYTES).catch((e: unknown) => e);
    // A raw Node fs error (realpath ENOENT) carries the absolute path; the port re-wraps it so the
    // resolved path / scope root never escapes (the I3 self-defending contract).
    expect(error).toBeInstanceOf(MediaWriteError);
    if (error instanceof MediaWriteError) {
      expect(error.message).not.toContain('does-not-exist-secret-name');
    }
    // Nothing was written anywhere.
    expect(() => readFileSync(join(missingRoot, 'x.png'))).toThrow();
  });

  it('refuses to write through a symlinked ancestor directory that escapes the root', async () => {
    // root/link -> outside ; a write to link/x.png would land OUTSIDE the scope root.
    symlinkSync(outside, join(root, 'link'), 'dir');
    const write = createFilesystemMediaWrite(root);
    const error = await write('link/x.png', BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaWriteError); // reason-only type, never a raw Node fs error
    if (error instanceof MediaWriteError) {
      expect(error.message).toMatch(/escapes the scope root/);
      expect(error.message).not.toContain(outside); // the resolved path never leaks (I3 contract)
    }
    // The bytes never reached the symlink target.
    expect(() => readFileSync(join(outside, 'x.png'))).toThrow();
  });

  it('refuses to write through a symlink at the final component', async () => {
    const target = join(outside, 'real.png');
    writeFileSync(target, new Uint8Array([0]));
    symlinkSync(target, join(root, 'evil.png'), 'file'); // root/evil.png -> outside/real.png
    const write = createFilesystemMediaWrite(root);
    const error = await write('evil.png', BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaWriteError);
    if (error instanceof MediaWriteError) {
      expect(error.message).toMatch(/symlink/);
      expect(error.message).not.toContain(outside);
    }
    // The symlink target file is untouched (1 byte, not overwritten with BYTES).
    expect(readFileSync(target).length).toBe(1);
  });

  it('refuses a dangling ancestor without materializing its missing target', async () => {
    const missing = join(outside, 'missing');
    symlinkSync(missing, join(root, 'dangling'), 'dir');
    await expect(
      createFilesystemMediaWrite(root)('dangling/new/file.bin', BYTES),
    ).rejects.toBeInstanceOf(MediaWriteError);
    expect(() => readFileSync(join(missing, 'new/file.bin'))).toThrow();
    // The shared helper must refuse the existing dangling entry, not climb to root and mkdir through it.
    expect(() => readFileSync(join(root, 'dangling/new/file.bin'))).toThrow();
  });

  it('writes correctly when the scope root itself is reached via a symlink (realpath-normalized)', async () => {
    // A scope root that is a symlink to a real dir must still work — realpath normalizes it, and a write
    // INTO the resolved real dir is in-root.
    const realDir = mkdirSyncIn(root, 'real-root');
    const linkedRoot = join(root, 'linked-root');
    symlinkSync(realDir, linkedRoot, 'dir');
    const write = createFilesystemMediaWrite(linkedRoot);
    await write('nested/ok.png', BYTES);
    expect([...readFileSync(join(realDir, 'nested/ok.png'))]).toEqual([...BYTES]);
  });

  it('throws before any I/O when the abort signal is already aborted', async () => {
    const write = createFilesystemMediaWrite(root);
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };
    await expect(write('x.png', BYTES, signal)).rejects.toThrow(/aborted/);
    expect(() => readFileSync(join(root, 'x.png'))).toThrow();
  });
  it('captures a trusted guard once and checks lexical/canonical ancestors and actual object identities', async () => {
    const assertPath = vi.fn<CapturedMediaWriteGuard['assertPath']>();
    const assertIdentity = vi.fn<CapturedMediaWriteGuard['assertIdentity']>();
    const capture = vi.fn(() => Promise.resolve({ assertPath, assertIdentity }));
    await createFilesystemMediaWrite(root, { capture })('deep/nested/out.bin', BYTES);
    expect(capture).toHaveBeenCalledOnce();
    expect(assertPath).toHaveBeenCalledWith(root, root);
    expect(assertPath).toHaveBeenCalledWith(
      join(root, 'deep/nested/out.bin'),
      join(root, 'deep/nested/out.bin'),
    );
    const parent = statSync(join(root, 'deep/nested'), { bigint: true });
    expect(assertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ dev: parent.dev, ino: parent.ino }),
    );
    expect(
      assertIdentity.mock.calls.every(
        ([identity]) => typeof identity.dev === 'bigint' && typeof identity.ino === 'bigint',
      ),
    ).toBe(true);
    expect(readdirSync(join(root, 'deep/nested'))).toEqual(['out.bin']);
  });
  it('a guard path refusal occurs before creating missing directories and has no private diagnostic', async () => {
    const capture = () =>
      Promise.resolve({
        assertPath: () => {
          throw new Error(`private index ${outside}`);
        },
        assertIdentity: () => undefined,
      });
    const error = await createFilesystemMediaWrite(root, { capture })('missing/a.bin', BYTES).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(MediaWriteError);
    expect(error).toMatchObject({ message: 'save_to: the filesystem write failed' });
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });
  it('a target opened-object guard denial preserves its existing bytes', async () => {
    const target = join(root, 'existing.bin');
    writeFileSync(target, new Uint8Array([1, 2, 3]));
    const identity = statSync(target, { bigint: true });
    let observed = 0;
    const capture = () =>
      Promise.resolve({
        assertPath: () => undefined,
        assertIdentity: (candidate: { dev: bigint; ino: bigint }) => {
          if (candidate.dev === identity.dev && candidate.ino === identity.ino && ++observed === 3)
            throw new Error('opened object refused');
        },
      });
    await expect(
      createFilesystemMediaWrite(root, { capture })('existing.bin', BYTES),
    ).rejects.toBeInstanceOf(MediaWriteError);
    expect(observed).toBe(3);
    expect([...readFileSync(target)]).toEqual([1, 2, 3]);
    expect(readdirSync(root)).toEqual(['existing.bin']);
  });
  it('guards the fresh opened temporary before payload bytes and joins close/cleanup on refusal', async () => {
    let tmp: string | undefined;
    let refused = false;
    let sizeAtRefusal: bigint | undefined;
    const capture = () =>
      Promise.resolve({
        assertPath: (lexical: string) => {
          if (lexical.endsWith('.tmp')) tmp = lexical;
        },
        assertIdentity: (identity: { dev: bigint; ino: bigint }) => {
          if (tmp !== undefined && existsSync(tmp) && !refused) {
            const entry = statSync(tmp, { bigint: true });
            if (entry.dev === identity.dev && entry.ino === identity.ino) {
              sizeAtRefusal = entry.size;
              refused = true;
              throw new Error('fresh object refused');
            }
          }
        },
      });
    await expect(
      createFilesystemMediaWrite(root, { capture })('out.bin', BYTES),
    ).rejects.toBeInstanceOf(MediaWriteError);
    expect(refused).toBe(true);
    expect(sizeAtRefusal).toBe(0n);
    expect(readdirSync(root)).toEqual([]);
  });
  it('cancellation cannot detach a pending capture producer or start byte publication', async () => {
    let release!: (guard: CapturedMediaWriteGuard) => void;
    const pending = new Promise<CapturedMediaWriteGuard>((resolve) => {
      release = resolve;
    });
    const capture = vi.fn(() => pending);
    const controller = new AbortController();
    let settled = false;
    const writing = createFilesystemMediaWrite(root, { capture })(
      'out.bin',
      BYTES,
      controller.signal,
    );
    void writing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ assertPath: () => undefined, assertIdentity: () => undefined });
    await expect(writing).rejects.toThrow('was aborted');
    expect(readdirSync(root)).toEqual([]);
  });
});

function mkdirSyncIn(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
