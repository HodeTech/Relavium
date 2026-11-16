/**
 * ADR-0132 through a real `AgentSession` and the real registry: when the tool is offered, what the model receives,
 * what rides the event stream, the per-turn ceiling and "a skip closes questions" on the real tool loop, and what a stop
 * at the card does to the turn. The pure schema/answer rules are pinned in `tools/ask-user.test.ts`.
 */
import type { CapabilityFlags, LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';
import {
  AgentSchema,
  SessionContextSchema,
  type Agent,
  type SessionContext,
} from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { type AskUserAnswer, type AskUserDelegate } from '../tools/ask-user.js';
import { BUILTIN_TOOLS } from '../tools/builtins.js';
import { createToolRegistry } from '../tools/registry.js';
import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { DEFAULT_AGENT_TURN_LIMITS } from './agent-turn.js';
import { createAbortController } from './execution-host.js';

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
  id: 'asker',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You may ask the user.',
  tools: ['ask_user'],
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

const QUESTION = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

/** A response that makes the given number of `ask_user` calls, in order. */
function asks(count: number, args: unknown = QUESTION): StreamChunk[] {
  const ids = Array.from({ length: count }, (_, index) => `ask-${String(index + 1)}`);
  return [
    ...ids.flatMap((id): StreamChunk[] => [
      { type: 'tool_call_start', id, name: 'ask_user' },
      { type: 'tool_call_delta', id, argsJsonDelta: JSON.stringify(args) },
      { type: 'tool_call_end', id },
    ]),
    { type: 'stop', stopReason: 'tool_use', usage },
  ];
}

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

interface Rig {
  readonly session: AgentSession;
  readonly requests: LlmRequest[];
  readonly events: SessionStreamEvent[];
}

function rig(scripts: StreamChunk[][], askUser?: AskUserDelegate): Rig {
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
    registry: createToolRegistry({ tools: BUILTIN_TOOLS, host: {} }),
    tools: BUILTIN_TOOLS,
    limits: { ...DEFAULT_AGENT_TURN_LIMITS, recoverToolFailures: true },
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
    ...(askUser === undefined ? {} : { askUser }),
  };
  const session = new AgentSession({
    sessionId: 'sess-ask',
    agentRef: AGENT.id,
    agent: AGENT,
    context: CONTEXT,
    deps,
  });
  return { session, requests, events };
}

const advertised = (request: LlmRequest | undefined): string[] =>
  (request?.tools ?? []).map((tool) => tool.name);

/** Every tool-result string the model was sent in a request. */
function toolResultsIn(request: LlmRequest | undefined): string[] {
  const out: string[] = [];
  for (const message of request?.messages ?? []) {
    for (const part of message.content) {
      if (part.type === 'tool_result')
        out.push(typeof part.result === 'string' ? part.result : JSON.stringify(part.result));
    }
  }
  return out;
}

const answered = (label: string): AskUserAnswer => ({
  kind: 'answered',
  answers: [{ selected: [label] }],
});

describe('ask_user is offered only where someone can answer (ADR-0132 §1, CR-73)', () => {
  it('is not advertised while the session has no delegate, even though the agent is granted it', async () => {
    const { session, requests } = rig([textTurn('hi')]);
    session.start();
    await session.sendMessage('hello');
    expect(advertised(requests[0])).toEqual([]);
  });

  it('is advertised once the delegate is wired', async () => {
    const { session, requests } = rig(
      [textTurn('hi')],
      vi.fn<AskUserDelegate>(() => Promise.resolve({ kind: 'skipped' })),
    );
    session.start();
    await session.sendMessage('hello');
    expect(advertised(requests[0])).toEqual(['ask_user']);
  });
});

describe('a question through the real tool loop (ADR-0132 §3, §5, §6)', () => {
  it('shows the card, gives the model the answer, and keeps the words out of the event stream', async () => {
    const words = 'PRIVATE-WORDS-OF-THE-PERSON';
    const delegate = vi.fn<AskUserDelegate>(() =>
      Promise.resolve({ kind: 'answered', answers: [{ selected: [], other: words }] }),
    );
    const { session, requests, events } = rig([asks(1), textTurn('done')], delegate);
    session.start();
    await session.sendMessage('which file?');

    expect(delegate).toHaveBeenCalledTimes(1);
    // The delegate got the VALIDATED request (the default was applied).
    expect(delegate.mock.calls[0]?.[0].questions[0]?.multiSelect).toBe(false);
    // The model's next request carries the answer…
    const received = toolResultsIn(requests[1]);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain(words);
    expect(received[0]).toContain('"status":"answered"');
    // …and nothing on the event stream does: the summary is a closed phrase.
    const toolResults = events.filter((event) => event.type === 'agent:tool_result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolId: 'ask_user',
      success: true,
      outputSummary: 'answered 1 question',
    });
    expect(JSON.stringify(events)).not.toContain(words);
    const completed = events.filter((event) => event.type === 'session:turn_completed');
    expect(completed[0]).toMatchObject({ stopReason: 'stop' });
  });

  it('answers a skip with the fixed text and lets the turn go on', async () => {
    const { session, requests, events } = rig([asks(1), textTurn('ok, I will pick')], () =>
      Promise.resolve({ kind: 'skipped' }),
    );
    session.start();
    await session.sendMessage('which file?');
    expect(toolResultsIn(requests[1])[0]).toContain('"status":"skipped"');
    expect(events.find((event) => event.type === 'agent:tool_result')).toMatchObject({
      outputSummary: 'skipped',
      success: true,
    });
    expect(events.filter((event) => event.type === 'session:turn_completed')[0]).toMatchObject({
      stopReason: 'stop',
    });
  });

  it('a skip closes questions for the rest of the turn: the second call in the response shows no card', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve({ kind: 'skipped' }));
    const { session, requests } = rig([asks(2), textTurn('done')], delegate);
    session.start();
    await session.sendMessage('go');
    expect(delegate).toHaveBeenCalledTimes(1);
    const received = toolResultsIn(requests[1]);
    expect(received).toHaveLength(2);
    expect(received[0]).toContain('"status":"skipped"');
    expect(received[1]).toContain('"reason":"skipped_earlier"');
  });

  it('has no per-turn card ceiling: a response may carry several questions and each opens its card', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve(answered('alpha.ts')));
    const { session, requests } = rig([asks(5), textTurn('done')], delegate);
    session.start();
    await session.sendMessage('go');
    expect(delegate).toHaveBeenCalledTimes(5);
    const received = toolResultsIn(requests[1]);
    expect(received).toHaveLength(5);
    expect(received.every((text) => text.includes('"status":"answered"'))).toBe(true);
  });

  it('a skip closes questions for ITS turn only: the next turn may ask again', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve({ kind: 'skipped' }));
    const { session } = rig([asks(1), textTurn('one'), asks(1), textTurn('two')], delegate);
    session.start();
    await session.sendMessage('first');
    await session.sendMessage('second');
    expect(delegate).toHaveBeenCalledTimes(2);
  });

  it('an invalid call is refused to the model as a correctable error and opens no card', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.resolve(answered('alpha.ts')));
    const bad = { questions: [{ ...QUESTION.questions[0], question: 'two\nlines' }] };
    const { session, requests } = rig([asks(1, bad), textTurn('sorry')], delegate);
    session.start();
    await session.sendMessage('go');
    expect(delegate).not.toHaveBeenCalled();
    const received = toolResultsIn(requests[1]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(/invalid arguments/i);
    expect(received[0]).toContain('questions.0.question');
  });
});

describe('what a later turn sees (ADR-0132 §6, ADR-0128)', () => {
  it('shows an `ask_user` receipt and nothing of the question or the answer', async () => {
    const words = 'PRIVATE-WORDS-OF-THE-PERSON';
    const { session, requests } = rig([asks(1), textTurn('I picked alpha'), textTurn('next')], () =>
      Promise.resolve({ kind: 'answered', answers: [{ selected: [], other: words }] }),
    );
    session.start();
    await session.sendMessage('which file?');
    await session.sendMessage('and then?');
    const text = JSON.stringify(requests[2]?.messages ?? []);
    expect(text).toContain('ask_user');
    expect(text).not.toContain(words);
    expect(text).not.toContain('Which file?');
    expect(text).not.toContain('alpha.ts');
  });
});

describe('a stop at the card (ADR-0132 §5, ADR-0119)', () => {
  it('Esc/Ctrl-C at the card aborts the turn: the call is recorded cancelled and the turn is retained as aborted', async () => {
    let signalSeen: unknown;
    let openCard = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      openCard = resolve;
    });
    const delegate: AskUserDelegate = (_request, signal) =>
      new Promise((_resolve, reject) => {
        signalSeen = signal;
        openCard();
        signal?.addEventListener('abort', () => {
          const error = new Error('stopped');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const { session, events } = rig([asks(1), textTurn('never')], delegate);
    session.start();
    const running = session.sendMessage('which file?');
    await opened;
    session.abort();
    await running;

    expect(signalSeen).toBeDefined();
    const terminal = events.filter((event) => event.type === 'session:turn_completed')[0];
    expect(terminal).toMatchObject({
      stopReason: 'aborted',
      interruption: { reason: 'aborted' },
      toolHistory: [{ call: { name: 'ask_user' }, result: { outcome: 'cancelled' } }],
    });
  });

  it('a SESSION-ENDING cancel with a card open keeps the ADR-0119 rollback: nothing is retained', async () => {
    let openCard = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      openCard = resolve;
    });
    const delegate: AskUserDelegate = (_request, signal) =>
      new Promise((_resolve, reject) => {
        openCard();
        signal?.addEventListener('abort', () => {
          const error = new Error('stopped');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const { session, events } = rig([asks(1), textTurn('never')], delegate);
    session.start();
    const running = session.sendMessage('which file?');
    await opened;
    session.cancel(); // the session ends — not a turn abort
    await running.catch(() => undefined);
    const completed = events.filter((event) => event.type === 'session:turn_completed');
    expect(completed.every((event) => event.interruption === undefined)).toBe(true);
    expect(events.some((event) => event.type === 'session:cancelled')).toBe(true);
  });

  it('a delegate that fails (not a stop) ends the turn with a classified error and is never retried', async () => {
    const delegate = vi.fn<AskUserDelegate>(() => Promise.reject(new Error('the card crashed')));
    const { session, events } = rig([asks(1), textTurn('never')], delegate);
    session.start();
    await session.sendMessage('go').catch(() => undefined);
    expect(delegate).toHaveBeenCalledTimes(1);
    const terminal = events.filter((event) => event.type === 'session:turn_completed')[0];
    expect(terminal).toMatchObject({ stopReason: 'error' });
  });
});
