// Offline fixture producer using public built packages and a real migrated SQLite store.
// The reference host supplies timers only; UUIDs, wall clock, events and leases are durable/native.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { setImmediate, setTimeout as sleep } from 'node:timers/promises';
import {
  BUILTIN_TOOLS,
  WorkflowEngine,
  createExpressionSandbox,
  createInMemoryHost,
  createStandardNodeExecutor,
  createToolRegistry,
  parseWorkflow,
} from '../../packages/core/dist/index.js';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '../../packages/db/dist/index.js';
import { CapabilityFlagsSchema } from '../../packages/llm/dist/index.js';
import { buildServerToolDefs } from '../../packages/mcp/dist/index.js';

const home = process.argv[2];
const fixture = process.argv[3];
assert.ok(home, 'An explicit temporary fixture home is required');
const historyDir = join(home, '.relavium');
mkdirSync(historyDir, { recursive: true, mode: 0o700 });
chmodSync(historyDir, 0o700);
const model = 'gpt-5.4-mini';
let keys = 0;
let providerCalls = 0;
const provider = {
  id: 'openai',
  customEndpoint: false,
  supports: CapabilityFlagsSchema.parse({
    tools: true,
    streaming: true,
    parallelToolCalls: false,
    vision: false,
    promptCache: false,
    reasoning: false,
    media: {
      input: { image: false, audio: false, video: false, document: false },
      outputCombinations: [['text']],
      surface: 'chat',
    },
  }),
  generate: () => {
    providerCalls++;
    throw new Error('Offline fixture provider forbidden');
  },
  stream: () => {
    providerCalls++;
    throw new Error('Offline fixture provider forbidden');
  },
};
const definition = parseWorkflow(
  JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'native-budget-process',
      budget: {
        max_cost_microcents: 1,
        on_exceed: 'pause_for_approval',
        strict_cost_cap: true,
      },
      agents: [
        {
          id: 'worker',
          model,
          provider: 'openai',
          system_prompt: 'go',
          ...(fixture === undefined
            ? {}
            : {
                tools: ['mcp_silent_ping'],
                mcp_servers: [
                  {
                    id: 'silent',
                    transport: 'stdio',
                    command: process.execPath,
                    args: [fixture],
                  },
                ],
              }),
        },
      ],
      nodes: [
        {
          id: 'agent',
          type: 'agent',
          agent_ref: 'worker',
          prompt_template: 'hello',
          max_tokens: 64,
        },
      ],
      edges: [],
    },
  }),
);
const client = createClient(join(historyDir, 'history.db'));
try {
  chmodSync(client.path, 0o600);
  runMigrations(client.db, { dbPath: client.path });
  const store = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    projectRoot: home,
    workflow: {
      slug: definition.workflow.id,
      name: 'Offline budget smoke',
      definitionJson: JSON.stringify(definition),
    },
  });
  const leases = createRunLeasePort(store);
  const reference = createInMemoryHost({ store, runLeases: leases });
  const host = {
    ...reference,
    clock: { now: () => new Date().toISOString() },
    ids: { newId: randomUUID },
  };
  const toolDefs = buildServerToolDefs('silent', [
    {
      name: 'ping',
      description: 'Offline probe',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ]).defs;
  const tools = fixture === undefined ? BUILTIN_TOOLS : [...BUILTIN_TOOLS, ...toolDefs];
  const registry = createToolRegistry({
    tools,
    host:
      fixture === undefined
        ? {}
        : {
            mcp: {
              call: () => Promise.reject(new Error('Offline fixture tool dispatch forbidden')),
            },
          },
  });
  const sandbox = await createExpressionSandbox();
  const engine = new WorkflowEngine({
    host,
    executor: createStandardNodeExecutor({
      sandbox,
      humanGate: {},
      agent: {
        resolveProvider: () => provider,
        keyFor: () => {
          keys++;
          throw new Error('Offline fixture key resolution forbidden');
        },
        registry,
        tools,
        sleep,
        newAbortController: () => new globalThis.AbortController(),
        setTimer: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
        now: Date.now,
      },
    }),
  });
  const handle = engine.start({ workflow: definition });
  let gateId;
  let amount;
  for await (const event of handle.events) {
    if (event.type === 'budget:authorization' && event.authorization.state === 'paused') {
      gateId = event.gateId;
      const allowance = event.authorization.allowance;
      if (
        allowance.kind === 'frozen' &&
        allowance.quote.kind === 'quoted' &&
        allowance.quote.quote.amount.kind === 'representable'
      )
        amount = allowance.quote.quote.amount.microcents;
    }
    if (event.type === 'run:paused') break;
  }
  assert.ok(
    gateId && Number.isSafeInteger(amount),
    'Actual producer must record a frozen representable amount',
  );
  let parked = false;
  for (let turn = 0; turn < 100; turn++) {
    if ((await leases.read(handle.runId)) === undefined) {
      parked = true;
      break;
    }
    await setImmediate();
  }
  assert.ok(parked, 'Producer must release its idle lease');
  assert.equal(keys, 0);
  assert.equal(providerCalls, 0);
  process.stdout.write(
    JSON.stringify({
      runId: handle.runId,
      gateId,
      amount,
      keys,
      providerCalls,
    }) + '\n',
  );
} finally {
  client.sqlite.close();
}
