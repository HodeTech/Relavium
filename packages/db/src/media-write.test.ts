import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFilesystemMediaWrite, MediaWriteError } from './media-write.js';

const BYTES = new Uint8Array([0x68, 0x69]); // "hi"

describe('createFilesystemMediaWrite (1.AF/D16, ADR-0044 §2 — save_to write port)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-saveto-'));
    outside = mkdtempSync(join(tmpdir(), 'relavium-outside-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
});

function mkdirSyncIn(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
