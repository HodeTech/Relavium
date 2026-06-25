import { createClient, createRunHistoryReader, runMigrations } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { parseNdjson, seedRun } from './test-support.js';

describe('seedRun', () => {
  it('seeds a gateless paused run as a VALID media-job park (no run:paused zero-reason violation)', async () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      // No gate / budgetGateId → the media-job park branch. It must NOT throw: a `run:paused` with no suspension
      // reason is rejected by RunEventSchema's union refinement, so the park seeds a parked node + media_job.
      const runId = await seedRun(client.db, { slug: 'wf', runId: 'r1', state: 'paused' });
      expect(runId).toBe('r1');
      const reader = createRunHistoryReader(client.db);
      expect(reader.loadRun('r1')?.status).toBe('paused');
      const paused = reader.loadRunEvents('r1').find((e) => e.type === 'run:paused');
      if (paused?.type !== 'run:paused') {
        throw new Error('expected a run:paused event');
      }
      expect(paused.gateIds).toEqual([]); // no human gate — a media-job park, not a gate park
      expect(paused.pendingMediaJobNodeIds).toEqual(['g']);
    } finally {
      client.sqlite.close();
    }
  });
});

describe('parseNdjson', () => {
  it('parses one JSON object per non-empty line', () => {
    const text = '{"a":1}\n{"a":2}\n';
    expect(parseNdjson<{ a: number }>(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('ignores trailing/blank lines', () => {
    expect(parseNdjson('{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });

  it('rejects a non-object line (a malformed fixture fails loudly, not silently accepted)', () => {
    expect(() => parseNdjson('{"a":1}\n42')).toThrow(/expected one JSON object/);
    expect(() => parseNdjson('[1,2]')).toThrow(/expected one JSON object/); // an array is not a record
  });
});
