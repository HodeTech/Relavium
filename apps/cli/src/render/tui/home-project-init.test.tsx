import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import { runHomeProjectInit } from '../../home/project-init.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createChatStore } from './chat-store.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed, settleFrames } from './harness-util.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture(alternate: boolean, color: boolean, hold = false) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-home-init-'));
  const home = join(root, 'home'),
    cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const input = new OwnedTtyInput(),
    output = new OwnedTtyOutput(),
    stderr = new OwnedTtyOutput();
  output.columns = 80;
  output.rows = 24;
  const channel = createNativePromptChannel();
  const store = createChatStore(
    color,
    undefined,
    alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
  );
  const session = {
    store,
    sessionId: 'kept-session',
    processLine: async () => {},
    shouldStop: () => false,
    stopReason: () => 'exit' as const,
    teardown: async () => {},
  };
  let flush: NoticeFlush | undefined;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  let flushes = 0;
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => Promise.resolve(session),
    homeStore: {
      read: () => ({
        attention: { gates: [], failedRuns: [] },
        recentSessions: [],
        recentRuns: [],
        recentAgents: [],
        unreadableRunIds: [],
        isEmpty: true,
      }),
    },
    onExit: () => {},
    onError: (error) => {
      throw error;
    },
    initializeProject: () =>
      runHomeProjectInit({
        cwd,
        home,
        flow: channel.flow,
        ui: channel.ui,
        assertAdmitting: () => {},
        flushVisible: async () => {
          flushes++;
          if (flush === undefined) throw new Error('Renderer not mounted');
          await flush();
          if (hold && !held) {
            held = true;
            await gate;
          }
        },
      }),
  });
  const instance = render(
    <RootApp
      controller={controller}
      nativePrompt={channel.ui}
      nowMs={() => 0}
      color={color}
      alternateScreen={alternate}
      getSize={() => ({ cols: output.columns, rows: output.rows })}
      subscribeResize={(callback) => {
        output.on('resize', callback);
        return () => {
          output.off('resize', callback);
        };
      }}
      onRendererReady={(ready) => {
        flush = ready;
      }}
    />,
    {
      stdin: input,
      stdout: output,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: false,
    },
  );
  cleanup.push(() => {
    release();
    channel.ui.dispose();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  const paint = async (): Promise<void> => {
    if (flush === undefined) throw new Error('Renderer not mounted');
    await flush();
  };
  const open = async (chat = false): Promise<void> => {
    await vi.waitFor(() => expect(flush).toBeDefined());
    if (chat) {
      controller.handleKey('start', {});
      controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
      store.appendUser('retained context');
    }
    // The native parser treats a mixed text+CR chunk as editable multiline
    // text. A separate Return event is the terminal's submit gesture.
    input.push('/init');
    await vi.waitFor(() => expect(controller.getSnapshot().input.text).toBe('/init'));
    input.push('\r');
    await vi.waitFor(() =>
      expect(
        channel.ui.getSnapshot().kind,
        JSON.stringify({
          notice: controller.getSnapshot().notice,
          input: controller.getSnapshot().input.text,
          palette: controller.getSnapshot().palette,
          mode: controller.getSnapshot().mode,
        }),
      ).toBe('select'),
    );
    await paint();
    const snapshot = channel.ui.getSnapshot();
    expect(snapshot.options[snapshot.selected]?.value).toBe('no');
    for (const path of ['.relavium', '.relavium/workflows', '.relavium/agents'])
      expect(snapshot.note).toContain(path);
    expect(existsSync(join(cwd, '.relavium'))).toBe(false);
  };
  const approve = async (): Promise<void> => {
    input.push('\x1b[A');
    await vi.waitFor(() => {
      const snapshot = channel.ui.getSnapshot();
      expect(snapshot.options[snapshot.selected]?.value).toBe('yes');
    });
    await paint();
    input.push('\r');
  };
  const finish = async (): Promise<void> => {
    await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false));
    expect(channel.ui.getSnapshot().active).toBe(false);
  };
  const resize = (columns: number): void => {
    output.columns = columns;
    output.emit('resize');
  };
  return {
    cwd,
    channel,
    store,
    controller,
    input,
    output,
    open,
    approve,
    finish,
    release,
    resize,
    held: () => held,
    flushes: () => flushes,
  };
}

describe.each([false, true])('Home init alternate=%s', (alternate) => {
  it('does not let bracketed paste confirm or enter the underlying Home editor', async () => {
    const f = fixture(alternate, false);
    await f.open();
    f.input.push(bracketed('yes\r/init'));
    await settleFrames();
    const snapshot = f.channel.ui.getSnapshot();
    expect(snapshot.kind).toBe('select');
    expect(snapshot.options[snapshot.selected]?.value).toBe('no');
    expect(f.controller.getSnapshot().input.text).toBe('');
    expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
    f.input.push('\r');
    await f.finish();
    expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
  });
  for (const chat of [false, true]) {
    it.each([false, true])(
      `lists directories and requires explicit yes (chat=${chat}, color=%s)`,
      async (color) => {
        const f = fixture(alternate, color);
        await f.open(chat);
        await f.approve();
        await f.finish();
        expect(readdirSync(join(f.cwd, '.relavium')).sort()).toEqual(['agents', 'workflows']);
        expect(f.controller.getSnapshot().notice).toContain('Created');
        if (chat) {
          expect(f.controller.getSnapshot().session?.store).toBe(f.store);
          expect(
            f.store
              .getSnapshot()
              .state.transcript.filter((entry) => entry.role === 'user')
              .map((entry) => entry.text),
          ).toEqual(['retained context']);
          if (!alternate)
            expect(f.output.frames.join('').split('retained context')).toHaveLength(2);
        }
      },
    );
  }
  it.each(['no', 'escape', 'ctrl-c'] as const)(
    '%s cancels without any project write',
    async (choice) => {
      const f = fixture(alternate, false);
      await f.open();
      f.input.push(choice === 'no' ? '\r' : choice === 'escape' ? '\x1b' : '\x03');
      await f.finish();
      expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
      expect(f.controller.getSnapshot().notice).toContain('cancelled');
    },
  );
  it.each(['recover', 'cancel'] as const)(
    'blocks publication after shrink and can %s',
    async (action) => {
      const f = fixture(alternate, false, true);
      await f.open(true);
      await f.approve();
      await vi.waitFor(() => expect(f.held()).toBe(true));
      f.resize(0.5);
      f.release();
      // At half a column even the resize instruction is physically clipped.
      // Observe the retried visibility wait, rather than treating fallback text as an ACK.
      await vi.waitFor(() => expect(f.flushes()).toBeGreaterThanOrEqual(2));
      expect(f.controller.getSnapshot().nativeActionBusy).toBe(true);
      expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
      if (action === 'cancel') f.input.push('\x1b');
      else f.resize(80);
      await f.finish();
      expect(existsSync(join(f.cwd, '.relavium'))).toBe(action === 'recover');
      expect(f.controller.getSnapshot().session?.store).toBe(f.store);
    },
  );
});
