import { createClient, createRunHistoryReader, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRun } from '../test-support.js';
import { humanGateResumeHints, pendingHumanGates } from './pending.js';

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

describe('humanGateResumeHints', () => {
  it('names one copyable command per decision the gate type accepts', () => {
    expect(humanGateResumeHints('run-1', 'g-1', 'approval')).toEqual([
      'approve: relavium gate run-1 --gate g-1 --approve',
      'reject: relavium gate run-1 --gate g-1 --reject',
    ]);
    expect(humanGateResumeHints('run-1', 'g-1', 'review')).toEqual([
      'approve: relavium gate run-1 --gate g-1 --approve',
      'reject: relavium gate run-1 --gate g-1 --reject',
    ]);
    expect(humanGateResumeHints('run-1', 'g-1', 'input')).toEqual([
      'input: relavium gate run-1 --gate g-1 --input <json>',
      'reject: relavium gate run-1 --gate g-1 --reject',
    ]);
  });

  it.each([
    ['a shell-active run id', 'run;rm -rf ~', 'g-1'],
    ['an option-shaped gate id', 'run-1', '--approve'],
    ['a gate id with a space', 'run-1', 'g 1'],
    ['a terminal control', 'run-1', 'g\u001b]0;x\u0007'],
  ])('builds no command from %s, only the flags', (_label, runId, gateId) => {
    expect(humanGateResumeHints(runId, gateId, 'input')).toEqual([
      'Use relavium gate with the recorded run and gate IDs and --input <json> or --reject.',
    ]);
  });
});
