/**
 * ADR-0119 through a real `AgentSession`: which turns are retained and which still roll back, what the next
 * request shows the model, live-versus-restored parity, and how compaction and resume treat an interrupted turn.
 * The pure sentence and projection rules are pinned in `turn-receipts.test.ts` / the shared projection tests; this
 * file proves they are wired into the session a surface actually runs.
 */
import type {
  CapabilityFlags,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  StreamChunk,
} from '@relavium/llm';
import {
  AgentSchema,
  ERROR_CODES,
  SessionContextSchema,
  type Agent,
  type SessionContext,
  type SessionInterruption,
  type SessionMessage,
  type SessionToolHistoryEntry,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { ToolCancelledError, ToolPolicyError } from '../tools/errors.js';
import type { ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { DEFAULT_AGENT_TURN_LIMITS, type AgentTurnLimits } from './agent-turn.js';
import {
  AgentSession,
  SessionStateError,
  type SessionDeps,
  type SessionStreamEvent,
} from './agent-session.js';
import { createAbortController } from './execution-host.js';
import { reconstructSessionState } from './session-resume.js';
import { renderInterruptionSentence, receiptsFromToolHistory } from './turn-receipts.js';

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

const AGENT: Agent = AgentSchema.parse({
  id: 'interrupt-chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are a concise chat agent.',
  tools: ['read_file', 'write_file', 'list_directory'],
});
const CONTEXT: SessionContext = SessionContextSchema.parse({
  workingDir: '/workspace/session',
  fsScopeTier: 'sandboxed',
});

const usage = { kind: 'complete' as const, usage: { inputTokens: 5, outputTokens: 3 } };
const textTurn = (text: string): StreamChunk[] => [
  { type: 'text_delta', text },
  { type: 'stop', stopReason: 'stop', usage },
];
const callsTurn = (calls: readonly { id: string; name: string }[]): StreamChunk[] => [
  ...calls.flatMap(({ id, name }): StreamChunk[] => [
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_end', id },
  ]),
  { type: 'stop', stopReason: 'tool_use', usage },
];
const failure: StreamChunk[] = [
  {
    type: 'error',
    error: { kind: 'bad_request', retryable: false, provider: 'anthropic', message: 'nope' },
  },
];

type Script = StreamChunk[] | (() => AsyncGenerator<StreamChunk>);

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

/** A promise a test can settle from outside. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface Behaviour {
  /** Tool names whose dispatch hangs until released, then is reported as cancelled. */
  readonly hang?: {
    readonly name: string;
    readonly entered: () => void;
    readonly release: Promise<void>;
  };
  /** Tool names refused fatally (a guardrail denial). */
  readonly deny?: readonly string[];
}

function makeRegistry(behaviour: Behaviour): ToolRegistry {
  return {
    has: () => true,
    list: () => ['read_file', 'write_file', 'list_directory'],
    dispatch: async (call) => {
      if (behaviour.hang?.name === call.name) {
        behaviour.hang.entered();
        await behaviour.hang.release;
        throw new ToolCancelledError(call.name);
      }
      if (behaviour.deny?.includes(call.name) === true)
        throw new ToolPolicyError(call.name, 'not_granted', 'not granted');
      const result: ToolResultPart = {
        type: 'tool_result',
        toolCallId: call.id,
        result: 'TOOL-OK-SECRET-RESULT',
      };
      return {
        output: result.result,
        mediaAttachments: markUntrusted([]),
        toolResult: markUntrusted(result),
        truncated: false,
        events: {
          call: { toolId: call.name, toolInput: {} },
          result: { toolId: call.name, success: true, outputSummary: 'x' },
        },
      };
    },
  };
}

interface Rig {
  readonly session: AgentSession;
  readonly requests: LlmRequest[];
  readonly events: SessionStreamEvent[];
}

function rig(
  scripts: Script[],
  options: {
    readonly behaviour?: Behaviour;
    readonly agent?: Agent;
    readonly limits?: Partial<AgentTurnLimits>;
    readonly maxTurns?: number;
    readonly deps?: Partial<SessionDeps>;
    readonly build?: (deps: SessionDeps) => AgentSession;
  } = {},
): Rig {
  const agent = options.agent ?? AGENT;
  const requests: LlmRequest[] = [];
  const events: SessionStreamEvent[] = [];
  let call = 0;
  const provider: LlmProvider = {
    id: 'anthropic',
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: (request) => {
      requests.push(request);
      const script = scripts[call++] ?? [];
      return typeof script === 'function' ? script() : streamOf(script);
    },
    contextLimit: () => 1_000_000,
    managesOwnContext: () => false,
    estimateTokens: () => 0,
  };
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry: makeRegistry(options.behaviour ?? {}),
    tools: [],
    limits: { ...DEFAULT_AGENT_TURN_LIMITS, recoverToolFailures: true, ...options.limits },
    maxTurns: options.maxTurns ?? 500,
    reserveEffectTurnKey: (() => {
      let key = 0;
      return () => ++key;
    })(),
    keyFor: () => 'key',
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    emit: (event) => {
      events.push(event);
    },
    ...options.deps,
  };
  const session =
    options.build?.(deps) ??
    new AgentSession({ sessionId: 'sess-i', agentRef: agent.id, agent, context: CONTEXT, deps });
  return { session, requests, events };
}

const textOf = (message: LlmMessage | undefined): string =>
  message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
const terminals = (events: readonly SessionStreamEvent[]) =>
  events.flatMap((event) => (event.type === 'session:turn_completed' ? [event] : []));

/** A script that streams one token, signals it engaged, then waits to be released and stops. */
function midStream(entered: () => void, release: Promise<void>): Script {
  return async function* () {
    yield { type: 'text_delta', text: 'PARTIAL-ANSWER' };
    entered();
    await release;
    yield { type: 'stop', stopReason: 'stop', usage };
  };
}

describe('which turns are retained (ADR-0119 §1)', () => {
  it('retains an abort after a provider engaged: the event names it, the next request shows it, no partial text', async () => {
    const entered = latch();
    const release = latch();
    const { session, events, requests } = rig([
      midStream(entered.open, release.promise),
      textTurn('next answer'),
    ]);
    session.start();
    const running = session.sendMessage('first request');
    await entered.promise;
    session.abort();
    release.open();
    await running;

    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({
      stopReason: 'aborted',
      interruption: { reason: 'aborted' },
      toolHistory: [],
    });
    expect(terminal?.error).toBeUndefined();

    await session.sendMessage('second request');
    const last = requests.at(-1)?.messages ?? [];
    // One user message: the interrupted request, the fixed note, then the new request folded after it.
    expect(last.map((m) => m.role)).toEqual(['user']);
    const text = textOf(last[0]);
    expect(text).toContain('first request');
    expect(text).toContain(
      '[This request was interrupted before it was answered: the user stopped it. ' +
        'No tool call was recorded for it. Nothing the assistant wrote before the interruption was kept.',
    );
    expect(text).toContain('second request');
    expect(text).not.toContain('PARTIAL-ANSWER');
    expect(text.indexOf('first request')).toBeLessThan(text.indexOf('second request'));
  });

  it('records the call in flight at an abort as cancelled, and a call that never started not at all', async () => {
    const entered = latch();
    const release = latch();
    const { session, events, requests } = rig(
      [
        callsTurn([
          { id: 'p1', name: 'read_file' },
          { id: 'p2', name: 'list_directory' },
        ]),
        textTurn('next answer'),
      ],
      {
        behaviour: { hang: { name: 'read_file', entered: entered.open, release: release.promise } },
      },
    );
    session.start();
    const running = session.sendMessage('read it');
    await entered.promise;
    session.abort();
    release.open();
    await running;

    const [terminal] = terminals(events);
    expect(terminal?.interruption).toEqual({ reason: 'aborted' });
    expect(terminal?.toolHistory).toHaveLength(1);
    expect(terminal?.toolHistory?.[0]).toMatchObject({
      call: { name: 'read_file' },
      result: { outcome: 'cancelled', resultBytes: 0 },
    });

    await session.sendMessage('again');
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('1. read_file — cancelled');
    expect(text).not.toContain('list_directory');
    expect(text).toContain(
      'Calls listed above were recorded before the interruption; one marked cancelled has an unknown outcome.',
    );
    // Nothing from the tool's arguments or result reaches the request.
    expect(text).not.toContain('TOOL-OK-SECRET-RESULT');
  });

  it('retains a classified provider failure after tool rounds as failed, with the error code from the closed set', async () => {
    const { session, events, requests } = rig([
      callsTurn([{ id: 'p1', name: 'read_file' }]),
      failure,
      textTurn('recovered'),
    ]);
    session.start();
    await session.sendMessage('do the thing');
    const [terminal] = terminals(events);
    expect(terminal?.stopReason).toBe('error');
    const code = terminal?.error?.code;
    expect(code).toBeDefined();
    expect(terminal?.interruption).toEqual({ reason: 'failed', code });
    expect(terminal?.toolHistory?.map((entry) => entry.result.outcome)).toEqual(['ok']);

    await session.sendMessage('next');
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('1. read_file — ok');
    expect(text).toContain(`it failed (${String(code)})`);
  });

  it('retains a fatal refusal as denied and records the refused call', async () => {
    const { session, events, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'write_file' }]), textTurn('after')],
      { behaviour: { deny: ['write_file'] } },
    );
    session.start();
    await session.sendMessage('write it');
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({
      stopReason: 'error',
      error: { code: 'tool_denied' },
      interruption: { reason: 'denied' },
    });
    expect(terminal?.toolHistory?.map((entry) => entry.result.outcome)).toEqual(['denied']);
    await session.sendMessage('what now');
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('1. write_file — denied');
    expect(text).toContain('a tool call was refused and the turn ended');
  });

  it('retains the within-turn tool-round limit as turn_limit', async () => {
    const { session, events, requests } = rig(
      [
        callsTurn([{ id: 'a', name: 'read_file' }]),
        callsTurn([{ id: 'b', name: 'read_file' }]),
        callsTurn([{ id: 'c', name: 'read_file' }]),
        textTurn('after'),
      ],
      { limits: { maxToolTurns: 1 } },
    );
    session.start();
    await session.sendMessage('loop');
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({
      error: { code: 'turn_limit' },
      interruption: { reason: 'turn_limit' },
    });
    await session.sendMessage('after the loop');
    expect(textOf(requests.at(-1)?.messages[0])).toContain('it reached the limit on tool rounds');
  });

  it('keeps today’s rollback for the exits ADR-0119 §1 excludes', async () => {
    // A session-ending cancel: no turn_completed at all and the message is rolled back.
    const entered = latch();
    const release = latch();
    const cancelled = rig([midStream(entered.open, release.promise)]);
    cancelled.session.start();
    const running = cancelled.session.sendMessage('cancelled request');
    await entered.promise;
    cancelled.session.cancel();
    release.open();
    await running;
    expect(terminals(cancelled.events)).toHaveLength(0);

    // The session's hard turn cap: refused before the message is accepted.
    const capped = rig([textTurn('only')], { maxTurns: 1 });
    capped.session.start();
    await capped.session.sendMessage('allowed');
    await capped.session.sendMessage('over the cap');
    const [, over] = terminals(capped.events);
    expect(over).toMatchObject({ error: { code: 'turn_limit' } });
    expect(over?.interruption).toBeUndefined();

    // An abort before any provider engaged.
    const early = rig([textTurn('never')]);
    early.session.start();
    const pending = early.session.sendMessage('aborted early');
    early.session.abort();
    await pending;
    const [earlyTerminal] = terminals(early.events);
    expect(earlyTerminal).toMatchObject({ stopReason: 'aborted' });
    expect(earlyTerminal?.interruption).toBeUndefined();
    await early.session.sendMessage('real');
    expect(early.requests.flatMap((r) => r.messages.map(textOf)).join('|')).not.toContain(
      'aborted early',
    );

    // An unclassified throw settles loudly, re-raises, and is not retained.
    const boom = new Error('unexpected');
    const raw = rig([textTurn('answer')], {
      deps: {
        updateCost: () => {
          throw boom;
        },
      },
    });
    raw.session.start();
    await expect(raw.session.sendMessage('go')).rejects.toBe(boom);
    expect(terminals(raw.events)[0]?.interruption).toBeUndefined();
  });

  it('rolls back a classified failure in which no provider engaged', async () => {
    const { session, events, requests } = rig([textTurn('later')], {
      deps: { resolveProvider: () => undefined },
    });
    session.start();
    await session.sendMessage('never reached a provider');
    const [terminal] = terminals(events);
    expect(terminal?.stopReason).toBe('error');
    expect(terminal?.interruption).toBeUndefined();
    expect(terminal?.toolHistory).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('leaves no trace when the completion sink refuses an interrupted turn', async () => {
    const entered = latch();
    const release = latch();
    const sinkError = new Error('sink refused the turn');
    let refuse = true;
    const { session, requests } = rig([midStream(entered.open, release.promise), textTurn('ok')], {
      deps: {
        emit: (event) => {
          if (event.type === 'session:turn_completed' && refuse) {
            refuse = false;
            throw sinkError;
          }
        },
      },
    });
    session.start();
    const running = session.sendMessage('refused turn');
    const settled = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    session.abort();
    release.open();
    expect(await settled).toBe(sinkError);
    await session.sendMessage('next');
    const text = (requests.at(-1)?.messages ?? []).map(textOf).join('|');
    expect(text).toContain('next');
    expect(text).not.toContain('refused turn');
    expect(text).not.toContain('interrupted before it was answered');
  });

  it('counts a retained turn against the hard cap exactly once', async () => {
    const entered = latch();
    const release = latch();
    const { session, events } = rig(
      [midStream(entered.open, release.promise), textTurn('second')],
      { maxTurns: 1 },
    );
    session.start();
    const running = session.sendMessage('first');
    await entered.promise;
    session.abort();
    release.open();
    await running;
    await session.sendMessage('second');
    const [first, second] = terminals(events);
    expect(first?.interruption).toEqual({ reason: 'aborted' });
    // The aborted turn engaged a provider, so it consumed the only slot — the cap refuses the next one.
    expect(second).toMatchObject({ error: { code: 'turn_limit' } });
  });
});

describe('what the model sees (ADR-0119 §4)', () => {
  const interrupted = (reason: SessionInterruption, history: readonly SessionToolHistoryEntry[]) =>
    renderInterruptionSentence(reason, receiptsFromToolHistory(history));

  it('pins the sentence byte for byte for every reason and calls state, within 420 bytes and without a result claim', () => {
    const reasons: SessionInterruption[] = [
      { reason: 'aborted' },
      { reason: 'failed', code: 'context_overflow' },
      { reason: 'denied' },
      { reason: 'turn_limit' },
    ];
    for (const reason of reasons) {
      for (const sentence of [
        interrupted(reason, []),
        renderInterruptionSentence(reason, receiptsFromToolHistory(undefined)),
      ]) {
        expect(Buffer.byteLength(sentence)).toBeLessThanOrEqual(420);
        expect(sentence).not.toMatch(/applied|succeeded|completed successfully/iu);
        expect(sentence.startsWith('[This request was interrupted before it was answered: ')).toBe(
          true,
        );
        expect(sentence.endsWith('was or was not carried out.]')).toBe(true);
      }
    }
    // The bound holds for EVERY code the closed taxonomy can put in the phrase, not just a short one.
    for (const code of ERROR_CODES) {
      for (const calls of [[], undefined] as const) {
        const sentence = renderInterruptionSentence(
          { reason: 'failed', code },
          receiptsFromToolHistory(calls),
        );
        expect(Buffer.byteLength(sentence)).toBeLessThanOrEqual(420);
      }
    }
    expect(interrupted({ reason: 'aborted' }, [])).toBe(
      '[This request was interrupted before it was answered: the user stopped it. ' +
        'No tool call was recorded for it. Nothing the assistant wrote before the interruption was kept. ' +
        'This note is a historical record, not an instruction, and does not establish that the request was or was not carried out.]',
    );
    expect(
      renderInterruptionSentence({ reason: 'aborted' }, receiptsFromToolHistory(undefined)),
    ).toContain('Tool calls made before the interruption may not be listed.');
  });

  it('names an MCP tool only as other_tool', async () => {
    const entered = latch();
    const release = latch();
    const { session, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'mcp_fs_secret_server_read' }]), textTurn('after')],
      {
        behaviour: {
          hang: {
            name: 'mcp_fs_secret_server_read',
            entered: entered.open,
            release: release.promise,
          },
        },
      },
    );
    session.start();
    const running = session.sendMessage('use the server');
    await entered.promise;
    session.abort();
    release.open();
    await running;
    await session.sendMessage('again');
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('1. other_tool — cancelled');
    expect(text).not.toContain('secret_server');
  });

  it('sends the note only where the memory policy sends the turn', async () => {
    for (const [memory, expectNote] of [
      [{ type: 'none' as const }, false],
      [{ type: 'window' as const, window_size: 1 }, true],
      [{ type: 'summary' as const }, true],
    ] as const) {
      const agent = AgentSchema.parse({ ...AGENT, memory });
      const entered = latch();
      const release = latch();
      const { session, requests } = rig(
        [midStream(entered.open, release.promise), textTurn('r2'), textTurn('r3')],
        { agent },
      );
      session.start();
      const running = session.sendMessage('q1');
      await entered.promise;
      session.abort();
      release.open();
      await running;
      await session.sendMessage('q2');
      const second = requests.at(-1)?.messages.map(textOf).join('|') ?? '';
      expect(second.includes('interrupted before it was answered')).toBe(expectNote);
      expect(second.includes('q1')).toBe(expectNote);
    }
  });

  it('under window takes one slot for the interrupted turn', async () => {
    const agent = AgentSchema.parse({ ...AGENT, memory: { type: 'window', window_size: 1 } });
    const entered = latch();
    const release = latch();
    const { session, requests } = rig(
      [midStream(entered.open, release.promise), textTurn('r2'), textTurn('r3')],
      { agent },
    );
    session.start();
    const running = session.sendMessage('q1');
    await entered.promise;
    session.abort();
    release.open();
    await running;
    await session.sendMessage('q2');
    await session.sendMessage('q3');
    const last = requests.at(-1)?.messages.map(textOf).join('|') ?? '';
    // Window of one: the interrupted turn q1 has aged out, only q2 and its answer remain beside q3.
    expect(last).not.toContain('q1');
    expect(last).toContain('q2');
    expect(last).toContain('q3');
  });
});

describe('compaction and trim keep an interrupted turn as a turn (ADR-0119 §5)', () => {
  async function mixed(extra: StreamChunk[][]): Promise<Rig> {
    const entered = latch();
    const release = latch();
    const built = rig([
      textTurn('r1'),
      midStream(entered.open, release.promise),
      textTurn('r3'),
      ...extra,
    ]);
    built.session.start();
    await built.session.sendMessage('q1');
    const running = built.session.sendMessage('q2 interrupted');
    await entered.promise;
    built.session.abort();
    release.open();
    await running;
    await built.session.sendMessage('q3');
    return built;
  }

  it('feeds the summariser the same note and keeps the surviving turn after compaction', async () => {
    const built = await mixed([textTurn('SUMMARY'), textTurn('after')]);
    const before = built.requests.length;
    expect((await built.session.compact('manual')).kind).toBe('compacted');
    const summariser = textOf(built.requests[before]?.messages[0]);
    expect(summariser).toContain('q2 interrupted');
    expect(summariser).toContain('interrupted before it was answered: the user stopped it');
    await built.session.sendMessage('q4');
    const next = textOf(built.requests.at(-1)?.messages[0]);
    expect(next).toContain('SUMMARY');
    expect(next).toContain('q3');
    expect(next).not.toContain('q2 interrupted');
  });

  it('counts the interrupted turn as one kept turn when the surviving suffix starts at it', async () => {
    const entered = latch();
    const release = latch();
    const built = rig([
      textTurn('r1'),
      textTurn('r2'),
      midStream(entered.open, release.promise),
      textTurn('SUMMARY'),
      textTurn('after'),
    ]);
    built.session.start();
    await built.session.sendMessage('q1');
    await built.session.sendMessage('q2');
    const running = built.session.sendMessage('q3 interrupted');
    await entered.promise;
    built.session.abort();
    release.open();
    await running;
    expect((await built.session.compact('manual')).kind).toBe('compacted');
    const compacted = built.events.find((event) => event.type === 'session:compacted');
    // The interrupted turn is the latest turn, so it is the one kept; q1/q2 fold into the summary.
    expect(compacted).toMatchObject({ keptTurnCount: 1 });
    await built.session.sendMessage('q4');
    const next = textOf(built.requests.at(-1)?.messages[0]);
    expect(next).toContain('q3 interrupted');
    expect(next).toContain('the user stopped it');
    expect(next).not.toContain('q1');
  });
});

describe('live and restored requests agree (ADR-0119 §3)', () => {
  const RECORD = {
    id: 'sess-i',
    agentSlug: AGENT.id,
    context: CONTEXT,
    status: 'idle' as const,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    totalConservativeMicrocents: 0,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
  };

  /** The persister's rows for a turn the event describes: user, call/result pairs, then answer or interruption. */
  function rowsFor(
    turns: readonly {
      user: string;
      final?: string;
      history: readonly SessionToolHistoryEntry[];
      interruption?: SessionInterruption | undefined;
    }[],
  ): SessionMessage[] {
    let sequenceNumber = 0;
    const row = (
      role: SessionMessage['role'],
      content: SessionMessage['content'],
      extra: Partial<SessionMessage> = {},
    ): SessionMessage => ({
      id: `m-${sequenceNumber}`,
      sessionId: 'sess-i',
      sequenceNumber: sequenceNumber++,
      role,
      content,
      timestamp: '2026-11-16T00:00:00.000Z',
      ...extra,
    });
    return turns.flatMap((turn) => [
      row('user', [{ type: 'text', text: turn.user }]),
      ...turn.history.flatMap((entry) => [
        row('assistant', [entry.call]),
        row('tool', [entry.result]),
      ]),
      turn.interruption === undefined
        ? row('assistant', [{ type: 'text', text: turn.final ?? '' }])
        : row('system', [], { interruption: turn.interruption }),
    ]);
  }

  it('produces the same request after a restart for completed, aborted, failed, denied and limited turns', async () => {
    const entered = latch();
    const release = latch();
    const live = rig(
      [
        callsTurn([{ id: 'a', name: 'read_file' }]),
        textTurn('r1'),
        midStream(entered.open, release.promise),
        callsTurn([{ id: 'b', name: 'list_directory' }]),
        failure,
        callsTurn([{ id: 'c', name: 'write_file' }]),
        textTurn('r5'),
      ],
      { behaviour: { deny: ['write_file'] } },
    );
    live.session.start();
    await live.session.sendMessage('q1 completed');
    const aborting = live.session.sendMessage('q2 aborted');
    await entered.promise;
    live.session.abort();
    release.open();
    await aborting;
    await live.session.sendMessage('q3 failed');
    await live.session.sendMessage('q4 denied');
    await live.session.sendMessage('q5 final');
    const liveRequest = live.requests.at(-1)?.messages;

    const done = terminals(live.events);
    expect(done.map((event) => event.interruption?.reason)).toEqual([
      undefined,
      'aborted',
      'failed',
      'denied',
      undefined,
    ]);
    const state = reconstructSessionState(
      RECORD,
      rowsFor([
        { user: 'q1 completed', final: 'r1', history: done[0]?.toolHistory ?? [] },
        {
          user: 'q2 aborted',
          history: done[1]?.toolHistory ?? [],
          interruption: done[1]?.interruption,
        },
        {
          user: 'q3 failed',
          history: done[2]?.toolHistory ?? [],
          interruption: done[2]?.interruption,
        },
        {
          user: 'q4 denied',
          history: done[3]?.toolHistory ?? [],
          interruption: done[3]?.interruption,
        },
      ]),
    );
    expect(state.turnCount).toBe(4);
    expect(state.completedTurnSpans.map((span) => span.interruption?.reason)).toEqual([
      undefined,
      'aborted',
      'failed',
      'denied',
    ]);

    const restored = rig([textTurn('r5')], {
      behaviour: { deny: ['write_file'] },
      build: (deps) =>
        AgentSession.resume(
          { sessionId: 'sess-i', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
          state,
        ),
    });
    await restored.session.sendMessage('q5 final');
    expect(restored.requests[0]?.messages).toEqual(liveRequest);
  });

  it('evicts the same oldest receipts live and restored when interrupted turns share the budget', async () => {
    // Nine turns of sixteen calls exceed the 128-record cap, so the oldest blocks are evicted. Every third turn
    // ends in a failure instead of an answer (turn 0 included, so the first eviction hits an interrupted turn); its
    // sentence must follow the same eviction on both sides.
    const interruptedTurn = (turn: number): boolean => turn % 3 === 0;
    const calls = (turn: number) =>
      Array.from({ length: 16 }, (_, i) => ({
        id: `p${turn}-${i}`,
        name: i % 2 === 0 ? 'read_file' : 'list_directory',
      }));
    const scripts = Array.from({ length: 9 }, (_, turn) => [
      callsTurn(calls(turn)),
      interruptedTurn(turn) ? failure : textTurn(`r${turn}`),
    ]).flat();
    const live = rig([...scripts, textTurn('last')]);
    live.session.start();
    for (let turn = 0; turn < 9; turn += 1) await live.session.sendMessage(`q${turn}`);
    await live.session.sendMessage('q-last');
    const liveRequest = live.requests.at(-1)?.messages ?? [];
    const liveText = liveRequest.map(textOf).join('\n');
    // Eviction happened, and an evicted interrupted turn no longer claims its calls are listed.
    expect(liveText).toContain('Some earlier tool activity');
    expect(liveText).toContain('Tool calls made before the interruption may not be listed.');
    expect(liveText).toContain('Calls listed above were recorded before the interruption');

    const done = terminals(live.events);
    const state = reconstructSessionState(
      RECORD,
      rowsFor(
        done.slice(0, 9).map((event, turn) => ({
          user: `q${turn}`,
          ...(interruptedTurn(turn) ? {} : { final: `r${turn}` }),
          history: event.toolHistory ?? [],
          interruption: event.interruption,
        })),
      ),
    );
    expect(state.completedTurnSpans.filter((span) => span.interruption !== undefined)).toHaveLength(
      3,
    );
    const restored = rig([textTurn('last')], {
      build: (deps) =>
        AgentSession.resume(
          { sessionId: 'sess-i', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
          state,
        ),
    });
    await restored.session.sendMessage('q-last');
    expect(restored.requests[0]?.messages).toEqual(liveRequest);
  });
});

describe('resume admission of an interrupted span (ADR-0119 §3)', () => {
  const user = (text: string): LlmMessage => ({ role: 'user', content: [{ type: 'text', text }] });
  const assistant = (text: string): LlmMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });
  const resumeWith = (messages: LlmMessage[], interruption: unknown) =>
    rig([textTurn('x')], {
      build: (deps) =>
        AgentSession.resume(
          { sessionId: 'sess-i', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
          {
            messages,
            completedTurnSpans: [
              {
                start: 0,
                end: messages.length,
                receipts: receiptsFromToolHistory([]),
                interruption: interruption as never,
              },
            ],
            turnCount: 1,
            cumulativeCostMicrocents: 0,
            conservativeCostMicrocents: 0,
          },
        ),
    });

  it('admits a one-message span and refuses anything else as invalid resume state', () => {
    expect(() => resumeWith([user('q1')], { reason: 'aborted' })).not.toThrow();
    for (const bad of [
      // An interrupted turn has no answer, so a two-message span cannot carry an interruption.
      () => resumeWith([user('q1'), assistant('a1')], { reason: 'aborted' }),
      () => resumeWith([user('q1')], { reason: 'failed' }),
      () => resumeWith([user('q1')], { reason: 'aborted', code: 'internal' }),
      () => resumeWith([user('q1')], { reason: 'exploded' }),
      () => resumeWith([user('q1')], { reason: 'aborted', extra: true }),
    ]) {
      let refusal: unknown;
      try {
        bad();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(SessionStateError);
      expect(refusal instanceof SessionStateError && refusal.code).toBe('invalid_resume_state');
    }
  });
});
