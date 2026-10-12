import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-cas-concurrency-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(['put', 'putStream'] as const)('cooperating CAS %s publishers', (publish) => {
  it.each(['get', 'readRange', 'resolveForEgress'] as const)(
    'preserves native %s delivery while independent stores republish the same handle',
    async (delivery) => {
      const bytes = Buffer.alloc(1024 * 1024, 65);
      const handle = await new FilesystemMediaStore(root).put(bytes);
      const expected =
        delivery === 'resolveForEgress'
          ? { kind: 'base64', data: bytes.toString('base64') }
          : delivery === 'readRange'
            ? bytes.subarray(3, 18)
            : bytes;
      // Native opens, writes, renames and reads, with no injected scheduling/syscall doubles.
      // Each operation has its own store, so an instance-local lock cannot hide the regression.
      const work = Array.from({ length: 30 }, (_, index) => {
        const store = new FilesystemMediaStore(root);
        if (index % 2 === 0) {
          return publish === 'put'
            ? store.put(bytes)
            : store.putStream(
                (async function* () {
                  yield await Promise.resolve(bytes);
                })(),
              );
        }
        if (delivery === 'readRange') return store.readRange(handle, { start: 3, end: 17 });
        return store[delivery](handle);
      });
      // Join failures too: fixture cleanup must never race an outstanding publisher or reader.
      const results = await Promise.allSettled(work);
      expect(
        results.filter((result) => result.status === 'rejected'),
        'FS_CAUSAL_CAS_COOPERATIVE_READ',
      ).toEqual([]);
      for (const [index, result] of results.entries()) {
        if (result.status !== 'fulfilled') continue;
        if (index % 2 === 0) expect(result.value).toBe(handle);
        else if (expected instanceof Uint8Array) {
          expect(result.value).toBeInstanceOf(Uint8Array);
          if (result.value instanceof Uint8Array)
            expect(Buffer.from(result.value).equals(expected)).toBe(true);
        } else expect(result.value).toEqual(expected);
      }
      expect(Buffer.from(await new FilesystemMediaStore(root).get(handle)).equals(bytes)).toBe(
        true,
      );
      expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
  );
});
