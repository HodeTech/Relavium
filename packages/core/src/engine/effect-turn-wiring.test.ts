/**
 * The turn-level half of the effect journal
 * ([ADR-0080](../../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md) §7-8;
 * canonical contract in [effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §5-7).
 *
 * **Why this file exists.** `effect-bracket.test.ts` proves the registry journals and classifies correctly.
 * It cannot prove the turn loop READS either answer. A review measured both gaps by mutation: hard-coding
 * `retryable: true` in `codeForToolError`, and hard-coding `slotBase: 0` so every tool round restarts its
 * ordinals, each left all 1,209 core tests green. The first re-fires a possibly-landed effect by re-running
 * the node; the second collides round 2's first tool call with round 1's on the journal's unique identity.
 */

import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import { unwiredEffectJournal } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { ToolExecutionError } from '../tools/errors.js';
import type {
  ToolCallPart,
  ToolDispatchContext,
  ToolRegistry,
  ToolResultPart,
} from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import {
  AgentTurnError,
  DEFAULT_AGENT_TURN_LIMITS,
  runAgentTurn,
  type AgentTurnParams,
} from './agent-turn.js';

const CAPS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const c of chunks) yield c;
}

function scriptedProvider(id: ProviderId, scripts: StreamChunk[][]): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('generate not used here');
    },
    stream: (): AsyncIterable<StreamChunk> => {
      const chunks = scripts[call];
      call += 1;
      if (chunks === undefined) throw new Error(`unscripted stream call #${call}`);
      return streamOf(chunks);
    },
  };
}

const USE = (id: string, name = 'send'): readonly StreamChunk[] => [
  { type: 'tool_call_start', id, name },
  { type: 'tool_call_end', id },
];
const STOP = (reason: 'stop' | 'tool_use'): StreamChunk => ({
  type: 'stop',
  stopReason: reason,
  usage: { inputTokens: 1, outputTokens: 1 },
});

function paramsWith(provider: LlmProvider, registry: ToolRegistry): AgentTurnParams {
  const dispatchContext: Omit<ToolDispatchContext, 'signal'> = {
    nodeId: 'n1',
    grantedToolIds: new Set(['send']),
    config: {},
    toolPolicy: {},
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: unwiredEffectJournal(),
    effectSlot: 0,
  };
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    planEntries: [{ provider, model: 'claude-opus-4-8', maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'k', sleep: () => Promise.resolve(), now: () => 0 },
    nodeId: 'n1',
    emit: () => undefined,
    signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
    registry,
    dispatchContext,
    limits: DEFAULT_AGENT_TURN_LIMITS,
  };
}

/** A registry that always throws the given dispatch error. */
function throwingRegistry(error: ToolExecutionError): ToolRegistry {
  return {
    has: () => true,
    list: () => ['send'],
    dispatch: () => Promise.reject(error),
  };
}

/** A registry that succeeds and records the `effectSlot` each dispatch was handed. */
function slotRecordingRegistry(slots: number[]): ToolRegistry {
  return {
    has: () => true,
    list: () => ['send'],
    dispatch: (call: ToolCallPart, ctx: ToolDispatchContext) => {
      slots.push(ctx.effectSlot);
      const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'OK' };
      return Promise.resolve({
        output: 'OK',
        toolResult: markUntrusted(result),
        truncated: false,
        events: {
          call: { toolId: call.name, toolInput: {} },
          result: { toolId: call.name, success: true, outputSummary: 'OK' },
        },
      });
    },
  };
}

describe('the turn loop reads the registry’s retryable stamp (ADR-0080 §8)', () => {
  it('a journaled dispatch failure reaches the node as NON-retryable', async () => {
    // The registry stamps `retryable: false` once an effect left the process. `codeForToolError` is the one
    // reader, and the engine gates node re-dispatch purely on `AgentTurnError.retryable` — so this assertion
    // is the whole distance between "a POST timed out" and "we POSTed twice".
    const provider = scriptedProvider('anthropic', [[...USE('c1'), STOP('tool_use')]]);
    const err = new ToolExecutionError('send', 'tool `send` failed', new Error('timeout'), {
      recoverable: false,
      retryable: false,
    });

    await expect(runAgentTurn(paramsWith(provider, throwingRegistry(err)))).rejects.toMatchObject({
      code: 'tool_failed',
      retryable: false,
    });
  });

  it('an ORDINARY dispatch failure stays retryable — the negative control', async () => {
    // Without this the assertion above passes for an implementation that made every tool failure fatal,
    // which would silently disable the node-retry budget for every transient read.
    const provider = scriptedProvider('anthropic', [[...USE('c1'), STOP('tool_use')]]);
    const err = new ToolExecutionError('send', 'tool `send` failed', new Error('ECONNRESET'), {
      recoverable: false,
      retryable: true,
    });

    const rejection: unknown = await runAgentTurn(
      paramsWith(provider, throwingRegistry(err)),
    ).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(AgentTurnError);
    expect(rejection).toMatchObject({ code: 'tool_failed', retryable: true });
  });
});

describe('the slot ordinal carries ACROSS tool rounds (ADR-0080 §5)', () => {
  it('round 2 continues where round 1 stopped — it does not restart at 0', async () => {
    // Both rounds share ONE correlation (same run, node and attempt), so the slot is the only thing keeping
    // their identities apart. Restarting per round makes round 2's first call collide with round 1's, and
    // the journal refuses it — permanently, since nothing sweeps the row.
    const slots: number[] = [];
    const provider = scriptedProvider('anthropic', [
      [...USE('c1'), ...USE('c2'), STOP('tool_use')], // round 1: two calls
      [...USE('c3'), STOP('tool_use')], // round 2: one more
      [{ type: 'text_delta', text: 'done' }, STOP('stop')],
    ]);

    await runAgentTurn(paramsWith(provider, slotRecordingRegistry(slots)));

    expect(slots).toEqual([0, 1, 2]);
  });
});
