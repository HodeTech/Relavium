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

  function setup(
    providers: ProviderResolver,
    initialSequenceNumber?: number,
    seeds?: { input?: number; output?: number; cost?: number },
  ) {
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
      ...(initialSequenceNumber === undefined ? {} : { initialSequenceNumber }),
      ...(seeds?.input === undefined ? {} : { initialTotalInputTokens: seeds.input }),
      ...(seeds?.output === undefined ? {} : { initialTotalOutputTokens: seeds.output }),
      ...(seeds?.cost === undefined ? {} : { initialTotalCostMicrocents: seeds.cost }),
    });
    return { built, persister };
  }

  it('persists the session row eagerly on start (auto-persisted from the moment it starts)', () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    const full = store.loadFull('sess-1');
    expect(full).toBeDefined();
    expect(full?.session.status).toBe('active');
    expect(full?.session.agentSlug).toBe('relavium-chat');
    // The full bound agent is frozen into agent_snapshot (for reproducible resume/export).
    expect(full?.session.agentSnapshot).toEqual(built.agent);
    expect(full?.messages).toHaveLength(0); // no turn yet
  });

  it('adopts an existing row on start instead of re-INSERTing (resume does not hit the UNIQUE pk)', () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi')]), 5);
    // Simulate the prior process: the session row already exists in history.db before this resume starts.
    store.createSession({
      id: built.sessionId,
      agentSlug: built.agent.id,
      agentSnapshot: built.agent,
      context: built.context,
      status: 'ended',
      totalInputTokens: 7,
      totalOutputTokens: 11,
      totalCostMicrocents: 1300,
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    });
    expect(() => persister.start()).not.toThrow(); // a re-INSERT would be a UNIQUE constraint failure
    const full = store.loadFull(built.sessionId);
    expect(full).toBeDefined();
    // The existing row is adopted untouched here — its persisted totals are NOT reset to the fresh record's 0
    // (chat-resume / 2.N seeds the persister from these before the first resumed turn).
    expect(full?.session.totalCostMicrocents).toBe(1300);
  });

  it('resumed persister folds new-turn tokens ON TOP of the seeded prior-session totals, not from zero', async () => {
    // Simulate 2.N resume: a row with prior totals already exists AND the persister is seeded from it.
    const { built, persister } = setup(scriptedResolver([textTurn('go')]), 5, {
      input: 100,
      output: 50,
    });
    store.createSession({
      id: built.sessionId,
      agentSlug: built.agent.id,
      agentSnapshot: built.agent,
      context: built.context,
      status: 'ended',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCostMicrocents: 1300,
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    });
    persister.start();
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');

    const full = store.loadFull(built.sessionId);
    // The scripted turn adds {input:10, output:5}; seeded 100/50 ⇒ 110/55, NOT 10/5 (the unseeded regression).
    expect(full?.session.totalInputTokens).toBe(110);
    expect(full?.session.totalOutputTokens).toBe(55);
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

  it('persists only the user row when a successful turn produces no assistant text', async () => {
    // A turn that emits only a stop chunk — zero text_delta, so result.text is empty; the assistantText.length
    // guard must skip the empty assistant row (mirroring the engine), leaving just the user row.
    const { built, persister } = setup(scriptedResolver([[stop('stop')]]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('hello');
    await built.session.sendMessage('hello');

    const full = store.loadFull('sess-1');
    expect(full?.messages).toHaveLength(1); // only the user row — no spurious empty assistant row
    expect(full?.messages[0]?.role).toBe('user');
    // The turn still engaged the provider, so its usage folds into the totals even with no text.
    expect(full?.session.totalInputTokens).toBe(10);
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
    // claude-sonnet-4-6 is priced, so a real turn produces a non-zero session cost the resume seeds from.
    expect(state.cumulativeCostMicrocents).toBeGreaterThan(0);
  });

  it('accumulates sequenceNumber and token totals across consecutive turns', async () => {
    const { built, persister } = setup(
      scriptedResolver([textTurn('reply 1'), textTurn('reply 2')]),
    );
    persister.start();
    built.session.start();
    persister.beginUserTurn('first');
    await built.session.sendMessage('first');
    persister.beginUserTurn('second');
    await built.session.sendMessage('second');

    const full = store.loadFull('sess-1');
    // sequenceNumber is continuous across turns; roles alternate user/assistant.
    expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1, 2, 3]);
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // {input:10, output:5} per turn × 2 completed turns folds into the session totals.
    expect(full?.session.totalInputTokens).toBe(20);
    expect(full?.session.totalOutputTokens).toBe(10);
    // The cost column is folded from cost:updated; claude-sonnet-4-6 is priced ⇒ a non-zero running total.
    expect(full?.session.totalCostMicrocents).toBeGreaterThan(0);
  });

  it('seeds the first sequenceNumber from initialSequenceNumber (the 2.N resume injection point)', async () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi')]), 5);
    persister.start();
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');
    // A resumed persister continues past the persisted MAX rather than colliding at 0.
    expect(store.loadFull('sess-1')?.messages.map((m) => m.sequenceNumber)).toEqual([5, 6]);
  });

  it('start() is idempotent — a second call neither duplicates the row nor double-subscribes', async () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    persister.start(); // a duplicate createSession would PK-violate; a double-subscribe would double-write
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');
    expect(store.loadFull('sess-1')?.messages).toHaveLength(2);
  });

  it('close() unsubscribes — turns after close are not persisted (the session stays in the db)', async () => {
    const { built, persister } = setup(scriptedResolver([textTurn('one'), textTurn('two')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('first');
    await built.session.sendMessage('first');
    expect(store.loadFull('sess-1')?.messages).toHaveLength(2);

    persister.close();
    persister.beginUserTurn('second');
    await built.session.sendMessage('second');
    expect(store.loadFull('sess-1')?.messages).toHaveLength(2); // unchanged — close() stopped persistence
  });

  it('flushes the running cost on a failed turn so a resumed budget governor sees the true spend', async () => {
    // Turn 1 succeeds and incurs a real (priced) cost; turn 2 is unscripted, so the provider throws and the
    // turn settles as an error. The d6b975b unconditional flush must keep the turn-1 cost durable (not 0).
    const { built, persister } = setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('first');
    await built.session.sendMessage('first');
    const afterSuccess = store.loadFull('sess-1')?.session.totalCostMicrocents ?? 0;
    expect(afterSuccess).toBeGreaterThan(0);

    persister.beginUserTurn('second');
    // The 2nd (unscripted) turn fails; whether it settles or rethrows, turn_completed flushes the row first.
    await built.session.sendMessage('second').catch(() => undefined);
    const after = store.loadFull('sess-1');
    expect(after?.session.totalCostMicrocents).toBe(afterSuccess); // cost did NOT regress to 0 on the error
    expect(after?.messages).toHaveLength(2); // the failed turn added no transcript rows
  });

  it('on cancel after a successful turn: status ended, totals retained, messages untouched', async () => {
    const { built, persister } = setup(scriptedResolver([textTurn('hi there')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('hello');
    await built.session.sendMessage('hello');
    const before = store.loadFull('sess-1');
    built.session.cancel();
    const after = store.loadFull('sess-1');

    expect(after?.session.status).toBe('ended');
    // The ended-flush carries the accumulated totals forward (live reads, not a start-time snapshot of 0).
    expect(after?.session.totalInputTokens).toBe(before?.session.totalInputTokens);
    expect(after?.session.totalCostMicrocents).toBe(before?.session.totalCostMicrocents);
    expect(after?.messages).toHaveLength(2); // cancel does not touch the transcript
  });
});
