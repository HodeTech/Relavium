import { createClient, runEvents, runMigrations, type Db, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson, seedRun } from '../test-support.js';
import { logsCommand, type LogsCommandDeps } from './logs.js';

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
});
