import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '../config/load.js';
import { scriptedResolver } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { chatCommand, driveJson, drivePlain } from './chat.js';

vi.mock('../config/load.js', { spy: true });
const actualConfig = await vi.importActual<typeof import('../config/load.js')>('../config/load.js');
afterEach(() => vi.restoreAllMocks());

describe('actual headless chat partial readline custody', () => {
  for (const mode of ['plain', 'json'] as const) {
    it.each(['error', 'data', 'end', 'iterator'] as const)(
      `${mode} releases captured callbacks and session subscription after %s acquisition fails`,
      async (stage) => {
        const directory = mkdtempSync(join(tmpdir(), 'relavium-readline-custody-'));
        const client = createClient(':memory:');
        runMigrations(client.db);
        vi.spyOn(config, 'loadResolvedConfig').mockImplementation((options) =>
          actualConfig.loadResolvedConfig({ ...options, home: directory }),
        );
        vi.spyOn(config, 'resolveHomeDir').mockReturnValue(directory);
        const f = invocationFixture();
        const input = new PassThrough();
        const primary = new Error('PRIVATE_PARTIAL_READLINE_FAILURE');
        const priorData = vi.fn();
        const priorError = vi.fn();
        input.on('data', priorData);
        input.on('error', priorError);
        input.on('newListener', (event) => {
          if (event === stage) throw primary;
        });
        if (stage === 'iterator')
          vi.spyOn(Interface.prototype, Symbol.asyncIterator).mockImplementation(() => {
            throw primary;
          });
        const close = vi.fn();
        let unsubscribed = 0;
        const captured = captureIo();
        try {
          await expect(
            chatCommand(
              { agent: undefined },
              {
                invocation: f.invocation,
                io: { ...captured.io, stdin: input },
                global: {
                  cwd: directory,
                  json: mode === 'json',
                  color: false,
                  configPath: undefined,
                  verbosity: 'normal',
                },
                providers: scriptedResolver([]),
                openSessionStore: () => ({
                  db: client.db,
                  store: createSessionStore(client.db),
                  close,
                }),
                drive: (ctx) =>
                  (mode === 'plain' ? drivePlain : driveJson)({
                    ...ctx,
                    handle: {
                      ...ctx.handle,
                      subscribe: (listener) => {
                        const unsubscribe = ctx.handle.subscribe(listener);
                        return () => {
                          unsubscribed++;
                          unsubscribe();
                        };
                      },
                    },
                  }),
                lifecycle: {
                  onInterrupt: () => () => {},
                  onTerminationSignal: () => () => {},
                  onProcessExit: () => () => {},
                  setRawMode: () => {},
                  exit: () => {},
                },
                now: () => 0,
                uuid: () => 'synthetic-readline-session',
              },
            ),
          ).rejects.toBe(primary);
          expect(input.listeners('data'), 'HEADLESS_READLINE_PARTIAL_INPUT_RELEASE').toEqual([
            priorData,
          ]);
          expect(input.listeners('error')).toEqual([priorError]);
          expect(input.listenerCount('end')).toBe(0);
          expect(input.isPaused()).toBe(true);
          expect(unsubscribed, 'HEADLESS_READLINE_PARTIAL_SUBSCRIPTION_RELEASE').toBe(1);
          expect(close).toHaveBeenCalledOnce();
          expect(f.registry.activeOwners).toBe(0);
          expect(f.registry.observations.exitCode()).toBe(9);
          expect(captured.out() + captured.err()).not.toContain(primary.message);
        } finally {
          input.removeAllListeners();
          input.destroy();
          client.sqlite.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  }
});
