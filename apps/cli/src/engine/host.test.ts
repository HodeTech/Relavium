import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Checkpointer, ExecutionHost, RunStore } from '@relavium/core';
import { createClient, createMediaReferenceStore, runMigrations } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { createCliHost } from './host.js';

/** A stand-in DURABLE store (not the in-memory reference) — what the gate path injects alongside a checkpointer. */
const durableStore: RunStore = {
  resolveWorkflowId: () => Promise.resolve('wf'),
  persistEvent: () => Promise.resolve(),
  listInterruptedRuns: () => Promise.resolve([]),
};

describe('createCliHost', () => {
  it('uses an injected checkpointer (the 2.G cross-process gate-resume seam) over the default', async () => {
    const injected: Checkpointer = { load: () => Promise.resolve(undefined) };
    const host = createCliHost(durableStore, { checkpointer: injected });
    expect(host.checkpointer).toBe(injected); // resumeFromCheckpoint loads from the durable reconstruction
    expect(await host.checkpointer.load('any')).toBeUndefined();
  });

  it('rejects a checkpointer over the in-memory store — that split-backend pairing would resume against the wrong store', () => {
    const injected: Checkpointer = { load: () => Promise.resolve(undefined) };
    // Default store (in-memory) + a durable checkpointer = read/write backends diverge → fail loud at wiring.
    expect(() => createCliHost(undefined, { checkpointer: injected })).toThrow(/durable RunStore/);
  });

  it('defaults to the in-memory checkpointer when none is injected (the run path never resumes)', () => {
    const host = createCliHost();
    expect(host.checkpointer).toBeDefined();
  });

  it('provides a NATIVE AbortController whose signal a provider SDK threads into fetch', () => {
    // Regression: the CLI host once injected the engine's in-house test `createAbortController`, whose signal
    // is NOT `instanceof AbortSignal` — so the LLM adapters (isAbortSignal gate) DROPPED it and a run cancel
    // could not abort an in-flight LLM stream, leaving Ctrl-C unable to cooperatively cancel an agent run.
    const controller = createCliHost().newAbortController();
    expect(controller.signal).toBeInstanceOf(AbortSignal); // a real AbortSignal — fetch/SDKs honour it
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('exposes a real, node-backed host (clock, ids, store, timer)', () => {
    const host = createCliHost();
    expect(typeof host.clock.now()).toBe('string'); // ISO timestamp
    expect(host.ids.newId()).toMatch(/^[0-9a-f-]{36}$/); // a UUID
    const cancel = host.setTimer(10_000, () => {});
    expect(typeof cancel).toBe('function');
    cancel(); // clears the timer — no dangling handle
  });

  describe('fetchMedia (the SSRF media-egress port, 2.S / ADR-0043)', () => {
    // Asserts the port is wired AND returns it narrowed (no non-null `!`); a missing port fails loudly here.
    function mediaFetch(): NonNullable<ExecutionHost['fetchMedia']> {
      const { fetchMedia } = createCliHost();
      if (fetchMedia === undefined) {
        throw new Error('createCliHost must wire the fetchMedia media-egress port');
      }
      return fetchMedia;
    }

    // All three reject BEFORE any network: scheme/credential checks and the literal-IP range block run ahead of
    // DNS/connect, so the wiring is verified offline (the mechanism's own redirect/rebinding vectors are covered
    // by @relavium/db's 23 media-egress tests — here we only assert the CLI wires it with allowPrivate=false).
    it('rejects a non-HTTPS url (insecure_url), opening no connection', async () => {
      await expect(mediaFetch()('http://media.example/a.png', 1000)).rejects.toMatchObject({
        code: 'insecure_url',
      });
    });

    it('rejects a url with embedded credentials (insecure_url)', async () => {
      await expect(
        mediaFetch()('https://user:pass@media.example/a.png', 1000),
      ).rejects.toMatchObject({
        code: 'insecure_url',
      });
    });

    it('rejects a literal private/loopback target — proving allowPrivate=false (blocked_host, no network)', async () => {
      await expect(mediaFetch()('https://127.0.0.1/a.png', 1000)).rejects.toMatchObject({
        code: 'blocked_host',
      });
    });
  });

  describe('mediaWrite (the save_to write port, 2.S / ADR-0044 §2)', () => {
    it('is unwired when no saveToRoot is given (a save_to then fails the run loud)', () => {
      expect(createCliHost().mediaWrite).toBeUndefined();
    });

    it('writes jailed under the saveToRoot and rejects a traversal escape', async () => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-saveto-'));
      try {
        const { mediaWrite } = createCliHost(undefined, { media: { saveToRoot: root } });
        if (mediaWrite === undefined) {
          throw new Error('createCliHost must wire mediaWrite when a saveToRoot is given');
        }
        await mediaWrite('sub/out.bin', new Uint8Array([1, 2, 3]));
        expect(Array.from(readFileSync(join(root, 'sub', 'out.bin')))).toEqual([1, 2, 3]);
        // The wired port rejects a `..` traversal via its lexical relative-path guard — assert the CAUSE (not
        // just "an error") so a wiring bug that rejected for the wrong reason wouldn't pass, and confirm nothing
        // was written above the root. (The deeper realpath+commonpath symlink jail is covered by @relavium/db's
        // media-write tests; here we only verify the CLI wired the port under the right scope root.)
        await expect(mediaWrite('../escape.bin', new Uint8Array([9]))).rejects.toThrow(
          /\.\.|escapes/,
        );
        expect(existsSync(join(root, '..', 'escape.bin'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('mediaStore + mediaReferences (the CAS + retention ports, 2.S / ADR-0042)', () => {
    it('are unwired without their config (a media-producing run then fails loud)', () => {
      const host = createCliHost();
      expect(host.mediaStore).toBeUndefined();
      expect(host.mediaReferences).toBeUndefined();
    });

    it('wires the two ports independently from their own config fields (not coupled)', () => {
      const casRoot = mkdtempSync(join(tmpdir(), 'relavium-cas-'));
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        // casRoot only ⇒ mediaStore wired, mediaReferences absent.
        const storeOnly = createCliHost(undefined, { media: { casRoot } });
        expect(storeOnly.mediaStore).toBeDefined();
        expect(storeOnly.mediaReferences).toBeUndefined();
        // referenceDb only ⇒ mediaReferences wired, mediaStore absent (a coupling regression would fail here).
        const refsOnly = createCliHost(undefined, { media: { referenceDb: client.db } });
        expect(refsOnly.mediaReferences).toBeDefined();
        expect(refsOnly.mediaStore).toBeUndefined();
      } finally {
        client.sqlite.close();
        rmSync(casRoot, { recursive: true, force: true });
      }
    });

    it('wires a single content-addressed mediaStore (round-trip + fail-closed on an unknown handle)', async () => {
      const casRoot = mkdtempSync(join(tmpdir(), 'relavium-cas-'));
      try {
        const store = createCliHost(undefined, { media: { casRoot } }).mediaStore;
        if (store === undefined) {
          throw new Error('createCliHost must wire mediaStore when a casRoot is given');
        }
        // A content-addressed round-trip proves it is a real FilesystemMediaStore over the CAS root.
        const handle = await store.put(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream');
        expect(handle).toMatch(/^media:\/\/sha256-[0-9a-f]{64}$/);
        expect(Array.from(await store.get(handle))).toEqual([1, 2, 3, 4]);
        // Fail-closed: an unknown handle (not in the CAS) rejects rather than serving stray bytes.
        await expect(store.get(`media://sha256-${'0'.repeat(64)}`)).rejects.toThrow();
      } finally {
        rmSync(casRoot, { recursive: true, force: true });
      }
    });

    it('wires a mediaReferences port actually backed by the passed referenceDb', async () => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        const refs = createCliHost(undefined, {
          media: { referenceDb: client.db },
        }).mediaReferences;
        if (refs === undefined) {
          throw new Error('createCliHost must wire mediaReferences when a referenceDb is given');
        }
        await refs.recordRunMedia(
          {
            handle: `media://sha256-${'a'.repeat(64)}`,
            mimeType: 'image/png',
            modality: 'image',
            byteLength: 4,
          },
          'run-1',
        );
        // Proof it wrote to the SAME db (not merely non-undefined): an observer store over `client.db` sees
        // and reclaims the run reference the host's port just recorded.
        const observer = createMediaReferenceStore(client.db);
        expect(observer.removeRunReferences('run-1')).toBe(1);
      } finally {
        client.sqlite.close();
      }
    });
  });
});
