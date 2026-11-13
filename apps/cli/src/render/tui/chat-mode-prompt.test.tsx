import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NoticeFlush } from '../../engine/effect-retention.js';
import { loadResolvedConfig } from '../../config/load.js';
import { runModeSettings } from '../../chat/mode-settings.js';
import { publishModePreference } from '../../chat/mode-preference-publication.js';
import { createStartingModeRuntime } from '../../chat/starting-mode.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createSuspendPort } from '../suspend.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { bracketed, settleFrames } from './harness-util.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

class HeldOutput extends OwnedTtyOutput {
  held = false;
  blockedWrite: (() => void) | undefined;
  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    super._write(
      chunk,
      encoding,
      this.held
        ? () => {
            this.blockedWrite = () => callback();
          }
        : callback,
    );
  }
  override _writev(
    chunks: Array<{ chunk: unknown; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    let index = 0;
    const next = (): void => {
      const part = chunks[index++];
      if (part === undefined) callback();
      else this._write(part.chunk, part.encoding, next);
    };
    next();
  }
  release(): void {
    this.held = false;
    const pending = this.blockedWrite;
    this.blockedWrite = undefined;
    pending?.();
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(alternateScreen = false) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-chat-mode-prompt-'));
  const home = join(root, 'home'),
    cwd = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(cwd);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true);
  const input = new OwnedTtyInput(),
    output = new HeldOutput(),
    stderr = new OwnedTtyOutput();
  output.columns = 80;
  output.rows = 24;
  const store = createChatStore(
    false,
    undefined,
    alternateScreen ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
  );
  store.setMode('accept-edits');
  store.notice('MODE_TRANSCRIPT_ALREADY_PRINTED');
  const channel = createNativePromptChannel();
  const suspendPort = createSuspendPort();
  const errors: unknown[] = [];
  const submitted = vi.fn<() => Promise<void>>(() => Promise.resolve());
  let visibleFlush: NoticeFlush | undefined;
  let active = true;
  const assertAdmitting = (): void => {
    if (!active) throw new Error('original chat is closed');
  };
  const app = render(
    <ChatApp
      store={store}
      onSubmit={submitted}
      shouldStop={() => false}
      onExit={() => {}}
      onModeChange={(mode) => store.setMode(mode)}
      onError={(error) => {
        errors.push(error);
      }}
      alternateScreen={alternateScreen}
      suspendPort={suspendPort}
      modePrompt={{
        ui: channel.ui,
        ready: (flush) => {
          visibleFlush = flush;
        },
      }}
    />,
    {
      stdin: input,
      stdout: output,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen,
    },
  );
  const exited = app.waitUntilExit();
  const rendered = async (): Promise<void> => {
    await settleFrames();
    await app.waitUntilRenderFlush();
    await settleFrames();
  };
  const settings = (live = true): Promise<void> =>
    runModeSettings({
      runtime,
      cwd,
      interactive: true,
      flow: channel.flow,
      assertAdmitting,
      ...(live
        ? {
            currentMode: () => store.getSnapshot().mode,
            onCurrentMode: (mode) => store.setMode(mode),
          }
        : {}),
      notice: (text) => store.notice(text),
      publish: (prepared, check) =>
        publishModePreference({
          prepared,
          flow: channel.flow,
          ui: channel.ui,
          flushVisible: () => visibleFlush,
          assertAdmitting: check,
        }),
    });
  const key = async (text: string): Promise<void> => {
    input.push(text);
    await rendered();
  };
  const choose = async (value: string): Promise<void> => {
    await rendered();
    const target = channel.ui.getSnapshot().options.findIndex((option) => option.value === value);
    expect(target).toBeGreaterThanOrEqual(0);
    for (let remaining = channel.ui.getSnapshot().options.length; remaining > 0; remaining--) {
      if (channel.ui.getSnapshot().selected === target) break;
      await key('\x1b[B');
    }
    expect(channel.ui.getSnapshot().selected).toBe(target);
    await key('\r');
  };
  const close = (): void => {
    active = false;
    channel.ui.dispose();
  };
  cleanups.push(async () => {
    output.release();
    close();
    app.unmount();
    await exited;
    input.destroy();
    output.destroy();
    stderr.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    app,
    input,
    output,
    store,
    channel,
    runtime,
    errors,
    submitted,
    settings,
    rendered,
    key,
    choose,
    close,
    suspendPort,
    text: () => output.frames.join(''),
  };
}

describe('mounted standalone chat mode prompt', () => {
  it.each([false, true])(
    'keeps current mode/footer and the existing transcript across the picker, alternate=%s',
    async (alternate) => {
      const f = fixture(alternate);
      await f.rendered();
      expect(f.text()).toContain('accept-edits mode');
      const before = f.store.getSnapshot().state.transcript;
      const task = f.settings();
      await f.rendered();
      expect(f.text()).toContain('Current mode: accept-edits');
      await f.choose('plan');
      await task;
      await f.rendered();
      expect(f.store.getSnapshot().mode).toBe('plan');
      expect(f.text()).toContain('plan mode');
      expect(f.store.getSnapshot().state.transcript.slice(0, before.length)).toEqual(before);
      if (!alternate) expect(f.text().split('MODE_TRANSCRIPT_ALREADY_PRINTED')).toHaveLength(2);
      expect(f.submitted).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    },
  );

  it('requires visible explicit Yes for auto; paste and a coalesced transition never save it', async () => {
    const f = fixture();
    await f.rendered();
    mkdirSync(join(f.runtime.homeDir, '.relavium'));
    writeFileSync(f.runtime.configPath, '[preferences]\ndefault_mode = "ask"\n');
    const task = f.settings();
    await f.choose('save-startup');
    await f.rendered();
    await f.key('\x1b[B');
    await f.key('\x1b[B');
    await f.key('\x1b[B');
    expect(f.channel.ui.getSnapshot().options[f.channel.ui.getSnapshot().selected]?.value).toBe(
      'auto',
    );
    f.input.push('\r\r');
    await f.rendered();
    expect(f.channel.ui.getSnapshot().message).toContain('without approval');
    expect(f.channel.ui.getSnapshot().options[f.channel.ui.getSnapshot().selected]?.value).toBe(
      'no',
    );
    await f.key(bracketed('yes\r'));
    expect(f.channel.ui.getSnapshot().options[f.channel.ui.getSnapshot().selected]?.value).toBe(
      'no',
    );
    expect(readFileSync(f.runtime.configPath, 'utf8')).toContain('default_mode = "ask"');
    await f.choose('yes');
    await task;
    expect(readFileSync(f.runtime.configPath, 'utf8')).toContain('default_mode = "auto"');
    expect(f.text()).toContain('Saving preferences rewrites the global config');
    expect(f.store.getSnapshot().mode).toBe('accept-edits');
    expect(f.runtime.resolve(f.runtime.homeDir).startingMode.mode).toBe('auto');
    expect(f.submitted).not.toHaveBeenCalled();
    await f.key('\r');
    // ChatApp forwards an empty submit; no pasted/native prompt byte survived in its editor.
    expect(f.submitted).toHaveBeenCalledExactlyOnceWith('', '');
  });

  it('rejects unflushed and undersized selection, then needs fresh resized visibility', async () => {
    const f = fixture();
    await f.rendered();
    f.output.held = true;
    const task = f.settings();
    await vi.waitFor(() => expect(f.output.blockedWrite).toBeDefined());
    f.input.push('\x1b[B\r');
    await settleFrames();
    expect(f.channel.ui.getSnapshot().selected).toBe(2);
    expect(f.store.getSnapshot().mode).toBe('accept-edits');
    f.output.release();
    await f.rendered();
    f.output.columns = 79;
    f.output.rows = 23;
    f.output.emit('resize');
    await f.rendered();
    expect(f.text()).toContain('Terminal too small');
    f.input.push('\r');
    await f.rendered();
    expect(f.channel.ui.getSnapshot().active).toBe(true);
    f.output.held = true;
    f.output.columns = 80;
    f.output.rows = 24;
    f.output.emit('resize');
    await vi.waitFor(() => expect(f.output.blockedWrite).toBeDefined());
    f.input.push('\r');
    await settleFrames();
    expect(f.channel.ui.getSnapshot().active).toBe(true);
    f.output.release();
    await f.choose('ask');
    await task;
    expect(f.store.getSnapshot().mode).toBe('ask');
  });

  it('cancels a pending picker when its owning chat closes and never submits its bytes', async () => {
    const f = fixture();
    await f.rendered();
    const task = f.settings();
    await f.rendered();
    f.close();
    await task;
    await f.rendered();
    expect(f.channel.ui.getSnapshot().active).toBe(false);
    expect(f.store.getSnapshot().mode).toBe('accept-edits');
    expect(f.submitted).not.toHaveBeenCalled();
    expect(() => readFileSync(f.runtime.configPath)).toThrow();
  });

  it('reports actual output closure to the owner, whose disposal cancels the pending selection', async () => {
    const f = fixture();
    await f.rendered();
    const task = f.settings();
    await f.rendered();
    f.output.destroy();
    await vi.waitFor(() => expect(f.errors.length).toBeGreaterThan(0));
    // driveOneSession owns this disposal; this component fixture exercises its UI port boundary.
    f.close();
    await task;
    expect(f.channel.ui.getSnapshot().active).toBe(false);
    expect(f.store.getSnapshot().mode).toBe('accept-edits');
    expect(() => readFileSync(f.runtime.configPath)).toThrow();
    expect(f.submitted).not.toHaveBeenCalled();
  });

  it('requires a newly flushed prompt after external terminal suspension and reclaim', async () => {
    const f = fixture();
    await f.rendered();
    const task = f.settings();
    await f.rendered();
    const suspend = f.suspendPort.current();
    expect(suspend).toBeDefined();
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release: (() => void) | undefined;
    const external = new Promise<void>((resolve) => {
      release = resolve;
    });
    const suspended = suspend?.(async () => {
      enter?.();
      await external;
    });
    await entered;
    expect(f.suspendPort.isSuspended()).toBe(true);
    expect(f.input.isRaw).toBe(false);
    f.output.held = true;
    release?.();
    await vi.waitFor(() => expect(f.output.blockedWrite).toBeDefined());
    // The enclosing ChatApp keeps suspension custody through the actual reclaim flush.
    expect(f.suspendPort.isSuspended()).toBe(true);
    f.input.push('\r');
    await settleFrames();
    expect(f.channel.ui.getSnapshot().active).toBe(true);
    f.output.release();
    await suspended;
    await f.choose('plan');
    await task;
    expect(f.store.getSnapshot().mode).toBe('plan');
    expect(f.submitted).not.toHaveBeenCalled();
  });
});
