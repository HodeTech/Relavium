import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BudgetExceededError, BudgetPauseError } from '@relavium/core';
import type { SessionStreamHandleEvent } from '@relavium/core';
import { startMcpClient as realStartMcpClient, type McpConnection } from '@relavium/mcp';
import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { buildDefaultChatAgent } from './default-agent.js';
import {
  buildChatSession,
  buildGovernorWiring,
  buildResumedChatSession,
  type ChatBudgetWarning,
} from './session-host.js';
import {
  drainHandle,
  scriptedResolver,
  textTurn,
  toolUseTurn,
  unresolvedResolver,
} from './test-support.js';

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
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
    // Turn 1 calls read_file (a default-agent grant) → dispatched through the fail-closed {} host (a
    // tool_result, unavailable) → turn 2 streams the final answer. The agent:tool_call annotation fires.
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
    // unresolvedResolver ⇒ every turn fails fast as `internal` (a host-wiring gap) but still COUNTS toward
    // the cap, so the 3rd message past a cap of 2 is blocked as turn_limit without engaging a provider.
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
    expect(errorCodes).toEqual(['internal', 'internal', 'turn_limit']);
  });
});

describe('buildChatSession + MCP host wiring (2.R)', () => {
  /** Write a throwaway `.agent.yaml` declaring one inline stdio MCP server, returning its path. */
  function writeMcpAgent(): string {
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
