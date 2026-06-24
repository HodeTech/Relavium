import { createClient, runMigrations, type Db, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson, seedRun } from '../test-support.js';
import { statusCommand, type StatusCommandDeps } from './status.js';

function globalOptions(json = false): GlobalOptions {
  return { json, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' };
}

describe('statusCommand', () => {
  let client: DbClient;
  let db: Db;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    db = client.db;
  });
  afterEach(() => {
    client.sqlite.close();
  });

  function deps(io: ReturnType<typeof captureIo>['io'], json = false): StatusCommandDeps {
    return { io, global: globalOptions(json), openDb: () => ({ db, close: () => {} }) };
  }

  it('reports "No active runs." when history holds only terminal runs', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'done', state: 'completed' });

    expect(statusCommand(deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toContain('No active runs.');
  });

  it('lists active/paused runs with per-node steps and surfaces the pending gate', async () => {
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'demo',
      runId: 'paused-1',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
    });
    await seedRun(db, { slug: 'demo', runId: 'done', state: 'completed' }); // terminal → excluded

    statusCommand(deps(io));
    const text = out();
    expect(text).toContain('run paused-1 — paused');
    expect(text).toContain('n1 [transform]'); // the completed node step
    expect(text).toContain('g [human_in_the_loop]'); // the gate node still 'running'
    expect(text).toContain('pending gate gate-1 (approval) at g — "ship it?"'); // the gate message is shown
    expect(text).not.toContain('run done'); // a terminal run is not active
  });

  it('lists a running run with its steps and no pending gate', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'run-x', state: 'running' });

    statusCommand(deps(io));
    const text = out();
    expect(text).toContain('run run-x — running');
    expect(text).toContain('n1 [transform]');
    expect(text).not.toContain('pending gate'); // a running run holds no pending human gate
  });

  it('--json emits one record per active run with steps + pendingGates', async () => {
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'demo',
      runId: 'paused-1',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval' },
    });

    statusCommand(deps(io, true));
    const records = parseNdjson<{
      runId: string;
      status: string;
      steps: { nodeId: string }[];
      pendingGates: { gateId: string }[];
    }>(out());
    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe('paused-1');
    expect(records[0]?.status).toBe('paused');
    expect(records[0]?.pendingGates[0]?.gateId).toBe('gate-1');
    expect(records[0]?.steps.some((s) => s.nodeId === 'n1')).toBe(true);
  });
});
