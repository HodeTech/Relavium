import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { captureIo } from '../test-support.js';
import { runOnboardingWizard } from './wizard.js';

describe('native setup recovery names the reachable host action', () => {
  for (const surface of ['home', 'standalone-chat'] as const) {
    it.each(['skip', 'store-fault'] as const)(`${surface}: %s`, async (failure) => {
      const client = createClient(':memory:');
      runMigrations(client.db);
      try {
        const messages: string[] = [];
        const abort = new AbortController();
        const flow: NativePromptFlow = {
          pick: () => Promise.reject(new Error('Unexpected session picker in credential fixture.')),
          begin: () => abort.signal,
          end: () => Promise.resolve(),
          cancel: () => abort.abort(),
          note: (message) => {
            messages.push(message);
          },
          busy: () => {},
          select: () => Promise.resolve('skip'),
          password: () => Promise.resolve('synthetic-key-3847'),
          text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
          confirm: () => Promise.resolve(false),
        };
        const store = createProviderStore(client.db, { uuid: () => 'provider', now: () => 1 });
        const writeDefaultModel = vi.fn();
        await runOnboardingWizard({
          initialProvider: 'openai',
          native: {
            flow,
            signal: abort.signal,
            assertAdmitting: () => abort.signal.throwIfAborted(),
            endpointContext: () => 'Official endpoint',
            surface,
          },
          io: captureIo().io,
          store:
            failure === 'skip'
              ? store
              : {
                  ...store,
                  upsert: () => {
                    throw new Error('synthetic private store detail');
                  },
                },
          keychain: { get: () => null, set: () => {}, delete: () => false },
          resolver: { resolveProvider: () => undefined, keyFor: () => '' },
          validate: () =>
            Promise.resolve(
              failure === 'skip'
                ? { ok: false, reason: 'network', detail: 'synthetic-key-3847' }
                : { ok: true, reason: 'ok', detail: 'ok' },
            ),
          writeDefaultModel,
        });
        const copy = messages.join('\n');
        // The way back in is the host's own action, in words and not as a shell command (ADR-0122 §6, MVP-11 Step 2.4): the Home has
        // `/providers`; a stand-alone chat has neither it nor the Home, and says to start the chat again.
        if (failure === 'skip')
          expect(copy).toContain(
            surface === 'home'
              ? 'Setup skipped · /providers connects a provider any time'
              : 'Setup skipped · restart this chat to open provider setup any time',
          );
        else
          expect(copy).toContain(
            surface === 'home'
              ? 'Open /providers to connect a key'
              : 'Restart this chat to open provider setup',
          );
        expect(copy).not.toContain('relavium');
        expect(copy).not.toContain('provider add');
        if (surface === 'standalone-chat') expect(copy).not.toContain('/providers');
        expect(copy).not.toContain('3847');
        expect(copy).not.toContain('private store detail');
        expect(writeDefaultModel).not.toHaveBeenCalled();
      } finally {
        client.sqlite.close();
      }
    });
  }
});
