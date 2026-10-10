import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  CorruptRunEventError,
  createRunHistoryReader,
  createRunHistoryStore,
  UnreadableRunEventLogError,
  type RunHistoryStore,
} from './run-history-store.js';
import { runEvents } from './schema.js';

describe('stored event discriminator agrees with its column before forward skipping', () => {
  let client: DbClient;
  let store: RunHistoryStore;
  let directory: string;
  const timestamp = '2026-10-07T00:00:00.000Z';
  const futureType = 'future:pause';

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'run-event-projection-'));
    client = createClient(join(directory, 'history.db'));
    runMigrations(client.db);
    let ordinal = 0;
    store = createRunHistoryStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++ordinal).padStart(12, '0')}`,
      now: () => 0,
      workflow: {
        slug: 'probe',
        name: 'Probe',
        definitionJson: JSON.stringify({
          workflow: { id: 'probe', name: 'Probe', nodes: [], edges: [] },
        }),
      },
    });
    const workflowId = await store.resolveWorkflowId('probe');
    await store.persistEvent(
      RunEventSchema.parse({
        type: 'run:started',
        runId: 'run-1',
        timestamp,
        sequenceNumber: 0,
        workflowId,
        inputs: {},
        executionMode: 'local',
      }),
    );
  });

  afterEach(() => {
    client.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function pause(type: 'human_gate:paused' | 'budget:authorization'): Promise<RunEvent> {
    const event = RunEventSchema.parse({
      runId: 'run-1',
      timestamp,
      sequenceNumber: 1,
      nodeId: 'agent',
      gateId: 'gate',
      ...(type === 'human_gate:paused'
        ? { type, gateType: 'approval', message: 'approve' }
        : {
            type,
            authorization: {
              state: 'paused',
              allowance: { kind: 'legacy_no_allowance' },
              spentMicrocents: 2,
              limitMicrocents: 1,
            },
          }),
    });
    await store.persistEvent(event);
    return event;
  }

  for (const type of ['human_gate:paused', 'budget:authorization'] as const) {
    for (const mutation of [
      'unknown-payload',
      'future:pause',
      'agent:token',
      'agent:reasoning',
      'agent:tool_call',
      'agent:tool_result',
    ] as const) {
      for (const surface of ['display', 'state', 'discovery', 'replay'] as const) {
        it(`refuses ${type} with ${mutation} corruption on ${surface}`, async () => {
          const event = await pause(type);
          if (mutation === 'unknown-payload') {
            client.sqlite
              .prepare('UPDATE run_events SET payload_json = ? WHERE run_id = ? AND seq = ?')
              .run(JSON.stringify({ ...event, type: futureType }), 'run-1', 1);
          } else {
            client.sqlite
              .prepare('UPDATE run_events SET event_type = ? WHERE run_id = ? AND seq = ?')
              .run(mutation, 'run-1', 1);
          }
          const before = client.db.select().from(runEvents).all();
          const read = async () => {
            if (surface === 'discovery') return store.listInterruptedRuns();
            if (surface === 'display') return store.loadRunEventLog('run-1');
            if (surface === 'state')
              return createRunHistoryReader(client.db).loadRunStateEvents('run-1');
            return store.loadRunEventLogForReplay('run-1');
          };
          await expect(read()).rejects.toBeInstanceOf(CorruptRunEventError);
          expect(client.db.select().from(runEvents).all()).toEqual(before);
        });
      }
    }

    it(`keeps an unmodified ${type} pause resumable`, async () => {
      await pause(type);
      expect((await store.listInterruptedRuns())[0]).toMatchObject({
        runId: 'run-1',
        resumable: true,
        lastSequenceNumber: 1,
      });
      expect(store.loadRunEventLogForReplay('run-1').at(-1)?.type).toBe(type);
    });
  }

  it('preserves matching unknown display/discovery tolerance while refusing strict replay', async () => {
    const event = await pause('human_gate:paused');
    client.sqlite
      .prepare(
        'UPDATE run_events SET event_type = ?, payload_json = ? WHERE run_id = ? AND seq = ?',
      )
      .run(futureType, JSON.stringify({ ...event, type: futureType }), 'run-1', 1);
    expect(store.loadRunEventLog('run-1').skipped).toEqual([
      { sequenceNumber: 1, type: futureType },
    ]);
    expect((await store.listInterruptedRuns())[0]).toMatchObject({
      runId: 'run-1',
      resumable: false,
      lastSequenceNumber: 1,
    });
    expect(() => store.loadRunEventLogForReplay('run-1')).toThrow(UnreadableRunEventLogError);
  });

  const streams = [
    { type: 'agent:token', token: 'text', model: 'model' },
    { type: 'agent:reasoning', text: 'reasoning', model: 'model' },
    { type: 'agent:tool_call', model: 'model', toolId: 'tool', toolInput: {} },
    { type: 'agent:tool_result', toolId: 'tool', success: true, outputSummary: 'done' },
  ] as const;

  for (const stream of streams) {
    it(`validates and excludes a genuine ${stream.type} without losing the pause or high-water`, async () => {
      await pause('human_gate:paused');
      await store.persistEvent(
        RunEventSchema.parse({
          ...stream,
          runId: 'run-1',
          timestamp,
          sequenceNumber: 2,
          nodeId: 'agent',
        }),
      );
      const before = client.db.select().from(runEvents).all();
      expect(
        createRunHistoryReader(client.db)
          .loadRunStateEvents('run-1')
          .map((event) => event.type),
      ).toEqual(['run:started', 'human_gate:paused']);
      expect(store.loadRunEventLog('run-1').events.at(-1)?.type).toBe(stream.type);
      expect(store.loadRunEventLogForReplay('run-1').at(-1)?.type).toBe(stream.type);
      expect((await store.listInterruptedRuns())[0]).toMatchObject({
        runId: 'run-1',
        resumable: true,
        lastSequenceNumber: 2,
      });
      expect(client.db.select().from(runEvents).all()).toEqual(before);
    });
  }

  for (const damage of ['invalid-json', 'wrong-run-id', 'wrong-sequence'] as const) {
    for (const surface of ['display', 'state', 'discovery', 'replay'] as const) {
      it(`refuses ${damage} in a genuine streaming row before ${surface} filtering`, async () => {
        await pause('human_gate:paused');
        const stream = RunEventSchema.parse({
          type: 'agent:token',
          runId: 'run-1',
          timestamp,
          sequenceNumber: 2,
          nodeId: 'agent',
          token: 'text',
          model: 'model',
        });
        await store.persistEvent(stream);
        const payload =
          damage === 'invalid-json'
            ? '{'
            : JSON.stringify({
                ...stream,
                ...(damage === 'wrong-run-id' ? { runId: 'other-run' } : { sequenceNumber: 99 }),
              });
        client.sqlite
          .prepare('UPDATE run_events SET payload_json = ? WHERE run_id = ? AND seq = ?')
          .run(payload, 'run-1', 2);
        const before = client.db.select().from(runEvents).all();
        const read = async () => {
          if (surface === 'display') return store.loadRunEventLog('run-1');
          if (surface === 'state')
            return createRunHistoryReader(client.db).loadRunStateEvents('run-1');
          if (surface === 'discovery') return store.listInterruptedRuns();
          return store.loadRunEventLogForReplay('run-1');
        };
        await expect(read()).rejects.toBeInstanceOf(CorruptRunEventError);
        expect(client.db.select().from(runEvents).all()).toEqual(before);
      });
    }
  }
});
