import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { parseWorkflow } from '@relavium/core';
import { RunEventSchema, RunSuspensionCorruptionError } from '@relavium/shared';
import { createHistoryCheckpointer } from '../engine/checkpointer.js';
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
import { toUserFacing } from '../process/errors.js';
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
describe('actual SQLite typed checkpoint fold corruption', () => {
  it.each([
    ['gate', 'direct'],
    ['gate', 'dispatch'],
  ] as const)('%s %s', async (surface, route) => {
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
    const events = store.loadRunEventLog(handle.runId).events;
    const paused = events.find((event) => event.type === 'human_gate:paused');
    if (paused === undefined) throw new Error('expected real paused event');
    const sequenceNumber = Math.max(...events.map((event) => event.sequenceNumber)) + 1;
    const conflict = RunEventSchema.parse({
      ...paused,
      sequenceNumber,
      nodeId: 'different-valid-node',
    });
    client.sqlite
      .prepare(
        'INSERT INTO run_events(id,run_id,seq,event_type,node_id,payload_json,ts) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        handle.runId,
        sequenceNumber,
        conflict.type,
        'different-valid-node',
        JSON.stringify(conflict),
        Date.now(),
      );
    // Every row passes the actual strict parser/projection before the relational fold refuses reuse.
    expect(store.loadRunEventLogForReplay(handle.runId)).toHaveLength(events.length + 1);
    const foldFailure = await createHistoryCheckpointer(store)
      .load(handle.runId)
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(foldFailure).toBeInstanceOf(RunSuspensionCorruptionError);
    expect(foldFailure).toMatchObject({ code: 'gate_identity_conflict' });
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
    let code: number | undefined;
    try {
      const runId = handle.runId;
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
        code = toUserFacing(cause).exitCode;
      }
      expect(code, 'TYPED_GATE_FOLD_CORRUPTION_REMAINS_OPERATIONAL').toBe(1);
      expect(f.registry.observations.exitCode()).toBe(1);
      expect(f.registry.termination).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
      expect(client.sqlite.open).toBe(false);
      expect(f.registry.activeOwners).toBe(0);
    } finally {
      vi.restoreAllMocks();
      if (client.sqlite.open) client.sqlite.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
