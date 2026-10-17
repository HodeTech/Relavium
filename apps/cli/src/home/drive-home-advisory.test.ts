import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';

import { buildChatSession } from '../chat/session-host.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

it.each(['notice', 'store-listener'] as const)(
  'actual Home host owns an advisory %s failure before governor recovery',
  async (faultKind) => {
    for (const faulted of [false, true]) {
      const f = invocationFixture();
      const client = createClient(':memory:');
      runMigrations(client.db);
      const sessions = createSessionStore(client.db);
      const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-advisory-'));
      mkdirSync(join(cwd, '.relavium'));
      writeFileSync(
        join(cwd, '.relavium', 'project.toml'),
        '[chat]\nmax_cost_microcents = 1\non_exceed = "warn"\n',
      );
      let props: RootAppProps | undefined;
      let owner: SessionWorkOwner | undefined;
      let finishRender = () => {};
      let closed = 0;
      let durableReplies = 0;
      let sessionId: string | undefined;
      let id = 0;
      const exited = new Promise<void>((resolve) => {
        finishRender = resolve;
      });
      const providers = scriptedResolver([textTurn('first'), textTurn('second')]);
      const provider = providers.resolveProvider('anthropic');
      if (provider === undefined) throw new Error('Expected offline provider.');
      const stream = vi.spyOn(provider, 'stream');
      const running = driveHome({
        invocation: f.invocation,
        io: { ...captureIo().io, stdoutIsTty: true, stdinIsTty: true },
        global: {
          cwd,
          json: false,
          color: false,
          configPath: join(cwd, 'absent-global.toml'),
          verbosity: 'normal',
        },
        providers,
        now: () => Date.parse('2026-10-17T00:00:00.000Z'),
        uuid: () => `home-advisory-${++id}`,
        buildSession: (options) => {
          owner = options.workOwner;
          return buildChatSession(options);
        },
        openSessionStore: () => ({
          store: sessions,
          db: client.db,
          close: () => {
            durableReplies =
              sessionId === undefined
                ? 0
                : (sessions.loadFull(sessionId)?.messages.filter((m) => m.role === 'assistant')
                    .length ?? 0);
            closed++;
            client.sqlite.close();
          },
        }),
        // Real controller/session/store; this captured renderer does not claim installed Ink coverage.
        render: (value) => {
          props = value;
          value.onRendererReady?.(async (publish) => {
            await publish?.();
          });
          return {
            unmount: finishRender,
            waitUntilExit: () => exited,
            waitUntilRenderFlush: () => Promise.resolve(),
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
      });
      try {
        if (props === undefined) throw new Error('Expected Home controller.');
        const controller = props.controller;
        for (const char of 'hello') controller.handleKey(char, {});
        controller.handleKey('', { return: true });
        await flush();
        await flush();
        const session = controller.getSnapshot().session;
        if (session === undefined) throw new Error('Expected active Home session.');
        sessionId = session.sessionId;
        const cause = new TypeError('PRIVATE_ADVISORY_VIEW_FAILURE');
        let hits = 0;
        const notice = session.store.notice.bind(session.store);
        const spy = vi.spyOn(session.store, 'notice').mockImplementation((text) => {
          if (faulted && faultKind === 'notice' && text.includes('budget warning')) {
            hits++;
            throw cause;
          }
          notice(text);
        });
        const remove = session.store.subscribe(() => {
          const last = session.store.getSnapshot().state.transcript.at(-1)?.text;
          if (
            faulted &&
            faultKind === 'store-listener' &&
            hits === 0 &&
            last?.includes('budget warning')
          ) {
            hits++;
            throw cause;
          }
        });
        try {
          await session.processLine('second input');
          await flush();
          expect(hits).toBe(faulted ? 1 : 0);
          expect(owner?.firstFailure?.cause, 'HOME_ADVISORY_ORIGINAL_CAUSE').toBe(
            faulted ? cause : undefined,
          );
          expect(f.registry.termination !== undefined).toBe(faulted);
          if (!faulted) {
            expect(
              session.store
                .getSnapshot()
                .state.transcript.some((entry) => entry.text?.includes('budget warning')),
            ).toBe(true);
            controller.handleKey('c', { ctrl: true });
            await flush();
            await flush();
            controller.handleKey('c', { ctrl: true });
          }
        } finally {
          remove();
          spy.mockRestore();
        }
        expect(await running, 'HOME_ADVISORY_ORIGINAL_OWNER_OUTCOME').toBe(faulted ? 9 : 0);
        expect(stream).toHaveBeenCalledTimes(faulted ? 1 : 2);
        expect(durableReplies).toBe(faulted ? 1 : 2);
        expect(closed).toBe(1);
        expect(client.sqlite.open).toBe(false);
        expect(f.registry.activeOwners).toBe(0);
      } finally {
        finishRender();
        await running;
        stream.mockRestore();
        vi.restoreAllMocks();
        if (client.sqlite.open) client.sqlite.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  },
);
