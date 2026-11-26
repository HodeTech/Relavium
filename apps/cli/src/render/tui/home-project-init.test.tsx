/**
 * `/init` on the Home as a popup (MVP-11 unit 6, 6.3; ADR-0148 §1, §3, §6), mounted in the real Home with the real channel and the real
 * `prepareProjectInit` over a temporary directory: the chord card that names every directory, `Ctrl+Y` as the only Yes (after the card's own
 * guards), the write held behind the visibility proof, and the Done step that names what was created. Nothing is written to the Home's notice
 * or a transcript: a cancel is one notification on the Home's channel.
 *
 * The channel runs on the real clock, so the waits are real and named.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import {
  INIT_ALLOW_LABEL,
  INIT_CANCELLED,
  INIT_CREATED,
  INIT_CREATING,
  INIT_DENY_LABEL,
  INIT_QUESTION,
  runHomeProjectInit,
} from '../../home/project-init.js';
import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createChatStore } from './chat-store.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed, settleFrames } from './harness-util.js';
import { APPROVAL_LOCKOUT_MS, APPROVAL_QUIET_MS, APPROVAL_SETTLE_MS } from './tool-review-model.js';

/** A real wait past the flow's opening settle and the chord card's dwell and quiet gap (the channel's clock is the real one). */
const PAST_THE_GUARDS_MS =
  Math.max(POPUP_SELECT_SETTLE_MS, APPROVAL_SETTLE_MS) + APPROVAL_QUIET_MS + 150;
/**
 * A real wait, from the moment the card is on screen, past the lockout that runs from the moment it opened (the `/init` card is the flow's
 * first prompt: no answer came before it, so its own opening is what a held key meets). The other guards are shorter.
 */
const PAST_THE_LOCKOUT_MS = APPROVAL_LOCKOUT_MS + 150;
/** How long a key that must change nothing is watched. */
const WATCH_MS = 150;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** The bound of every `vi.waitFor` of this file: a step that needs more is a defect, not a slow machine (the default second is not a bound). */
const STEP_WAIT_MS = 5000;

const CTRL_Y = '\u0019';
const CTRL_N = '\u000e';

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
  const announced: string[] = [];
  const controller = createHomeController({
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
    announce: (text) => announced.push(text),
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
  /** Whether the prompt on the channel now is the frame on the terminal, measured and flushed. */
  const shownNow = (): boolean => {
    try {
      channel.ui.assertVisible(channel.ui.getSnapshot());
      return true;
    } catch {
      return false;
    }
  };
  /** Everything the renderer wrote (a frame can be written in several chunks). */
  const frame = (): string => output.frames.join('');
  const open = async (): Promise<void> => {
    await vi.waitFor(() => expect(flush).toBeDefined(), { timeout: STEP_WAIT_MS });
    // The native parser treats a mixed text+CR chunk as editable multiline
    // text. A separate Return event is the terminal's submit gesture.
    input.push('/init');
    await vi.waitFor(() => expect(controller.getSnapshot().input.text).toBe('/init'), {
      timeout: STEP_WAIT_MS,
    });
    input.push('\r');
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: STEP_WAIT_MS,
    });
    await paint();
    const snapshot = channel.ui.getSnapshot();
    expect(snapshot.message).toBe(INIT_QUESTION);
    expect(snapshot.popup?.title).toBe('/init');
    expect(snapshot.popup?.stepIndex).toBe(1);
    expect(snapshot.popup?.stepNames).toEqual(['Check', 'Confirm', 'Done']);
    for (const path of ['.relavium/', '.relavium/workflows/', '.relavium/agents/'])
      expect(snapshot.details.join(' ')).toContain(path);
    expect(snapshot.options.map((option) => option.label)).toEqual([
      INIT_ALLOW_LABEL,
      INIT_DENY_LABEL,
    ]);
    await vi.waitFor(() => expect(shownNow()).toBe(true), { timeout: STEP_WAIT_MS });
    expect(existsSync(join(cwd, '.relavium'))).toBe(false);
  };
  /** `Ctrl+Y` once, after the card's guards (its lockout the longest): a key pressed inside them would be refused and restart the lockout. */
  const approve = async (): Promise<void> => {
    await pause(PAST_THE_LOCKOUT_MS);
    input.push(CTRL_Y);
  };
  /** The Done step, measured and flushed: what it says and what its one option names. */
  const doneUp = async (): Promise<void> => {
    await vi.waitFor(() => expect(channel.ui.getSnapshot().final).toBeDefined(), {
      timeout: STEP_WAIT_MS,
    });
    await vi.waitFor(() => expect(shownNow()).toBe(true), { timeout: STEP_WAIT_MS });
  };
  const closeDone = async (): Promise<void> => {
    await doneUp();
    input.push('\r');
  };
  const finish = async (): Promise<void> => {
    await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false), {
      timeout: STEP_WAIT_MS,
    });
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
    announced,
    frame,
    open,
    approve,
    doneUp,
    closeDone,
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
    await pause(WATCH_MS);
    expect(f.channel.ui.getSnapshot().kind).toBe('chord');
    expect(f.controller.getSnapshot().input.text).toBe('');
    expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
    f.input.push('\x1b');
    await f.finish();
    expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
  });
  it.each([false, true])(
    'lists directories, creates them only on Ctrl+Y, and ends in a Done step that names them (color=%s)',
    async (color) => {
      const f = fixture(alternate, color);
      await f.open();
      await f.approve();
      await f.doneUp();
      const done = f.channel.ui.getSnapshot();
      expect(done.kind).toBe('select');
      expect(done.final).toBe('ok');
      expect(done.message).toBe(INIT_CREATED);
      expect(done.popup?.stepIndex).toBe(2);
      expect(done.details).toEqual(
        expect.arrayContaining(['.relavium/', '.relavium/workflows/', '.relavium/agents/']),
      );
      // The target is drawn once, as the first row under the sentence; the step's one option (`Close`) names nothing.
      expect(done.details[0]).toBe('.relavium/');
      expect(done.options[0]?.hint).toBeUndefined();
      expect(f.frame()).toContain(INIT_CREATED);
      // the write happened behind the Done step, before it closed
      expect(readdirSync(join(f.cwd, '.relavium')).sort()).toEqual(['agents', 'workflows']);
      f.input.push('\r');
      await f.finish();
      // no residue: no Home notice, no transcript line, no notification (the Done step said it)
      expect(f.controller.getSnapshot().notice).toBeUndefined();
      expect(f.store.getSnapshot().state.transcript).toEqual([]);
      expect(f.announced).toEqual([]);
    },
  );
  it('is the Home’s: in the chat the Home hosts, /init answers one line that names the Home, and no flow opens (ADR-0145 §7.5, OD-2)', async () => {
    const f = fixture(alternate, false);
    await settleFrames();
    f.controller.handleKey('start', {});
    f.controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(f.controller.getSnapshot().mode).toBe('chat'), {
      timeout: STEP_WAIT_MS,
    });
    f.store.appendUser('retained context');
    f.input.push('/init');
    await vi.waitFor(() => expect(f.controller.getSnapshot().input.text).toBe('/init'), {
      timeout: STEP_WAIT_MS,
    });
    f.input.push('\r');
    await vi.waitFor(
      () =>
        expect(
          f.store
            .getSnapshot()
            .state.transcript.some(
              (entry) =>
                entry.role === 'notice' && entry.text === '/init is available from the Home.',
            ),
        ).toBe(true),
      { timeout: STEP_WAIT_MS },
    );
    await settleFrames();
    expect(f.channel.ui.getSnapshot().active, 'no popup or prompt opened').toBe(false);
    expect(f.controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(f.controller.getSnapshot().session?.store).toBe(f.store);
    expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
    expect(
      f.store
        .getSnapshot()
        .state.transcript.filter((entry) => entry.role === 'user')
        .map((entry) => entry.text),
    ).toEqual(['retained context']);
  });
  it.each(['ctrl-n', 'escape', 'ctrl-c'] as const)(
    '%s cancels without any project write, in one notification and no notice',
    async (choice) => {
      const f = fixture(alternate, false);
      await f.open();
      await pause(PAST_THE_GUARDS_MS);
      f.input.push(choice === 'ctrl-n' ? CTRL_N : choice === 'escape' ? '\x1b' : '\x03');
      await f.finish();
      expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
      expect(f.controller.getSnapshot().notice).toBeUndefined();
      expect(f.announced).toEqual([INIT_CANCELLED]);
    },
  );
  it('a Ctrl+Y inside the card’s dwell and the lockout that runs from its opening creates nothing (the chord guard is the channel’s)', async () => {
    const f = fixture(alternate, false);
    await f.open();
    f.input.push(CTRL_Y);
    await pause(WATCH_MS);
    expect(f.channel.ui.getSnapshot().kind).toBe('chord');
    expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
    f.input.push('\x1b');
    await f.finish();
    expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
  });
  it.each(['recover', 'cancel'] as const)(
    'blocks publication after shrink and can %s (the write is behind the visibility proof of the framed wait)',
    async (action) => {
      const f = fixture(alternate, false, true);
      await f.open();
      await f.approve();
      await vi.waitFor(() => expect(f.held()).toBe(true), { timeout: STEP_WAIT_MS });
      expect(f.channel.ui.getSnapshot().kind).toBe('busy');
      // the wait the visibility proof is held to says what it waits for, in the popup's frame
      expect(f.channel.ui.getSnapshot().message).toBe(INIT_CREATING);
      expect(f.channel.ui.getSnapshot().popup?.title).toBe('/init');
      f.resize(0.5);
      f.release();
      // At half a column even the resize instruction is physically clipped.
      // Observe the retried visibility wait, rather than treating fallback text as an ACK.
      await vi.waitFor(() => expect(f.flushes()).toBeGreaterThanOrEqual(2), {
        timeout: STEP_WAIT_MS,
      });
      expect(f.controller.getSnapshot().nativeActionBusy).toBe(true);
      expect(existsSync(join(f.cwd, '.relavium'))).toBe(false);
      if (action === 'cancel') f.input.push('\x1b');
      else {
        f.resize(80);
        await f.closeDone();
      }
      await f.finish();
      expect(existsSync(join(f.cwd, '.relavium'))).toBe(action === 'recover');
      expect(f.announced).toEqual(action === 'cancel' ? [INIT_CANCELLED] : []);
      expect(
        f.controller.getSnapshot().session,
        '/init is the Home’s: no chat is in front',
      ).toBeUndefined();
    },
  );
});
