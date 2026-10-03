import { expect, it } from 'vitest';
import {
  InMemoryRunStore,
  WorkflowEngine,
  createInMemoryHost,
  parseWorkflow,
} from '@relavium/core';
import {
  createClient,
  runMigrations,
  InMemoryMediaStore,
  createMediaReferenceStore,
  createMediaReferencePort,
} from '@relavium/db';
import { LeaseFencedError, type MediaReferencePort, type RunEvent } from '@relavium/shared';

for (const ending of ['acknowledged', 'terminal-store-refusal', 'terminal-fenced'] as const) {
  it(`ordered native retention preserves ${ending}`, async () => {
    const workflow = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: retention-ack-control\n  nodes: [{ id: work, type: output }]\n  edges: []`,
    );
    const db = createClient(':memory:');
    runMigrations(db.db);
    const referenceStore = createMediaReferenceStore(db.db);
    const nativeReferences = createMediaReferencePort(referenceStore);
    const actions: string[] = [];
    const references: MediaReferencePort = {
      recordRunMedia: (meta, runId) => {
        actions.push('record');
        return nativeReferences.recordRunMedia(meta, runId);
      },
      reclaimRun: (runId) => {
        actions.push('reclaim');
        return nativeReferences.reclaimRun(runId);
      },
    };
    const store = new InMemoryRunStore();
    const persist = store.persistEvent.bind(store);
    let terminalAttempt = -1;
    store.persistEvent = (event, context) => {
      actions.push(`append:${event.type}`);
      if (event.type === 'run:completed') {
        terminalAttempt = actions.length;
        if (ending === 'terminal-store-refusal')
          return Promise.reject(new Error('synthetic terminal store fault'));
        if (ending === 'terminal-fenced')
          return Promise.reject(new LeaseFencedError(event.runId, 'original', 1, 2));
      }
      return persist(event, context);
    };
    const base = createInMemoryHost({
      store,
      mediaStore: new InMemoryMediaStore(),
      mediaReferences: references,
    });
    const originalPut = base.terminalOutbox.put.bind(base.terminalOutbox);
    base.terminalOutbox.put = (event) => {
      actions.push('outbox');
      expect(referenceStore.runReferenceRunIds()).toEqual([event.runId]);
      return originalPut(event);
    };
    const engine = new WorkflowEngine({
      host: base,
      executor: {
        execute: () =>
          Promise.resolve({
            kind: 'completed',
            output: {
              image: {
                type: 'media',
                mimeType: 'image/png',
                source: { kind: 'base64', data: 'aGVsbG8=' },
              },
            },
          }),
      },
    });
    const handle = engine.start({ workflow });
    const events: RunEvent[] = [];
    try {
      for await (const event of handle.events) events.push(event);
      expect(terminalAttempt).toBeGreaterThan(0);
      const terminalActions = actions.slice(terminalAttempt);
      if (ending === 'terminal-store-refusal') {
        expect(handle.durability()).toBe('uncertain');
        expect(events.at(-1)?.type).toBe('run:completed');
        expect(terminalActions).toContain('record');
        expect(terminalActions.indexOf('record')).toBeLessThan(terminalActions.indexOf('outbox'));
        expect(terminalActions).not.toContain('reclaim');
        expect(referenceStore.runReferenceRunIds()).toEqual([handle.runId]);
        expect(await base.terminalOutbox.list()).toHaveLength(1);
      } else if (ending === 'terminal-fenced') {
        expect(handle.durability()).toBe('uncertain');
        expect(events.some((event) => event.type === 'run:completed')).toBe(false);
        expect(terminalActions).not.toContain('record');
        expect(terminalActions).not.toContain('reclaim');
        expect(await base.terminalOutbox.list()).toEqual([]);
      } else {
        expect(handle.durability()).toBe('durable');
        expect(terminalActions).toEqual(['record', 'reclaim']);
        expect(referenceStore.runReferenceRunIds()).toEqual([]);
        expect(events.at(-1)?.type).toBe('run:completed');
      }
      expect(base.livenessCount()).toBe(0);
      expect(base.deadlineCount()).toBe(0);
    } finally {
      handle.cancel();
      db.sqlite.close();
    }
  });
}
