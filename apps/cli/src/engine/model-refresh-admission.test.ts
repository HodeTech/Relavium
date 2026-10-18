import { describe, expect, it, vi } from 'vitest';
import { CliError } from '../process/cli-error.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import { createModelRefreshService } from './model-refresh.js';
import { KNOWN_PROVIDERS } from './providers.js';

function fixture(fatal: boolean, clockFault = false) {
  const f = invocationFixture();
  const owner = new InvocationWorkOwner(
    f.invocation,
    { kind: 'command' },
    {
      cancel: () => {},
      cleanup: () => Promise.resolve(),
    },
  );
  const entered: Array<{ kind: string; stopped: boolean }> = [];
  const keyFor = vi.fn((id: string) => {
    entered.push({ kind: `key:${id}`, stopped: owner.signal.aborted });
    if (id === 'anthropic' && !clockFault)
      throw fatal ? new Error('PRIVATE_KEY_FAULT') : new CliError('invalid_invocation', 'No key.');
    return 'synthetic-unused';
  });
  const now = vi.fn(() => {
    entered.push({ kind: 'clock', stopped: owner.signal.aborted });
    if (clockFault) throw new Error('PRIVATE_CLOCK_FAULT');
    return 0;
  });
  const get = vi.fn((id: string) => {
    entered.push({ kind: `store:${id}`, stopped: owner.signal.aborted });
    return { id };
  });
  const resolveProvider = vi.fn(() => undefined);
  const service = createModelRefreshService({
    assertAdmitting: owner.assertAdmitting,
    onHostFailure: owner.failure,
    knownProviderIds: ['anthropic', 'openai'],
    knownProviders: KNOWN_PROVIDERS,
    keyFor,
    now,
    resolveProvider,
    providerStore: { get, upsert: () => ({ id: 'synthetic' }) },
    catalogStore: {
      providerRefreshedAt: () => undefined,
      replaceProviderModels: () => ({ added: 0, updated: 0, deactivated: 0 }),
    },
  });
  return { ...f, owner, service, entered, keyFor, now, get, resolveProvider };
}

describe('catalog refresh original-owner admission', () => {
  it.each(['refresh', 'refreshIfStale'] as const)(
    '%s starts no next key/store/clock work after a fatal key port stops its actual owner',
    async (method) => {
      const f = fixture(true);
      try {
        const outcome = await f.service[method]({ signal: f.owner.signal }).then(
          () => ({ stopped: false }),
          (cause: unknown) => ({ stopped: f.owner.isStoppedFailure(cause) }),
        );
        expect(outcome, 'CATALOG_FATAL_KEY_STOPS_CANDIDATE_ADMISSION').toEqual({ stopped: true });
        expect(f.keyFor.mock.calls.map(([id]) => id)).toEqual(['anthropic']);
        expect(f.entered.some((event) => event.stopped)).toBe(false);
        expect(f.get).not.toHaveBeenCalled();
        expect(f.resolveProvider).not.toHaveBeenCalled();
        expect(f.registry.observations.exitCode()).toBe(9);
        expect(f.registry.budget.deadline()).toBe(3000);
      } finally {
        await f.owner.close();
      }
    },
  );

  it.each(['refresh', 'refreshIfStale'] as const)(
    '%s preserves ordinary typed missing-key isolation while the owner remains admitted',
    async (method) => {
      const f = fixture(false);
      try {
        const report = await f.service[method]({ signal: f.owner.signal });
        expect(report?.providers).toContainEqual({
          provider: 'openai',
          status: 'skipped-unsupported',
        });
        expect(f.keyFor.mock.calls.some(([id]) => id === 'openai')).toBe(true);
        expect(f.entered.every((event) => !event.stopped)).toBe(true);
        expect(f.owner.signal.aborted).toBe(false);
        expect(f.registry.observations.exitCode()).toBe(0);
      } finally {
        await f.owner.close();
      }
    },
  );

  it('admits sibling attempt clocks before entry, preserving already selected keys without starting post-stop work', async () => {
    const f = fixture(true, true);
    try {
      const result = await f.service
        .refresh({ signal: f.owner.signal })
        .catch((cause: unknown) => cause);
      expect(f.owner.isStoppedFailure(result)).toBe(true);
      expect(f.keyFor).toHaveBeenCalledTimes(2); // Both keys were selected before the first attempt fault.
      expect(f.now, 'CATALOG_FATAL_CLOCK_STOPS_SIBLING_ATTEMPT').toHaveBeenCalledOnce();
      expect(f.entered.some((event) => event.stopped)).toBe(false);
      expect(f.resolveProvider).not.toHaveBeenCalled();
      expect(f.registry.observations.exitCode()).toBe(9);
    } finally {
      await f.owner.close();
    }
  });
});
