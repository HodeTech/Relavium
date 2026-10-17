/** Synthetic inputs only; the parent owns this child and keeps its actual stdin pipe open. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseWorkflow } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import { buildEngine } from '../../engine/build-engine.js';
import { createCliHost } from '../../engine/host.js';
import { createCliInvocation } from '../../process/invocation.js';
import { captureIo } from '../../test-support.js';
import { gateCommand } from '../gate.js';
import { runCommand } from '../run.js';

const mode = process.argv[2];
const root = process.argv[3];
if (root === undefined || (mode !== 'run' && mode !== 'gate'))
  throw new Error('Fixture arguments required.');
const source = JSON.stringify({
  schema_version: '1.0',
  workflow: {
    id: 'native-secret-cancellation',
    inputs: [{ name: 'token', type: 'secret', required: true }],
    nodes: [
      { id: 'start', type: 'input' },
      { id: 'gate', type: 'human_gate', gate_type: 'approval' },
      { id: 'out', type: 'output' },
    ],
    edges: [
      { from: 'start', to: 'gate' },
      { from: 'gate', to: 'out' },
    ],
  },
});
const workflowPath = join(root, 'workflow.relavium.yaml');
const configPath = join(root, 'config.toml');
writeFileSync(workflowPath, source);
writeFileSync(configPath, '');
async function seedGate(root: string) {
  const client = createClient(join(root, 'owned.sqlite'));
  runMigrations(client.db);
  const workflow = parseWorkflow(source);
  const store = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    workflow: {
      slug: workflow.workflow.id,
      name: workflow.workflow.id,
      definitionJson: JSON.stringify(workflow),
    },
  });
  const engine = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
  });
  const handle = engine.start({
    workflow,
    inputs: { token: 'synthetic-unused' },
    eventConsumption: 'iterated',
  });
  const iterator = handle.events[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('Seed ended before gate.');
    if (next.value.type === 'run:paused') break;
  }
  if ((await handle.depart()).kind !== 'detached') throw new Error('Seed did not detach.');
  while (!(await iterator.next()).done) {
    /* Join seeded delivery. */
  }
  await iterator.return?.();
  return { client, runId: handle.runId };
}
const gate = mode === 'gate' ? await seedGate(root) : undefined;
const captured = process.stdin;
const ambient = new PassThrough();
const original = captured[Symbol.asyncIterator].bind(captured);
const events: string[] = [];
let keyCalls = 0,
  buildCalls = 0,
  dbCloses = 0,
  ambientReads = 0;
Object.defineProperty(captured, Symbol.asyncIterator, {
  value: () => {
    process.send?.({ type: 'ready', source: 'captured' });
    return original();
  },
});
const foreign = ambient[Symbol.asyncIterator].bind(ambient);
Object.defineProperty(ambient, Symbol.asyncIterator, {
  value: () => {
    ambientReads++;
    process.send?.({ type: 'ready', source: 'ambient' });
    return foreign();
  },
});
Object.defineProperty(process, 'stdin', { value: ambient });
captured.once('close', () => events.push('stdin-close'));
process.on('message', (message: unknown) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    Object.getOwnPropertyDescriptor(message, 'type')?.value === 'interrupt'
  )
    process.emit('SIGINT');
});
const invocation = createCliInvocation({
  exit: () => {
    throw new Error('Unexpected finite exit.');
  },
  setExitCode: () => {},
});
const deps = {
  invocation,
  io: { ...captureIo().io, stdin: captured },
  global: { json: true, color: false, verbosity: 'normal' as const, cwd: root, configPath },
  resolveKeys: () => {
    keyCalls++;
    throw new Error('Unexpected key entry.');
  },
  buildEngine: () => {
    buildCalls++;
    throw new Error('Unexpected engine entry.');
  },
};
try {
  const code =
    gate === undefined
      ? await runCommand(
          { workflow: workflowPath, input: [], allowMcpStdio: [], secretInputsStdin: true },
          deps,
        )
      : await gateCommand(
          { runId: gate.runId, approve: true, secretStdin: true },
          {
            ...deps,
            openDb: () => ({
              db: gate.client.db,
              close: () => {
                dbCloses++;
                events.push('db-close');
                gate.client.sqlite.close();
              },
            }),
          },
        );
  events.push('command-settled');
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({
      code,
      events,
      keyCalls,
      buildCalls,
      dbCloses,
      ambientReads,
      capturedClosed: captured.closed,
      ambientDestroyed: ambient.destroyed,
      owners: invocation.registry.activeOwners,
      terminating: invocation.registry.termination !== undefined,
      observedExit: invocation.registry.observations.exitCode(),
    }),
  );
} finally {
  if (gate?.client.sqlite.open) gate.client.sqlite.close();
  ambient.destroy();
  if (process.connected) process.disconnect();
}
