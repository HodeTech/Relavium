import { reconstructSessionState } from '@relavium/core';
import type { StreamChunk } from '@relavium/llm';
import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import type { DurableContentPart } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { createSessionPersister } from './persister.js';
import { buildChatSession } from './session-host.js';
import { scriptedResolver, stop, textTurn, unresolvedResolver } from './test-support.js';
import type { ProviderResolver } from '../engine/providers.js';

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
};

const textOf = (content: readonly DurableContentPart[]): string =>
  content.map((part) => (part.type === 'text' ? part.text : '')).join('');

describe('createSessionPersister', () => {
  let client: DbClient;
  let store: SessionStore;
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
  });

  function setup(providers: ProviderResolver) {
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    const now = () => tick++;
    let msgId = 0;
    const built = buildChatSession({
      chat: EMPTY_CHAT,
      agentRef: undefined,
      cwd: '/workspace',
      projectConfigDir: undefined,
      now,
      uuid: () => 'sess-1',
      providers,
    });
    const persister = createSessionPersister({
      store,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now,
      uuid: () => `msg-${msgId++}`,
    });
    return { built, persister };
  }

  it('persists the session row eagerly on start (auto-persisted from the moment it starts)', () => {
    const { persister } = setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    const full = store.loadFull('sess-1');
    expect(full).toBeDefined();
    expect(full?.session.status).toBe('active');
    expect(full?.session.agentSlug).toBe('relavium-chat');
    expect(full?.session.agentSnapshot?.model).toBe('claude-sonnet-4-6');
    expect(full?.messages).toHaveLength(0); // no turn yet
  });

  it('persists a completed turn as a user + text-only assistant pair, and folds the token totals', async () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi there')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('hello');
    await built.session.sendMessage('hello');

    const full = store.loadFull('sess-1');
    expect(full?.messages).toHaveLength(2);
    expect(full?.messages[0]?.role).toBe('user');
    expect(textOf(full?.messages[0]?.content ?? [])).toBe('hello');
    expect(full?.messages[1]?.role).toBe('assistant');
    expect(textOf(full?.messages[1]?.content ?? [])).toBe('hi there');
    // sequenceNumber is monotonic 0,1 across the turn.
    expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1]);
    // The scripted stop reports usage {input:10, output:5}; the persister folds it into the session totals.
    expect(full?.session.totalInputTokens).toBe(10);
    expect(full?.session.totalOutputTokens).toBe(5);
  });

  it('stores the post-tool answer as the assistant text, dropping a pre-tool preamble (mirrors result.text)', async () => {
    // A turn that streams a preamble, then calls a tool, then (turn 2) streams the final answer. The engine
    // keeps only the final result.text, so the persister must reset its accumulator on the tool call.
    const preToolTurn: StreamChunk[] = [
      { type: 'text_delta', text: 'let me check… ' },
      { type: 'tool_call_start', id: 'c1', name: 'read_file' },
      { type: 'tool_call_end', id: 'c1' },
      stop('tool_use'),
    ];
    const { built, persister } = setup(scriptedResolver([preToolTurn, textTurn('the answer')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');

    const full = store.loadFull('sess-1');
    expect(full?.messages).toHaveLength(2);
    expect(textOf(full?.messages[1]?.content ?? [])).toBe('the answer'); // NOT "let me check… the answer"
  });

  it('persists nothing for a failed turn (the engine rolls its user message back)', async () => {
    const { built, persister } = setup(unresolvedResolver()); // every turn fails `internal`
    persister.start();
    built.session.start();
    persister.beginUserTurn('hello');
    await built.session.sendMessage('hello');

    const full = store.loadFull('sess-1');
    expect(full?.messages).toHaveLength(0); // an error turn keeps the transcript to completed exchanges
    expect(full?.session.status).toBe('active');
  });

  it('marks the session ended on cancel (its sole terminal), leaving it resumable', () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    built.session.start();
    built.session.cancel();
    expect(store.loadFull('sess-1')?.session.status).toBe('ended');
  });

  it('produces a transcript reconstructSessionState round-trips into a resumable state', async () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi there')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('hello');
    await built.session.sendMessage('hello');

    const full = store.loadFull('sess-1');
    expect(full).toBeDefined();
    const state = reconstructSessionState(full!.session, full!.messages);
    // The text-only user+assistant pair reconstructs; one completed turn ⇒ turnCount 1.
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]);
    expect(state.turnCount).toBe(1);
  });
});
