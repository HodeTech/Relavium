import { describe, expect, it } from 'vitest';
import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { reconstructSessionState, unwrapUntrusted } from '@relavium/core';
import type { LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';
import type { ResolvedChatConfig } from '../config/resolve.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { buildResumedChatSession } from './session-host.js';
import { createSessionPersister } from './persister.js';

const chat: ResolvedChatConfig = {
  defaultModel: undefined,
  defaultProvider: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: true,
  compactThreshold: 0.7,
  maxCostMicrocents: undefined,
  onExceed: undefined,
  strictCostCap: false,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};
const iso = '2026-10-10T00:00:00.000Z';

describe('W7 native SQLite compaction boundaries across active turns and resume', () => {
  for (const refuse of [false, true])
    it(`keeps legacy and empty-final boundaries exact during pending-user compaction; refused=${refuse}`, async () => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        const store = createSessionStore(client.db);
        const agent = AgentSchema.parse({
          id: 'compaction-native',
          model: 'offline-model',
          provider: 'openai',
          system_prompt: 'authored',
          max_tokens: 64,
        });
        const record: AgentSessionRecord = {
          id: 'compaction-native',
          agentSlug: agent.id,
          agentSnapshot: agent,
          context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
          status: 'ended',
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostMicrocents: 0,
          totalConservativeMicrocents: 0,
          createdAt: iso,
          updatedAt: iso,
        };
        const row = (
          sequenceNumber: number,
          role: 'user' | 'assistant',
          text: string,
        ): SessionMessage => ({
          id: `old-${sequenceNumber}`,
          sessionId: record.id,
          sequenceNumber,
          role,
          content: [{ type: 'text', text }],
          timestamp: iso,
        });
        const messages = [
          row(0, 'user', 'old '.repeat(9000)),
          row(1, 'assistant', 'old final'),
          row(2, 'user', 'legacy retained'),
          row(3, 'user', 'latest retained'),
          row(4, 'assistant', ''),
        ];
        store.createSession(record);
        for (const message of messages) store.appendMessage(message);
        const requests: LlmRequest[] = [];
        let passes = 0;
        const provider: LlmProvider = {
          id: 'openai',
          supports: CHAT_TEXT_CAPABILITY_FLAGS,
          contextLimit: () => 12000,
          generate: () => Promise.reject(new Error('unused generate')),
          stream: async function* (request): AsyncGenerator<StreamChunk> {
            requests.push(request);
            if (request.maxTokens === 4096 && ++passes === 2 && refuse)
              throw new Error('synthetic second-pass failure');
            yield {
              type: 'text_delta',
              text: request.maxTokens === 4096 ? 'native summary' : 'next final',
            };
            yield await Promise.resolve({
              type: 'stop',
              stopReason: 'stop',
              usage: { inputTokens: 7, outputTokens: 3 },
            });
          },
        };
        const built = await buildResumedChatSession({
          chat,
          record,
          messages,
          now: () => Date.parse(iso),
          afterTurnCompaction: false,
          providers: { resolveProvider: () => provider, keyFor: () => 'offline-placeholder' },
        });
        let id = 0;
        const persister = createSessionPersister({
          store,
          governor: built.governor,
          handle: built.handle,
          attachEffectTurnAllocator: built.attachEffectTurnAllocator,
          attachDurabilityProbe: built.attachDurabilityProbe,
          sessionId: built.sessionId,
          agent: built.agent,
          context: built.context,
          now: () => Date.parse(iso),
          uuid: () => `new-${id++}`,
          initialSequenceNumber: built.nextSequenceNumber,
        });
        persister.start();
        try {
          persister.beginUserTurn('pending unique');
          await built.session.sendMessage('pending unique');
          const full = store.loadFull(record.id);
          if (full === undefined) throw new Error('missing persisted session');
          const markers = full.messages.filter((message) => message.compaction !== undefined);
          expect(markers).toHaveLength(refuse ? 0 : 1);
          if (!refuse) {
            expect(markers[0]?.compaction).toEqual({ droppedThroughSequence: 2 });
            // The legacy bare user precedes the latest proven turn, so it is folded as data.
            // The empty durable final remains in the archive but is omitted from the request projection.
            expect(
              requests.some(
                (request) =>
                  request.maxTokens === 4096 &&
                  request.messages.some((message) =>
                    message.content.some(
                      (part) => part.type === 'text' && part.text.includes('legacy retained'),
                    ),
                  ),
              ),
            ).toBe(true);
            expect(full.messages.find((message) => message.sequenceNumber === 4)?.content).toEqual([
              { type: 'text', text: '' },
            ]);
            const state = reconstructSessionState(full.session, full.messages);
            expect(state.compactionSummary && unwrapUntrusted(state.compactionSummary)).toBe(
              'native summary',
            );
            expect(state.messages.map((message) => message.content)).toEqual([
              [{ type: 'text', text: 'latest retained' }],
              [{ type: 'text', text: 'pending unique' }],
              [{ type: 'text', text: 'next final' }],
            ]);
          } else
            expect(
              full.messages.filter(
                (message) => message.role === 'user' || message.role === 'assistant',
              ),
            ).toHaveLength(7);
          expect(requests.filter((request) => request.maxTokens === 4096)).toHaveLength(2);
          expect(persister.durabilityFailure).toBeUndefined();
        } finally {
          built.session.cancel();
          persister.close();
        }
      } finally {
        client.sqlite.close();
      }
    });
});
