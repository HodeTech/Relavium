import { CommitmentDurabilityError } from '@relavium/core';
import {
  createClient,
  createEffectJournalPort,
  createEffectJournalStore,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
} from '@relavium/db';
import { prepareOutputCapPlan } from '@relavium/llm';
import { expect, it, vi } from 'vitest';
import type { ResolvedChatConfig } from '../config/resolve.js';
import { createSessionPersister } from './persister.js';
import { buildChatSession } from './session-host.js';
import { scriptedResolver } from './test-support.js';

it('latches a failed conservative commitment and refuses a cached-key command effect', async () => {
  const client = createClient(':memory:');
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const chat: ResolvedChatConfig = {
    defaultModel: undefined,
    defaultProvider: undefined,
    fsScope: undefined,
    maxTurns: undefined,
    maxMessages: undefined,
    autoCompact: undefined,
    compactThreshold: undefined,
    maxCostMicrocents: 10_000_000,
    maxTokens: undefined,
    onExceed: 'fail',
    strictCostCap: false,
    allowedCommands: ['ls'],
    allowedCommandGlobs: undefined,
    reasoningEffort: undefined,
  };
  const spawn = vi.fn(() =>
    Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
  );
  let id = 0;
  const now = () => 1_790_900_000_000;
  const built = await buildChatSession({
    chat,
    agentRef: undefined,
    cwd: '/workspace',
    projectConfigDir: undefined,
    now,
    uuid: () => 'session',
    providers: scriptedResolver([]),
    toolHost: { process: { spawn } },
    onListenerError: () => undefined,
  });
  const journal = createEffectJournalStore(client.db, { now, uuid: () => `effect-${++id}` });
  built.attachEffectJournal((correlation) =>
    createEffectJournalPort(journal, correlation, {
      providerAttempt: 0,
      toolCallId: 'test',
    }),
  );
  const persister = createSessionPersister({
    usageStore: createSessionUsageStore(client.db),
    mode: 'fresh',
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
    uuid: () => `message-${++id}`,
  });
  try {
    persister.start();
    built.session.start();
    expect((await built.session.runUserCommand('ls', [])).kind).toBe('ran');
    expect(spawn).toHaveBeenCalledTimes(1);
    const failure = new Error('private store failure');
    const failedWrite = vi
      .spyOn(store, 'recordSessionConservativeCommitment')
      .mockImplementation(() => {
        throw failure;
      });
    const identity = {
      model: 'claude-haiku-4-5',
      maxTokens: 1000,
      provider: 'anthropic' as const,
      endpoint: 'official' as const,
      providerOptions: undefined,
    };
    const info = {
      ...identity,
      route: 'text' as const,
      inputTokensEstimate: 0,
      maxTokensEstimate: undefined,
      outputCapPlan: prepareOutputCapPlan(identity),
    };
    const governor = built.governor;
    if (governor === undefined) throw new Error('missing governor');
    const admission = await governor.preEgress(info);
    if (admission === undefined) throw new Error('missing admission');
    admission.settleAtReservedEstimate();
    await expect(governor.flushBudgetCommitments()).rejects.toBeInstanceOf(
      CommitmentDurabilityError,
    );
    expect(persister.durabilityFailure).toBe(failure);
    await expect(
      persister.recordConservativeCommitment({ model: identity.model, estimateMicrocents: 1 }),
    ).rejects.toBe(failure);
    failedWrite.mockRestore();
    const outcome = await built.session.runUserCommand('ls', []);
    expect(outcome.kind).toBe('failed');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(persister.durabilityFailure).toBe(failure);
    expect(JSON.stringify(outcome)).not.toContain('private store failure');
  } finally {
    built.session.cancel();
    await built.whenHostSafeToClose().catch(() => undefined);
    persister.close();
    client.sqlite.close();
    vi.restoreAllMocks();
  }
});
