// Actual engine/de-inlining -> filesystem CAS -> file-backed SQLite metadata/append boundary.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRunStore, WorkflowEngine, parseWorkflow, type RunHandle } from '@relavium/core';
import {
  createClient,
  createMediaReferenceStore,
  FilesystemMediaStore,
  mediaObjects,
  mediaReferences,
  runMigrations,
} from '@relavium/db';
import { collectDurableMediaHandles, type RunEvent } from '@relavium/shared';
import { expect, it } from 'vitest';
import {
  FLAC_BLOCK_REFUSALS,
  flacBlocks,
} from '../../../../packages/shared/src/media-flac-vectors.js';
import { createCliHost } from './host.js';

const workflow = parseWorkflow(
  "schema_version: '1.0'\nworkflow:\n  id: flac-publication\n  nodes: [{ id: produce, type: output }]\n  edges: []",
);

async function publish(bytes: Uint8Array, valid: boolean, marker: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'relavium-flac-publication-'));
  const client = createClient(join(root, 'history.db'));
  let run: RunHandle | undefined;
  try {
    runMigrations(client.db);
    const references = createMediaReferenceStore(client.db);
    const store = new InMemoryRunStore();
    const appended: RunEvent[] = [];
    const append = store.persistEvent.bind(store);
    const handle = `media://sha256-${createHash('sha256').update(bytes).digest('hex')}`;
    let mediaAppends = 0;
    store.persistEvent = async (event, context) => {
      for (const meta of collectDurableMediaHandles(event)) {
        mediaAppends++;
        expect(meta, marker).toEqual({
          handle,
          mimeType: 'audio/flac',
          modality: 'audio',
          byteLength: bytes.length,
        });
        expect(references.describe(handle), marker).toEqual({
          mimeType: 'audio/flac',
          byteLength: bytes.length,
          allowedScopes: [],
        });
      }
      await append(event, context);
      appended.push(event);
    };
    const host = createCliHost(store, {
      media: { casRoot: join(root, 'cas'), referenceDb: client.db },
    });
    if (!(host.mediaStore instanceof FilesystemMediaStore) || host.mediaReferences === undefined)
      throw new Error('Missing production media ports');
    const record = host.mediaReferences.recordRunMedia.bind(host.mediaReferences);
    let grants = 0;
    host.mediaReferences.recordRunMedia = (batch, runId) => {
      expect(
        appended.some((event) => collectDurableMediaHandles(event).length > 0),
        marker,
      ).toBe(true);
      grants++;
      return record(batch, runId);
    };
    run = new WorkflowEngine({
      host,
      executor: {
        execute: () =>
          Promise.resolve({
            kind: 'completed',
            output: {
              type: 'media',
              mimeType: 'audio/flac',
              source: { kind: 'base64', data: Buffer.from(bytes).toString('base64') },
            },
          }),
      },
    }).start({ workflow });
    const events: RunEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect((await run.depart()).kind).toBe('closed');
    expect(
      events.filter((event) =>
        ['run:completed', 'run:failed', 'run:cancelled'].includes(event.type),
      ),
    ).toHaveLength(1);
    expect(events.at(-1)?.type, marker).toBe(valid ? 'run:completed' : 'run:failed');
    if (valid) {
      expect(mediaAppends, marker).toBeGreaterThan(0);
      expect(grants, marker).toBeGreaterThan(0);
      expect(await host.mediaStore.get(handle), marker).toEqual(bytes);
      expect(references.listObjectHandles()).toEqual([handle]);
    } else {
      expect(mediaAppends, marker).toBe(0);
      expect(grants, marker).toBe(0);
      expect(
        appended.some((event) => event.type === 'node:completed'),
        marker,
      ).toBe(false);
      expect(appended.flatMap(collectDurableMediaHandles), marker).toEqual([]);
      expect(client.db.select().from(mediaObjects).all(), marker).toEqual([]);
      expect(client.db.select().from(mediaReferences).all(), marker).toEqual([]);
      const [missing] = await Promise.allSettled([host.mediaStore.get(handle)]);
      expect(missing, marker).toMatchObject({ status: 'rejected' });
      expect(await host.mediaStore.listHandles(), marker).toEqual([]);
    }
    expect(references.runReferenceRunIds()).toEqual([]);
    expect(
      (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  } finally {
    run?.cancel();
    await run?.depart();
    client.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
}

it.each(FLAC_BLOCK_REFUSALS)(
  'MEDIA_FLAC_PUBLICATION_%s: refuses before append, metadata or grant',
  (rule, bytes) => publish(bytes, false, `MEDIA_FLAC_PUBLICATION_${rule}`),
);
it('MEDIA_FLAC_PUBLICATION_SHORT_FINAL: preserves the admitted bytes and ACK ordering', () =>
  publish(flacBlocks([32, 32, 1]), true, 'MEDIA_FLAC_PUBLICATION_SHORT_FINAL'));
