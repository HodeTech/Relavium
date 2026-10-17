/** Inert native fixture: real command/engine/SQLite/MCP manager, synthetic connection, no provider or spawn. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import { startMcpClient, type McpConnection } from '@relavium/mcp';
import { buildEngine } from '../../engine/build-engine.js';
import { createCliHost } from '../../engine/host.js';
import { createCliInvocation } from '../../process/invocation.js';
import { captureIo } from '../../test-support.js';
import { runCommand } from '../run.js';
import { gateCommand } from '../gate.js';

const mode = process.argv[2];
const root = process.argv[3];
if (root === undefined || mode === undefined) throw new Error('Owned fixture arguments required.');
const isGate = mode.startsWith('gate-');
const heldClose = mode.endsWith('build-fault');
const source = JSON.stringify({
  schema_version: '1.0',
  workflow: {
    id: 'workflow-native-cleanup',
    agents: [
      {
        id: 'unused',
        provider: 'openai',
        model: 'offline',
        system_prompt: 'offline',
        mcp_servers: [{ id: 'inert', transport: 'stdio', command: process.execPath }],
      },
    ],
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
const def = parseWorkflow(source);
const workflowPath = join(root, 'fixture.relavium.yaml');
const configPath = join(root, 'config.toml');
writeFileSync(workflowPath, source);
writeFileSync(configPath, '');
const client = createClient(join(root, 'owned.sqlite'));
runMigrations(client.db);
const store = createRunHistoryStore(client.db, {
  uuid: randomUUID,
  now: Date.now,
  projectRoot: root,
  workflow: { slug: def.workflow.id, name: def.workflow.id, definitionJson: JSON.stringify(def) },
});
let runId = '';
if (isGate) {
  const seed = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
  });
  const handle = seed.start({ workflow: def, inputs: {}, eventConsumption: 'iterated' });
  runId = handle.runId;
  const primary = handle.events[Symbol.asyncIterator]();
  for (;;) {
    const event = await primary.next();
    if (event.done) throw new Error('Fixture seed ended before pause.');
    if (event.value.type === 'run:paused') break;
  }
  const departed = await handle.depart();
  if (departed.kind !== 'detached') throw new Error('Fixture seed did not detach.');
  while (!(await primary.next()).done) {
    /* Join the seeded primary before resuming in a new owner. */
  }
  await primary.return?.();
}
const io = captureIo();
const invocation = createCliInvocation();
let closeCount = 0;
let dbCloseCount = 0;
let elapsedFrom = 0;
let settled = false;
const keepalive = setInterval(() => undefined, 1000);
process.on('exit', () => {
  writeFileSync(
    join(root, 'exit.json'),
    JSON.stringify({
      activeOwners: invocation.registry.activeOwners,
      dbOpen: client.sqlite.open,
      dbCloseCount,
      closeCount,
      settled,
      observedExit: invocation.registry.observations.exitCode(),
      elapsed: performance.now() - elapsedFrom,
      stdout: io.out(),
      stderr: io.err(),
    }),
  );
});
const connection: McpConnection = {
  listTools: () => Promise.resolve([]),
  callTool: () => Promise.resolve({ content: [], isError: false }),
  close: () => {
    closeCount++;
    process.send?.({ type: 'cleanup-entered' });
    return heldClose
      ? new Promise<never>(() => {})
      : Promise.reject(new Error('PRIVATE_NATIVE_CONNECTION_CLOSE'));
  },
};
const closeDb = (): void => {
  dbCloseCount++;
  client.sqlite.close();
};
const common = {
  invocation,
  io: io.io,
  global: { json: true, color: false, verbosity: 'normal' as const, cwd: root, configPath },
  providers: { resolveProvider: () => undefined, keyFor: () => 'synthetic-unused' },
  consentGate: () => Promise.resolve(new Map()),
  startMcpClient: () => startMcpClient([{ id: 'inert', open: () => Promise.resolve(connection) }]),
  ...(heldClose ? { buildEngine: () => Promise.reject(new Error('PRIVATE_BUILD_FAILURE')) } : {}),
};
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const type: unknown = Object.getOwnPropertyDescriptor(message, 'type')?.value;
  if (type === 'terminate') {
    elapsedFrom = performance.now();
    process.emit('SIGTERM');
    return;
  }
  if (type !== 'go') return;
  const pending = isGate
    ? gateCommand(
        { runId, approve: true },
        { ...common, openDb: () => ({ db: client.db, close: closeDb }) },
      )
    : runCommand(
        { workflow: workflowPath, input: [], allowMcpStdio: [] },
        {
          ...common,
          openRunStore: () => ({
            db: client.db,
            store,
            terminalOutboxPath: join(root, 'outbox.ndjson'),
            close: closeDb,
          }),
        },
      );
  void pending.then(
    () => {
      settled = true;
      process.send?.({ type: 'unexpected-settlement' });
    },
    () => {
      settled = true;
      process.send?.({ type: 'unexpected-settlement' });
    },
  );
});
process.on('SIGTERM', () => {
  if (elapsedFrom === 0) elapsedFrom = performance.now();
});
process.send?.({ type: 'ready' });
await new Promise<never>(() => {
  void keepalive;
});
