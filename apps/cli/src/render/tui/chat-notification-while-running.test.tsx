import './force-color.js';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { buildChatSession } from '../../chat/session-host.js';
import { scriptedResolver } from '../../chat/test-support.js';
import { createChatModeControl } from '../../commands/chat.js';
import { resolveConfig } from '../../config/resolve.js';
import { MODE_CHANGE_RUNNING_NOTICE } from './chat-input.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * SE7-1 (the scoped security sitting of unit 7): the notification channel is held while a chat's hint row is not drawn. Before the chat drew a
 * hint row while a turn runs, a running turn was one of those states, and the hosts held the channel for it. Since the prompt block draws the
 * hint row of a running turn (and `hintFor` already prefers a notification), the hold made the refusal of a mode change SILENT while the turn
 * ran and STALE after it (`Mode changes apply between turns · Esc stops the running turn` appearing when nothing runs). These tests mount the
 * REAL hosts (`ChatApp` for the stand-alone chat, `RootApp` for the Home's chat) over their real notification channels, with a store whose turn
 * is running: the notice an announcement writes onto the channel must be on the hint row within a frame, in both renderers and both hosts.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
type Host = (typeof HOSTS)[number];

const variant = (renderer: 'alt' | 'inline'): Variant => ({
  renderer,
  color: false,
  size: { cols: 100, rows: 30 },
});

const turnCompleted = {
  type: 'session:turn_completed' as const,
  sessionId: 'matrix-session',
  sequenceNumber: 2,
  timestamp: '2026-11-26T00:00:01.000Z',
  stopReason: 'stop' as const,
  tokensUsed: { input: 1, output: 1 },
};
const turnStarted = {
  type: 'session:turn_started' as const,
  sessionId: 'matrix-session',
  sequenceNumber: 1,
  timestamp: '2026-11-26T00:00:00.000Z',
};

async function mountIn(host: Host, renderer: 'alt' | 'inline'): Promise<ChatMount> {
  const setup = {
    prepare: (store: ChatMount['store']) => store.appendUser('hi'),
    standalone: { provider: 'anthropic' },
    hosted: { session: { provider: 'anthropic' } },
  };
  const mount =
    host === 'chat'
      ? await mountHostedChat(variant(renderer), setup)
      : mountStandaloneChat(variant(renderer), setup);
  await mount.settle();
  return mount;
}

/** The last row of the live frame: the hint row of the prompt block. */
const hintRow = (mount: ChatMount): string =>
  mount
    .frame()
    .filter((row) => row.trim() !== '')
    .at(-1) ?? '';

describe.each(HOSTS)('a notification raised while a turn runs, in the %s host', (host) => {
  it.each(['alt', 'inline'] as const)(
    'is on the hint row within a frame (%s renderer), with the running hint under it gone for its few seconds',
    async (renderer) => {
      const m = await mountIn(host, renderer);
      try {
        m.store.apply(turnStarted);
        await m.until(() => hintRow(m).includes('[Ctrl+C]'));
        expect(hintRow(m), 'the running hint is the hint row before the notification').toMatch(
          /^\[Ctrl\+C\] /u,
        );
        m.notifications.notify(MODE_CHANGE_RUNNING_NOTICE, undefined, 'mode');
        const shown = await m.until(() => hintRow(m).includes('Mode changes apply between turns'));
        expect(shown, m.text()).toBe(true);
        expect(hintRow(m)).toBe(MODE_CHANGE_RUNNING_NOTICE);
        expect(
          m.notifications.getSnapshot().held,
          'the channel is not held by a turn that is running',
        ).toBe(false);
      } finally {
        m.unmount();
      }
    },
  );

  it('still holds the channel where the hint row is not drawn: while the history search owns the bottom of the view', async () => {
    const m = await mountIn(host, 'alt');
    try {
      expect(m.notifications.getSnapshot().held).toBe(false);
      m.key('\u0012'); // Ctrl+R
      await m.until(() => m.text().includes('search'));
      await m.until(() => m.notifications.getSnapshot().held);
      expect(m.notifications.getSnapshot().held).toBe(true);
    } finally {
      m.unmount();
    }
  });
});

/**
 * The whole path with the PRODUCTION control: `Shift+Tab` in a mounted chat while a turn runs reaches the real mode control, whose refusal is
 * announced on the host's real channel. The channel's hold is what made it silent, so nothing here stubs the hold; when the turn ends the control
 * withdraws the refusal, so the hint row goes back to the idle hint at once.
 */
describe.each(HOSTS)(
  'Shift+Tab while a turn runs, through the real mode control, in the %s host',
  (host) => {
    const SHIFT_TAB = '\x1b[Z';
    const dirs: string[] = [];
    const closers: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const close of closers.splice(0)) await close();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    async function mountWithControl(renderer: 'alt' | 'inline'): Promise<ChatMount> {
      const workspace = mkdtempSync(join(tmpdir(), 'relavium-notification-running-'));
      dirs.push(workspace);
      const built = await buildChatSession({
        chat: resolveConfig({}).chat,
        operatorHomeDir: workspace,
        outputStoreFactory: () => Promise.resolve(undefined),
        agentRef: undefined,
        cwd: workspace,
        providers: scriptedResolver([]),
        projectConfigDir: undefined,
        now: Date.now,
        uuid: randomUUID,
      });
      closers.push(async () => {
        built.session.cancel();
        await built.whenHostSafeToClose();
        await built.closeOutputStore?.();
        await built.closeMcp?.();
      });
      const holder: { mount?: ChatMount } = {};
      let onModeChange: ((mode: 'ask' | 'plan' | 'accept-edits' | 'auto') => void) | undefined;
      const setup = {
        prepare: (store: ChatMount['store']) => {
          store.appendUser('hi');
          const control = createChatModeControl(built, store, {
            announce: (text, topic) => holder.mount?.notifications.notify(text, undefined, topic),
            commandPaths: undefined,
          });
          onModeChange = (mode) => {
            control.onModeChange(mode);
          };
        },
        standalone: {
          provider: 'anthropic',
          onModeChange: (mode: 'ask' | 'plan' | 'accept-edits' | 'auto') => onModeChange?.(mode),
        },
        hosted: {
          session: {
            provider: 'anthropic',
            onModeChange: (mode: 'ask' | 'plan' | 'accept-edits' | 'auto') => onModeChange?.(mode),
          },
        },
      };
      const mounted =
        host === 'chat'
          ? await mountHostedChat(variant(renderer), setup)
          : mountStandaloneChat(variant(renderer), setup);
      holder.mount = mounted;
      await mounted.settle();
      return mounted;
    }

    it.each(['alt', 'inline'] as const)(
      'says the refusal on the hint row while the turn runs and not after it ends (%s renderer)',
      async (renderer) => {
        const m = await mountWithControl(renderer);
        try {
          m.store.apply(turnStarted);
          await m.until(() => hintRow(m).startsWith('[Ctrl+C]'));
          m.key(SHIFT_TAB);
          const shown = await m.until(() => hintRow(m) === MODE_CHANGE_RUNNING_NOTICE);
          expect(shown, m.text()).toBe(true);
          expect(m.store.getSnapshot().mode, 'record-first: the mode did not change').toBe('ask');
          m.store.apply(turnCompleted);
          const gone = await m.until(() => !m.text().includes('Mode changes apply between turns'));
          expect(gone, `the refusal outlived the turn it spoke about:\n${m.text()}`).toBe(true);
          expect(hintRow(m)).toMatch(/^\[\/\] commands/u);
        } finally {
          m.unmount();
        }
      },
    );
  },
);
