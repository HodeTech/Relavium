import { expect, it } from 'vitest';
import type { LlmProvider } from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { markUntrusted } from '../tools/untrusted.js';
import type { ToolRegistry, ToolResultPart } from '../tools/types.js';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import { AgentTurnError } from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';
import { LedgerDurabilityError } from './money-durability.js';
import { createAbortController } from './execution-host.js';

for (const kind of ['raw', 'typed', 'pause', 'ledger', 'opaque'] as const) {
  it(`user command controller initialization ${kind} preserves identity and releases the session`, async () => {
    const replacement = new Error('private reflection replacement');
    const marker =
      kind === 'typed'
        ? new AgentTurnError('provider_unavailable', 'private factory value', true)
        : kind === 'pause'
          ? new BudgetPauseError(1, 2, 100)
          : kind === 'ledger'
            ? new LedgerDurabilityError(new Error('private factory value'), 'false-writer')
            : kind === 'opaque'
              ? new Proxy(new Error('private factory value'), {
                  getPrototypeOf: () => {
                    throw replacement;
                  },
                })
              : new Error('private factory value');
    const counts = { controller: 0, dispatch: 0, reserve: 0, key: 0, provider: 0 };
    const events: SessionStreamEvent[] = [];
    const registry: ToolRegistry = {
      has: () => true,
      list: () => ['run_command'],
      dispatch: (call) => {
        counts.dispatch++;
        const result = { exitCode: 0, stdout: 'synthetic output', stderr: '', durationMs: 1 };
        const toolResult: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result };
        return Promise.resolve({
          output: result,
          mediaAttachments: markUntrusted([]),
          toolResult: markUntrusted(toolResult),
          truncated: false,
          events: {
            call: { toolId: 'run_command', toolInput: {} },
            result: { toolId: 'run_command', success: true, outputSummary: 'synthetic output' },
          },
        });
      },
    };
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: {
        tools: false,
        streaming: false,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        media: {
          input: { image: false, audio: false, video: false, document: false },
          outputCombinations: [],
        },
      },
      generate: () => {
        counts.provider++;
        throw new Error('unexpected provider');
      },
      stream: () => {
        counts.provider++;
        throw new Error('unexpected provider');
      },
    };
    const session = new AgentSession({
      sessionId: 'controller-command-' + kind,
      agentRef: 'command-fixture',
      agent: AgentSchema.parse({
        id: 'command-fixture',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        system_prompt: 'Synthetic offline control.',
      }),
      context: SessionContextSchema.parse({
        workingDir: '/workspace/session',
        fsScopeTier: 'sandboxed',
      }),
      deps: {
        resolveProvider: () => provider,
        tools: [],
        registry,
        sleep: () => Promise.resolve(),
        now: () => 0,
        reserveEffectTurnKey: () => ++counts.reserve,
        keyFor: () => {
          counts.key++;
          return 'synthetic-key';
        },
        newAbortController: () => {
          if (++counts.controller === 1) throw marker;
          return createAbortController();
        },
        emit: (event) => events.push(event),
      },
    });
    session.start();
    const escaped = await session.runUserCommand('synthetic-command', []).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Keep the assertion primitive: a wrong-identity formatter must not reflect an opaque throwable.
    expect(Object.is(escaped, marker)).toBe(true);
    expect(counts).toEqual({ controller: 1, dispatch: 0, reserve: 0, key: 0, provider: 0 });
    expect(events.map((event) => event.type)).toEqual(['session:started']);
    const next = await session.runUserCommand('synthetic-command', []);
    expect(next).toEqual({ kind: 'ran', exitCode: 0, stdout: 'synthetic output', stderr: '' });
    expect(counts).toEqual({ controller: 2, dispatch: 1, reserve: 1, key: 0, provider: 0 });
    expect(JSON.stringify(events)).not.toContain('private');
    expect(JSON.stringify(events)).not.toContain('false-writer');
  });
}
