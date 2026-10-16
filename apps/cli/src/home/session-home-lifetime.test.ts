import { describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from '@relavium/llm';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { validateProviderKey } from '../engine/providers.js';
import { SessionHomeLifetime } from './session-home-lifetime.js';

describe('Home shared database after actual onboarding work', () => {
  it('a probe timeout cannot close the database before the actual producer settles', async () => {
    const f = invocationFixture();
    const home = new SessionHomeLifetime(f.invocation, () => () => undefined);
    const close = vi.fn();
    home.adoptStore({ close });
    let settle: () => void = () => undefined;
    const raw = new Promise<never>((_resolve, reject) => {
      settle = () => reject(new Error('synthetic probe settled'));
    });
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CHAT_TEXT_CAPABILITY_FLAGS,
      generate: () => raw,
      stream: () => {
        throw new Error('unexpected stream');
      },
    };
    const work = home.surface.work;
    const drive = home.execute(async () => {
      const result = await validateProviderKey(
        provider,
        'synthetic-probe-key',
        'synthetic-model',
        5,
        { signal: work.signal, work: work.work, assertAdmitting: work.assertAdmitting },
      );
      expect(result.reason).toBe('network');
      return 0;
    });
    await vi.waitFor(() => expect(work.signal.aborted).toBe(true));
    expect(close, 'HOME_PROBE_BEFORE_SHARED_DATABASE_CLOSE').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    settle();
    expect(await drive).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
  });
});
