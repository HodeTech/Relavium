import { createClient, runEvents, runMigrations, type Db, type DbClient } from '@relavium/db';
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

  it('SANITIZES the untrusted gate message (lane-c security review)', async () => {
    // `human_gate:paused.message` is `resolveTemplate(node.message_template, …)` — interpolated upstream node
    // output, i.e. the most model-controlled string in the product. The interactive prompt sanitized it
    // (`clack-prompter.ts`); this command leaf did not, so an OSC 52 clipboard write, an OSC 8 hyperlink, a
    // CSI erase-display and a bidi override all reached the terminal intact. Confirmed by executing the real
    // command against a real DB during the review, not by reading.
    const { io, out } = captureIo();
    const hostile =
      'hi\u001b]52;c;ZXZpbA==\u0007\u001b]8;;file:///etc/passwd\u0007click\u001b]8;;\u0007\u001b[2J\u202Egnp.txt';
    await seedRun(db, {
      slug: 'x',
      runId: 'r9',
      state: 'paused',
      gate: { gateId: 'g-x', gateType: 'approval', message: hostile },
    });

    expect(gateListCommand({}, deps(io))).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).not.toContain('\u001b'); // no CSI/OSC introducer survives
    expect(text).not.toContain('\u0007'); // nor the OSC terminator
    expect(text).not.toContain('\u202E'); // nor a Trojan-Source bidi override
    expect(text).toContain('hi'); // …while the readable text still reaches the user
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

/**
 * #W15-15 — a run whose event log cannot be read used to contribute nothing AND say nothing, so the listing
 * answered "No pending human gates." for gates that had been lost. "I could not read this" and "there is
 * nothing here" are different answers.
 */
describe('gateListCommand — a damaged run is named, not silently skipped (#W15-15)', () => {
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

  /** A `type` this binary DOES know, with a body that cannot be one — corruption, not a forward-written row. */
  async function seedDamagedRun(runId: string): Promise<void> {
    await seedRun(db, { slug: 'demo', runId, state: 'paused' });
    db.insert(runEvents)
      .values({
        id: `00000000-0000-4000-8000-0000000000${runId.slice(-2)}`,
        runId,
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
  }

  it('warns on stderr while stdout keeps the healthy listing', async () => {
    const { io, out, err } = captureIo();
    await seedRun(db, {
      slug: 'demo',
      runId: 'ok-01',
      state: 'paused',
      gate: { gateId: 'g-ok', gateType: 'approval', message: 'ship it?' },
    });
    await seedDamagedRun('bad-01');

    expect(gateListCommand({}, deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toContain('g-ok'); // the healthy run is unaffected
    expect(err()).toContain('bad-01');
    expect(err()).toContain('could not be read');
  });

  it('emits a machine-readable marker record under --json', async () => {
    const { io, out } = captureIo();
    await seedDamagedRun('bad-01');

    expect(gateListCommand({}, deps(io, true))).toBe(EXIT_CODES.success);
    const records = parseNdjson(out());
    expect(records).toEqual([{ runId: 'bad-01', unavailable: 'corrupt_event_log' }]);
    // Without it the stream was EMPTY — indistinguishable from a run with no pending gates, which is the
    // whole defect.
    expect(records.some((r) => r['gateId'] !== undefined)).toBe(false);
  });

  it('still fails LOUDLY for an explicitly named run — degrading there would answer for a run the user asked about', async () => {
    const { io } = captureIo();
    await seedDamagedRun('bad-01');

    expect(() => gateListCommand({ runId: 'bad-01' }, deps(io))).toThrow();
  });
});
