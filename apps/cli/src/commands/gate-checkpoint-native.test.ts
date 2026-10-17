import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { parseWorkflow } from '@relavium/core';
import {
  createClient,
  runMigrations,
  createRunHistoryStore,
  createRunLeasePort,
} from '@relavium/db';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { gateCommand, budgetCommand } from './gate.js';
import { executeCommand } from './dispatch.js';
import * as databaseOpen from '../db/open.js';
import { CliError, toUserFacing } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';

const workflow = parseWorkflow(
  JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'probe-checkpoint',
      nodes: [
        { id: 'input', type: 'input' },
        { id: 'gate', type: 'human_gate', gate_type: 'approval' },
        { id: 'output', type: 'output' },
      ],
      edges: [
        { from: 'input', to: 'gate' },
        { from: 'gate', to: 'output' },
      ],
    },
  }),
);
describe('actual SQLite checkpoint failure ownership', () => {
  it.each([
    ['gate', 'direct', 'closed'],
    ['budget', 'direct', 'closed'],
    ['gate', 'dispatch', 'closed'],
    ['budget', 'dispatch', 'closed'],
    ['gate', 'direct', 'corrupt'],
    ['gate', 'dispatch', 'corrupt'],
    ['gate', 'direct', 'missing'],
    ['gate', 'dispatch', 'missing'],
  ] as const)('%s %s %s', async (surface, route, fault) => {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-r10-checkpoint-'));
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, '');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    const client = createClient(join(dir, 'history.db'));
    runMigrations(client.db);
    const store = createRunHistoryStore(client.db, {
      uuid: randomUUID,
      now: Date.now,
      workflow: {
        slug: workflow.workflow.id,
        name: 'Probe',
        definitionJson: JSON.stringify(workflow),
      },
    });
    const engine = await buildEngine({
      host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    });
    const handle = engine.start({ workflow, inputs: {}, eventConsumption: 'iterated' });
    const iterator = handle.events[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error('pause missing');
      if (next.value.type === 'run:paused') break;
    }
    expect((await handle.depart()).kind).toBe('detached');
    expect((await iterator.next()).done).toBe(true);
    await iterator.return?.();
    if (fault === 'corrupt')
      client.sqlite
        .prepare(
          "UPDATE run_events SET payload_json='not-json' WHERE run_id=? AND event_type='run:started'",
        )
        .run(handle.runId);
    let nativeFailure: unknown;
    let entered = 0;
    if (fault === 'closed') {
      const original = client.sqlite.transaction.bind(client.sqlite);
      vi.spyOn(client.sqlite, 'transaction').mockImplementation((fn) => {
        entered++;
        client.sqlite.close();
        try {
          return original(fn);
        } catch (cause) {
          nativeFailure = cause;
          throw cause;
        }
      });
    }
    const f = invocationFixture();
    const c = captureIo();
    const close = vi.fn(() => {
      if (client.sqlite.open) client.sqlite.close();
    });
    const open = (_home: string, capture?: (close: () => void) => void) => {
      capture?.(close);
      return { db: client.db, close };
    };
    const global = { cwd: dir, configPath, json: true, color: false, verbosity: 'normal' as const };
    if (route === 'dispatch')
      vi.spyOn(databaseOpen, 'openLocalDb').mockImplementation((_home, _notice, capture) =>
        open(_home, capture),
      );
    let thrown: unknown;
    let code: number | undefined;
    try {
      const runId = fault === 'missing' ? '00000000-0000-4000-8000-000000000000' : handle.runId;
      try {
        code =
          route === 'dispatch'
            ? await executeCommand(
                surface === 'gate' ? 'gate' : 'budget.resume',
                {
                  positionals: [runId],
                  options: surface === 'gate' ? { approve: true } : { abort: true },
                },
                { io: c.io, global, invocation: f.invocation },
              )
            : surface === 'gate'
              ? await gateCommand(
                  { runId, approve: true },
                  {
                    io: c.io,
                    global,
                    invocation: f.invocation,
                    openDb: open,
                    subscribeSignals: () => () => undefined,
                  },
                )
              : await budgetCommand(
                  { runId, abort: true },
                  {
                    io: c.io,
                    global,
                    invocation: f.invocation,
                    openDb: open,
                    subscribeSignals: () => () => undefined,
                  },
                );
      } catch (cause) {
        thrown = cause;
        code = toUserFacing(cause).exitCode;
      }

      if (fault === 'closed') {
        nativeFailure = thrown instanceof CliError ? thrown.cause : thrown;
        expect(entered).toBe(1);
        expect(nativeFailure).toBeInstanceOf(TypeError);
        expect(nativeFailure).toMatchObject({ message: 'The database connection is not open' });
        expect(toUserFacing(nativeFailure).exitCode).toBe(9);
        expect(code, 'ACTUAL_NATIVE_CLOSED_CHECKPOINT_MUST_RETAIN_INFRASTRUCTURE').toBe(9);
        expect(f.registry.observations.exitCode()).toBe(9);
        expect(f.registry.termination).toBeDefined();
      } else {
        expect(code).toBe(fault === 'corrupt' ? 1 : 2);
        expect(f.registry.termination).toBeUndefined();
      }
      expect(f.registry.activeOwners).toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(client.sqlite.open).toBe(false);
    } finally {
      vi.restoreAllMocks();
      if (client.sqlite.open) client.sqlite.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
