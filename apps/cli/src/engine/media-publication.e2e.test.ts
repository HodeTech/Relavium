// Actual CAS and file-backed SQLite admission through the pure engine's public host seam.
// Run-event persistence is the reference store; these are not SQLite run-lease tests.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createInMemoryHost,
  InMemoryRunStore,
  parseWorkflow,
  WorkflowEngine,
  type ExecutionHost,
  type RunHandle,
} from '@relavium/core';
import {
  createClient,
  createMediaReferencePort,
  createMediaReferenceStore,
  FilesystemMediaStore,
  mediaObjects,
  mediaReferences,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import {
  collectDurableMediaHandles,
  type MediaReferencePort,
  type RunEvent,
} from '@relavium/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Explicit L16's finite structural profile: nonempty even byte count, no decoder/rate claim.
const bytes = new Uint8Array([0, 1, 0, 2, 0, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');
const handle = `media://sha256-${digest}`;
const descriptor = {
  handle,
  mimeType: 'audio/L16',
  modality: 'audio',
  byteLength: bytes.length,
} as const;
const part = {
  type: 'media',
  mimeType: 'audio/L16',
  byteLength: bytes.length,
  source: { kind: 'handle', ref: handle },
} as const;
const workflow = parseWorkflow(
  "schema_version: '1.0'\nworkflow:\n  id: publication-admission\n  nodes: [{ id: work, type: output }]\n  edges: []",
);
let root: string;
let client: DbClient;
let cas: FilesystemMediaStore;
let references: ReturnType<typeof createMediaReferenceStore>;
const runs: RunHandle[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relavium-media-publication-'));
  client = createClient(join(root, 'history.db'));
  runMigrations(client.db);
  cas = new FilesystemMediaStore(join(root, 'cas'));
  references = createMediaReferenceStore(client.db);
});
afterEach(async () => {
  for (const run of runs) run.cancel();
  await Promise.allSettled(runs.splice(0).map((run) => run.depart()));
  vi.restoreAllMocks();
  client.sqlite.close();
  await rm(root, { recursive: true, force: true });
});
function start(output: unknown, host: ExecutionHost, saveTo = false): RunHandle {
  const engine = new WorkflowEngine({
    host,
    executor: {
      execute: (ctx) => {
        // Paid work precedes media preparation. A publication refusal must retain its observed charge.
        ctx.emit({
          type: 'cost:updated',
          nodeId: 'work',
          model: 'synthetic-offline-model',
          inputTokens: 2,
          outputTokens: 3,
          costMicrocents: 7,
          cumulativeCostMicrocents: 0,
        });
        return Promise.resolve({ kind: 'completed', output, tokensUsed: { input: 2, output: 3 } });
      },
    },
  });
  const run = engine.start({
    workflow: saveTo
      ? parseWorkflow(
          "schema_version: '1.0'\nworkflow:\n  id: publication-save\n  nodes: [{ id: work, type: output, save_to: result.pcm }]\n  edges: []",
        )
      : workflow,
  });
  runs.push(run);
  return run;
}
async function drain(run: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of run.events) events.push(event);
  expect((await run.depart()).kind).toBe('closed');
  expect(
    events.filter((event) => ['run:completed', 'run:failed', 'run:cancelled'].includes(event.type)),
  ).toHaveLength(1);
  const completed = events.find((event) => event.type === 'run:completed');
  if (completed) {
    expect(completed.totalCostMicrocents).toBe(7);
    expect(completed.totalTokensUsed).toEqual({ input: 2, output: 3 });
  }
  const failed = events.find((event) => event.type === 'run:failed');
  if (failed) expect(failed.cumulativeCostMicrocents).toBe(7);
  return events;
}
function host(
  store = new InMemoryRunStore(),
  port = createMediaReferencePort(references),
): ExecutionHost {
  return createInMemoryHost({ store, mediaStore: cas, mediaReferences: port });
}

it('admits metadata before append and creates lifetime references only after its ACK', async () => {
  expect(await cas.put(bytes, 'audio/L16')).toBe(handle);
  const store = new InMemoryRunStore();
  const append = store.persistEvent.bind(store);
  let release = () => {};
  let entered = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atAppend = new Promise<void>((resolve) => {
    entered = resolve;
  });
  store.persistEvent = async (event, context) => {
    if (event.type === 'node:completed') {
      entered();
      expect(references.describe(handle), 'FS_CAUSAL_MEDIA_PREPUBLICATION_ADMISSION').toEqual({
        mimeType: 'audio/L16',
        byteLength: 6,
        allowedScopes: [],
      });
      expect(client.db.select().from(mediaReferences).all()).toEqual([]);
      await blocked;
    }
    return append(event, context);
  };
  const run = start({ nested: [part] }, host(store));
  const draining = drain(run);
  try {
    await atAppend;
    expect(references.listObjectHandles()).toEqual([handle]);
    expect(references.runReferenceRunIds()).toEqual([]);
  } finally {
    release();
  }
  const events = await draining;
  expect(events.at(-1)?.type).toBe('run:completed');
  expect(collectDurableMediaHandles(events.at(-1))).toEqual([descriptor]);
  expect(references.runReferenceRunIds()).toEqual([]);
  expect(references.describe(handle)?.allowedScopes).toEqual([]);
});

it.each(['bad-count', 'bad-mime', 'known-duration', 'deleted-conflict'] as const)(
  'refuses existing SQLite tuple conflict %s before state, save_to and append',
  async (fault) => {
    await cas.put(bytes, 'audio/L16');
    references.recordObject({
      ...descriptor,
      ...(fault === 'bad-count' || fault === 'deleted-conflict'
        ? { byteLength: 8 }
        : fault === 'bad-mime'
          ? { mimeType: 'audio/wav' }
          : { durationMs: 9 }),
    });
    if (fault === 'deleted-conflict') references.reclaimExpired(0);
    const original = client.db.select().from(mediaObjects).all();
    const save = vi.fn(() => Promise.resolve({ bytesWritten: bytes.length }));
    const output = {
      nested: [{ ...part, ...(fault === 'known-duration' ? { durationMs: 10 } : {}) }],
    };
    const events = await drain(start(output, { ...host(), mediaWrite: save }, true));
    expect(events.at(-1)?.type, 'FS_CAUSAL_MEDIA_PREPUBLICATION_ADMISSION').toBe('run:failed');
    expect(events.some((event) => event.type === 'node:completed')).toBe(false);
    expect(save, 'FS_CAUSAL_MEDIA_PRESTATE_ADMISSION').not.toHaveBeenCalled();
    expect(client.db.select().from(mediaObjects).all()).toEqual(original);
    expect(client.db.select().from(mediaReferences).all()).toEqual([]);
    expect(events.find((event) => event.type === 'cost:updated')).toMatchObject({
      costMicrocents: 7,
    });
    expect(JSON.stringify(events)).not.toContain(handle);
  },
);

it.each([false, true])(
  'refuses same-hash conflicts before any metadata mutation in either order (%s)',
  async (reverse) => {
    await cas.put(bytes, 'audio/L16');
    const occurrences = [part, { ...part, byteLength: 8 }];
    const events = await drain(start(reverse ? occurrences.reverse() : occurrences, host()));
    expect(events.at(-1)?.type).toBe('run:failed');
    expect(references.listObjectHandles()).toEqual([]);
    expect(client.db.select().from(mediaReferences).all()).toEqual([]);
  },
);

it.each([
  'missing-bytes',
  'invalid-legacy-bytes',
  'no-store',
  'missing-port-method',
  'admission-io',
] as const)('refuses handle-only publication with %s and retains paid work', async (fault) => {
  if (fault === 'invalid-legacy-bytes') {
    const target = join(root, 'cas', digest.slice(0, 2));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, digest.slice(2)), new Uint8Array([1]));
  } else if (fault !== 'missing-bytes') await cas.put(bytes, 'audio/L16');
  const port: MediaReferencePort = createMediaReferencePort(references);
  if (fault === 'missing-port-method') Reflect.deleteProperty(port, 'admitProducedMedia');
  if (fault === 'admission-io')
    port.admitProducedMedia = () => Promise.reject(new Error('PRIVATE metadata IO failure'));
  const executionHost =
    fault === 'no-store'
      ? createInMemoryHost({ mediaReferences: port })
      : host(new InMemoryRunStore(), port);
  const events = await drain(start({ deep: [{ payload: part }] }, executionHost));
  expect(events.at(-1)?.type, 'FS_CAUSAL_MEDIA_HANDLE_EVIDENCE').toBe('run:failed');
  expect(events.some((event) => event.type === 'node:completed')).toBe(false);
  expect(events.find((event) => event.type === 'cost:updated')).toMatchObject({
    costMicrocents: 7,
  });
  expect(JSON.stringify(events)).not.toContain(handle);
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
  expect(references.listObjectHandles()).toEqual([]);
});

it('text-only publication does not invoke media admission', async () => {
  const admission = vi.fn(() => {
    throw new Error('unexpected text admission');
  });
  const port: MediaReferencePort = {
    admitProducedMedia: admission,
    recordRunMedia: () => undefined,
    reclaimRun: () => undefined,
  };
  const events = await drain(start('text-only', createInMemoryHost({ mediaReferences: port })));
  expect(events.at(-1)?.type).toBe('run:completed');
  expect(admission).not.toHaveBeenCalled();
});

it('permits verified bytes with an absent optional reference port', async () => {
  await cas.put(bytes, 'audio/L16');
  const events = await drain(start(part, createInMemoryHost({ mediaStore: cas })));
  expect(events.at(-1)?.type).toBe('run:completed');
  expect(collectDurableMediaHandles(events.at(-1))).toEqual([descriptor]);
});

it('fresh terminal validation strips nested media after bytes change, retaining charge and one terminal', async () => {
  await cas.put(bytes, 'audio/L16');
  const store = new InMemoryRunStore();
  const append = store.persistEvent.bind(store);
  store.persistEvent = async (event, context) => {
    await append(event, context);
    if (event.type === 'node:completed')
      await writeFile(
        join(root, 'cas', digest.slice(0, 2), digest.slice(2)),
        new Uint8Array([4, 5]),
      );
  };
  const events = await drain(start({ deep: [{ payload: part }] }, host(store)));
  const terminal = events.at(-1);
  expect(terminal, 'FS_CAUSAL_MEDIA_TERMINAL_REVALIDATION').toMatchObject({
    type: 'run:completed',
  });
  if (terminal?.type === 'run:completed')
    expect(terminal.outputs, 'FS_CAUSAL_MEDIA_TERMINAL_REVALIDATION').toEqual({});
  expect(
    collectDurableMediaHandles(events.find((event) => event.type === 'node:completed')),
  ).toEqual([descriptor]);
  expect(events.find((event) => event.type === 'cost:updated')).toMatchObject({
    costMicrocents: 7,
  });
  expect(references.runReferenceRunIds()).toEqual([]);
});

it('an append failure leaves admitted metadata with no run reference, then settles once', async () => {
  await cas.put(bytes, 'audio/L16');
  const store = new InMemoryRunStore();
  const append = store.persistEvent.bind(store);
  store.persistEvent = (event, context) =>
    event.type === 'node:completed'
      ? Promise.reject(new Error('synthetic append refusal'))
      : append(event, context);
  const events = await drain(start(part, host(store)));
  expect(events.at(-1)?.type).toBe('run:failed');
  expect(references.listObjectHandles()).toEqual([handle]);
  expect(client.db.select().from(mediaReferences).all()).toEqual([]);
});

it('fresh terminal metadata admission strips a tuple corrupted after the node ACK', async () => {
  await cas.put(bytes, 'audio/L16');
  const store = new InMemoryRunStore();
  const append = store.persistEvent.bind(store);
  store.persistEvent = async (event, context) => {
    await append(event, context);
    if (event.type === 'node:completed') {
      // Simulate a legacy/external writer after successful node admission. The CAS bytes stay valid;
      // only the independent durable-draft metadata barrier can refuse this terminal payload.
      client.db.update(mediaObjects).set({ byteLength: 8 }).run();
    }
  };
  const events = await drain(start({ deep: [{ payload: part }] }, host(store)));
  const terminal = events.at(-1);
  expect(terminal, 'FS_CAUSAL_MEDIA_TERMINAL_METADATA_ADMISSION').toMatchObject({
    type: 'run:completed',
  });
  if (terminal?.type === 'run:completed')
    expect(terminal.outputs, 'FS_CAUSAL_MEDIA_TERMINAL_METADATA_ADMISSION').toEqual({});
  expect(
    collectDurableMediaHandles(events.find((event) => event.type === 'node:completed')),
  ).toEqual([descriptor]);
  expect(events.filter((event) => event.type === 'node:completed')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'cost:updated')).toHaveLength(1);
  expect(client.db.select().from(mediaObjects).all()[0]?.byteLength).toBe(8);
  expect(references.runReferenceRunIds()).toEqual([]);
});

it('post-ACK retention failure cannot revoke verified publication', async () => {
  await cas.put(bytes, 'audio/L16');
  const native = createMediaReferencePort(references);
  const port: MediaReferencePort = {
    admitProducedMedia: (batch) => native.admitProducedMedia(batch),
    recordRunMedia: () => Promise.reject(new Error('synthetic retention failure')),
    reclaimRun: () => {
      throw new Error('synthetic retention failure');
    },
  };
  const events = await drain(start(part, host(new InMemoryRunStore(), port)));
  expect(events.at(-1)?.type).toBe('run:completed');
  expect(collectDurableMediaHandles(events.at(-1))).toEqual([descriptor]);
  expect(references.describe(handle)?.allowedScopes).toEqual([]);
});
