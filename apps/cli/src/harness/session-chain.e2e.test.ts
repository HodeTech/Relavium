import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import type { LlmProvider, LlmRequest } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { exportSession } from '../chat/export.js';
import { cassetteResolver, type Cassette } from '../chat/fixture.js';
import { createSessionPersister } from '../chat/persister.js';
import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import { textTurn } from '../chat/test-support.js';
import type { ProviderResolver } from '../engine/providers.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';

/**
 * 2.5.I S4 — the Home → chat → resume → export CHAIN over a real file-backed `history.db`, the coverage the
 * 2.K regression harness (offline `run` fixtures only) does not carry. It proves a transcript survives the
 * whole journey a user takes: a fresh session graduated from the Home (`buildChatSession`, cassette-driven)
 * that persists a turn, a `chat-resume` on a FRESH connection to the same file (`loadFull` →
 * `buildResumedChatSession`) that continues it, and a `chat-export` (`exportSession`) that serializes it to a
 * `.relavium.yaml`. The interactive ink Home/chat surface itself is a TUI (out of scope without a render-test
 * dependency); this drives the exact session-host + persister + export seam the Home graduates into.
 */

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
    strictCostCap: false,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};

/** A one-turn cassette: the single `stream()` call replays the given assistant reply (the seam holds — all
 *  chunks are Relavium `StreamChunk`s). A fresh + a resumed build each get their OWN cassette (own call counter). */
const oneTurnCassette = (reply: string): Cassette => ({
  schema_version: '1.0',
  provider: 'anthropic',
  calls: [textTurn(reply)],
});

/**
 * A resolver that RECORDS each `stream()` request (unlike the cassette, which ignores it) and replays `reply` —
 * used for the resumed turn so the test can prove `reconstructSessionState` threaded the PRIOR transcript into
 * the next turn's provider request, not just that the DB rows accumulated.
 */
function capturingResolver(reply: string): { resolver: ProviderResolver; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: () => {
      throw new Error('capturingResolver.generate is not used (the session path streams)');
    },
    stream: (req) => {
      requests.push(req);
      return (async function* () {
        await Promise.resolve();
        for (const chunk of textTurn(reply)) yield chunk;
      })();
    },
  };
  return {
    resolver: {
      resolveProvider: (id) => (id === 'anthropic' ? provider : undefined),
      keyFor: () => 'test-key',
    },
    requests,
  };
}

const SESSION_ID = 'sess-chain';

describe('session chain e2e (2.5.I S4) — Home→chat→resume→export over a real history.db', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-session-chain-'));
    dbPath = join(dir, 'history.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Open a fresh connection + a migrated session store on the shared file (each "process" gets its own). */
  function openStore(): { client: DbClient; store: SessionStore } {
    const client = createClient(dbPath);
    runMigrations(client.db); // idempotent — mirrors migrate-on-open
    return { client, store: createSessionStore(client.db) };
  }

  it('a transcript survives fresh-chat → persist → resume → continue → export', async () => {
    let tick = Date.parse('2026-07-07T00:00:00.000Z');
    const now = (): number => tick++;
    let msgSeq = 0;
    const uuidMsg = (): string => `m-${msgSeq++}`;

    // 1. FRESH session (the Home graduating into chat), cassette-driven, on connection #1.
    const first = openStore();
    try {
      const built = await buildChatSession({
        chat: EMPTY_CHAT,
        agentRef: undefined,
        cwd: dir,
        projectConfigDir: undefined,
        now,
        uuid: () => SESSION_ID,
        providers: cassetteResolver(oneTurnCassette('reply from the fresh session')),
        disableMcp: true, // fully offline: the default agent declares no mcp_servers, so make the intent explicit
      });
      const persister = createSessionPersister({
        store: first.store,
        handle: built.handle,
        sessionId: built.sessionId,
        agent: built.agent,
        context: built.context,
        now,
        uuid: uuidMsg,
      });
      persister.start();
      built.session.start(); // a fresh session must be started before its first turn (the resumed one lands idle)
      persister.beginUserTurn('first user message'); // record the user text for the in-flight turn (as the REPL does)
      await built.session.sendMessage('first user message');
      persister.close();
    } finally {
      first.client.sqlite.close(); // the chat process exits
    }

    // 2. RESUME on a FRESH connection (a separate `chat-resume` process reopening the file).
    const second = openStore();
    try {
      const loaded = second.store.loadFull(SESSION_ID);
      if (loaded === undefined) {
        throw new Error('expected the fresh session to have persisted before resume');
      }
      // The fresh turn persisted a user + an assistant message, with usage/cost recorded.
      expect(loaded.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const freshInput = loaded.session.totalInputTokens;
      const freshOutput = loaded.session.totalOutputTokens;
      const freshCost = loaded.session.totalCostMicrocents;
      // The fresh turn recorded real usage on every axis, so the doubling below has teeth on all three (a 0
      // would make `2 × 0 === 0` pass trivially and silently lose the accumulation guarantee).
      expect(freshInput).toBeGreaterThan(0);
      expect(freshOutput).toBeGreaterThan(0);
      expect(freshCost).toBeGreaterThan(0);

      const capture = capturingResolver('reply from the resumed session');
      const resumed = await buildResumedChatSession({
        chat: EMPTY_CHAT,
        record: loaded.session,
        messages: loaded.messages,
        now,
        providers: capture.resolver,
      });
      expect(resumed.sessionId).toBe(SESSION_ID); // resume continues the SAME session, never a fresh one
      const persister = createSessionPersister({
        store: second.store,
        handle: resumed.handle,
        sessionId: resumed.sessionId,
        agent: resumed.agent,
        context: resumed.context,
        now,
        uuid: uuidMsg,
        initialSequenceNumber: resumed.nextSequenceNumber, // continue PAST the persisted max seq
      });
      persister.start();
      persister.beginUserTurn('second user message');
      await resumed.session.sendMessage('second user message');
      persister.close();

      // The resumed turn's provider request carried the reconstructed PRIOR transcript into the model's context
      // (the defining behavior of resume) — not merely appended DB rows. Assert the exact role + order + text of
      // the reconstructed history followed by the new user turn, so a scrambled/duplicated/mis-tagged
      // reconstruction (which a substring check would miss) fails here.
      expect(capture.requests).toHaveLength(1); // exactly one provider call drove the resumed turn
      const resumedRequest = capture.requests[0];
      expect(resumedRequest?.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'first user message' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply from the fresh session' }] },
        { role: 'user', content: [{ type: 'text', text: 'second user message' }] },
      ]);

      // The full chain persisted, in order, gap-free: two complete turns.
      const full = second.store.loadFull(SESSION_ID);
      if (full === undefined) {
        throw new Error('expected the resumed session to still exist after the second turn');
      }
      expect(full.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(full.messages.map((m) => m.sequenceNumber)).toEqual([0, 1, 2, 3]);
      // Resume ADOPTED the fresh turn's totals and ACCUMULATED an identical turn → exact double (a resume that
      // failed to seed the prior totals would reset the row, and this would be 1×, not 2×).
      expect(full.session.totalInputTokens).toBe(2 * freshInput);
      expect(full.session.totalOutputTokens).toBe(2 * freshOutput);
      expect(full.session.totalCostMicrocents).toBe(2 * freshCost);

      // 3. EXPORT → a share-safe `.relavium.yaml`; both turns (user + the replayed assistant reply) survive.
      const result = exportSession({
        store: second.store,
        sessionId: SESSION_ID,
        cwd: dir,
        force: false,
      });
      const yaml = readFileSync(result.path, 'utf8');
      expect(yaml).toContain('first user message');
      expect(yaml).toContain('reply from the fresh session');
      expect(yaml).toContain('second user message');
      expect(yaml).toContain('reply from the resumed session');
    } finally {
      second.client.sqlite.close();
    }
  });
});
