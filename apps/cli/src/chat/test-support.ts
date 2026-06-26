import type { LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import type { SessionStreamHandleEvent } from '@relavium/core';

import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import type { ProviderResolver } from '../engine/providers.js';

/**
 * Chat-surface test fixtures (2.M) — a scripted streaming {@link LlmProvider} + the turn-chunk builders the
 * `AgentSession` host tests and the chat e2e replay, mirroring the `@relavium/core` m5 harness's
 * `scriptedProvider`. NOT shipped: imported only by `*.test.ts`, so it stays out of the engine-inlined bundle.
 */

const FIXED_USAGE = { inputTokens: 10, outputTokens: 5 } as const;

/** A terminal stream chunk — `stop` ends a plain turn, `tool_use` hands control to the tool loop. */
export const stop = (reason: 'stop' | 'tool_use' = 'stop'): StreamChunk => ({
  type: 'stop',
  stopReason: reason,
  usage: FIXED_USAGE,
});

/** A one-shot text turn: stream `text` then stop. */
export const textTurn = (text: string): StreamChunk[] => [
  { type: 'text_delta', text },
  stop('stop'),
];

/** A tool-calling turn: emit a `name` tool call (id `callId`) then a `tool_use` stop. */
export const toolUseTurn = (callId: string, name: string): StreamChunk[] => [
  { type: 'tool_call_start', id: callId, name },
  { type: 'tool_call_end', id: callId },
  stop('tool_use'),
];

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

/**
 * A provider that replays a different chunk list per `stream()` call (call N → `scripts[N]`). An
 * unscripted call throws — an unintended extra LLM invocation is a test bug, not a silent empty turn.
 */
export function scriptedProvider(
  scripts: StreamChunk[][],
  id: ProviderId = 'anthropic',
): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: () => {
      throw new Error('scriptedProvider.generate is not used (the session path streams)');
    },
    stream: () => {
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

/** A {@link ProviderResolver} that returns the scripted provider for its id and a fixed dummy key. */
export function scriptedResolver(
  scripts: StreamChunk[][],
  id: ProviderId = 'anthropic',
): ProviderResolver {
  const provider = scriptedProvider(scripts, id);
  return {
    resolveProvider: (requested) => (requested === id ? provider : undefined),
    keyFor: () => 'test-key',
  };
}

/** A resolver with no wired provider — every turn fails fast as an `internal` host-wiring gap (counts toward the cap). */
export function unresolvedResolver(): ProviderResolver {
  return { resolveProvider: () => undefined, keyFor: () => 'test-key' };
}

/** Drain a session handle's event stream to completion (closes on `session:cancelled`). */
export async function drainHandle(
  events: AsyncIterable<SessionStreamHandleEvent>,
): Promise<SessionStreamHandleEvent[]> {
  const collected: SessionStreamHandleEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
