import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createNodeFsCapability } from './fs.js';

// Several processes on one operator home (two terminals, a terminal and an editor extension) are a supported way to
// work, and they share the native allocation claim on `inventory.lock` (ADR-0135). That claim used to be one
// nonblocking attempt, so two concurrent writers lost about half of their writes at stage (measured on the built
// addon: 28 of 60 failed with `changed:not_needed`, two more ended `possibly_published:uncertain`). The claim is now
// waited for, so concurrent writers queue instead of failing. These writers run in one process, on separate
// descriptors, which conflict under `flock` exactly as separate processes do; a probe with two real OS processes is
// still owed (see the register). Every write goes through the real host path: prepare, stage, publish and release
// through the built native addon.
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-native-concurrency-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Windows is proven only by the eight-target native CI (ADR-0135). The required Windows job
// (`windows-concurrency` selects every file whose name contains "concurrency") selects this file, but the test is
// skipped there, so Windows does not exercise these assertions: what a Windows scan does with a delete-pending
// entry is not claimed, and an unverified platform must not turn into a failed required check.
it.skipIf(process.platform === 'win32')(
  'lets several concurrent writers on one operator home all succeed with their exact bytes',
  async () => {
    const fs = createNodeFsCapability({
      operatorHomeDir: root,
      tier: 'sandboxed',
      workspaceDir: root,
      readOnly: false,
    });
    const writers = 3;
    const rounds = 8;
    const names: string[] = [];
    // Every writer settles before anything is reported: a writer that rejects must not leave the others writing
    // into a directory the cleanup is about to remove.
    const settled = await Promise.allSettled(
      Array.from({ length: writers }, async (_, writer) => {
        for (let round = 0; round < rounds; round++) {
          const name = `writer-${writer}-round-${round}`;
          names.push(name);
          const prepared = await fs.prepareWrite!({
            kind: 'write',
            path: name,
            content: `${name}\n`,
          });
          try {
            await prepared.execute();
          } finally {
            await prepared.release();
          }
        }
      }),
    );
    expect(
      settled.flatMap((outcome) => (outcome.status === 'rejected' ? [String(outcome.reason)] : [])),
    ).toEqual([]);
    expect(names).toHaveLength(writers * rounds);
    const written = (await readdir(root)).filter((entry) => entry.startsWith('writer-'));
    expect(written.sort()).toEqual([...names].sort());
    for (const name of names) expect(await readFile(join(root, name), 'utf8')).toBe(`${name}\n`);
  },
  30_000,
);
