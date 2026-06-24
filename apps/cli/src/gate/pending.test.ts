import { createClient, createRunHistoryReader, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRun } from '../test-support.js';
import { pendingHumanGates } from './pending.js';

describe('pendingHumanGates', () => {
  let client: DbClient;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
  });

  it('returns the pending human gate with its node id, type, and message', async () => {
    await seedRun(client.db, {
      slug: 'a',
      runId: 'r1',
      state: 'paused',
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });
    const events = createRunHistoryReader(client.db).loadRunEvents('r1');

    expect(pendingHumanGates(events)).toEqual([
      { gateId: 'g1', nodeId: 'g', gateType: 'approval', message: 'ship it?' },
    ]);
  });

  it('excludes a budget gate (the `relavium budget resume` surface)', async () => {
    await seedRun(client.db, { slug: 'a', runId: 'r1', state: 'paused', budgetGateId: 'budget-1' });
    const events = createRunHistoryReader(client.db).loadRunEvents('r1');

    expect(pendingHumanGates(events)).toEqual([]);
  });

  it('returns [] for an empty event log (no reconstructable run)', () => {
    expect(pendingHumanGates([])).toEqual([]);
  });
});
