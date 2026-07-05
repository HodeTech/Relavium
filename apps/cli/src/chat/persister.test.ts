import { reconstructSessionState } from '@relavium/core';
import type { StreamChunk } from '@relavium/llm';
import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import type { AgentSessionRecord, DurableContentPart, SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { buildDefaultChatAgent } from './default-agent.js';
import { createSessionPersister } from './persister.js';
import { buildChatSession, buildResumedChatSession } from './session-host.js';
import { scriptedResolver, stop, textTurn, unresolvedResolver } from './test-support.js';
import type { ProviderResolver } from '../engine/providers.js';

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
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

  async function setup(providers: ProviderResolver, initialSequenceNumber?: number) {
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    const now = () => tick++;
    let msgId = 0;
    const built = await buildChatSession({
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
    });
    return { built, persister };
  }

  it('persists the session row eagerly on start (auto-persisted from the moment it starts)', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    const full = store.loadFull('sess-1');
    expect(full).toBeDefined();
    expect(full?.session.status).toBe('active');
    expect(full?.session.agentSlug).toBe('relavium-chat');
    // The full bound agent is frozen into agent_snapshot (for reproducible resume/export).
    expect(full?.session.agentSnapshot).toEqual(built.agent);
    expect(full?.messages).toHaveLength(0); // no turn yet
  });

  it('adopts an existing row on start instead of re-INSERTing (resume does not hit the UNIQUE pk)', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('hi')]), 5);
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
    // The existing row is adopted untouched here — start() hydrates the persister's running totals from it
    // (not reset to the fresh record's 0), so the next turn flushes prior+new rather than just the delta.
    expect(full?.session.totalCostMicrocents).toBe(1300);
  });

  it('resumed persister folds new-turn tokens ON TOP of the adopted row totals, not from zero', async () => {
    // Simulate 2.N resume: a row with prior totals already exists; start() adopts it and hydrates the totals.
    const { built, persister } = await setup(scriptedResolver([textTurn('go')]), 5);
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
    // The scripted turn adds {input:10, output:5}; hydrated 100/50 ⇒ 110/55, NOT 10/5 (the un-hydrated regression).
    expect(full?.session.totalInputTokens).toBe(110);
    expect(full?.session.totalOutputTokens).toBe(55);
  });

  it('resumed persister carries the adopted-row cost through a zero-egress turn (no cost:updated ⇒ it survives)', async () => {
    // A turn with no provider egress emits NO cost:updated, so the cost flush relies entirely on the hydrated
    // total. unresolvedResolver fails the turn `internal` before any egress; the prior row cost (1300) must
    // survive — without start()'s hydration the unconditional flush would reset it to 0.
    const { built, persister } = await setup(unresolvedResolver(), 5);
    store.createSession({
      id: built.sessionId,
      agentSlug: built.agent.id,
      agentSnapshot: built.agent,
      context: built.context,
      status: 'ended',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 1300,
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    });
    persister.start();
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go'); // fails internal — no provider egress, so no cost:updated fires

    const full = store.loadFull(built.sessionId);
    expect(full?.session.totalCostMicrocents).toBe(1300); // the hydrated cost survived (would be 0 without it)
  });

  it('persists a completed turn as a user + text-only assistant pair, and folds the token totals', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('hi there')]));
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

  it('derives the session title from the FIRST user message, and a later message does not overwrite it', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('a'), textTurn('b')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('Plan the launch for next week');
    await built.session.sendMessage('Plan the launch for next week');
    persister.beginUserTurn('and a follow-up question');
    await built.session.sendMessage('and a follow-up question');

    // The title is the (trimmed, ~40-char) FIRST message — the second turn must not re-title the session.
    expect(store.loadFull('sess-1')?.session.title).toBe('Plan the launch for next week');
  });

  it('persists only the user row when a successful turn produces no assistant text', async () => {
    // A turn that emits only a stop chunk — zero text_delta, so result.text is empty; the assistantText.length
    // guard must skip the empty assistant row (mirroring the engine), leaving just the user row.
    const { built, persister } = await setup(scriptedResolver([[stop('stop')]]));
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
    const { built, persister } = await setup(
      scriptedResolver([preToolTurn, textTurn('the answer')]),
    );
    persister.start();
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');

    const full = store.loadFull('sess-1');
    expect(full?.messages).toHaveLength(2);
    expect(textOf(full?.messages[1]?.content ?? [])).toBe('the answer'); // NOT "let me check… the answer"
  });

  it('persists nothing for a failed turn (the engine rolls its user message back)', async () => {
    const { built, persister } = await setup(unresolvedResolver()); // every turn fails `internal`
    persister.start();
    built.session.start();
    persister.beginUserTurn('hello');
    await built.session.sendMessage('hello');

    const full = store.loadFull('sess-1');
    expect(full?.messages).toHaveLength(0); // an error turn keeps the transcript to completed exchanges
    expect(full?.session.status).toBe('active');
  });

  it('persists NO messages for a mid-turn ABORTED turn (EA7), then the next turn persists cleanly', async () => {
    // An aborted turn (stopReason:'aborted', error:undefined — ADR-0057) is rolled back by the engine just
    // like an error turn, so the persister must NOT write its rows: gating only on `error === undefined`
    // would orphan the user message in history.db (no in-memory counterpart on chat-resume).
    const { built, persister } = await setup(scriptedResolver([textTurn('kept-reply')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('abort me');
    const p = built.session.sendMessage('abort me');
    built.session.abort(); // mid-turn abort (pre-egress → the turn settles 'aborted', no provider script used)
    await p;
    expect(store.loadFull('sess-1')?.messages).toHaveLength(0); // the aborted turn left no rows

    // pendingUserText was reset by the aborted turn, so the next successful turn persists cleanly.
    persister.beginUserTurn('kept');
    await built.session.sendMessage('kept');
    const full = store.loadFull('sess-1');
    expect(full?.messages).toHaveLength(2); // ONLY the kept turn's user + assistant
    expect(textOf(full?.messages[0]?.content ?? [])).toBe('kept'); // user
    expect(textOf(full?.messages[1]?.content ?? [])).toBe('kept-reply'); // assistant (the first script)
    // The title is derived from the first COMPLETED exchange, never the aborted prompt ('abort me') whose rows
    // were rolled back — so a session's label always has a transcript behind it.
    expect(full?.session.title).toBe('kept');
  });

  it('marks the session ended on cancel (its sole terminal), leaving it resumable', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    built.session.start();
    built.session.cancel();
    expect(store.loadFull('sess-1')?.session.status).toBe('ended');
  });

  it('produces a transcript reconstructSessionState round-trips into a resumable state', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('hi there')]));
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
    const { built, persister } = await setup(
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
    const { built, persister } = await setup(scriptedResolver([textTurn('hi')]), 5);
    persister.start();
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');
    // A resumed persister continues past the persisted MAX rather than colliding at 0.
    expect(store.loadFull('sess-1')?.messages.map((m) => m.sequenceNumber)).toEqual([5, 6]);
  });

  it('start() is idempotent — a second call neither duplicates the row nor double-subscribes', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('hi')]));
    persister.start();
    persister.start(); // a duplicate createSession would PK-violate; a double-subscribe would double-write
    built.session.start();
    persister.beginUserTurn('go');
    await built.session.sendMessage('go');
    expect(store.loadFull('sess-1')?.messages).toHaveLength(2);
  });

  it('close() unsubscribes — turns after close are not persisted (the session stays in the db)', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('one'), textTurn('two')]));
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
    const { built, persister } = await setup(scriptedResolver([textTurn('hi')]));
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
    const { built, persister } = await setup(scriptedResolver([textTurn('hi there')]));
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

  it('on /compact: writes a role-filtered boundary marker + resume honors it (ADR-0062)', async () => {
    // 2 turns → durable rows seq 0..3 (u0,a1,u2,a3). A compact keeping the last exchange (kept=2) must map to
    // droppedThroughSequence=1 (drop seq 0,1; keep 2,3) — the ROLE-FILTERED mapping, not raw arithmetic.
    const { built, persister } = await setup(
      scriptedResolver([textTurn('a1'), textTurn('a2'), textTurn('the summary text')]),
    );
    persister.start();
    built.session.start();
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    persister.beginUserTurn('q2');
    await built.session.sendMessage('q2');

    const result = await built.session.compact('manual');
    expect(result.kind).toBe('compacted');

    const messages = store.loadMessages('sess-1');
    const marker = messages.find((m) => m.role === 'system');
    expect(marker?.compaction).toEqual({ droppedThroughSequence: 1 });
    expect(marker?.content).toEqual([{ type: 'text', text: 'the summary text' }]);
    // The full transcript is preserved (append-only — nothing deleted): 4 real rows + 1 marker.
    expect(messages).toHaveLength(5);

    // Resume honors the marker: only the kept exchange survives, with the summary as the preamble.
    const full = store.loadFull('sess-1');
    const state = reconstructSessionState(full!.session, full!.messages);
    expect(state.contextPreamble).toBe('the summary text');
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ]);
  });

  it('resume→/compact maps the boundary over the ENGINE projection, not the raw rows (ADR-0062 step-3 fix)', async () => {
    // A prior process left a durable transcript ENDING on a dangling `user` (an empty-text turn): u0,a1,u2,a3,u4.
    const agent = buildDefaultChatAgent('claude-sonnet-4-6');
    const iso = '2026-06-25T00:00:00.000Z';
    const rec: AgentSessionRecord = {
      id: 'sess-r',
      agentSlug: agent.id,
      agentSnapshot: agent,
      context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
      status: 'ended',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      createdAt: iso,
      updatedAt: iso,
    };
    const row = (seq: number, role: 'user' | 'assistant', text: string): SessionMessage => ({
      id: `m${seq}`,
      sessionId: 'sess-r',
      sequenceNumber: seq,
      role,
      content: [{ type: 'text', text }],
      timestamp: iso,
    });
    const messages = [
      row(0, 'user', 'q0'),
      row(1, 'assistant', 'a1'),
      row(2, 'user', 'q2'),
      row(3, 'assistant', 'a3'),
      row(4, 'user', 'unanswered'), // a dangling user (empty-text turn) the engine rolls back on resume
    ];
    store.createSession(rec);
    for (const m of messages) store.appendMessage(m);

    // Resume: the engine's #messages = [u0,a1,u2,a3] (u4 rolled back). A second persister adopts + seeds its
    // boundary-mapping from the SAME projection (excluding u4).
    const built = await buildResumedChatSession({
      chat: EMPTY_CHAT,
      record: rec,
      messages,
      now: () => Date.parse(iso),
      providers: scriptedResolver([textTurn('the summary')]),
    });
    let mid = 100;
    const persister = createSessionPersister({
      store,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now: () => Date.parse(iso),
      uuid: () => `mk-${mid++}`,
      initialSequenceNumber: built.nextSequenceNumber,
    });
    persister.start();

    const result = await built.session.compact('manual'); // keeps the last exchange [u2,a3]
    expect(result.kind).toBe('compacted');
    const marker = store.loadMessages('sess-r').find((m) => m.role === 'system');
    // Boundary = the last DROPPED real row = seq 1 (drop u0,a1; keep u2,a3). A bare ROLE-filter seed would count
    // the rolled-back u4 and produce seq 2 — silently dropping u2, the exact data-loss the step-3 fix prevents.
    expect(marker?.compaction).toEqual({ droppedThroughSequence: 1 });
  });

  it('on /trim: writes a summary-less boundary marker (no cost, ADR-0062)', async () => {
    const { built, persister } = await setup(scriptedResolver([textTurn('a1'), textTurn('a2')]));
    persister.start();
    built.session.start();
    persister.beginUserTurn('q1');
    await built.session.sendMessage('q1');
    persister.beginUserTurn('q2');
    await built.session.sendMessage('q2');

    const result = built.session.trimHistory(2); // keep the last exchange
    expect(result.kind).toBe('trimmed');
    const marker = store.loadMessages('sess-1').find((m) => m.role === 'system');
    expect(marker?.compaction).toEqual({ droppedThroughSequence: 1 });
    expect(marker?.content).toEqual([]); // a trim marker carries NO summary
  });
});
