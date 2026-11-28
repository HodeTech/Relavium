/**
 * SE-L3 (MVP-11 unit 6, review round 2; round 1's S5 fixed the popup only): after a network-class failure the pre-selected `Retry the check`
 * SENDS the key again, so on EVERY surface it is guarded: the `Enter` that submitted the key, held down, never re-sends it, on the popup's steps
 * and on the stand-alone `relavium chat` card alike. Driven on the real native channel with an injected clock and a host that acknowledges
 * every frame it is given (the card's host acknowledges unframed cards too: `native-prompt-host.tsx`), with a held-key schedule.
 */
import { Readable } from 'node:stream';

import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import type { Key } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderKeyValidation } from '../engine/providers.js';
import type { CliIo } from '../process/io.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
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
const NONE: Key = {
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
const ENTER: Key = { ...NONE, return: true };
const NETWORK: ProviderKeyValidation = { ok: false, reason: 'network', detail: 'timeout' };
/** How long the key is held down: well past the guarded row's lockout, which every refused repeat restarts. */
const HELD_MS = 4000;
/** The key's repeat gaps a held `Enter` is tried at (a fast terminal, a typical one, a slow one). */
const HELD_RATES = [30, 100, 300] as const;

let client: DbClient;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

describe('SE-L3: a held Enter never re-sends the key through `Retry the check`', () => {
  it.each(
    (['card', 'popup'] as const).flatMap((surface) =>
      HELD_RATES.map((rate) => [surface, rate] as const),
    ),
  )(
    'on the %s, the Enter that submitted the key held down (a repeat every %i ms) sends it once; one deliberate Enter after the lockout sends it again',
    async (surface, rate) => {
      let clock = 10_000;
      const channel = createNativePromptChannel({ now: () => clock });
      // The host's acknowledgement: every frame it is given is measured and flushed, card or popup (`native-prompt-acknowledgement.ts`).
      channel.ui.bindVisibility((expected) => channel.ui.getSnapshot() === expected);
      channel.ui.subscribe(() => {
        const frame = channel.ui.getSnapshot();
        queueMicrotask(() => {
          if (channel.ui.getSnapshot() === frame) channel.ui.shown(frame);
        });
      });
      const signal = channel.flow.begin();
      let checks = 0;
      const running = runNativeSetup(
        {
          initialProvider: 'anthropic',
          io,
          store: createProviderStore(client.db, { uuid: () => 'id', now: () => 1 }),
          keychain: { get: () => null, set: () => undefined, delete: () => false },
          resolver: { resolveProvider: () => undefined, keyFor: () => '' },
          validate: () => {
            checks += 1;
            return Promise.resolve(NETWORK);
          },
          writeDefaultModel: () => undefined,
        },
        {
          flow: channel.flow,
          signal,
          assertAdmitting: () => {},
          endpointContext: () => 'Official endpoint',
          ...(surface === 'popup'
            ? {
                stages: {
                  provider: channel.flow,
                  key: channel.flow,
                  done: (): Promise<void> => Promise.resolve(),
                },
              }
            : {}),
        },
      );
      const flush = async (): Promise<void> => {
        for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((r) => setImmediate(r));
      };
      for (let turn = 0; turn < 400 && channel.ui.getSnapshot().kind !== 'password'; turn += 1)
        await flush();
      channel.ui.paste('synthetic-recheck-credential-4410');
      channel.ui.input('\r', ENTER); // the press that submits the key, held down from here
      await flush();
      const highlighted = channel.ui.getSnapshot().options[channel.ui.getSnapshot().selected];
      for (let at = 0; at <= HELD_MS; at += rate) {
        clock += rate;
        channel.ui.input('\r', ENTER);
        await flush();
      }
      expect(checks, 'the held key re-sent nothing').toBe(1);
      expect(highlighted, 'the pre-selected row sends the key: it is guarded').toMatchObject({
        value: 'recheck',
        guarded: true,
      });
      // The key is released; a deliberate `Enter`, pressed once after the lockout, checks the same key again.
      clock += APPROVAL_LOCKOUT_MS + 100;
      channel.ui.input('\r', ENTER);
      await flush();
      expect(checks).toBe(2);
      channel.flow.cancel();
      await running.catch(() => undefined);
      await channel.flow.end();
    },
  );
});
