/**
 * ADR-0128 through a real `AgentSession`: live collection, resume/reseat parity, admission, retention across
 * turns, compaction and trim. The pure rules are pinned in `turn-receipts.test.ts`; this file proves they are
 * wired into the session a surface actually runs.
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
  SessionContextSchema,
  type Agent,
  type SessionContext,
  type SessionMessage,
  type SessionToolHistoryEntry,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { ToolPolicyError } from '../tools/errors.js';
import type { ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { DEFAULT_AGENT_TURN_LIMITS } from './agent-turn.js';
import {
  AgentSession,
  SessionStateError,
  type SessionDeps,
  type SessionStreamEvent,
} from './agent-session.js';
import { createAbortController } from './execution-host.js';
import { reconstructSessionState } from './session-resume.js';
import {
  RECEIPT_BLOCK_OPENING,
  RECEIPT_NOTICE_INCOMPLETE,
  RECEIPT_NOTICE_LEGEND,
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
  id: 'receipt-chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are a concise chat agent.',
  tools: ['read_file', 'write_file', 'read_media', 'list_directory'],
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
/** One provider response that issues several tool calls at once. */
const callsTurn = (calls: readonly { id: string; name: string }[]): StreamChunk[] => [
  ...calls.flatMap(({ id, name }): StreamChunk[] => [
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_end', id },
  ]),
  { type: 'stop', stopReason: 'tool_use', usage },
];

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

/** Dispatches by NAME so one turn can record ok, error and denied outcomes. */
const registry: ToolRegistry = {
  has: () => true,
  list: () => ['read_file', 'write_file', 'read_media', 'list_directory'],
  dispatch: (call) => {
    if (call.name === 'read_media')
      return Promise.reject(
        new ToolPolicyError('read_media', 'media_scope_denied', 'scope denied'),
      );
    const failed = call.name === 'write_file';
    const result: ToolResultPart = {
      type: 'tool_result',
      toolCallId: call.id,
      result: failed ? 'boom' : 'TOOL-OK',
      ...(failed ? { isError: true } : {}),
    };
    return Promise.resolve({
      output: result.result,
      mediaAttachments: markUntrusted([]),
      toolResult: markUntrusted(result),
      truncated: false,
      events: {
        call: { toolId: call.name, toolInput: {} },
        result: { toolId: call.name, success: !failed, outputSummary: 'x' },
      },
    });
  },
};

interface Rig {
  readonly session: AgentSession;
  readonly requests: LlmRequest[];
  readonly events: SessionStreamEvent[];
}

function rig(
  scripts: StreamChunk[][],
  overrides: Partial<SessionDeps> = {},
  build: (deps: SessionDeps) => AgentSession = (deps) =>
    new AgentSession({
      sessionId: 'sess-r',
      agentRef: AGENT.id,
      agent: AGENT,
      context: CONTEXT,
      deps,
    }),
): Rig {
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
      return streamOf(scripts[call++] ?? []);
    },
    contextLimit: () => 1_000_000,
    managesOwnContext: () => false,
    estimateTokens: () => 0,
  };
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry,
    tools: [],
    limits: { ...DEFAULT_AGENT_TURN_LIMITS, recoverToolFailures: true },
    maxTurns: 500,
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
    ...overrides,
  };
  return { session: build(deps), requests, events };
}

const textOf = (message: LlmMessage | undefined): string =>
  message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';

/** The persister's row pattern for one completed turn: user, [assistant call, tool result]*, terminal text. */
function rowsOf(
  turns: readonly { user: string; final: string; history: readonly SessionToolHistoryEntry[] }[],
): SessionMessage[] {
  let sequenceNumber = 0;
  const row = (
    role: SessionMessage['role'],
    content: SessionMessage['content'],
  ): SessionMessage => ({
    id: `m-${sequenceNumber}`,
    sessionId: 'sess-r',
    sequenceNumber: sequenceNumber++,
    role,
    content,
    timestamp: '2026-11-15T00:00:00.000Z',
  });
  return turns.flatMap((turn) => [
    row('user', [{ type: 'text', text: turn.user }]),
    ...turn.history.flatMap((entry) => [
      row('assistant', [entry.call]),
      row('tool', [entry.result]),
    ]),
    row('assistant', [{ type: 'text', text: turn.final }]),
  ]);
}

const RECORD = {
  id: 'sess-r',
  agentSlug: AGENT.id,
  context: CONTEXT,
  status: 'idle' as const,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
};

const historyOf = (events: readonly SessionStreamEvent[]): SessionToolHistoryEntry[][] =>
  events.flatMap((event) =>
    event.type === 'session:turn_completed' ? [[...(event.toolHistory ?? [])]] : [],
  );

describe('live collection (ADR-0128)', () => {
  it('shows the next request the recorded calls and each outcome, behind one legend', async () => {
    const { session, requests } = rig([
      callsTurn([{ id: 'p1', name: 'read_file' }]),
      callsTurn([{ id: 'p2', name: 'write_file' }]),
      callsTurn([{ id: 'p3', name: 'read_media' }]),
      textTurn('done one'),
      textTurn('done two'),
    ]);
    session.start();
    await session.sendMessage('first request');
    await session.sendMessage('second request');
    const second = requests[4]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(textOf(second[0])).toBe(
      `${RECEIPT_NOTICE_LEGEND}\n\nfirst request\n\n${RECEIPT_BLOCK_OPENING}\n` +
        '1. read_file — ok\n2. write_file — error\n3. read_media — denied\n' +
        '[End of recorded tool calls.]',
    );
    expect(textOf(second[1])).toBe('done one');
    expect(textOf(second[2])).toBe('second request');
    // The block is a separate text part of the user message, after the user's own text.
    expect(second[0]?.content.map((p) => p.type)).toEqual(['text', 'text', 'text']);
  });

  it('adds no byte to a history in which the live instance observed no tool call', async () => {
    const { session, requests } = rig([textTurn('a1'), textTurn('a2')]);
    session.start();
    await session.sendMessage('q1');
    await session.sendMessage('q2');
    expect(requests[1]?.messages.map(textOf)).toEqual(['q1', 'a1', 'q2']);
  });

  it('never lets a substituted or credential-like name reach the request', async () => {
    const { session, requests } = rig([
      callsTurn([{ id: 'p1', name: 'sk-live-LEAK-0123456789' }]),
      textTurn('done'),
      textTurn('next'),
    ]);
    session.start();
    await session.sendMessage('q1');
    await session.sendMessage('q2');
    const sent = JSON.stringify(requests[2]?.messages);
    expect(sent).toContain('1. other_tool — ');
    expect(sent).not.toContain('LEAK');
    expect(sent).not.toContain('session-tool');
  });

  it('omits receipts under memory none and shows only selected turns under window', async () => {
    const withMemory = (memory: Agent['memory']): Agent => AgentSchema.parse({ ...AGENT, memory });
    for (const [memory, expected] of [
      [{ type: 'none' as const }, ['q3']],
      [{ type: 'window' as const, window_size: 1 }, null],
    ] as const) {
      const agent = withMemory(memory);
      const { session, requests } = rig(
        [
          callsTurn([{ id: 'a', name: 'read_file' }]),
          textTurn('r1'),
          callsTurn([{ id: 'b', name: 'list_directory' }]),
          textTurn('r2'),
          textTurn('r3'),
        ],
        {},
        (deps) =>
          new AgentSession({
            sessionId: 'sess-r',
            agentRef: agent.id,
            agent,
            context: CONTEXT,
            deps,
          }),
      );
      session.start();
      await session.sendMessage('q1');
      await session.sendMessage('q2');
      await session.sendMessage('q3');
      const last = requests.at(-1)?.messages ?? [];
      if (expected !== null) expect(last.map(textOf)).toEqual(expected);
      else {
        const text = last.map(textOf).join('|');
        expect(text).toContain('1. list_directory — ok');
        expect(text).not.toContain('read_file');
        expect(text).not.toContain('q1');
        expect(text).not.toContain(RECEIPT_NOTICE_INCOMPLETE);
      }
    }
  });
});

describe('resume and reseat rebuild the same receipts', () => {
  const twoToolTurns = [
    callsTurn([
      { id: 'p1', name: 'read_file' },
      { id: 'p2', name: 'write_file' },
    ]),
    textTurn('r1'),
    callsTurn([{ id: 'p3', name: 'read_media' }]),
    textTurn('r2'),
  ];

  it('produces the identical request for a history in which every turn made calls', async () => {
    const live = rig([...twoToolTurns, textTurn('r3')]);
    live.session.start();
    await live.session.sendMessage('q1');
    await live.session.sendMessage('q2');
    await live.session.sendMessage('q3');
    const liveRequest = live.requests.at(-1)?.messages;

    const histories = historyOf(live.events);
    const state = reconstructSessionState(
      RECORD,
      rowsOf([
        { user: 'q1', final: 'r1', history: histories[0] ?? [] },
        { user: 'q2', final: 'r2', history: histories[1] ?? [] },
      ]),
    );
    const restored = rig([textTurn('r3')], {}, (deps) =>
      AgentSession.resume(
        { sessionId: 'sess-r', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
        state,
      ),
    );
    await restored.session.sendMessage('q3');
    expect(restored.requests[0]?.messages).toEqual(liveRequest);
  });

  it('differs for a plain-chat turn only by the one fixed incompleteness sentence', async () => {
    const live = rig([textTurn('a1'), textTurn('a2')]);
    live.session.start();
    await live.session.sendMessage('q1');
    await live.session.sendMessage('q2');
    const liveRequest = live.requests[1]?.messages ?? [];
    const state = reconstructSessionState(
      RECORD,
      rowsOf([{ user: 'q1', final: 'a1', history: [] }]),
    );
    const restored = rig([textTurn('a2')], {}, (deps) =>
      AgentSession.resume(
        { sessionId: 'sess-r', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
        state,
      ),
    );
    await restored.session.sendMessage('q2');
    const restoredRequest = restored.requests[0]?.messages ?? [];
    expect(liveRequest.map(textOf)).toEqual(['q1', 'a1', 'q2']);
    expect(restoredRequest.map(textOf)).toEqual([`${RECEIPT_NOTICE_INCOMPLETE}\n\nq1`, 'a1', 'q2']);
  });

  it('retains the same records across many turns, evicting the same oldest block live and restored', async () => {
    // Nine turns of sixteen calls (the per-response limit): 144 records exceed the 128 cap, so the oldest block
    // is evicted and exactly eight remain.
    const calls = (turn: number) =>
      Array.from({ length: 16 }, (_, i) => ({
        id: `p${turn}-${i}`,
        name: i % 2 === 0 ? 'read_file' : 'list_directory',
      }));
    const scripts = Array.from({ length: 9 }, (_, t) => [
      callsTurn(calls(t)),
      textTurn(`r${t}`),
    ]).flat();
    const live = rig([...scripts, textTurn('last')]);
    live.session.start();
    for (let turn = 0; turn < 9; turn += 1) await live.session.sendMessage(`q${turn}`);
    await live.session.sendMessage('q-last');
    const liveRequest = live.requests.at(-1)?.messages ?? [];
    const liveText = liveRequest.map(textOf).join('\n');
    expect(liveText).toContain(RECEIPT_NOTICE_INCOMPLETE);
    expect(
      liveText.match(new RegExp(RECEIPT_BLOCK_OPENING.replace(/[[\]().]/g, '\\$&'), 'g')),
    ).toHaveLength(8);

    const histories = historyOf(live.events);
    const state = reconstructSessionState(
      RECORD,
      rowsOf(
        Array.from({ length: 9 }, (_, t) => ({
          user: `q${t}`,
          final: `r${t}`,
          history: histories[t] ?? [],
        })),
      ),
    );
    const restored = rig([textTurn('last')], {}, (deps) =>
      AgentSession.resume(
        { sessionId: 'sess-r', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
        state,
      ),
    );
    await restored.session.sendMessage('q-last');
    expect(restored.requests[0]?.messages).toEqual(liveRequest);
  });

  it('resumes 50 completed turns of four calls without refusal, evicting only the oldest', async () => {
    const entry = (id: string): SessionToolHistoryEntry => ({
      call: { type: 'tool_call', id, name: 'read_file', argsBytes: 2 },
      result: { type: 'tool_result', toolCallId: id, resultBytes: 2, outcome: 'ok' },
    });
    const turns = Array.from({ length: 50 }, (_, t) => ({
      user: `q${t}`,
      final: `r${t}`,
      history: Array.from({ length: 4 }, (_, i) => entry(`session-tool:${t}:${i}`)),
    }));
    const state = reconstructSessionState(RECORD, rowsOf(turns));
    expect(state.completedTurnSpans).toHaveLength(50);
    const retained = state.completedTurnSpans.filter((span) => span.receipts.records.length > 0);
    expect(retained).toHaveLength(32);
    expect(state.completedTurnSpans.slice(0, 18).every((span) => span.receipts.incomplete)).toBe(
      true,
    );
    const restored = rig([textTurn('ok')], {}, (deps) =>
      AgentSession.resume(
        { sessionId: 'sess-r', agentRef: AGENT.id, agent: AGENT, context: CONTEXT, deps },
        state,
      ),
    );
    await restored.session.sendMessage('next');
    expect(textOf(restored.requests[0]?.messages[0])).toContain(RECEIPT_NOTICE_INCOMPLETE);
  });
});

describe('admission of host-supplied receipts', () => {
  const resumeWith = (receipts: unknown, onCost: () => void = () => undefined) => {
    const built = rig([textTurn('x')], { updateCost: onCost }, (sessionDeps) =>
      AgentSession.resume(
        {
          sessionId: 'sess-r',
          agentRef: AGENT.id,
          agent: AGENT,
          context: CONTEXT,
          deps: sessionDeps,
        },
        {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'q' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
          ],
          // A deliberately untyped value: the admission gate is what must refuse it.
          completedTurnSpans: [{ start: 0, end: 2, receipts: receipts as never }],
          turnCount: 1,
          cumulativeCostMicrocents: 0,
          conservativeCostMicrocents: 0,
        },
      ),
    );
    return built;
  };

  it('refuses an over-cap or malformed value as invalid resume state, before any budget callback', () => {
    let costCalls = 0;
    for (const bad of [
      {
        records: Array.from({ length: 33 }, () => ({ label: 'read_file', outcome: 'ok' })),
        omitted: 0,
        incomplete: false,
      },
      { records: [{ label: 'sk-secret', outcome: 'ok' }], omitted: 0, incomplete: false },
      { records: [], omitted: 1, incomplete: false },
      undefined,
    ]) {
      let refusal: unknown;
      try {
        resumeWith(bad, () => (costCalls += 1));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(SessionStateError);
      expect(refusal instanceof SessionStateError && refusal.code).toBe('invalid_resume_state');
    }
    expect(costCalls).toBe(0);
  });

  it('admits a valid supplied value and projects it', async () => {
    const built = resumeWith({
      records: [{ label: 'read_file', outcome: 'denied' }],
      omitted: 0,
      incomplete: false,
    });
    await built.session.sendMessage('next');
    expect(textOf(built.requests[0]?.messages[0])).toContain('1. read_file — denied');
  });
});

describe('compaction and trim keep receipts with their turns', () => {
  const threeToolTurns = [
    callsTurn([{ id: 'a', name: 'read_file' }]),
    textTurn('r1'),
    callsTurn([{ id: 'b', name: 'write_file' }]),
    textTurn('r2'),
    callsTurn([{ id: 'c', name: 'list_directory' }]),
    textTurn('r3'),
  ];

  async function threeTurns(extra: StreamChunk[][]): Promise<Rig> {
    const built = rig([...threeToolTurns, ...extra]);
    built.session.start();
    await built.session.sendMessage('q1');
    await built.session.sendMessage('q2');
    await built.session.sendMessage('q3');
    return built;
  }

  it('feeds the folded turns’ receipts to the summariser and keeps the surviving turn’s', async () => {
    const built = await threeTurns([textTurn('SUMMARY'), textTurn('after')]);
    const before = built.requests.length;
    expect((await built.session.compact('manual')).kind).toBe('compacted');
    const summariser = textOf(built.requests[before]?.messages[0]);
    expect(summariser).toContain('1. read_file — ok');
    expect(summariser).toContain('1. write_file — error');
    expect(summariser).not.toContain('list_directory');
    expect(summariser.startsWith(RECEIPT_NOTICE_LEGEND)).toBe(true);

    await built.session.sendMessage('q4');
    const next = textOf(built.requests.at(-1)?.messages[0]);
    expect(next).toContain('SUMMARY');
    expect(next).toContain('1. list_directory — ok');
    expect(next).not.toContain('read_file');
    expect(next).not.toContain('write_file');
  });

  it('keeps the original receipts when compaction fails', async () => {
    const built = await threeTurns([
      [{ type: 'stop', stopReason: 'stop', usage }],
      textTurn('after'),
    ]);
    expect((await built.session.compact('manual')).kind).toBe('failed');
    await built.session.sendMessage('q4');
    const next = built.requests.at(-1)?.messages.map(textOf).join('\n') ?? '';
    for (const line of ['1. read_file — ok', '1. write_file — error', '1. list_directory — ok'])
      expect(next).toContain(line);
  });

  it('restores every receipt when the completion sink refuses the compaction after installation', async () => {
    // This is the rollback branch: the history was already replaced when the synchronous `session:compacted`
    // notification threw, so the receipts of the folded turns must come back with the text.
    let refuse = false;
    const built = rig([...threeToolTurns, textTurn('SUMMARY'), textTurn('after')], {
      emit: (event) => {
        if (refuse && event.type === 'session:compacted') throw new Error('sink refused');
      },
    });
    built.session.start();
    await built.session.sendMessage('q1');
    await built.session.sendMessage('q2');
    await built.session.sendMessage('q3');
    refuse = true;
    await built.session.compact('manual').catch(() => undefined);
    refuse = false;
    await built.session.sendMessage('q4');
    const next = built.requests.at(-1)?.messages.map(textOf).join('\n') ?? '';
    expect(next).not.toContain('SUMMARY');
    for (const line of ['1. read_file — ok', '1. write_file — error', '1. list_directory — ok'])
      expect(next).toContain(line);
  });

  it('rebases receipts through a trim and drops those of the trimmed turns', async () => {
    const built = await threeTurns([textTurn('after')]);
    expect(built.session.trimHistory(2)).toMatchObject({ kind: 'trimmed' });
    await built.session.sendMessage('q4');
    const next = built.requests.at(-1)?.messages.map(textOf).join('\n') ?? '';
    expect(next).toContain('1. list_directory — ok');
    expect(next).not.toContain('read_file');
    expect(next).not.toContain('write_file');
  });
});
