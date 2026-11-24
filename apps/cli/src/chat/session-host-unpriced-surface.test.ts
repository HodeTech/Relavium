import { createInMemoryEffectJournal } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { buildChatSession as buildFreshSession } from './session-host.js';
import { collectSubscribedSessionEvents, scriptedResolver, textTurn } from './test-support.js';

/**
 * The unpriced-model note, composed by the REAL session host (MVP-11 Step 2 review round 2, Q1). `session-host-notice-surface.test.ts` calls
 * `buildGovernorWiring` directly with the surface as an argument, so the host's own threading of its `noticeSurface` to the governor was never
 * exercised: dropping that argument printed `relavium models pricing …` to the interactive chat and the Home with the suite green. A new file.
 */
const CAP: ResolvedChatConfig = {
  defaultMode: 'ask',
  defaultModeSource: 'fallback',
  defaultModel: 'my-self-hosted-model', // not in the catalog, and nobody priced it
  defaultProvider: 'anthropic',
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: 1_000_000,
  maxTokens: undefined,
  onExceed: 'fail',
  strictCostCap: false, // the cap degrades to `allow` and SAYS so; with `strict_cost_cap` on the turn is refused and there is no note
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
};

async function unpricedNote(noticeSurface?: 'shell' | 'tui'): Promise<string> {
  let tick = Date.parse('2026-06-25T00:00:00.000Z');
  const notes: string[] = [];
  const built = await buildFreshSession({
    chat: CAP,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now: () => tick++,
    uuid: () => 'sess-unpriced-surface',
    providers: scriptedResolver([textTurn('hello there')]),
    consentGate: () => Promise.resolve(new Map()),
    onUnpriced: (note) => notes.push(note),
    ...(noticeSurface === undefined ? {} : { noticeSurface }),
  });
  let key = 0;
  built.attachEffectTurnAllocator(() => ++key);
  let ordinal = 0;
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
          ordinal: ++ordinal,
          dispatchId: draft.nodeId,
          round: draft.round,
          chainAttempt: draft.chainAttempt,
        }),
      ),
    disposition: () => undefined,
    record: () => undefined,
  });
  built.attachEffectJournal((correlation) => createInMemoryEffectJournal(correlation));
  const recorded = collectSubscribedSessionEvents(built.handle);
  built.session.start();
  await built.session.sendMessage('hello');
  built.session.cancel();
  await recorded;
  expect(notes, 'the unpriced model was said once').toHaveLength(1);
  return notes[0] ?? '';
}

describe('the unpriced-model note of a session the host builds', () => {
  it('names the shell command when the host is not told it is a TUI (agent run, a plain or --json chat)', async () => {
    const note = await unpricedNote();
    expect(note).toContain('relavium models pricing');
    expect(note).not.toContain('from the Home');
  });

  it('names the shell command for an explicit shell surface', async () => {
    expect(await unpricedNote('shell')).toContain('relavium models pricing');
  });

  it('names the Home’s /pricing, and no shell command, for the interactive chat and the Home', async () => {
    const note = await unpricedNote('tui');
    expect(note).toContain('Price it from the Home with /pricing');
    expect(note).not.toContain('relavium');
  });
});
