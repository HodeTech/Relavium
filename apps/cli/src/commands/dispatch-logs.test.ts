import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClient,
  createRunHistoryStore,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import { RunEventSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openLocalDb } from '../db/open.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { captureIo, parseNdjson, seedRun } from '../test-support.js';
import { executeCommand, type CommandInput, type DispatchContext } from './dispatch.js';

// The history file is an in-memory db: `logs` opens it through the one opener every read command uses.
vi.mock('../db/open.js', () => ({ openLocalDb: vi.fn() }));

/**
 * `logs --failed` and `logs --follow` through the dispatch path the CLI itself takes (`executeCommand`, over the
 * uniform `CommandInput` the Commander action builds) — not through `logsCommand` directly. A flag the executor
 * forgot to forward (`--failed` dropped, `--follow` treated as a plain read) passes the command's own tests and
 * fails here.
 */
describe('logs through the dispatch path', () => {
  let client: DbClient;
  let db: Db;
  let cwd: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    db = client.db;
    cwd = mkdtempSync(join(tmpdir(), 'relavium-dispatch-logs-'));
    vi.mocked(openLocalDb).mockImplementation(() => ({ db, close: () => undefined }));
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const input = (options: CommandInput['options']): CommandInput => ({
    positionals: ['run-1'],
    options,
  });

  function context(io: DispatchContext['io'], json = false): DispatchContext {
    // A `--config` path that does not exist keeps the read off the operator's real config (it is never healed).
    return {
      io,
      global: {
        json,
        color: false,
        cwd,
        configPath: join(cwd, 'no-such-config.toml'),
        verbosity: 'normal',
      },
    };
  }

  /** Persist an event behind a run `seedRun` made — what another process does while the follow is running. */
  async function append(runId: string, seq: number, body: Record<string, unknown>): Promise<void> {
    const store = createRunHistoryStore(db, {
      uuid: () => `${runId}-appended-${seq}`,
      now: () => 0,
      workflow: { slug: 'demo', name: 'demo', definitionJson: '{}' },
    });
    await store.persistEvent(
      RunEventSchema.parse({
        ...body,
        runId,
        timestamp: '2026-11-22T10:00:00.000Z',
        sequenceNumber: seq,
      }),
    );
  }

  it('--failed reaches the command: the failure and the closing event are shown, the rest of the log is not', async () => {
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'failed' }); // run:started, node:started, node:completed, run:failed
    const plain = captureIo();
    await expect(executeCommand('logs', input({}), context(plain.io))).resolves.toBe(
      EXIT_CODES.success,
    );
    expect(plain.out()).toContain('[1] node:started n1');
    expect(plain.out()).toContain('[2] node:completed n1');

    const failed = captureIo();
    await expect(executeCommand('logs', input({ failed: true }), context(failed.io))).resolves.toBe(
      EXIT_CODES.success,
    );
    expect(failed.out()).toBe(
      ['run run-1 — failed (1 of 4 events)', '[3] run:failed — internal', ''].join('\n'),
    );
    expect(failed.out()).not.toContain('node:started');
    expect(failed.out()).not.toContain('node:completed');
    expect(failed.err()).toBe('');

    // And under --json the dropped events are absent from the stream, not merely from the human rows.
    const json = captureIo();
    await executeCommand('logs', input({ failed: true }), context(json.io, true));
    expect(parseNdjson<{ type: string }>(json.out()).map((event) => event.type)).toEqual([
      'run:failed',
    ]);
  });

  it('--follow reaches the follow loop: a terminal event written after the log was printed ends the command, and is printed', async () => {
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'running' });
    const { io, out, err } = captureIo();
    const done = executeCommand('logs', input({ follow: true }), context(io));
    // The command has printed what the log held (so it is polling), and only then does the run end.
    await vi.waitFor(() => expect(out()).toContain('[2] node:completed n1'));
    expect(out()).not.toContain('run:completed');
    await append('run-1', 3, {
      type: 'run:completed',
      outputs: {},
      totalTokensUsed: { input: 1, output: 2 },
      totalCostMicrocents: 100,
      durationMs: 9,
    });
    await expect(done).resolves.toBe(EXIT_CODES.success);
    expect(out()).toContain('[3] run:completed — completed');
    expect(err()).toBe('');
  }, 15_000);

  it('--follow --failed reaches both: only the failure rows that arrive are printed, and the run ending ends the command', async () => {
    await seedRun(db, { slug: 'demo', runId: 'run-1', state: 'running' });
    const { io, out } = captureIo();
    const done = executeCommand('logs', input({ follow: true, failed: true }), context(io));
    await vi.waitFor(() => expect(out()).toContain('run run-1 — running (0 of 3 events)'));
    await append('run-1', 3, { type: 'node:started', nodeId: 'b', nodeType: 'transform' });
    await append('run-1', 4, {
      type: 'node:failed',
      nodeId: 'b',
      error: { code: 'internal', message: 'boom', retryable: false },
    });
    await append('run-1', 5, {
      type: 'run:failed',
      error: { code: 'internal', message: 'boom', retryable: false },
      partialOutputs: {},
    });
    await expect(done).resolves.toBe(EXIT_CODES.success);
    expect(out()).toBe(
      [
        'run run-1 — running (0 of 3 events)',
        '[4] node:failed b — internal',
        '[5] run:failed — internal',
        '',
      ].join('\n'),
    );
  }, 15_000);
});
