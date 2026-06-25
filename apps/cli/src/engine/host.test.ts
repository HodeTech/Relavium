import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Checkpointer, ExecutionHost, RunStore } from '@relavium/core';
import { createClient, createMediaReferenceStore, runMigrations } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { createCliHost, type CliMediaOptions } from './host.js';

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
          /must not contain a "\.\." segment/,
        );
        expect(existsSync(join(root, '..', 'escape.bin'))).toBe(false);
        // An ABSOLUTE path is rejected for its own distinct cause (not the `..` one) — confirm the wired port
        // forwards every relative-only rule, not just traversal. (The full drive/UNC/symlink matrix is the db
        // media-write suite's; here we assert the CLI didn't narrow the guard to `..` alone.)
        await expect(mediaWrite('/etc/escape.bin', new Uint8Array([9]))).rejects.toThrow(
          /must be relative/,
        );
        // A PRE-ABORTED signal short-circuits the write cooperatively (the port's throwIfAborted) — the bytes
        // never land. (wireSaveToPort's mkdir runs first, so the scope root may exist, but no file is written.)
        await expect(
          mediaWrite('aborted.bin', new Uint8Array([9]), AbortSignal.abort()),
        ).rejects.toThrow(/was aborted/);
        expect(existsSync(join(root, 'aborted.bin'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('provisions a not-yet-existing saveToRoot LAZILY on the first write (not at host construction)', async () => {
      // The write port fail-closes if its jail root is missing — a fresh project has no `.relavium/runs/` yet, so
      // the host `mkdir -p`s it. But LAZILY (on the first write), so wiring the host for a run WITHOUT save_to
      // never needs cwd write access (read-only-env safe). Point at a nested root whose ancestors do NOT exist.
      const base = mkdtempSync(join(tmpdir(), 'relavium-saveto-fresh-'));
      const saveToRoot = join(base, '.relavium', 'runs');
      try {
        expect(existsSync(saveToRoot)).toBe(false);
        const { mediaWrite } = createCliHost(undefined, { media: { saveToRoot } });
        if (mediaWrite === undefined) {
          throw new Error('createCliHost must wire mediaWrite when a saveToRoot is given');
        }
        expect(existsSync(saveToRoot)).toBe(false); // NOT provisioned at construction — lazy
        await mediaWrite('out.bin', new Uint8Array([7]));
        expect(existsSync(saveToRoot)).toBe(true); // provisioned on the first write, and the bytes landed
        expect(Array.from(readFileSync(join(saveToRoot, 'out.bin')))).toEqual([7]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('mediaStore + mediaReferences (the CAS + retention ports, 2.S / ADR-0042)', () => {
    it('are unwired without their config (a media-producing run then fails loud)', () => {
      const host = createCliHost();
      expect(host.mediaStore).toBeUndefined();
      expect(host.mediaReferences).toBeUndefined();
    });

    it('wires each of the three media ports independently from its own config field', () => {
      const casRoot = mkdtempSync(join(tmpdir(), 'relavium-cas-'));
      const saveToRoot = mkdtempSync(join(tmpdir(), 'relavium-saveto-'));
      const client = createClient(':memory:');
      // [mediaStore, mediaReferences, mediaWrite] presence for a given media config.
      const wired = (media: CliMediaOptions): boolean[] => {
        const host = createCliHost(undefined, { media });
        return [host.mediaStore, host.mediaReferences, host.mediaWrite].map(Boolean);
      };
      try {
        runMigrations(client.db);
        // Each single field wires ONLY its own port (a coupling regression — gating one port on another's
        // field — fails here): mediaStore ⇐ casRoot, mediaReferences ⇐ referenceDb, mediaWrite ⇐ saveToRoot.
        expect(wired({ casRoot })).toEqual([true, false, false]);
        expect(wired({ referenceDb: client.db })).toEqual([false, true, false]);
        expect(wired({ saveToRoot })).toEqual([false, false, true]);
        // The realistic run-path config — all three fields — exposes all three ports.
        expect(wired({ casRoot, referenceDb: client.db, saveToRoot })).toEqual([true, true, true]);
      } finally {
        client.sqlite.close();
        rmSync(casRoot, { recursive: true, force: true });
        rmSync(saveToRoot, { recursive: true, force: true });
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
        // Fail-closed: an unknown handle (no CAS file) rejects with the file-not-found CAUSE (a content-address
        // miss), never serving stray bytes — the CAUSE is asserted, mirroring the mediaWrite traversal rigor.
        await expect(store.get(`media://sha256-${'0'.repeat(64)}`)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        rmSync(casRoot, { recursive: true, force: true });
      }
    });

    it('wires a mediaReferences port whose record + reclaim are both backed by the passed referenceDb', async () => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        const refs = createCliHost(undefined, {
          media: { referenceDb: client.db },
        }).mediaReferences;
        if (refs === undefined) {
          throw new Error('createCliHost must wire mediaReferences when a referenceDb is given');
        }
        // `as const` (a const assertion, not an unsafe cast) pins `modality` to the literal so the object
        // satisfies `DurableMediaMeta` without importing the type.
        const meta = {
          handle: `media://sha256-${'a'.repeat(64)}`,
          mimeType: 'image/png',
          modality: 'image',
          byteLength: 4,
        } as const;
        // BOTH host-port methods route through the SAME referenceDb — prove each via an observer store over it.
        const observer = createMediaReferenceStore(client.db);
        await refs.recordRunMedia(meta, 'run-1');
        await refs.reclaimRun('run-1');
        expect(observer.removeRunReferences('run-1')).toBe(0); // reclaimRun cleared the ref from the db
        await refs.recordRunMedia(meta, 'run-2');
        expect(observer.removeRunReferences('run-2')).toBe(1); // recordRunMedia wrote the ref to the db
      } finally {
        client.sqlite.close();
      }
    });
  });
});
