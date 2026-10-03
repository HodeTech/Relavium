// Native SQLite retention plus the actual CAS behind the public engine seam.
// Run events/lease use the reference host; these are not SQLite run-lease tests.
import {
  createClient,
  createMediaReferenceStore,
  createMediaReferencePort,
  runMigrations,
  InMemoryMediaStore,
} from '@relavium/db';
import type { MediaReferencePort, MediaStore, RunEvent } from '@relavium/shared';
import { expect, it } from 'vitest';
import {
  parseWorkflow,
  WorkflowEngine,
  createInMemoryHost,
  createInMemoryRunLeases,
  InMemoryRunStore,
} from '@relavium/core';

type Ending =
  | 'positive'
  | 'cancel'
  | 'run-deadline'
  | 'node-deadline'
  | 'successor'
  | 'late-pin-rejection';
for (const ending of [
  'positive',
  'cancel',
  'run-deadline',
  'node-deadline',
  'successor',
  'late-pin-rejection',
] satisfies readonly Ending[]) {
  it(`ordinary gate held actual CAS pin ${ending}`, async () => {
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pinEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cas = new InMemoryMediaStore();
    const mediaStore: MediaStore = {
      put: async (bytes) => {
        entered();
        await held;
        if (ending === 'late-pin-rejection') throw new Error('synthetic private pin failure');
        return cas.put(bytes);
      },
      get: (handle) => cas.get(handle),
      resolveForEgress: (handle) => cas.resolveForEgress(handle),
      readRange: (handle, range) => cas.readRange(handle, range),
    };
    const dbClient = createClient(':memory:');
    runMigrations(dbClient.db);
    const referenceStore = createMediaReferenceStore(dbClient.db);
    const nativeReferences = createMediaReferencePort(referenceStore);
    const activeRefs = new Set<string>();
    const referenceActions: string[] = [];
    const mediaReferences: MediaReferencePort = {
      recordRunMedia: (meta, runId) => {
        const recorded = nativeReferences.recordRunMedia(meta, runId);
        activeRefs.add(meta.handle);
        referenceActions.push('record');
        return recorded;
      },
      reclaimRun: (runId) => {
        const reclaimed = nativeReferences.reclaimRun(runId);
        activeRefs.clear();
        referenceActions.push('reclaim');
        return reclaimed;
      },
    };
    let leaseClock = 0;
    const leases = createInMemoryRunLeases(() => leaseClock);
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store, mediaStore, mediaReferences, runLeases: leases });
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: (ctx) =>
          Promise.resolve(
            ctx.vertex.id === 'g'
              ? { kind: 'paused', gate: { gateType: 'approval', message: 'Synthetic gate' } }
              : { kind: 'completed', output: 'done' },
          ),
      },
    });
    const definition = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: parent-held-pin\n${ending === 'run-deadline' ? '  timeout_ms: 3000\n' : ''}${ending === 'node-deadline' ? '  agents: [{ id: worker, model: synthetic-model, provider: openai, system_prompt: go }]\n' : ''}  nodes:\n    - { id: start, type: input }\n    - ${ending === 'node-deadline' ? '{ id: g, type: agent, agent_ref: worker, prompt_template: go, timeout_ms: 3000 }' : '{ id: g, type: human_gate, gate_type: approval }'}\n    - { id: out, type: output }\n  edges:\n    - { from: start, to: g }\n    - { from: g, to: out }`,
    );
    const handle = engine.start({ workflow: definition });
    const subscribers: RunEvent[] = [];
    const unsubscribe = handle.subscribe((event) => subscribers.push(event));
    const stream: RunEvent[] = [];
    let resume: Promise<void> | undefined;
    const drained = (async () => {
      for await (const event of handle.events) {
        stream.push(event);
        if (event.type === 'human_gate:paused')
          resume = engine.resume(handle.runId, event.gateId, {
            decision: 'approved',
            decidedBy: 'parent',
            payload: {
              image: {
                type: 'media',
                mimeType: 'image/png',
                source: { kind: 'base64', data: 'aGVsbG8=' },
              },
            },
          });
      }
    })();
    try {
      await pinEntered;
      for (let turn = 0; turn < 100; turn++) await Promise.resolve();
      expect(stream.some((event) => event.type === 'run:paused')).toBe(false);
      if (ending === 'cancel' || ending === 'late-pin-rejection') handle.cancel();
      if (ending === 'run-deadline') host.fireTimers();
      if (ending === 'node-deadline') host.fireDeadlines();
      if (ending === 'successor') {
        leaseClock = 80_000;
        expect(
          await leases.acquire(handle.runId, 'distinct-parent-successor', 60_000),
        ).toBeDefined();
        host.fireLiveness();
      }
      if (ending !== 'positive') await drained;
      const before = {
        subscriber: subscribers.length,
        rows: store.eventsFor(handle.runId).length,
        reference: referenceActions.length,
      };
      release();
      await resume;
      await drained;
      const rows = store.eventsFor(handle.runId);
      if (ending === 'positive') {
        expect(rows.at(-1)?.type).toBe('run:completed');
        expect(subscribers.filter((event) => event.type === 'human_gate:resumed')).toHaveLength(1);
        expect(referenceActions).toContain('record');
        expect(referenceActions.at(-1)).toBe('reclaim');
      } else {
        expect({
          lateSubscriberEvents: subscribers.slice(before.subscriber).map((event) => event.type),
          lateDurableRows: rows.slice(before.rows).map((event) => event.type),
          lateReferenceActions: referenceActions.slice(before.reference),
          activeReferenceCount: activeRefs.size,
          nativeReferenceRunIds: referenceStore.runReferenceRunIds(),
        }).toEqual({
          lateSubscriberEvents: [],
          lateDurableRows: [],
          lateReferenceActions: [],
          activeReferenceCount: 0,
          nativeReferenceRunIds: [],
        });
        if (ending === 'successor')
          expect((await leases.read(handle.runId))?.ownerId).toBe('distinct-parent-successor');
        else
          expect(rows.at(-1)?.type).toBe(
            ending.includes('deadline') ? 'run:failed' : 'run:cancelled',
          );
      }
      expect(host.deadlineCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(JSON.stringify(subscribers)).not.toContain('aGVsbG8=');
    } finally {
      release();
      handle.cancel();
      await resume;
      await drained;
      unsubscribe();
      dbClient.sqlite.close();
    }
  });
}
