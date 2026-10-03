import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow, reconstructCheckpointState, type RunStore } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { buildServerToolDefs, type McpClient } from '@relavium/mcp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { budgetCommand, gateCommand, type GateCommandDeps } from './gate.js';
import { statusCommand } from './status.js';
import { createPlainRenderer } from '../render/renderer.js';
import { initialRunViewState, reduceRunEvent } from '../render/tui/run-view-model.js';

let root: string;
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) =>
      actual.loadResolvedConfig({ ...options, home: root }),
  };
});
const MODEL = 'offline-budget-command';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
let client: DbClient;
let calls: number;
let keyReads: number;
let factories: number;
let builds: number;
let prices: Map<string, ModelPricing>;
let toolMode: boolean;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-budget-command-'));
  client = createClient(':memory:');
  runMigrations(client.db);
  calls = 0;
  keyReads = 0;
  factories = 0;
  builds = 0;
  toolMode = false;
  prices = new Map([[MODEL, PRICE]]);
});
afterEach(() => {
  client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});
const provider: LlmProvider = {
  id: 'openai',
  customEndpoint: true,
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
  generate: () => Promise.reject(new Error('unexpected generate')),
  stream: async function* () {
    await Promise.resolve();
    calls++;
    if (toolMode && calls === 1) {
      yield { type: 'tool_call_start', id: 'mcp-read-1', name: 'mcp_fs_read' };
      yield { type: 'tool_call_delta', id: 'mcp-read-1', argsJsonDelta: '{}' };
      yield { type: 'tool_call_end', id: 'mcp-read-1' };
      yield {
        type: 'stop',
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      return;
    }
    yield { type: 'text_delta', text: 'ANSWER' };
    yield {
      type: 'stop',
      stopReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};
function providers() {
  return {
    resolveProvider: () => provider,
    keyFor: () => {
      keyReads++;
      return 'offline-key';
    },
    endpointKind: () => 'custom' as const,
  };
}
function reader() {
  return createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    workflow: {
      slug: 'budget-command',
      name: 'Budget command',
      definitionJson: '{}',
    },
  });
}
const mcpDefs = buildServerToolDefs('fs', [
  {
    name: 'read',
    description: 'Read fixture',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]).defs;
async function seed(
  options: {
    readonly mcp?: boolean;
    readonly secret?: boolean;
    readonly laterGate?: boolean;
  } = {},
): Promise<{ runId: string; gateId: string; amount: number }> {
  const { mcp = false, secret = false, laterGate = false } = options;
  const workflow = parseWorkflow(
    `schema_version: '1.0'\nworkflow:\n  id: budget-command\n${secret ? '  inputs: [{name: api_key, type: secret}]\n' : ''}  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}\n  agents:\n    - {id: worker, model: ${MODEL}, provider: openai, system_prompt: go${mcp ? ', tools: [mcp_fs_read], mcp_servers: [{id: fs, transport: stdio, command: node}]' : ''}}\n  nodes:\n    - {id: agent, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}\n${laterGate ? '    - {id: later, type: human_gate, gate_type: approval}\n' : ''}    - {id: out, type: output}\n  edges:\n${laterGate ? '    - {from: agent, to: later}\n    - {from: later, to: out}\n' : '    - {from: agent, to: out}\n'}`,
  );
  const store = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    projectRoot: root,
    workflow: {
      slug: workflow.workflow.id,
      name: 'Budget command',
      definitionJson: JSON.stringify(workflow),
    },
  });
  const engine = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    resolvePrice: prices,
    providers: providers(),
    ...(mcp
      ? {
          mcp: {
            toolDefs: mcpDefs,
            capability: {
              call: () => Promise.reject(new Error('unexpected original tool egress')),
            },
          },
        }
      : {}),
  });
  const handle = engine.start({
    workflow,
    inputs: secret ? { api_key: 'sk-fixture-budget-secret' } : {},
  });
  let gateId: string | undefined;
  let amount: number | undefined;
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
  if (gateId === undefined || amount === undefined)
    throw new Error('native producer did not pause with frozen amount');
  expect(calls).toBe(0);
  expect(keyReads).toBe(0);
  return { runId: handle.runId, gateId, amount };
}
function deps(io: ReturnType<typeof captureIo>['io']): GateCommandDeps {
  return {
    io,
    global: {
      json: false,
      color: false,
      cwd: root,
      configPath: undefined,
      verbosity: 'normal',
    },
    openDb: () => ({ db: client.db, close: () => undefined }),
    resolveKeys: () => {
      factories++;
      return {
        providers: providers(),
        mcpSecretResolver: () => {
          throw new Error('unexpected MCP secret');
        },
      };
    },
    buildEngine: (options) => {
      builds++;
      return buildEngine({ ...options, resolvePrice: prices });
    },
  };
}
for (const abort of [false, true]) {
  it(`native SQLite budget resume is binary and amount bounded (abort=${abort})`, async () => {
    const paused = await seed();
    const { io } = captureIo();
    expect(
      await budgetCommand(
        {
          runId: paused.runId,
          ...(abort ? { abort: true } : { approveAmount: String(paused.amount) }),
        },
        deps(io),
      ),
    ).toBe(abort ? 1 : 0);
    const rows = reader().loadRunEventLogForReplay(paused.runId);
    const authorization = rows.find(
      (event) => event.type === 'budget:authorization' && event.authorization.state === 'decided',
    );
    expect(authorization).toMatchObject({
      type: 'budget:authorization',
      gateId: paused.gateId,
      authorization: {
        state: 'decided',
        decision: abort ? 'rejected' : 'approved',
        ...(abort ? {} : { approvedAmountMicrocents: paused.amount }),
      },
    });
    expect(rows.at(-1)).toMatchObject(
      abort
        ? { type: 'run:failed', error: { code: 'budget_exceeded' } }
        : { type: 'run:completed' },
    );
    expect(factories).toBe(abort ? 0 : 1);
    expect(calls).toBe(abort ? 0 : 1);
    expect(keyReads).toBe(abort ? 0 : 1);
    expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
  });
}
it('wrong amount refuses before credential factory, engine build and decision writes', async () => {
  const paused = await seed();
  const before = reader().loadRunEventLogForReplay(paused.runId);
  const { io } = captureIo();
  await expect(
    budgetCommand({ runId: paused.runId, approveAmount: String(paused.amount + 1) }, deps(io)),
  ).rejects.toMatchObject({ code: 'invalid_invocation' });
  expect(factories).toBe(0);
  expect(builds).toBe(0);
  expect(calls).toBe(0);
  expect(keyReads).toBe(0);
  expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
  expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
});
it('changed price with the recorded amount remains pending without claim or egress', async () => {
  const paused = await seed();
  prices.set(MODEL, { ...PRICE, inputPerMtokMicrocents: 2000000 });
  const before = reader().loadRunEventLogForReplay(paused.runId);
  const { io } = captureIo();
  await expect(
    budgetCommand({ runId: paused.runId, approveAmount: String(paused.amount) }, deps(io)),
  ).rejects.toMatchObject({ code: 'invalid_invocation' });
  expect(calls).toBe(0);
  expect(keyReads).toBe(0);
  expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
  expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
});
it('ordinary gate command refuses a budget gate without credential factory or engine build', async () => {
  const paused = await seed();
  const { io } = captureIo();
  await expect(
    gateCommand({ runId: paused.runId, gate: paused.gateId, approve: true }, deps(io)),
  ).rejects.toMatchObject({ code: 'invalid_invocation' });
  expect(factories).toBe(0);
  expect(builds).toBe(0);
  expect(calls).toBe(0);
  expect(keyReads).toBe(0);
});
it('abort of an MCP-bearing frozen run starts no client and reads no credentials', async () => {
  const paused = await seed({ mcp: true });
  const { io } = captureIo();
  let starts = 0;
  const code = await budgetCommand(
    { runId: paused.runId, abort: true },
    {
      ...deps(io),
      startMcpClient: () => {
        starts++;
        return Promise.reject(new Error('unexpected spawn'));
      },
    },
  );
  expect(code).toBe(1);
  expect(starts).toBe(0);
  expect(factories).toBe(0);
  expect(calls).toBe(0);
  expect(keyReads).toBe(0);
  expect(reader().loadRunEventLogForReplay(paused.runId).at(-1)).toMatchObject({
    type: 'run:failed',
    error: { code: 'budget_exceeded' },
  });
});

for (const json of [false, true]) {
  it(`status displays native authority-only frozen amount without provenance (json=${json})`, async () => {
    const paused = await seed();
    const authority = reader()
      .loadRunEventLogForReplay(paused.runId)
      .find((event) => event.type === 'budget:authorization');
    if (authority === undefined) throw new Error('missing emitted authority');
    client.sqlite
      .prepare('DELETE FROM run_events WHERE run_id = ? AND seq > ?')
      .run(paused.runId, authority.sequenceNumber);
    const before = reader().loadRunEventLogForReplay(paused.runId);
    const { io, out } = captureIo();
    const baseDeps = deps(io);
    expect(
      await statusCommand({
        ...baseDeps,
        global: { ...baseDeps.global, json },
        readTerminalOutbox: () => Promise.resolve([]),
      }),
    ).toBe(0);
    if (json) {
      const records: unknown = JSON.parse(out().trim());
      expect(records).toMatchObject({
        pendingGates: [],
        pendingBudgetGates: [
          {
            gateId: paused.gateId,
            nodeId: 'agent',
            allowance: { kind: 'amount', microcents: paused.amount },
          },
        ],
      });
    } else {
      expect(out()).toContain(`pending budget gate ${paused.gateId}`);
      expect(out()).toContain(
        `approve: relavium budget resume ${paused.runId} --gate ${paused.gateId} --approve-amount ${paused.amount}`,
      );
      expect(out()).toContain(
        `reject: relavium budget resume ${paused.runId} --gate ${paused.gateId} --abort`,
      );
    }
    expect(out()).not.toContain(MODEL);
    expect(out()).not.toContain('provenance');
    expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
    expect(factories).toBe(0);
    expect(builds).toBe(0);
    expect(keyReads).toBe(0);
    expect(calls).toBe(0);
  });
}

it('native authority and companions render one scalar notice in plain and TUI views', async () => {
  const paused = await seed();
  const rows = reader().loadRunEventLogForReplay(paused.runId);
  const state = rows.reduce(reduceRunEvent, initialRunViewState());
  const notices = state.warnings.filter((line) => line.startsWith('budget gate '));
  expect(notices).toEqual([`budget gate ${paused.gateId} at agent — ${paused.amount} microcents`]);
  expect(state.warnings.join(' ')).not.toContain(MODEL);
  expect(state.warnings.join(' ')).not.toContain('awaiting input');
  const { io, out } = captureIo();
  const renderer = createPlainRenderer(io);
  for (const row of rows) renderer.onEvent(row);
  expect(out().split('pending budget gate ')).toHaveLength(2);
  expect(out()).toContain(`${paused.amount} microcents`);
  expect(out()).not.toContain(MODEL);
  expect(out()).not.toContain('provenance');
});

for (const removed of [false, true]) {
  it(`MCP budget resume preserves frozen registry and native tool dispatch (removed=${removed})`, async () => {
    const paused = await seed({ mcp: true });
    toolMode = true;
    const before = reader().loadRunEventLogForReplay(paused.runId);
    const { io } = captureIo();
    let consents = 0;
    let starts = 0;
    let closes = 0;
    let toolCalls = 0;
    const client: McpClient = {
      capability: {
        call: (input) => {
          toolCalls++;
          expect(input).toMatchObject({ server: 'fs', tool: 'read', args: {} });
          return Promise.resolve({
            content: [{ type: 'text', text: 'TOOL_RESULT' }],
            isError: false,
          });
        },
      },
      toolDefs: removed ? [] : mcpDefs,
      toolIdsByServer: new Map([['fs', removed ? [] : ['mcp_fs_read']]]),
      childPids: [],
      skipped: [],
      close: () => {
        closes++;
        return Promise.resolve();
      },
    };
    const command = budgetCommand(
      { runId: paused.runId, approveAmount: String(paused.amount) },
      {
        ...deps(io),
        consentGate: () => {
          consents++;
          return Promise.resolve(new Map());
        },
        startMcpClient: () => {
          starts++;
          return Promise.resolve(client);
        },
      },
    );
    if (removed) {
      await expect(command).rejects.toMatchObject({
        code: 'invalid_invocation',
      });
      expect(builds).toBe(0);
      expect(calls).toBe(0);
      expect(keyReads).toBe(0);
      expect(toolCalls).toBe(0);
      expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
    } else {
      expect(await command).toBe(0);
      expect(calls).toBe(2);
      expect(keyReads).toBe(2);
      expect(toolCalls).toBe(1);
      expect(reader().loadRunEventLogForReplay(paused.runId).at(-1)).toMatchObject({
        type: 'run:completed',
      });
    }
    expect(consents).toBe(1);
    expect(starts).toBe(1);
    expect(closes).toBe(1);
    expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
  });
}

it('secretful amount mismatch refuses before reading stdin or creating credentials', async () => {
  const paused = await seed({ secret: true });
  const { io } = captureIo();
  let reads = 0;
  await expect(
    budgetCommand(
      {
        runId: paused.runId,
        approveAmount: String(paused.amount + 1),
        secretStdin: true,
      },
      {
        ...deps(io),
        readSecretInput: () => {
          reads++;
          return Promise.resolve('api_key=another-value\n');
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'invalid_invocation' });
  expect(reads).toBe(0);
  expect(factories).toBe(0);
  expect(builds).toBe(0);
  expect(keyReads).toBe(0);
  expect(calls).toBe(0);
});
it('secretful budget refusal names its complete amount approval command', async () => {
  const paused = await seed({ secret: true });
  const { io } = captureIo();
  await expect(
    budgetCommand({ runId: paused.runId, approveAmount: String(paused.amount) }, deps(io)),
  ).rejects.toThrow(
    `relavium budget resume ${paused.runId} --gate ${paused.gateId} --approve-amount ${paused.amount} --secret-stdin`,
  );
  expect(factories).toBe(0);
  expect(builds).toBe(0);
  expect(keyReads).toBe(0);
  expect(calls).toBe(0);
});
it('secret stdin resumes the native budget and leaves a later ordinary gate pending without prompting', async () => {
  const paused = await seed({ secret: true, laterGate: true });
  const { io, out, err } = captureIo();
  let reads = 0;
  let selects = 0;
  const code = await budgetCommand(
    {
      runId: paused.runId,
      approveAmount: String(paused.amount),
      secretStdin: true,
    },
    {
      ...deps(io),
      readSecretInput: () => {
        reads++;
        return Promise.resolve('api_key=sk-resupplied-budget-secret\n');
      },
      selectGatePrompter: () => {
        selects++;
        return undefined;
      },
    },
  );
  expect(code).toBe(3);
  expect(reads).toBe(1);
  expect(selects).toBe(0);
  expect(calls).toBe(1);
  expect(keyReads).toBe(1);
  const rows = reader().loadRunEventLogForReplay(paused.runId);
  expect(rows.at(-1)).toMatchObject({ type: 'run:paused' });
  expect(JSON.stringify(rows)).not.toContain('sk-resupplied-budget-secret');
  expect(out() + err()).not.toContain('sk-resupplied-budget-secret');
  expect(rows).toContainEqual(
    expect.objectContaining({ type: 'human_gate:paused', nodeId: 'later' }),
  );
});

async function seedHumanMcp(): Promise<{ runId: string; gateId: string }> {
  const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: budget-command
  budget: {max_cost_microcents: 100000, on_exceed: pause_for_approval, strict_cost_cap: true}
  agents:
    - {id: worker, model: ${MODEL}, provider: openai, system_prompt: go, tools: [mcp_fs_read], mcp_servers: [{id: fs, transport: stdio, command: node}]}
  nodes:
    - {id: before, type: human_gate, gate_type: approval}
    - {id: agent, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}
    - {id: out, type: output}
  edges:
    - {from: before, to: agent}
    - {from: agent, to: out}
`);
  const store = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    projectRoot: root,
    workflow: {
      slug: workflow.workflow.id,
      name: 'Human MCP',
      definitionJson: JSON.stringify(workflow),
    },
  });
  const engine = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    resolvePrice: prices,
    providers: providers(),
    mcp: {
      toolDefs: mcpDefs,
      capability: {
        call: () => Promise.reject(new Error('unexpected original egress')),
      },
    },
  });
  const handle = engine.start({ workflow });
  let gateId: string | undefined;
  for await (const event of handle.events) {
    if (event.type === 'human_gate:paused') gateId = event.gateId;
    if (event.type === 'run:paused') break;
  }
  if (gateId === undefined) throw new Error('native producer did not pause at human gate');
  expect(calls).toBe(0);
  expect(keyReads).toBe(0);
  return { runId: handle.runId, gateId };
}

it('ordinary human resume reconnects frozen MCP with the original workspace and releases signal handlers', async () => {
  const paused = await seedHumanMcp();
  toolMode = true;
  const { io } = captureIo();
  const base = deps(io);
  const cwd = join(root, 'resumer');
  mkdirSync(cwd);
  const beforeSignals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  let starts = 0;
  let closes = 0;
  let toolCalls = 0;
  let consents = 0;
  const mcp: McpClient = {
    capability: {
      call: (input) => {
        toolCalls++;
        expect(input).toMatchObject({ server: 'fs', tool: 'read', args: {} });
        return Promise.resolve({
          content: [{ type: 'text', text: 'RESULT' }],
          isError: false,
        });
      },
    },
    toolDefs: mcpDefs,
    toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]),
    childPids: [],
    skipped: [],
    close: () => {
      closes++;
      return Promise.resolve();
    },
  };
  const code = await gateCommand(
    { runId: paused.runId, gate: paused.gateId, approve: true },
    {
      ...base,
      global: { ...base.global, cwd },
      consentGate: (refs, consentCwd) => {
        consents++;
        expect(refs).toHaveLength(1);
        expect(consentCwd).toBe(root);
        return Promise.resolve(new Map());
      },
      startMcpClient: () => {
        starts++;
        expect(process.listenerCount('SIGINT')).toBeGreaterThan(beforeSignals[0] ?? 0);
        return Promise.resolve(mcp);
      },
      buildEngine: (options) => {
        expect(options?.toolEnv?.workspaceDir).toBe(root);
        builds++;
        return buildEngine({ ...options, resolvePrice: prices });
      },
    },
  );
  expect(code).toBe(0);
  expect(starts).toBe(1);
  expect(closes).toBe(1);
  expect(consents).toBe(1);
  expect(toolCalls).toBe(1);
  expect(calls).toBe(2);
  expect(keyReads).toBe(2);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(
    beforeSignals,
  );
  expect(reader().loadRunEventLogForReplay(paused.runId).at(-1)).toMatchObject({
    type: 'run:completed',
  });
  expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
});

it('MCP consent refusal precedes spawn, engine construction and decision writes', async () => {
  const paused = await seed({ mcp: true });
  const before = reader().loadRunEventLogForReplay(paused.runId);
  const { io } = captureIo();
  let starts = 0;
  const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  await expect(
    budgetCommand(
      { runId: paused.runId, approveAmount: String(paused.amount) },
      {
        ...deps(io),
        consentGate: () => Promise.reject(new Error('fixture consent declined')),
        startMcpClient: () => {
          starts++;
          return Promise.reject(new Error('unexpected spawn'));
        },
      },
    ),
  ).rejects.toThrow('fixture consent declined');
  expect(starts).toBe(0);
  expect(builds).toBe(0);
  expect(keyReads).toBe(0);
  expect(calls).toBe(0);
  expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
  expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
});

for (const priceRefusal of [false, true]) {
  it(`MCP close fault preserves the primary budget result (priceRefusal=${priceRefusal})`, async () => {
    const paused = await seed({ mcp: true });
    if (priceRefusal) prices.set(MODEL, { ...PRICE, inputPerMtokMicrocents: 2000000 });
    const before = reader().loadRunEventLogForReplay(paused.runId);
    const { io, out, err } = captureIo();
    let closes = 0;
    let dbCloses = 0;
    const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const mcp: McpClient = {
      capability: { call: () => Promise.reject(new Error('unexpected tool')) },
      toolDefs: mcpDefs,
      toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]),
      childPids: [],
      skipped: [],
      close: () => {
        closes++;
        return Promise.reject(new Error('PRIVATE fixture close path'));
      },
    };
    const command = budgetCommand(
      { runId: paused.runId, approveAmount: String(paused.amount) },
      {
        ...deps(io),
        openDb: () => ({
          db: client.db,
          close: () => {
            dbCloses++;
          },
        }),
        consentGate: () => Promise.resolve(new Map()),
        startMcpClient: () => Promise.resolve(mcp),
      },
    );
    if (priceRefusal) {
      await expect(command).rejects.toMatchObject({
        code: 'invalid_invocation',
      });
      expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
      expect(calls).toBe(0);
      expect(keyReads).toBe(0);
    } else {
      expect(await command).toBe(0);
      expect(calls).toBe(1);
      expect(keyReads).toBe(1);
      expect(reader().loadRunEventLogForReplay(paused.runId).at(-1)).toMatchObject({
        type: 'run:completed',
      });
    }
    expect(closes).toBe(1);
    expect(dbCloses).toBe(1);
    expect(out() + err()).not.toContain('PRIVATE');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
    expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
  });
}

it('a doubled completed budget decision is an idempotent no-op before rebuilding credentials or engine', async () => {
  const paused = await seed();
  const { io } = captureIo();
  const args = {
    runId: paused.runId,
    gate: paused.gateId,
    approveAmount: String(paused.amount),
  };
  expect(await budgetCommand(args, deps(io))).toBe(0);
  const before = reader().loadRunEventLogForReplay(paused.runId);
  const counts = { calls, keyReads, factories, builds };
  expect(await budgetCommand(args, deps(io))).toBe(0);
  expect({ calls, keyReads, factories, builds }).toEqual(counts);
  expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
});

async function seedMultipleGates(secret = false): Promise<{
  runId: string;
  budgetGates: readonly { gateId: string; amount: number }[];
  humanGateId: string;
}> {
  const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: budget-command
${secret ? '  inputs: [{name: api_key, type: secret}]\n' : ''}  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}
  agents:
    - {id: worker, model: ${MODEL}, provider: openai, system_prompt: go}
  nodes:
    - {id: agent-one, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}
    - {id: agent-two, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}
    - {id: ordinary, type: human_gate, gate_type: approval}
    - {id: out, type: output}
  edges:
    - {from: agent-one, to: out}
    - {from: agent-two, to: out}
    - {from: ordinary, to: out}
`);
  const store = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    projectRoot: root,
    workflow: {
      slug: workflow.workflow.id,
      name: 'Multiple gates',
      definitionJson: JSON.stringify(workflow),
    },
  });
  const engine = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    resolvePrice: prices,
    providers: providers(),
  });
  const handle = engine.start({
    workflow,
    inputs: secret ? { api_key: 'sk-fixture-multiple-secret' } : {},
  });
  const budgetGates: { gateId: string; amount: number }[] = [];
  let humanGateId: string | undefined;
  let pausedCompanions = 0;
  for await (const event of handle.events) {
    if (event.type === 'budget:authorization' && event.authorization.state === 'paused') {
      const a = event.authorization.allowance;
      if (
        a.kind !== 'frozen' ||
        a.quote.kind !== 'quoted' ||
        a.quote.quote.amount.kind !== 'representable'
      )
        throw new Error('missing native allowance');
      budgetGates.push({
        gateId: event.gateId,
        amount: a.quote.quote.amount.microcents,
      });
    }
    if (event.type === 'human_gate:paused') {
      pausedCompanions++;
      if (event.nodeId === 'ordinary') humanGateId = event.gateId;
    }
    if (
      event.type === 'human_gate:paused' &&
      budgetGates.length === 2 &&
      humanGateId !== undefined &&
      pausedCompanions === 3
    )
      break;
  }
  if (humanGateId === undefined || budgetGates.length !== 2)
    throw new Error('native producer did not pause all three gates');
  await expect
    .poll(() => createRunLeasePort(store).read(handle.runId), {
      timeout: 300,
      interval: 10,
    })
    .toBeUndefined();
  return { runId: handle.runId, budgetGates, humanGateId };
}

it('multiple native budget gates require an explicit selection and preserve an ordinary sibling across resumes', async () => {
  const paused = await seedMultipleGates();
  const [first, second] = paused.budgetGates;
  if (first === undefined || second === undefined) throw new Error('missing gates');
  const { io } = captureIo();
  const before = reader().loadRunEventLogForReplay(paused.runId);
  await expect(
    budgetCommand({ runId: paused.runId, approveAmount: String(first.amount) }, deps(io)),
  ).rejects.toThrow(/more than one budget gate/);
  expect(factories).toBe(0);
  expect(builds).toBe(0);
  expect(keyReads).toBe(0);
  expect(calls).toBe(0);
  expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
  expect(
    await budgetCommand(
      {
        runId: paused.runId,
        gate: first.gateId,
        approveAmount: String(first.amount),
      },
      deps(io),
    ),
  ).toBe(3);
  const checkpoint = reconstructCheckpointState(reader().loadRunEventLogForReplay(paused.runId));
  expect(checkpoint?.pendingGates.map((gate) => gate.gateId).sort()).toEqual(
    [second.gateId, paused.humanGateId].sort(),
  );
  expect(calls).toBe(1);
  expect(keyReads).toBe(1);
  expect(
    await gateCommand({ runId: paused.runId, gate: paused.humanGateId, approve: true }, deps(io)),
  ).toBe(3);
  expect(
    reconstructCheckpointState(reader().loadRunEventLogForReplay(paused.runId))?.pendingGates.map(
      (gate) => gate.gateId,
    ),
  ).toEqual([second.gateId]);
  expect(calls).toBe(1);
  expect(
    await budgetCommand(
      {
        runId: paused.runId,
        gate: second.gateId,
        approveAmount: String(second.amount),
      },
      deps(io),
    ),
  ).toBe(0);
  expect(calls).toBe(2);
  expect(keyReads).toBe(2);
  expect(reader().loadRunEventLogForReplay(paused.runId).at(-1)).toMatchObject({
    type: 'run:completed',
  });
  expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
});

it('a native zero allowance after a paid node can be explicitly approved with --approve-amount 0', async () => {
  const ZERO = 'offline-zero-command';
  prices.set(ZERO, {
    ...PRICE,
    nativeId: ZERO,
    inputPerMtokMicrocents: 0,
    outputPerMtokMicrocents: 0,
    cachedInputPerMtokMicrocents: 0,
  });
  const workflow = parseWorkflow(`schema_version: '1.0'
workflow:
  id: budget-command
  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}
  agents:
    - {id: paid, model: ${MODEL}, provider: openai, system_prompt: go}
    - {id: free, model: ${ZERO}, provider: openai, system_prompt: go}
  nodes:
    - {id: paid-node, type: agent, agent_ref: paid, prompt_template: hello, max_tokens: 64}
    - {id: free-node, type: agent, agent_ref: free, prompt_template: hello, max_tokens: 64}
    - {id: out, type: output}
  edges:
    - {from: paid-node, to: free-node}
    - {from: free-node, to: out}
`);
  const store = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    projectRoot: root,
    workflow: {
      slug: workflow.workflow.id,
      name: 'Zero allowance',
      definitionJson: JSON.stringify(workflow),
    },
  });
  const engine = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    resolvePrice: prices,
    providers: providers(),
  });
  const handle = engine.start({ workflow });
  let firstGate: string | undefined;
  let firstAmount: number | undefined;
  for await (const event of handle.events) {
    if (event.type === 'budget:authorization' && event.authorization.state === 'paused') {
      firstGate = event.gateId;
      const a = event.authorization.allowance;
      if (
        a.kind === 'frozen' &&
        a.quote.kind === 'quoted' &&
        a.quote.quote.amount.kind === 'representable'
      )
        firstAmount = a.quote.quote.amount.microcents;
    }
    if (event.type === 'run:paused') break;
  }
  if (firstGate === undefined || firstAmount === undefined)
    throw new Error('missing first native allowance');
  const { io } = captureIo();
  expect(
    await budgetCommand(
      {
        runId: handle.runId,
        gate: firstGate,
        approveAmount: String(firstAmount),
      },
      deps(io),
    ),
  ).toBe(3);
  const cp = reconstructCheckpointState(reader().loadRunEventLogForReplay(handle.runId));
  const zero = cp?.pendingGates.find((gate) => gate.nodeId === 'free-node');
  expect(zero?.allowance).toMatchObject({
    kind: 'frozen',
    quote: {
      kind: 'quoted',
      quote: { amount: { kind: 'representable', microcents: 0 } },
    },
  });
  if (zero === undefined) throw new Error('missing native zero gate');
  expect(
    await budgetCommand({ runId: handle.runId, gate: zero.gateId, approveAmount: '0' }, deps(io)),
  ).toBe(0);
  expect(calls).toBe(2);
  expect(keyReads).toBe(2);
  expect(reader().loadRunEventLogForReplay(handle.runId).at(-1)).toMatchObject({
    type: 'run:completed',
  });
  expect(await createRunLeasePort(reader()).read(handle.runId)).toBeUndefined();
});

for (const kind of ['budget', 'human'] as const) {
  it(`secret re-provision hint preserves explicitly selected ${kind} gate among native siblings`, async () => {
    const paused = await seedMultipleGates(true);
    const first = paused.budgetGates[0];
    if (first === undefined) throw new Error('missing native budget gate');
    const { io } = captureIo();
    const before = reader().loadRunEventLogForReplay(paused.runId);
    const invoke =
      kind === 'budget'
        ? budgetCommand(
            {
              runId: paused.runId,
              gate: first.gateId,
              approveAmount: String(first.amount),
            },
            deps(io),
          )
        : gateCommand({ runId: paused.runId, gate: paused.humanGateId, approve: true }, deps(io));
    const command =
      kind === 'budget'
        ? `relavium budget resume ${paused.runId} --gate ${first.gateId} --approve-amount ${first.amount} --secret-stdin`
        : `relavium gate ${paused.runId} --gate ${paused.humanGateId} --approve --secret-stdin`;
    await expect(invoke).rejects.toThrow(command);
    expect(factories).toBe(0);
    expect(builds).toBe(0);
    expect(keyReads).toBe(0);
    expect(calls).toBe(0);
    expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
    expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
  });
}

for (const phase of ['connect', 'build', 'build_without_mcp'] as const) {
  it(`Ctrl-C during ${phase} keeps the native budget gate pending and returns runtime failure`, async () => {
    const paused = await seed({ mcp: phase !== 'build_without_mcp' });
    const before = reader().loadRunEventLogForReplay(paused.runId);
    const { io, out, err } = captureIo();
    const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    let closes = 0;
    let dbCloses = 0;
    const mcp: McpClient = {
      capability: { call: () => Promise.reject(new Error('unexpected tool')) },
      toolDefs: mcpDefs,
      toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]),
      childPids: [],
      skipped: [],
      close: () => {
        closes++;
        return Promise.resolve();
      },
    };
    const code = await budgetCommand(
      { runId: paused.runId, approveAmount: String(paused.amount) },
      {
        ...deps(io),
        global: { ...deps(io).global, json: true },
        openDb: () => ({
          db: client.db,
          close: () => {
            dbCloses++;
          },
        }),
        consentGate: () => Promise.resolve(new Map()),
        startMcpClient: () => {
          if (phase === 'connect') {
            process.emit('SIGINT');
            return Promise.reject(new Error('PRIVATE aborted connect detail'));
          }
          return Promise.resolve(mcp);
        },
        buildEngine: async (options) => {
          builds++;
          const engine = await buildEngine({
            ...options,
            resolvePrice: prices,
          });
          expect(process.listenerCount('SIGINT')).toBeGreaterThan(signals[0] ?? 0);
          process.emit('SIGINT');
          return engine;
        },
      },
    );
    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(err()).toContain(
      'resume interrupted before a decision was recorded; the gate remains pending',
    );
    expect(err()).not.toContain('PRIVATE');
    expect(calls).toBe(0);
    expect(keyReads).toBe(0);
    expect(builds).toBe(phase === 'connect' ? 0 : 1);
    expect(dbCloses).toBe(1);
    expect(closes).toBe(phase === 'build' ? 2 : 0);
    expect(reader().loadRunEventLogForReplay(paused.runId)).toEqual(before);
    expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
  });
}

for (const interrupt of [false, true]) {
  it(`native SQLite approval contention preserves cancellation intent (interrupt=${interrupt})`, async () => {
    client.sqlite.close();
    const file = join(root, 'busy-approval.db');
    client = createClient(file);
    runMigrations(client.db, { dbPath: file });
    client.sqlite.pragma('busy_timeout = 0');
    const blocker = createClient(file);
    const paused = await seed();
    const { io } = captureIo();
    const signals = process.listenerCount('SIGINT');
    let blocked = false;
    let interrupted = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      const code = await budgetCommand(
        { runId: paused.runId, gate: paused.gateId, approveAmount: String(paused.amount) },
        {
          ...deps(io),
          buildEngine: (options) => {
            if (options?.host === undefined) throw new Error('missing actual command host');
            const host = options.host;
            const store: RunStore = {
              ...host.store,
              persistEvent: async (event, context) => {
                if (
                  !blocked &&
                  event.type === 'budget:authorization' &&
                  event.authorization.state === 'decided'
                ) {
                  blocked = true;
                  blocker.sqlite.exec('BEGIN IMMEDIATE');
                  if (interrupt)
                    timers.push(
                      setTimeout(() => {
                        interrupted = true;
                        // Unit-level signal dispatch; actual OS delivery is covered by the bounded child proof.
                        process.emit('SIGINT');
                      }, 1),
                    );
                  timers.push(setTimeout(() => blocker.sqlite.exec('COMMIT'), 15));
                }
                return host.store.persistEvent(event, context);
              },
            };
            return buildEngine({ ...options, host: { ...host, store }, resolvePrice: prices });
          },
        },
      );
      expect(blocked).toBe(true);
      expect(interrupted).toBe(interrupt);
      expect(code).toBe(interrupt ? 1 : 0);
      expect(calls).toBe(interrupt ? 0 : 1);
      expect(keyReads).toBe(interrupt ? 0 : 1);
      const rows = reader().loadRunEventLogForReplay(paused.runId);
      // A successful late decision append stays durable; cancellation prevents its dispatch.
      expect(rows.filter((event) => event.type === 'budget:authorization')).toHaveLength(2);
      expect(rows.at(-1)?.type).toBe(interrupt ? 'run:cancelled' : 'run:completed');
      expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
      expect(process.listenerCount('SIGINT')).toBe(signals);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      if (blocker.sqlite.inTransaction) blocker.sqlite.exec('ROLLBACK');
      blocker.sqlite.close();
    }
  });
}

it('a command interrupt during asynchronous effect admission reaches the passively preparing engine', async () => {
  const paused = await seed();
  const { io } = captureIo();
  let interrupted = false;
  const code = await budgetCommand(
    { runId: paused.runId, approveAmount: String(paused.amount) },
    {
      ...deps(io),
      buildEngine: (options) => {
        if (options?.effectResume === undefined)
          throw new Error('missing actual effect resume port');
        const effects = options.effectResume;
        return buildEngine({
          ...options,
          resolvePrice: prices,
          effectResume: {
            unresolvedForRun: async (runId) => {
              const rows = await effects.unresolvedForRun(runId);
              interrupted = true;
              process.emit('SIGINT');
              return rows;
            },
          },
        });
      },
    },
  );
  expect(interrupted).toBe(true);
  expect(code).toBe(1);
  expect(calls).toBe(0);
  expect(keyReads).toBe(0);
  const rows = reader().loadRunEventLogForReplay(paused.runId);
  expect(rows.filter((event) => event.type === 'budget:authorization')).toHaveLength(1);
  expect(rows.at(-1)).toMatchObject({ type: 'run:cancelled' });
  expect(await createRunLeasePort(reader()).read(paused.runId)).toBeUndefined();
});
