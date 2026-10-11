import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UsageCoverageFold, type RunEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations } from './client.js';
import {
  createRunHistoryStore,
  CorruptRunEventError,
  UnreadableRunEventLogError,
} from './run-history-store.js';

const timestamp = '2026-10-10T00:00:00.000Z';
describe('strict incremental replay', () => {
  it.each(['before-visit', 'during-visit'] as const)(
    'returns stored amount with its own coverage snapshot when settlement commits %s',
    async (schedule) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-atomic-run-summary-'));
      const client = createClient(join(root, 'db.sqlite'));
      const writer = createClient(client.path);
      try {
        runMigrations(client.db, { dbPath: client.path });
        let id = 0;
        const dependencies = {
          uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
          now: () => 1,
          workflow: { slug: 'w', name: 'w', definitionJson: '{}' },
        };
        const reader = createRunHistoryStore(client.db, dependencies);
        const producer = createRunHistoryStore(writer.db, dependencies);
        const workflowId = await producer.resolveWorkflowId('w');
        const envelope = { runId: 'r', timestamp };
        const invocation = {
          producerId: 'p',
          ordinal: 1,
          dispatchId: 'd',
          round: 0,
          chainAttempt: 1,
        };
        await producer.persistEvent({
          ...envelope,
          type: 'run:started',
          workflowId,
          inputs: {},
          executionMode: 'local',
          sequenceNumber: 0,
        });
        await producer.persistEvent({
          ...envelope,
          type: 'cost:coverage_started',
          basis: 'complete',
          sequenceNumber: 1,
        });
        await producer.persistEvent({
          ...envelope,
          type: 'node:started',
          nodeId: 'a',
          nodeType: 'agent',
          sequenceNumber: 2,
        });
        await producer.persistEvent({
          ...envelope,
          type: 'cost:usage_pending',
          nodeId: 'a',
          model: 'm',
          invocation,
          sequenceNumber: 3,
        });
        const discovered = reader.listRuns()[0];
        expect(discovered?.totalCostMicrocents).toBe(0);
        const settlement: RunEvent = {
          ...envelope,
          type: 'cost:attempt_settled',
          nodeId: 'a',
          model: 'm',
          invocation,
          attemptNumber: 1,
          inputTokens: 10,
          outputTokens: 5,
          costMicrocents: 70_000,
          cumulativeCostMicrocents: 70_000,
          priced: true,
          sequenceNumber: 4,
        };
        let writing: Promise<void> | undefined;
        if (schedule === 'before-visit') await producer.persistEvent(settlement);
        const fold = new UsageCoverageFold();
        const snapshot = reader.visitRunEventsForReplay('r', (event) => {
          if (schedule === 'during-visit' && writing === undefined) {
            writing = producer.persistEvent(settlement);
            // The production writer commits synchronously before its async acknowledgement. The
            // other native connection sees it while this reader still owns the earlier snapshot.
            expect(producer.loadRun('r')?.totalCostMicrocents).toBe(70_000);
          }
          fold.apply(event);
        });
        await writing;
        expect(snapshot?.totalCostMicrocents).toBe(schedule === 'before-visit' ? 70_000 : 0);
        expect(fold.snapshot().coverage).toEqual({
          unverified: false,
          unknownCalls: 0,
          pendingInvocations: schedule === 'before-visit' ? 0 : 1,
        });
        expect(producer.loadRun('r')?.totalCostMicrocents).toBe(70_000);
        expect(discovered?.totalCostMicrocents).toBe(0);
        expect(
          reader.visitRunEventsForReplay('missing', () => {
            throw new Error('unexpected row');
          }),
        ).toBeUndefined();
      } finally {
        writer.sqlite.close();
        client.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('validates indexed batches under one snapshot, including excluded streaming rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-incremental-replay-'));
    const client = createClient(join(root, 'db.sqlite'));
    const writer = createClient(client.path);
    try {
      runMigrations(client.db, { dbPath: client.path });
      let id = 0;
      const store = createRunHistoryStore(client.db, {
        uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
        now: () => 1,
        workflow: { slug: 'w', name: 'w', definitionJson: '{}' },
      });
      const workflowId = await store.resolveWorkflowId('w');
      await store.persistEvent({
        type: 'run:started',
        runId: 'r',
        workflowId,
        inputs: {},
        executionMode: 'local',
        timestamp,
        sequenceNumber: 0,
      });
      const insert = writer.sqlite.prepare(
        'INSERT INTO run_events (id, run_id, seq, event_type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
      );
      // Commit only fixture preparation together; the visitor's concurrent write stays separate.
      writer.sqlite.transaction(() => {
        for (let seq = 1; seq < 600; seq += 1) {
          const event: RunEvent = {
            type: 'node:started',
            runId: 'r',
            nodeId: 'a',
            nodeType: 'agent',
            sequenceNumber: seq,
            timestamp,
          };
          insert.run(`e-${seq}`, 'r', seq, event.type, JSON.stringify(event), 1);
        }
      })();
      const prepare = client.sqlite.prepare.bind(client.sqlite);
      let batches = 0;
      let stepReads = 0;
      const spy = vi.spyOn(client.sqlite, 'prepare').mockImplementation((query) => {
        if (/select.*from "step_executions"/i.test(query)) stepReads += 1;
        if (/select.*from "run_events"/i.test(query)) {
          expect(query).toMatch(/limit \?/i);
          batches += 1;
        }
        return prepare(query);
      });
      let seen = 0;
      store.visitRunEventsForReplay(
        'r',
        () => {
          seen += 1;
          if (seen === 1)
            insert.run(
              'later',
              'r',
              600,
              'future:unknown',
              JSON.stringify({
                type: 'future:unknown',
                runId: 'r',
                sequenceNumber: 600,
                timestamp,
              }),
              1,
            );
        },
        { streamingIncluded: false },
      );
      expect(seen).toBe(600);
      expect(batches).toBe(3);
      expect(stepReads).toBe(0);
      const visitSteps = vi.fn();
      expect(() => store.visitRunEventsForReplay('r', () => undefined, { visitSteps })).toThrow(
        UnreadableRunEventLogError,
      );
      expect(visitSteps).not.toHaveBeenCalled();
      expect(stepReads).toBe(0);
      expect(() => store.visitRunEventsForReplay('r', () => undefined)).toThrow(
        UnreadableRunEventLogError,
      );
      spy.mockRestore();
      writer.sqlite.prepare('UPDATE run_events SET event_type=?, payload_json=? WHERE seq=600').run(
        'agent:token',
        JSON.stringify({
          type: 'agent:token',
          runId: 'wrong-owner',
          sequenceNumber: 600,
          timestamp,
          nodeId: 'a',
          token: 'x',
        }),
      );
      expect(() =>
        store.visitRunEventsForReplay('r', () => undefined, { streamingIncluded: false }),
      ).toThrow(CorruptRunEventError);
    } finally {
      vi.restoreAllMocks();
      writer.sqlite.close();
      client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
