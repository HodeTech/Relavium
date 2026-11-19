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
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileWritten, FsPreparedWrite } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeFsCapability, FsScopeDeniedError, PROTECTED_PATH_REFUSAL } from './fs.js';
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

describe('a cleanup failure after execute', () => {
  /** A host whose native cleanup of an EXISTING target's preparation always fails (after really releasing it). */
  async function withFailingCleanup() {
    const native = await nativeMetadata.loadNativeMetadataWriteAdapter();
    return vi.spyOn(nativeMetadata, 'loadNativeMetadataWriteAdapter').mockResolvedValue({
      ...native,
      releaseExistingMetadata: async (prepared) => {
        await native.releaseExistingMetadata(prepared);
        throw new Error('injected cleanup failure');
      },
    });
  }

  it('is plain cleanup, not "needs attention", when the work scope refused before any native work began', async () => {
    await writeFile(join(root, 'file'), 'old');
    const loader = await withFailingCleanup();
    try {
      const prepared = await host().prepareWrite!({ kind: 'write', path: 'file', content: 'new' });
      let refusals = 0;
      const retainWork = (): never => {
        refusals++;
        throw new Error('egress work scope has ended'); // a sealed scope refuses before invoking the producer
      };
      expect(() => prepared.execute(undefined, { retainWork })).toThrow(
        'egress work scope has ended',
      );
      expect(refusals).toBe(1);
      // The single-use guarantee is unchanged: the refused handle can neither run again nor be re-claimed.
      await expect(prepared.execute()).rejects.toThrow('prepared write is no longer available');
      const failure = await Promise.resolve()
        .then(() => prepared.release())
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toMatchObject({ message: 'filesystem metadata cleanup failed' });
      expect(failure).not.toMatchObject({ runErrorCode: 'effect_needs_attention' });
      expect(await readFile(join(root, 'file'), 'utf8')).toBe('old');
    } finally {
      loader.mockRestore();
    }
  });

  it('still reports "needs attention" once the producer has started', async () => {
    await writeFile(join(root, 'file'), 'old');
    const loader = await withFailingCleanup();
    try {
      const prepared = await host().prepareWrite!({ kind: 'write', path: 'file', content: 'new' });
      await prepared.execute(undefined, { retainWork: (factory) => factory() });
      await expect(prepared.release()).rejects.toMatchObject({
        runErrorCode: 'effect_needs_attention',
        retryable: false,
      });
      expect(await readFile(join(root, 'file'), 'utf8')).toBe('new');
    } finally {
      loader.mockRestore();
    }
  });
});

// `retainWork` is host code: it can invoke the factory (native work starts) and THEN throw. execute() throws, so no
// `pending` was recorded — release() must still join the producer it started, and that producer's later rejection
// must not surface as an unhandled one nobody can observe, whether it settles before or after release() is called.
it.each(['while the producer is still running', 'after the producer already settled'] as const)(
  'joins a producer that a throwing retainer already started and leaves no unhandled rejection: release() %s',
  async (when) => {
    await writeFile(join(root, 'file'), 'old');
    const native = await nativeMetadata.loadNativeMetadataWriteAdapter();
    let reachedPublish = false;
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const loader = vi.spyOn(nativeMetadata, 'loadNativeMetadataWriteAdapter').mockResolvedValue({
      ...native,
      publishMetadata: async () => {
        reachedPublish = true;
        await gate;
        throw new Error('injected publish failure');
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const prepared = await host().prepareWrite!({ kind: 'write', path: 'file', content: 'new' });
      let lost: Promise<unknown> | undefined;
      const retainWork = <T>(factory: () => Promise<T>): Promise<T> => {
        lost = factory();
        throw new Error('retainer failed');
      };
      expect(() => prepared.execute(undefined, { retainWork })).toThrow('retainer failed');
      expect(lost, 'the retainer really started the producer').toBeDefined();
      await vi.waitFor(() => expect(reachedPublish).toBe(true));
      if (when === 'while the producer is still running') {
        let released = false;
        const releasing = Promise.resolve(prepared.release()).then(() => {
          released = true;
        });
        await turn();
        await turn();
        expect(released, 'release() must not resolve while the producer is still running').toBe(
          false,
        );
        openGate();
        await releasing;
      } else {
        openGate();
        // The producer's failure path removes its staging record before it rejects.
        await vi.waitFor(async () =>
          expect(await readdir(join(root, '.relavium-fs-private-v1', 'fs-staging-v1'))).toEqual([
            'inventory.lock',
          ]),
        );
        await turn();
        await turn();
        await turn();
        expect(unhandled, 'no rejection before anything observes the producer').toEqual([]);
        await prepared.release();
      }
      await turn();
      await turn();
      expect(unhandled, 'the producer rejection was observed').toEqual([]);
      await expect(lost).rejects.toBeDefined();
      expect(await readFile(join(root, 'file'), 'utf8')).toBe('old');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      openGate();
      loader.mockRestore();
    }
  },
);

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

// The plain case (no link anywhere) must behave exactly as before, on every platform.
it('a createDirs write without any link keeps the lexical card path and succeeds', async () => {
  await mkdir(join(root, 'src'));
  for (const path of ['brand/new/child.txt', 'src/more/child.txt']) {
    const prepared = await host().prepareWrite!({
      kind: 'write',
      path,
      content: 'on: push\n',
      createDirs: true,
    });
    try {
      expect(prepared.path).toBe(join(...path.split('/')));
      expect((await prepared.execute()).path).toBe(prepared.path);
      expect(await readFile(join(root, path), 'utf8')).toBe('on: push\n');
    } finally {
      await prepared.release();
    }
  }
});

// Which protected-path refusals return to the model (ADR-0117, ADR-0118). The rule is ADR-0117's test: a refusal returns
// only if its text is the SAME for every target state. The lexical protected-directory and startup-file arm is decided
// from the path text alone; the credential-store arm and anything only resolution reveals stay fatal.
describe('a protected-path write: which refusal returns to the model', () => {
  const write = (path: string) =>
    ({ kind: 'write', path, content: 'x', createDirs: true }) as const;

  async function refusal(path: string): Promise<FsScopeDeniedError> {
    const err: unknown = await host().prepareWrite!(write(path)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FsScopeDeniedError);
    return err as FsScopeDeniedError;
  }

  it.each([
    '.git/config',
    '.git/hooks/pre-commit',
    '.bashrc',
    '.ssh/authorized_keys',
    '.relavium/x',
  ])('the lexical arm (%s) is recoverable and says one fixed text', async (path) => {
    const err = await refusal(path);
    expect(err.recoverable).toBe(true);
    expect(err.message).toBe(PROTECTED_PATH_REFUSAL);
    expect(err.code).toBe('tool_denied');
    expect(err.retryable).toBe(false);
  });

  it('says the same words whether or not the target exists (no probe oracle)', async () => {
    const missing = await refusal('.git/config');
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'existing');
    const existing = await refusal('.git/config');
    expect(existing.message).toBe(missing.message);
    expect(existing.recoverable).toBe(missing.recoverable);
    // The refusal never names the protected list or the target.
    expect(missing.message).not.toMatch(/\.git|\.ssh|\.relavium|credential|startup/);
  });

  it.each(['.env', '.npmrc', '.aws/credentials', '.docker/config.json'])(
    'the credential-store arm (%s) stays fatal',
    async (path) => {
      const err = await refusal(path);
      expect(err.recoverable).toBe(false);
      expect(err.message).not.toBe(PROTECTED_PATH_REFUSAL);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a refusal only resolution reveals (a link into a protected directory) stays fatal',
    async () => {
      await mkdir(join(root, '.git'));
      await symlink(join(root, '.git'), join(root, 'innocent'), 'dir');
      // The lexical path `innocent/config` is ordinary: only the canonical `.git/config` is protected, and saying so
      // would tell the model that `innocent` is a link — which depends on the target's state.
      const err = await refusal('innocent/config');
      expect(err.recoverable).toBe(false);
      expect(err.message).not.toBe(PROTECTED_PATH_REFUSAL);
    },
  );
});

// Consent honesty (PR #99 security sitting F1): a card must name the path that is WRITTEN. An existing parent was
// always canonicalised; a MISSING parent was not, so a link ancestor made the card name the lexical path while the
// bytes landed somewhere the person never saw named.
describe.skipIf(process.platform === 'win32')(
  'a createDirs write whose missing parents sit under a linked ancestor',
  () => {
    const request = (path: string) =>
      ({ kind: 'write', path, content: 'on: push\n', createDirs: true }) as const;

    it.each(['notes/workflows/release.yml', 'notes/workflows/nested/release.yml'])(
      'names the canonical path on the card, and the write lands exactly there (%s)',
      async (path) => {
        await mkdir(join(root, '.github'));
        await symlink(join(root, '.github'), join(root, 'notes'), 'dir');
        const prepared = await host().prepareWrite!(request(path));
        try {
          const canonical = join('.github', path.slice('notes/'.length));
          expect(prepared.path, 'the card names the canonical path, not the link spelling').toBe(
            canonical,
          );
          expect(await readdir(join(root, '.github')), 'prepare creates nothing').toEqual([]);
          const written = await prepared.execute();
          expect(written.path, 'the card named exactly what was written').toBe(prepared.path);
          expect(await readFile(join(root, canonical), 'utf8')).toBe('on: push\n');
        } finally {
          await prepared.release();
        }
      },
    );

    it('refuses at prepare when the canonical path is a protected or credential location', async () => {
      // `.config` is an ordinary directory and `op` an ordinary name; only the canonical `.config/op` run is the
      // 1Password credential store. Neither the lexical path nor the existing ancestor shows it.
      await mkdir(join(root, '.config'));
      await symlink(join(root, '.config'), join(root, 'notes'), 'dir');
      await expect(host().prepareWrite!(request('notes/op/token.txt'))).rejects.toBeInstanceOf(
        FsScopeDeniedError,
      );
      expect(await readdir(join(root, '.config')), 'nothing was created there').toEqual([]);
    });

    describe('when the link is retargeted after the card was shown', () => {
      /** Re-point `notes` at `other` the moment the Nth native recheck of the EXECUTE phase runs. */
      async function retargetOnRecheck(nth: number, onSwap: () => void) {
        const native = await nativeMetadata.loadNativeMetadataWriteAdapter();
        let armed = false;
        let calls = 0;
        const loader = vi
          .spyOn(nativeMetadata, 'loadNativeMetadataWriteAdapter')
          .mockResolvedValue({
            ...native,
            recheckNewMetadata: async (prepared, mask) => {
              if (armed && ++calls === nth) {
                await rm(join(root, 'notes'));
                await symlink(join(root, 'other'), join(root, 'notes'), 'dir');
                onSwap();
              }
              return native.recheckNewMetadata(prepared, mask);
            },
          });
        return { loader, arm: () => (armed = true) };
      }

      it('refuses before creating any directory in the place the card never named', async () => {
        await mkdir(join(root, '.github'));
        await mkdir(join(root, 'other'));
        await symlink(join(root, '.github'), join(root, 'notes'), 'dir');
        let swapped = false;
        const { loader, arm } = await retargetOnRecheck(1, () => (swapped = true));
        try {
          const prepared = await host().prepareWrite!(request('notes/workflows/release.yml'));
          try {
            expect(prepared.path).toBe(join('.github', 'workflows', 'release.yml'));
            arm();
            await expect(prepared.execute()).rejects.toMatchObject({ reason: 'stale_file' });
            expect(swapped, 'the retarget window was really driven').toBe(true);
            expect(await readdir(join(root, 'other')), 'no directory in the new target').toEqual(
              [],
            );
            expect(await readdir(join(root, '.github'))).toEqual([]);
          } finally {
            await prepared.release();
          }
        } finally {
          loader.mockRestore();
        }
      });

      it('refuses, publishing nothing, when it is retargeted after the directories were created', async () => {
        await mkdir(join(root, '.github'));
        await mkdir(join(root, 'other', 'workflows'), { recursive: true });
        await symlink(join(root, '.github'), join(root, 'notes'), 'dir');
        let swapped = false;
        // The 2nd recheck is the one after the (single) mkdir: the directory exists, the file does not yet.
        const { loader, arm } = await retargetOnRecheck(2, () => (swapped = true));
        try {
          const prepared = await host().prepareWrite!(request('notes/workflows/release.yml'));
          try {
            arm();
            await expect(prepared.execute()).rejects.toMatchObject({ reason: 'stale_file' });
            expect(swapped, 'the retarget window was really driven').toBe(true);
            expect(
              await readdir(join(root, 'other', 'workflows')),
              'no bytes were published into the place the card never named',
            ).toEqual([]);
          } finally {
            await prepared.release();
          }
        } finally {
          loader.mockRestore();
        }
      });
    });
  },
);
