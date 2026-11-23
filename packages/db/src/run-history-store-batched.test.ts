import { describe, expect, it } from 'vitest';

import { createClient, runMigrations } from './client.js';
import {
  createRunHistoryReader,
  MAX_RUN_STATE_EVENT_BATCH_IDS,
  RunHistoryReadError,
} from './run-history-store.js';

/** The batched state-event read's bounds and its shape for runs that have no events. */
describe('loadRunStateEventsForRuns — the bound and the shape', () => {
  it('answers exactly the bound, refuses one more, and gives every requested id one entry', () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const reader = createRunHistoryReader(client.db);
    const ids = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `run-${String(i)}`);

    // The literals are the claim: the bound is 200 and 201 is refused, whatever the constant is changed to.
    expect(MAX_RUN_STATE_EVENT_BATCH_IDS).toBe(200);
    expect(() => reader.loadRunStateEventsForRuns(ids(201))).toThrow(RunHistoryReadError);

    const answer = reader.loadRunStateEventsForRuns(ids(200));
    expect(answer.size).toBe(200);
    // A run with no events is a healthy empty answer, not a corrupt one.
    expect(answer.get('run-0')).toEqual({ events: [] });

    // A repeated id is collapsed to one entry.
    expect(reader.loadRunStateEventsForRuns(['run-0', 'run-0']).size).toBe(1);
    client.sqlite.close();
  });
});
