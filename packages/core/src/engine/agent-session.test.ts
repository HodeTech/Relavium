import type {
  CapabilityFlags,
  EstimateTokensInput,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  ProviderId,
  StreamChunk,
} from '@relavium/llm';
import {
  AgentSchema,
  RunEventSchema,
  SessionContextSchema,
  type Agent,
  type SessionContext,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS } from '../tools/builtins.js';
import { ToolExecutionError } from '../tools/errors.js';
import { createToolRegistry } from '../tools/registry.js';
import type {
  ProcessResult,
  ToolDispatchContext,
  ToolHost,
  ToolRegistry,
  ToolResultPart,
} from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import {
  AgentSession,
  COMPACTION_SYSTEM_PROMPT,
  DEFAULT_SESSION_MAX_TURNS,
  SessionStateError,
  type SessionDeps,
  type SessionStreamEvent,
} from './agent-session.js';
// Intra-package helper (NOT the identically-named public index.ts export) — keeps engine purity; the
// session never names the ambient `AbortController`. A path drift to the public surface would be a smell.
import { BudgetPauseError } from './budget-governor.js';
import { RunEventBus } from './event-bus.js';
import { createAbortController } from './execution-host.js';
import {
  createSessionEventSink,
  createSessionHandle,
  type SessionStreamHandleEvent,
} from './session-handle.js';

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

/** A provider that replays a different chunk list per `stream()` call (call N → scripts[N]). */
function scriptedProvider(scripts: StreamChunk[][], id: ProviderId = 'anthropic'): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: () => streamOf(scripts[call++] ?? []),
  };
}

/** A registry returning a sanitized echo outcome (for the tool round-trip). */
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

const noToolRegistry: ToolRegistry = {
  has: () => false,
  list: () => [],
  dispatch: () => Promise.reject(new Error('no tool dispatch expected')),
};

const AGENT: Agent = AgentSchema.parse({
  id: 'chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are a concise chat agent.',
});

const TOOL_AGENT: Agent = AgentSchema.parse({
  id: 'tool-chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You may call echo.',
  tools: ['echo'],
});

const CONTEXT: SessionContext = SessionContextSchema.parse({
  workingDir: '/workspace/session', // a fixture path (never touched on disk); avoid a publicly-writable /tmp
  fsScopeTier: 'sandboxed',
});

const textTurn = (text: string): StreamChunk[] => [
  { type: 'text_delta', text },
  { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } },
];

/** A turn reporting a controllable real input-token usage — for the auto-compaction threshold (ADR-0062). */
const inputTurn = (text: string, inputTokens: number): StreamChunk[] => [
  { type: 'text_delta', text },
  { type: 'stop', stopReason: 'stop', usage: { inputTokens, outputTokens: 3 } },
];

const toolUseTurn = (id: string): StreamChunk[] => [
  { type: 'tool_call_start', id, name: 'echo' },
  { type: 'tool_call_end', id },
  { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 2 } },
];

interface Harness {
  readonly deps: SessionDeps;
  readonly events: SessionStreamEvent[];
}

function harness(
  scripts: StreamChunk[][],
  overrides: Partial<SessionDeps> = {},
  registry: ToolRegistry = noToolRegistry,
): Harness {
  const events: SessionStreamEvent[] = [];
  const provider = scriptedProvider(scripts);
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry,
    tools: [],
    keyFor: () => 'key',
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    emit: (event) => {
      events.push(event);
    },
    ...overrides,
  };
  return { deps, events };
}

const session = (deps: SessionDeps, agent: Agent = AGENT): AgentSession =>
  new AgentSession({ sessionId: 'sess-1', agentRef: agent.id, agent, context: CONTEXT, deps });

const typesOf = (events: readonly SessionStreamEvent[]): readonly string[] =>
  events.map((e) => e.type);

/** Drain a `SessionHandle` stream to completion — for the 1.W end-to-end wiring test below. */
async function drainSession(
  events: AsyncIterable<SessionStreamHandleEvent>,
): Promise<SessionStreamHandleEvent[]> {
  const collected: SessionStreamHandleEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('AgentSession (1.V) — multi-turn entry point over the shared turn core', () => {
  it('runs a multi-turn conversation with a tool round-trip through the same turn core', async () => {
    // Turn 1 calls echo then answers (2 stream() calls); turn 2 is a plain answer (1 stream() call).
    const { deps, events } = harness(
      [toolUseTurn('c1'), textTurn('first answer'), textTurn('second answer')],
      {},
      echoRegistry,
    );
    const s = session(deps, TOOL_AGENT);
    s.start();
    await s.sendMessage('hello');
    await s.sendMessage('again');

    const types = typesOf(events);
    expect(types[0]).toBe('session:started');
    // Two turns, each bracketed by turn_started / turn_completed.
    expect(types.filter((t) => t === 'session:turn_started')).toHaveLength(2);
    expect(types.filter((t) => t === 'session:turn_completed')).toHaveLength(2);
    // The tool round-trip surfaced through the reused core.
    expect(types).toContain('agent:tool_call');
    expect(types).toContain('agent:tool_result');
    // Both turns completed successfully (no error payload).
    const completes = events.filter((e) => e.type === 'session:turn_completed');
    for (const e of completes) {
      expect(e.type === 'session:turn_completed' && e.error).toBeUndefined();
      expect(e.type === 'session:turn_completed' && e.stopReason).toBe('stop');
    }
    // The two assistant answers streamed.
    const tokens = events.filter((e) => e.type === 'agent:token');
    expect(tokens.map((e) => (e.type === 'agent:token' ? e.token : ''))).toEqual([
      'first answer',
      'second answer',
    ]);
  });

  it('keeps the cross-turn transcript content-only (protocol-valid: no orphaned tool_use, no reasoning)', async () => {
    // Capture the messages each provider call receives. After a tool-using turn 1, turn 2's OUTBOUND
    // messages must carry NO tool_call / tool_result part (the tool round-trip stays inside the turn core,
    // so there is no orphaned tool_use → no provider 400) and NO reasoning part (its signature must not
    // span turns — ADR-0030/0039). The prior assistant turn survives as a text-only message.
    const seen: LlmMessage[][] = [];
    const scripts = [toolUseTurn('c1'), textTurn('answer one'), textTurn('answer two')];
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        seen.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        return streamOf(scripts[seen.length - 1] ?? []);
      },
    };
    const deps: SessionDeps = {
      resolveProvider: () => provider,
      registry: echoRegistry,
      tools: [],
      keyFor: () => 'key',
      sleep: () => Promise.resolve(),
      newAbortController: createAbortController,
      emit: () => {}, // this test inspects the provider's received messages (`seen`), not the event stream
    };
    const s = new AgentSession({
      sessionId: 'sx',
      agentRef: TOOL_AGENT.id,
      agent: TOOL_AGENT,
      context: CONTEXT,
      deps,
    });
    s.start();
    await s.sendMessage('hi'); // turn 1: tool round-trip (2 provider calls)
    await s.sendMessage('again'); // turn 2: 1 provider call

    const turn2 = seen.at(-1) ?? [];
    const carriesNonTextPart = turn2.some((m) =>
      m.content.some(
        (p) => p.type === 'tool_call' || p.type === 'tool_result' || p.type === 'reasoning',
      ),
    );
    expect(carriesNonTextPart).toBe(false);
    // The prior assistant turn is present, text-only; and the new user turn is there.
    expect(
      turn2.some((m) => m.role === 'assistant' && m.content.every((p) => p.type === 'text')),
    ).toBe(true);
    expect(turn2.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('accumulates cumulative cost across turns AND across multiple cost events within one turn', async () => {
    // Turn 1 is a tool round-trip → TWO cost:updated events (the tool_use attempt + the answer attempt);
    // turn 2 is one. Pins that per-attempt increments sum correctly (no double-count even with multiple
    // events per turn) — the same model the WorkflowEngine uses (engine.ts `#cumulativeCostMicrocents +=`).
    const { deps, events } = harness(
      [toolUseTurn('c1'), textTurn('first'), textTurn('second')],
      {},
      echoRegistry,
    );
    const s = session(deps, TOOL_AGENT);
    s.start();
    await s.sendMessage('one');
    await s.sendMessage('two');

    const costs = events.filter((e) => e.type === 'cost:updated');
    expect(costs.length).toBeGreaterThanOrEqual(3); // ≥2 in the tool turn + ≥1 in the plain turn
    // Each cumulative equals the running sum of per-event costMicrocents (never the 0 placeholder).
    let running = 0;
    for (const e of costs) {
      if (e.type !== 'cost:updated') continue;
      running += e.costMicrocents;
      expect(e.cumulativeCostMicrocents).toBe(running);
    }
  });

  it('feeds the running cumulative cost to a wired governor via updateCost — M3', async () => {
    // A host wiring preEgress to a BudgetGovernor must also keep the governor's cumulative current, else a
    // tool-looping chat never fails safe (only single-call estimates would trip). The session calls
    // SessionDeps.updateCost once per cost:updated with the running total.
    const seen: number[] = [];
    const { deps, events } = harness([textTurn('a'), textTurn('b')], {
      updateCost: (n) => {
        seen.push(n);
      },
    });
    const s = session(deps);
    s.start();
    await s.sendMessage('one');
    await s.sendMessage('two');

    const costs = events.filter((e) => e.type === 'cost:updated');
    expect(seen).toHaveLength(costs.length); // one updateCost per cost:updated
    const last = costs.at(-1);
    expect(seen.at(-1)).toBe(last?.type === 'cost:updated' ? last.cumulativeCostMicrocents : -1);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0); // monotonic non-decreasing
    }
  });

  it('settles a turn LOUDLY as budget_exceeded when a pre-egress BudgetPauseError is thrown — M1', async () => {
    // A session has no pause/resume gate machinery in 1.V; a pre-egress pause_for_approval must not escape
    // sendMessage as a raw throw (which would leave the turn with no terminal session:turn_completed).
    const { deps, events } = harness([textTurn('unreached')], {
      preEgress: () => {
        throw new BudgetPauseError(900, 1000, 90);
      },
    });
    const s = session(deps);
    s.start();
    await expect(s.sendMessage('go')).resolves.toBeUndefined(); // no raw throw escapes

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'budget_exceeded',
    );
    expect(completed?.type === 'session:turn_completed' ? completed.stopReason : undefined).toBe(
      'error',
    );
    // No egress happened (the pause was pre-egress).
    expect(typesOf(events)).not.toContain('agent:token');
    // EA2: a pre-egress pause engaged NO provider — truthful zero usage (the budget-pause branch hardcodes
    // `{0,0}` by design; pin it so a regression can't start reporting fabricated tokens here).
    expect(completed?.type === 'session:turn_completed' ? completed.tokensUsed : undefined).toEqual(
      { input: 0, output: 0 },
    );
  });

  it('reports the turn’s REAL accumulated usage on a failed turn (EA2) — not a hardcoded zero', async () => {
    // A tool_use turn settles usage 4/2 (the STOP), THEN the tool throws → AgentTurnError(tool_failed)
    // carrying that usage (EA2). The session reports it on the failed turn_completed, not `{0,0}`.
    const failingRegistry: ToolRegistry = {
      has: () => true,
      list: () => ['echo'],
      dispatch: () => Promise.reject(new ToolExecutionError('echo', 'disk full')),
    };
    const { deps, events } = harness([toolUseTurn('c1')], {}, failingRegistry);
    const s = session(deps, TOOL_AGENT);
    s.start();
    await s.sendMessage('go');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    if (completed?.type !== 'session:turn_completed') throw new Error('expected a turn_completed');
    expect(completed.error?.code).toBe('tool_failed');
    expect(completed.tokensUsed).toEqual({ input: 4, output: 2 });
  });

  it('emits session:turn_completed{turn_limit} — loudly, no egress — when driven past the hard cap', async () => {
    // MANDATORY regression: a turn-loop refactor must not be able to silently drop the cap signal.
    // maxTurns 1: turn 1 runs; turn 2 is blocked with turn_limit and never reaches the provider.
    const { deps, events } = harness([textTurn('only answer')], { maxTurns: 1 });
    const s = session(deps);
    s.start();
    await s.sendMessage('first');
    events.length = 0; // isolate the blocked turn's events
    await s.sendMessage('second — over the cap');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'turn_limit',
    );
    expect(completed?.type === 'session:turn_completed' ? completed.stopReason : undefined).toBe(
      'error',
    );
    // EA2 regression: a NO-egress hard-cap block reports a TRUTHFUL zero — it must never start fabricating
    // usage (the hard-cap branch hardcodes `{0,0}` by design, distinct from the within-turn turn_limit above).
    expect(completed?.type === 'session:turn_completed' ? completed.tokensUsed : undefined).toEqual(
      { input: 0, output: 0 },
    );
    // The blocked turn still brackets turn_started → turn_completed, and emits NOTHING else (no egress —
    // no streamed token / tool / cost). Pinning the EXACT sequence stops a refactor from moving the
    // turn_started emission after the cap check, which would silently break the observable contract.
    expect(typesOf(events)).toEqual(['session:turn_started', 'session:turn_completed']);
  });

  it('does NOT count a pre-egress failure against max_turns — only an engaged turn burns the cap (F7)', async () => {
    // F7 (ADR-0055): the hard cap counts ONLY turns where a provider actually engaged. A turn that fails BEFORE
    // any egress — here a fixed host-wiring gap (`resolveProvider → undefined`, which the session memoizes) —
    // must never consume one of `max_turns`. With maxTurns 1 we drive THREE such turns: under the engaged-gate
    // every one fails identically with `internal` and NONE is ever blocked by `turn_limit`. The pre-gate
    // UNCONDITIONAL increment would have counted turn 1 and blocked turn 2 with `turn_limit` — so this also pins
    // the regression: a pre-flight failure can no longer silently exhaust the cap without a single provider call.
    const events: SessionStreamEvent[] = [];
    const deps: SessionDeps = {
      resolveProvider: () => undefined, // a fixed wiring gap — every turn fails pre-egress, none engages
      registry: noToolRegistry,
      tools: [],
      keyFor: () => 'key',
      sleep: () => Promise.resolve(),
      newAbortController: createAbortController,
      maxTurns: 1,
      emit: (e) => {
        events.push(e);
      },
    };
    const s = session(deps);
    s.start();
    await s.sendMessage('one');
    await s.sendMessage('two');
    await s.sendMessage('three');

    const completes = events.filter((e) => e.type === 'session:turn_completed');
    expect(completes).toHaveLength(3);
    const codes = completes.map((e) =>
      e.type === 'session:turn_completed' ? e.error?.code : undefined,
    );
    // Every turn fails with the SAME pre-egress internal error — and the cap is NEVER tripped, because no turn
    // engaged a provider to count.
    expect(codes).toEqual(['internal', 'internal', 'internal']);
    expect(codes).not.toContain('turn_limit');
  });

  it('maps a within-turn turn_limit (maxToolTurns exceeded) to session:turn_completed{turn_limit}', async () => {
    // maxToolTurns 0: a tool_use turn exceeds the within-turn loop guard → AgentTurnError('turn_limit').
    const { deps, events } = harness(
      [toolUseTurn('c1')],
      { limits: { maxToolTurns: 0, maxToolCorrections: 3 } },
      echoRegistry,
    );
    const s = session(deps, TOOL_AGENT);
    s.start();
    await s.sendMessage('loop please');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    if (completed?.type !== 'session:turn_completed') throw new Error('expected a turn_completed');
    expect(completed.error?.code).toBe('turn_limit');
    // EA2: the WITHIN-turn turn_limit is thrown from runAgentTurn AFTER the first tool turn streamed (usage
    // 4/2 accumulated), so — unlike the session HARD cap below (no egress) — it reports the REAL spent tokens,
    // not a zero. Pins the within-turn-vs-hard-cap usage distinction so it cannot silently drift.
    expect(completed.tokensUsed).toEqual({ input: 4, output: 2 });
  });

  it('completes a turn with an error (stopReason error) when the provider chain is exhausted', async () => {
    const { deps, events } = harness([
      [
        {
          type: 'error',
          error: { kind: 'bad_request', retryable: false, provider: 'anthropic', message: 'nope' },
        },
      ],
    ]);
    const s = session(deps);
    s.start();
    await s.sendMessage('go');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.stopReason : undefined).toBe(
      'error',
    );
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'validation',
    );
  });

  it('completes a turn with an internal error when no provider is wired (resolveProvider → undefined)', async () => {
    const events: SessionStreamEvent[] = [];
    const deps: SessionDeps = {
      resolveProvider: () => undefined, // a host-wiring gap — no adapter for the agent's provider
      registry: noToolRegistry,
      tools: [],
      keyFor: () => 'key',
      sleep: () => Promise.resolve(),
      newAbortController: createAbortController,
      emit: (e) => {
        events.push(e);
      },
    };
    const s = session(deps);
    s.start();
    await s.sendMessage('go');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'internal',
    );
    // The failed turn engaged no provider and left the transcript clean (the user message rolled back).
    expect(typesOf(events)).not.toContain('agent:token');
  });

  it('is reusable after a failed turn — the next sendMessage drives a clean, successful turn', async () => {
    // A turn that fails (exhausted chain) must leave the session idle (not wedged) with the failed turn's
    // user message rolled back, so the next message starts fresh and succeeds.
    const errorChunk: StreamChunk = {
      type: 'error',
      error: { kind: 'bad_request', retryable: false, provider: 'anthropic', message: 'nope' },
    };
    const { deps, events } = harness([[errorChunk], textTurn('recovered')]);
    const s = session(deps);
    s.start();
    await s.sendMessage('first — fails');
    const firstCompleted = events.find((e) => e.type === 'session:turn_completed');
    expect(
      firstCompleted?.type === 'session:turn_completed' ? firstCompleted.stopReason : undefined,
    ).toBe('error');

    events.length = 0; // isolate the recovery turn
    await s.sendMessage('second — succeeds'); // no SessionStateError: the session is reusable after a failure
    const secondCompleted = events.find((e) => e.type === 'session:turn_completed');
    expect(
      secondCompleted?.type === 'session:turn_completed' ? secondCompleted.error : 'present',
    ).toBeUndefined();
    expect(
      secondCompleted?.type === 'session:turn_completed' ? secondCompleted.stopReason : undefined,
    ).toBe('stop');
    expect(
      events
        .filter((e) => e.type === 'agent:token')
        .map((e) => (e.type === 'agent:token' ? e.token : '')),
    ).toEqual(['recovered']);
  });

  it('settles LOUDLY then re-raises a truly unexpected error, with a key-free message', async () => {
    // The defensive else-branch: an error that is neither an AgentTurnError nor a BudgetPauseError must
    // still leave a terminal session:turn_completed{internal} (the stream stays balanced) AND re-raise so
    // the caller still sees the bug. Inject a raw throw via the updateCost seam (called mid-turn on
    // cost:updated). The settled message is generic — it must NOT echo the raw error text.
    const boom = new Error('sk-secret-must-not-surface');
    const { deps, events } = harness([textTurn('answer')], {
      updateCost: () => {
        throw boom;
      },
    });
    const s = session(deps);
    s.start();
    await expect(s.sendMessage('go')).rejects.toBe(boom); // re-raised verbatim, not swallowed
    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'internal',
    );
    expect(completed?.type === 'session:turn_completed' ? completed.stopReason : undefined).toBe(
      'error',
    );
    const msg = completed?.type === 'session:turn_completed' ? completed.error?.message : '';
    expect(msg).toBe('the session turn failed with an unexpected error');
    expect(msg).not.toContain('secret'); // the raw error text never reaches the settled payload
  });

  it('cancel() between turns emits session:cancelled and blocks further messages', async () => {
    const { deps, events } = harness([textTurn('answer')]);
    const s = session(deps);
    s.start();
    await s.sendMessage('hi');
    s.cancel();

    expect(typesOf(events)).toContain('session:cancelled');
    await expect(s.sendMessage('after cancel')).rejects.toBeInstanceOf(SessionStateError);
  });

  it('cancel() during an in-flight turn wins: session:cancelled is the terminal, no turn_completed', async () => {
    const { deps, events } = harness([textTurn('streaming…')]);
    const sink = deps.emit;
    // The cancelling deps must reference the running session, which is constructed after them — a holder.
    const ref: { session?: AgentSession } = {};
    let cancelled = false;
    const cancellingDeps: SessionDeps = {
      ...deps,
      emit: (event) => {
        sink(event);
        // Cancel the moment the first token streams (the turn is in flight inside runAgentTurn).
        if (event.type === 'agent:token' && !cancelled) {
          cancelled = true;
          ref.session?.cancel();
        }
      },
    };
    const s = new AgentSession({
      sessionId: 'sess-2',
      agentRef: AGENT.id,
      agent: AGENT,
      context: CONTEXT,
      deps: cancellingDeps,
    });
    ref.session = s;
    s.start();
    await s.sendMessage('stream then cancel');

    expect(typesOf(events)).toContain('session:cancelled');
    // The cancelled turn must NOT also emit a turn_completed (cancel owns the terminal).
    expect(events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(0);
  });

  it('guards the lifecycle: sendMessage before start, and double start, throw SessionStateError', async () => {
    const { deps } = harness([textTurn('x')]);
    const s = session(deps);
    await expect(s.sendMessage('too early')).rejects.toBeInstanceOf(SessionStateError);
    s.start();
    expect(() => {
      s.start();
    }).toThrow(SessionStateError);
  });

  it('exposes a finite default hard cap', () => {
    expect(DEFAULT_SESSION_MAX_TURNS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_SESSION_MAX_TURNS)).toBe(true);
  });
});

describe('AgentSession → createSessionEventSink → RunEventBus → SessionHandle (1.W end-to-end)', () => {
  it('streams a full session through the bus with a per-session sequence; cancel is the terminal', async () => {
    let tick = Date.parse('2026-06-13T00:00:00.000Z');
    const b = new RunEventBus({ now: () => new Date(tick++).toISOString() });
    // The handle subscribes BEFORE session:started is emitted (no startup race) — mirrors RunHandle (1.N).
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    const deps: SessionDeps = {
      resolveProvider: () => scriptedProvider([textTurn('hello back')]),
      registry: noToolRegistry,
      tools: [],
      keyFor: () => 'key',
      sleep: () => Promise.resolve(),
      newAbortController: createAbortController,
      emit: createSessionEventSink(b, 'sess-1'), // the 1.W wiring under test
    };
    const s = new AgentSession({
      sessionId: 'sess-1',
      agentRef: AGENT.id,
      agent: AGENT,
      context: CONTEXT,
      deps,
    });
    s.start();
    await s.sendMessage('hello');
    s.cancel(); // session:cancelled — the session stream's sole terminal

    const events = await drainSession(handle.events);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session:started');
    expect(types).toContain('session:turn_started');
    expect(types).toContain('agent:token'); // an in-turn dual event, carried with sessionId
    expect(types).toContain('session:turn_completed');
    expect(types.at(-1)).toBe('session:cancelled');
    // Every event carries the sessionId, and the per-session sequence is monotonic + gap-free from 0.
    expect(events.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(events.map((e) => e.sequenceNumber)).toEqual(events.map((_, i) => i));
  });
});

describe('AgentSession — reseat-less modes + mid-turn abort (ADR-0057 Step 2)', () => {
  it('abort() ends the in-flight turn as turn_completed{aborted} (no error) and keeps the session alive', async () => {
    // This abort lands PRE-EGRESS (synchronous abort() → the turn core throws at its pre-egress
    // throwIfAborted before the provider stream), so the turn engaged no provider. The mid-stream
    // (engaged) abort is exercised by the barrier test below.
    const { deps, events } = harness([textTurn('hi')]);
    const s = session(deps);
    s.start();
    const p = s.sendMessage('hi');
    s.abort();
    await p;

    const completes = events.filter((e) => e.type === 'session:turn_completed');
    expect(completes).toHaveLength(1);
    const aborted = completes[0];
    expect(aborted?.type === 'session:turn_completed' && aborted.stopReason).toBe('aborted');
    // aborted carries NO error (user-initiated, not a failure) and is NOT the terminal session:cancelled.
    expect(aborted?.type === 'session:turn_completed' ? aborted.error : 'x').toBeUndefined();
    expect(typesOf(events)).not.toContain('session:cancelled');

    // The session is alive — a second turn runs to normal completion.
    await s.sendMessage('again');
    const after = events.filter((e) => e.type === 'session:turn_completed');
    expect(after).toHaveLength(2);
    expect(after[1]?.type === 'session:turn_completed' && after[1].stopReason).toBe('stop');
  });

  it('abort() rolls the pending user message back — the aborted turn leaves no transcript trace', async () => {
    const scripts = [textTurn('partial'), textTurn('answer')];
    const seenUserTexts: string[][] = [];
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        seenUserTexts.push(
          req.messages
            .filter((m) => m.role === 'user')
            .flatMap((m) => m.content.flatMap((c) => (c.type === 'text' ? [c.text] : []))),
        );
        return streamOf(scripts[seenUserTexts.length - 1] ?? []);
      },
    };
    const { deps } = harness(scripts, { resolveProvider: () => provider });
    const s = session(deps);
    s.start();
    const p = s.sendMessage('aborted-msg');
    s.abort();
    await p;
    await s.sendMessage('kept-msg');
    // The LAST outbound request (turn 2) carries ONLY 'kept-msg' — never ['aborted-msg', 'kept-msg'].
    // The aborted turn's user message was rolled back, so it is not carried into the next turn's transcript.
    // (Robust to whether turn 1 reached the provider before the abort landed.)
    expect(seenUserTexts.at(-1)).toEqual(['kept-msg']);
  });

  it('abort() is a no-op when no turn is in flight (idle) — emits nothing, the session stays usable', async () => {
    const { deps, events } = harness([textTurn('ok')]);
    const s = session(deps);
    s.start();
    s.abort(); // idle — nothing to abort
    expect(typesOf(events)).toEqual(['session:started']);
    await s.sendMessage('hi');
    expect(events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(1);
  });

  it('cancel() wins over a concurrent abort() — session:cancelled is the terminal, no turn_completed{aborted}', async () => {
    const { deps, events } = harness([textTurn('partial')]);
    const s = session(deps);
    s.start();
    const p = s.sendMessage('hi');
    s.abort();
    s.cancel(); // terminal precedence over the abort
    await p;
    expect(typesOf(events)).toContain('session:cancelled');
    expect(events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(0);
  });

  it('setTurnPolicy advertise-filter narrows the model-visible tool set (lossless, next turn)', async () => {
    const readFileDef = BUILTIN_TOOLS.find((t) => t.id === 'read_file');
    if (readFileDef === undefined) throw new Error('read_file builtin missing');
    const scripts = [textTurn('a'), textTurn('b')];
    let advertised: string[] = [];
    let n = 0;
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        advertised = (req.tools ?? []).map((t) => t.name);
        return streamOf(scripts[n++] ?? []);
      },
    };
    const reader = AgentSchema.parse({
      id: 'reader',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'x',
      tools: ['read_file'],
    });
    const { deps } = harness(scripts, { resolveProvider: () => provider, tools: [readFileDef] });
    const s = session(deps, reader);
    s.start();
    await s.sendMessage('no policy'); // advertise every granted tool
    expect(advertised).toContain('read_file');
    s.setTurnPolicy({ advertise: (id) => id !== 'read_file' }); // filter it out next turn
    await s.sendMessage('filtered');
    expect(advertised).not.toContain('read_file');
  });

  it('sends the authored reasoning_effort ONLY when the model is reasoning-capable (ADR-0066)', async () => {
    const reader = AgentSchema.parse({
      id: 'reader',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'x',
      reasoning_effort: 'high',
    });
    const capturing = (): { provider: LlmProvider; effort: () => unknown } => {
      let effort: unknown = 'UNSET';
      const provider: LlmProvider = {
        id: 'anthropic',
        supports: CAPS,
        generate: () => {
          throw new Error('unused');
        },
        stream: (req) => {
          effort = req.reasoningEffort;
          return streamOf(textTurn('ok'));
        },
      };
      return { provider, effort: () => effort };
    };
    // Reasoning-capable ⇒ the tier reaches the request.
    const on = capturing();
    const onSession = session(
      harness([textTurn('ok')], { resolveProvider: () => on.provider, resolveReasoning: () => true })
        .deps,
      reader,
    );
    onSession.start();
    await onSession.sendMessage('go');
    expect(on.effort()).toBe('high');
    // NOT reasoning-capable ⇒ the tier is WITHHELD (a non-reasoning model would reject it).
    const off = capturing();
    const offSession = session(
      harness([textTurn('ok')], {
        resolveProvider: () => off.provider,
        resolveReasoning: () => false,
      }).deps,
      reader,
    );
    offSession.start();
    await offSession.sendMessage('go');
    expect(off.effort()).toBeUndefined();
  });

  it('setReasoningEffort override wins over the authored tier on the NEXT turn — no reseat (ADR-0066 §5)', async () => {
    const reader = AgentSchema.parse({
      id: 'reader',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'x',
      reasoning_effort: 'low',
    });
    let effort: unknown = 'UNSET';
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        effort = req.reasoningEffort;
        return streamOf(textTurn('ok'));
      },
    };
    const s = session(
      harness([textTurn('ok')], { resolveProvider: () => provider, resolveReasoning: () => true }).deps,
      reader,
    );
    s.start();
    // Turn 1: no override yet ⇒ the authored 'low' rides; the getter reflects the effective tier.
    expect(s.reasoningEffort).toBe('low');
    await s.sendMessage('one');
    expect(effort).toBe('low');
    // A mid-session setter — the SAME instance, no reseat; the getter updates and it lands on the NEXT turn.
    s.setReasoningEffort('max');
    expect(s.reasoningEffort).toBe('max'); // override ?? agent
    await s.sendMessage('two');
    expect(effort).toBe('max');
    // Clearing the override falls back to the authored tier.
    s.setReasoningEffort(undefined);
    expect(s.reasoningEffort).toBe('low');
  });

  it('a session-effort override is STILL per-model gated — withheld on a non-reasoning model (ADR-0066 §4)', async () => {
    const reader = AgentSchema.parse({
      id: 'reader',
      model: 'gpt-4o',
      provider: 'openai',
      system_prompt: 'x',
    });
    let effort: unknown = 'UNSET';
    const provider: LlmProvider = {
      id: 'openai',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        effort = req.reasoningEffort;
        return streamOf(textTurn('ok'));
      },
    };
    const s = session(
      harness([textTurn('ok')], { resolveProvider: () => provider, resolveReasoning: () => false }).deps,
      reader,
    );
    s.start();
    s.setReasoningEffort('high'); // the user set a tier, but the model does not reason
    await s.sendMessage('go');
    expect(effort).toBeUndefined(); // gated off at send — a non-reasoning model would reject it
  });

  it('setTurnPolicy activates the approval regime — the dispatch context carries the confirm hook', async () => {
    const confirm = (): Promise<{ outcome: 'approve' }> => Promise.resolve({ outcome: 'approve' });
    let captured: ToolDispatchContext | undefined;
    const capturing: ToolRegistry = {
      has: () => true,
      list: () => ['echo'],
      dispatch: (toolCall, ctx) => {
        captured = ctx;
        return echoRegistry.dispatch(toolCall, ctx);
      },
    };
    const { deps } = harness([toolUseTurn('c1'), textTurn('done')], {}, capturing);
    const s = session(deps, TOOL_AGENT);
    s.start();
    s.setTurnPolicy({ confirm });
    await s.sendMessage('use echo');
    expect(captured?.approval?.confirm).toBe(confirm);
  });

  it('wires emitApprovalRequested (EA5) — it emits agent:approval_requested through the sink, stamping the nodeId', async () => {
    let captured: ToolDispatchContext | undefined;
    const capturing: ToolRegistry = {
      has: () => true,
      list: () => ['echo'],
      dispatch: (toolCall, ctx) => {
        captured = ctx;
        return echoRegistry.dispatch(toolCall, ctx);
      },
    };
    const { deps, events } = harness([toolUseTurn('c1'), textTurn('done')], {}, capturing);
    const s = session(deps, TOOL_AGENT);
    s.start();
    s.setTurnPolicy({ confirm: () => Promise.resolve({ outcome: 'approve' }) });
    await s.sendMessage('use echo');
    // The engine provided the emit; invoking it (as confirmDispatch does) puts a valid event on the sink.
    captured?.approval?.emitApprovalRequested?.({
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: './out.txt' },
    });
    const approvalEvent = events.find((e) => e.type === 'agent:approval_requested');
    expect(approvalEvent).toMatchObject({
      type: 'agent:approval_requested',
      nodeId: TOOL_AGENT.id, // stamped from the session's agentRef (matches the in-turn events)
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: './out.txt' },
    });
    // The emitted body, once the sink stamps the session envelope (1.W), is a SCHEMA-VALID run event — the
    // action-bound preview + dual-envelope refinements accept it (this is what the bus parses against).
    const validated = RunEventSchema.safeParse({
      ...approvalEvent,
      sessionId: 's1',
      timestamp: '2026-06-19T00:00:00.000Z',
      sequenceNumber: 0,
    });
    expect(validated.success).toBe(true);
  });

  it('no turn policy ⇒ no approval regime in the dispatch context (workflow author-trust parity)', async () => {
    let captured: ToolDispatchContext | undefined;
    const capturing: ToolRegistry = {
      has: () => true,
      list: () => ['echo'],
      dispatch: (toolCall, ctx) => {
        captured = ctx;
        return echoRegistry.dispatch(toolCall, ctx);
      },
    };
    const { deps } = harness([toolUseTurn('c1'), textTurn('done')], {}, capturing);
    const s = session(deps, TOOL_AGENT);
    s.start();
    await s.sendMessage('use echo'); // no setTurnPolicy
    expect(captured?.approval).toBeUndefined();
  });

  it('a policy WITHOUT a confirm hook threads approval:{} — the fail-closed regime (no_approval_hook floor)', async () => {
    // The security-critical middle state: a set policy with no confirm activates the regime as approval:{}
    // (present-but-empty), which the Step-1 registry floor turns into a fail-closed `no_approval_hook` deny.
    // A regression collapsing this to `undefined` would silently re-grant the author-trust floor to a moded
    // session (letting `ask` mode write), so pin the threading here.
    let captured: ToolDispatchContext | undefined;
    const capturing: ToolRegistry = {
      has: () => true,
      list: () => ['echo'],
      dispatch: (toolCall, ctx) => {
        captured = ctx;
        return echoRegistry.dispatch(toolCall, ctx);
      },
    };
    const { deps } = harness([toolUseTurn('c1'), textTurn('done')], {}, capturing);
    const s = session(deps, TOOL_AGENT);
    s.start();
    s.setTurnPolicy({ advertise: () => true }); // a policy, but NO confirm
    await s.sendMessage('use echo');
    expect(captured?.approval).toStrictEqual({}); // present (regime active) but confirm-less (fail-closed)
  });

  it('setTurnPolicy(undefined) CLEARS the regime — re-advertises every granted tool', async () => {
    // The clear path (e.g. Shift+Tab back to a no-filter mode) must re-advertise all granted tools. The
    // approval-key half of the clear is the same observable as the no-policy test above (approval undefined).
    const readFileDef = BUILTIN_TOOLS.find((t) => t.id === 'read_file');
    if (readFileDef === undefined) throw new Error('read_file builtin missing');
    const scripts = [textTurn('a'), textTurn('b')];
    let advertised: string[] = [];
    let n = 0;
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req) => {
        advertised = (req.tools ?? []).map((t) => t.name);
        return streamOf(scripts[n++] ?? []);
      },
    };
    const reader = AgentSchema.parse({
      id: 'reader',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'x',
      tools: ['read_file'],
    });
    const { deps } = harness(scripts, { resolveProvider: () => provider, tools: [readFileDef] });
    const s = session(deps, reader);
    s.start();
    s.setTurnPolicy({ advertise: () => false }); // filter read_file OUT
    await s.sendMessage('filtered');
    expect(advertised).not.toContain('read_file');
    s.setTurnPolicy(undefined); // CLEAR
    await s.sendMessage('cleared');
    expect(advertised).toContain('read_file'); // re-advertised
  });

  it('aborts an ENGAGED mid-stream turn — real partial usage, counted, session alive (barrier-controlled)', async () => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    async function* blockingStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: 'partial' }; // a provider engaged + a token streamed
      await barrier; // hold the turn open mid-stream until the test releases it
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 7, outputTokens: 4 } };
    }
    let n = 0;
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: () => (n++ === 0 ? blockingStream() : streamOf(textTurn('next'))),
    };
    const { deps, events } = harness([], { resolveProvider: () => provider });
    const s = session(deps, AGENT);
    s.start();
    const p = s.sendMessage('hi');
    // A setTimeout(0) macrotask fires only AFTER all pending microtasks drain (single-threaded JS), so the
    // turn has deterministically engaged, streamed 'partial', and parked at `await barrier` by the time this
    // resolves — making the mid-stream abort below non-flaky, not a timing guess.
    await new Promise((r) => setTimeout(r, 0));
    s.abort(); // mid-stream abort — a provider HAS engaged
    release();
    await p;

    const tokens = events.filter((e) => e.type === 'agent:token');
    expect(tokens.map((e) => (e.type === 'agent:token' ? e.token : ''))).toContain('partial'); // engaged
    const completes = events.filter((e) => e.type === 'session:turn_completed');
    expect(completes).toHaveLength(1);
    const aborted = completes[0];
    expect(aborted?.type === 'session:turn_completed' && aborted.stopReason).toBe('aborted');
    // EA2: the aborted turn reports REAL accumulated usage (a provider engaged), not a hardcoded zero.
    expect(aborted?.type === 'session:turn_completed' && aborted.tokensUsed.input).toBeGreaterThan(
      0,
    );
    // The session is alive — a second turn still runs.
    await s.sendMessage('again');
    expect(events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(2);
  });

  it('a pre-egress (un-engaged) abort does NOT burn a max_turns slot — the cap is engaged-gated', async () => {
    // maxTurns=1: an aborted, un-engaged turn must not consume the only slot, so the next turn still runs.
    const { deps, events } = harness([textTurn('ok')], { maxTurns: 1 });
    const s = session(deps, AGENT);
    s.start();
    const p = s.sendMessage('abort me');
    s.abort(); // pre-egress (un-engaged)
    await p;
    await s.sendMessage('real turn'); // must NOT hit the cap
    const completes = events.filter((e) => e.type === 'session:turn_completed');
    expect(completes).toHaveLength(2);
    expect(completes[0]?.type === 'session:turn_completed' && completes[0].stopReason).toBe(
      'aborted',
    );
    // The second turn ran (not blocked by turn_limit) — the aborted un-engaged turn did not count.
    expect(completes[1]?.type === 'session:turn_completed' && completes[1].stopReason).toBe('stop');
  });

  it('abort() from the turn_started emit sink aborts THIS turn (the controller is armed BEFORE the emit)', async () => {
    // Regression: if the controller were armed AFTER the turn_started emit, an abort() from the emit sink
    // would set #abortingTurn but no-op the (undefined) signal, so a later real failure would misclassify as
    // 'aborted'. With the controller armed first, the abort actually aborts the turn → it settles 'aborted'.
    const sinkEvents: SessionStreamEvent[] = [];
    const ref: { s?: AgentSession } = {}; // a const holder — the emit closure reads it before `s` exists
    const { deps } = harness([textTurn('hi')], {
      emit: (e) => {
        sinkEvents.push(e);
        if (e.type === 'session:turn_started') ref.s?.abort();
      },
    });
    const s = session(deps);
    ref.s = s;
    s.start();
    await s.sendMessage('hi');
    const completes = sinkEvents.filter((e) => e.type === 'session:turn_completed');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.type === 'session:turn_completed' && completes[0].stopReason).toBe(
      'aborted',
    );
    expect(sinkEvents.map((e) => e.type)).not.toContain('session:cancelled');
  });

  // NOTE on the LATE-abort no-op (abort() landing in the microtask gap AFTER the turn core's final abort
  // check but BEFORE the success path runs): it is **structurally** a no-op — the success path has NO
  // `#abortingTurn` read, so it always completes the turn normally regardless of the flag (the `finally`
  // clears it). There is no deterministic emit hook past the core's last `throwIfAborted` to drive that exact
  // gap (a hook on the last in-turn event, cost:updated, lands BEFORE that check → a mid-stream abort, which
  // the engaged-mid-stream test above already covers), so the guarantee is pinned by the code's structure,
  // not a contrived race test.

  it('setTurnPolicy(undefined) CLEARS the approval regime too — the dispatch context drops the approval key', async () => {
    const confirm = (): Promise<{ outcome: 'approve' }> => Promise.resolve({ outcome: 'approve' });
    let captured: ToolDispatchContext | undefined;
    const capturing: ToolRegistry = {
      has: () => true,
      list: () => ['echo'],
      dispatch: (toolCall, ctx) => {
        captured = ctx;
        return echoRegistry.dispatch(toolCall, ctx);
      },
    };
    const { deps } = harness(
      [toolUseTurn('c1'), textTurn('a'), toolUseTurn('c2'), textTurn('b')],
      {},
      capturing,
    );
    const s = session(deps, TOOL_AGENT);
    s.start();
    s.setTurnPolicy({ confirm });
    await s.sendMessage('with regime');
    expect(captured?.approval?.confirm).toBe(confirm); // regime active
    s.setTurnPolicy(undefined); // CLEAR
    await s.sendMessage('cleared');
    expect(captured?.approval).toBeUndefined(); // regime gone — back to author-trust parity
  });
});

describe('AgentSession.runUserCommand — the `!`-shell escape (2.5.D, ADR-0061)', () => {
  const RAN: ProcessResult = { exitCode: 0, stdout: 'FILES\n', stderr: '', durationMs: 3 };
  /** The REAL registry over the `run_command` builtin + a fake process arm, so a dispatch exercises the ACTUAL
   *  enforcePolicy (allowlist) → confirmDispatch (approval) → spawn path — never a stubbed registry. */
  const commandRegistry = (
    spawn: (command: string, args: readonly string[]) => Promise<ProcessResult>,
  ): { registry: ToolRegistry; calls: { command: string; args: readonly string[] }[] } => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const host: ToolHost = {
      process: {
        spawn: (command, args) => {
          calls.push({ command, args });
          return spawn(command, args);
        },
      },
    };
    return { registry: createToolRegistry({ tools: BUILTIN_TOOLS, host }), calls };
  };
  const startedSession = (deps: SessionDeps): AgentSession => {
    const s = session(deps, AGENT); // the default agent does NOT grant run_command — runUserCommand grants it itself
    s.start();
    return s;
  };

  it('an unlisted command is DENIED before any spawn, flagged as an allowlist miss (actionable hint)', async () => {
    const { registry, calls } = commandRegistry(() => Promise.resolve(RAN));
    const { deps } = harness([], { toolPolicy: {} }, registry); // empty allowlist ⇒ `!` disabled
    const outcome = await startedSession(deps).runUserCommand('ls', ['-la']);
    expect(outcome.kind).toBe('denied');
    expect(outcome.kind === 'denied' && outcome.allowlist).toBe(true); // an allowlist miss (not an approval reject)
    expect(calls).toHaveLength(0); // enforcePolicy denied BEFORE the side effect — the process never spawned
  });

  it('an allowlisted command with no approval regime RUNS and returns the bounded output', async () => {
    const { registry, calls } = commandRegistry(() => Promise.resolve(RAN));
    const { deps } = harness([], { toolPolicy: { allowedCommands: ['ls -la'] } }, registry);
    const outcome = await startedSession(deps).runUserCommand('ls', ['-la']);
    expect(outcome).toEqual({
      kind: 'ran',
      exitCode: 0,
      stdout: 'FILES\n',
      stderr: '',
    });
    // The exact-match allowlist matched the joined `command + args`; the process spawned with the split argv.
    expect(calls).toEqual([{ command: 'ls', args: ['-la'] }]);
  });

  it('rejects a process result missing a required field (durationMs) as an unexpected shape — the boundary guard', async () => {
    // Simulate a future process-arm drift that omits `durationMs`; the FULL-shape boundary guard must fail loudly,
    // not pass a partial result to the model. (A deliberate cast — the guard exists to catch exactly this untyped
    // runtime shape that the type system cannot see across the dispatch boundary.)
    const malformed = { exitCode: 0, stdout: 'x', stderr: '' } as unknown as ProcessResult;
    const { registry } = commandRegistry(() => Promise.resolve(malformed));
    const { deps } = harness([], { toolPolicy: { allowedCommands: ['ls'] } }, registry);
    const outcome = await startedSession(deps).runUserCommand('ls', []);
    expect(outcome).toEqual({
      kind: 'failed',
      message: 'run_command returned an unexpected result shape',
    });
  });

  it('a glob-allowlisted command RUNS (opt-in allowedCommandGlobs)', async () => {
    const { registry } = commandRegistry(() => Promise.resolve(RAN));
    const { deps } = harness([], { toolPolicy: { allowedCommandGlobs: ['git *'] } }, registry);
    const outcome = await startedSession(deps).runUserCommand('git', ['status']);
    expect(outcome.kind).toBe('ran');
  });

  it('under an approval regime, a REJECT denies (not an allowlist miss) and never spawns', async () => {
    const { registry, calls } = commandRegistry(() => Promise.resolve(RAN));
    const { deps } = harness([], { toolPolicy: { allowedCommands: ['ls'] } }, registry);
    const s = startedSession(deps);
    s.setTurnPolicy({ confirm: () => Promise.resolve({ outcome: 'reject', reason: 'ask mode' }) });
    const outcome = await s.runUserCommand('ls', []);
    expect(outcome.kind).toBe('denied');
    expect(outcome.kind === 'denied' && outcome.allowlist).toBe(false); // a mode/approval deny, not an allowlist miss
    expect(calls).toHaveLength(0); // confirmAction rejected BEFORE the spawn
  });

  it('under an approval regime, an APPROVE runs the allowlisted command', async () => {
    const { registry, calls } = commandRegistry(() => Promise.resolve(RAN));
    const { deps } = harness([], { toolPolicy: { allowedCommands: ['ls'] } }, registry);
    const s = startedSession(deps);
    s.setTurnPolicy({ confirm: () => Promise.resolve({ outcome: 'approve' }) });
    const outcome = await s.runUserCommand('ls', []);
    expect(outcome.kind).toBe('ran');
    expect(calls).toHaveLength(1);
  });

  it('a spawn fault classifies as `failed` with a secret-free message (never a raw throw)', async () => {
    // A raw host fault (a plain Error) — the registry stamps it as a ToolExecutionError naming the tool, and
    // runUserCommand maps that to `failed` (the message is the registry's secret-free `tool ... failed`).
    const { registry } = commandRegistry(() =>
      Promise.reject(new Error('spawn ENOENT secret-path')),
    );
    const { deps } = harness([], { toolPolicy: { allowedCommands: ['nope'] } }, registry);
    const outcome = await startedSession(deps).runUserCommand('nope', []);
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.message).toContain('run_command');
    expect(outcome.kind === 'failed' && outcome.message).not.toContain('secret-path'); // raw detail not echoed
  });

  it('classifies a mid-command cancel as `cancelled` (an aborted dispatch signal, not a failure)', async () => {
    // The spawn cancels the session mid-run — aborting the dispatch signal `runUserCommand` armed — then rejects.
    // The registry classifies an aborted dispatch as ToolCancelledError (cancel precedence), which runUserCommand
    // maps to `cancelled` (never `failed`).
    const ref: { s?: AgentSession } = {};
    const { registry } = commandRegistry(() => {
      ref.s?.cancel(); // aborts the command's signal
      return Promise.reject(new Error('killed'));
    });
    const { deps } = harness([], { toolPolicy: { allowedCommands: ['sleep'] } }, registry);
    const s = startedSession(deps);
    ref.s = s;
    const outcome = await s.runUserCommand('sleep', []); // joined 'sleep' matches the allowlist → reaches the spawn
    expect(outcome.kind).toBe('cancelled');
  });

  it('is lifecycle-guarded: runUserCommand before start throws SessionStateError', async () => {
    const { registry } = commandRegistry(() => Promise.resolve(RAN));
    const { deps } = harness([], { toolPolicy: { allowedCommands: ['ls'] } }, registry);
    const s = session(deps, AGENT); // NOT started
    await expect(s.runUserCommand('ls', [])).rejects.toBeInstanceOf(SessionStateError);
  });

  it('leaves the session idle + reusable after a command (a sendMessage still works)', async () => {
    const { registry } = commandRegistry(() => Promise.resolve(RAN));
    const { deps, events } = harness(
      [textTurn('after')],
      { toolPolicy: { allowedCommands: ['ls'] } },
      registry,
    );
    const s = startedSession(deps);
    await s.runUserCommand('ls', []);
    await s.sendMessage('and now a message'); // no SessionStateError — the command left the session idle
    // The message drove ONE real turn to a clean completion — a loud postcondition that the command left the
    // session idle + reusable (`runUserCommand` itself emits no turn events, so this turn is the message's).
    const completes = events.filter((e) => e.type === 'session:turn_completed');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.type === 'session:turn_completed' && completes[0].stopReason).toBe('stop');
  });
});

// --- Context compaction (ADR-0062) ---------------------------------------------------------------

interface CompactCaptured {
  readonly requests: LlmRequest[];
}

interface CompactOpts {
  readonly contextLimit?: number | undefined;
  readonly managesOwnContext?: boolean;
  readonly estimate?: (input: EstimateTokensInput) => number;
}

/** A provider that captures each request (to assert the summariser prompt + the injected preamble) and
 *  implements the ADR-0062 seam methods with test-controllable values. */
function compactionProvider(
  scripts: StreamChunk[][],
  opts: CompactOpts = {},
): { readonly provider: LlmProvider; readonly captured: CompactCaptured } {
  const captured: CompactCaptured = { requests: [] };
  let call = 0;
  const provider: LlmProvider = {
    id: 'anthropic',
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: (req) => {
      captured.requests.push(req);
      return streamOf(scripts[call++] ?? []);
    },
    contextLimit: () => opts.contextLimit,
    managesOwnContext: () => opts.managesOwnContext ?? false,
    estimateTokens: (input) => opts.estimate?.(input) ?? 0,
  };
  return { provider, captured };
}

function compactHarness(
  scripts: StreamChunk[][],
  opts: CompactOpts = {},
  depsOverrides: Partial<SessionDeps> = {},
): { session: AgentSession; events: SessionStreamEvent[]; captured: CompactCaptured } {
  const events: SessionStreamEvent[] = [];
  const { provider, captured } = compactionProvider(scripts, opts);
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry: noToolRegistry,
    tools: [],
    keyFor: () => 'key',
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    emit: (event) => {
      events.push(event);
    },
    ...depsOverrides,
  };
  const s = new AgentSession({
    sessionId: 'sess-1',
    agentRef: AGENT.id,
    agent: AGENT,
    context: CONTEXT,
    deps,
  });
  return { session: s, events, captured };
}

describe('AgentSession — context compaction + trim (ADR-0062)', () => {
  it('compact() folds earlier turns into a system-prompt preamble and keeps the last exchange', async () => {
    // Large window ⇒ auto-compaction never fires; we drive compact() manually. 3 turns then a summary.
    const {
      session: s,
      events,
      captured,
    } = compactHarness([textTurn('a1'), textTurn('a2'), textTurn('SUMMARY-TEXT'), textTurn('a3')], {
      contextLimit: 1_000_000,
    });
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');

    const result = await s.compact('manual');
    expect(result.kind).toBe('compacted');
    if (result.kind === 'compacted') {
      expect(result.summary).toBe('SUMMARY-TEXT');
      expect(result.keptMessageCount).toBe(2); // the last user+assistant exchange stays verbatim
    }
    // The summariser call used the AUTHORED compaction system prompt, and the conversation to summarise rode
    // a USER message (never the system prompt) carrying the folded earlier turn.
    const summaryReq = captured.requests[2];
    expect(summaryReq?.system).toBe(COMPACTION_SYSTEM_PROMPT);
    const summaryUser = summaryReq?.messages[0];
    expect(summaryUser?.role).toBe('user');
    const summaryText =
      summaryUser?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(summaryText).toContain('User: q1');
    expect(summaryText).toContain('Assistant: a1');
    // The compaction MOMENT was announced (ADR-0062 §7): session:compacting fired BEFORE the terminal
    // session:compacted, carrying the same reason — the host drives a labeled "Summarizing…" indicator off it.
    const compactingIdx = events.findIndex((e) => e.type === 'session:compacting');
    const compactedIdx = events.findIndex((e) => e.type === 'session:compacted');
    expect(compactingIdx).toBeGreaterThanOrEqual(0);
    expect(compactedIdx).toBeGreaterThan(compactingIdx); // START precedes the terminal
    const compacting = events[compactingIdx];
    expect(compacting?.type === 'session:compacting' && compacting.reason).toBe('manual');
    // A session:compacted event carried the summary + the summarisation spend (accounted, ADR-0028).
    const compacted = events.find((e) => e.type === 'session:compacted');
    expect(compacted?.type === 'session:compacted' && compacted.reason).toBe('manual');
    expect(compacted?.type === 'session:compacted' && compacted.tokensUsed.input).toBe(5);

    // The NEXT turn's system prompt now carries the preamble (reseat-free, applies from the next turn).
    await s.sendMessage('q3');
    expect(captured.requests[3]?.system).toContain('<earlier-conversation-summary>\nSUMMARY-TEXT');
  });

  it('compact() is a no-op with ≤1 exchange (nothing to fold)', async () => {
    const { session: s, events } = compactHarness([textTurn('a1')], { contextLimit: 1_000_000 });
    s.start();
    await s.sendMessage('q1'); // one exchange only
    const result = await s.compact('manual');
    expect(result.kind).toBe('nothing_to_compact');
    expect(events.some((e) => e.type === 'session:compacted')).toBe(false);
  });

  it('trimHistory() deterministically drops older messages, emits session:trimmed, no LLM call', async () => {
    const {
      session: s,
      events,
      captured,
    } = compactHarness([textTurn('a1'), textTurn('a2'), textTurn('a3')], {
      contextLimit: 1_000_000,
    });
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');
    await s.sendMessage('q3'); // #messages now [u,a,u,a,u,a] (6)
    const before = captured.requests.length;

    const result = s.trimHistory(2); // keep the last exchange
    expect(result).toEqual({ kind: 'trimmed', keptMessageCount: 2, droppedMessageCount: 4 });
    expect(events.some((e) => e.type === 'session:trimmed')).toBe(true);
    expect(captured.requests).toHaveLength(before); // NO summarisation call — deterministic

    // Trimming to a bound larger than the history is a no-op.
    expect(s.trimHistory(100)).toEqual({ kind: 'nothing_to_trim', messageCount: 2 });
  });

  it('auto-compacts after a turn whose real input tokens exceed threshold × the model window', async () => {
    // window 10000 × 0.8 = 8000 budget; each turn reports 9000 input (> 8000). The projected floor
    // (base estimate 0 + the 4096 summary bound) is under budget, so guard-b passes. Turn 1 skips (≤1
    // exchange); after turn 2 (2 exchanges) it fires and consumes the SUMMARY script.
    const { session: s, events } = compactHarness(
      [inputTurn('a1', 9000), inputTurn('a2', 9000), textTurn('AUTO-SUMMARY')],
      { contextLimit: 10_000 },
    );
    s.start();
    await s.sendMessage('q1');
    expect(events.some((e) => e.type === 'session:compacted')).toBe(false); // ≤1 exchange — guarded
    await s.sendMessage('q2');
    const compacted = events.find((e) => e.type === 'session:compacted');
    expect(compacted?.type === 'session:compacted' && compacted.reason).toBe('auto-threshold');
  });

  it('auto-compaction is skipped by config / provider / window guards', async () => {
    const cases: Array<{ opts: CompactOpts; deps: Partial<SessionDeps> }> = [
      { opts: { contextLimit: 6 }, deps: { autoCompact: false } }, // disabled by config
      { opts: { contextLimit: 6, managesOwnContext: true }, deps: {} }, // provider bounds its own context
      { opts: { contextLimit: undefined }, deps: {} }, // unrated/custom model — window unknown
      { opts: { contextLimit: 1_000_000 }, deps: {} }, // under the threshold (5 ≤ 800k)
    ];
    for (const { opts, deps } of cases) {
      const { session: s, events } = compactHarness(
        [textTurn('a1'), textTurn('a2'), textTurn('UNUSED')],
        opts,
        deps,
      );
      s.start();
      await s.sendMessage('q1');
      await s.sendMessage('q2');
      expect(events.some((e) => e.type === 'session:compacted')).toBe(false);
    }
  });

  it('degrades a failed auto-compaction to a deterministic trim (maxMessages)', async () => {
    // The summariser returns NO text (empty summary ⇒ compact 'failed'); with maxMessages wired the session
    // falls back to a zero-cost /trim rather than sending an ever-growing context.
    const emptySummary: StreamChunk[] = [
      { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 0 } },
    ];
    const { session: s, events } = compactHarness(
      [inputTurn('a1', 9000), inputTurn('a2', 9000), emptySummary],
      { contextLimit: 10_000 },
      { maxMessages: 2 },
    );
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');
    expect(events.some((e) => e.type === 'session:compacted')).toBe(false); // the summary failed
    const trimmed = events.find((e) => e.type === 'session:trimmed');
    expect(trimmed?.type === 'session:trimmed' && trimmed.keptMessageCount).toBe(2); // degraded to /trim(2)
    expect(trimmed?.type === 'session:trimmed' && trimmed.droppedMessageCount).toBe(2);
    expect(trimmed?.type === 'session:trimmed' && trimmed.reason).toBe('auto-fallback'); // the view surfaces it
  });

  it('auto-compaction failure WITHOUT maxMessages leaves the context un-compacted (no throw, no trim)', async () => {
    const emptySummary: StreamChunk[] = [
      { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 0 } },
    ];
    const { session: s, events } = compactHarness(
      [inputTurn('a1', 9000), inputTurn('a2', 9000), emptySummary],
      { contextLimit: 10_000 },
      {}, // no maxMessages wired
    );
    s.start();
    await s.sendMessage('q1');
    await expect(s.sendMessage('q2')).resolves.toBeUndefined(); // no throw
    expect(events.some((e) => e.type === 'session:compacted')).toBe(false);
    expect(events.some((e) => e.type === 'session:trimmed')).toBe(false); // nothing to degrade to
  });

  it('skips auto-compaction when the projected floor would still exceed the budget (thrash guard b)', async () => {
    // window 10000 × 0.8 = 8000 budget; input 9000 triggers. The estimator reports 8000 for the base kept
    // context, so the projected floor (8000 + the 4096 summary bound) > budget → compaction cannot help; the
    // session must NOT pay a summariser call every turn, so the SUMMARY script is never consumed.
    const {
      session: s,
      events,
      captured,
    } = compactHarness([inputTurn('a1', 9000), inputTurn('a2', 9000), textTurn('NEVER-USED')], {
      contextLimit: 10_000,
      estimate: () => 8000,
    });
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');
    expect(events.some((e) => e.type === 'session:compacted')).toBe(false);
    expect(captured.requests).toHaveLength(2); // only the two real turns — no summariser call
  });

  it('trimHistory(1) keeps the last exchange rather than WIPING the transcript', async () => {
    const { session: s, captured } = compactHarness(
      [textTurn('a1'), textTurn('a2'), textTurn('a3')],
      { contextLimit: 1_000_000 },
    );
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2'); // #messages = [u,a,u,a]
    // trim(1) on a transcript ending in assistant must NOT forward-snap to empty (a full wipe) — it floors at
    // the last complete exchange.
    const result = s.trimHistory(1);
    expect(result).toEqual({ kind: 'trimmed', keptMessageCount: 2, droppedMessageCount: 2 });
    await s.sendMessage('q3');
    expect(captured.requests.at(-1)?.messages[0]?.role).toBe('user'); // protocol-valid next turn
  });

  it('does not keep a lone dangling user as the kept exchange (an empty-text turn)', async () => {
    // A completed turn with empty final text leaves a dangling `user` (sendMessage only appends the assistant
    // when result.text is non-empty). compact() must NOT keep that lone user as the "kept exchange" — with only
    // one complete exchange before it, there is nothing earlier to fold, so it is a clean no-op.
    const emptyTurn: StreamChunk[] = [
      { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 0 } },
    ];
    const { session: s, events } = compactHarness([textTurn('a1'), emptyTurn], {
      contextLimit: 1_000_000,
    });
    s.start();
    await s.sendMessage('q1'); // [u,a1]
    await s.sendMessage('q2'); // empty text → [u,a1,u2] (u2 dangling)
    const result = await s.compact('manual');
    expect(result.kind).toBe('nothing_to_compact'); // never a lone-user kept slice
    expect(events.some((e) => e.type === 'session:compacted')).toBe(false);
  });

  it('reports non-zero before/after token deltas from the estimator (before > after)', async () => {
    // The estimator returns message-count × 10 — the pre-fold context (more messages) estimates higher than
    // the post-fold context (the kept last exchange). Pins the before/after ordering + non-zero deltas.
    const { session: s, events } = compactHarness(
      [textTurn('a1'), textTurn('a2'), textTurn('SUMMARY')],
      { contextLimit: 1_000_000, estimate: (input) => input.messages.length * 10 },
    );
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2'); // #messages = 4
    const result = await s.compact('manual');
    expect(result.kind).toBe('compacted');
    const compacted = events.find((e) => e.type === 'session:compacted');
    if (compacted?.type === 'session:compacted') {
      expect(compacted.tokensBefore).toBe(40); // 4 messages × 10 (pre-fold)
      expect(compacted.tokensAfter).toBe(20); // 2 kept × 10 (post-fold)
      expect(compacted.tokensBefore).toBeGreaterThan(compacted.tokensAfter);
    }
  });

  it('a second compaction folds the PRIOR preamble into the new summary (summary-of-summary)', async () => {
    const { session: s, captured } = compactHarness(
      [
        textTurn('a1'),
        textTurn('a2'),
        textTurn('SUMMARY-1'),
        textTurn('a3'),
        textTurn('SUMMARY-2'),
      ],
      { contextLimit: 1_000_000 },
    );
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');
    await s.compact('manual'); // → preamble 'SUMMARY-1' (call 2)
    await s.sendMessage('q3'); // call 3
    const result = await s.compact('manual'); // → call 4, folding the prior preamble
    expect(result.kind === 'compacted' && result.summary).toBe('SUMMARY-2');
    const secondSummaryReq = captured.requests[4];
    const text =
      secondSummaryReq?.messages[0]?.content
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('') ?? '';
    expect(text).toContain('Summary of the conversation so far:');
    expect(text).toContain('SUMMARY-1'); // the prior preamble is folded in, not lost
  });

  it('abort() mid-summarisation yields cancelled, leaves the context unchanged, and the session stays usable', async () => {
    const { session: s, events } = compactHarness(
      [textTurn('a1'), textTurn('a2'), textTurn('SUMMARY')],
      { contextLimit: 1_000_000 },
    );
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');
    const pending = s.compact('manual');
    s.abort(); // EA7 — a synchronous abort lands pre-egress in the summariser turn core
    const result = await pending;
    expect(result.kind).toBe('cancelled');
    expect(events.some((e) => e.type === 'session:compacted')).toBe(false); // context unchanged, no event
    // The session stays alive after an abort — a fresh compact() now succeeds (consumes the SUMMARY script).
    const retry = await s.compact('manual');
    expect(retry.kind).toBe('compacted');
  });

  it('cancel() mid-summarisation yields cancelled and ends the (terminal) session', async () => {
    const { session: s, events } = compactHarness(
      [textTurn('a1'), textTurn('a2'), textTurn('SUMMARY')],
      { contextLimit: 1_000_000 },
    );
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');
    const pending = s.compact('manual');
    s.cancel(); // terminal
    const result = await pending;
    expect(result.kind).toBe('cancelled');
    expect(events.some((e) => e.type === 'session:cancelled')).toBe(true);
    expect(() => s.trimHistory(2)).toThrow(SessionStateError); // the session is terminal
  });

  it('compact() / trimHistory() before start throw SessionStateError (not_started)', async () => {
    const { session: s } = compactHarness([textTurn('a1')], { contextLimit: 1_000_000 });
    await expect(s.compact('manual')).rejects.toBeInstanceOf(SessionStateError);
    expect(() => s.trimHistory(2)).toThrow(SessionStateError);
  });

  it('trimHistory snaps the kept slice to a user boundary (drops an orphan leading assistant)', async () => {
    // Build [u,a,u,a,u,a] then trim to 3: the raw last-3 is [a,u,a] (assistant-first) → snapped to [u,a].
    const { session: s, captured } = compactHarness(
      [textTurn('a1'), textTurn('a2'), textTurn('a3'), textTurn('a4')],
      { contextLimit: 1_000_000 },
    );
    s.start();
    await s.sendMessage('q1');
    await s.sendMessage('q2');
    await s.sendMessage('q3'); // #messages = [u,a,u,a,u,a] (6)
    const result = s.trimHistory(3);
    expect(result).toEqual({ kind: 'trimmed', keptMessageCount: 2, droppedMessageCount: 4 });
    // The NEXT turn's outbound messages start on a user role (protocol-valid — no orphan assistant).
    await s.sendMessage('q4');
    expect(captured.requests.at(-1)?.messages[0]?.role).toBe('user');
  });
});
