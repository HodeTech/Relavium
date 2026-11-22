import {
  createClient,
  createRunHistoryStore,
  runEvents,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandLifetime } from '../process/command-lifetime.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, forgeRunStatus, parseNdjson, seedRun } from '../test-support.js';
import {
  FOLLOW_POLL_INTERVAL_MS,
  logsCommand,
  logsFollowCommand,
  type LogsCommandDeps,
} from './logs.js';

function globalOptions(json = false): GlobalOptions {
  return { json, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' };
}

describe('logsCommand', () => {
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

  function deps(io: ReturnType<typeof captureIo>['io'], json = false): LogsCommandDeps {
    return { io, global: globalOptions(json), openDb: () => ({ db, close: () => {} }) };
  }

  it('exits 2 for an unknown runId', () => {
    const { io } = captureIo();
    try {
      logsCommand({ runId: 'nope' }, deps(io));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) {
        expect(err.exitCode).toBe(EXIT_CODES.invalidInvocation);
      }
    }
  });

  it('prints a forged run id on one line in its header', async () => {
    // `logs` looks the run up by the id the user typed, so a stored id with an escape is reached only by typing it.
    const forgedId = 'run\u001b[2J\nforged';
    await seedRun(db, { slug: 'demo', runId: forgedId, state: 'completed' });
    const { io, out } = captureIo();
    logsCommand({ runId: forgedId }, deps(io));
    const header = out().split('\n')[0] ?? '';
    expect(header).toContain('forged');
    expect(header).not.toContain('\u001b');
  });

  it('prints a forged run status on one line in its header', async () => {
    await seedRun(db, { slug: 'demo', runId: 'run-forged', state: 'completed' });
    forgeRunStatus(client, 'run-forged', 'completed\u001b[2J\nforged row');
    const { io, out } = captureIo();
    logsCommand({ runId: 'run-forged' }, deps(io));
    const header = out().split('\n')[0] ?? '';
    expect(header).toContain('forged row');
    expect(header).not.toContain('\u001b');
  });

  it('prints a terse human line per persisted event in seq order', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'completed' });

    expect(logsCommand({ runId: 'run-1' }, deps(io))).toBe(EXIT_CODES.success);
    const text = out();
    expect(text.split('\n')[0]).toContain('run run-1');
    expect(text).toContain('[0] run:started');
    expect(text).toContain('[1] node:started n1');
    expect(text).toContain('[3] run:completed — completed');
  });

  it('renders the gate detail line for a paused run (the human_gate:paused branch)', async () => {
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'demo',
      runId: 'paused-1',
      state: 'paused',
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });

    expect(logsCommand({ runId: 'paused-1' }, deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toContain('human_gate:paused g — gate g1 (approval)');
  });

  it('renders the failure detail line for a failed run (the run:failed branch)', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'failed-1', state: 'failed' });

    expect(logsCommand({ runId: 'failed-1' }, deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toContain('run:failed — internal'); // detailOf surfaces the error code
  });

  it('renders the skip detail line with its reason (the node:skipped branch)', async () => {
    // The persisted-run twin of the plain renderer's `skip` line. Without the reason this row reports
    // that a node did not run and not why — the same gap the live surface had.
    const { io, out } = captureIo();
    await seedRun(db, {
      slug: 'demo',
      runId: 'skipped-1',
      state: 'completed',
      skipped: { nodeId: 'lo', reason: 'branch_not_taken' },
    });

    expect(logsCommand({ runId: 'skipped-1' }, deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toContain('node:skipped lo — branch_not_taken');
  });

  it('reports rows written by a NEWER binary on stderr, keeping stdout`s contract intact (ADR-0074 §5)', async () => {
    // A dropped row (§5) makes the count below and the `[seq]` column describe a log that is short and has a hole
    // in its sequence — which `sse-event-schema.md` §Transport tells consumers to read as data loss. So it is
    // announced. On STDERR in both modes, because `--json`'s stdout is contractually a pure `RunEvent` stream.
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'completed' });
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000ff',
        runId: 'run-1',
        seq: 99,
        eventType: 'test:never_a_real_event',
        payloadJson: JSON.stringify({ type: 'test:never_a_real_event' }),
        ts: 0,
      })
      .run();

    const human = captureIo();
    expect(logsCommand({ runId: 'run-1' }, deps(human.io))).toBe(EXIT_CODES.success);
    expect(human.err()).toContain(
      '1 event written by a newer version of Relavium was skipped (seq 99)',
    );
    expect(human.out()).not.toContain('newer version'); // the note never pollutes the log body

    const json = captureIo();
    expect(logsCommand({ runId: 'run-1' }, deps(json.io, true))).toBe(EXIT_CODES.success);
    expect(json.err()).toContain('seq 99');
    // Every stdout line still parses as a RunEvent — the note did not become an NDJSON record.
    for (const record of parseNdjson(json.out())) {
      expect(record).toHaveProperty('type');
      expect(record).not.toHaveProperty('skipped');
    }
  });

  it('prints a forged skipped-row seq on one line, without its controls', async () => {
    // `run_events.seq` is an integer column with no CHECK, so SQLite stores text there as it is given.
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'completed' });
    client.sqlite
      .prepare(
        'INSERT INTO run_events (id, run_id, seq, event_type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        '00000000-0000-4000-8000-0000000000fe',
        'run-1',
        '9\u001b]0;PWNED\u0007\u001b[2J\nFAKE: all clear',
        'test:never_a_real_event',
        JSON.stringify({ type: 'test:never_a_real_event' }),
        0,
      );
    const { io, err } = captureIo();
    expect(logsCommand({ runId: 'run-1' }, deps(io))).toBe(EXIT_CODES.success);
    expect(err()).toContain('was skipped (seq 9');
    expect(err()).not.toContain('\u001b');
    expect(err()).not.toContain('\u0007');
    expect(err().trimEnd().split('\n')).toHaveLength(1);
  });

  it('pins the plain output of a fixture run byte for byte, human and --json (the flags are additive)', async () => {
    await seedRun(db, {
      slug: 'demo',
      runId: 'pin-1',
      state: 'completed',
      outputs: { answer: 'done' },
    });
    const human = captureIo();
    expect(logsCommand({ runId: 'pin-1' }, deps(human.io))).toBe(EXIT_CODES.success);
    expect(human.out()).toBe(
      [
        'run pin-1 — completed (4 events)',
        '[0] run:started',
        '[1] node:started n1',
        '[2] node:completed n1',
        '[3] run:completed — completed',
        '    outputs:',
        '      answer: done',
        '',
      ].join('\n'),
    );
    expect(human.err()).toBe('');
    const json = captureIo();
    expect(logsCommand({ runId: 'pin-1' }, deps(json.io, true))).toBe(EXIT_CODES.success);
    // The one random byte run is the workflow's uuid; everything else in each line is fixed by the fixture.
    expect(json.out().replace(/"workflowId":"[0-9a-f-]{36}"/u, '"workflowId":"<uuid>"')).toBe(
      [
        '{"type":"run:started","runId":"pin-1","timestamp":"2025-06-15T15:06:40.000Z","sequenceNumber":0,"workflowId":"<uuid>","inputs":{},"executionMode":"local"}',
        '{"type":"node:started","runId":"pin-1","timestamp":"2025-06-15T15:06:40.000Z","sequenceNumber":1,"nodeId":"n1","nodeType":"transform"}',
        '{"type":"node:completed","runId":"pin-1","cumulativeCostMicrocents":100,"timestamp":"2025-06-15T15:06:40.000Z","sequenceNumber":2,"nodeId":"n1","output":{},"tokensUsed":{"input":1,"output":2},"durationMs":5}',
        '{"type":"run:completed","runId":"pin-1","timestamp":"2025-06-15T15:06:40.000Z","sequenceNumber":3,"outputs":{"answer":"done"},"totalTokensUsed":{"input":1,"output":2},"totalCostMicrocents":100,"durationMs":9}',
        '',
      ].join('\n'),
    );
    expect(json.err()).toBe('');
  });

  it('says nothing when the log is clean — no note on the happy path', async () => {
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'completed' });
    const { io, err } = captureIo();
    expect(logsCommand({ runId: 'run-1' }, deps(io))).toBe(EXIT_CODES.success);
    expect(err()).toBe('');
  });

  it('--json emits each raw RunEvent as one NDJSON line in seq order', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'completed' });

    expect(logsCommand({ runId: 'run-1' }, deps(io, true))).toBe(EXIT_CODES.success);
    const events = parseNdjson<{ type: string; runId: string; sequenceNumber: number }>(out());
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3]);
    expect(events[0]?.type).toBe('run:started');
    expect(events.every((e) => e.runId === 'run-1')).toBe(true);
  });

  it('preserves historical field absence and all coverage evidence without enriching raw logs', async () => {
    await seedRun(db, { slug: 'raw-accounting', runId: 'raw-accounting', state: 'running' });
    let id = 0;
    const store = createRunHistoryStore(db, {
      uuid: () => `raw-event-${++id}`,
      now: () => 0,
      workflow: { slug: 'raw-accounting', name: 'raw-accounting', definitionJson: '{}' },
    });
    const invocation = {
      producerId: 'producer',
      ordinal: 1,
      dispatchId: 'turn',
      round: 0,
      chainAttempt: 1,
    };
    const bodies = [
      {
        type: 'cost:updated',
        nodeId: 'n1',
        model: 'offline',
        inputTokens: 4,
        outputTokens: 2,
        costMicrocents: 123456,
        cumulativeCostMicrocents: 123456,
      },
      { type: 'cost:coverage_started', basis: 'legacy_unverified' },
      { type: 'cost:usage_pending', nodeId: 'n1', model: 'offline', invocation },
      {
        type: 'cost:usage_disposition',
        nodeId: 'n1',
        model: 'offline',
        invocation,
        disposition: {
          kind: 'incomplete',
          evidence: { kind: 'partial', known: { outputTokens: 2 }, reason: 'missing_fields' },
        },
        receiptPending: true,
      },
      {
        type: 'budget:estimate_committed',
        nodeId: 'n1',
        model: 'offline',
        estimateMicrocents: 9876,
        cumulativeConservativeMicrocents: 9876,
      },
      {
        type: 'run:completed',
        outputs: {},
        totalTokensUsed: { input: 4, output: 2 },
        totalCostMicrocents: 123456,
        durationMs: 3,
      },
    ];
    const expected: RunEvent[] = [];
    for (const [index, body] of bodies.entries()) {
      const event = RunEventSchema.parse({
        ...body,
        runId: 'raw-accounting',
        timestamp: '2026-10-11T00:00:00.000Z',
        sequenceNumber: index + 3,
      });
      await store.persistEvent(event);
      expected.push(event);
    }
    db.insert(runEvents)
      .values({
        id: 'future-accounting',
        runId: 'raw-accounting',
        seq: 99,
        eventType: 'cost:future',
        payloadJson: JSON.stringify({ type: 'cost:future' }),
        ts: 0,
      })
      .run();
    const json = captureIo();
    expect(logsCommand({ runId: 'raw-accounting' }, deps(json.io, true))).toBe(EXIT_CODES.success);
    const emitted = parseNdjson<RunEvent>(json.out()).slice(3);
    expect(emitted).toEqual(expected);
    for (const event of emitted.filter(
      (event) => event.type === 'cost:updated' || event.type === 'run:completed',
    )) {
      for (const key of ['usageCoverage', 'cumulativeUnpricedCalls', 'invocation'])
        expect(Object.hasOwn(event, key)).toBe(false);
    }
    expect(
      emitted.filter((event) =>
        ['cost:coverage_started', 'cost:usage_pending', 'cost:usage_disposition'].includes(
          event.type,
        ),
      ),
    ).toHaveLength(3);
    expect(json.err()).toContain(
      '1 event written by a newer version of Relavium was skipped (seq 99)',
    );
    expect(json.out()).not.toContain('newer version');
    const human = captureIo();
    expect(logsCommand({ runId: 'raw-accounting' }, deps(human.io))).toBe(EXIT_CODES.success);
    expect(human.out()).toContain('~9876µ¢ estimated, possibly billed (~9876µ¢ total)');
    expect(human.out()).not.toMatch(/123456|\$|free|realized|Session cost/);
    expect(human.err()).toContain('seq 99');
  });
});

/** The newer-binary row the skip note is about: a `type` this binary does not know. */
const FUTURE_NOTE = (seq: number): string =>
  `note: 1 event written by a newer version of Relavium was skipped (seq ${seq}). Upgrade to read it.\n`;

const BOOM = { code: 'internal', message: 'boom', retryable: false } as const;

describe('logs --failed and --follow (ADR-0140 §7)', () => {
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

  function deps(io: CliIo, json = false, extra: Partial<LogsCommandDeps> = {}): LogsCommandDeps {
    return { io, global: globalOptions(json), openDb: () => ({ db, close: () => {} }), ...extra };
  }

  /** An io whose every stdout write is kept apart, so a test can say "one write, one line". */
  function lineIo(): ReturnType<typeof captureIo> & { writes: string[] } {
    const captured = captureIo();
    const writes: string[] = [];
    const io: CliIo = {
      ...captured.io,
      writeOut: (text) => {
        writes.push(text);
        captured.io.writeOut(text);
      },
    };
    return { ...captured, io, writes };
  }

  /** Persist events behind a run `seedRun` made, numbering them from `firstSeq` — what another process does while we follow. */
  function appender(
    runId: string,
    firstSeq: number,
  ): (body: Record<string, unknown>) => Promise<void> {
    let seq = firstSeq;
    let id = 0;
    const store = createRunHistoryStore(db, {
      uuid: () => `${runId}-appended-${++id}`,
      now: () => 0,
      workflow: { slug: 'demo', name: 'demo', definitionJson: '{}' },
    });
    return async (body) => {
      const event = RunEventSchema.parse({
        ...body,
        runId,
        timestamp: '2026-10-11T00:00:00.000Z',
        sequenceNumber: seq++,
      });
      await store.persistEvent(event);
    };
  }

  function insertFutureRow(runId: string, seq: number): void {
    db.insert(runEvents)
      .values({
        id: `future-${runId}-${seq}`,
        runId,
        seq,
        eventType: 'test:never_a_real_event',
        payloadJson: JSON.stringify({ type: 'test:never_a_real_event' }),
        ts: 0,
      })
      .run();
  }

  /**
   * A fake wait: the Nth call runs the Nth step (what another process writes meanwhile). **The script is the poll
   * guard**: a loop that does not stop when it should asks for a wait the script does not have, and fails there
   * instead of hanging — so a mutation of the stop rule or the cursor fails the test, it cannot stall it.
   */
  function scriptedSleep(steps: readonly (() => void | Promise<void>)[]): {
    sleep: NonNullable<LogsCommandDeps['sleep']>;
    waits: number[];
  } {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms) => {
        waits.push(ms);
        const step = steps[waits.length - 1];
        if (step === undefined) {
          throw new Error(
            `poll guard: follow waited ${waits.length} times, the script allowed ${steps.length}`,
          );
        }
        await step();
      },
    };
  }

  /** `node:started n2`, `node:completed n2` — a node that runs to its end. */
  async function runNode(
    append: (body: Record<string, unknown>) => Promise<void>,
    nodeId: string,
  ): Promise<void> {
    await append({ type: 'node:started', nodeId, nodeType: 'transform' });
    await append({
      type: 'node:completed',
      nodeId,
      output: {},
      tokensUsed: { input: 1, output: 2 },
      durationMs: 5,
      cumulativeCostMicrocents: 100,
    });
  }

  const COMPLETED = {
    type: 'run:completed',
    outputs: { answer: 'done' },
    totalTokensUsed: { input: 1, output: 2 },
    totalCostMicrocents: 100,
    durationMs: 9,
  } as const;

  /** A run that ran, retried a node, lost it, skipped one and failed: events 0–7, failures at 4, 5 and 7. */
  async function seedFailedRun(runId: string): Promise<void> {
    await seedRun(db, { slug: 'demo', runId, state: 'running' });
    const append = appender(runId, 3);
    await append({ type: 'node:started', nodeId: 'b', nodeType: 'transform' });
    await append({
      type: 'node:retrying',
      nodeId: 'b',
      attemptNumber: 1,
      error: { code: 'internal', message: 'boom', retryable: true },
      delayMs: 10,
    });
    await append({ type: 'node:failed', nodeId: 'b', error: BOOM });
    await append({ type: 'node:skipped', nodeId: 'c', reason: 'branch_not_taken' });
    await append({ type: 'run:failed', error: BOOM, partialOutputs: {} });
  }

  describe('--failed', () => {
    it('prints the three failure types and the closing event, one terse row each (human)', async () => {
      await seedFailedRun('fail-1');
      const { io, out, err } = captureIo();
      expect(logsCommand({ runId: 'fail-1', failed: true }, deps(io))).toBe(EXIT_CODES.success);
      expect(out()).toBe(
        [
          'run fail-1 — failed (3 of 8 events)',
          '[4] node:retrying b — internal (attempt 1)',
          '[5] node:failed b — internal',
          '[7] run:failed — internal',
          '',
        ].join('\n'),
      );
      expect(err()).toBe('');
    });

    it('under --json emits exactly those events as NDJSON and nothing else on stdout', async () => {
      await seedFailedRun('fail-1');
      const { io, out, err } = captureIo();
      expect(logsCommand({ runId: 'fail-1', failed: true }, deps(io, true))).toBe(
        EXIT_CODES.success,
      );
      const events = parseNdjson<{ type: string; sequenceNumber: number }>(out());
      expect(events.map((event) => [event.sequenceNumber, event.type])).toEqual([
        [4, 'node:retrying'],
        [5, 'node:failed'],
        [7, 'run:failed'],
      ]);
      expect(out().trimEnd().split('\n')).toHaveLength(3);
      expect(err()).toBe('');
    });

    it.each([
      ['completed', 'run:completed — completed'],
      ['cancelled', 'run:cancelled — cancelled'],
    ] as const)(
      'keeps a run that %s to its closing event alone, with no outputs block',
      async (how, row) => {
        await seedRun(db, { slug: 'demo', runId: 'end-1', state: 'running' });
        const append = appender('end-1', 3);
        await (how === 'completed' ? append(COMPLETED) : append({ type: 'run:cancelled' }));
        const { io, out } = captureIo();
        expect(logsCommand({ runId: 'end-1', failed: true }, deps(io))).toBe(EXIT_CODES.success);
        expect(out()).toBe(`run end-1 — ${how} (1 of 4 events)\n[3] ${row}\n`);
      },
    );

    it('prints a header and no rows for a run that is still going and has not failed', async () => {
      await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'running' });
      const { io, out } = captureIo();
      expect(logsCommand({ runId: 'run-1', failed: true }, deps(io))).toBe(EXIT_CODES.success);
      expect(out()).toBe('run run-1 — running (0 of 3 events)\n');
    });
  });

  describe('--follow', () => {
    it('prints the existing log, then each appended event before the next wait, and ends 0 at the terminal', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const plain = captureIo();
      logsCommand({ runId: 'f1' }, deps(plain.io));
      const append = appender('f1', 3);
      const { io, out, err } = captureIo();
      const seen: string[] = [];
      const { sleep, waits } = scriptedSleep([
        async () => {
          seen.push(out());
          await runNode(append, 'n2');
        },
        async () => {
          seen.push(out());
          await append(COMPLETED);
        },
      ]);
      await expect(logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep }))).resolves.toBe(
        EXIT_CODES.success,
      );
      expect(waits).toEqual([FOLLOW_POLL_INTERVAL_MS, FOLLOW_POLL_INTERVAL_MS]);
      expect(FOLLOW_POLL_INTERVAL_MS).toBe(500);
      // The first wait comes after exactly what a plain `logs` prints; the second after the batch that arrived since.
      expect(seen[0]).toBe(plain.out());
      expect(seen[1]).toBe(`${plain.out()}[3] node:started n2\n[4] node:completed n2\n`);
      expect(out()).toBe(
        `${seen[1]}[5] run:completed — completed\n    outputs:\n      answer: done\n`,
      );
      expect(err()).toBe('');
    });

    it('under --json is a pure NDJSON stream, one write per event line, nothing on stderr', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const append = appender('f1', 3);
      const { io, out, err, writes } = lineIo();
      const { sleep } = scriptedSleep([() => runNode(append, 'n2'), () => append(COMPLETED)]);
      await expect(logsFollowCommand({ runId: 'f1' }, deps(io, true, { sleep }))).resolves.toBe(
        EXIT_CODES.success,
      );
      const events = parseNdjson<{ type: string; sequenceNumber: number }>(out());
      expect(events.map((event) => event.sequenceNumber)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(events.at(-1)?.type).toBe('run:completed');
      // Flushed per line: no write holds two lines or half of one.
      expect(writes).toHaveLength(6);
      for (const write of writes) expect(write).toMatch(/^[^\n]+\n$/u);
      expect(err()).toBe('');
    });

    it('ends at once, without a wait, for a run that is already over — and says nothing more than a plain logs', async () => {
      await seedRun(db, { slug: 'demo', runId: 'done-1', state: 'failed' });
      const plain = captureIo();
      logsCommand({ runId: 'done-1' }, deps(plain.io));
      const { io, out } = captureIo();
      const { sleep, waits } = scriptedSleep([]);
      await expect(
        logsFollowCommand({ runId: 'done-1' }, deps(io, false, { sleep })),
      ).resolves.toBe(
        EXIT_CODES.success, // the log is read to its end whatever the run's own outcome was
      );
      expect(waits).toEqual([]);
      expect(out()).toBe(plain.out());
    });

    it.each([
      ['run:completed', COMPLETED],
      ['run:failed', { type: 'run:failed', error: BOOM, partialOutputs: {} }],
      ['run:cancelled', { type: 'run:cancelled' }],
    ] as const)('ends with exit 0 when the run reaches %s', async (type, body) => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const append = appender('f1', 3);
      const { io, out } = captureIo();
      const { sleep, waits } = scriptedSleep([() => append(body)]);
      await expect(logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep }))).resolves.toBe(
        EXIT_CODES.success,
      );
      expect(waits).toHaveLength(1);
      expect(out()).toContain(`[3] ${type}`);
    });

    it('ends at a gate pause and names the run and the answer, on stdout in human mode', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'gate-1',
        state: 'paused',
        gate: { gateId: 'g1', gateType: 'approval' },
      });
      await appender('gate-1', 5)({ type: 'run:paused', pendingGateCount: 1, gateIds: ['g1'] });
      const { io, out, err } = captureIo();
      const { sleep, waits } = scriptedSleep([]);
      await expect(
        logsFollowCommand({ runId: 'gate-1' }, deps(io, false, { sleep })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toEqual([]);
      const lines = out().trimEnd().split('\n');
      expect(lines.at(-1)).toBe(
        'run gate-1 is paused at a gate — approve: relavium gate gate-1 --gate g1 --approve; reject: relavium gate gate-1 --gate g1 --reject',
      );
      expect(lines.at(-2)).toBe('[5] run:paused');
      expect(err()).toBe('');
    });

    it('ends at a gate pause under --json with the notice on stderr, so stdout stays pure NDJSON', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'gate-1',
        state: 'paused',
        gate: { gateId: 'g1', gateType: 'approval' },
      });
      await appender('gate-1', 5)({ type: 'run:paused', pendingGateCount: 1, gateIds: ['g1'] });
      const { io, out, err } = captureIo();
      const { sleep } = scriptedSleep([]);
      await expect(logsFollowCommand({ runId: 'gate-1' }, deps(io, true, { sleep }))).resolves.toBe(
        EXIT_CODES.success,
      );
      expect(parseNdjson<{ sequenceNumber: number }>(out()).map((e) => e.sequenceNumber)).toEqual([
        0, 1, 2, 3, 4, 5,
      ]);
      expect(out()).not.toContain('paused at a gate');
      expect(err()).toBe(
        'run gate-1 is paused at a gate — approve: relavium gate gate-1 --gate g1 --approve; reject: relavium gate gate-1 --gate g1 --reject\n',
      );
    });

    it('ends at a budget gate pause with the budget form of the answer', async () => {
      await seedRun(db, { slug: 'demo', runId: 'bud-1', state: 'paused', budgetGateId: 'b1' });
      await appender('bud-1', 5)({ type: 'run:paused', pendingGateCount: 1, gateIds: ['b1'] });
      const { io, out } = captureIo();
      const { sleep, waits } = scriptedSleep([]);
      await expect(logsFollowCommand({ runId: 'bud-1' }, deps(io, false, { sleep }))).resolves.toBe(
        EXIT_CODES.success,
      );
      expect(waits).toEqual([]);
      expect(out().trimEnd().split('\n').at(-1)).toMatch(
        /^run bud-1 is paused at a gate — .*relavium budget resume bud-1 --gate b1 /u,
      );
    });

    it('keeps following a run whose gate was answered after it parked, and a run parked on a media job alone', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'gate-1',
        state: 'paused',
        gate: { gateId: 'g1', gateType: 'approval' },
      });
      const append = appender('gate-1', 5);
      await append({ type: 'run:paused', pendingGateCount: 1, gateIds: ['g1'] });
      await append({
        type: 'human_gate:resumed',
        nodeId: 'g',
        decision: 'approved',
        decidedBy: 'cli',
      });
      const answered = captureIo();
      const first = scriptedSleep([() => append(COMPLETED)]);
      await logsFollowCommand(
        { runId: 'gate-1' },
        deps(answered.io, false, { sleep: first.sleep }),
      );
      expect(first.waits).toHaveLength(1);
      expect(answered.out()).not.toContain('paused at a gate');

      await seedRun(db, { slug: 'demo', runId: 'media-1', state: 'paused' }); // parks on a media job: no gate to answer
      const media = captureIo();
      const second = scriptedSleep([() => appender('media-1', 6)({ type: 'run:cancelled' })]);
      await logsFollowCommand({ runId: 'media-1' }, deps(media.io, false, { sleep: second.sleep }));
      expect(second.waits).toHaveLength(1);
      expect(media.out()).not.toContain('paused at a gate');
    });

    it('keeps following a run whose budget gate was decided after it parked', async () => {
      await seedRun(db, { slug: 'demo', runId: 'bud-1', state: 'paused', budgetGateId: 'b1' });
      const append = appender('bud-1', 5);
      await append({ type: 'run:paused', pendingGateCount: 1, gateIds: ['b1'] });
      await append({
        type: 'budget:authorization',
        nodeId: 'g',
        gateId: 'b1',
        authorization: {
          state: 'decided',
          allowance: { kind: 'legacy_no_allowance' },
          decision: 'approved',
          decidedBy: 'cli',
        },
      });
      const { io, out } = captureIo();
      const { sleep, waits } = scriptedSleep([() => append(COMPLETED)]);
      await logsFollowCommand({ runId: 'bud-1' }, deps(io, false, { sleep }));
      expect(waits).toHaveLength(1);
      expect(out()).not.toContain('paused at a gate');
    });

    it('moves its cursor over rows a newer binary wrote: each is reported once, and the wait is never re-read', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      insertFutureRow('f1', 3); // the log's tail is unreadable to this binary
      const append = appender('f1', 5);
      const { io, out, err } = captureIo();
      const { sleep, waits } = scriptedSleep([
        () => undefined, // nothing new: a cursor parked on the last event would re-read seq 3 here
        () => insertFutureRow('f1', 4), // and a row that arrives while following
        () => append(COMPLETED),
      ]);
      await expect(logsFollowCommand({ runId: 'f1' }, deps(io, true, { sleep }))).resolves.toBe(
        EXIT_CODES.success,
      );
      expect(waits).toHaveLength(3);
      expect(err()).toBe(`${FUTURE_NOTE(3)}${FUTURE_NOTE(4)}`);
      // stdout is still only RunEvents, newest last.
      expect(parseNdjson<{ sequenceNumber: number }>(out()).map((e) => e.sequenceNumber)).toEqual([
        0, 1, 2, 5,
      ]);
    });

    it('reads a log longer than one tail page whole before it follows', async () => {
      await seedRun(db, { slug: 'demo', runId: 'long-1', state: 'running' });
      const append = appender('long-1', 3);
      const nodes = 1_100;
      for (let index = 0; index < nodes; index++) {
        await append({ type: 'node:started', nodeId: `n${index}`, nodeType: 'transform' });
      }
      await append(COMPLETED);
      const { io, out } = captureIo();
      const { sleep, waits } = scriptedSleep([]);
      await logsFollowCommand({ runId: 'long-1' }, deps(io, false, { sleep }));
      expect(waits).toEqual([]);
      const lines = out().split('\n');
      expect(lines[0]).toBe(`run long-1 — completed (${3 + nodes + 1} events)`);
      expect(lines).toContain(`[${3 + nodes - 1}] node:started n${nodes - 1}`);
      expect(lines).toContain(`[${3 + nodes}] run:completed — completed`);
    });

    it('exits 2 for an unknown run id, as a plain logs does', async () => {
      const { io } = captureIo();
      const failure: unknown = await logsFollowCommand({ runId: 'nope' }, deps(io)).catch(
        (cause: unknown) => cause,
      );
      expect(isCliError(failure) && failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
    });

    it('leaves the wait to the command lifetime: the wait is told its signal, and a stopped owner is not polled again', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const fixture = invocationFixture();
      const captured = captureIo();
      const lifetime = new CommandLifetime(fixture.invocation, captured.io, () => () => undefined);
      const waits: (AbortSignal | undefined)[] = [];
      const sleep: NonNullable<LogsCommandDeps['sleep']> = (_ms, signal) => {
        waits.push(signal instanceof AbortSignal ? signal : undefined);
        // A signal arrives during the wait (the lifetime's stop is what the process's signal handler calls).
        lifetime.work.stop();
        if (waits.length > 1)
          return Promise.reject(new Error('poll guard: waited again after the stop'));
        return Promise.resolve();
      };
      const exit = await lifetime.execute(() =>
        logsFollowCommand(
          { runId: 'f1' },
          deps(lifetime.io, false, { sleep, commandLifetime: lifetime }),
        ),
      );
      // The stopped owner ends the loop quietly; the signal's own exit code is the process layer's, not this command's.
      expect(exit).toBe(EXIT_CODES.success);
      expect(waits).toEqual([lifetime.work.signal]);
      expect(lifetime.work.signal.aborted).toBe(true);
      expect(captured.out().trimEnd().split('\n')).toHaveLength(4); // the header and the three events, nothing after
    });
  });

  describe('--follow --failed', () => {
    it('prints only failure events as they arrive and ends on the same stop rule', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const append = appender('f1', 3);
      const { io, out } = captureIo();
      const { sleep, waits } = scriptedSleep([
        async () => {
          await runNode(append, 'n2'); // not a failure: not printed
          await append({ type: 'node:started', nodeId: 'b', nodeType: 'transform' });
          await append({
            type: 'node:retrying',
            nodeId: 'b',
            attemptNumber: 1,
            error: { code: 'internal', message: 'boom', retryable: true },
            delayMs: 10,
          });
        },
        async () => {
          await append({ type: 'node:failed', nodeId: 'b', error: BOOM });
          await append({ type: 'run:failed', error: BOOM, partialOutputs: {} });
        },
      ]);
      await expect(
        logsFollowCommand({ runId: 'f1', failed: true }, deps(io, false, { sleep })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toHaveLength(2);
      expect(out()).toBe(
        [
          'run f1 — running (0 of 3 events)',
          '[6] node:retrying b — internal (attempt 1)',
          '[7] node:failed b — internal',
          '[8] run:failed — internal',
          '',
        ].join('\n'),
      );
    });

    it('under --json prints those events as NDJSON, and a gate notice still goes to stderr', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'gate-1',
        state: 'paused',
        gate: { gateId: 'g1', gateType: 'approval' },
      });
      const append = appender('gate-1', 5);
      await append({ type: 'run:paused', pendingGateCount: 1, gateIds: ['g1'] });
      const { io, out, err } = captureIo();
      const { sleep } = scriptedSleep([]);
      await logsFollowCommand({ runId: 'gate-1', failed: true }, deps(io, true, { sleep }));
      expect(out()).toBe(''); // a parked run has no failure and no closing event yet
      expect(err()).toContain('run gate-1 is paused at a gate');
    });
  });
});
