/**
 * 1.AA — Node-harness chat regression (1.m5). The session counterpart of 1.U: proves the
 * agent-first sub-spine end-to-end before any surface exists. Composes 1.V (AgentSession) /
 * 1.W (session:* event namespace + SessionHandle) / 1.Y (resume) / 1.Z (export-to-workflow)
 * behind the @relavium/llm seam and the shared RunEventBus, using only already-exported
 * @relavium/core symbols — zero platform imports, no live network/keys, deterministic.
 *
 * Members:
 *   • multi-turn chat — two turns, the first with an echo tool round-trip; events validate
 *     against the canonical RunOrSessionEventSchema and sequenceNumbers are gap-free.
 *   • export — the same transcript maps to a linear-chain workflow scaffold that parses and
 *     round-trips byte-stably.
 *   • resume — a persisted transcript reconstructs into a resumed session that continues the
 *     conversation, carrying prior context into the next provider call.
 *   • determinism — the same scenario produces an identical event signature on re-run.
 */

import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import {
  AgentSchema,
  RunOrSessionEventSchema,
  SessionContextSchema,
  type Agent,
  type AgentSessionRecord,
  type RunOrSessionEvent,
  type SessionContext,
  type SessionMessage,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { RunEventBus } from './event-bus.js';
import { createAbortController } from './execution-host.js';
import {
  createSessionEventSink,
  createSessionHandle,
  type SessionStreamHandleEvent,
} from './session-handle.js';
import { parseWorkflow } from '../parser.js';
import { serializeWorkflow, sessionToWorkflow } from '../export/serializer.js';
import { reconstructSessionState, type SessionResumeState } from './session-resume.js';
import type { ToolDef as CoreToolDef, ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';

// --- LLM-provider stubs (mirror agent-session.test.ts) -----------------------------------------------

const CAPS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const c of chunks) yield c;
}

/** A provider that replays a different chunk list per stream() call (call N → scripts[N]). */
function scriptedProvider(scripts: StreamChunk[][], id: ProviderId = 'anthropic'): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('generate not used in the harness');
    },
    stream: () => {
      // Fail fast on an UNSCRIPTED call — an unintended extra LLM invocation is a harness bug, not a
      // silent empty turn (which would mask, e.g., a retry/failover that re-dispatched more than expected).
      const chunks = scripts[call];
      call += 1;
      if (chunks === undefined) {
        throw new Error(
          `scriptedProvider: unexpected stream call #${call} (only ${scripts.length} scripted)`,
        );
      }
      return streamOf(chunks);
    },
  };
}

const usage = { inputTokens: 10, outputTokens: 5 };
const STOP = (reason: 'stop' | 'tool_use' = 'stop'): StreamChunk => ({
  type: 'stop',
  stopReason: reason,
  usage,
});
const textTurn = (text: string): StreamChunk[] => [{ type: 'text_delta', text }, STOP('stop')];
const toolUseTurn = (id: string): StreamChunk[] => [
  { type: 'tool_call_start', id, name: 'echo' },
  { type: 'tool_call_end', id },
  STOP('tool_use'),
];

// --- Tool stubs: a sanitized echo registry + its LLM-visible def (mirror agent-runner.e2e.test.ts) ----

const echoRegistry: ToolRegistry = {
  has: () => true,
  list: () => ['echo'],
  dispatch: (call) => {
    const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'TOOL-OK' };
    return Promise.resolve({
      output: 'TOOL-OK',
      toolResult: markUntrusted(result),
      truncated: false,
      events: {
        call: { toolId: call.name, toolInput: {} },
        result: { toolId: call.name, success: true, outputSummary: 'TOOL-OK' },
      },
    });
  },
};

const echoToolDef: CoreToolDef = {
  id: 'echo',
  source: 'builtin',
  description: 'echo',
  parseArgs: (raw) => raw,
  llmVisibleParams: { type: 'object' },
  policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
  dispatch: () => Promise.reject(new Error('echoToolDef dispatch is not used directly')),
};

// --- Session fixture ---------------------------------------------------------------------------------

const AGENT: Agent = AgentSchema.parse({
  id: 'chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are a concise chat agent.',
  tools: ['echo'],
});

const CONTEXT: SessionContext = SessionContextSchema.parse({
  workingDir: '/workspace/chat',
  fsScopeTier: 'sandboxed',
});

const TS = '2026-06-17T08:00:00.000Z';

// --- Harness helpers ---------------------------------------------------------------------------------

function createBus(): RunEventBus {
  let tick = Date.parse('2026-06-17T00:00:00.000Z');
  return new RunEventBus({ now: () => new Date(tick++).toISOString() });
}

function buildSession(
  bus: RunEventBus,
  scripts: StreamChunk[][],
  sessionId = 'sess-aa-1',
): { session: AgentSession; events: SessionStreamEvent[] } {
  const collected: SessionStreamEvent[] = [];
  const provider = scriptedProvider(scripts);
  const sink = createSessionEventSink(bus, sessionId);
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry: echoRegistry,
    tools: [echoToolDef],
    keyFor: () => 'key',
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    emit: (event) => {
      collected.push(event);
      sink(event);
    },
  };
  const session = new AgentSession({
    sessionId,
    agentRef: AGENT.id,
    agent: AGENT,
    context: CONTEXT,
    deps,
  });
  return { session, events: collected };
}

async function drainSession(
  events: AsyncIterable<SessionStreamHandleEvent>,
): Promise<SessionStreamHandleEvent[]> {
  const collected: SessionStreamHandleEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/** Assert every event validates against the canonical RunOrSessionEventSchema. */
function assertCanonicalSchema(events: readonly RunOrSessionEvent[]): void {
  for (const event of events) {
    const parsed = RunOrSessionEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`event ${event.type}#${String(event.sequenceNumber)} is not canonical`);
    }
  }
}

/** Assert sequenceNumbers are exactly 0..n-1 — the bus's gap-free guarantee. */
function assertGapFreeSeq(events: readonly { sequenceNumber: number }[]): void {
  const seqs = events.map((e) => e.sequenceNumber).sort((a, b) => a - b);
  seqs.forEach((seq, index) => expect(seq).toBe(index));
}

const tokensOf = (events: readonly SessionStreamHandleEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'agent:token' ? [e.token] : []));

const costsOf = (
  events: readonly SessionStreamHandleEvent[],
): Extract<SessionStreamHandleEvent, { type: 'cost:updated' }>[] =>
  events.filter(
    (e): e is Extract<SessionStreamHandleEvent, { type: 'cost:updated' }> =>
      e.type === 'cost:updated',
  );

// --- The scenarios -----------------------------------------------------------------------------------

describe('1.AA — chat harness (1.m5 agent-first sub-spine)', () => {
  it('multi-turn chat with a tool call: session events stream through the bus, gap-free + canonical', async () => {
    const bus = createBus();
    const handle = createSessionHandle(bus, 'sess-aa-1', () => undefined);
    const { session } = buildSession(
      bus,
      [toolUseTurn('c1'), textTurn('echo received'), textTurn('plain answer')],
      'sess-aa-1',
    );

    session.start();
    await session.sendMessage('call echo');
    await session.sendMessage('anything else?');
    session.cancel();

    const events = await drainSession(handle.events);

    // Lifecycle shape: started, two turn brackets, cancelled terminal.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session:started');
    expect(types.at(-1)).toBe('session:cancelled');
    expect(types.filter((t) => t === 'session:turn_started')).toHaveLength(2);
    expect(types.filter((t) => t === 'session:turn_completed')).toHaveLength(2);

    // The first turn performed a tool round-trip through the shared turn core.
    expect(types).toContain('agent:tool_call');
    expect(types).toContain('agent:tool_result');

    // Live tokens from both turns reached the stream.
    expect(tokensOf(events)).toEqual(['echo received', 'plain answer']);

    // Per-attempt cost: tool turn has two cost events, plain turn has one; cumulative is monotonic.
    const costs = costsOf(events);
    expect(costs.length).toBeGreaterThanOrEqual(3);
    let running = 0;
    for (const c of costs) {
      expect(c.costMicrocents).toBeGreaterThan(0);
      running += c.costMicrocents;
      expect(c.cumulativeCostMicrocents).toBe(running);
    }

    assertGapFreeSeq(events);
    assertCanonicalSchema(events);
  });

  it('exports the session transcript to a round-trippable workflow scaffold', () => {
    const record: AgentSessionRecord = {
      id: 'sess-aa-1',
      agentSlug: AGENT.id,
      agentSnapshot: AGENT,
      title: 'Chat Harness Export',
      context: CONTEXT,
      status: 'idle',
      totalInputTokens: 25,
      totalOutputTokens: 15,
      totalCostMicrocents: 4200,
      createdAt: TS,
      updatedAt: TS,
    };
    const messages: SessionMessage[] = [
      {
        id: 'm-0',
        sessionId: 'sess-aa-1',
        sequenceNumber: 0,
        role: 'user',
        content: [{ type: 'text', text: 'call echo' }],
        timestamp: TS,
      },
      {
        id: 'm-1',
        sessionId: 'sess-aa-1',
        sequenceNumber: 1,
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'c1', name: 'echo', args: {} },
          { type: 'text', text: 'echo received' },
        ],
        modelId: 'claude-opus-4-8',
        timestamp: TS,
      },
      {
        id: 'm-2',
        sessionId: 'sess-aa-1',
        sequenceNumber: 2,
        role: 'user',
        content: [{ type: 'text', text: 'anything else?' }],
        timestamp: TS,
      },
      {
        id: 'm-3',
        sessionId: 'sess-aa-1',
        sequenceNumber: 3,
        role: 'assistant',
        content: [{ type: 'text', text: 'plain answer' }],
        modelId: 'claude-opus-4-8',
        timestamp: TS,
      },
    ];

    const def = sessionToWorkflow(record, messages);
    const yaml1 = serializeWorkflow(def);
    const parsed = parseWorkflow(yaml1);
    const yaml2 = serializeWorkflow(parsed);

    // Byte-stable round-trip: the export is a valid workflow and re-emits identically.
    expect(yaml2).toBe(yaml1);

    // Linear chain: input → turn-1 (tool) → turn-2 (text) → output.
    expect(def.workflow.nodes.map((n) => n.id)).toEqual(['input', 'turn-1', 'turn-2', 'output']);
    expect(def.workflow.nodes.map((n) => n.type)).toEqual(['input', 'agent', 'agent', 'output']);
    expect(def.workflow.edges).toEqual([
      { from: 'input', to: 'turn-1' },
      { from: 'turn-1', to: 'turn-2' },
      { from: 'turn-2', to: 'output' },
    ]);

    const turn1 = def.workflow.nodes[1];
    expect(turn1?.type === 'agent' && turn1.prompt_template).toBe('call echo');
    expect(turn1?.type === 'agent' && turn1.tools).toEqual(['echo']);

    const turn2 = def.workflow.nodes[2];
    expect(turn2?.type === 'agent' && turn2.prompt_template).toBe('anything else?');
    expect(turn2?.type === 'agent' && turn2.tools).toBeUndefined();

    // Full transcript preserved under metadata.
    const serialized = JSON.stringify(def.workflow.metadata);
    expect(serialized).toContain('"source":"session"');
    expect(serialized).toContain('"sessionId":"sess-aa-1"');
    expect(serialized).toContain('"sequenceNumber":0');
    expect(serialized).toContain('"sequenceNumber":3');
  });

  it('resumes a persisted session and continues the conversation', async () => {
    const bus = createBus();
    const seen: { role: string; content: unknown }[][] = [];
    const capturingProvider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('generate not used in the harness');
      },
      stream: (req) => {
        seen.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        return streamOf(textTurn('resumed answer'));
      },
    };

    const events: SessionStreamEvent[] = [];
    const sink = createSessionEventSink(bus, 'sess-aa-resume');
    const deps: SessionDeps = {
      resolveProvider: () => capturingProvider,
      registry: echoRegistry,
      tools: [echoToolDef],
      keyFor: () => 'key',
      sleep: () => Promise.resolve(),
      newAbortController: createAbortController,
      emit: (event) => {
        events.push(event);
        sink(event);
      },
    };

    const state: SessionResumeState = reconstructSessionState(
      {
        id: 'sess-aa-resume',
        agentSlug: AGENT.id,
        context: CONTEXT,
        status: 'idle',
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCostMicrocents: 2100,
        createdAt: TS,
        updatedAt: TS,
      },
      [
        {
          id: 'm-0',
          sessionId: 'sess-aa-resume',
          sequenceNumber: 0,
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          timestamp: TS,
        },
        {
          id: 'm-1',
          sessionId: 'sess-aa-resume',
          sequenceNumber: 1,
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
          modelId: 'claude-opus-4-8',
          timestamp: TS,
        },
      ],
    );

    const resumed = AgentSession.resume(
      {
        sessionId: 'sess-aa-resume',
        agentRef: AGENT.id,
        agent: AGENT,
        context: CONTEXT,
        deps,
      },
      state,
    );

    await resumed.sendMessage('again');

    // The provider saw the prior transcript plus the new user message.
    expect(seen[0]).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);

    // Resume does not re-emit session:started.
    expect(events.map((e) => e.type)).not.toContain('session:started');
    expect(events.some((e) => e.type === 'session:turn_completed')).toBe(true);
  });

  it('determinism: re-running the chat yields an identical event signature', async () => {
    const runOnce = async (): Promise<{ sig: string; tokens: string[] }> => {
      const bus = createBus();
      const handle = createSessionHandle(bus, 'sess-aa-det', () => undefined);
      const { session } = buildSession(
        bus,
        [toolUseTurn('c1'), textTurn('echo received'), textTurn('plain answer')],
        'sess-aa-det',
      );
      session.start();
      await session.sendMessage('call echo');
      await session.sendMessage('anything else?');
      session.cancel();
      const events = await drainSession(handle.events);
      return {
        sig: events.map((e) => `${String(e.sequenceNumber)}:${e.type}`).join('|'),
        tokens: tokensOf(events),
      };
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(second.sig).toBe(first.sig);
    expect(second.tokens).toEqual(first.tokens);
  });
});
