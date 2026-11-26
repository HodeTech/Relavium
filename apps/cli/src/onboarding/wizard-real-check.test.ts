/**
 * What the key check does with the signal that says it was abandoned, on the REAL check path (no injected `validate`), where a work owner's
 * lifecycle wraps the probe (`checkLifecycle`): an `Esc` out of the check aborts the request itself, not only the wait for it.
 */
import { Readable } from 'node:stream';

import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import type { LlmProvider } from '@relavium/llm';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../chat/session-work-owner.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { runNativeSetup } from './wizard.js';

const io: CliIo = {
  env: {},
  stdoutIsTty: true,
  stdinIsTty: true,
  stdin: Readable.from([]),
  writeOut: () => {},
  writeErr: () => {},
  writeOutAcknowledged: async () => {},
  writeErrAcknowledged: async () => {},
};
const KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
/** Turns of the event loop a step is given to settle (the check goes out, or the wait gives way to the key step). */
const SETTLE_TURNS = 20;
const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

describe('the key check on the real path (a work owner, no injected check)', () => {
  it('R2-9 an Esc out of the check aborts the request itself, not only the wait for it: the abandoned signal reaches the probe', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const fixture = invocationFixture();
    const owner = new SessionWorkOwner(fixture.invocation, 'home', {
      cancel: () => {},
      cleanup: async () => {},
    });
    try {
      const channel = createNativePromptChannel();
      const signal = channel.flow.begin();
      const seen: (AbortSignal | undefined)[] = [];
      let release: () => void = () => undefined;
      const adapter = {
        generate: (request: { readonly signal?: AbortSignal }) => {
          seen.push(request.signal);
          // Never answers on its own: the request stays in flight until the test (or an abort) lets it go.
          return new Promise<never>((_, reject) => {
            release = () => reject(new Error('released'));
            request.signal?.addEventListener('abort', release, { once: true });
          });
        },
      } as unknown as LlmProvider;
      const running = runNativeSetup(
        {
          initialProvider: 'openai',
          workOwner: owner,
          io,
          store: createProviderStore(client.db, { uuid: () => 'id', now: () => 1 }),
          keychain: { get: () => null, set: vi.fn(), delete: () => false },
          resolver: { resolveProvider: () => adapter, keyFor: () => '' },
          writeDefaultModel: vi.fn(),
        },
        {
          flow: channel.flow,
          signal,
          assertAdmitting: () => signal.throwIfAborted(),
          endpointContext: () => 'official',
          // The popup's stages: the wait steps back on `Esc` (the card's does not).
          stages: {
            provider: channel.flow,
            key: channel.flow,
            done: () => Promise.resolve(),
          },
        },
      );
      channel.ui.paste('synthetic-key-w13');
      channel.ui.input('\r', { ...KEY, return: true });
      for (let i = 0; i < SETTLE_TURNS && seen.length === 0; i += 1) await turn();
      expect(seen, 'the probe went out once').toHaveLength(1);
      expect(seen[0]?.aborted, 'still in flight').toBe(false);
      expect(channel.ui.getSnapshot().kind).toBe('busy');
      channel.ui.input('', { ...KEY, escape: true });
      for (let i = 0; i < SETTLE_TURNS && channel.ui.getSnapshot().kind === 'busy'; i += 1)
        await turn();
      expect(channel.ui.getSnapshot().kind, 'the key step again').toBe('password');
      expect(seen[0]?.aborted, 'the request itself was told to stop').toBe(true);
      channel.flow.cancel();
      await running;
      await channel.flow.end();
      release(); // the retained producer settles, so the owner can close
      await owner.close();
    } finally {
      client.sqlite.close();
    }
  });
});
