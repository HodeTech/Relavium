import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations } from './client.js';
import {
  createRunHistoryStore,
  CorruptRunEventError,
  UnreadableRunEventLogError,
} from './run-history-store.js';

const timestamp = '2026-10-10T00:00:00.000Z';
describe('strict incremental replay', () => {
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
      const prepare = client.sqlite.prepare.bind(client.sqlite);
      let batches = 0;
      const spy = vi.spyOn(client.sqlite, 'prepare').mockImplementation((query) => {
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
  });
});
