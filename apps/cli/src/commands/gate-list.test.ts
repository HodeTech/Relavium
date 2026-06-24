import { createClient, runMigrations, type Db, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson, seedRun } from '../test-support.js';
import { gateListCommand, type GateListCommandDeps } from './gate-list.js';

function globalOptions(json = false): GlobalOptions {
  return { json, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' };
}

describe('gateListCommand', () => {
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

  function deps(io: ReturnType<typeof captureIo>['io'], json = false): GateListCommandDeps {
    return { io, global: globalOptions(json), openDb: () => ({ db, close: () => {} }) };
  }

  it('lists pending human gates across every paused run', async () => {
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'a',
      runId: 'r1',
      state: 'paused',
      gate: { gateId: 'g-a', gateType: 'approval', message: 'A?' },
    });
    await seedRun(db, {
      slug: 'b',
      runId: 'r2',
      state: 'paused',
      gate: { gateId: 'g-b', gateType: 'input', message: 'B?' },
    });
    await seedRun(db, { slug: 'c', runId: 'r3', state: 'completed' }); // not paused → no gate

    expect(gateListCommand({}, deps(io))).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('r1  g-a  approval  node=g');
    expect(text).toContain('r2  g-b  input  node=g');
    expect(text).not.toContain('r3');
  });

  it('scopes to one run when given a runId', async () => {
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'a',
      runId: 'r1',
      state: 'paused',
      gate: { gateId: 'g-a', gateType: 'approval' },
    });
    await seedRun(db, {
      slug: 'b',
      runId: 'r2',
      state: 'paused',
      gate: { gateId: 'g-b', gateType: 'approval' },
    });

    gateListCommand({ runId: 'r1' }, deps(io));
    expect(out()).toContain('g-a');
    expect(out()).not.toContain('g-b');
  });

  it('reports no pending gate for a scoped runId that is not paused (no event-log replay)', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'a', runId: 'done', state: 'completed' });

    expect(gateListCommand({ runId: 'done' }, deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toContain('Run done has no pending human gate.');
  });

  it('excludes a budget gate (that is `relavium budget resume`, not a human gate)', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'a', runId: 'r1', state: 'paused', budgetGateId: 'budget-1' });

    expect(gateListCommand({}, deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toContain('No pending human gates.');
  });

  it('exits 2 for an unknown runId', () => {
    const { io } = captureIo();
    try {
      gateListCommand({ runId: 'nope' }, deps(io));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) {
        expect(err.exitCode).toBe(EXIT_CODES.invalidInvocation);
      }
    }
  });

  it('--json emits one record per pending gate', async () => {
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'a',
      runId: 'r1',
      state: 'paused',
      gate: { gateId: 'g-a', gateType: 'approval', message: 'A?' },
    });

    gateListCommand({}, deps(io, true));
    const rows = parseNdjson(out());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: 'r1',
      gateId: 'g-a',
      gateType: 'approval',
      nodeId: 'g',
      message: 'A?',
    });
  });
});
