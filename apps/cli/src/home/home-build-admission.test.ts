import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';
import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { createProviderResolver } from '../engine/providers.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { driveHome } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => {}, delete: () => false }),
}));

describe.each(['fresh', 'resume'] as const)('Home %s builder admission handoff', (kind) => {
  it.each([0, 1, 2, 3])(
    'keeps credential reads before stop, microtask depth=%s (0=live control)',
    async (depth) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-build-')));
      const client = createClient(':memory:');
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      const f = invocationFixture();
      const captured = captureIo();
      const afterStop = vi.fn();
      const keychain = {
        get: vi.fn(() => {
          if (f.registry.termination !== undefined) afterStop();
          return 'synthetic-build-test-key';
        }),
        set: () => {},
        delete: () => false,
      };
      const credentials = createProviderResolver({}, keychain);
      const model = scriptedResolver([textTurn('saved answer'), textTurn('live answer')]);
      const scheduleStop = (): void => {
        if (depth === 0) return;
        let remaining = depth;
        const tick = (): void => {
          if (--remaining === 0) f.invocation.finiteExit.signal(15);
          else queueMicrotask(tick);
        };
        queueMicrotask(tick);
      };
      let props: RootAppProps | undefined;
      let acknowledgeExit = (): void => {};
      const exited = new Promise<void>((resolve) => {
        acknowledgeExit = resolve;
      });
      const unmount = vi.fn(() => acknowledgeExit());
      const close = vi.fn();
      const resumed = vi.fn(async (options: Parameters<typeof buildResumedChatSession>[0]) => {
        const built = await buildResumedChatSession(options);
        scheduleStop();
        return built;
      });
      let uuid = 0;
      const running = driveHome({
        invocation: f.invocation,
        io: { ...captured.io, env: {}, stdinIsTty: true, stdoutIsTty: true },
        global: {
          cwd: root,
          configPath: join(root, 'absent.toml'),
          json: false,
          color: false,
          noAltScreen: true,
          verbosity: 'normal',
        },
        providers: { ...credentials, resolveProvider: model.resolveProvider },
        openSessionStore: () => ({ store, db: client.db, close }),
        uuid: () => `build-${uuid++}`,
        buildSession: async (options) => {
          const built = await buildChatSession(options);
          if (kind === 'fresh') scheduleStop();
          return built;
        },
        buildResumedSession: resumed,
        render: (value) => {
          props = value;
          const native = value.nativePrompt;
          native?.bindVisibility((expected) => native.getSnapshot() === expected);
          value.onRendererReady?.(async (publish) => {
            await publish?.();
          });
          return {
            unmount,
            waitUntilRenderFlush: () => Promise.resolve(),
            waitUntilExit: () => exited,
          };
        },
        getSize: () => ({ cols: 120, rows: 40 }),
        subscribeResize: () => () => {},
        subscribeSignals: () => () => {},
        subscribeProcessExit: () => () => {},
        jobControlLifecycle: {
          supported: false,
          onSuspend: () => () => {},
          onContinue: () => () => {},
          suspendSelf: () => {},
        },
        onboardingTerminalLifecycle: {
          onInput: () => () => {},
          isRawMode: () => false,
          setRawMode: () => {},
        },
        writeControl: () => {},
        exit: () => {},
      });
      try {
        await vi.waitFor(() => expect(props).toBeDefined());
        if (props === undefined) throw new Error('Home did not mount');
        const controller = props.controller;
        controller.handlePaste('first prompt');
        controller.handleKey('', { return: true });
        if (kind === 'resume' || depth === 0) {
          await vi.waitFor(() => {
            expect(controller.getSnapshot().mode).toBe('chat');
            expect(controller.getSnapshot().submitBusy).toBe(false);
          });
        }
        if (kind === 'resume') {
          controller.handlePaste('/cancel');
          controller.handleKey('', { return: true });
          await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('home'));
          controller.handleKey('', { downArrow: true });
          expect(controller.getSnapshot().continueSessionId).toBeDefined();
          controller.handleKey('', { return: true });
          await vi.waitFor(() => expect(resumed).toHaveBeenCalledOnce());
        }
        if (depth === 0) {
          await vi.waitFor(() => {
            expect(controller.getSnapshot().mode).toBe('chat');
            expect(controller.getSnapshot().nativeActionBusy).toBe(false);
          });
          expect(keychain.get).toHaveBeenCalled();
          f.invocation.finiteExit.signal(15);
        }
        expect(await f.invocation.finiteExit.exited).toBe(143);
        await running;
        expect(afterStop).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect(unmount).toHaveBeenCalledOnce();
        expect(f.registry.activeOwners).toBe(0);
      } finally {
        if (f.registry.activeOwners > 0) f.invocation.finiteExit.signal(15);
        await running;
        client.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
