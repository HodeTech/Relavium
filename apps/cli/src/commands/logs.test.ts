import {
  createClient,
  createRunHistoryStore,
  runEvents,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import {
  RUN_LEASE_TTL_MS,
  RunEventSchema,
  isCorruptRunEventError,
  type RunEvent,
} from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandLifetime } from '../process/command-lifetime.js';
import { isCliError, toUserFacing } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, forgeRunStatus, parseNdjson, seedRun } from '../test-support.js';
import {
  FOLLOW_LIVENESS_INTERVAL_MS,
  FOLLOW_POLL_INTERVAL_MS,
  FOLLOW_RESUME_GRACE_MS,
  logsCommand,
  logsFollowCommand,
  readHistory,
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

  /** An injected clock the script moves: no real time passes, so a liveness rule is a function of what the script did. */
  function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
    let current = startMs;
    return {
      now: () => current,
      advance: (ms) => {
        current += ms;
      },
    };
  }

  const T0 = 1_750_000_000_000;

  /** The lease row another process holds (or held) on a run: `expiresAt` is what a liveness verdict reads. */
  function setLease(runId: string, expiresAt: number): void {
    client.sqlite.prepare('DELETE FROM run_leases WHERE run_id = ?').run(runId);
    client.sqlite
      .prepare(
        'INSERT INTO run_leases (run_id, owner_id, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(runId, 'owner-1', 1, expiresAt, T0, T0);
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
        expect(out()).toBe(
          `run end-1 — ${how} (1 of 4 events)\nno failure events in this run.\n[3] ${row}\n`,
        );
      },
    );

    it('under --json says nothing extra for a run that closed without a failure: the closing event is the answer', async () => {
      await seedRun(db, { slug: 'demo', runId: 'end-1', state: 'running' });
      await appender('end-1', 3)(COMPLETED);
      const { io, out, err } = captureIo();
      expect(logsCommand({ runId: 'end-1', failed: true }, deps(io, true))).toBe(
        EXIT_CODES.success,
      );
      expect(parseNdjson<{ type: string }>(out()).map((event) => event.type)).toEqual([
        'run:completed',
      ]);
      expect(out().trimEnd().split('\n')).toHaveLength(1);
      expect(err()).toBe('');
    });

    it('says nothing failed only when nothing did: a cancelled run with a failed node is not told so', async () => {
      await seedRun(db, { slug: 'demo', runId: 'end-1', state: 'running' });
      const append = appender('end-1', 3);
      await append({ type: 'node:started', nodeId: 'b', nodeType: 'transform' });
      await append({ type: 'node:failed', nodeId: 'b', error: BOOM });
      await append({ type: 'run:cancelled' });
      const { io, out } = captureIo();
      logsCommand({ runId: 'end-1', failed: true }, deps(io));
      expect(out()).toBe(
        [
          'run end-1 — cancelled (2 of 6 events)',
          '[4] node:failed b — internal',
          '[5] run:cancelled — cancelled',
          '',
        ].join('\n'),
      );
    });

    it('does not claim a run that is still going has no failure: it has not closed', async () => {
      await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'running' });
      const { io, out } = captureIo();
      logsCommand({ runId: 'run-1', failed: true }, deps(io));
      expect(out()).not.toContain('no failure events');
    });

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
      expect(lines.slice(-5)).toEqual([
        '[5] run:paused',
        'run gate-1 is paused at a gate:',
        '  pending gate g1 (approval) at g',
        '    approve: relavium gate gate-1 --gate g1 --approve',
        '    reject: relavium gate gate-1 --gate g1 --reject',
      ]);
      expect(err()).toBe('');
    });

    it('puts each command of the gate notice on its own row, and no row wraps at 100 columns for these ids', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'gate-1',
        state: 'paused',
        gate: { gateId: 'g1', gateType: 'approval' },
      });
      await appender('gate-1', 5)({ type: 'run:paused', pendingGateCount: 1, gateIds: ['g1'] });
      const { io, out } = captureIo();
      await logsFollowCommand(
        { runId: 'gate-1' },
        deps(io, false, { sleep: scriptedSleep([]).sleep }),
      );
      const notice = out().split('\n[5] run:paused\n')[1]?.trimEnd().split('\n') ?? [];
      expect(notice).toHaveLength(4);
      for (const row of notice) {
        expect(row.length).toBeLessThanOrEqual(100);
        expect(row.match(/relavium /gu)?.length ?? 0).toBeLessThanOrEqual(1); // never two commands in one row
      }
      expect(notice.filter((row) => row.includes('relavium gate'))).toHaveLength(2);
    });

    it('keeps every command on a row of its own for recorded ids the size of a UUID', async () => {
      const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';
      const gateId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
      await seedRun(db, {
        slug: 'demo',
        runId,
        state: 'paused',
        gate: { gateId, gateType: 'approval' },
      });
      await appender(runId, 5)({ type: 'run:paused', pendingGateCount: 1, gateIds: [gateId] });
      const { io, out } = captureIo();
      await logsFollowCommand({ runId }, deps(io, false, { sleep: scriptedSleep([]).sleep }));
      const notice = out().split('\n[5] run:paused\n')[1]?.trimEnd().split('\n') ?? [];
      expect(notice).toEqual([
        `run ${runId} is paused at a gate:`,
        `  pending gate ${gateId} (approval) at g`,
        `    approve: relavium gate ${runId} --gate ${gateId} --approve`,
        `    reject: relavium gate ${runId} --gate ${gateId} --reject`,
      ]);
    });

    it('names the first gate and counts the rest when several are pending', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'gate-1',
        state: 'paused',
        gates: [
          { gateId: 'g1', gateType: 'approval' },
          { gateId: 'g2', gateType: 'approval' },
          { gateId: 'g3', gateType: 'approval' },
        ],
      });
      await appender(
        'gate-1',
        7,
      )({
        type: 'run:paused',
        pendingGateCount: 3,
        gateIds: ['g1', 'g2', 'g3'],
      });
      const { io, out } = captureIo();
      await logsFollowCommand(
        { runId: 'gate-1' },
        deps(io, false, { sleep: scriptedSleep([]).sleep }),
      );
      const notice = out().split('\n[7] run:paused\n')[1]?.trimEnd().split('\n') ?? [];
      expect(notice).toHaveLength(5);
      expect(notice[0]).toBe('run gate-1 is paused at a gate:');
      expect(notice[1]).toMatch(/^ {2}pending gate g[123] \(approval\) at g$/u);
      expect(notice.at(-1)).toBe('  2 more pending gates: `relavium status gate-1` lists them');
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
        [
          'run gate-1 is paused at a gate:',
          '  pending gate g1 (approval) at g',
          '    approve: relavium gate gate-1 --gate g1 --approve',
          '    reject: relavium gate gate-1 --gate g1 --reject',
          '',
        ].join('\n'),
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
      // The allowance label first, as `status` prints it, then the one command a legacy gate takes.
      expect(out().trimEnd().split('\n').slice(-3)).toEqual([
        'run bud-1 is paused at a gate:',
        '  pending budget gate b1 at g — legacy gate: no frozen allowance',
        '    reject: relavium budget resume bud-1 --gate b1 --abort',
      ]);
    });

    it('puts the excluded-candidate notes of a budget gate under its allowance, before its commands, as status does', async () => {
      await seedRun(db, { slug: 'demo', runId: 'bud-1', state: 'running' });
      const append = appender('bud-1', 3);
      await append({ type: 'node:started', nodeId: 'g', nodeType: 'agent' });
      await append({
        type: 'budget:paused',
        nodeId: 'g',
        gateId: 'b1',
        spentMicrocents: 100,
        limitMicrocents: 50,
        allowanceQuote: {
          kind: 'unpriced',
          excludedEntries: [
            {
              index: 0,
              provider: 'openai',
              endpoint: 'official',
              model: 'ghost-model',
              reason: 'unpriced_model',
            },
          ],
        },
      });
      await append({ type: 'run:paused', pendingGateCount: 1, gateIds: ['b1'] });
      const { io, out } = captureIo();
      await logsFollowCommand(
        { runId: 'bud-1' },
        deps(io, false, { sleep: scriptedSleep([]).sleep }),
      );
      expect(out().trimEnd().split('\n').slice(-4)).toEqual([
        'run bud-1 is paused at a gate:',
        '  pending budget gate b1 at g — reject only: no priced allowance',
        '    Excluded openai candidate 1 "ghost-model": unpriced model',
        '    reject: relavium budget resume bud-1 --gate b1 --abort',
      ]);
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

  describe('--follow liveness: a run nobody owns never gets a terminal event', () => {
    /** The note a no-owner verdict ends the follow on: two short rows, plain words, no claim about the log's future. */
    const noOwnerNote = (id: string): string =>
      `note: no running process found for run ${id}; following stops.\n` +
      `\`relavium status ${id}\` shows where it stands.\n`;

    /** A run that began long before the clock the test starts at, so the absent-lease age rule does not hold it back. */
    const OLD_RUN_MS = T0 - 10 * RUN_LEASE_TTL_MS;
    const seedOldRun = async (runId: string, state: 'running' | 'paused' = 'running') =>
      seedRun(db, { slug: 'demo', runId, state, atMs: OLD_RUN_MS });

    it('ends with exit 0 and one stderr note once a poll that found nothing finds no lease, and stdout stays the plain log', async () => {
      await seedOldRun('f1');
      const plain = captureIo();
      logsCommand({ runId: 'f1' }, deps(plain.io));
      const clock = fakeClock(T0);
      const { io, out, err } = captureIo();
      const { sleep, waits } = scriptedSleep([() => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS)]);
      await expect(
        logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toEqual([FOLLOW_POLL_INTERVAL_MS]);
      expect(err()).toBe(noOwnerNote('f1'));
      expect(out()).toBe(plain.out());
      expect(out()).not.toContain('no running process');
    });

    it('words the no-owner note in at most two short rows of plain language, without the words owner or settle', async () => {
      const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';
      await seedOldRun(runId);
      const clock = fakeClock(T0);
      const { io, err } = captureIo();
      await logsFollowCommand(
        { runId },
        deps(io, false, {
          sleep: scriptedSleep([() => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS)]).sleep,
          now: clock.now,
        }),
      );
      const rows = err().trimEnd().split('\n');
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(100);
      expect(err()).not.toMatch(/owner|settle|Home/iu);
      expect(rows[1]).toBe(`\`relavium status ${runId}\` shows where it stands.`);
    });

    /** The row another process commits in the instant between the follower's tail read and its lease check. */
    function insertEvent(body: Record<string, unknown>, seq: number): void {
      const event = RunEventSchema.parse({
        ...body,
        runId: 'f1',
        timestamp: '2026-10-11T00:00:00.000Z',
        sequenceNumber: seq,
      });
      db.insert(runEvents)
        .values({
          id: `raced-${seq}`,
          runId: 'f1',
          seq,
          eventType: event.type,
          payloadJson: JSON.stringify(event),
          ts: 0,
        })
        .run();
    }

    /**
     * A clock whose second reading, the one a due liveness check takes right after the first empty tail read, is
     * where `race` runs: whatever the owner does between that read and the lease check lands there. From that
     * reading on a full interval has passed since the start, so the check is due.
     */
    function racingClock(race: () => void): () => number {
      return movableRacingClock(race).now;
    }

    /** {@link racingClock}, whose time the script can then move on, so a later check can come due. */
    function movableRacingClock(race: () => void): {
      now: () => number;
      advance: (ms: number) => void;
    } {
      let reads = 0;
      let moved = 0;
      return {
        now: () => {
          reads += 1;
          if (reads === 1) return T0;
          if (reads === 2) race();
          return T0 + FOLLOW_LIVENESS_INTERVAL_MS + moved;
        },
        advance: (ms) => {
          moved += ms;
        },
      };
    }

    const releaseLease = (): void => {
      client.sqlite.prepare('DELETE FROM run_leases WHERE run_id = ?').run('f1');
    };

    it('prints the closing event the owner committed between the tail read and the lease check, and ends 0 with no note', async () => {
      await seedOldRun('f1');
      setLease('f1', T0 + 3_600_000); // live until the owner lets it go
      const { io, out, err } = captureIo();
      // No wait is scripted: the poll guard fails the test if the follow sleeps instead of ending.
      const { sleep, waits } = scriptedSleep([]);
      const now = racingClock(() => {
        insertEvent(COMPLETED, 3);
        releaseLease();
      });
      await expect(
        logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toEqual([]);
      expect(out()).toContain('[3] run:completed — completed');
      // The run closed: the note, which would say the run was left unsettled, is not written.
      expect(err()).toBe('');
    });

    it('under --json prints that closing event as the last NDJSON line, with nothing on stderr', async () => {
      await seedOldRun('f1');
      setLease('f1', T0 + 3_600_000);
      const { io, out, err } = captureIo();
      const now = racingClock(() => {
        insertEvent(COMPLETED, 3);
        releaseLease();
      });
      await expect(
        logsFollowCommand({ runId: 'f1' }, deps(io, true, { sleep: scriptedSleep([]).sleep, now })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(parseNdjson<{ type: string }>(out()).map((event) => event.type)).toEqual([
        'run:started',
        'node:started',
        'node:completed',
        'run:completed',
      ]);
      expect(err()).toBe('');
    });

    it('reads once more before it says the run row is gone, too', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const { io, out, err } = captureIo();
      const now = racingClock(() => {
        insertEvent(COMPLETED, 3);
        // Foreign keys off, so the row goes and the event it closed with stays to be read.
        client.sqlite.pragma('foreign_keys = OFF');
        client.sqlite.prepare('DELETE FROM runs WHERE id = ?').run('f1');
      });
      await expect(
        logsFollowCommand(
          { runId: 'f1' },
          deps(io, false, { sleep: scriptedSleep([]).sleep, now }),
        ),
      ).resolves.toBe(EXIT_CODES.success);
      expect(out()).toContain('[3] run:completed — completed');
      expect(err()).toBe('');
    });

    it('prints a late event that does not close the run, goes on following, and judges the verdict again at its next check', async () => {
      await seedOldRun('f1');
      setLease('f1', T0 + 3_600_000);
      const { io, out, err } = captureIo();
      const clock = movableRacingClock(() => {
        insertEvent({ type: 'node:started', nodeId: 'n2', nodeType: 'transform' }, 3);
        releaseLease();
      });
      // One wait is scripted: the late event must not end the follow on the verdict, so it waits, and the check
      // that comes due after it (the clock moved a full interval) ends it on the note.
      const { sleep, waits } = scriptedSleep([() => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS)]);
      await expect(
        logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toEqual([FOLLOW_POLL_INTERVAL_MS]);
      expect(out()).toContain('[3] node:started n2');
      expect(err()).toBe(noOwnerNote('f1'));
    });

    it('goes on following after a late event, and ends at the closing event that follows it with no note', async () => {
      await seedOldRun('f1');
      setLease('f1', T0 + 3_600_000);
      const { io, out, err } = captureIo();
      const clock = movableRacingClock(() => {
        insertEvent({ type: 'node:started', nodeId: 'n2', nodeType: 'transform' }, 3);
        releaseLease();
      });
      const { sleep, waits } = scriptedSleep([
        () => insertEvent(COMPLETED, 4), // the late event was not the end: the owner went on and closed the run
      ]);
      await expect(
        logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toHaveLength(1);
      expect(out()).toContain('[4] run:completed — completed');
      expect(err()).toBe('');
    });

    it('ends with the gate notice, not the no-owner note, when the owner parks the run at a gate and lets go of its lease', async () => {
      // A parked run releases its lease right after it commits `run:paused`: the natural race for this check.
      await seedRun(db, {
        slug: 'demo',
        runId: 'f1',
        state: 'paused',
        gate: { gateId: 'g1', gateType: 'approval' },
        atMs: OLD_RUN_MS,
      });
      setLease('f1', T0 + 3_600_000);
      const { io, out, err } = captureIo();
      const now = racingClock(() => {
        insertEvent({ type: 'run:paused', pendingGateCount: 1, gateIds: ['g1'] }, 5);
        releaseLease();
      });
      // No wait is scripted: the poll guard fails the test if the follow sleeps instead of ending.
      await expect(
        logsFollowCommand(
          { runId: 'f1' },
          deps(io, false, { sleep: scriptedSleep([]).sleep, now }),
        ),
      ).resolves.toBe(EXIT_CODES.success);
      expect(out().trimEnd().split('\n').slice(-5)).toEqual([
        '[5] run:paused',
        'run f1 is paused at a gate:',
        '  pending gate g1 (approval) at g',
        '    approve: relavium gate f1 --gate g1 --approve',
        '    reject: relavium gate f1 --gate g1 --reject',
      ]);
      expect(err()).toBe('');
    });

    it('under --json the note is on stderr only, and stdout stays a pure NDJSON stream', async () => {
      await seedOldRun('f1');
      const clock = fakeClock(T0);
      const { io, out, err } = captureIo();
      const { sleep } = scriptedSleep([() => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS)]);
      await logsFollowCommand({ runId: 'f1' }, deps(io, true, { sleep, now: clock.now }));
      expect(err()).toBe(noOwnerNote('f1'));
      expect(out()).not.toContain('no running process');
      expect(parseNdjson<{ sequenceNumber: number }>(out()).map((e) => e.sequenceNumber)).toEqual([
        0, 1, 2,
      ]);
    });

    it('keeps following a run with a live lease, and ends 0 at the terminal event with nothing on stderr', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      setLease('f1', T0 + 3_600_000);
      const append = appender('f1', 3);
      const clock = fakeClock(T0);
      const { io, out, err } = captureIo();
      const { sleep, waits } = scriptedSleep([
        () => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS), // the check is due next poll: the lease is live
        async () => {
          clock.advance(FOLLOW_LIVENESS_INTERVAL_MS);
          await append(COMPLETED);
        },
      ]);
      await expect(
        logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toHaveLength(2);
      expect(out()).toContain('[3] run:completed — completed');
      expect(err()).toBe('');
    });

    it('ends when the lease it was following lapsed MORE than a full TTL ago, and not when it merely expires', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      setLease('f1', T0 + 2_000);
      const clock = fakeClock(T0);
      const { io, err } = captureIo();
      const { sleep, waits } = scriptedSleep([
        () => clock.advance(1_500), // T0+1500: due, the lease (to T0+2000) is live
        () => clock.advance(1_500), // T0+3000: due, the lease has expired, but a beat may only be late: still followed
        () => clock.advance(RUN_LEASE_TTL_MS - 2_000), // T0+TTL+1000, a second short of a full TTL past the expiry
        () => clock.advance(1_001), // T0+TTL+2001: more than a full TTL past the expiry, with no renewal: gone
      ]);
      await logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now }));
      expect(waits).toHaveLength(4);
      expect(err()).toBe(noOwnerNote('f1'));
    });

    it('treats a lease as gone a millisecond past one TTL after its expiry, and live at exactly one TTL (strictly more than one TTL, as `stalled` is)', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      // At the check (T0 + interval) the lease expired one TTL and a millisecond ago: more than one TTL, gone.
      setLease('f1', T0 + FOLLOW_LIVENESS_INTERVAL_MS - RUN_LEASE_TTL_MS - 1);
      const after = captureIo();
      const clockAfter = fakeClock(T0);
      const afterScript = scriptedSleep([() => clockAfter.advance(FOLLOW_LIVENESS_INTERVAL_MS)]);
      await logsFollowCommand(
        { runId: 'f1' },
        deps(after.io, false, { sleep: afterScript.sleep, now: clockAfter.now }),
      );
      expect(afterScript.waits).toHaveLength(1);
      expect(after.err()).toBe(noOwnerNote('f1'));

      // The same check one millisecond earlier: the lease expired exactly one TTL ago, which is not more than one
      // TTL, so it is still live: the follow goes on, and ends on the terminal event the script appends.
      setLease('f1', T0 + FOLLOW_LIVENESS_INTERVAL_MS - RUN_LEASE_TTL_MS);
      const at = captureIo();
      const clockAt = fakeClock(T0);
      const atScript = scriptedSleep([
        () => clockAt.advance(FOLLOW_LIVENESS_INTERVAL_MS),
        () => appender('f1', 3)(COMPLETED),
      ]);
      await logsFollowCommand(
        { runId: 'f1' },
        deps(at.io, false, { sleep: atScript.sleep, now: clockAt.now }),
      );
      expect(atScript.waits).toHaveLength(2);
      expect(at.err()).toBe('');
    });

    it('does not judge a run with no lease until it is older than one TTL: a run that has only just begun may not have taken it', async () => {
      // Started at T0 - TTL + interval + 1, the clock stops a millisecond short of one TTL of age at the check.
      const startedAtMs = T0 - RUN_LEASE_TTL_MS + FOLLOW_LIVENESS_INTERVAL_MS + 1;
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running', atMs: startedAtMs });
      const young = captureIo();
      const clockYoung = fakeClock(T0);
      const { sleep, waits } = scriptedSleep([
        () => clockYoung.advance(FOLLOW_LIVENESS_INTERVAL_MS), // due; the run is TTL - 1 ms old: not judged
        () => appender('f1', 3)(COMPLETED),
      ]);
      await logsFollowCommand(
        { runId: 'f1' },
        deps(young.io, false, { sleep, now: clockYoung.now }),
      );
      expect(waits).toHaveLength(2);
      expect(young.err()).toBe('');
    });

    it('judges a run with no lease from the moment it is one TTL old', async () => {
      const startedAtMs = T0 - RUN_LEASE_TTL_MS + FOLLOW_LIVENESS_INTERVAL_MS;
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running', atMs: startedAtMs });
      const old = captureIo();
      const clock = fakeClock(T0);
      const { sleep, waits } = scriptedSleep([() => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS)]);
      await logsFollowCommand({ runId: 'f1' }, deps(old.io, false, { sleep, now: clock.now }));
      expect(waits).toHaveLength(1);
      expect(old.err()).toBe(noOwnerNote('f1'));
    });

    it('judges a run with no lease whose start lies one TTL or more ahead of now (here exactly one TTL): a clock moved back', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'f1',
        state: 'running',
        atMs: T0 + RUN_LEASE_TTL_MS + FOLLOW_LIVENESS_INTERVAL_MS,
      });
      const future = captureIo();
      const clock = fakeClock(T0);
      const { sleep, waits } = scriptedSleep([() => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS)]);
      await logsFollowCommand({ runId: 'f1' }, deps(future.io, false, { sleep, now: clock.now }));
      expect(waits).toHaveLength(1);
      expect(future.err()).toBe(noOwnerNote('f1'));
    });

    it('asks at most once per second of the injected clock, and not in the first second', async () => {
      await seedOldRun('f1');
      const clock = fakeClock(T0);
      const { io, err } = captureIo();
      // No lease at all. A check on every empty poll would end this after the first wait; the interval, from the
      // moment the follow started, ends it only once a full second has passed on the injected clock.
      const { sleep, waits } = scriptedSleep([
        () => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS - 1),
        () => clock.advance(1),
      ]);
      await logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now }));
      expect(waits).toHaveLength(2);
      expect(err()).toBe(noOwnerNote('f1'));
    });

    it('rates the next check from the last one, not from the start', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      setLease('f1', T0 + 3_600_000);
      const clock = fakeClock(T0);
      const { io, err } = captureIo();
      const { sleep, waits } = scriptedSleep([
        () => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS), // due: live
        () => {
          setLease('f1', 0); // the owner is gone from here on, but the last check was half a second ago
          clock.advance(FOLLOW_LIVENESS_INTERVAL_MS / 2);
        },
        () => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS / 2), // a full second since the last check: due
      ]);
      await logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now }));
      expect(waits).toHaveLength(3);
      expect(err()).toBe(noOwnerNote('f1'));
    });

    describe('a process that slept does not judge the owner (HISTORY-1)', () => {
      /** The laptop slept for five minutes: far more than the TTL, and more than the old rule's ~100 s allowance. */
      const SLEEP_MS = 300_000;

      it('does not end on a lease that only looks expired because this process slept, and ends on the closing event the owner then writes', async () => {
        await seedOldRun('f1');
        setLease('f1', T0 + RUN_LEASE_TTL_MS / 2); // live when the follow began
        const clock = fakeClock(T0);
        const { io, out, err } = captureIo();
        const { sleep, waits } = scriptedSleep([
          () => clock.advance(SLEEP_MS), // the machine slept: the lease is now five minutes stale
          () => {
            // The owner woke with the follow and beat once: its lease is live again.
            setLease('f1', clock.now() + RUN_LEASE_TTL_MS);
            clock.advance(FOLLOW_LIVENESS_INTERVAL_MS);
          },
          () => appender('f1', 3)(COMPLETED),
        ]);
        await expect(
          logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now })),
        ).resolves.toBe(EXIT_CODES.success);
        expect(waits).toHaveLength(3);
        expect(err()).toBe('');
        expect(err()).not.toContain('no running process');
        expect(out()).toContain('[3] run:completed — completed');
      });

      it.each([
        ['a check one millisecond short of the window is held back', FOLLOW_RESUME_GRACE_MS - 1],
        [
          "a check exactly at the window's end is not",
          FOLLOW_RESUME_GRACE_MS - FOLLOW_LIVENESS_INTERVAL_MS,
        ],
      ])(
        'holds a no-owner verdict back for one heartbeat after the gap, reads the lease again, and ends on it only when it is still gone (%s)',
        async (_name, secondAdvanceMs) => {
          await seedOldRun('f1');
          setLease('f1', T0 + RUN_LEASE_TTL_MS / 2);
          const clock = fakeClock(T0);
          const { io, err } = captureIo();
          const { sleep, waits } = scriptedSleep([
            () => clock.advance(SLEEP_MS), // the tick that finds the gap: the window runs from here
            () => clock.advance(secondAdvanceMs), // the lease is still stale, and the window is not over: held back
            // A full liveness interval later the next check is due. In the first case it lands one interval
            // after the window ended, in the second exactly on its end: the lease is still gone, and it ends.
            () => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS),
          ]);
          await logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now }));
          expect(waits).toHaveLength(3);
          expect(err()).toBe(noOwnerNote('f1'));
        },
      );

      it('takes a gap of exactly one TTL for no sleep, and one millisecond more for one', async () => {
        await seedOldRun('f1');
        setLease('f1', 0); // long expired at either clock: only the gap rule decides
        const exact = captureIo();
        const clockExact = fakeClock(T0);
        const atTtl = scriptedSleep([() => clockExact.advance(RUN_LEASE_TTL_MS)]);
        await logsFollowCommand(
          { runId: 'f1' },
          deps(exact.io, false, { sleep: atTtl.sleep, now: clockExact.now }),
        );
        expect(atTtl.waits).toHaveLength(1);
        expect(exact.err()).toBe(noOwnerNote('f1'));

        const over = captureIo();
        const clockOver = fakeClock(T0);
        const pastTtl = scriptedSleep([
          () => clockOver.advance(RUN_LEASE_TTL_MS + 1),
          () => clockOver.advance(FOLLOW_RESUME_GRACE_MS),
        ]);
        await logsFollowCommand(
          { runId: 'f1' },
          deps(over.io, false, { sleep: pastTtl.sleep, now: clockOver.now }),
        );
        expect(pastTtl.waits).toHaveLength(2);
        expect(over.err()).toBe(noOwnerNote('f1'));
      });

      it('does not hold back the end of a run whose row is gone: that is not about the clock', async () => {
        await seedOldRun('f1');
        const clock = fakeClock(T0);
        const { io, err } = captureIo();
        const { sleep, waits } = scriptedSleep([
          () => {
            client.sqlite.prepare('DELETE FROM runs WHERE id = ?').run('f1');
            clock.advance(SLEEP_MS);
          },
        ]);
        await logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now }));
        expect(waits).toHaveLength(1);
        expect(err()).toBe(
          'note: run f1 is no longer in the history, so there is nothing more to follow.\n',
        );
      });
    });

    it('ends, with its own note, when the run row is gone', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const clock = fakeClock(T0);
      const { io, err, out } = captureIo();
      const { sleep, waits } = scriptedSleep([
        () => {
          client.sqlite.prepare('DELETE FROM runs WHERE id = ?').run('f1');
          clock.advance(FOLLOW_LIVENESS_INTERVAL_MS);
        },
      ]);
      await expect(
        logsFollowCommand({ runId: 'f1' }, deps(io, false, { sleep, now: clock.now })),
      ).resolves.toBe(EXIT_CODES.success);
      expect(waits).toHaveLength(1);
      expect(err()).toBe(
        'note: run f1 is no longer in the history, so there is nothing more to follow.\n',
      );
      expect(out()).not.toContain('no longer in the history');
    });

    it('never asks about a run parked at a gate: it ends on the gate, however far the clock has run', async () => {
      await seedRun(db, {
        slug: 'demo',
        runId: 'gate-1',
        state: 'paused',
        gate: { gateId: 'g1', gateType: 'approval' },
      });
      await appender('gate-1', 5)({ type: 'run:paused', pendingGateCount: 1, gateIds: ['g1'] });
      let jumping = T0;
      const now = (): number => {
        jumping += 10 * FOLLOW_LIVENESS_INTERVAL_MS;
        return jumping;
      };
      const { io, out, err } = captureIo();
      const { sleep, waits } = scriptedSleep([]);
      await logsFollowCommand({ runId: 'gate-1' }, deps(io, false, { sleep, now }));
      expect(waits).toEqual([]);
      expect(out()).toContain('run gate-1 is paused at a gate');
      expect(err()).toBe('');
    });

    it('does not mistake a gate that was answered for a lost owner while the lease is live', async () => {
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
      setLease('gate-1', T0 + 3_600_000);
      const clock = fakeClock(T0);
      const { io, err } = captureIo();
      const { sleep, waits } = scriptedSleep([
        () => clock.advance(FOLLOW_LIVENESS_INTERVAL_MS),
        () => append(COMPLETED),
      ]);
      await logsFollowCommand({ runId: 'gate-1' }, deps(io, false, { sleep, now: clock.now }));
      expect(waits).toHaveLength(2);
      expect(err()).toBe('');
    });

    it('ends a run parked on a media job alone when its owner is gone, and follows one whose lease is live', async () => {
      await seedOldRun('media-1', 'paused'); // no gate: a media park
      const gone = captureIo();
      const clockGone = fakeClock(T0);
      await logsFollowCommand(
        { runId: 'media-1' },
        deps(gone.io, false, {
          sleep: scriptedSleep([() => clockGone.advance(FOLLOW_LIVENESS_INTERVAL_MS)]).sleep,
          now: clockGone.now,
        }),
      );
      expect(gone.err()).toBe(noOwnerNote('media-1'));

      setLease('media-1', T0 + 3_600_000);
      const live = captureIo();
      const clockLive = fakeClock(T0);
      const { sleep, waits } = scriptedSleep([
        () => clockLive.advance(FOLLOW_LIVENESS_INTERVAL_MS),
        () => appender('media-1', 6)({ type: 'run:cancelled' }),
      ]);
      await logsFollowCommand(
        { runId: 'media-1' },
        deps(live.io, false, { sleep, now: clockLive.now }),
      );
      expect(waits).toHaveLength(2);
      expect(live.err()).toBe('');
    });

    it('lets a stop that arrives during the wait win over a check that is already due', async () => {
      await seedOldRun('f1'); // old enough that the due check would end the follow, were the stop not to win
      const clock = fakeClock(T0);
      const fixture = invocationFixture();
      const captured = captureIo();
      const lifetime = new CommandLifetime(fixture.invocation, captured.io, () => () => undefined);
      let waited = 0;
      const sleep: NonNullable<LogsCommandDeps['sleep']> = () => {
        waited += 1;
        clock.advance(10 * FOLLOW_LIVENESS_INTERVAL_MS); // a check is due on the next poll...
        lifetime.work.stop(); // ...but the owner is stopped first
        return waited > 1
          ? Promise.reject(new Error('poll guard: waited again after the stop'))
          : Promise.resolve();
      };
      const exit = await lifetime.execute(() =>
        logsFollowCommand(
          { runId: 'f1' },
          deps(lifetime.io, false, { sleep, now: clock.now, commandLifetime: lifetime }),
        ),
      );
      expect(exit).toBe(EXIT_CODES.success);
      expect(waited).toBe(1);
      expect(captured.err()).not.toContain('no running process');
    });
  });

  describe('a damaged row while following', () => {
    it('fails the command with the damaged-row error (exit 1) at the moment it is read, and does not poll again', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const { io, out } = captureIo();
      // A type this binary knows, with a body that does not parse: damaged, not newer.
      const { sleep, waits } = scriptedSleep([
        () => {
          client.sqlite
            .prepare(
              'INSERT INTO run_events (id, run_id, seq, event_type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
              'damaged-row-1',
              'f1',
              3,
              'node:started',
              JSON.stringify({ type: 'node:started' }),
              0,
            );
        },
      ]);
      const failure: unknown = await logsFollowCommand(
        { runId: 'f1' },
        deps(io, false, { sleep }),
      ).catch((cause: unknown) => cause);
      expect(isCorruptRunEventError(failure)).toBe(true);
      const shown = toUserFacing(failure);
      expect(shown.exitCode).toBe(EXIT_CODES.workflowFailed);
      expect(shown.message).toContain('run f1 has a damaged event row at seq 3');
      expect(waits).toHaveLength(1); // read once more after that wait, failed there, and never waited again
      expect(out().trimEnd().split('\n')).toHaveLength(4); // the header and the three events it had read
    });
  });

  describe('readHistory', () => {
    it('accumulates a page with a very large skipped list without a spread (no RangeError)', () => {
      const skippedRows = 600_000;
      const page = {
        events: [],
        scannedThroughSeq: skippedRows - 1,
        skipped: Array.from({ length: skippedRows }, (_, index) => ({
          sequenceNumber: index,
          type: 'test:never_a_real_event',
        })),
      };
      // A short page (no events) ends the read, as the real tail read does at the end of a log.
      const history = readHistory({ loadRunEventsAfter: () => page }, 'f1');
      expect(history.skipped).toHaveLength(skippedRows);
      expect(history.scannedThroughSeq).toBe(skippedRows - 1);
      expect(history.events).toEqual([]);
    });

    it('accumulates events and skipped rows across full pages in order', () => {
      const event = (sequenceNumber: number): RunEvent => ({
        type: 'run:cancelled',
        runId: 'f1',
        timestamp: '2026-11-22T10:00:00.000Z',
        sequenceNumber,
      });
      const full = Array.from({ length: 1000 }, (_, index) => event(index));
      const pages = [
        {
          events: full,
          scannedThroughSeq: 999,
          skipped: [{ sequenceNumber: 500, type: 'future' }],
        },
        {
          events: [event(1000)],
          scannedThroughSeq: 1001,
          skipped: [{ sequenceNumber: 1001, type: 'future' }],
        },
      ];
      const cursors: number[] = [];
      let call = 0;
      const history = readHistory(
        {
          loadRunEventsAfter: (_runId, afterSeq) => {
            cursors.push(afterSeq);
            return pages[call++] ?? { events: [], scannedThroughSeq: afterSeq, skipped: [] };
          },
        },
        'f1',
      );
      expect(cursors).toEqual([-1, 999]);
      expect(history.events.map((e) => e.sequenceNumber)).toEqual(
        Array.from({ length: 1001 }, (_, index) => index),
      );
      expect(history.skipped.map((row) => row.sequenceNumber)).toEqual([500, 1001]);
      expect(history.scannedThroughSeq).toBe(1001);
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

    it('says nothing failed, before the closing row, when the run closes during the follow with no failure', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const append = appender('f1', 3);
      const { io, out } = captureIo();
      const { sleep } = scriptedSleep([() => runNode(append, 'n2'), () => append(COMPLETED)]);
      await logsFollowCommand({ runId: 'f1', failed: true }, deps(io, false, { sleep }));
      expect(out()).toBe(
        [
          'run f1 — running (0 of 3 events)',
          'no failure events in this run.',
          '[5] run:completed — completed',
          '',
        ].join('\n'),
      );
    });

    it('says nothing failed once, for a log that already closed without a failure, and ends at once', async () => {
      await seedRun(db, { slug: 'demo', runId: 'done-1', state: 'completed' });
      const { io, out } = captureIo();
      const { sleep, waits } = scriptedSleep([]);
      await logsFollowCommand({ runId: 'done-1', failed: true }, deps(io, false, { sleep }));
      expect(waits).toEqual([]);
      expect(out()).toBe(
        [
          'run done-1 — completed (1 of 4 events)',
          'no failure events in this run.',
          '[3] run:completed — completed',
          '',
        ].join('\n'),
      );
    });

    it('does not say nothing failed once a failure was shown, and says nothing extra under --json', async () => {
      await seedRun(db, { slug: 'demo', runId: 'f1', state: 'running' });
      const append = appender('f1', 3);
      const failing = captureIo();
      const { sleep } = scriptedSleep([
        async () => {
          await append({ type: 'node:started', nodeId: 'b', nodeType: 'transform' });
          await append({ type: 'node:failed', nodeId: 'b', error: BOOM });
        },
        () => append({ type: 'run:cancelled' }),
      ]);
      await logsFollowCommand({ runId: 'f1', failed: true }, deps(failing.io, false, { sleep }));
      expect(failing.out()).not.toContain('no failure events');

      await seedRun(db, { slug: 'demo', runId: 'f2', state: 'running' });
      const json = captureIo();
      const second = scriptedSleep([() => appender('f2', 3)(COMPLETED)]);
      await logsFollowCommand(
        { runId: 'f2', failed: true },
        deps(json.io, true, { sleep: second.sleep }),
      );
      expect(parseNdjson<{ type: string }>(json.out()).map((event) => event.type)).toEqual([
        'run:completed',
      ]);
      expect(json.err()).toBe('');
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
