import type { PreEgressInfo } from '@relavium/core';
import { prepareOutputCapPlan } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { createInMemoryEffectJournal } from '@relavium/core';

import { buildChatSession as buildFreshSession, buildGovernorWiring } from './session-host.js';
import { collectSubscribedSessionEvents, scriptedResolver, textTurn } from './test-support.js';

// The same unit host `session-host.test.ts` builds over: an explicit reference allocator, an in-memory journal and a usage writer, so a turn runs.
async function buildChatSession(opts: Parameters<typeof buildFreshSession>[0]) {
  const built = await buildFreshSession(opts);
  let key = 0;
  built.attachEffectTurnAllocator(() => ++key);
  let invocationOrdinal = 0;
  built.attachUsageWriter({
    initialCoverage: () => ({
      coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
      models: [],
      started: true,
      highWater: 0,
    }),
    begin: (draft) =>
      Promise.resolve(
        Object.freeze({
          producerId: 'unit-host',
          ordinal: ++invocationOrdinal,
          dispatchId: draft.nodeId,
          round: draft.round,
          chainAttempt: draft.chainAttempt,
        }),
      ),
    disposition: () => undefined,
    record: () => undefined,
  });
  built.attachEffectJournal((correlation) => createInMemoryEffectJournal(correlation));
  return { ...built, recordedEvents: collectSubscribedSessionEvents(built.handle) };
}

/**
 * Where the notices the session host composes are READ (MVP-11 Step 2 review, C6). They were hard-wired to the TUI wording, so a scripted
 * `agent run` and a plain or `--json` chat printed `Open /models and press Ctrl+R…` and `Add one from the Home with /pricing`, remedies a
 * script has no way to follow. The host now takes a `noticeSurface` and defaults to the scripted wording; only the interactive chat and the
 * Home say `tui`. A new file: the pinned test counts of `chat.test.ts` and `run.test.ts` belong to the causal and secrets controls.
 */
const CHAT: ResolvedChatConfig = {
  defaultMode: 'ask',
  defaultModeSource: 'fallback',
  defaultModel: 'my-self-hosted-model',
  defaultProvider: 'anthropic',
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
  reasoningEffort: 'high',
};

async function withheldNote(noticeSurface?: 'shell' | 'tui'): Promise<string> {
  let tick = Date.parse('2026-06-25T00:00:00.000Z');
  const notes: string[] = [];
  const built = await buildChatSession({
    chat: CHAT,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now: () => tick++,
    uuid: () => 'sess-notice-surface',
    providers: scriptedResolver([textTurn('hello there')]),
    consentGate: () => Promise.resolve(new Map()),
    onEffortWithheld: (note) => notes.push(note),
    ...(noticeSurface === undefined ? {} : { noticeSurface }),
  });
  built.session.start();
  await built.session.sendMessage('hello');
  built.session.cancel();
  await built.recordedEvents;
  expect(notes, 'the unknown model withheld its tier once').toHaveLength(1);
  return notes[0] ?? '';
}

describe('the withheld-tier note a session host composes', () => {
  it('is the scripted wording when the host is not told it is a TUI (agent run, a plain or --json chat)', async () => {
    const note = await withheldNote();
    expect(note).toContain('Run `relavium models refresh`');
    expect(note).not.toContain('/models');
  });

  it('is the scripted wording for an explicit shell surface', async () => {
    expect(await withheldNote('shell')).toContain('relavium models refresh');
  });

  it('names the picker’s own refresh when the host is the interactive chat or the Home', async () => {
    const note = await withheldNote('tui');
    expect(note).toContain('Open /models and press [Ctrl+R]');
    expect(note).not.toContain('relavium');
  });
});

/** The request a pre-egress check reads, for a model neither the catalog nor a user prices. */
function requestInfo(): PreEgressInfo {
  const identity = {
    model: 'my-self-hosted-model',
    maxTokens: 1000,
    provider: 'anthropic' as const,
    endpoint: 'official' as const,
    providerOptions: undefined,
  };
  return {
    ...identity,
    route: 'text',
    inputTokensEstimate: 0,
    maxTokensEstimate: undefined,
    outputCapPlan: prepareOutputCapPlan(identity),
  };
}

describe('the unpriced-model note the governor wiring composes', () => {
  const cap = { ...CHAT, maxCostMicrocents: 1_000_000, onExceed: 'fail' as const };
  async function unpricedNote(surface?: 'shell' | 'tui'): Promise<string> {
    const notes: string[] = [];
    const wiring = buildGovernorWiring(
      cap,
      undefined,
      undefined,
      undefined,
      (note) => notes.push(note),
      undefined,
      surface,
    );
    await wiring?.preEgress(requestInfo());
    expect(notes).toHaveLength(1);
    return notes[0] ?? '';
  }

  it('defaults to the scripted wording', async () => {
    const note = await unpricedNote();
    expect(note).toContain('relavium models pricing');
    expect(note).not.toContain('from the Home');
  });

  it('says the Home’s action on the TUI surface', async () => {
    const note = await unpricedNote('tui');
    expect(note).toContain('/pricing');
    expect(note).not.toContain('relavium models pricing');
  });
});
