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

  it('shows one run by id, finished or active, and refuses an unknown id (MVP-1)', async () => {
    await seedRun(db, { slug: 'done', runId: 'done-1', state: 'completed' });
    await seedRun(db, { slug: 'live', runId: 'live-1', state: 'running' });
    const noOutbox = { readTerminalOutbox: () => Promise.resolve([]) };
    const finished = captureIo();
    expect(await statusCommand({ ...deps(finished.io), ...noOutbox }, { runId: 'done-1' })).toBe(
      EXIT_CODES.success,
    );
    expect(finished.out()).toContain('run done-1 — completed');
    expect(finished.out()).not.toContain('live-1');
    const active = captureIo();
    await statusCommand({ ...deps(active.io, true), ...noOutbox }, { runId: 'live-1' });
    const records = parseNdjson(active.out());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ runId: 'live-1', status: 'running' });
    // Without an id the listing is unchanged: active runs only.
    const listing = captureIo();
    await statusCommand({ ...deps(listing.io), ...noOutbox });
    expect(listing.out()).toContain('run live-1 — running');
    expect(listing.out()).not.toContain('done-1');
    await expect(
      statusCommand({ ...deps(captureIo().io), ...noOutbox }, { runId: 'missing' }),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
  });

  it('shows nothing pending for a run that ended while a gate waited, and marks its open step stopped (MVP-1)', async () => {
    // Esc at an inline gate prompt cancels the run without resolving the gate, so its log still holds the open
    // human and budget gates and the gate node's open step row. `gate` and `budget resume` answer a finished run
    // with an exit-0 `nothing to resume`.
    await seedRun(db, {
      slug: 'demo',
      runId: 'cancelled-1',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
      budgetGateId: 'budget-1',
      cancelAfterPause: true,
    });
    const noOutbox = { readTerminalOutbox: () => Promise.resolve([]) };
    const human = captureIo();
    await statusCommand({ ...deps(human.io), ...noOutbox }, { runId: 'cancelled-1' });
    const text = human.out();
    expect(text).toContain('run cancelled-1 — cancelled');
    expect(text).toContain('stopped   g [human_in_the_loop]');
    expect(text).not.toContain('pending');
    expect(text).not.toContain('budget resume');
    const machine = captureIo();
    await statusCommand({ ...deps(machine.io, true), ...noOutbox }, { runId: 'cancelled-1' });
    const [record] = parseNdjson<{ steps: readonly { nodeId: string; status: string }[] }>(
      machine.out(),
    );
    expect(record).toMatchObject({
      status: 'cancelled',
      pendingGates: [],
      pendingBudgetGates: [],
    });
    // `stopped` is the human rendering only; the machine record keeps the status history.db recorded.
    expect(record?.steps.find((step) => step.nodeId === 'g')?.status).toBe('running');
  });

  it('shows a decided gate as completed, though no node:completed closes its step row (MVP-1)', async () => {
    // `relavium gate --approve` resolves the gate and the run completes, but the projection leaves the gate node's
    // step row `running`. The engine marks the vertex completed, so `status` does too.
    await seedRun(db, {
      slug: 'demo',
      runId: 'decided-1',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
      decideAfterPause: true,
    });
    const noOutbox = { readTerminalOutbox: () => Promise.resolve([]) };
    const human = captureIo();
    await statusCommand({ ...deps(human.io), ...noOutbox }, { runId: 'decided-1' });
    const text = human.out();
    expect(text).toContain('run decided-1 — completed');
    expect(text).toContain('  completed g [human_in_the_loop]\n');
    expect(text).not.toContain('stopped');
    const machine = captureIo();
    await statusCommand({ ...deps(machine.io, true), ...noOutbox }, { runId: 'decided-1' });
    const [record] = parseNdjson<{ steps: readonly { nodeId: string; status: string }[] }>(
      machine.out(),
    );
    // The machine record keeps the status history.db recorded.
    expect(record?.steps.find((step) => step.nodeId === 'g')?.status).toBe('running');
  });

  it('raises no gate warning for a finished run whose log is damaged: nothing was pending to lose (MVP-1)', async () => {
    await seedRun(db, {
      slug: 'demo',
      runId: 'decided-3',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
      decideAfterPause: true,
    });
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000de',
        runId: 'decided-3',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
    const noOutbox = { readTerminalOutbox: () => Promise.resolve([]) };
    const human = captureIo();
    await statusCommand({ ...deps(human.io), ...noOutbox }, { runId: 'decided-3' });
    expect(human.out()).toContain('usage coverage unavailable');
    expect(human.out()).not.toContain('pending gates unavailable');
    const machine = captureIo();
    await statusCommand({ ...deps(machine.io, true), ...noOutbox }, { runId: 'decided-3' });
    expect(parseNdjson(machine.out())[0]).not.toHaveProperty('gatesUnavailable');
  });

  it('relabels only a gate node: another open step under a finished run stays stopped (MVP-1)', async () => {
    // A budget gate's decision names its agent node, which can still be open when the run ends.
    await seedRun(db, {
      slug: 'demo',
      runId: 'decided-2',
      state: 'paused',
      gate: { gateId: 'gate-1', gateType: 'approval', message: 'ship it?' },
      decideAfterPause: true,
    });
    client.sqlite
      .prepare("UPDATE step_executions SET node_type = 'agent' WHERE run_id = 'decided-2'")
      .run();
    const { io, out } = captureIo();
    await statusCommand(
      { ...deps(io), readTerminalOutbox: () => Promise.resolve([]) },
      { runId: 'decided-2' },
    );
    expect(out()).toContain('  stopped   g [agent]\n');
  });

  it('says no node ran for a finished run with no step, rather than that none was recorded yet (MVP-1)', async () => {
    await seedRun(db, { slug: 'demo', runId: 'empty-1', state: 'failed' });
    client.sqlite.prepare("DELETE FROM step_executions WHERE run_id = 'empty-1'").run();
    const { io, out } = captureIo();
    await statusCommand(
      { ...deps(io), readTerminalOutbox: () => Promise.resolve([]) },
      { runId: 'empty-1' },
    );
    expect(out()).toContain('  (no node ran)');
  });

  it('prints every history identifier on one line, terminal controls stripped (MVP-1)', async () => {
    // history.db is the trust boundary: a hand-edited or crafted file must not repaint the terminal through
    // `status`. The run id, the workflow, a step's node id and type, and a pending gate's id and node all come
    // from it.
    const attack = '\u001b]0;PWNED\u0007\u202e';
    await seedRun(db, {
      slug: `wf${attack}`,
      runId: `r${attack}`,
      state: 'paused',
      gate: {
        gateId: `gate${attack}`,
        gateType: 'approval',
        message: 'ship it?',
        nodeId: `x${attack}`,
      },
    });
    client.sqlite
      .prepare('UPDATE step_executions SET node_id = ?, node_type = ?')
      .run(`n${attack}`, `t${attack}`);
    // The workflow id the header names is the row's foreign key, so only a crafted file carries a hostile one.
    client.sqlite.pragma('foreign_keys = OFF');
    client.sqlite.prepare('UPDATE runs SET workflow_id = ?').run(`w${attack}`);
    client.sqlite.pragma('foreign_keys = ON');
    const { io, out } = captureIo();
    await statusCommand(
      { ...deps(io), readTerminalOutbox: () => Promise.resolve([]) },
      { runId: `r${attack}` },
    );
    const text = out();
    expect(text).toMatch(/^run r.* — paused \(workflow w/u);
    expect(text).toMatch(/pending gate gate.* \(approval\) at x/u);
    expect(text).toMatch(/\[t[^\]]*\]/u); // the step row printed, with its type
    // A recorded identifier that is not shell-inert never becomes a copyable command.
    expect(text).toContain(
      '    Use relavium gate with the recorded run and gate IDs and --approve or --reject.\n',
    );
    expect(text).not.toContain('relavium gate r');
    for (const control of ['\u001b', '\u0007', '\u202e']) expect(text).not.toContain(control);
  });

  it('keeps healthy status beside a future event and explicitly marks unavailable usage in human and JSON output', async () => {
    await seedRun(db, { slug: 'healthy', runId: 'healthy', state: 'running' });
    await seedRun(db, { slug: 'future', runId: 'future', state: 'running' });
    client.db
      .insert(runEvents)
      .values({
        id: 'future-usage',
        runId: 'future',
        seq: 900,
        eventType: 'future:usage',
        payloadJson: JSON.stringify({
          type: 'future:usage',
          runId: 'future',
          sequenceNumber: 900,
          timestamp: '2026-10-10T00:00:00.000Z',
        }),
        ts: 1,
      })
      .run();
    const human = captureIo();
    expect(
      await statusCommand({ ...deps(human.io), readTerminalOutbox: () => Promise.resolve([]) }),
    ).toBe(EXIT_CODES.success);
    expect(human.out()).toContain('run healthy — running');
    expect(human.out()).toContain('run future — running');
    expect(human.out()).toContain('usage coverage unavailable');
    const machine = captureIo();
    expect(
      await statusCommand({
        ...deps(machine.io, true),
        readTerminalOutbox: () => Promise.resolve([]),
      }),
    ).toBe(EXIT_CODES.success);
    const records = parseNdjson(machine.out());
    expect(records.find((row) => row['runId'] === 'future')).toMatchObject({
      usageUnavailable: true,
      usageUnavailableReason: 'unreadable_event_log',
      usageCoverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
      steps: [
        expect.objectContaining({
          nodeId: 'n1',
          status: 'completed',
          usageCoverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
        }),
      ],
    });
    expect(records.find((row) => row['runId'] === 'healthy')).not.toHaveProperty(
      'usageUnavailable',
    );
  });

  it('NAMES a run whose terminal is held in the outbox — the exit-5 state (ADR-0078 §4/§5)', async () => {
    // A run in this state is still `running` in the derived projection, so it listed here as an ordinary
    // active run with nothing saying its outcome was already known. Exit 5 tells a script to read
    // `relavium status <runId>` — and status itself never drains the outbox. A user who does the natural thing
    // and asks for status again saw the same stale truth. This is what makes the documented remedy discoverable.
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

  it.each([false, true])(
    'does not call a run already recorded failed "held" — the reconcile race leaves a stale entry (json=%s)',
    async (json) => {
      // Exit 5's race: the reconciler's run:failed is durable and the run's own refused terminal is in the
      // outbox too. The next drain DROPS that entry; "finished, not durable yet" would send a script waiting.
      const { io, out } = captureIo();
      await seedRun(db, { slug: 'raced', runId: 'raced-1', state: 'failed' });
      await statusCommand(
        {
          ...deps(io, json),
          readTerminalOutbox: () =>
            Promise.resolve([
              {
                type: 'run:completed',
                runId: 'raced-1',
                sequenceNumber: 9,
                timestamp: '2026-01-01T00:00:00.000Z',
                outputs: {},
                totalTokensUsed: { input: 1, output: 1 },
                totalCostMicrocents: 1,
                durationMs: 1,
              },
            ]),
        },
        { runId: 'raced-1' },
      );
      if (json) expect(out()).toContain('"terminalHeld":false');
      else expect(out()).not.toContain('FINISHED');
    },
  );

  it.each([false, true])(
    'warns without failing or leaking an unreadable outbox (json=%s)',
    async (json) => {
      const { io, out, err } = captureIo();
      await seedRun(db, { slug: 'demo', runId: 'running-1', state: 'running' });
      const code = await statusCommand({
        ...deps(io, json),
        readTerminalOutbox: () =>
          Promise.reject(new Error('/private/outbox\x1b[31m sensitive-payload')),
      });
      expect(code).toBe(EXIT_CODES.success);
      expect(out()).not.toContain('this run has FINISHED');
      expect(err()).toBe(
        'Warning: terminal outbox unavailable; held terminal status could not be verified.\n',
      );
      expect(out() + err()).not.toMatch(/private|sensitive-payload/);
      expect(out() + err()).not.toContain('\x1b');
      if (json) expect(parseNdjson(out())).toMatchObject([{ runId: 'running-1' }]);
      else expect(out()).toContain('run running-1');
    },
  );

  it.each([false, true])(
    'closes the history reader and preserves a failing outbox warning sink (json=%s)',
    async (json) => {
      const { io } = captureIo();
      const sinkFailure = new Error('diagnostic sink unavailable');
      let closes = 0;
      await expect(
        statusCommand({
          ...deps(io, json),
          io: {
            ...io,
            writeErr: () => {
              throw sinkFailure;
            },
          },
          openDb: () => ({
            db,
            close: () => {
              closes += 1;
              client.sqlite.close();
            },
          }),
          readTerminalOutbox: () => Promise.reject(new Error('outbox unavailable')),
        }),
      ).rejects.toBe(sinkFailure);
      expect(closes).toBe(1);
      expect(client.sqlite.open).toBe(false);
    },
  );

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
    expect(text).toContain(
      '  ⏸ pending gate gate-1 (approval) at g — "ship it?"\n' +
        '    approve: relavium gate paused-1 --gate gate-1 --approve\n' +
        '    reject: relavium gate paused-1 --gate gate-1 --reject\n',
    ); // the gate message is shown, then the commands that continue it
    expect(text).not.toContain('run done'); // a terminal run is not active
  });

  it('prints the command that continues each pending human gate, by its type (MVP-1)', async () => {
    // A resumed run's final summary cannot classify a gate its engine restored from the checkpoint and sends the
    // user here for the command, so every pending human gate gets one — an input gate takes its value or a reject.
    await seedRun(db, {
      slug: 'demo',
      runId: 'fan-1',
      state: 'paused',
      gates: [
        { gateId: 'review-1', gateType: 'review', message: 'look' },
        { gateId: 'input-1', gateType: 'input', message: 'name?' },
      ],
    });
    const { io, out } = captureIo();
    await statusCommand(
      { ...deps(io), readTerminalOutbox: () => Promise.resolve([]) },
      { runId: 'fan-1' },
    );
    const text = out();
    expect(text).toContain(
      '  ⏸ pending gate review-1 (review) at g — "look"\n' +
        '    approve: relavium gate fan-1 --gate review-1 --approve\n' +
        '    reject: relavium gate fan-1 --gate review-1 --reject\n',
    );
    expect(text).toContain(
      '  ⏸ pending gate input-1 (input) at g — "name?"\n' +
        '    input: relavium gate fan-1 --gate input-1 --input <json>\n' +
        '    reject: relavium gate fan-1 --gate input-1 --reject\n',
    );
    expect(text).not.toContain('--gate input-1 --approve');
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
