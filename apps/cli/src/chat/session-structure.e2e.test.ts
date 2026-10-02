import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWorkflow,
  buildRunPlan,
  reconstructSessionState,
  serializeWorkflow,
  sessionToWorkflow,
} from '@relavium/core';
import {
  createClient,
  createEffectJournalPort,
  createEffectJournalStore,
  createSessionStore,
  runMigrations,
} from '@relavium/db';
import { startMcpClient, type McpConnection } from '@relavium/mcp';
import type { StreamChunk } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { createSessionPersister } from './persister.js';
import {
  buildChatSession,
  buildResumedChatSession,
  type BuildChatSessionOptions,
  type BuiltChatSession,
} from './session-host.js';
import { scriptedResolver, textTurn, stop } from './test-support.js';

const chat: ResolvedChatConfig = {
  defaultModel: undefined,
  defaultProvider: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: false,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
  strictCostCap: false,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};
const call = (id: string, name = 'mcp_fs_read'): StreamChunk[] => [
  { type: 'tool_call_start', id, name },
  { type: 'tool_call_delta', id, argsJsonDelta: '{"value":"argument-sentinel-ş"}' },
  { type: 'tool_call_end', id },
  stop('tool_use'),
];

describe('session structure through the real CLI host and SQLite', () => {
  let root: string;
  let client: ReturnType<typeof createClient>;
  let store: ReturnType<typeof createSessionStore>;
  let id = 0;
  const builtHosts: BuiltChatSession[] = [];
  const persisters: ReturnType<typeof createSessionPersister>[] = [];
  const now = () => 1_790_900_000_000;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-w7-structure-'));
    client = createClient(join(root, 'history.db'));
    runMigrations(client.db);
    store = createSessionStore(client.db);
    id = 0;
    writeFileSync(
      join(root, 'mcp.agent.yaml'),
      'id: reader\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: Read things.\nmcp_servers:\n  - id: fs\n    transport: stdio\n    command: node\n',
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const persister of persisters.splice(0)) persister.close();
    for (const built of builtHosts.splice(0)) {
      built.session.cancel();
      await built.closeMcp?.();
    }
    client.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const connection: McpConnection = {
    listTools: () => Promise.resolve([{ name: 'read', inputSchema: { type: 'object' } }]),
    callTool: () =>
      Promise.resolve({ content: [{ type: 'text', text: 'result-sentinel' }], isError: false }),
    close: () => Promise.resolve(),
  };
  const connect = () => startMcpClient([{ id: 'fs', open: () => Promise.resolve(connection) }]);
  function attach(built: BuiltChatSession, initialSequenceNumber?: number) {
    builtHosts.push(built);
    const journal = createEffectJournalStore(client.db, { now, uuid: () => `effect-${++id}` });
    built.attachEffectJournal((correlation) =>
      createEffectJournalPort(journal, correlation, {
        providerAttempt: 0,
        toolCallId: 'wiring-sentinel',
      }),
    );
    const persister = createSessionPersister({
      store,
      governor: built.governor,
      attachDurabilityProbe: built.attachDurabilityProbe,
      attachEffectTurnAllocator: built.attachEffectTurnAllocator,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now,
      uuid: () => `message-${++id}`,
      ...(initialSequenceNumber === undefined ? {} : { initialSequenceNumber }),
    });
    persisters.push(persister);
    persister.start();
    if (initialSequenceNumber === undefined) built.session.start();
    return persister;
  }
  const fresh = (scripts: StreamChunk[][], overrides: Partial<BuildChatSessionOptions> = {}) =>
    buildChatSession({
      chat,
      agentRef: join(root, 'mcp.agent.yaml'),
      cwd: root,
      projectConfigDir: undefined,
      now,
      uuid: () => 'session',
      providers: scriptedResolver(scripts),
      onListenerError: () => undefined,
      startMcpClient: connect,
      consentGate: () => Promise.resolve(new Map()),
      ...overrides,
    });

  it('persists resolved MCP structure with exact per-call attempt joins and no raw strings', async () => {
    const built = await fresh([call('provider-sentinel-1'), call('provider-sentinel-2'), [stop()]]);
    const persister = attach(built);
    persister.beginUserTurn('read');
    await built.session.sendMessage('read');
    const full = store.loadFull('session');
    if (full === undefined) throw new Error('missing session');
    expect(full.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    const structures = full.messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'tool_call' || part.type === 'tool_result');
    expect(structures[0]).toEqual({
      type: 'tool_call',
      id: 'session-tool:1:0',
      name: 'mcp_fs_read',
      argsBytes: Buffer.byteLength('{"value":"argument-sentinel-ş"}'),
    });
    const rows = client.sqlite
      .prepare('SELECT scope, attempt_json AS attemptJson FROM run_effects ORDER BY slot')
      .all();
    expect(
      rows.map((row) => {
        if (
          typeof row !== 'object' ||
          row === null ||
          !('attemptJson' in row) ||
          typeof row.attemptJson !== 'string'
        )
          throw new Error('missing attempt');
        return JSON.parse(row.attemptJson) as unknown;
      }),
    ).toEqual([
      { providerAttempt: 1, toolCallId: 'session-tool:1:0' },
      { providerAttempt: 2, toolCallId: 'session-tool:1:1' },
    ]);
    expect(
      rows.map((row) => {
        if (typeof row !== 'object' || row === null || !('scope' in row))
          throw new Error('missing scope');
        return row.scope;
      }),
    ).toEqual(['session:session:1', 'session:session:1']);
    const exported = sessionToWorkflow(full.session, full.messages);
    expect(exported.workflow.nodes[1]).toMatchObject({ tools: ['mcp_fs_read'] });
    expect(parseWorkflow(serializeWorkflow(exported)).workflow.nodes).toEqual(
      exported.workflow.nodes,
    );
    const parsed = parseWorkflow(serializeWorkflow(exported));
    expect(() => buildRunPlan(parsed, { toolGrantsFinal: true })).toThrow();
    const rediscovered = await connect();
    try {
      const discoveredIds = rediscovered.toolDefs.map((tool) => tool.id);
      const plan = buildRunPlan(
        {
          ...parsed,
          workflow: {
            ...parsed.workflow,
            agents:
              parsed.workflow.agents?.map((agent) =>
                '$ref' in agent
                  ? agent
                  : { ...agent, tools: [...(agent.tools ?? []), ...discoveredIds] },
              ) ?? [],
          },
        },
        { toolGrantsFinal: true },
      );
      expect(plan.vertices.size).toBe(3);
    } finally {
      await rediscovered.close();
    }
    for (const sentinel of [
      'provider-sentinel',
      'argument-sentinel',
      'result-sentinel',
      'wiring-sentinel',
    ]) {
      expect(JSON.stringify(full.messages)).not.toContain(sentinel);
      expect(serializeWorkflow(exported)).not.toContain(sentinel);
    }
    expect(reconstructSessionState(full.session, full.messages)).toMatchObject({
      turnCount: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }],
    });
  });

  it('persists a fixed unknown marker after a hostile unresolved name, never granting that name on export', async () => {
    const built = await fresh([call('provider-sentinel', 'unresolved-name-sentinel'), [stop()]]);
    const persister = attach(built);
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');
    const full = store.loadFull('session');
    if (full === undefined) throw new Error('missing session');
    expect(full.messages[1]?.content[0]).toMatchObject({ type: 'tool_call', name: 'unknown_tool' });
    expect(full.messages[2]?.content[0]).toMatchObject({ type: 'tool_result', outcome: 'error' });
    const exported = sessionToWorkflow(full.session, full.messages);
    expect(exported.workflow.nodes[1]).not.toHaveProperty('tools');
    for (const sentinel of ['unresolved-name-sentinel', 'provider-sentinel', 'argument-sentinel'])
      expect(serializeWorkflow(exported)).not.toContain(sentinel);
  });

  it('maps compact and trim boundaries by complete turn, including empty finals, across resume/reseat', async () => {
    const built = await fresh([textTurn('first'), call('provider'), [stop()], textTurn('summary')]);
    const persister = attach(built);
    for (const text of ['one', 'two']) {
      persister.beginUserTurn(text);
      await built.session.sendMessage(text);
    }
    expect((await built.session.compact()).kind).toBe('compacted');
    let full = store.loadFull('session');
    if (full === undefined) throw new Error('missing session');
    expect(full.messages.at(-1)?.compaction).toEqual({ droppedThroughSequence: 1 });
    expect(reconstructSessionState(full.session, full.messages).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
    ]);
    persister.close();
    const resumed = await buildResumedChatSession({
      chat,
      record: full.session,
      messages: full.messages,
      now,
      providers: scriptedResolver([textTurn('continued')]),
      onListenerError: () => undefined,
      startMcpClient: connect,
      consentGate: () => Promise.resolve(new Map()),
    });
    const resumedPersister = attach(resumed, resumed.nextSequenceNumber);
    resumedPersister.beginUserTurn('three');
    await resumed.session.sendMessage('three');
    resumed.session.trimHistory(1);
    full = store.loadFull('session');
    if (full === undefined) throw new Error('missing resumed session');
    expect(full.messages.at(-1)?.compaction).toEqual({ droppedThroughSequence: 5 });
    expect(
      reconstructSessionState(full.session, full.messages).messages.map((message) => message.role),
    ).toEqual(['user', 'assistant']);
    expect(sessionToWorkflow(full.session, full.messages).workflow.nodes).toHaveLength(5); // all three historical turns
  });

  it('rolls back all split rows on a late store failure, then refuses new model and command egress', async () => {
    const built = await fresh([call('provider'), textTurn('answer'), textTurn('never')]);
    const persister = attach(built);
    const original = store.writeTurn;
    vi.spyOn(store, 'writeTurn').mockImplementation((turn) =>
      original({
        ...turn,
        messages: turn.messages.map((write, index) =>
          index === turn.messages.length - 1
            ? { ...write, meta: { content: 'mismatched' } }
            : write,
        ),
      }),
    );
    persister.beginUserTurn('one');
    await built.session.sendMessage('one');
    expect(store.loadMessages('session')).toEqual([]);
    expect(persister.durabilityFailure).toBeDefined();
    vi.restoreAllMocks();
    persister.beginUserTurn('two');
    await built.session.sendMessage('two');
    expect(await built.session.runUserCommand('ls', [])).toEqual({
      kind: 'failed',
      message: 'session effect identity could not be reserved',
    });
    expect(store.loadMessages('session')).toEqual([]);
    expect(
      client.sqlite
        .prepare('SELECT scope, attempt_json AS attemptJson FROM run_effects ORDER BY slot')
        .all(),
    ).toHaveLength(1);
  });

  it('refuses another idle command after a failed trim even with a cached command key', async () => {
    const spawn = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    );
    const built = await fresh([textTurn('first'), textTurn('second')], {
      chat: { ...chat, allowedCommands: ['ls'] },
      toolHost: { process: { spawn } },
    });
    const persister = attach(built);
    for (const text of ['first', 'second']) {
      persister.beginUserTurn(text);
      await built.session.sendMessage(text);
    }
    expect((await built.session.runUserCommand('ls', [])).kind).toBe('ran');
    const fail = vi.spyOn(store, 'writeTurn').mockImplementation(() => {
      throw new Error('synthetic-private-store-token');
    });
    built.session.trimHistory(2);
    expect(persister.durabilityFailure).toBeDefined();
    fail.mockRestore();
    const outcome = await built.session.runUserCommand('ls', []);
    expect(outcome.kind).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain('synthetic-private-store-token');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(client.sqlite.prepare('SELECT scope, slot FROM run_effects').all()).toEqual([
      { scope: 'session:session:3', slot: -1 },
    ]);
    expect(
      client.sqlite
        .prepare('SELECT effect_turn_high_water AS highWater FROM agent_sessions WHERE id = ?')
        .get('session'),
    ).toEqual({ highWater: 3 });
  });

  it('refuses a model effect when its attempt cost write has just latched a durability failure', async () => {
    const providers = scriptedResolver([call('provider'), textTurn('never')]);
    const provider = providers.resolveProvider('anthropic');
    if (provider === undefined) throw new Error('missing scripted provider');
    const egress = vi.spyOn(provider, 'stream');
    const built = await fresh([], { providers });
    const persister = attach(built);
    const dispatch = vi.spyOn(connection, 'callTool');
    vi.spyOn(store, 'recordSessionCost').mockImplementation(() => {
      throw new Error('synthetic-private-store-token');
    });
    persister.beginUserTurn('read');
    await built.session.sendMessage('read');
    expect(persister.durabilityFailure).toBeDefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(egress).toHaveBeenCalledTimes(1);
    expect(client.sqlite.prepare('SELECT id FROM run_effects').all()).toEqual([]);
    expect(store.loadMessages('session')).toEqual([]);
  });

  it('persists the resolved tool name after a real recoverable filesystem scope denial', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(root, 'outside.txt'), 'private-host-content');
    const agentRef = join(root, 'read.agent.yaml');
    writeFileSync(
      agentRef,
      'id: reader\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: Read things.\ntools: [read_file]\n',
    );
    const built = await fresh(
      [
        [
          { type: 'tool_call_start', id: 'provider-private-id', name: 'read_file' },
          {
            type: 'tool_call_delta',
            id: 'provider-private-id',
            argsJsonDelta: '{"path":"../outside.txt"}',
          },
          { type: 'tool_call_end', id: 'provider-private-id' },
          stop('tool_use'),
        ],
        textTurn('recovered'),
      ],
      { agentRef, cwd: workspace },
    );
    const persister = attach(built);
    persister.beginUserTurn('read');
    await built.session.sendMessage('read');
    const full = store.loadFull('session');
    if (full === undefined) throw new Error('missing persisted session');
    const parts = full.messages.flatMap((message) => message.content);
    expect(parts.find((part) => part.type === 'tool_call')).toMatchObject({ name: 'read_file' });
    expect(parts.find((part) => part.type === 'tool_result')).toMatchObject({ outcome: 'denied' });
    const exported = sessionToWorkflow(full.session, full.messages);
    expect(exported.workflow.nodes.find((node) => node.type === 'agent')).toMatchObject({
      tools: ['read_file'],
    });
    for (const sentinel of ['provider-private-id', '../outside.txt', 'private-host-content']) {
      expect(JSON.stringify(full.messages)).not.toContain(sentinel);
      expect(serializeWorkflow(exported)).not.toContain(sentinel);
    }
  });
});
