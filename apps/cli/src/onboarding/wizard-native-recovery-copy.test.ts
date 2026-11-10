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
        expect(copy).toContain(
          surface === 'home' ? 'Open `/providers`' : 'Restart `relavium chat`',
        );
        expect(copy).not.toContain('relavium provider add');
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
