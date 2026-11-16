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

import { ToolCancelledError, ToolExecutionError, ToolPolicyError } from '../tools/errors.js';
import type { ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { DEFAULT_AGENT_TURN_LIMITS, type AgentTurnLimits } from './agent-turn.js';
import {
  AgentSession,
  SessionStateError,
  type SessionDeps,
  type SessionStreamEvent,
} from './agent-session.js';
import { BudgetPauseError } from './budget-governor.js';
import { createAbortController } from './execution-host.js';
import { reconstructSessionState } from './session-resume.js';
import {
  RECEIPT_NOTICE_INCOMPLETE,
  renderInterruptionSentence,
  receiptsFromToolHistory,
} from './turn-receipts.js';

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

type Script = StreamChunk[] | ((signal: LlmRequest['signal']) => AsyncGenerator<StreamChunk>);

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
  /** Tool names that fail with a non-recoverable execution error (neither cancelled nor denied). */
  readonly fail?: readonly string[];
  /** Tool names whose dispatch throws a RAW (unclassified) error. */
  readonly raw?: readonly string[];
  /** Tool names that run but report a tool id the session-structure schema refuses (so the call cannot be recorded). */
  readonly unrecordable?: readonly string[];
  /** Called when any non-hanging call is dispatched (a test uses it to press Esc at that moment). */
  readonly onDispatch?: () => void;
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
      behaviour.onDispatch?.();
      if (behaviour.deny?.includes(call.name) === true)
        throw new ToolPolicyError(call.name, 'not_granted', 'not granted');
      if (behaviour.fail?.includes(call.name) === true)
        throw new ToolExecutionError(call.name, 'the tool failed');
      if (behaviour.raw?.includes(call.name) === true) throw new TypeError('raw host failure');
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
          call: {
            toolId:
              behaviour.unrecordable?.includes(call.name) === true ? 'not a tool id!' : call.name,
            toolInput: {},
          },
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
    /** Wrap the provider resolver, e.g. to make one resolution throw. */
    readonly wrapResolve?: (inner: () => LlmProvider) => () => LlmProvider;
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
      return typeof script === 'function' ? script(request.signal) : streamOf(script);
    },
    contextLimit: () => 1_000_000,
    managesOwnContext: () => false,
    estimateTokens: () => 0,
  };
  const deps: SessionDeps = {
    resolveProvider: options.wrapResolve?.(() => provider) ?? (() => provider),
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
          { id: 'p1', name: 'list_directory' },
          { id: 'p2', name: 'read_file' },
          { id: 'p3', name: 'write_file' },
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
    // The first call finished (and its result carries a sentinel); the second was in flight; the third never started.
    expect(terminal?.toolHistory).toHaveLength(2);
    expect(terminal?.toolHistory?.[0]).toMatchObject({
      call: { name: 'list_directory' },
      result: { outcome: 'ok' },
    });
    expect(terminal?.toolHistory?.[1]).toMatchObject({
      call: { name: 'read_file', argsBytes: 2 },
      result: { outcome: 'cancelled', resultBytes: 0 },
    });

    await session.sendMessage('again');
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('1. list_directory — ok\n2. read_file — cancelled');
    expect(text).not.toContain('write_file');
    expect(text).toContain(
      'Calls listed above were recorded before the interruption; one marked cancelled has an unknown outcome.',
    );
    // The finished call really produced a result (so this is not a fixture that never had one), and none of it — nor
    // anything of the call's arguments — reaches the request or the event.
    expect(terminal?.toolHistory?.[0]?.result.resultBytes).toBeGreaterThan(0);
    expect(text).not.toContain('TOOL-OK-SECRET-RESULT');
    expect(JSON.stringify(terminal)).not.toContain('TOOL-OK-SECRET-RESULT');
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
    expect(terminal).toMatchObject({ stopReason: 'error', error: { code: 'tool_denied' } });
    expect(terminal?.interruption).toEqual({ reason: 'denied' });
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
    expect(terminal).toMatchObject({ error: { code: 'turn_limit' } });
    expect(terminal?.interruption).toEqual({ reason: 'turn_limit' });
    expect(terminal?.toolHistory?.length).toBeGreaterThan(0);
    await session.sendMessage('after the loop');
    expect(textOf(requests.at(-1)?.messages[0])).toContain('it reached a limit on tool use');
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

  it.each([
    ['context_overflow', 'context_overflow'],
    ['content_filter', 'content_filter'],
    ['bad_request', 'validation'],
  ] as const)(
    'rolls back a request the provider refused outright (%s) when no tool ran, so the refused message is not resent',
    async (kind, code) => {
      const refusal: StreamChunk[] = [
        {
          type: 'error',
          error: { kind, retryable: false, provider: 'anthropic', message: 'refused' },
        },
      ];
      const { session, events, requests } = rig([refusal, textTurn('answer')]);
      session.start();
      await session.sendMessage('a huge pasted file');
      const [terminal] = terminals(events);
      expect(terminal).toMatchObject({ stopReason: 'error', error: { code } });
      expect(terminal?.interruption).toBeUndefined();
      await session.sendMessage('a shorter request');
      // Only the new message is sent: the refused one is gone, exactly as it was before ADR-0119.
      expect((requests.at(-1)?.messages ?? []).map(textOf).join('|')).toBe('a shorter request');
    },
  );

  it.each([
    ['rate_limit', 'provider_rate_limit'],
    ['timeout', 'provider_unavailable'],
    ['auth', 'provider_auth'],
  ] as const)(
    'rolls back a request that ended with %s before the provider returned any content, whatever the error code',
    async (kind, code) => {
      // A deterministic refusal can arrive under ANY code (a token-per-minute 429 for a large paste, a timeout on a slow
      // prefill), so the rule is whether the provider ACCEPTED the request, not which error came back.
      const refusal: StreamChunk[] = [
        { type: 'error', error: { kind, retryable: true, provider: 'anthropic', message: 'no' } },
      ];
      const { session, events, requests } = rig([refusal, refusal, refusal, textTurn('answer')]);
      session.start();
      await session.sendMessage('a huge pasted file');
      const [terminal] = terminals(events);
      expect(terminal).toMatchObject({ stopReason: 'error', error: { code } });
      expect(terminal?.interruption).toBeUndefined();
      const before = requests.length;
      await session.sendMessage('a shorter request');
      expect(
        requests
          .slice(before)
          .flatMap((request) => request.messages.map(textOf))
          .join('|'),
      ).not.toContain('a huge pasted file');
    },
  );

  it('rolls back an Esc that arrives before the provider returned any content', async () => {
    const silent = latch();
    const early = rig([
      // The request was sent and the provider has said nothing; an abort then surfaces as the adapter's cancelled error,
      // exactly as a real fetch abort does. No content chunk ever arrives.
      async function* (signal) {
        silent.open();
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
        yield {
          type: 'error',
          error: { kind: 'cancelled', retryable: false, provider: 'anthropic', message: 'aborted' },
        } satisfies StreamChunk;
      },
      textTurn('later'),
    ]);
    early.session.start();
    const running = early.session.sendMessage('first request');
    await silent.promise;
    early.session.abort();
    await running;
    expect(terminals(early.events)[0]).toMatchObject({ stopReason: 'aborted' });
    expect(terminals(early.events)[0]?.interruption).toBeUndefined();
    await early.session.sendMessage('second request');
    expect((early.requests.at(-1)?.messages ?? []).map(textOf).join('|')).toBe('second request');
  });

  it('retains a turn whose overflow RETRY streamed content and then failed: the retry shows the provider accepted it', async () => {
    const overflow: StreamChunk[] = [
      {
        type: 'error',
        error: {
          kind: 'context_overflow',
          retryable: false,
          provider: 'anthropic',
          message: 'too long',
        },
      },
    ];
    const midFailure: StreamChunk[] = [
      { type: 'text_delta', text: 'PARTIAL' },
      {
        type: 'error',
        error: { kind: 'unknown', retryable: false, provider: 'anthropic', message: 'dropped' },
      },
    ];
    // Two completed turns give recovery something to fold; turn 3 overflows with no content, compaction runs, and the
    // retry returns content before failing.
    const { session, events } = rig([
      textTurn('r1'),
      textTurn('r2'),
      overflow,
      textTurn('SUMMARY'),
      midFailure,
      textTurn('later'),
    ]);
    session.start();
    await session.sendMessage('q1');
    await session.sendMessage('q2');
    await session.sendMessage('q3 overflows once');
    expect(events.some((event) => event.type === 'session:compacted')).toBe(true);
    const turns = terminals(events);
    expect(turns.at(-1)?.interruption).toEqual({ reason: 'failed', code: 'internal' });
  });

  it('rolls back a context overflow that arrives AFTER the first chunk when no tool ran: the message does not fit the window', async () => {
    const overflowAfterContent: StreamChunk[] = [
      { type: 'text_delta', text: 'PARTIAL' },
      {
        type: 'error',
        error: {
          kind: 'context_overflow',
          retryable: false,
          provider: 'anthropic',
          message: 'window exhausted',
        },
      },
    ];
    const { session, events, requests } = rig([overflowAfterContent, textTurn('answer')]);
    session.start();
    await session.sendMessage('a message at the edge of the window');
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({ error: { code: 'context_overflow' } });
    expect(terminal?.interruption).toBeUndefined();
    await session.sendMessage('a short follow-up');
    expect((requests.at(-1)?.messages ?? []).map(textOf).join('|')).toBe('a short follow-up');
  });

  it('counts any first chunk as the provider accepting the request, a reasoning chunk included', async () => {
    const reasoningThenFailure: StreamChunk[] = [
      { type: 'reasoning_start', id: 'r1' },
      {
        type: 'error',
        error: { kind: 'unknown', retryable: false, provider: 'anthropic', message: 'dropped' },
      },
    ];
    const { session, events } = rig([reasoningThenFailure, textTurn('later')]);
    session.start();
    await session.sendMessage('think about it');
    expect(terminals(events)[0]?.interruption).toEqual({ reason: 'failed', code: 'internal' });
  });

  it('retains the tool-calls-per-response limit as turn_limit with nothing dispatched', async () => {
    const many = Array.from({ length: 64 }, (_, index) => ({ id: `c${index}`, name: 'read_file' }));
    const { session, events } = rig([callsTurn(many), textTurn('later')]);
    session.start();
    await session.sendMessage('read everything at once');
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({ error: { code: 'turn_limit' } });
    expect(terminal?.interruption).toEqual({ reason: 'turn_limit' });
    // The ceiling is checked before the first dispatch, so no call ran and none is listed.
    expect(terminal?.toolHistory).toEqual([]);
  });

  it('rolls back a pre-egress budget refusal: no request was sent, so nothing is retained', async () => {
    const { session, events, requests } = rig([textTurn('never'), textTurn('later')], {
      deps: {
        preEgress: () => {
          throw new BudgetPauseError(900, 1000, 90);
        },
      },
    });
    session.start();
    await session.sendMessage('refused before egress');
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({ error: { code: 'budget_exceeded' } });
    expect(terminal?.interruption).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('keeps a refusal that comes after a tool round: the calls ran, so the turn is retained', async () => {
    const refusal: StreamChunk[] = [
      {
        type: 'error',
        error: {
          kind: 'content_filter',
          retryable: false,
          provider: 'anthropic',
          message: 'refused',
        },
      },
    ];
    const { session, events, requests } = rig([
      callsTurn([{ id: 'p1', name: 'read_file' }]),
      refusal,
      textTurn('after'),
    ]);
    session.start();
    await session.sendMessage('read it');
    const [terminal] = terminals(events);
    expect(terminal?.interruption).toEqual({ reason: 'failed', code: 'content_filter' });
    expect(terminal?.toolHistory?.map((entry) => entry.result.outcome)).toEqual(['ok']);
    await session.sendMessage('next');
    expect(textOf(requests.at(-1)?.messages[0])).toContain('1. read_file — ok');
  });

  it('retains a budget pause that follows a tool round as failed(budget_exceeded) with its calls listed', async () => {
    let egress = 0;
    const { session, events, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'read_file' }]), textTurn('never'), textTurn('after')],
      {
        deps: {
          preEgress: () => {
            if (++egress === 2) throw new BudgetPauseError(900, 1000, 90);
            return undefined;
          },
        },
      },
    );
    session.start();
    await session.sendMessage('read it, then keep going');
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({ error: { code: 'budget_exceeded' } });
    expect(terminal?.interruption).toEqual({ reason: 'failed', code: 'budget_exceeded' });
    expect(terminal?.toolHistory?.map((entry) => entry.result.outcome)).toEqual(['ok']);
    await session.sendMessage('next');
    expect(textOf(requests.at(-1)?.messages[0])).toContain('it failed (budget_exceeded)');
  });

  it('records a non-recoverable tool failure as an error call, not a cancelled or denied one', async () => {
    const { session, events, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'write_file' }]), textTurn('after')],
      { behaviour: { fail: ['write_file'] } },
    );
    session.start();
    await session.sendMessage('write it');
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({ error: { code: 'tool_failed' } });
    expect(terminal?.interruption).toEqual({ reason: 'failed', code: 'tool_failed' });
    expect(terminal?.toolHistory?.map((entry) => entry.result.outcome)).toEqual(['error']);
    await session.sendMessage('what now');
    expect(textOf(requests.at(-1)?.messages[0])).toContain('1. write_file — error');
  });

  it('records a raw failure inside a tool under the fixed unknown_tool label and retains it as failed(internal)', async () => {
    const { session, events, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'read_file' }]), textTurn('after')],
      { behaviour: { raw: ['read_file'] } },
    );
    session.start();
    await session.sendMessage('read it');
    const [terminal] = terminals(events);
    // The turn core classifies a raw tool throw as `internal`; the call dispatched, so it is listed — under the fixed
    // label, because a failure carries no registry-resolved name.
    expect(terminal?.interruption).toEqual({ reason: 'failed', code: 'internal' });
    expect(terminal?.toolHistory?.map((entry) => [entry.call.name, entry.result.outcome])).toEqual([
      ['unknown_tool', 'error'],
    ]);
    await session.sendMessage('next');
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('1. other_tool — error');
    expect(text).toContain('it failed (internal)');
  });

  it('rolls back an unclassified throw (not an AgentTurnError) and re-raises it', async () => {
    let resolutions = 0;
    const { session, events, requests } = rig([textTurn('answer')], {
      wrapResolve: (inner) => () => {
        if (++resolutions === 1) throw new TypeError('raw provider-resolution fault');
        return inner();
      },
    });
    session.start();
    await expect(session.sendMessage('first request')).rejects.toThrow(
      'raw provider-resolution fault',
    );
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({ stopReason: 'error', error: { code: 'internal' } });
    expect(terminal?.interruption).toBeUndefined();
    await session.sendMessage('second request');
    // The message was rolled back, not retained: a later request carries only the new one.
    expect((requests.at(-1)?.messages ?? []).map(textOf).join('|')).toBe('second request');
  });

  it('records a tool call BEFORE its events, so a throwing event sink cannot drop an executed call from a retained turn', async () => {
    let throwOnce = true;
    const { session, events, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'read_file' }]), textTurn('after')],
      {
        deps: {
          emit: (event) => {
            sink.push(event);
            if (event.type === 'agent:tool_call' && throwOnce) {
              throwOnce = false;
              throw new Error('host sink refused the tool event');
            }
          },
        },
      },
    );
    const sink: SessionStreamEvent[] = events;
    session.start();
    await session.sendMessage('read it').catch(() => undefined);
    const [terminal] = terminals(sink);
    // The call ran, so the history lists it even though the sink threw right after the dispatch.
    expect(terminal?.toolHistory?.map((entry) => [entry.call.name, entry.result.outcome])).toEqual([
      ['read_file', 'ok'],
    ]);
    await session.sendMessage('next');
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('1. read_file — ok');
    expect(text).not.toContain('No tool call was recorded for it.');
  });

  it('does not retain a turn in which an executed call could not be recorded', async () => {
    const { session, events, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'read_file' }]), textTurn('after')],
      { behaviour: { unrecordable: ['read_file'] } },
    );
    session.start();
    await session.sendMessage('read it').catch(() => undefined);
    const [terminal] = terminals(events);
    expect(terminal).toMatchObject({ stopReason: 'error', error: { code: 'internal' } });
    // The list would have said "no tool call was recorded" about a turn in which one ran, so nothing is kept.
    expect(terminal?.interruption).toBeUndefined();
    await session.sendMessage('next');
    const text = (requests.at(-1)?.messages ?? []).map(textOf).join('|');
    expect(text).not.toContain('read it');
    expect(text).not.toContain('interrupted before it was answered');
  });

  it('does not retain an abort that landed while an executed call could not be recorded', async () => {
    const ref: { session?: AgentSession } = {};
    const { session, events, requests } = rig(
      [callsTurn([{ id: 'p1', name: 'read_file' }]), textTurn('after')],
      {
        behaviour: { unrecordable: ['read_file'], onDispatch: () => ref.session?.abort() },
      },
    );
    ref.session = session;
    session.start();
    await session.sendMessage('read it').catch(() => undefined);
    const [terminal] = terminals(events);
    expect(terminal?.stopReason).toBe('aborted');
    expect(terminal?.interruption).toBeUndefined();
    await session.sendMessage('next');
    expect((requests.at(-1)?.messages ?? []).map(textOf).join('|')).not.toContain('read it');
  });

  it('does not retain an abort that coincided with a host callback fault', async () => {
    const ref: { session?: AgentSession } = {};
    const seen: SessionStreamEvent[] = [];
    let armed = true;
    const { session, requests } = rig([textTurn('PARTIAL'), textTurn('later')], {
      deps: {
        emit: (event) => {
          seen.push(event);
          if (event.type === 'agent:token' && armed) {
            armed = false;
            ref.session?.abort();
            throw new Error('sink fault while stopping');
          }
        },
      },
    });
    ref.session = session;
    session.start();
    await session.sendMessage('first request').catch(() => undefined);
    const [terminal] = terminals(seen);
    expect(terminal?.stopReason).toBe('aborted');
    expect(terminal?.interruption).toBeUndefined();
    await session.sendMessage('second request');
    const text = (requests.at(-1)?.messages ?? []).map(textOf).join('|');
    expect(text).not.toContain('first request');
  });

  it('keeps a retained turn through trim(3) with its note, and drops it with trim(2)', async () => {
    const run = async (limit: number) => {
      const entered = latch();
      const release = latch();
      const built = rig([
        textTurn('r1'),
        midStream(entered.open, release.promise),
        textTurn('r3'),
        textTurn('after'),
      ]);
      built.session.start();
      await built.session.sendMessage('q1');
      const running = built.session.sendMessage('q2 interrupted');
      await entered.promise;
      built.session.abort();
      release.open();
      await running;
      await built.session.sendMessage('q3');
      const result = built.session.trimHistory(limit);
      await built.session.sendMessage('q4');
      return { result, built, text: textOf(built.requests.at(-1)?.messages[0]) };
    };
    const kept = await run(3);
    expect(kept.result).toMatchObject({ kind: 'trimmed' });
    expect(kept.built.events.find((event) => event.type === 'session:trimmed')).toMatchObject({
      keptTurnCount: 2,
    });
    expect(kept.text).toContain('q2 interrupted');
    expect(kept.text).toContain('the user stopped it');
    expect(kept.text).not.toContain('q1');
    const dropped = await run(2);
    expect(dropped.text).not.toContain('q2 interrupted');
    expect(dropped.text).not.toContain('interrupted before it was answered');
  });

  it('keeps a retained turn out of reach of a sink that mutates the event it was handed', async () => {
    const entered = latch();
    const release = latch();
    const { session, requests } = rig([midStream(entered.open, release.promise), textTurn('ok')], {
      deps: {
        emit: (event) => {
          if (event.type === 'session:turn_completed' && event.interruption !== undefined)
            Object.assign(event.interruption, { reason: 'denied' });
        },
      },
    });
    session.start();
    const running = session.sendMessage('first request');
    await entered.promise;
    session.abort();
    release.open();
    await running;
    await session.sendMessage('second request');
    // The span holds its own frozen copy: the mutated event cannot change what the model is told.
    const text = textOf(requests.at(-1)?.messages[0]);
    expect(text).toContain('the user stopped it');
    expect(text).not.toContain('a tool call was refused');
  });

  it('under window 1 keeps the newest interrupted turn in place of an older completed one', async () => {
    const agent = AgentSchema.parse({ ...AGENT, memory: { type: 'window', window_size: 1 } });
    const entered = latch();
    const release = latch();
    const { session, requests } = rig(
      [textTurn('r1'), midStream(entered.open, release.promise), textTurn('r3')],
      { agent },
    );
    session.start();
    await session.sendMessage('q1 completed');
    const running = session.sendMessage('q2 interrupted');
    await entered.promise;
    session.abort();
    release.open();
    await running;
    await session.sendMessage('q3');
    const text = (requests.at(-1)?.messages ?? []).map(textOf).join('|');
    // One slot: the interrupted turn takes it; the older completed turn is out. (Zero slots would show q1 instead.)
    expect(text).toContain('q2 interrupted');
    expect(text).toContain('the user stopped it');
    expect(text).not.toContain('q1 completed');
  });

  it('retains two consecutive interrupted turns and folds all three user messages into one', async () => {
    const first = { entered: latch(), release: latch() };
    const second = { entered: latch(), release: latch() };
    const { session, requests } = rig([
      midStream(first.entered.open, first.release.promise),
      midStream(second.entered.open, second.release.promise),
      textTurn('answer'),
    ]);
    session.start();
    for (const turn of [first, second]) {
      const running = session.sendMessage(turn === first ? 'q1 stopped' : 'q2 stopped');
      await turn.entered.promise;
      session.abort();
      turn.release.open();
      await running;
    }
    await session.sendMessage('q3 real');
    const last = requests.at(-1)?.messages ?? [];
    expect(last.map((message) => message.role)).toEqual(['user']);
    const text = textOf(last[0]);
    expect(text.indexOf('q1 stopped')).toBeLessThan(text.indexOf('q2 stopped'));
    expect(text.indexOf('q2 stopped')).toBeLessThan(text.indexOf('q3 real'));
    expect(text.match(/interrupted before it was answered/gu)).toHaveLength(2);
  });

  it('survives an abort requested from inside the completion sink of an interrupted turn', async () => {
    const ref: { session?: AgentSession } = {};
    const entered = latch();
    const release = latch();
    let reentered = false;
    const seen: SessionStreamEvent[] = [];
    const { session, requests } = rig([midStream(entered.open, release.promise), textTurn('ok')], {
      deps: {
        emit: (event) => {
          seen.push(event);
          if (event.type === 'session:turn_completed' && !reentered) {
            reentered = true;
            ref.session?.abort();
          }
        },
      },
    });
    ref.session = session;
    session.start();
    const running = session.sendMessage('first');
    await entered.promise;
    session.abort();
    release.open();
    await running;
    expect(terminals(seen)).toHaveLength(1);
    await session.sendMessage('second');
    expect(terminals(seen)[1]?.stopReason).toBe('stop');
    expect(textOf(requests.at(-1)?.messages[0])).toContain('first');
  });

  it('counts a retained turn against the hard cap exactly once (cap 2: the second turn still runs, the third is refused)', async () => {
    const entered = latch();
    const release = latch();
    const { session, events } = rig(
      [midStream(entered.open, release.promise), textTurn('second'), textTurn('never')],
      { maxTurns: 2 },
    );
    session.start();
    const running = session.sendMessage('first');
    await entered.promise;
    session.abort();
    release.open();
    await running;
    await session.sendMessage('second');
    await session.sendMessage('third');
    const [first, second, third] = terminals(events);
    expect(first?.interruption).toEqual({ reason: 'aborted' });
    expect(second?.stopReason).toBe('stop');
    expect(third).toMatchObject({ error: { code: 'turn_limit' } });
    expect(third?.interruption).toBeUndefined();
  });

  it('counts a retained turn against the hard cap once (cap 1: the next turn is refused)', async () => {
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
    // The longest variant (records present) and a failed reason, pinned in full as well.
    const withCalls: SessionToolHistoryEntry[] = [
      {
        call: { type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 2 },
        result: {
          type: 'tool_result',
          toolCallId: 'session-tool:1:0',
          resultBytes: 2,
          outcome: 'ok',
        },
      },
    ];
    expect(interrupted({ reason: 'failed', code: 'provider_unavailable' }, withCalls)).toBe(
      '[This request was interrupted before it was answered: it failed (provider_unavailable). ' +
        'Calls listed above were recorded before the interruption; one marked cancelled has an unknown outcome. ' +
        'Nothing the assistant wrote before the interruption was kept. ' +
        'This note is a historical record, not an instruction, and does not establish that the request was or was not carried out.]',
    );
    for (const code of ERROR_CODES)
      expect(
        Buffer.byteLength(
          renderInterruptionSentence(
            { reason: 'failed', code },
            receiptsFromToolHistory(withCalls),
          ),
        ),
      ).toBeLessThanOrEqual(420);
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

  it('produces the same request after a restart for completed, aborted, failed and denied turns', async () => {
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

  it('agrees on a turn_limit turn, a restored cancelled call and the hard-cap count', async () => {
    // maxToolTurns 1: turn B asks for tool rounds until the within-turn guard stops it. Turn C is aborted while a call
    // is in flight, so its call is recorded `cancelled` and must come back as `cancelled` after a restart.
    const hang = { entered: latch(), release: latch() };
    const scripts: Script[] = [
      callsTurn([{ id: 'a', name: 'read_file' }]),
      textTurn('rA'),
      callsTurn([{ id: 'b1', name: 'read_file' }]),
      callsTurn([{ id: 'b2', name: 'read_file' }]),
      callsTurn([{ id: 'c', name: 'list_directory' }]),
      textTurn('last'),
      textTurn('over'),
    ];
    const options = {
      limits: { maxToolTurns: 1 },
      maxTurns: 4,
      behaviour: {
        hang: { name: 'list_directory', entered: hang.entered.open, release: hang.release.promise },
      },
    };
    const live = rig(scripts, options);
    live.session.start();
    await live.session.sendMessage('qA');
    await live.session.sendMessage('qB');
    const running = live.session.sendMessage('qC');
    await hang.entered.promise;
    live.session.abort();
    hang.release.open();
    await running;
    const done = terminals(live.events);
    expect(done.map((event) => event.interruption?.reason)).toEqual([
      undefined,
      'turn_limit',
      'aborted',
    ]);
    expect(done[2]?.toolHistory?.map((entry) => entry.result.outcome)).toEqual(['cancelled']);
    await live.session.sendMessage('q-last');
    await live.session.sendMessage('q-over');
    // `q-over` is refused by the cap before any egress, so the last request is the one `q-last` made.
    const liveRequest = live.requests.at(-1)?.messages;
    // Four turns engaged a provider, so the cap of four refuses the fifth.
    expect(terminals(live.events).at(-1)).toMatchObject({ error: { code: 'turn_limit' } });

    const state = reconstructSessionState(
      RECORD,
      rowsFor([
        { user: 'qA', final: 'rA', history: done[0]?.toolHistory ?? [] },
        { user: 'qB', history: done[1]?.toolHistory ?? [], interruption: done[1]?.interruption },
        { user: 'qC', history: done[2]?.toolHistory ?? [], interruption: done[2]?.interruption },
      ]),
    );
    // The restored count equals the live count of the same turns (all three engaged a provider).
    expect(state.turnCount).toBe(3);
    expect(state.completedTurnSpans.map((span) => span.interruption?.reason)).toEqual([
      undefined,
      'turn_limit',
      'aborted',
    ]);
    const restored = rig([textTurn('last'), textTurn('over')], {
      ...options,
      behaviour: {},
      build: (deps) =>
        AgentSession.resume(
          { sessionId: 'sess-i', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
          state,
        ),
    });
    await restored.session.sendMessage('q-last');
    expect(restored.requests[0]?.messages).toEqual(liveRequest);
    expect((restored.requests[0]?.messages ?? []).map(textOf).join('\n')).toContain(
      '1. list_directory — cancelled',
    );
    await restored.session.sendMessage('q-over');
    // Same cap, same count: the fifth turn is refused on both sides.
    expect(terminals(restored.events).at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
  });

  it('shows a forged or degraded interrupted turn as "may not be listed", never as a clean record', async () => {
    // A tool result with no matching call: derivation degrades the turn to incomplete instead of failing the resume.
    const state = reconstructSessionState(RECORD, [
      ...rowsFor([{ user: 'qX', history: [], interruption: { reason: 'aborted' } }]).slice(0, 1),
      {
        id: 'orphan-result',
        sessionId: 'sess-i',
        sequenceNumber: 1,
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'session-tool:1:0',
            resultBytes: 3,
            outcome: 'ok',
          },
        ],
        timestamp: '2026-11-16T00:00:00.000Z',
      },
      {
        id: 'i',
        sessionId: 'sess-i',
        sequenceNumber: 2,
        role: 'system',
        content: [],
        interruption: { reason: 'aborted' },
        timestamp: '2026-11-16T00:00:00.000Z',
      },
    ]);
    expect(state.completedTurnSpans[0]?.receipts.incomplete).toBe(true);
    const restored = rig([textTurn('ok')], {
      build: (deps) =>
        AgentSession.resume(
          { sessionId: 'sess-i', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
          state,
        ),
    });
    await restored.session.sendMessage('next');
    const text = textOf(restored.requests[0]?.messages[0]);
    expect(text).toContain('Tool calls made before the interruption may not be listed.');
    expect(text).not.toContain('No tool call was recorded for it.');
    // ADR-0128's single request notice applies to a degraded interrupted turn, exactly once.
    expect(text).toContain(RECEIPT_NOTICE_INCOMPLETE);
    expect(text.split(RECEIPT_NOTICE_INCOMPLETE)).toHaveLength(2);
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
