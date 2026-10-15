import { expect, it } from 'vitest';
import {
  admitMediaDescriptor,
  type DurableMediaMeta,
  type MediaStore,
  type RunEvent,
} from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('owns the admission batch and run state while the metadata port awaits caller mutation', async () => {
  const mediaHandle = `media://sha256-${'a'.repeat(64)}`;
  const part = {
    type: 'media',
    mimeType: 'audio/L16',
    source: { kind: 'handle', ref: mediaHandle },
    byteLength: 2,
    durationMs: 3,
  };
  const output = { part, label: 'before' };
  const admissionEntered = deferred<readonly DurableMediaMeta[]>();
  const admissionRelease = deferred<void>();
  const batches: (readonly DurableMediaMeta[])[] = [];
  let downstream: unknown;
  const mediaStore: MediaStore = {
    put: () => Promise.resolve(mediaHandle),
    get: () => Promise.resolve(new Uint8Array(2)),
    readRange: () => Promise.resolve(new Uint8Array(2)),
    resolveForEgress: () => Promise.resolve({ kind: 'handle', ref: mediaHandle }),
    validateMedia: (handle, descriptor) =>
      Promise.resolve(admitMediaDescriptor({ ...descriptor, handle, byteLength: 2 })),
  };
  const runStore = new InMemoryRunStore();
  const host = createInMemoryHost({
    store: runStore,
    mediaStore,
    mediaReferences: {
      admitProducedMedia: async (batch) => {
        batches.push(batch);
        if (batches.length === 1) {
          admissionEntered.resolve(batch);
          await admissionRelease.promise;
        }
      },
      recordRunMedia: () => undefined,
      reclaimRun: () => undefined,
    },
  });
  const engine = new WorkflowEngine({
    host,
    executor: {
      execute: (ctx) => {
        if (ctx.vertex.id === 'work') return Promise.resolve({ kind: 'completed', output });
        if (ctx.vertex.id === 'done') downstream = ctx.runOutputs.get('work');
        return Promise.resolve({ kind: 'completed', output: 'plain' });
      },
    },
  });
  const handle = engine.start({
    workflow: parseWorkflow(`schema_version: '1.0'
workflow:
  id: metadata-ownership
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: 'plain' }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }
`),
  });
  const collected = (async () => {
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    return events;
  })();
  const batch = await admissionEntered.promise;
  try {
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch[0])).toBe(true);
    output.label = 'after';
    part.source.ref = 'changed';
    part.mimeType = 'image/png';
    part.byteLength = 400;
    part.durationMs = 0;
    expect(batch).toEqual([
      {
        handle: mediaHandle,
        mimeType: 'audio/L16',
        modality: 'audio',
        byteLength: 2,
        durationMs: 3,
      },
    ]);
  } finally {
    admissionRelease.resolve();
  }
  const events = await collected;
  expect(events.at(-1)?.type).toBe('run:completed');
  const expected = {
    label: 'before',
    part: {
      type: 'media',
      mimeType: 'audio/L16',
      source: { kind: 'handle', ref: mediaHandle },
      byteLength: 2,
      durationMs: 3,
    },
  };
  expect(downstream).toEqual(expected);
  expect(downstream).not.toBe(output);
  for (const recorded of [events, runStore.eventsFor(handle.runId)]) {
    const completed = recorded.find(
      (event) => event.type === 'node:completed' && event.nodeId === 'work',
    );
    expect(completed?.type === 'node:completed' ? completed.output : undefined).toEqual(expected);
  }
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.every((admitted) => JSON.stringify(admitted) === JSON.stringify(batch))).toBe(
    true,
  );
});
