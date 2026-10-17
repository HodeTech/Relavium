import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import { expect, it, vi } from 'vitest';

import { scriptedResolver } from '../chat/test-support.js';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { toUserFacing } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { gateCommand } from './gate.js';
import { runCommand } from './run.js';

const cases = (['run', 'gate'] as const).flatMap((surface) =>
  (['healthy', 'throw', 'reject', 'held'] as const).map((mode) => ({ surface, mode })),
);

it.each(cases)('$surface owns effect-retention warning mode=$mode', async ({ surface, mode }) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-retention-notice-')));
  const client = createClient(':memory:');
  runMigrations(client.db);
  const f = invocationFixture();
  const captured = captureIo();
  const source = JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'retention-notice',
      nodes: [
        { id: 'start', type: 'input' },
        ...(surface === 'gate'
          ? [{ id: 'approval', type: 'human_gate', gate_type: 'approval' }]
          : []),
        { id: 'out', type: 'output' },
      ],
      edges:
        surface === 'gate'
          ? [
              { from: 'start', to: 'approval' },
              { from: 'approval', to: 'out' },
            ]
          : [{ from: 'start', to: 'out' }],
    },
  });
  const path = join(dir, 'workflow.relavium.yaml');
  writeFileSync(path, source);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let closed = () => {};
  const closeEntered = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let writes = 0;
  let closes = 0;
  let settled = false;
  const prepare = client.sqlite.prepare.bind(client.sqlite);
  const prepareSpy = vi.spyOn(client.sqlite, 'prepare').mockImplementation((sql) => {
    if (/^\s*delete\s+from\s+"run_effects"/iu.test(sql))
      throw new Error('SYNTHETIC_PRIVATE_RETENTION_DRIVER');
    return prepare(sql);
  });
  const storeFor = (def: WorkflowDefinition) =>
    createRunHistoryStore(client.db, {
      uuid: randomUUID,
      now: Date.now,
      projectRoot: dir,
      workflow: {
        slug: def.workflow.id,
        name: def.workflow.id,
        definitionJson: JSON.stringify(def),
      },
    });
  const close = () => {
    closes++;
    client.sqlite.close();
    closed();
  };
  const deps = {
    invocation: f.invocation,
    subscribeSignals: () => () => {},
    providers: scriptedResolver([]),
    io: {
      ...captured.io,
      writeErrAcknowledged: (text: string) => {
        expect(text).toBe('warning: effect-journal retention could not be completed.\n');
        writes++;
        enter();
        if (mode === 'held') return held;
        if (mode === 'throw') throw new Error('SYNTHETIC_PRIVATE_RETENTION_SINK');
        if (mode === 'reject') return Promise.reject(new Error('SYNTHETIC_PRIVATE_RETENTION_SINK'));
        return captured.io.writeErrAcknowledged(text);
      },
    },
    global: {
      cwd: dir,
      json: false,
      color: false,
      configPath: join(dir, 'absent.toml'),
      verbosity: 'normal' as const,
    },
    sweepMedia: () => Promise.resolve(undefined),
  };
  const execute = async () => {
    if (surface === 'run')
      return runCommand(
        { workflow: path, input: [], allowMcpStdio: [] },
        {
          ...deps,
          openRunStore: (def, _home, _cwd, captureClose) => {
            captureClose?.(close);
            return {
              db: client.db,
              store: storeFor(def),
              close,
              terminalOutboxPath: join(dir, 'outbox.ndjson'),
            };
          },
        },
      );
    const def = parseWorkflow(source, { source: 'retention-notice-fixture' });
    const store = storeFor(def);
    const engine = await buildEngine({
      providers: deps.providers,
      host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    });
    const handle = engine.start({ workflow: def, inputs: {} });
    for await (const event of handle.events) if (event.type === 'run:paused') break;
    return gateCommand(
      { runId: handle.runId, approve: true },
      {
        ...deps,
        openDb: (_home, captureClose) => {
          captureClose?.(close);
          return { db: client.db, close };
        },
      },
    );
  };
  const action = execute()
    .catch((cause: unknown) => toUserFacing(cause).exitCode)
    .then((value) => {
      settled = true;
      return value;
    });
  try {
    expect(await Promise.race([entered.then(() => 'notice'), action.then(() => 'command')])).toBe(
      'notice',
    );
    if (mode === 'held') {
      await closeEntered;
      // The real command cleanup has closed SQLite; only the entered output delivery remains.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled, 'RETENTION_WARNING_DELIVERY_MUST_JOIN_COMMAND_COMPLETION').toBe(false);
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      release();
    }
    expect(await action, 'RETENTION_OUTPUT_FAILURE_REACHES_ORIGINAL_WORKFLOW').toBe(
      mode === 'throw' || mode === 'reject' ? 9 : 0,
    );
    expect(f.registry.observations.infrastructureCode()).toBe(
      mode === 'throw' || mode === 'reject' ? 'output_unavailable' : undefined,
    );
    expect(writes).toBe(1);
    expect(closes).toBe(1);
    expect(f.registry.activeOwners).toBe(0);
    expect(captured.out() + captured.err()).not.toContain('SYNTHETIC_PRIVATE');
    if (mode === 'healthy') expect(captured.err()).toContain('effect-journal retention');
  } finally {
    release();
    await action;
    await f.registry.terminate({ kind: 'normal' });
    prepareSpy.mockRestore();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
