import { reconstructSessionState } from '@relavium/core';
import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
} from '@relavium/db';
import type { LlmProvider, LlmRequest } from '@relavium/llm';
import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { buildDefaultChatAgent, DEFAULT_CHAT_MODEL } from './default-agent.js';
import { createSessionPersister, type SessionPersister } from './persister.js';
import { restoreSessionTranscript } from './restored-transcript.js';
import { buildResumedChatSession, type BuiltResumedChatSession } from './session-host.js';
import { scriptedProvider, textTurn } from './test-support.js';

const timestamp = '2026-11-10T00:00:00.000Z';
const row = (
  sequenceNumber: number,
  role: SessionMessage['role'],
  text: string,
): SessionMessage => ({
  id: `m${sequenceNumber}`,
  sessionId: 's',
  sequenceNumber,
  role,
  content: [{ type: 'text', text }],
  timestamp,
});

describe('restored archive and actual authored model request', () => {
  it.each([
    undefined,
    { type: 'none' },
    { type: 'window', window_size: 1 },
    { type: 'summary' },
  ] as const)(
    'preserves canonical policy selection and adjacent-role folding (%j)',
    async (memory) => {
      const client = createClient(':memory:');
      let built: BuiltResumedChatSession | undefined;
      let persister: SessionPersister | undefined;
      try {
        runMigrations(client.db);
        const store = createSessionStore(client.db);
        const record: AgentSessionRecord = {
          id: 's',
          agentSlug: 'chat',
          agentSnapshot: {
            ...buildDefaultChatAgent(DEFAULT_CHAT_MODEL),
            ...(memory === undefined ? {} : { memory }),
          },
          context: { workingDir: '/workspace', fsScopeTier: 'project' },
          status: 'active',
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostMicrocents: 0,
          totalConservativeMicrocents: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const messages = [
          row(0, 'user', 'CANONICAL archived'),
          row(1, 'assistant', 'archived answer'),
          row(2, 'user', 'CANONICAL empty-final'),
          row(3, 'assistant', ''),
          { ...row(4, 'system', 'PRIVATE SUMMARY'), compaction: { droppedThroughSequence: 1 } },
          row(5, 'user', 'CANONICAL latest'),
          row(6, 'assistant', 'latest answer'),
        ];
        store.createSession(record);
        store.writeTurn({
          messages: messages.map((message) => ({
            message,
            ...(message.role === 'user'
              ? { meta: { userDisplayText: `DISPLAY CHIP ${message.sequenceNumber}` } }
              : {}),
          })),
        });
        const requests: LlmRequest[] = [];
        const scripted = scriptedProvider([textTurn('next answer')]);
        const provider: LlmProvider = {
          ...scripted,
          stream: (request, key, options) => {
            requests.push(request);
            return scripted.stream(request, key, options);
          },
        };
        const visible = restoreSessionTranscript({
          messages: store.loadMessages('s'),
          memory,
          transcriptBound: FULLSCREEN_TRANSCRIPT_BOUND,
          readDisplay: (sequences) => store.loadUserDisplayTexts('s', sequences),
        });
        expect(JSON.stringify(visible)).not.toContain('CANONICAL');
        expect(JSON.stringify(visible)).not.toContain('PRIVATE SUMMARY');
        expect(visible.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual(
          ['DISPLAY CHIP 0', 'DISPLAY CHIP 2', 'DISPLAY CHIP 5'],
        );
        expect(requests).toEqual([]);
        expect(store.loadMessages('s')).toEqual(messages);
        const rawRestore = reconstructSessionState(record, messages);
        expect(rawRestore.completedTurnSpans).toEqual([
          { start: 0, end: 1 },
          { start: 1, end: 3 },
        ]);
        built = await buildResumedChatSession({
          now: () => Date.parse(timestamp),
          record,
          messages,
          chat: resolveConfig({}).chat,
          providers: { resolveProvider: () => provider, keyFor: () => 'offline-test-key' },
        });
        let id = 0;
        persister = createSessionPersister({
          usageStore: createSessionUsageStore(client.db),
          mode: 'adopt',
          attachUsageWriter: built.attachUsageWriter,
          governor: built.governor,
          store,
          handle: built.handle,
          attachEffectTurnAllocator: built.attachEffectTurnAllocator,
          attachDurabilityProbe: built.attachDurabilityProbe,
          sessionId: 's',
          agent: built.agent,
          context: built.context,
          now: () => Date.parse(timestamp),
          uuid: () => `new-${id++}`,
          initialSequenceNumber: built.nextSequenceNumber,
        });
        persister.start();
        expect(persister.hasSavedTurns).toBe(true);
        expect(requests).toEqual([]);
        persister.beginUserTurn('CURRENT pending', 'CURRENT pending');
        await built.session.sendMessage('CURRENT pending');
        expect(requests).toHaveLength(1);
        const request = requests[0];
        if (request === undefined) throw new Error('expected an actual offline request');
        const sent = JSON.stringify(request.messages);
        expect(sent).toContain('CURRENT pending');
        expect(sent).not.toContain('DISPLAY CHIP');
        expect(sent).not.toContain('CANONICAL archived');
        expect(sent.includes('CANONICAL latest')).toBe(memory?.type !== 'none');
        expect(sent.includes('CANONICAL empty-final')).toBe(
          memory?.type !== 'none' && memory?.type !== 'window',
        );
        expect(sent.includes('PRIVATE SUMMARY')).toBe(
          memory?.type !== 'none' && memory?.type !== 'window',
        );
        expect(
          request.messages.every(
            (message, index) => index === 0 || request.messages[index - 1]?.role !== message.role,
          ),
        ).toBe(true);
        expect(store.loadMessages('s').slice(0, messages.length)).toEqual(messages);
      } finally {
        built?.session.cancel();
        await built?.whenHostSafeToClose();
        persister?.close();
        client.sqlite.close();
      }
    },
  );
});
