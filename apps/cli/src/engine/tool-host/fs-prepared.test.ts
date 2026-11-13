import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileWritten, FsPreparedWrite } from '@relavium/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNodeFsCapability } from './fs.js';
import * as nativeMetadata from './fs-native-metadata.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-prepared-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function host() {
  return createNodeFsCapability({
    operatorHomeDir: root,
    tier: 'sandboxed',
    workspaceDir: root,
    readOnly: false,
  });
}

it('prepares without filesystem mutation, executes once, and preserves mode and exact bytes', async () => {
  const fs = host();
  await writeFile(join(root, 'file'), 'a\r\nb\n');
  await chmod(join(root, 'file'), 0o751);
  const prepared = await fs.prepareWrite!({
    kind: 'write',
    path: 'file',
    content: 'c',
    append: true,
  });
  expect(prepared.before).toBe('a\r\nb\n');
  expect(prepared.after).toBe('a\r\nb\nc');
  expect(await readFile(join(root, 'file'), 'utf8')).toBe(prepared.before);
  expect(await readdir(root)).toEqual(['file']);
  await prepared.execute();
  expect(await readFile(join(root, 'file'), 'utf8')).toBe(prepared.after);
  if (process.platform !== 'win32')
    expect((await stat(join(root, 'file'))).mode & 0o777).toBe(0o751);
  await expect(prepared.execute()).rejects.toThrow();
  await prepared.release();
});

it('defers parent creation and refuses a staged new-file publication after a competing winner', async () => {
  const fs = host();
  const delayed = await fs.prepareWrite!({
    kind: 'write',
    path: 'new/child',
    content: 'one',
    createDirs: true,
  });
  expect(await readdir(root)).toEqual([]);
  await delayed.release();
  expect(await readdir(root)).toEqual([]);
  await mkdir(join(root, 'dir'));
  const native = await nativeMetadata.loadNativeMetadataWriteAdapter();
  let one: FsPreparedWrite | undefined;
  let two: FsPreparedWrite | undefined;
  let winner: FileWritten | undefined;
  let competingStarted = false;
  const publicationOrder: string[] = [];
  const loader = vi.spyOn(nativeMetadata, 'loadNativeMetadataWriteAdapter').mockResolvedValue({
    ...native,
    publishMetadata: async (stage, mask, cancellation) => {
      const first = !competingStarted;
      if (first) {
        competingStarted = true;
        publicationOrder.push('first-staged');
        if (two === undefined) throw new Error('the competing prepared write is missing');
        // Keep the first real stage alive while the competitor publishes and
        // joins cleanup. Uncontrolled inventory-lock contention can refuse both
        // executions; it does not establish whether publication clobbered a file.
        winner = await two.execute();
        publicationOrder.push('winner-complete');
      }
      publicationOrder.push(first ? 'first-native-publish' : 'winner-native-publish');
      return native.publishMetadata(stage, mask, cancellation);
    },
  });
  try {
    one = await fs.prepareWrite!({ kind: 'write', path: 'dir/file', content: 'one' });
    two = await fs.prepareWrite!({ kind: 'write', path: 'dir/file', content: 'two' });
    await expect(one.execute()).rejects.toMatchObject({
      name: 'NativeWriteNeedsAttentionError',
      code: 'execution_failed',
      runErrorCode: 'effect_needs_attention',
      retryable: false,
    });
    expect(publicationOrder).toEqual([
      'first-staged',
      'winner-native-publish',
      'winner-complete',
      'first-native-publish',
    ]);
    expect(winner).toEqual({ path: join('dir', 'file'), bytesWritten: 3 });
    expect(await readFile(join(root, 'dir/file'), 'utf8')).toBe('two');
    expect(await readdir(join(root, 'dir'))).toEqual(['file']);
    expect(await readdir(join(root, '.relavium-fs-private-v1', 'fs-staging-v1'))).toEqual([
      'inventory.lock',
    ]);
  } finally {
    try {
      const releases = await Promise.allSettled([one?.release(), two?.release()]);
      expect(releases.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      loader.mockRestore();
    }
  }
});

it('requires promoted matching evidence for each replacement and refuses stale state', async () => {
  const fs = host();
  const scope = {};
  await writeFile(join(root, 'file'), 'é one\none\n');
  const read = await fs.readFile('file', { range: { unit: 'lines', start: 1, end: 1 } });
  fs.acknowledgeReadResult?.(scope, read);
  await expect(
    fs.prepareWrite!({
      kind: 'edit',
      path: 'file',
      oldString: 'one',
      newString: 'X',
      replaceAll: true,
      readScope: scope,
    }),
  ).rejects.toMatchObject({ reason: 'unobserved_match' });
  fs.promoteReadScope?.(scope);
  await expect(
    fs.prepareWrite!({
      kind: 'edit',
      path: 'file',
      oldString: 'one',
      newString: 'X',
      replaceAll: true,
      readScope: scope,
    }),
  ).rejects.toMatchObject({ reason: 'unobserved_match' });
  const rest = await fs.readFile('file', { range: { unit: 'lines', start: 2, end: 2 } });
  fs.acknowledgeReadResult?.(scope, rest);
  fs.promoteReadScope?.(scope);
  const prepared = await fs.prepareWrite!({
    kind: 'edit',
    path: 'file',
    oldString: 'one',
    newString: 'X',
    replaceAll: true,
    readScope: scope,
  });
  expect(prepared.after).toBe('é X\nX\n');
  await writeFile(join(root, 'file'), 'é two\ntwo\n');
  await expect(prepared.execute()).rejects.toMatchObject({ reason: 'stale_file' });
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('é two\ntwo\n');
  await prepared.release();
});

it('rejects binary and hard-linked targets before creating anything', async () => {
  const fs = host();
  await writeFile(join(root, 'binary'), Buffer.from([65, 0]));
  await expect(
    fs.prepareWrite!({ kind: 'write', path: 'binary', content: 'x' }),
  ).rejects.toMatchObject({ reason: 'unsupported_text' });
  await writeFile(join(root, 'source'), 'source');
  await link(join(root, 'source'), join(root, 'alias'));
  await expect(fs.prepareWrite!({ kind: 'write', path: 'alias', content: 'x' })).rejects.toThrow(
    /hard-linked/,
  );
  expect(await readFile(join(root, 'source'), 'utf8')).toBe('source');
});

it('rejects target replacement and cancellation after preparation without publication', async () => {
  const fs = host();
  await writeFile(join(root, 'target'), 'original');
  const changed = await fs.prepareWrite!({ kind: 'write', path: 'target', content: 'replacement' });
  await rm(join(root, 'target'));
  await writeFile(join(root, 'target'), 'original');
  await expect(changed.execute()).rejects.toMatchObject({ reason: 'stale_file' });
  expect(await readFile(join(root, 'target'), 'utf8')).toBe('original');
  await changed.release();
  const aborted = await fs.prepareWrite!({ kind: 'write', path: 'target', content: 'replacement' });
  const controller = new AbortController();
  controller.abort();
  await expect(aborted.execute(controller.signal)).rejects.toThrow();
  expect(await readdir(root)).toEqual(['target']);
  await aborted.release();
});

it('refuses expanded replacements before allocating the result', async () => {
  const fs = host();
  const scope = {};
  await writeFile(join(root, 'target'), 'x'.repeat(1024));
  const result = await fs.readFile('target', {});
  fs.acknowledgeReadResult?.(scope, result);
  fs.promoteReadScope?.(scope);
  await expect(
    fs.prepareWrite!({
      kind: 'edit',
      path: 'target',
      oldString: 'x',
      newString: 'y'.repeat(10_000),
      replaceAll: true,
      readScope: scope,
    }),
  ).rejects.toMatchObject({ reason: 'diff_limit' });
  expect((await stat(join(root, 'target'))).size).toBe(1024);
});

it.each([
  { oldString: '', reason: 'match_not_found' },
  { oldString: 'absent', reason: 'match_not_found' },
  { oldString: 'same', reason: 'match_not_unique' },
])(
  'refuses $reason before editing even with promoted full-file read evidence',
  async ({ oldString, reason }) => {
    const fs = host(),
      readScope = {};
    await writeFile(join(root, 'file'), 'same\r\nsame\r\n');
    const observed = await fs.readFile('file', {});
    fs.acknowledgeReadResult?.(readScope, observed);
    fs.promoteReadScope?.(readScope);
    await expect(
      fs.prepareWrite?.({ kind: 'edit', path: 'file', oldString, newString: 'changed', readScope }),
    ).rejects.toMatchObject({ reason });
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('same\r\nsame\r\n');
  },
);

it.each([false, true])(
  'preserves BOM and CRLF through a promoted exact edit (no-op=%s)',
  async (noop) => {
    const fs = host(),
      readScope = {};
    const before = '\ufefffirst\r\nsecond\r\n';
    await writeFile(join(root, 'file'), before);
    const observed = await fs.readFile('file', {});
    fs.acknowledgeReadResult?.(readScope, observed);
    fs.promoteReadScope?.(readScope);
    const prepared = await fs.prepareWrite!({
      kind: 'edit',
      path: 'file',
      oldString: 'second',
      newString: noop ? 'second' : 'changed',
      readScope,
    });
    const expected = noop ? before : '\ufefffirst\r\nchanged\r\n';
    expect(prepared.before).toBe(before);
    expect(prepared.after).toBe(expected);
    try {
      await prepared.execute();
    } finally {
      await prepared.release();
    }
    expect(await readFile(join(root, 'file'))).toEqual(Buffer.from(expected));
  },
);
