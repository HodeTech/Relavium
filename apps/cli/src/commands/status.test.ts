import { createClient, runEvents, runMigrations, type Db, type DbClient } from '@relavium/db';
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

  it('NAMES a run whose terminal is held in the outbox — the exit-5 state (ADR-0078 §4/§5)', async () => {
    // A run in this state is still `running` in the derived projection, so it listed here as an ordinary
    // active run with nothing saying its outcome was already known. Exit 5 tells a script to "re-check
    // `relavium status <runId>` after a subsequent invocation" — and only `run` and `gate` drain the outbox,
    // because only they construct a `WorkflowEngine`. A user who does the natural thing and asks for status
    // again saw the same stale truth forever. This is what makes the documented remedy discoverable.
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'running-1', state: 'running' });
    await statusCommand({
      ...deps(io),
      readTerminalOutbox: () =>
        Promise.resolve([
          {
            type: 'run:completed',
            runId: 'running-1',
            sequenceNumber: 9,
            timestamp: '2026-01-01T00:00:00.000Z',
            outputs: {},
            totalTokensUsed: { input: 1, output: 1 },
            totalCostMicrocents: 1,
            durationMs: 1,
          },
        ]),
    });
    expect(out()).toContain('this run has FINISHED');
    expect(out()).toContain('relavium run');
  });

  it('is UNAFFECTED when the outbox cannot be read — a status read must not fail on it', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'running-1', state: 'running' });
    const code = await statusCommand({
      ...deps(io),
      readTerminalOutbox: () => Promise.reject(new Error('outbox unreadable')),
    });
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).not.toContain('this run has FINISHED');
  });

  it('reports "No active runs." when history holds only terminal runs', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'done', state: 'completed' });

    expect(await statusCommand(deps(io))).toBe(EXIT_CODES.success);
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

    await statusCommand(deps(io));
    const text = out();
    expect(text).toContain('run paused-1 — paused');
    expect(text).toContain('n1 [transform]'); // the completed node step
    expect(text).toContain('g [human_in_the_loop]'); // the gate node still 'running'
    expect(text).toContain('pending gate gate-1 (approval) at g — "ship it?"'); // the gate message is shown
    expect(text).not.toContain('run done'); // a terminal run is not active
  });

  it('keeps listing every HEALTHY run when one run`s event log is damaged (ADR-0074 §5 blast radius)', async () => {
    // Before `readPerRunOrDegrade`, one unreadable row in ONE run threw straight out of this `.map` and the whole
    // command printed nothing — nineteen healthy runs taken away by the twentieth, with no CLI command able to
    // repair or delete the bad one. The damaged run is already lost (its log cannot be read, so it cannot be
    // resumed either); the listing is exactly where a user goes to find out WHICH run is broken.
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'demo',
      runId: 'paused-1',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
    });
    await seedRun(db, { slug: 'demo', runId: 'broken', state: 'paused' });
    // A `type` this binary DOES know with a body that cannot be one — corruption, not a forward-written row.
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000dd',
        runId: 'broken',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();

    expect(await statusCommand(deps(io))).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('run paused-1 — paused');
    expect(text).toContain('pending gate gate-1 (approval)'); // the healthy run keeps its full detail
    expect(text).toContain('run broken — paused'); // the damaged run is still LISTED, just without gate detail
    // …and it SAYS the detail is missing (#W15-15). Degrading silently made a damaged run render identically
    // to a paused run with nothing pending — "no data" standing in for "could not read".
    expect(text).toContain('pending gates unavailable');
  });

  it('marks the damaged run in --json too, without changing a healthy record (#W15-15)', async () => {
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'demo',
      runId: 'paused-1',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
    });
    await seedRun(db, { slug: 'demo', runId: 'broken', state: 'paused' });
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000de',
        runId: 'broken',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();

    expect(await statusCommand(deps(io, true))).toBe(EXIT_CODES.success);
    const records = parseNdjson(out());
    const broken = records.find((r) => r['runId'] === 'broken');
    const healthy = records.find((r) => r['runId'] === 'paused-1');
    expect(broken?.['gatesUnavailable']).toBe(true);
    expect(broken?.['gatesUnavailableReason']).toBe('corrupt_event_log');
    // Absent, not `false`, on the healthy path — an existing consumer's records are byte-identical.
    expect(healthy).not.toHaveProperty('gatesUnavailable');
  });

  it('lists a running run with its steps and no pending gate', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'run-x', state: 'running' });

    await statusCommand(deps(io));
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
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
    });

    await statusCommand(deps(io, true));
    const records = parseNdjson<{
      runId: string;
      status: string;
      steps: { nodeId: string }[];
      pendingGates: { gateId: string; message: string }[];
    }>(out());
    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe('paused-1');
    expect(records[0]?.status).toBe('paused');
    expect(records[0]?.pendingGates[0]?.gateId).toBe('gate-1');
    // Pin `message` in the NDJSON contract (a future drop of PendingGate.message would fail here).
    expect(records[0]?.pendingGates[0]?.message).toBe('ship it?');
    expect(records[0]?.steps.some((s) => s.nodeId === 'n1')).toBe(true);
  });
});
