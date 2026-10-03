import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  WorkflowEngine,
  createInMemoryHost,
  parseWorkflow,
  type ExecutionHost,
  type NodeExecutor,
} from '@relavium/core';
import {
  createClient,
  runMigrations,
  createRunHistoryStore,
  createRunLeasePort,
  createMediaReferenceStore,
  createMediaReferencePort,
  FilesystemMediaStore,
} from '@relavium/db';
import type { MediaStore, MediaReferencePort, RunEvent } from '@relavium/shared';
import { createHistoryCheckpointer } from './checkpointer.js';

for (const ending of ['normal', 'cancel', 'successor-observed', 'successor-unobserved'] as const) {
  it(`two actual SQLite connections preserve retention after ${ending}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-gate-successor-'));
    const first = createClient(join(root, 'history.db'));
    runMigrations(first.db);
    const second = createClient(join(root, 'history.db'));
    let clock = Date.parse('2026-10-03T00:00:00.000Z');
    const definition = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: native-gate-successor\n  nodes:\n    - { id: gate, type: human_gate, gate_type: approval }\n    - { id: out, type: output }\n  edges: [{ from: gate, to: out }]`,
    );
    const makeStore = (db: typeof first.db) =>
      createRunHistoryStore(db, {
        uuid: randomUUID,
        now: () => clock,
        workflow: {
          slug: definition.workflow.id,
          name: 'native gate successor',
          definitionJson: JSON.stringify(definition),
        },
      });
    const store = makeStore(first.db);
    const successorStore = makeStore(second.db);
    const leases = createRunLeasePort(store);
    const nativeReferences = createMediaReferencePort(
      createMediaReferenceStore(first.db, () => clock),
    );
    const referenceStore = createMediaReferenceStore(second.db, () => clock);
    const actions: string[] = [];
    const mediaReferences: MediaReferencePort = {
      recordRunMedia: (meta, runId) => {
        actions.push(`record:${runId}`);
        return nativeReferences.recordRunMedia(meta, runId);
      },
      reclaimRun: (runId) => {
        actions.push(`reclaim:${runId}`);
        return nativeReferences.reclaimRun(runId);
      },
    };
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pinEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cas = new FilesystemMediaStore(join(root, 'cas'));
    const heldCas: MediaStore = {
      put: async (bytes) => {
        entered();
        await held;
        return cas.put(bytes);
      },
      get: (handle) => cas.get(handle),
      resolveForEgress: (handle) => cas.resolveForEgress(handle),
      readRange: (handle, range) => cas.readRange(handle, range),
    };
    const base = createInMemoryHost({
      store,
      checkpointer: createHistoryCheckpointer(store),
      runLeases: leases,
      mediaStore: heldCas,
      mediaReferences,
    });
    const host: ExecutionHost = {
      ...base,
      clock: { now: () => new Date(clock).toISOString() },
      ids: { newId: randomUUID },
    };
    const executor: NodeExecutor = {
      execute: (ctx) =>
        Promise.resolve(
          ctx.vertex.id === 'gate'
            ? { kind: 'paused', gate: { gateType: 'approval', message: 'synthetic ordinary gate' } }
            : { kind: 'completed', output: 'done' },
        ),
    };
    const engine = new WorkflowEngine({ host, executor });
    const handle = engine.start({ workflow: definition });
    const events: RunEvent[] = [];
    let gateId: string | undefined;
    let resume: Promise<void> | undefined;
    const drain = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'human_gate:paused') {
          gateId = event.gateId;
          resume = engine.resume(handle.runId, event.gateId, {
            decision: 'approved',
            decidedBy: 'original',
            payload: {
              image: {
                type: 'media',
                mimeType: 'image/png',
                source: { kind: 'base64', data: 'aGVsbG8=' },
              },
            },
          });
        }
      }
    })();
    try {
      await pinEntered;
      expect(gateId).toBeDefined();
      expect(await leases.read(handle.runId)).toBeDefined();
      if (ending === 'cancel') {
        handle.cancel();
        await drain;
      }
      if (ending.startsWith('successor')) {
        clock += 80_000;
        const successorBase = createInMemoryHost({
          store: successorStore,
          checkpointer: createHistoryCheckpointer(successorStore),
          runLeases: createRunLeasePort(successorStore),
          mediaStore: cas,
          mediaReferences: createMediaReferencePort(referenceStore),
        });
        const successor = new WorkflowEngine({
          host: {
            ...successorBase,
            ids: { newId: randomUUID },
            clock: { now: () => new Date(clock).toISOString() },
          },
          executor,
        });
        if (gateId === undefined) throw new Error('Missing actual durable ordinary gate');
        const winner = await successor.resumeFromCheckpoint({
          runId: handle.runId,
          workflow: definition,
          gateId,
          decision: { decision: 'approved', decidedBy: 'successor' },
        });
        const winningEvents: RunEvent[] = [];
        for await (const event of winner.events) winningEvents.push(event);
        expect(winningEvents.at(-1)?.type).toBe('run:completed');
        expect(referenceStore.runReferenceRunIds()).toEqual([]);
        expect(await leases.read(handle.runId)).toBeUndefined();
        if (ending === 'successor-observed') {
          base.fireLiveness();
          await drain;
        }
      }
      const before = {
        actions: actions.length,
        rows: store.loadRunEventLogForReplay(handle.runId).length,
      };
      release();
      await resume;
      await drain;
      const result = {
        lateReferenceActions: actions.slice(before.actions),
        referenceRunIds: referenceStore.runReferenceRunIds(),
        lateDurableRows: store
          .loadRunEventLogForReplay(handle.runId)
          .slice(before.rows)
          .map((event) => event.type),
        finalType: store.loadRunEventLogForReplay(handle.runId).at(-1)?.type,
        deadlines: base.deadlineCount(),
        heartbeats: base.livenessCount(),
      };
      if (ending === 'normal') {
        expect(actions.some((action) => action.startsWith('record:'))).toBe(true);
        expect(result.finalType).toBe('run:completed');
      } else {
        expect(result.lateDurableRows).toEqual([]);
        expect(result.lateReferenceActions).toEqual([]);
      }
      expect(result.referenceRunIds).toEqual([]);
      expect(result.deadlines).toBe(0);
      expect(result.heartbeats).toBe(0);
    } finally {
      release();
      handle.cancel();
      await resume;
      await drain;
      first.sqlite.close();
      second.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
