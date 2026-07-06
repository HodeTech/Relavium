import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BudgetExceededError, BudgetPauseError } from '@relavium/core';
import type { SessionStreamHandleEvent } from '@relavium/core';
import {
  buildServerToolDefs,
  startMcpClient as realStartMcpClient,
  type McpClient,
  type McpConnection,
} from '@relavium/mcp';
import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { createMcpSecretResolver } from '../secrets/mcp-secret.js';
import type { LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';

import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { createChatModeControl } from '../commands/chat.js';
import type { ProviderResolver } from '../engine/providers.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { applyChatMode, makeChatModeEnv } from './chat-mode-host.js';
import { buildDefaultChatAgent } from './default-agent.js';
import {
  buildChatSession,
  buildGovernorWiring,
  buildResumedChatSession,
  swapAgentModel,
  type ChatBudgetWarning,
} from './session-host.js';
import {
  drainHandle,
  scriptedResolver,
  stop,
  textTurn,
  toolUseTurn,
  unresolvedResolver,
} from './test-support.js';

/** A tool-call turn that carries JSON args (the `toolUseTurn` helper sends none) — for read_file/write_file. */
const callWithArgs = (id: string, name: string, args: unknown): StreamChunk[] => [
  { type: 'tool_call_start', id, name },
  { type: 'tool_call_delta', id, argsJsonDelta: JSON.stringify(args) },
  { type: 'tool_call_end', id },
  stop('tool_use'),
];

/** A resolver whose provider records each request's advertised `tools` — for the advertise-filter assertion. */
function capturingResolver(scripts: StreamChunk[][]): {
  providers: ProviderResolver;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  let call = 0;
  const provider: LlmProvider = {
    id: 'anthropic',
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: () => {
      throw new Error('capturingResolver.generate is not used');
    },
    stream: (req) => {
      requests.push(req);
      const chunks = scripts[call++] ?? [];
      return (async function* () {
        await Promise.resolve();
        for (const c of chunks) yield c;
      })();
    },
  };
  return {
    providers: {
      resolveProvider: (id) => (id === 'anthropic' ? provider : undefined),
      keyFor: () => 'test-key',
    },
    requests,
  };
}

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};

function deterministicIds() {
  let tick = Date.parse('2026-06-25T00:00:00.000Z');
  return { now: () => tick++, uuid: () => 'sess-test-1' };
}

function build(overrides: Partial<Parameters<typeof buildChatSession>[0]> = {}) {
  const { now, uuid } = deterministicIds();
  return buildChatSession({
    chat: EMPTY_CHAT,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now,
    uuid,
    providers: scriptedResolver([textTurn('hello there')]),
    ...overrides,
  });
}

describe('buildChatSession', () => {
  it('mints the session over the default agent + a handle scoped to the same id', async () => {
    const built = await build({ chat: { ...EMPTY_CHAT, defaultModel: 'claude-sonnet-4-6' } });
    expect(built.sessionId).toBe('sess-test-1');
    expect(built.handle.sessionId).toBe('sess-test-1');
    expect(built.agent.id).toBe('relavium-chat');
    expect(built.agent.model).toBe('claude-sonnet-4-6');
    expect(built.context.workingDir).toBe('/workspace');
    expect(built.context.fsScopeTier).toBe('sandboxed'); // default when [chat].fs_scope is unset
  });

  it('honors [chat].fs_scope on the SessionContext', async () => {
    const built = await build({ chat: { ...EMPTY_CHAT, fsScope: 'project' } });
    expect(built.context.fsScopeTier).toBe('project');
  });

  it('a subscribe()-wired listener observes session:started synchronously (the driveInk ordering contract)', async () => {
    // driveInk subscribes BEFORE startSession so the synchronous session:started (which carries the model for
    // the footer) is not raced. This locks that the bus emits session:started inline on session.start().
    const built = await build({ chat: { ...EMPTY_CHAT, defaultModel: 'claude-sonnet-4-6' } });
    const received: SessionStreamHandleEvent[] = [];
    const off = built.handle.subscribe((e) => received.push(e));
    built.session.start();
    off();
    built.session.cancel();
    const startedEvent = received.find((e) => e.type === 'session:started');
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.type === 'session:started' && startedEvent.model).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('streams a text turn end-to-end through the handle (started → tokens → cost → completed → cancelled)', async () => {
    const built = await build({ providers: scriptedResolver([textTurn('hello there')]) });
    built.session.start();
    await built.session.sendMessage('hi');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const types = events.map((e) => e.type);
    expect(types).toContain('session:started');
    expect(types).toContain('session:turn_started');
    expect(types).toContain('cost:updated'); // the per-attempt cost event rides the session stream
    expect(types).toContain('session:turn_completed');
    expect(types[types.length - 1]).toBe('session:cancelled'); // the session's sole terminal

    const tokens = events.flatMap((e) => (e.type === 'agent:token' ? [e.token] : [])).join('');
    expect(tokens).toBe('hello there');
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' && completed.stopReason).toBe('stop');
  });

  it('streams a tool-calling turn: the model calls a granted tool, the loop completes, the answer streams', async () => {
    // Turn 1 calls read_file with NO `path` arg → it fails the tool's arg validation (correctable) BEFORE the
    // host, so the model self-corrects and turn 2 streams the final answer. The agent:tool_call annotation fires.
    // (A wired read_file working end-to-end against a real workspace is covered in the assemble integration tests.)
    const built = await build({
      providers: scriptedResolver([toolUseTurn('c1', 'read_file'), textTurn('the answer')]),
    });
    built.session.start();
    await built.session.sendMessage('read the file');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const types = events.map((e) => e.type);
    expect(types).toContain('agent:tool_call'); // the tool call is annotated on the stream
    const toolCall = events.find((e) => e.type === 'agent:tool_call');
    expect(toolCall?.type === 'agent:tool_call' && toolCall.toolId).toBe('read_file');
    const tokens = events.flatMap((e) => (e.type === 'agent:token' ? [e.token] : [])).join('');
    expect(tokens).toContain('the answer'); // the post-tool answer reached the stream
  });

  it('enforces [chat].max_turns: an over-cap sendMessage settles loudly as turn_limit with no provider call', async () => {
    // Two ENGAGED (successful) turns reach the cap of 2; the 3rd is blocked as turn_limit WITHOUT a provider
    // call. Only an engaged turn counts toward the cap (F7, ADR-0055) — so the cap is reached by real turns,
    // not by pre-egress failures (that gate is pinned in packages/core agent-session.test.ts and below).
    const built = await build({
      chat: { ...EMPTY_CHAT, maxTurns: 2 },
      providers: scriptedResolver([textTurn('first'), textTurn('second')]),
    });
    built.session.start();
    await built.session.sendMessage('one');
    await built.session.sendMessage('two');
    await built.session.sendMessage('three — over the cap');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const errorCodes = events.flatMap((e) =>
      e.type === 'session:turn_completed' && e.error !== undefined ? [e.error.code] : [],
    );
    expect(errorCodes).toEqual(['turn_limit']); // turns 1+2 succeeded; only the over-cap 3rd errors
  });

  it('a pre-egress failure does NOT count against [chat].max_turns — only an engaged turn burns the cap (F7)', async () => {
    // The corrected behavior (ADR-0055): with `unresolvedResolver` every turn fails fast as `internal` BEFORE
    // engaging a provider, so NONE counts toward the cap. Three messages past a cap of 2 therefore all settle as
    // `internal` and `turn_limit` is NEVER reached — the old code counted the pre-egress failures and wrongly
    // blocked the 3rd. This is the surface-level regression guard for the engine gate.
    const built = await build({
      chat: { ...EMPTY_CHAT, maxTurns: 2 },
      providers: unresolvedResolver(),
    });
    built.session.start();
    await built.session.sendMessage('one');
    await built.session.sendMessage('two');
    await built.session.sendMessage('three');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const errorCodes = events.flatMap((e) =>
      e.type === 'session:turn_completed' && e.error !== undefined ? [e.error.code] : [],
    );
    expect(errorCodes).toEqual(['internal', 'internal', 'internal']);
    expect(errorCodes).not.toContain('turn_limit');
  });
});

describe('buildChatSession + MCP host wiring (2.R)', () => {
  /** Write a throwaway `.agent.yaml` declaring one inline stdio MCP server (optional extra server lines). */
  function writeMcpAgent(extraServerLines: readonly string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-mcp-'));
    const path = join(dir, 'a.agent.yaml');
    writeFileSync(
      path,
      [
        'id: mcp-agent',
        'model: claude-sonnet-4-6',
        'provider: anthropic',
        'system_prompt: test agent',
        'tools:',
        '  - read_file',
        'mcp_servers:',
        '  - id: fs',
        '    transport: stdio',
        '    command: my-server',
        ...extraServerLines,
        '',
      ].join('\n'),
    );
    return path;
  }

  it('grants the discovered tool, routes a call to the connection by original name, and tears it down', async () => {
    const calls: { name: string; args: unknown }[] = [];
    let closed = 0;
    const conn: McpConnection = {
      listTools: () => Promise.resolve([{ name: 'read', inputSchema: { type: 'object' } }]),
      callTool: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve({ content: [{ type: 'text', text: 'file body' }], isError: false });
      },
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    };
    const built = await build({
      agentRef: writeMcpAgent(),
      providers: scriptedResolver([toolUseTurn('c1', 'mcp_fs_read'), textTurn('done')]),
      // The injected starter runs the REAL manager over a FAKE connection — no child is spawned, but the real
      // namespacing (`mcp_fs_read`), the dispatch routing, and the close all execute.
      startMcpClient: () => realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(conn) }]),
    });

    // The RETURNED agent is the ORIGINAL — its grant is not mutated with the dynamic id (so the persisted
    // snapshot stays the author's agent; the runtime session binds the augmented one).
    expect(built.agent.tools).toEqual(['read_file']);
    expect(built.mcpSkipped).toEqual([]);
    expect(typeof built.closeMcp).toBe('function');

    built.session.start();
    await built.session.sendMessage('go');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const toolCall = events.find((e) => e.type === 'agent:tool_call');
    expect(toolCall?.type === 'agent:tool_call' && toolCall.toolId).toBe('mcp_fs_read');
    expect(calls).toEqual([{ name: 'read', args: {} }]); // routed to the ORIGINAL server name, not the id

    await built.closeMcp?.();
    expect(closed).toBe(1);
  });

  it('MERGE-not-replace: a session with MCP keeps the fs arm too — read_file AND an MCP tool both dispatch', async () => {
    // The keystone 2.5.A fix (ADR-0055): the inbound-MCP arm is MERGED onto the factory fs+process host, never
    // REPLACING it. Proven end-to-end: in ONE session, read_file routes via host.fs (real file) AND mcp_fs_read
    // routes via host.mcp — both succeed, so neither arm displaced the other.
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-merge-'));
    writeFileSync(join(workspace, 'r.txt'), 'merged');
    const conn: McpConnection = {
      listTools: () => Promise.resolve([{ name: 'read', inputSchema: { type: 'object' } }]),
      callTool: () =>
        Promise.resolve({ content: [{ type: 'text', text: 'mcp body' }], isError: false }),
      close: () => Promise.resolve(),
    };
    const built = await build({
      cwd: workspace,
      agentRef: writeMcpAgent(), // grants read_file + declares the fs MCP server
      providers: scriptedResolver([
        callWithArgs('c1', 'read_file', { path: 'r.txt' }),
        toolUseTurn('c2', 'mcp_fs_read'),
        textTurn('done'),
      ]),
      startMcpClient: () => realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(conn) }]),
    });
    built.session.start();
    await built.session.sendMessage('read both ways');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const results = events.flatMap((e) =>
      e.type === 'agent:tool_result' ? [{ id: e.toolId, ok: e.success }] : [],
    );
    expect(results).toContainEqual({ id: 'read_file', ok: true }); // host.fs survived the merge
    expect(results).toContainEqual({ id: 'mcp_fs_read', ok: true }); // host.mcp survived the merge
    await built.closeMcp?.();
  });

  it('leaves closeMcp undefined + mcpSkipped empty when the agent declares no mcp_servers', async () => {
    const built = await build({ chat: { ...EMPTY_CHAT, defaultModel: 'claude-sonnet-4-6' } });
    expect(built.closeMcp).toBeUndefined();
    expect(built.mcpSkipped).toEqual([]);
  });

  it('surfaces a tool dropped at discovery via mcpSkipped (allowlist-excluded — non-fatal)', async () => {
    const conn: McpConnection = {
      listTools: () =>
        Promise.resolve([
          { name: 'read', inputSchema: { type: 'object' } },
          { name: 'danger', inputSchema: { type: 'object' } },
        ]),
      callTool: () => Promise.resolve({ content: [], isError: false }),
      close: () => Promise.resolve(),
    };
    const built = await build({
      agentRef: writeMcpAgent(),
      startMcpClient: () =>
        realStartMcpClient([
          { id: 'fs', toolsAllowlist: ['read'], open: () => Promise.resolve(conn) },
        ]),
    });
    expect(built.mcpSkipped.map((s) => s.name)).toContain('danger'); // excluded by the allowlist
    await built.closeMcp?.();
  });

  it('self-cleans: a post-connect construction fault tears the just-connected client down (no leak)', async () => {
    // Force a post-connect throw: two ToolDefs sharing an id make `createToolRegistry` reject ("duplicate tool
    // id") AFTER the client is connected. The build must close the client before the failure propagates, so a
    // setup fault can never orphan a spawned MCP child.
    const { defs } = buildServerToolDefs('fs', [{ name: 'read', inputSchema: { type: 'object' } }]);
    let closed = 0;
    const collidingClient: McpClient = {
      capability: { call: () => Promise.resolve({ content: [], isError: false }) },
      toolDefs: [...defs, ...defs], // duplicate id ⇒ createToolRegistry throws inside buildSessionRuntime
      toolIdsByServer: new Map(),
      skipped: [],
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    };
    const building = build({
      agentRef: writeMcpAgent(),
      startMcpClient: () => Promise.resolve(collidingClient),
    });
    await expect(building).rejects.toThrow(/duplicate tool id/);
    expect(closed).toBe(1); // the build closed the client it had just opened
  });

  it('threads the secret resolver to the child env: a MISSING {{secrets}} fails the build closed, never spawns', async () => {
    // The resolver runs in resolveStdioServerConfigs (inside connectAgentMcp) BEFORE startMcpClient — so a
    // missing secret fails the build loud, never reaching the (fake) client. Proves the full
    // command→build→connect→env-resolution threading + the fail-closed posture.
    let started = false;
    const building = build({
      agentRef: writeMcpAgent(['    env:', '      TOKEN: "{{secrets.missing}}"']),
      mcpSecretResolver: createMcpSecretResolver({}), // empty env, no keychain ⇒ 'missing' is unresolvable
      startMcpClient: () => {
        started = true;
        return Promise.reject(
          new Error('startMcpClient must not be reached on a fail-closed secret'),
        );
      },
    });
    await expect(building).rejects.toThrow(/secret 'missing' is not set/);
    expect(started).toBe(false); // failed at env resolution, before any connect
  });

  it('threads the resolver: a resolvable secret lets the build proceed, and the value never reaches the stream', async () => {
    const conn: McpConnection = {
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({ content: [], isError: false }),
      close: () => Promise.resolve(),
    };
    const built = await build({
      agentRef: writeMcpAgent(['    env:', '      TOKEN: "{{secrets.gh}}"']),
      providers: scriptedResolver([textTurn('done')]),
      mcpSecretResolver: createMcpSecretResolver({ RELAVIUM_MCP_GH: 'ghp_SECRET_SENTINEL' }),
      startMcpClient: () => realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(conn) }]),
    });
    expect(built.closeMcp).toBeDefined(); // the secret resolved ⇒ the build proceeded to connect

    // Complementary half of the ADR-0052 §6 custody guarantee: the session EVENT STREAM carries no secret. (The
    // value→spawn-env tie is proven directly in mcp-servers.test.ts "carries the RESOLVED secret into the
    // spawn-spec env"; the injected fake client here does not spawn, so this asserts only stream-cleanliness.)
    built.session.start();
    await built.session.sendMessage('go');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    expect(JSON.stringify(events)).not.toContain('ghp_SECRET_SENTINEL');
    await built.closeMcp?.();
  });
});

describe('buildResumedChatSession (2.N)', () => {
  const RESUME_AGENT = buildDefaultChatAgent('claude-sonnet-4-6');
  const ISO = '2026-06-25T00:00:00.000Z';

  const message = (seq: number, role: 'user' | 'assistant', text: string): SessionMessage => ({
    id: `m${seq}`,
    sessionId: 'sess-r',
    sequenceNumber: seq,
    role,
    content: [{ type: 'text', text }],
    timestamp: ISO,
  });

  const record = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
    id: 'sess-r',
    agentSlug: RESUME_AGENT.id,
    agentSnapshot: RESUME_AGENT,
    context: { workingDir: '/workspace', fsScopeTier: 'project' },
    status: 'ended',
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCostMicrocents: 1234,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  });

  function resume(messages: readonly SessionMessage[], rec: AgentSessionRecord = record()) {
    return buildResumedChatSession({
      chat: EMPTY_CHAT,
      record: rec,
      messages,
      now: () => Date.parse(ISO),
      providers: scriptedResolver([textTurn('continued')]),
    });
  }

  it('rebinds the frozen agent + context and reconstructs the carried-over state', async () => {
    const built = await resume([message(0, 'user', 'hi'), message(1, 'assistant', 'hello')]);
    expect(built.sessionId).toBe('sess-r');
    expect(built.agent.id).toBe(RESUME_AGENT.id);
    expect(built.agent.model).toBe('claude-sonnet-4-6');
    expect(built.context.fsScopeTier).toBe('project'); // the frozen context tier, not the chat default
    expect(built.resumeState.turnCount).toBe(1); // one completed exchange
    expect(built.resumeState.cumulativeCostMicrocents).toBe(1234); // carried from the record
    // The persister continues PAST the persisted MAX(sequence_number) = 1.
    expect(built.nextSequenceNumber).toBe(2);
  });

  it('createChatModeControl gates a governed dispatch on the RESUMED session too (regression guard)', async () => {
    // The resumed path shares buildSessionRuntime + runReplLoop→createChatModeControl with the fresh path, so
    // the fail-closed ask regime activates here too. Lock it against a future refactor that special-cases the
    // resume assembly and silently reintroduces the ungated-dispatch class the opus round fixed for one-shot.
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await buildResumedChatSession({
      chat: EMPTY_CHAT,
      record: record({
        agentSnapshot: { ...RESUME_AGENT, tools: ['write_file'] },
        context: { workingDir: workspace, fsScopeTier: 'project' },
      }),
      messages: [message(0, 'user', 'hi'), message(1, 'assistant', 'hello')],
      now: () => Date.parse(ISO),
      providers: scriptedResolver([
        callWithArgs('c1', 'write_file', { path: 'x.txt', content: 'p' }),
      ]),
    });
    createChatModeControl(built, createChatStore(false)); // ask regime, applied to the resumed session
    // A resumed session lands at idle and continues without start(); the next sendMessage runs a turn.
    await built.session.sendMessage('write a file');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'tool_denied',
    );
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false);
  });

  it('createChatModeControl with interactive:false DENIES a governed dispatch without HANGING (High 9 deadlock)', async () => {
    // On a non-interactive driver (plain non-TTY / --json) nothing answers `requestApproval`. In `accept-edits`
    // (a mode that would prompt on a TTY) the reject-immediately prompt must DENY the write, not publish an
    // unanswerable promise — so `sendMessage` RESOLVES (a regression would hang here and time the test out).
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await buildResumedChatSession({
      chat: EMPTY_CHAT,
      record: record({
        agentSnapshot: { ...RESUME_AGENT, tools: ['write_file'] },
        context: { workingDir: workspace, fsScopeTier: 'project' },
      }),
      messages: [message(0, 'user', 'hi'), message(1, 'assistant', 'hello')],
      now: () => Date.parse(ISO),
      providers: scriptedResolver([
        callWithArgs('c1', 'write_file', { path: 'x.txt', content: 'p' }),
      ]),
    });
    const control = createChatModeControl(built, createChatStore(false), { interactive: false });
    control.onModeChange('accept-edits'); // a prompting mode — but nothing can answer on this driver
    await built.session.sendMessage('write a file'); // MUST resolve (deny), never hang
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'tool_denied',
    );
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false);
  }, 10_000);

  it('CLAMPS a persisted full fs-scope tier down to project on resume (read-only chat ceiling, ADR-0055)', async () => {
    // SECURITY regression: a session persisted (e.g. pre-2.5.A) with the broad `full` tier must resume at the
    // read-only chat ceiling — `project`, never `full` — so a resumed chat can't read `~/.ssh` / `~/.aws` back
    // to the model. The resumed `context.fsScopeTier` is what both the host jail and the dispatch context use,
    // so clamping it here keeps all three channels consistent (the same clamp `buildChatSession` applies fresh).
    const built = await resume(
      [message(0, 'user', 'hi'), message(1, 'assistant', 'hello')],
      record({ context: { workingDir: '/workspace', fsScopeTier: 'full' } }),
    );
    expect(built.context.fsScopeTier).toBe('project');
  });

  it('continues a transcript whose last persisted seq is computed from the MAX (order-independent)', async () => {
    // Rows passed out of order; nextSequenceNumber must be MAX+1, not last-element+1.
    const built = await resume([message(1, 'assistant', 'hello'), message(0, 'user', 'hi')]);
    expect(built.nextSequenceNumber).toBe(2);
  });

  it('computes nextSequenceNumber from the MAX, not the row COUNT (a gapped transcript)', async () => {
    // A gapped transcript (seq 0,1,5 — length 3 but MAX 5) pins MAX+1 semantics: a count-based bug
    // (`messages.length`) would yield 3 and collide; the correct answer is 6.
    const built = await resume([
      message(0, 'user', 'hi'),
      message(1, 'assistant', 'hello'),
      message(5, 'user', 'later'),
    ]);
    expect(built.nextSequenceNumber).toBe(6);
  });

  it('rolls back a trailing unanswered user turn but still continues past its durable seq', async () => {
    // A session interrupted after the user typed (assistant never replied): the durable transcript ends in a
    // dangling user row (seq 2). reconstruct rolls it back (so the model is not re-sent two user turns), but
    // the persister must still continue PAST that durable row (seq 3), never overwrite it.
    const built = await resume([
      message(0, 'user', 'hi'),
      message(1, 'assistant', 'hello'),
      message(2, 'user', 'dangling'),
    ]);
    expect(built.resumeState.turnCount).toBe(1); // only the one completed exchange survives projection
    expect(built.resumeState.messages.at(-1)?.role).toBe('assistant'); // the dangling user turn is trimmed
    expect(built.nextSequenceNumber).toBe(3); // continues past the durable orphan row, not over it
  });

  it('starts a never-messaged session at sequence 0', async () => {
    const built = await resume([]);
    expect(built.nextSequenceNumber).toBe(0);
    expect(built.resumeState.turnCount).toBe(0);
  });

  it('the resumed session lands at idle and continues WITHOUT re-emitting session:started', async () => {
    const built = await resume([message(0, 'user', 'hi'), message(1, 'assistant', 'hello')]);
    // No start() — AgentSession.resume already landed at idle; sendMessage continues the conversation.
    await built.session.sendMessage('again');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const types = events.map((e) => e.type);
    expect(types).not.toContain('session:started'); // resume must not double the lifecycle-open event
    expect(types).toContain('session:turn_completed');
    const tokens = events.flatMap((e) => (e.type === 'agent:token' ? [e.token] : [])).join('');
    expect(tokens).toContain('continued');
  });

  it('rebinds the agent from the SNAPSHOT, not the record agentSlug (which may diverge after a rename)', async () => {
    // agentSlug diverges from the snapshot id; the resumed session must bind the SNAPSHOT's id, and the
    // live events' nodeId (= agentRef = agent.id) must follow the snapshot — not the stale slug.
    const built = await resume(
      [message(0, 'user', 'hi'), message(1, 'assistant', 'hello')],
      record({ agentSlug: 'old-slug' }),
    );
    expect(built.agent.id).toBe(RESUME_AGENT.id); // 'relavium-chat' from the snapshot, not 'old-slug'

    await built.session.sendMessage('go');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    const token = events.find((e) => e.type === 'agent:token');
    expect(token?.type === 'agent:token' && token.nodeId).toBe(RESUME_AGENT.id);
  });

  it('seeds the budget governor with the carried cost — the first resumed turn trips the cap pre-egress', async () => {
    // A near-exhausted record (totalCostMicrocents far past a 1µ¢ cap): AgentSession.resume seeds the governor
    // via updateCost(carried), so the FIRST resumed turn's pre-egress check trips BEFORE any new cost:updated.
    // Without that seeding the carried spend would be invisible and the first turn would slip past the cap.
    const built = await buildResumedChatSession({
      chat: { ...EMPTY_CHAT, maxCostMicrocents: 1, onExceed: 'fail' },
      record: record({ totalCostMicrocents: 999_999 }),
      messages: [message(0, 'user', 'hi'), message(1, 'assistant', 'hello')],
      now: () => Date.parse(ISO),
      providers: scriptedResolver([textTurn('should never stream')]),
    });
    await built.session.sendMessage('again');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const errorCodes = events.flatMap((e) =>
      e.type === 'session:turn_completed' && e.error !== undefined ? [e.error.code] : [],
    );
    expect(errorCodes).toContain('budget_exceeded'); // tripped on the carried cost, no provider call
  });

  it('rejects a record with no stored agent snapshot as a clean exit-2 invocation fault', async () => {
    // The build is async now (2.R MCP connect), so the no-snapshot guard surfaces as a REJECTED promise.
    await expect(resume([], record({ agentSnapshot: undefined }))).rejects.toThrow(
      /no stored agent snapshot/,
    );
  });

  describe('MCP re-discovery on resume (2.R)', () => {
    // The snapshot stores the AUTHOR's agent (mcp_servers, NOT the dynamic ids); resume re-discovers fresh.
    const mcpSnapshot = {
      ...RESUME_AGENT,
      mcp_servers: [{ id: 'fs', transport: 'stdio' as const, command: 'my-server' }],
    };

    it('re-discovers the snapshot mcp_servers: original grant returned, the discovered tool routes, teardown closes', async () => {
      const calls: { name: string; args: unknown }[] = [];
      let closed = 0;
      const conn: McpConnection = {
        listTools: () => Promise.resolve([{ name: 'read', inputSchema: { type: 'object' } }]),
        callTool: (name, args) => {
          calls.push({ name, args });
          return Promise.resolve({ content: [{ type: 'text', text: 'ok' }], isError: false });
        },
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      };
      const built = await buildResumedChatSession({
        chat: EMPTY_CHAT,
        record: record({ agentSnapshot: mcpSnapshot }),
        messages: [message(0, 'user', 'hi'), message(1, 'assistant', 'hello')],
        now: () => Date.parse(ISO),
        providers: scriptedResolver([toolUseTurn('c1', 'mcp_fs_read'), textTurn('done')]),
        startMcpClient: () => realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(conn) }]),
      });

      // The RETURNED agent is the ORIGINAL snapshot — its grant is not baked with the dynamic id, and it still
      // carries mcp_servers so a FUTURE resume re-discovers again (the persistence contract).
      expect(built.agent.tools).toEqual(mcpSnapshot.tools);
      expect(built.agent.mcp_servers).toEqual(mcpSnapshot.mcp_servers);
      expect(typeof built.closeMcp).toBe('function');

      // A resumed session is already idle — no start(); sendMessage continues. The call routing PROVES
      // withMcpGrant ran on the snapshot agent (else the call would be denied not_granted).
      await built.session.sendMessage('go');
      built.session.cancel();
      const events = await drainHandle(built.handle.events);
      const toolCall = events.find((e) => e.type === 'agent:tool_call');
      expect(toolCall?.type === 'agent:tool_call' && toolCall.toolId).toBe('mcp_fs_read');
      expect(calls).toEqual([{ name: 'read', args: {} }]);

      await built.closeMcp?.();
      expect(closed).toBe(1);
    });

    it('self-cleans on resume: a post-connect construction fault tears the just-connected client down', async () => {
      const { defs } = buildServerToolDefs('fs', [
        { name: 'read', inputSchema: { type: 'object' } },
      ]);
      let closed = 0;
      const collidingClient: McpClient = {
        capability: { call: () => Promise.resolve({ content: [], isError: false }) },
        toolDefs: [...defs, ...defs], // duplicate id ⇒ createToolRegistry throws post-connect
        toolIdsByServer: new Map(),
        skipped: [],
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      };
      const building = buildResumedChatSession({
        chat: EMPTY_CHAT,
        record: record({ agentSnapshot: mcpSnapshot }),
        messages: [message(0, 'user', 'hi'), message(1, 'assistant', 'hello')],
        now: () => Date.parse(ISO),
        providers: scriptedResolver([textTurn('unused')]),
        startMcpClient: () => Promise.resolve(collidingClient),
      });
      await expect(building).rejects.toThrow(/duplicate tool id/);
      expect(closed).toBe(1);
    });
  });
});

describe('swapAgentModel (ADR-0059 model-switch rule)', () => {
  it('swaps model + provider and DROPS the original fallback_chain, without mutating the input', () => {
    const original = {
      ...buildDefaultChatAgent('claude-sonnet-4-6'),
      fallback_chain: [{ model: 'gpt-5.5', provider: 'openai' as const, max_attempts: 2 }],
    };
    const frozenChain = original.fallback_chain;
    const next = swapAgentModel(original, 'claude-opus-4-8', 'anthropic');

    expect(next.model).toBe('claude-opus-4-8');
    expect(next.provider).toBe('anthropic');
    expect('fallback_chain' in next).toBe(false); // dropped — the new instance builds its own default plan
    // The input is untouched (a fresh copy): the original keeps its model + fallback_chain.
    expect(original.model).toBe('claude-sonnet-4-6');
    expect(original.fallback_chain).toBe(frozenChain);
  });

  it('is a no-op on fallback_chain for an agent that has none (no key materialized)', () => {
    const next = swapAgentModel(buildDefaultChatAgent('claude-sonnet-4-6'), 'gpt-5.5', 'openai');
    expect(next.model).toBe('gpt-5.5');
    expect(next.provider).toBe('openai');
    expect('fallback_chain' in next).toBe(false);
  });

  it('BINDS a passed reasoning-effort tier onto the swapped agent (ADR-0066)', () => {
    const next = swapAgentModel(
      buildDefaultChatAgent('claude-sonnet-4-6'),
      'claude-opus-4-8',
      'anthropic',
      'high',
    );
    expect(next.reasoning_effort).toBe('high');
  });

  it('DROPS a prior effort when none is passed (a non-reasoning target can’t carry a stale tier)', () => {
    const withEffort = { ...buildDefaultChatAgent('claude-opus-4-8'), reasoning_effort: 'max' as const };
    const next = swapAgentModel(withEffort, 'deepseek-chat', 'deepseek'); // no reasoningEffort arg
    expect('reasoning_effort' in next).toBe(false); // dropped, not carried onto the new model
    expect(withEffort.reasoning_effort).toBe('max'); // the input is untouched (a fresh copy)
  });

  it('OVERWRITES a prior effort with the newly-picked tier', () => {
    const withEffort = { ...buildDefaultChatAgent('claude-opus-4-8'), reasoning_effort: 'low' as const };
    const next = swapAgentModel(withEffort, 'claude-sonnet-4-6', 'anthropic', 'off');
    expect(next.reasoning_effort).toBe('off');
  });
});

describe('buildGovernorWiring', () => {
  // Seed the governor's cumulative directly via updateCost so the pre-egress projection trips the cap
  // regardless of model pricing — exercising the real fail/pause/warn behavior, not just the wiring shape.
  const OVER_CAP = { model: 'claude-sonnet-4-6', maxTokens: 1000 } as const;

  it('is unbounded (no governor) when the cost cap is absent or 0', () => {
    expect(buildGovernorWiring(EMPTY_CHAT)).toBeUndefined();
    expect(buildGovernorWiring({ ...EMPTY_CHAT, maxCostMicrocents: 0 })).toBeUndefined();
  });

  it('wires preEgress + updateCost when a positive cost cap is set', () => {
    const wiring = buildGovernorWiring({
      ...EMPTY_CHAT,
      maxCostMicrocents: 1000,
      onExceed: 'fail',
    });
    expect(wiring).toBeDefined();
    expect(typeof wiring?.preEgress).toBe('function');
    expect(typeof wiring?.updateCost).toBe('function');
  });

  it('on_exceed:fail — preEgress rejects with BudgetExceededError once the cap is exceeded', async () => {
    const wiring = buildGovernorWiring({ ...EMPTY_CHAT, maxCostMicrocents: 1, onExceed: 'fail' });
    wiring?.updateCost(999_999); // cumulative now far past the 1-microcent cap
    await expect(wiring?.preEgress(OVER_CAP)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('on_exceed default (pause_for_approval) — preEgress rejects with BudgetPauseError', async () => {
    // onExceed omitted ⇒ the wiring defaults to pause_for_approval (the REPL is the approval gate).
    const wiring = buildGovernorWiring({ ...EMPTY_CHAT, maxCostMicrocents: 1 });
    wiring?.updateCost(999_999);
    await expect(wiring?.preEgress(OVER_CAP)).rejects.toBeInstanceOf(BudgetPauseError);
  });

  it('on_exceed:warn — preEgress is non-blocking, forwards once to onWarning, and suppresses repeats', async () => {
    const warnings: ChatBudgetWarning[] = [];
    const wiring = buildGovernorWiring(
      { ...EMPTY_CHAT, maxCostMicrocents: 1, onExceed: 'warn' },
      (warning) => warnings.push(warning),
    );
    wiring?.updateCost(999_999);
    await expect(wiring?.preEgress(OVER_CAP)).resolves.toBeUndefined(); // warn never blocks
    await expect(wiring?.preEgress(OVER_CAP)).resolves.toBeUndefined(); // still non-blocking the 2nd time
    // The governor emits the warning ONCE (#warningEmitted) — the 2nd over-cap call must not re-notify.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.limitMicrocents).toBe(1);
  });

  it('on_exceed:warn — preEgress resolves cleanly when NO onWarning surface is supplied (the common config)', async () => {
    // A user who sets max_cost_microcents but wires no warning surface: the absent callback must be a no-op,
    // never a rejection that would surface as an `internal` turn error.
    const wiring = buildGovernorWiring({ ...EMPTY_CHAT, maxCostMicrocents: 1, onExceed: 'warn' });
    wiring?.updateCost(999_999);
    await expect(wiring?.preEgress(OVER_CAP)).resolves.toBeUndefined();
  });

  it('on_exceed:warn — a throwing onWarning surface never rejects preEgress (warn stays non-blocking)', async () => {
    const wiring = buildGovernorWiring(
      { ...EMPTY_CHAT, maxCostMicrocents: 1, onExceed: 'warn' },
      () => {
        throw new Error('renderer blew up');
      },
    );
    wiring?.updateCost(999_999);
    // A misbehaving warn surface must NOT surface as an `internal` turn error — the throw is swallowed.
    await expect(wiring?.preEgress(OVER_CAP)).resolves.toBeUndefined();
  });
});

describe('buildChatSession + 2.5.A tool-host wiring (ADR-0055)', () => {
  /** Write a throwaway `.agent.yaml` granting `tools` (for the read-only + advertise-filter assertions). */
  function writeAgent(tools: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-agent-'));
    const path = join(dir, 'a.agent.yaml');
    writeFileSync(
      path,
      [
        'id: custom-agent',
        'model: claude-sonnet-4-6',
        'provider: anthropic',
        'system_prompt: test agent',
        'tools:',
        ...tools.map((t) => `  - ${t}`),
        '',
      ].join('\n'),
    );
    return path;
  }

  it('read_file actually reads a real file through the wired fs host (end-to-end, not just the factory)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    writeFileSync(join(workspace, 'note.txt'), 'the file body');
    const built = await build({
      cwd: workspace,
      providers: scriptedResolver([
        callWithArgs('c1', 'read_file', { path: 'note.txt' }),
        textTurn('done'),
      ]),
    });
    built.session.start();
    await built.session.sendMessage('read note.txt');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const result = events.find((e) => e.type === 'agent:tool_result');
    expect(result?.type === 'agent:tool_result' && result.toolId).toBe('read_file');
    expect(result?.type === 'agent:tool_result' && result.success).toBe(true); // the wired read SUCCEEDED
    // No capability gap surfaced — the turn completed normally and the post-tool answer streamed.
    const errors = events.flatMap((e) =>
      e.type === 'session:turn_completed' && e.error !== undefined ? [e.error.code] : [],
    );
    expect(errors).toEqual([]);
  });

  it('write_file in a chat session is DENIED by the ask-mode approval floor (2.5.E) — no file on disk', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['write_file']),
      providers: scriptedResolver([
        callWithArgs('c1', 'write_file', { path: 'x.txt', content: 'pwned' }),
      ]),
    });
    // The chat host is now WRITE-capable (chat-read-write); safety rests on the mode's fail-closed approval
    // regime the REPL activates before any turn. Apply the default `ask` mode here so this reflects production:
    // `ask` denies every governed dispatch (two-layer — the advertise-filter also hides write_file, but the
    // scripted model calls it anyway, so the confirm floor is what denies it).
    const env = makeChatModeEnv({
      session: built.session,
      tools: built.tools,
      workspaceDir: workspace,
      prompt: () => Promise.resolve({ outcome: 'reject' }),
    });
    applyChatMode(env, 'ask');
    built.session.start();
    await built.session.sendMessage('write a file');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'tool_denied', // the ask-mode confirm floor denied the governed write (ADR-0057 EA3)
    );
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false); // denied BEFORE any write — no file on disk
  });

  it('createChatModeControl (the LIVE wiring) gates a governed dispatch under the default ask regime', async () => {
    // Prove the PRODUCTION seam — createChatModeControl(built, store) applies the initial ask mode via the real
    // store.requestApproval prompt — denies a governed write end-to-end (not just the manual-env path above).
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['write_file']),
      providers: scriptedResolver([
        callWithArgs('c1', 'write_file', { path: 'x.txt', content: 'pwned' }),
      ]),
    });
    createChatModeControl(built, createChatStore(false)); // applies ask → the fail-closed regime is now active
    built.session.start();
    await built.session.sendMessage('write a file');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'tool_denied',
    );
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false);
  });

  it('createChatModeControl seeds the store effort from the agent + onSetEffort pushes a no-reseat override (ADR-0066)', async () => {
    const built = await build({
      chat: { ...EMPTY_CHAT, defaultModel: 'claude-opus-4-8', reasoningEffort: 'medium' },
    });
    const store = createChatStore(false);
    const control = createChatModeControl(built, store);
    // Seeded from the agent's effective tier — opus is reasoning-capable, so the footer shows it.
    expect(store.getSnapshot().reasoningEffort).toBe('medium');
    expect(built.session.reasoningEffort).toBe('medium');
    // onSetEffort pushes the SESSION override (no reseat) + updates the footer — effective next turn.
    control.onSetEffort('max');
    expect(built.session.reasoningEffort).toBe('max');
    expect(store.getSnapshot().reasoningEffort).toBe('max');
  });

  it('createChatModeControl surfaces NO effort on a non-reasoning model — the footer stays clear (ADR-0066)', async () => {
    const built = await build({
      chat: { ...EMPTY_CHAT, defaultModel: 'gpt-4o', reasoningEffort: 'high' },
    });
    const store = createChatStore(false);
    createChatModeControl(built, store);
    // The config default is baked onto the agent, but gpt-4o has no reasoning tier — the footer shows nothing
    // (the tier is gated off at send anyway), so a user is never shown an inert effort.
    expect(store.getSnapshot().reasoningEffort).toBeUndefined();
  });

  it('createChatModeControl ask: denies an EGRESS-class dispatch too (http_request), not just fs_write', async () => {
    // The confirm floor rejects EVERY governed class; prove the egress class end-to-end (governedAction maps
    // http_request → 'egress', a distinct ToolActionClass) — the deny happens BEFORE dispatch, so the egress
    // arm's fetch never runs (no outbound request), and the turn fails tool_denied.
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['http_request']),
      providers: scriptedResolver([
        callWithArgs('c1', 'http_request', { url: 'https://example.test/x' }),
      ]),
    });
    createChatModeControl(built, createChatStore(false)); // ask regime active
    built.session.start();
    await built.session.sendMessage('fetch a url');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'tool_denied',
    );
  });

  it('createChatModeControl ask: denies an OS-class dispatch too (read_clipboard) — the exfil sink is gated', async () => {
    // ADR-0057 §security review: read_clipboard reads ambient secret-bearing OS state, so it is a governed os
    // action — denied in ask (never advertised, and the confirm floor rejects it if the model calls it anyway).
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['read_clipboard']),
      providers: scriptedResolver([callWithArgs('c1', 'read_clipboard', {})]),
    });
    createChatModeControl(built, createChatStore(false)); // ask regime active
    built.session.start();
    await built.session.sendMessage('read my clipboard');
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'tool_denied',
    );
  });

  it('createChatModeControl accept-edits: an APPROVE lets the governed write through the store prompt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['write_file']),
      providers: scriptedResolver([
        callWithArgs('c1', 'write_file', { path: 'ok.txt', content: 'hi' }),
        textTurn('done'),
      ]),
    });
    const store = createChatStore(false);
    const control = createChatModeControl(built, store);
    control.onModeChange('accept-edits'); // switch to accept-edits (prompts each governed write)
    built.session.start();
    const turn = built.session.sendMessage('write a file');
    // Drive the interactive prompt: wait for the published approval, then approve it.
    for (let i = 0; i < 200 && store.getSnapshot().approval === undefined; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(store.getSnapshot().approval?.request.toolId).toBe('write_file');
    store.answerApproval({ outcome: 'approve', scope: 'once' });
    await turn;
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    expect(existsSync(join(workspace, 'ok.txt'))).toBe(true); // approved ⇒ the write landed
    expect(readFileSync(join(workspace, 'ok.txt'), 'utf8')).toBe('hi');
    // EA5 end-to-end: a real AgentSession turn → real registry confirmDispatch → the emit lands on the handle
    // stream (locks the full compose the unit tests only prove per-hop — nodeId stamped, action-bound preview).
    const approvalEvent = events.find((e) => e.type === 'agent:approval_requested');
    expect(approvalEvent?.type).toBe('agent:approval_requested');
    if (approvalEvent?.type === 'agent:approval_requested') {
      expect(approvalEvent.toolId).toBe('write_file');
      expect(approvalEvent.action).toBe('fs_write');
      expect(approvalEvent.preview.path).toContain('ok.txt'); // the resolved target, nodeId-stamped by the session
    }
  });

  it('createChatModeControl auto: a PROTECTED-path write FALLS BACK to a prompt (not auto-approved)', async () => {
    // The most bespoke ADR-0057 branch, end-to-end (real registry + fs host + store): in auto mode a
    // protected-path target must NOT auto-approve — it publishes a non-cacheable prompt. Rejecting it denies
    // the write (the fs protected-paths floor would refuse it regardless — this proves the graceful fallback).
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['write_file']),
      providers: scriptedResolver([
        callWithArgs('c1', 'write_file', { path: '.git/config', content: '[evil]' }),
      ]),
    });
    const store = createChatStore(false);
    createChatModeControl(built, store).onModeChange('auto');
    built.session.start();
    const turn = built.session.sendMessage('write a protected file');
    for (let i = 0; i < 200 && store.getSnapshot().approval === undefined; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    // auto did NOT auto-approve the protected target — it published a prompt, marked non-cacheable.
    expect(store.getSnapshot().approval?.request.toolId).toBe('write_file');
    expect(store.getSnapshot().approval?.cacheable).toBe(false);
    store.answerApproval({ outcome: 'reject' });
    await turn;
    built.session.cancel();
    await drainHandle(built.handle.events);
    expect(existsSync(join(workspace, '.git', 'config'))).toBe(false);
  });

  it('auto: even an APPROVED protected-path write STILL fails — the fs floor is the true, approval-INDEPENDENT floor', async () => {
    // The complement of the reject test: prove the fs-layer protected-paths refusal (not the prompt) is the real
    // floor. Answer the auto fallback prompt with APPROVE and assert the write is STILL denied + never lands —
    // so a future refactor that coupled the two layers (letting an approval bypass the fs floor) fails here.
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['write_file']),
      providers: scriptedResolver([
        callWithArgs('c1', 'write_file', { path: '.git/config', content: '[evil]' }),
      ]),
    });
    const store = createChatStore(false);
    createChatModeControl(built, store).onModeChange('auto');
    built.session.start();
    const turn = built.session.sendMessage('write a protected file');
    for (let i = 0; i < 200 && store.getSnapshot().approval === undefined; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    // The fallback prompt WAS published (non-cacheable) — so the approve below is genuinely consumed, not a
    // no-op that would let the fs floor pass the test even if auto stopped prompting.
    expect(store.getSnapshot().approval?.request.toolId).toBe('write_file');
    expect(store.getSnapshot().approval?.cacheable).toBe(false);
    store.answerApproval({ outcome: 'approve', scope: 'once' }); // APPROVE — the fs floor must refuse it anyway
    await turn;
    built.session.cancel();
    const events = await drainHandle(built.handle.events);
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'tool_denied',
    );
    expect(existsSync(join(workspace, '.git', 'config'))).toBe(false); // never written despite the approval
  });

  it('the advertise-filter keeps http_request now that egress is wired (chat-read-write, 2.5.E)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-ws-'));
    const { providers, requests } = capturingResolver([textTurn('hi')]);
    const built = await build({
      cwd: workspace,
      agentRef: writeAgent(['read_file', 'http_request']), // egress IS wired in the full-capability chat host
      providers,
    });
    built.session.start();
    await built.session.sendMessage('go');
    built.session.cancel();
    await drainHandle(built.handle.events);

    const advertised = (requests[0]?.tools ?? []).map((t) => t.name);
    expect(advertised).toContain('read_file'); // fs wired ⇒ advertised
    expect(advertised).toContain('http_request'); // egress wired now ⇒ advertised (was dropped in 2.5.A)
    expect(built.agent.tools).toEqual(['read_file', 'http_request']); // the ORIGINAL keeps the author's grant
  });
});
