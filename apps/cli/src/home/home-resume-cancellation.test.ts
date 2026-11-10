import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Key } from 'ink';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { startMcpClient } from '@relavium/mcp';
import { AgentSchema } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildResumedChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { createProviderResolver } from '../engine/providers.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => {}, delete: () => false }),
}));
const key: Key = {
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

describe.each([false, true])(
  'Home local restoration cancellation, retained chat=%s',
  (retained) => {
    it.each([
      'live',
      'before-connect',
      'during-connect',
      'post-build',
      'fault-after-cancel',
    ] as const)(
      'preserves admission, actual cleanup and fault classification at %s',
      async (stage) => {
        const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-local-resume-')));
        const client = createClient(':memory:');
        runMigrations(client.db);
        const store = createSessionStore(client.db);
        const agent = AgentSchema.parse({
          id: 'saved',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          system_prompt: 'Offline test',
          mcp_servers: [{ id: 'test-server', transport: 'http', url: 'https://example.test/mcp' }],
        });
        const iso = '2026-11-10T00:00:00.000Z';
        store.createSession({
          id: 'target',
          title: 'target saved',
          agentSlug: agent.id,
          agentSnapshot: agent,
          context: { workingDir: root, fsScopeTier: 'project' },
          status: 'ended',
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostMicrocents: 0,
          totalConservativeMicrocents: 0,
          createdAt: iso,
          updatedAt: iso,
        });
        const saved = store.loadSession('target');
        if (saved === undefined) throw new Error('Missing seeded session');
        store.writeTurn({
          session: saved,
          messages: [
            {
              message: {
                id: 'u',
                sessionId: 'target',
                sequenceNumber: 0,
                role: 'user',
                content: [{ type: 'text', text: 'saved prompt' }],
                timestamp: iso,
              },
              meta: { userDisplayText: 'saved prompt' },
            },
            {
              message: {
                id: 'a',
                sessionId: 'target',
                sequenceNumber: 1,
                role: 'assistant',
                content: [{ type: 'text', text: 'saved answer' }],
                timestamp: iso,
              },
            },
          ],
        });
        const f = invocationFixture(),
          captured = captureIo();
        let cancelled = false;
        const afterCancelKey = vi.fn(),
          afterCancelStart = vi.fn(),
          mcpClose = vi.fn();
        const credentials = createProviderResolver(
          {},
          {
            get: () => {
              if (cancelled) afterCancelKey();
              return 'synthetic-local-resume-key';
            },
            set: () => {},
            delete: () => false,
          },
        );
        const model = scriptedResolver([textTurn('retained answer')]);
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let props: RootAppProps | undefined;
        let connectSignal: { readonly aborted: boolean } | undefined;
        const entered = vi.fn();
        let reportFault: (cause: unknown) => void = () => {
          throw new Error('Missing pending host owner');
        };
        const closeDb = vi.fn();
        const cancel = (): void => {
          cancelled = true;
          props?.nativePrompt?.input('\x1b', { ...key, escape: true });
        };
        const start = vi.fn<
          NonNullable<Parameters<typeof buildResumedChatSession>[0]['startMcpClient']>
        >(async (_configs, signal) => {
          connectSignal = signal;
          if (cancelled) afterCancelStart();
          if (stage === 'during-connect') {
            entered();
            await held;
          }
          // An empty real manager gives a real close path without a process or network connection.
          const manager = await startMcpClient([]);
          return {
            ...manager,
            close: (...args: Parameters<typeof manager.close>) => {
              mcpClose();
              return manager.close(...args);
            },
          };
        });
        const resumed = vi.fn<NonNullable<HomeDeps['buildResumedSession']>>(async (options) => {
          if (options.workOwner === undefined) throw new Error('Missing pending host owner');
          reportFault = options.workOwner.failure;
          const built = await buildResumedChatSession({
            ...options,
            startMcpClient: start,
            consentGate: async (...args) => {
              const consented = await options.consentGate?.(...args);
              if (stage === 'before-connect' || stage === 'fault-after-cancel') {
                entered();
                await held;
                if (stage === 'fault-after-cancel')
                  reportFault(new Error('PRIVATE_CONNECT_FAILURE'));
              }
              return consented ?? new Map();
            },
          });
          if (stage === 'post-build') queueMicrotask(() => queueMicrotask(cancel));
          return built;
        });
        let acknowledgeExit = (): void => {};
        const exited = new Promise<void>((resolve) => {
          acknowledgeExit = resolve;
        });
        const unmount = vi.fn(() => acknowledgeExit());
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
          openSessionStore: () => ({ store, db: client.db, close: closeDb }),
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
        let escaped: unknown;
        const settled = running.catch((cause: unknown) => {
          escaped = cause;
        });
        try {
          await vi.waitFor(() => expect(props).toBeDefined());
          if (props === undefined) throw new Error('Home did not mount');
          const controller = props.controller;
          if (retained) {
            controller.handlePaste('live prompt');
            controller.handleKey('', { return: true });
            await vi.waitFor(() => {
              expect(controller.getSnapshot().mode).toBe('chat');
              expect(controller.getSnapshot().submitBusy).toBe(false);
            });
          }
          const old = controller.getSnapshot().session;
          const baselineOwners = f.registry.activeOwners;
          if (retained) {
            controller.handlePaste('/resume');
            controller.handleKey('', { return: true });
            await vi.waitFor(() => expect(props?.nativePrompt?.getSnapshot().kind).toBe('picker'));
            props.nativePrompt?.paste('target saved');
            await vi.waitFor(() =>
              expect(
                props?.nativePrompt?.getSnapshot().options.map((option) => option.value),
              ).toEqual(['target']),
            );
            props.nativePrompt?.input('', { ...key, return: true });
          } else {
            controller.handleKey('', { downArrow: true });
            controller.handleKey('', { return: true });
          }
          await vi.waitFor(() => expect(resumed).toHaveBeenCalledOnce());
          if (
            stage === 'before-connect' ||
            stage === 'during-connect' ||
            stage === 'fault-after-cancel'
          ) {
            await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
            cancel();
            expect(props.nativePrompt?.signal()?.aborted).toBe(true);
            if (stage === 'during-connect') expect(connectSignal?.aborted).toBe(true);
            expect(controller.getSnapshot().nativeActionBusy).toBe(true);
            expect(f.registry.activeOwners).toBeGreaterThan(baselineOwners);
            expect(controller.getSnapshot().session).toBe(old);
            release();
          }
          if (stage === 'fault-after-cancel') {
            await vi.waitFor(() => expect(f.registry.observations.exitCode()).toBe(9));
            await settled;
            expect(f.registry.activeOwners).toBe(0);
            // Infrastructure fallback reserves the shared deadline for an outer diagnostic handoff,
            // even after actual cleanup. This isolated fixture has no command adapter to acknowledge it.
            f.advance(3000);
            expect(await f.invocation.finiteExit.exited).toBe(9);
          } else {
            await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false));
            expect(f.registry.termination).toBeUndefined();
            expect(controller.getSnapshot().mode).toBe(
              stage === 'live' || retained ? 'chat' : 'home',
            );
            if (stage !== 'live') {
              expect(controller.getSnapshot().session).toBe(old);
              expect(f.registry.activeOwners).toBe(baselineOwners);
            } else expect(controller.getSnapshot().session?.sessionId).toBe('target');
            expect(start).toHaveBeenCalledTimes(stage === 'before-connect' ? 0 : 1);
            if (stage === 'during-connect' || stage === 'post-build')
              expect(mcpClose).toHaveBeenCalledOnce();
            f.invocation.finiteExit.signal(15);
            expect(await f.invocation.finiteExit.exited).toBe(143);
          }
          await settled;
          if (stage !== 'fault-after-cancel') expect(escaped).toBeUndefined();
          expect(afterCancelKey).not.toHaveBeenCalled();
          expect(afterCancelStart).not.toHaveBeenCalled();
          expect(closeDb).toHaveBeenCalledOnce();
          expect(unmount).toHaveBeenCalledOnce();
          expect(f.registry.activeOwners).toBe(0);
        } finally {
          release();
          if (f.registry.activeOwners > 0) f.invocation.finiteExit.signal(15);
          await settled;
          client.sqlite.close();
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  },
);
