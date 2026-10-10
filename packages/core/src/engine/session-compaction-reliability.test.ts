import { describe, expect, it } from 'vitest';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import {
  estimateRequestTokens,
  FallbackChain,
  LlmProviderError,
  makeLlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type StreamChunk,
} from '@relavium/llm';
import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';
import { BudgetPauseError } from './budget-governor.js';
import { captureAgentTurnOutcome, DEFAULT_AGENT_TURN_LIMITS } from './agent-turn.js';

const text = (value: string): LlmMessage => ({
  role: 'user',
  content: [{ type: 'text', text: value }],
});
const body = (request: LlmRequest) =>
  request.messages
    .flatMap((m) => m.content)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('');
function fixture(
  options: {
    history?: readonly LlmMessage[];
    window?: number;
    custom?: boolean;
    threshold?: number;
    afterTurn?: boolean;
    auto?: boolean;
    maxTurns?: number;
    refusePass?: number;
    overflow?: boolean | number;
    provider?: Partial<LlmProvider>;
    fallbackProvider?: Partial<LlmProvider>;
    mainInputTokens?: number;
    onRequest?: (request: LlmRequest) => void | Promise<void>;
    memory?: { type: 'none' | 'summary' } | { type: 'window'; window_size: number };
    mainText?: string;
    emptyPass?: number;
    summaryText?: string;
    deps?: Partial<SessionDeps>;
  } = {},
) {
  const history = options.history ?? [text('old '.repeat(9000)), text('middle'), text('latest')];
  const events: SessionStreamEvent[] = [],
    requests: LlmRequest[] = [];
  let summaryCalls = 0,
    mainCalls = 0,
    passes = 0,
    key = 0;
  const provider: LlmProvider = {
    id: 'openai',
    ...(options.custom === undefined ? {} : { customEndpoint: options.custom }),
    supports: {
      tools: false,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    },
    contextLimit: () => options.window,
    generate: () => Promise.reject(new Error('unused generate')),
    stream: async function* (request): AsyncGenerator<StreamChunk> {
      await options.onRequest?.(request);
      requests.push(request);
      const summary = request.maxTokens === 4096;
      if (summary) summaryCalls++;
      else mainCalls++;
      if (
        !summary &&
        (options.overflow === true ||
          (typeof options.overflow === 'number' && mainCalls <= options.overflow))
      ) {
        yield {
          type: 'error',
          error: {
            ...makeLlmError({
              provider: 'openai',
              kind: 'context_overflow',
              message: 'synthetic overflow',
              status: 400,
            }),
            usage: { inputTokens: 2, outputTokens: 1 },
          },
        };
        return;
      }
      const value = summary
        ? options.emptyPass === summaryCalls
          ? ''
          : (options.summaryText ?? 'SUMMARY')
        : (options.mainText ?? 'reply');
      if (value.length > 0) yield { type: 'text_delta', text: value };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: {
          inputTokens: summary ? 7 : (options.mainInputTokens ?? 11),
          outputTokens: summary ? 3 : 5,
        },
      };
    },
    ...options.provider,
  };
  const fallback = { ...provider, id: 'anthropic' as const, ...options.fallbackProvider };
  const deps: SessionDeps = {
    resolveProvider: (id) => (id === 'anthropic' ? fallback : provider),
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unused tool')),
    },
    tools: [],
    keyFor: () => 'offline-placeholder',
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    reserveEffectTurnKey: () => ++key,
    emit: (e) => {
      events.push(e);
    },
    autoCompact: options.auto ?? true,
    afterTurnCompaction: options.afterTurn ?? false,
    ...(options.threshold === undefined ? {} : { compactThreshold: options.threshold }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    preEgress: (info) => {
      if (info.route === 'text' && info.maxTokens === 4096 && ++passes === options.refusePass)
        throw new BudgetPauseError(1, 2, 3);
    },
    ...options.deps,
  };
  const session = AgentSession.resume(
    {
      sessionId: 'compaction-reliability',
      agentRef: 'a',
      agent: AgentSchema.parse({
        id: 'a',
        provider: 'openai',
        model: 'compaction-fixture',
        system_prompt: 'authored',
        max_tokens: 64,
        ...(options.fallbackProvider === undefined
          ? {}
          : {
              fallback_chain: [
                { provider: 'anthropic', model: 'fallback-fixture', max_attempts: 1 },
              ],
            }),
        ...(options.memory === undefined ? {} : { memory: options.memory }),
      }),
      context: SessionContextSchema.parse({ workingDir: '/workspace', fsScopeTier: 'sandboxed' }),
      deps,
    },
    {
      messages: history,
      completedTurnSpans: history.map((_, i) => ({ start: i, end: i + 1 })),
      turnCount: history.length,
      cumulativeCostMicrocents: 0,
      conservativeCostMicrocents: 0,
    },
  );
  return {
    session,
    events,
    requests,
    provider,
    deps,
    counts: () => ({ summaryCalls, mainCalls, passes }),
  };
}

describe('W7 measured atomic compaction and active-entry budget outcomes', () => {
  it('measures and compacts before the main request, keeping latest completed and pending users distinct', async () => {
    const h = fixture({ window: 12000, threshold: 0.7 });
    await h.session.sendMessage('pending');
    expect(h.counts()).toMatchObject({ summaryCalls: 2, mainCalls: 1 });
    const event = h.events.find((e) => e.type === 'session:compacted');
    expect(event).toMatchObject({
      reason: 'pre-send',
      keptMessageCount: 2,
      keptTurnCount: 1,
      tokensUsed: { input: 14, output: 6 },
    });
    const main = h.requests.at(-1);
    expect(main?.maxTokens).toBe(64);
    if (main === undefined) throw new Error('missing main');
    expect(body(main)).toContain('latest');
    expect(body(main)).toContain('pending');
    expect(body(main)).not.toContain('old old');
    for (const request of h.requests.filter((r) => r.maxTokens === 4096))
      expect(
        estimateRequestTokens({ system: request.system ?? '', messages: request.messages }) + 4096,
      ).toBeLessThanOrEqual(12000);
  });
  for (const entry of ['manual', 'after-turn', 'pre-send', 'recovery'] as const)
    for (const pass of [1, 2])
      it(`${entry} pass ${pass} budget refusal preserves the right lifecycle and never trims`, async () => {
        const after = entry === 'after-turn';
        const h = fixture({
          history: after
            ? [text('x'.repeat(17600)), text('y'.repeat(17600))]
            : [
                text('x'.repeat(12000)),
                text('y'.repeat(12000)),
                text('z'.repeat(12000)),
                text('latest'),
              ],
          window: 12000,
          refusePass: pass,
          threshold: entry === 'pre-send' ? 0.7 : after ? 0.8 : 1,
          afterTurn: after,
          mainText: after ? 'a'.repeat(4000) : 'reply',
          overflow: entry === 'recovery',
          deps: { maxMessages: 1 },
        });
        let result: Awaited<ReturnType<AgentSession['compact']>> | undefined;
        if (entry === 'manual') result = await h.session.compact();
        else await h.session.sendMessage('pending');
        if (entry === 'manual') expect(result).toMatchObject({ kind: 'budget_refused' });
        const terminals = h.events.filter((e) => e.type === 'session:turn_completed');
        expect(terminals).toHaveLength(entry === 'manual' ? 0 : 1);
        if (after) expect(terminals[0]).toMatchObject({ stopReason: 'stop' });
        else if (entry !== 'manual')
          expect(terminals[0]).toMatchObject({ error: { code: 'budget_exceeded' } });
        expect(
          h.events.some((e) => e.type === 'session:trimmed' || e.type === 'session:compacted'),
        ).toBe(false);
        expect(h.events.filter((e) => e.type === 'session:compacting')).toHaveLength(
          pass === 1 ? 0 : 1,
        );
        expect(h.events.filter((e) => e.type === 'session:compaction_failed')).toHaveLength(
          pass === 1 ? 0 : 1,
        );
        expect(h.events.filter((e) => e.type === 'session:compaction_budget_refused')).toHaveLength(
          after && pass === 1 ? 1 : 0,
        );
        expect(h.counts().mainCalls).toBe(after || entry === 'recovery' ? 1 : 0);
      });
  it('refuses a fifth fold atomically after four billed passes', async () => {
    const h = fixture({
      history: [
        ...Array.from({ length: 5 }, (_, i) => text(String(i).repeat(2000))),
        text('latest'),
      ],
      window: 4800,
      auto: false,
    });
    expect(await h.session.compact()).toMatchObject({ kind: 'failed' });
    expect(h.counts().summaryCalls).toBe(4);
    expect(h.events.some((e) => e.type === 'session:compacted')).toBe(false);
    expect(h.events.filter((e) => e.type === 'session:compacting')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'session:compaction_failed')).toHaveLength(1);
    await h.session.sendMessage('next');
    const request = h.requests.at(-1);
    if (request === undefined) throw new Error('missing main');
    expect(body(request)).toContain('0'.repeat(100));
    expect(body(request)).toContain('4'.repeat(100));
  });
  it('installs exactly once after four successful passes', async () => {
    const h = fixture({
      history: [
        ...Array.from({ length: 4 }, (_, i) => text(String(i).repeat(2000))),
        text('latest'),
      ],
      window: 4800,
      auto: false,
    });
    expect(await h.session.compact()).toMatchObject({ kind: 'compacted' });
    expect(h.counts().summaryCalls).toBe(4);
    expect(h.events.filter((e) => e.type === 'session:compacted')).toHaveLength(1);
    expect(h.events.find((e) => e.type === 'session:compacted')).toMatchObject({
      tokensUsed: { input: 28, output: 12 },
    });
  });
  it('discloses an unknown manual window before provider invocation and enforces the soft input bound', async () => {
    let disclosed = false;
    const h = fixture({
      history: [text('x'.repeat(90000)), text('latest')],
      custom: true,
      window: 100000,
      auto: false,
      onRequest: () => {
        expect(disclosed).toBe(true);
      },
      deps: {
        emit: (e) => {
          if (e.type === 'session:compacting' && e.windowUnknown) disclosed = true;
        },
      },
    });
    expect(await h.session.compact()).toMatchObject({ kind: 'compacted' });
    expect(disclosed).toBe(true);
    const request = h.requests[0];
    if (request === undefined) throw new Error('missing summary');
    expect(
      estimateRequestTokens({ system: request.system ?? '', messages: request.messages }),
    ).toBeLessThanOrEqual(16384);
    expect(body(request)).toMatch(/\[engine: omitted \d+ character\(s\) from this message\]/);
  });
});

describe('W7 compaction authority, policy and atomic recovery controls', () => {
  const small = [text('old'), text('middle'), text('latest')];
  for (const overflow of [1, 2])
    it(`retries genuine overflow only once and accounts both main attempts: failures=${overflow}`, async () => {
      const h = fixture({ history: small, window: 10000, overflow });
      await h.session.sendMessage('pending-unique');
      expect(h.counts()).toMatchObject({ summaryCalls: 1, mainCalls: 2 });
      expect(h.events.filter((e) => e.type === 'session:compacted')).toHaveLength(1);
      const terminal = h.events.find((e) => e.type === 'session:turn_completed');
      expect(terminal).toMatchObject({
        tokensUsed: overflow === 1 ? { input: 13, output: 6 } : { input: 4, output: 2 },
      });
      if (overflow === 2) {
        expect(terminal).toMatchObject({ error: { code: 'context_overflow' } });
        await h.session.sendMessage('next-unique');
        const request = h.requests.at(-1);
        if (request === undefined) throw new Error('missing request');
        expect(body(request)).not.toContain('pending-unique');
        expect(body(request)).toContain('latest');
        expect(body(request)).toContain('next-unique');
      } else expect(terminal).toMatchObject({ stopReason: 'stop' });
    });
  for (const provider of [
    { contextLimit: () => undefined },
    { contextLimit: () => Number.NaN },
    {
      contextLimit: () => {
        throw new Error('offline metadata');
      },
    },
    { customEndpoint: true, contextLimit: () => 10000 },
    { managesOwnContext: () => true, contextLimit: () => 10000 },
  ])
    it('refuses automatic overflow recovery without authoritative applicable window/ownership', async () => {
      const h = fixture({ history: small, overflow: true, provider });
      await h.session.sendMessage('pending');
      expect(h.counts()).toMatchObject({ summaryCalls: 0, mainCalls: 1 });
      expect(h.events.some((e) => e.type === 'session:compacting')).toBe(false);
      expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
        error: { code: provider.customEndpoint === true ? 'validation' : 'context_overflow' },
      });
    });
  for (const memory of [{ type: 'none' }, { type: 'window', window_size: 2 }] as const)
    it(`does not summarise under ${memory.type} memory at manual or active entry`, async () => {
      const h = fixture({ window: 10000, overflow: true, memory });
      expect(await h.session.compact()).toMatchObject({ kind: 'policy_refused' });
      await h.session.sendMessage('pending');
      expect(h.counts().summaryCalls).toBe(0);
    });
  it('after-turn disable preserves explicit summary and pre-send permission', async () => {
    const h = fixture({ window: 12000, memory: { type: 'summary' }, afterTurn: false });
    expect(await h.session.compact()).toMatchObject({ kind: 'compacted' });
    await h.session.sendMessage('pending');
    expect(h.events.find((e) => e.type === 'session:compacted')).toMatchObject({
      reason: 'manual',
    });
    expect(
      h.events.some((e) => e.type === 'session:compacting' && e.reason === 'auto-threshold'),
    ).toBe(false);
  });
  for (const enabled of [false, true])
    it(`after-turn disable preserves a real next-request threshold, enabled=${enabled}`, async () => {
      const h = fixture({
        history: [text('x'.repeat(17600)), text('y'.repeat(17600))],
        window: 12000,
        threshold: 0.8,
        memory: { type: 'summary' },
        afterTurn: enabled,
        mainText: 'a'.repeat(4000),
      });
      await h.session.sendMessage('pending');
      expect(h.requests[0]?.maxTokens).toBe(64);
      expect(h.counts()).toMatchObject({ mainCalls: 1, summaryCalls: enabled ? 2 : 0 });
      expect(h.events.some((e) => e.type === 'session:compacting' && e.reason === 'pre-send')).toBe(
        false,
      );
      expect(
        h.events.some((e) => e.type === 'session:compacted' && e.reason === 'auto-threshold'),
      ).toBe(enabled);
    });
  for (const pass of [1, 2])
    it(`empty summary pass ${pass} leaves old history installed and closes exactly one moment`, async () => {
      const h = fixture({
        history: [text('x'.repeat(12000)), text('y'.repeat(12000)), text('latest')],
        window: 10000,
        auto: false,
        emptyPass: pass,
      });
      expect(await h.session.compact()).toMatchObject({ kind: 'failed' });
      expect(h.events.filter((e) => e.type === 'session:compacting')).toHaveLength(1);
      expect(h.events.filter((e) => e.type === 'session:compaction_failed')).toHaveLength(1);
      expect(h.events.some((e) => e.type === 'session:compacted')).toBe(false);
      await h.session.sendMessage('next');
      const request = h.requests.at(-1);
      if (request === undefined) throw new Error('missing request');
      expect(body(request)).toContain('x'.repeat(100));
      expect(body(request)).toContain('y'.repeat(100));
    });
  it('ordinary pre-send failure sends original context and suppresses a second recovery cycle', async () => {
    const h = fixture({ window: 12000, threshold: 0.7, emptyPass: 1, overflow: true });
    await h.session.sendMessage('pending');
    expect(h.counts()).toMatchObject({ summaryCalls: 1, mainCalls: 1 });
    const main = h.requests.at(-1);
    if (main === undefined) throw new Error('missing main');
    expect(body(main)).toContain('old old');
    expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
      error: { code: 'context_overflow' },
    });
  });
});

describe('W7 atomic compaction cancellation at every entry', () => {
  for (const entry of ['manual', 'after-turn', 'pre-send', 'recovery'] as const)
    for (const pass of [1, 2])
      for (const terminal of [false, true])
        it(`${entry} pass ${pass} ${terminal ? 'cancel' : 'Esc'} never installs partial context`, async () => {
          let reached: () => void = () => undefined,
            release: () => void = () => undefined;
          const entered = new Promise<void>((resolve) => {
            reached = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          let summaries = 0;
          const after = entry === 'after-turn';
          const h = fixture({
            history: after
              ? [text('x'.repeat(17600)), text('y'.repeat(17600))]
              : [
                  text('x'.repeat(12000)),
                  text('y'.repeat(12000)),
                  text('z'.repeat(12000)),
                  text('latest'),
                ],
            window: 12000,
            threshold: entry === 'pre-send' ? 0.7 : after ? 0.8 : 1,
            afterTurn: after,
            mainText: after ? 'a'.repeat(4000) : 'reply',
            overflow: entry === 'recovery',
            onRequest: async (request) => {
              if (request.maxTokens === 4096 && ++summaries === pass) {
                reached();
                await held;
              }
            },
          });
          const running =
            entry === 'manual' ? h.session.compact() : h.session.sendMessage('pending-unique');
          try {
            await entered;
            if (terminal) h.session.cancel();
            else h.session.abort();
          } finally {
            release();
          }
          await running;
          expect(h.events.some((e) => e.type === 'session:compacted')).toBe(false);
          expect(h.events.filter((e) => e.type === 'session:compacting')).toHaveLength(1);
          expect(h.events.filter((e) => e.type === 'session:compaction_failed')).toHaveLength(
            terminal ? 0 : 1,
          );
          expect(h.events.filter((e) => e.type === 'session:cancelled')).toHaveLength(
            terminal ? 1 : 0,
          );
          const completed = h.events.filter((e) => e.type === 'session:turn_completed');
          expect(completed).toHaveLength(after || (!terminal && entry !== 'manual') ? 1 : 0);
          if (!terminal && !after && entry !== 'manual')
            expect(completed[0]).toMatchObject({ stopReason: 'aborted' });
          if (after) expect(completed[0]).toMatchObject({ stopReason: 'stop' });
          if (!terminal) {
            await h.session.sendMessage('next-unique');
            const nextRequests = h.requests.filter((r) => body(r).includes('next-unique'));
            expect(nextRequests.length).toBeGreaterThan(0);
            if (!after && entry !== 'manual')
              for (const request of nextRequests)
                expect(body(request)).not.toContain('pending-unique');
          }
        });
});

it('never spends recovery after pre-send is skipped for an irreducible oversized kept exchange', async () => {
  const h = fixture({
    history: [text('foldable'.repeat(5000)), text('kept'.repeat(15000))],
    window: 12000,
    overflow: true,
  });
  await h.session.sendMessage('pending');
  expect(h.counts()).toMatchObject({ summaryCalls: 0, mainCalls: 1 });
  expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
    error: { code: 'context_overflow' },
  });
});

describe('W7 every-candidate window and measured next-construction controls', () => {
  it('bounds every summariser request by a smaller fallback window even when the primary succeeds', async () => {
    const h = fixture({
      history: [text('x'.repeat(10000)), text('y'.repeat(10000)), text('latest')],
      window: 12000,
      fallbackProvider: { contextLimit: () => 6000 },
      auto: false,
    });
    expect(await h.session.compact()).toMatchObject({ kind: 'compacted' });
    expect(h.counts().summaryCalls).toBe(2);
    for (const request of h.requests)
      expect(
        estimateRequestTokens({ system: request.system ?? '', messages: request.messages }) + 4096,
      ).toBeLessThanOrEqual(6000);
  });
  it('mixed manual unknown fallback never relaxes a known primary bound', async () => {
    let acknowledged = false;
    const h = fixture({
      history: [text('x'.repeat(100000)), text('latest')],
      window: 10000,
      auto: false,
      fallbackProvider: { customEndpoint: true, contextLimit: () => 100000 },
      onRequest: () => {
        expect(acknowledged).toBe(true);
      },
      deps: {
        onCompactionStart: (info) => {
          expect(info.windowUnknown).toBe(true);
          acknowledged = true;
        },
      },
    });
    expect(await h.session.compact()).toMatchObject({ kind: 'compacted' });
    for (const request of h.requests) {
      const input = estimateRequestTokens({
        system: request.system ?? '',
        messages: request.messages,
      });
      expect(input).toBeLessThanOrEqual(16384);
      expect(input + 4096).toBeLessThanOrEqual(10000);
    }
  });
  it('mixed unknown fallback skips automatic pre-send and suppresses recovery', async () => {
    const h = fixture({
      window: 12000,
      threshold: 0.7,
      overflow: true,
      fallbackProvider: { customEndpoint: true, contextLimit: () => 100000 },
    });
    await h.session.sendMessage('pending');
    expect(h.counts()).toMatchObject({ mainCalls: 1, summaryCalls: 0 });
  });
  it('after-turn trigger ignores large billed input and measures the actual next request', async () => {
    const h = fixture({
      history: [text('old'), text('latest')],
      window: 10000,
      afterTurn: true,
      mainInputTokens: 900000,
    });
    await h.session.sendMessage('pending');
    expect(h.counts()).toMatchObject({ mainCalls: 1, summaryCalls: 0 });
    expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
      tokensUsed: { input: 900000, output: 5 },
    });
  });
  it('compares the irreducible floor with the window instead of the threshold', async () => {
    const h = fixture({
      history: [text('x'.repeat(15000)), text('latest'.repeat(1000))],
      window: 10000,
      threshold: 0.5,
    });
    await h.session.sendMessage('pending');
    expect(h.counts().summaryCalls).toBeGreaterThan(0);
    expect(h.events.find((e) => e.type === 'session:compacted')).toMatchObject({
      reason: 'pre-send',
    });
  });
});

describe('W7 acknowledged disclosure, cap priority and hard turn boundaries', () => {
  it('awaits actual surface acknowledgement before unknown-window summariser egress', async () => {
    let entered: () => void = () => undefined,
      acknowledge: () => void = () => undefined;
    const shown = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delivered = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const h = fixture({
      auto: false,
      deps: {
        onCompactionStart: async (info) => {
          expect(info.reason).toBe('manual');
          expect(info.windowUnknown).toBe(true);
          expect(info.signal.aborted).toBe(false);
          entered();
          await delivered;
        },
      },
    });
    const running = h.session.compact();
    try {
      await shown;
      // Drain provider-entry microtasks while the acknowledgement is still held. Checking in
      // the callback's own microtask would also pass if the engine accidentally stopped awaiting it.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.counts().summaryCalls).toBe(0);
    } finally {
      acknowledge();
    }
    expect(await running).toMatchObject({ kind: 'compacted' });
    expect(h.counts().summaryCalls).toBeGreaterThan(0);
  });
  for (const active of [false, true])
    it(`surface callback cannot turn its thrown budget error into funding authority, active=${active}`, async () => {
      const h = fixture({
        ...(active ? { window: 12000 } : {}),
        threshold: 0.7,
        deps: {
          onCompactionStart: () => {
            throw new BudgetPauseError(123, 456, 100);
          },
        },
      });
      if (active) {
        await h.session.sendMessage('pending');
        expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
          error: { code: 'internal' },
        });
      } else {
        const result = await h.session.compact();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') throw new Error('expected observer failure');
        expect(result.message).toContain('observer');
      }
      expect(h.counts()).toMatchObject({ summaryCalls: 0, mainCalls: 0 });
      expect(h.events.filter((e) => e.type === 'session:compaction_failed')).toHaveLength(1);
      expect(h.events.some((e) => e.type === 'session:compaction_budget_refused')).toBe(false);
    });
  it('names the actual cap on a summariser budget refusal', async () => {
    const h = fixture({ auto: false, refusePass: 1 });
    const result = await h.session.compact();
    expect(result.kind).toBe('budget_refused');
    if (result.kind !== 'budget_refused') throw new Error('expected budget refusal');
    expect(result.message).toContain('cap of 2 micro-cents');
  });
  it('uses the first capability-eligible entry and excludes an unknown skipped primary from summariser bounds', async () => {
    const supports = {
      tools: false,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    };
    const h = fixture({
      provider: { supports: { ...supports, streaming: false } },
      fallbackProvider: { supports, contextLimit: () => 12_000 },
      threshold: 0.7,
    });
    await h.session.sendMessage('pending');
    expect(h.counts()).toMatchObject({ summaryCalls: 2, mainCalls: 1 });
    expect(h.events.find((event) => event.type === 'session:compacted')).toMatchObject({
      reason: 'pre-send',
    });
  });
  it('refuses an oversized running summary before another paid pass and preserves the entire original history', async () => {
    const h = fixture({ auto: false, window: 12_000, summaryText: 'S'.repeat(50_000) });
    expect(await h.session.compact()).toMatchObject({ kind: 'failed' });
    expect(h.counts()).toMatchObject({ summaryCalls: 1, mainCalls: 0 });
    expect(h.events.filter((event) => event.type === 'session:compaction_failed')).toHaveLength(1);
    expect(h.events.some((event) => event.type === 'session:compacted')).toBe(false);
    await h.session.sendMessage('still intact');
    const request = h.requests.at(-1);
    if (request === undefined) throw new Error('missing next request');
    expect(body(request)).toContain('old old');
  });
  it('checks the hard user-turn cap before starting any pre-send summariser', async () => {
    const h = fixture({ window: 12000, maxTurns: 3 });
    await h.session.sendMessage('blocked');
    expect(h.counts()).toMatchObject({ summaryCalls: 0, mainCalls: 0 });
    expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
      error: { code: 'turn_limit' },
    });
  });
});

describe('W7 current-invocation overflow authority and cancellable disclosure', () => {
  for (const earlierEngaged of [false, true])
    it(`does not recover a prior chain wrapper thrown by admission; earlierEngaged=${earlierEngaged}`, async () => {
      const old = fixture({ history: [text('old')], window: 10000 });
      const previousChain = new FallbackChain(
        [
          {
            provider: {
              ...old.provider,
              generate: () =>
                Promise.reject(
                  new LlmProviderError(
                    makeLlmError({
                      provider: 'openai',
                      kind: 'context_overflow',
                      message: 'earlier offline refusal',
                      status: 400,
                    }),
                  ),
                ),
            },
            model: 'compaction-fixture',
            maxAttempts: 1,
          },
        ],
        { keyFor: old.deps.keyFor, sleep: old.deps.sleep },
      );
      let previous: unknown;
      try {
        await previousChain.generate({ model: 'compaction-fixture', messages: [text('earlier')] });
      } catch (error) {
        previous = error;
      }
      expect(previous).toBeInstanceOf(LlmProviderError);
      let actualMainCalls = 0,
        summaries = 0;
      const h = fixture({
        history: [text('old'), text('middle'), text('latest')],
        window: 10000,
        ...(earlierEngaged ? { fallbackProvider: {} } : {}),
        provider: {
          stream: async function* (request): AsyncGenerator<StreamChunk> {
            await Promise.resolve();
            if (request.maxTokens === 4096) {
              summaries++;
              yield { type: 'text_delta', text: 'should never summarize' };
              yield {
                type: 'stop',
                stopReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            } else {
              actualMainCalls++;
              yield {
                type: 'error',
                error: makeLlmError({
                  provider: 'openai',
                  kind: 'protocol',
                  message: 'advance',
                }),
              };
            }
          },
        },
        deps: {
          preEgress: (info) => {
            if (info.maxTokens !== 4096 && (!earlierEngaged || info.provider === 'anthropic'))
              throw previous;
          },
        },
      });
      await h.session.sendMessage('current');
      expect(actualMainCalls).toBe(earlierEngaged ? 1 : 0);
      expect(summaries).toBe(0);
      expect(h.counts().summaryCalls).toBe(0);
      expect(h.events.some((e) => e.type === 'session:compacting')).toBe(false);
      expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
        error: { code: 'context_overflow' },
      });
    });

  for (const inline of [false, true])
    for (const origin of ['provider', 'admission', 'credential'] as const)
      it(`binds overflow to the current ${inline ? 'generate' : 'stream'} provider attempt; origin=${origin}`, async () => {
        const h = fixture({ history: [text('old')], window: 10000 });
        let calls = 0;
        const refusal = () =>
          new LlmProviderError(
            makeLlmError({
              provider: 'openai',
              kind: 'context_overflow',
              message: 'offline refusal',
              status: 400,
            }),
          );
        const provider: LlmProvider = {
          ...h.provider,
          supports: {
            ...h.provider.supports,
            media: { ...h.provider.supports.media, outputCombinations: [['image']] },
          },
          generate: () => {
            calls++;
            return Promise.reject(refusal());
          },
          stream: async function* (): AsyncGenerator<StreamChunk> {
            calls++;
            await Promise.resolve();
            yield { type: 'error', error: refusal().llmError };
          },
        };
        const outcome = await captureAgentTurnOutcome({
          nodeId: 'current',
          messages: [text('current')],
          ...(inline ? { outputModalities: ['image'] } : {}),
          planEntries: [{ provider, model: 'compaction-fixture', maxAttempts: 1 }],
          chainCapabilities: {
            keyFor: () => {
              if (origin === 'credential') throw refusal();
              return 'offline';
            },
            sleep: () => Promise.resolve(),
          },
          preEgress: () => {
            if (origin === 'admission') throw refusal();
          },
          emit: () => undefined,
          signal: createAbortController().signal,
          registry: h.deps.registry,
          dispatchContext: {
            nodeId: 'current',
            grantedToolIds: new Set(),
            config: {},
            toolPolicy: {},
            fsScope: 'sandboxed',
            gateApproved: false,
            effects: createInMemoryEffectJournalStore().for({
              kind: 'session',
              sessionId: 'current',
              turn: 1,
            }),
            effectSlot: 0,
          },
          limits: DEFAULT_AGENT_TURN_LIMITS,
        });
        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('expected refusal');
        expect(calls).toBe(origin === 'provider' ? 1 : 0);
        expect(outcome.error).toMatchObject({
          code: origin === 'credential' ? 'provider_auth' : 'context_overflow',
        });
        if (origin === 'provider') expect(outcome.overflowEntry?.provider).toBe(provider);
        else expect(outcome.overflowEntry).toBeUndefined();
      });

  it('does not borrow a previous genuine overflow when a current admission rethrows its error', async () => {
    const old = fixture({ history: [text('old')], window: 10000, overflow: true });
    const outcome = await captureAgentTurnOutcome({
      nodeId: 'earlier-call',
      messages: [text('earlier')],
      planEntries: [{ provider: old.provider, model: 'compaction-fixture', maxAttempts: 1 }],
      chainCapabilities: { keyFor: old.deps.keyFor, sleep: old.deps.sleep },
      emit: () => undefined,
      signal: createAbortController().signal,
      registry: old.deps.registry,
      dispatchContext: {
        nodeId: 'earlier-call',
        grantedToolIds: new Set(),
        config: {},
        toolPolicy: {},
        fsScope: 'sandboxed',
        gateApproved: false,
        effects: createInMemoryEffectJournalStore().for({
          kind: 'session',
          sessionId: 'earlier-call',
          turn: 1,
        }),
        effectSlot: 0,
      },
      limits: DEFAULT_AGENT_TURN_LIMITS,
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('expected prior genuine overflow');
    expect(outcome.overflowEntry).toBeDefined();
    expect(outcome.overflowEntry?.provider.contextLimit?.('compaction-fixture')).toBe(10000);
    const h = fixture({
      history: [text('old'), text('middle'), text('latest')],
      window: 10000,
      deps: {
        preEgress: (info) => {
          if (info.maxTokens !== 4096) throw outcome.error;
        },
      },
    });
    await h.session.sendMessage('current');
    expect(h.requests).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'session:compacting')).toBe(false);
    expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
      error: { code: 'context_overflow' },
    });
  });

  for (const entry of ['manual', 'pre-send', 'recovery', 'after-turn'] as const)
    for (const terminal of [false, true])
      for (const rejectLate of [false, true])
        it(`${entry} held disclosure ${terminal ? 'cancel' : 'Esc'} releases admission before late ${rejectLate ? 'rejection' : 'acknowledgement'}`, async () => {
          let enter = (): void => undefined,
            finish = (): void => undefined;
          const entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
          const held = new Promise<void>((resolve, reject) => {
            finish = () => (rejectLate ? reject(new Error('late surface refusal')) : resolve());
          });
          let released = 0,
            notifications = 0,
            settled = false;
          const after = entry === 'after-turn';
          const h = fixture({
            history: after
              ? [text('x'.repeat(17600)), text('y'.repeat(17600))]
              : [text('x'.repeat(17600)), text('middle'), text('latest')],
            window: 12000,
            threshold: entry === 'pre-send' ? 0.3 : after ? 0.8 : 1,
            afterTurn: after,
            mainText: after ? 'a'.repeat(4000) : 'reply',
            overflow: entry === 'recovery' ? 1 : false,
            deps: {
              preEgress: (info) =>
                info.maxTokens === 4096
                  ? {
                      settle: () => undefined,
                      settleAtReservedEstimate: () => undefined,
                      release: () => {
                        released++;
                      },
                    }
                  : undefined,
              onCompactionStart: async ({ signal }) => {
                if (++notifications > 1) return;
                enter();
                await held;
                expect(signal.aborted).toBe(true);
              },
            },
          });
          const running = (
            entry === 'manual' ? h.session.compact() : h.session.sendMessage('pending-unique')
          ).then(() => {
            settled = true;
          });
          try {
            await entered;
            if (terminal) h.session.cancel();
            else h.session.abort();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(settled).toBe(true);
            expect(released).toBe(1);
            expect(h.counts().summaryCalls).toBe(0);
            expect(
              h.events.some((e) => e.type === 'session:compacted' || e.type === 'session:trimmed'),
            ).toBe(false);
            expect(h.events.filter((e) => e.type === 'session:compaction_failed')).toHaveLength(
              terminal ? 0 : 1,
            );
          } finally {
            finish();
            await running;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          expect(h.counts().summaryCalls).toBe(0);
          if (!terminal) {
            await h.session.sendMessage('next-unique');
            expect(
              h.events.filter((e) => e.type === 'session:turn_completed').at(-1),
            ).toMatchObject({ stopReason: 'stop' });
          }
        });
});
