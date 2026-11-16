/**
 * ADR-0133 end to end, on the real pieces: a live chat session with the real persister writing to a real (in-memory)
 * database, a `loadFull`, and a resumed session built from those rows. What the person was asked and how they answered must
 * (1) land in the stored tool row, (2) reach the model on the very next live turn AND on the first turn after a resume — with
 * the request text byte-identical in both — and (3) read back in the restored transcript.
 *
 * The engine-level carry (`turn-receipts`, `session-ask-user`) and the transcript builder are pinned in their own files; this
 * one pins that the persister's rows are what the resume path reads, which none of those can see.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AskUserAnswer, AskUserDelegate } from '@relavium/core';
import {
  createClient,
  createEffectJournalPort,
  createEffectJournalStore,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderResolver } from '../engine/providers.js';
import type { ResolvedChatConfig } from '../config/resolve.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { createSessionPersister } from './persister.js';
import { restoreSessionTranscript } from './restored-transcript.js';
import { buildChatSession, buildResumedChatSession } from './session-host.js';
import { stop, textTurn } from './test-support.js';

const CHAT: ResolvedChatConfig = {
  defaultMode: 'ask',
  defaultModeSource: 'fallback',
  defaultModel: undefined,
  defaultProvider: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  maxTokens: undefined,
  onExceed: undefined,
  strictCostCap: false,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};

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

const askTurn = (id: string, args: unknown = QUESTION): StreamChunk[] => [
  { type: 'tool_call_start', id, name: 'ask_user' },
  { type: 'tool_call_delta', id, argsJsonDelta: JSON.stringify(args) },
  { type: 'tool_call_end', id },
  stop('tool_use'),
];

const now = (): number => Date.parse('2026-11-16T00:00:00.000Z');

function capturing(scripts: StreamChunk[][], requests: LlmRequest[]): ProviderResolver {
  let call = 0;
  const provider: LlmProvider = {
    id: 'anthropic',
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: () => {
      throw new Error('unused');
    },
    stream: (request) => {
      requests.push(structuredClone(request));
      const chunks = scripts[call++] ?? [];
      return (async function* () {
        await Promise.resolve();
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
  return {
    resolveProvider: (id) => (id === 'anthropic' ? provider : undefined),
    keyFor: () => 'test-key',
  };
}

/** The text of every user-role part of a request: where the receipt block and the notice ride. */
const userTexts = (request: LlmRequest | undefined): string[] =>
  (request?.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []));

describe('an ask_user question and its answer survive a resume (ADR-0133)', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  let store: ReturnType<typeof createSessionStore>;
  let ordinal: number;
  const uuid = (): string => `ask-resume-${String(++ordinal)}`;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-ask-resume-work-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-ask-resume-home-')));
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
    ordinal = 0;
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function attach(
    built: Awaited<ReturnType<typeof buildChatSession>>,
    initialSequenceNumber?: number,
  ) {
    const journal = createEffectJournalStore(client.db, { now, uuid });
    built.attachEffectJournal((correlation) =>
      createEffectJournalPort(journal, correlation, { providerAttempt: 0, toolCallId: 'wiring' }),
    );
    const persister = createSessionPersister({
      usageStore: createSessionUsageStore(client.db),
      mode: initialSequenceNumber === undefined ? 'fresh' : 'adopt',
      attachUsageWriter: built.attachUsageWriter,
      store,
      governor: built.governor,
      attachDurabilityProbe: built.attachDurabilityProbe,
      attachEffectTurnAllocator: built.attachEffectTurnAllocator,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now,
      uuid,
      ...(initialSequenceNumber === undefined ? {} : { initialSequenceNumber }),
    });
    persister.start();
    if (initialSequenceNumber === undefined) built.session.start();
    return persister;
  }

  const answers =
    (answer: AskUserAnswer): AskUserDelegate =>
    () =>
      Promise.resolve(answer);

  async function liveSession(
    scripts: StreamChunk[][],
    requests: LlmRequest[],
    ask: AskUserDelegate,
  ) {
    const built = await buildChatSession({
      chat: CHAT,
      agentRef: undefined,
      cwd,
      projectConfigDir: undefined,
      now,
      uuid: () => 'ask-resume-session',
      providers: capturing(scripts, requests),
      onListenerError: () => undefined,
      consentGate: () => Promise.resolve(new Map()),
      disableMcp: true,
      operatorHomeDir: home,
      askUser: ask,
    });
    return { built, persister: attach(built) };
  }

  async function resumed(scripts: StreamChunk[][], requests: LlmRequest[], ask: AskUserDelegate) {
    const full = store.loadFull('ask-resume-session');
    if (full === undefined) throw new Error('the session was not persisted');
    const built = await buildResumedChatSession({
      chat: CHAT,
      record: full.session,
      messages: full.messages,
      now,
      providers: capturing(scripts, requests),
      onListenerError: () => undefined,
      consentGate: () => Promise.resolve(new Map()),
      operatorHomeDir: home,
      askUser: ask,
    });
    return { built, persister: attach(built, built.nextSequenceNumber), full };
  }

  async function say(
    session: {
      built: { session: { sendMessage: (text: string) => Promise<unknown> } };
      persister: { beginUserTurn: (text: string) => void };
    },
    text: string,
  ): Promise<void> {
    session.persister.beginUserTurn(text);
    await session.built.session.sendMessage(text);
  }

  it('stores the question and the answer in the tool row, and nowhere else', async () => {
    const requests: LlmRequest[] = [];
    const live = await liveSession(
      [askTurn('c1'), textTurn('I will use beta.ts')],
      requests,
      answers({ kind: 'answered', answers: [{ selected: ['beta.ts'] }] }),
    );
    await say(live, 'which file should I use?');
    live.persister.close();
    live.built.session.cancel();

    const rows = store.loadFull('ask-resume-session')?.messages ?? [];
    const toolRows = rows.filter((row) => row.role === 'tool');
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        outcome: 'ok',
        ask: {
          status: 'answered',
          items: [{ header: 'Pick', question: 'Which file?', selected: ['beta.ts'] }],
        },
      }),
    ]);
    // The call row keeps the structure only (no arguments), exactly as before.
    const callRows = rows.filter(
      (row) => row.role === 'assistant' && row.content.some((part) => part.type === 'tool_call'),
    );
    expect(JSON.stringify(callRows)).not.toContain('Which file?');
    // The option's description was never recorded: only what the card showed as a question and what was chosen.
    expect(JSON.stringify(rows)).not.toContain('The second file');
  });

  // Scoped on purpose: ADR-0128 makes a turn with no tool rows AMBIGUOUS after a resume (no completeness marker exists), so a
  // conversation that also holds a text-only turn adds one fixed notice to the resumed request and not to the live one. The
  // claim pinned here is about the ask_user note: with no text-only turn in the history the two requests are the same bytes.
  it('is byte-identical to the live request for a conversation with no text-only turn', async () => {
    // One conversation, persisted after its first exchange; the live request for the second exchange is captured BEFORE
    // that second exchange is persisted, and the resumed request is built from the rows of the first exchange only.
    const liveRequests: LlmRequest[] = [];
    const live = await liveSession(
      [askTurn('c1'), textTurn('I will use beta.ts'), textTurn('next')],
      liveRequests,
      answers({ kind: 'answered', answers: [{ selected: ['beta.ts'] }] }),
    );
    await say(live, 'which file should I use?');
    const persisted = store.loadFull('ask-resume-session');
    expect(persisted?.messages.length).toBeGreaterThan(0);
    await say(live, 'act on my answer');
    const liveSecond = liveRequests.at(-1);
    live.persister.close();
    live.built.session.cancel();

    // Rebuild from the rows of the FIRST exchange alone.
    const firstExchange = persisted?.messages ?? [];
    const resumedRequests: LlmRequest[] = [];
    const built = await buildResumedChatSession({
      chat: CHAT,
      record:
        persisted?.session ??
        (() => {
          throw new Error('no session');
        })(),
      messages: firstExchange,
      now,
      providers: capturing([textTurn('next')], resumedRequests),
      onListenerError: () => undefined,
      consentGate: () => Promise.resolve(new Map()),
      operatorHomeDir: home,
      askUser: answers({ kind: 'skipped' }),
    });
    const persister = attach(built, built.nextSequenceNumber);
    await say({ built, persister }, 'act on my answer');
    persister.close();
    built.session.cancel();
    // The equality is not vacuous: BOTH requests carry the answered note, so dropping it on either path would show.
    const note = 'answered: "Pick" — "Which file?" → chose "beta.ts"';
    expect(userTexts(liveSecond).join('\n')).toContain(note);
    expect(userTexts(resumedRequests.at(-1)).join('\n')).toContain(note);
    expect(resumedRequests.at(-1)?.messages).toEqual(liveSecond?.messages);
  });

  it('carries a skipped question the same way, by its header only', async () => {
    const requests: LlmRequest[] = [];
    const live = await liveSession(
      [askTurn('c1'), textTurn('ok, my call'), textTurn('next')],
      requests,
      answers({ kind: 'skipped' }),
    );
    await say(live, 'pick one for me');
    live.persister.close();
    live.built.session.cancel();
    const resumedRequests: LlmRequest[] = [];
    const next = await resumed([textTurn('next')], resumedRequests, answers({ kind: 'skipped' }));
    await say(next, 'and now?');
    const resumedText = userTexts(resumedRequests.at(-1)).join('\n');
    expect(resumedText).toContain('   skipped: "Pick"\n');
    expect(resumedText).not.toContain('"Which file?"');
    next.persister.close();
    next.built.session.cancel();
  });

  it("shows the restored transcript the card's entry, rebuilt from the stored record", async () => {
    const requests: LlmRequest[] = [];
    const live = await liveSession(
      [askTurn('c1'), textTurn('I will use beta.ts')],
      requests,
      answers({ kind: 'answered', answers: [{ selected: ['beta.ts'] }] }),
    );
    await say(live, 'which file should I use?');
    live.persister.close();
    live.built.session.cancel();
    const entries = restoreSessionTranscript({
      messages: store.loadFull('ask-resume-session')?.messages ?? [],
      memory: undefined,
      transcriptBound: FULLSCREEN_TRANSCRIPT_BOUND,
      readDisplay: () => new Map(),
    });
    expect(entries.map((entry) => entry.text)).toContain(
      '› Asked: Pick — Which file?\n  └ beta.ts',
    );
  });
});
