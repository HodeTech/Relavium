/**
 * The chat the Home hosts keeps the same content-free mode record as the stand-alone chat
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): its `Shift+Tab` goes
 * through the Home controller's `cycle-mode` to the `onModeChange` of the session's own `createChatLineHandler`, which records every
 * effective change in the session before applying a widening one, and announces on the Home's own notification channel (never the
 * transcript, never a Home notice). Real Home, controller, builders, SQLite and Ink, on owned handle-free streams.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import type { ChatMode } from '@relavium/shared';
import { render, type Instance } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MODE_NOT_RECORDED_NOTICE, modeChangedNotice } from '../chat/mode-effects.js';
import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { acknowledgeWrite } from '../process/io.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

const ENTER = { return: true } as const;
const SHIFT_TAB = { shift: true, tab: true } as const;

async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-mode-record-')));
  const home = join(root, 'operator');
  const cwd = join(root, 'workspace');
  const configPath = join(home, '.relavium', 'config.toml');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  // The startup hint already shown, so no first-chat hint flow holds the keyboard.
  writeFileSync(configPath, '[preferences]\ndefault_mode="ask"\ndefault_mode_hint_shown=true\n');
  const client = createClient(':memory:');
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const input = new OwnedTtyInput();
  const stdout = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  stdout.columns = 110;
  stdout.rows = 30;
  let props: RootAppProps | undefined;
  let instance: Instance | undefined;
  let id = 0;
  let tick = 0;
  /** Every text the Home's own notification channel was given. */
  const notified: string[] = [];
  const deps: HomeDeps = {
    homeDir: home,
    outputStoreFactory: () => Promise.resolve(undefined),
    io: {
      nativeStdin: input,
      nativeStdout: stdout,
      nativeStderr: stderr,
      stdin: input,
      env: {},
      stdoutIsTty: true,
      stdinIsTty: true,
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: (text) => {
        stderr.write(text);
      },
      writeOutAcknowledged: (text) => acknowledgeWrite(stdout, text),
      writeErrAcknowledged: (text) => acknowledgeWrite(stderr, text),
    },
    global: {
      cwd,
      configPath,
      json: false,
      color: false,
      verbosity: 'normal',
      noAltScreen: false,
    },
    keychain: { get: () => null, set: () => undefined, delete: () => false },
    providers: scriptedResolver([textTurn('offline reply')]),
    openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
    now: () => 1_750_000_000_000 + tick++,
    uuid: () => `home-mode-record-${id++}`,
    buildSession: (buildOptions) => buildChatSession(buildOptions),
    render: (value, renderOptions) => {
      props = value;
      const channel = value.notifications;
      if (channel !== undefined) {
        const notify = channel.notify;
        vi.spyOn(channel, 'notify').mockImplementation((text, from) => {
          notified.push(text);
          notify(text, from);
        });
      }
      instance = render(createElement(RootApp, value), {
        ...renderOptions,
        stdin: input,
        stdout,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: false,
      });
      return instance;
    },
    getSize: () => ({ cols: stdout.columns, rows: stdout.rows }),
    subscribeResize: () => () => undefined,
    subscribeSignals: () => () => undefined,
    subscribeProcessExit: () => () => undefined,
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => undefined,
      onContinue: () => () => undefined,
      suspendSelf: () => undefined,
    },
    onboardingTerminalLifecycle: {
      onInput: () => () => undefined,
      isRawMode: () => false,
      setRawMode: () => undefined,
    },
    onboardingPrompter: {
      intro: () => undefined,
      outro: () => undefined,
      note: () => undefined,
      select: () => Promise.resolve(Symbol('cancel')),
      password: () => Promise.resolve(Symbol('cancel')),
      isCancel: (value): value is symbol => typeof value === 'symbol',
    },
    writeControl: () => undefined,
    exit: () => undefined,
  };
  let error: unknown;
  const outcome = driveHome(deps).catch((cause: unknown) => {
    error = cause;
  });
  await vi.waitFor(() => expect(props).toBeDefined());
  if (props === undefined) throw new Error('Home did not mount');
  const mounted = props;
  await instance?.waitUntilRenderFlush();
  const command = (text: string): void => {
    mounted.controller.handlePaste(text);
    mounted.controller.handleKey('', ENTER);
  };
  const ready = async (): Promise<void> => {
    await vi.waitFor(() => {
      const current = mounted.controller.getSnapshot();
      expect(current.mode).toBe('chat');
      expect(current.session).toBeDefined();
      expect(current.submitBusy).toBe(false);
      expect(current.session?.store.getSnapshot().state.status).toBe('idle');
    });
    await instance?.waitUntilRenderFlush();
  };
  const mode = (): ChatMode | undefined =>
    mounted.controller.getSnapshot().session?.store.getSnapshot().mode;
  /** Press Shift+Tab in the Home's chat and wait until the frame has settled. */
  const shiftTab = async (): Promise<void> => {
    mounted.controller.handleKey('', SHIFT_TAB);
    await instance?.waitUntilRenderFlush();
  };
  const transcriptNotices = (): string[] =>
    mounted.controller
      .getSnapshot()
      .session?.store.getSnapshot()
      .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : [])) ?? [];
  const modeRecords = (): string[] =>
    (
      client.sqlite
        .prepare(
          "SELECT record_from AS f, record_to AS t FROM session_messages WHERE record_kind = 'mode_change' ORDER BY sequence_number",
        )
        .all() as { f: string; t: string }[]
    ).map((row) => `${row.f}→${row.t}`);
  const close = async (): Promise<void> => {
    try {
      if (error === undefined) {
        if (mounted.controller.getSnapshot().session !== undefined) {
          command('/exit');
          await vi.waitFor(() => expect(mounted.controller.getSnapshot().mode).toBe('home'));
        }
        if (error === undefined) mounted.controller.handleKey('c', { ctrl: true });
        if (error === undefined) mounted.controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
      }
      await outcome;
    } finally {
      instance?.cleanup();
      input.destroy();
      stdout.destroy();
      stderr.destroy();
      if (client.sqlite.open) client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
  return {
    store,
    notified,
    command,
    ready,
    mode,
    shiftTab,
    transcriptNotices,
    modeRecords,
    close,
    error: () => error,
  };
}

describe('Shift+Tab in the chat the Home hosts (ADR-0148 §6)', () => {
  it('records every change in the session, announces the widening ones on the Home’s channel, and refuses a widening whose row is lost', async () => {
    const f = await fixture();
    try {
      f.command('first message');
      await f.ready();
      expect(f.mode()).toBe('ask');
      expect(f.modeRecords()).toEqual([]); // the chat's start is not a change
      for (const expected of ['plan', 'accept-edits', 'auto'] as const) {
        await f.shiftTab();
        expect(f.mode()).toBe(expected);
      }
      expect(f.modeRecords()).toEqual(['ask→plan', 'plan→accept-edits', 'accept-edits→auto']);
      expect(f.notified).toEqual([modeChangedNotice('accept-edits'), modeChangedNotice('auto')]);
      // A narrowing whose row is lost still applies, and says nothing about the row.
      vi.spyOn(f.store, 'writeTurn').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      await f.shiftTab();
      expect(f.mode()).toBe('ask');
      await f.shiftTab();
      expect(f.mode()).toBe('plan');
      // A widening whose row is lost is refused, on the Home's own channel.
      vi.spyOn(f.store, 'writeTurn').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      await f.shiftTab();
      expect(f.mode()).toBe('plan');
      expect(f.modeRecords()).toEqual([
        'ask→plan',
        'plan→accept-edits',
        'accept-edits→auto',
        'ask→plan',
      ]);
      expect(f.notified).toEqual([
        modeChangedNotice('accept-edits'),
        modeChangedNotice('auto'),
        MODE_NOT_RECORDED_NOTICE,
      ]);
      // Nothing of it in the conversation's transcript.
      expect(f.transcriptNotices().filter((text) => /mode|record/iu.test(text))).toEqual([]);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });
});
