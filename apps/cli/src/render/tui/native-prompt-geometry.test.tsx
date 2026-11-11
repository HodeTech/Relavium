import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_CANCEL,
  NativePromptVisibilityRefusedError,
} from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { createSuspendPort } from '../suspend.js';

const mounts: Array<() => void> = [];
afterEach(() => {
  for (const close of mounts.splice(0)) close();
});
function fixture(cols: number, rows: number) {
  const input = new OwnedTtyInput();
  const output = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  output.columns = cols;
  output.rows = rows;
  const channel = createNativePromptChannel();
  channel.flow.begin();
  let flush: NoticeFlush | undefined;
  const instance = render(
    createElement(NativePromptHost, {
      ui: channel.ui,
      color: false,
      onRendererReady: (ready) => {
        flush = ready;
      },
    }),
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
  mounts.push(() => {
    channel.ui.dispose();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  const text = (): string => output.frames.join('');
  const ready = async (): Promise<NoticeFlush> => {
    await vi.waitFor(() => expect(flush).toBeDefined());
    if (!flush) throw new Error('not mounted');
    return flush;
  };
  const resize = (columns: number, height: number): void => {
    output.columns = columns;
    output.rows = height;
    output.emit('resize');
  };
  return { input, output, channel, text, ready, resize };
}

describe('native prompt geometry and visible acknowledgement', () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'blocks input at invalid initial columns %s and recovers after resize',
    async (columns) => {
      const f = fixture(columns, 24);
      const answer = f.channel.flow.select({
        message: 'Allow source?',
        options: [{ value: 'yes', label: 'Yes' }],
      });
      await f.ready();
      f.input.push('\r');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.channel.ui.getSnapshot().kind).toBe('select');
      f.resize(80, 24);
      await vi.waitFor(() => expect(f.text()).toContain('Allow source?'));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      f.input.push('\r');
      expect(await answer).toBe('yes');
      await f.channel.flow.end();
    },
  );
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 23])(
    'blocks input at unusable row count %s',
    async (rows) => {
      const f = fixture(80, rows);
      const answer = f.channel.flow.password({ message: 'Secret key' });
      await f.ready();
      f.input.push('unseen-secret');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.channel.ui.getSnapshot().display).toBe('');
      f.input.push('\x1b');
      expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
      await f.channel.flow.end();
    },
  );
  it('waits for the exact notice to be visible after a geometry recovery', async () => {
    const f = fixture(0.5, 24);
    f.channel.flow.busy('Saving');
    const flush = await f.ready();
    let done = false;
    const pending = flush(() =>
      f.channel.flow.note('Saving preferences removes comments and ordering.'),
    ).then(() => {
      done = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    f.resize(80, 24);
    await pending;
    expect(f.text()).toContain('Saving preferences removes comments and ordering.');
    await f.channel.flow.end();
  });
  it('cancels a suspended visibility wait without settling it as a successful paint', async () => {
    const f = fixture(0.5, 24);
    f.channel.flow.busy('Saving');
    const flush = await f.ready();
    const pending = flush(() =>
      f.channel.flow.note('Saving preferences removes comments and ordering.'),
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const signal = f.channel.ui.signal();
    f.input.push('\x1b');
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(await outcome).toBe(signal?.reason);
    await f.channel.flow.end();
  });
  it('refuses an oversized decision instead of accepting a clipped card', async () => {
    const f = fixture(80, 24);
    const answer = f.channel.flow.select({
      message: 'Disclosure ' + 's'.repeat(4000),
      options: [{ value: 'yes', label: 'Yes' }],
    });
    await f.ready();
    await vi.waitFor(() => expect(f.text()).toContain('Prompt does not fit'));
    expect(f.text()).not.toContain('Disclosure ');
    f.input.push('\r');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(f.channel.ui.getSnapshot().kind).toBe('select');
    f.input.push('\x1b');
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
    await f.channel.flow.end();
  });
  it('invalidates an acknowledged notice immediately on shrink and permits fresh visible recovery', async () => {
    const f = fixture(80, 24);
    f.channel.flow.busy('Saving');
    const flush = await f.ready();
    await flush(() => f.channel.flow.note('Saving preferences removes comments and ordering.'));
    const expected = f.channel.ui.getSnapshot();
    expect(() => f.channel.ui.assertVisible(expected)).not.toThrow();
    f.resize(0.5, 24);
    expect(() => f.channel.ui.assertVisible(expected)).toThrow(NativePromptVisibilityRefusedError);
    f.resize(80, 24);
    await flush();
    expect(() => f.channel.ui.assertVisible(expected)).not.toThrow();
    await f.channel.flow.end();
  });
  it('does not acknowledge a notice when the terminal shrinks during its actual paint', async () => {
    const f = fixture(80, 24);
    f.channel.flow.busy('Saving');
    const flush = await f.ready();
    let shrunk = false;
    f.output.onFrame = (frame) => {
      if (!shrunk && frame.includes('Saving preferences')) {
        shrunk = true;
        f.output.columns = 0.5;
        setImmediate(() => f.output.emit('resize'));
      }
    };
    let done = false;
    const pending = flush(() =>
      f.channel.flow.note('Saving preferences removes comments and ordering.'),
    ).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(shrunk).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    f.resize(80, 24);
    await pending;
    expect(done).toBe(true);
    await f.channel.flow.end();
  });
  it('does not hold the suspend lease while waiting for a visible resize', async () => {
    const input = new OwnedTtyInput(),
      output = new OwnedTtyOutput(),
      stderr = new OwnedTtyOutput();
    output.columns = 0.5;
    output.rows = 24;
    const channel = createNativePromptChannel();
    channel.flow.begin();
    channel.flow.busy('Saving');
    const port = createSuspendPort();
    let flush: NoticeFlush | undefined;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let suspended = false;
    const instance = render(
      createElement(NativePromptHost, {
        ui: channel.ui,
        color: false,
        suspendPort: port,
        onSuspend: () => {
          const suspend = port.current();
          if (suspend)
            void suspend(async () => {
              suspended = true;
              await held;
            });
        },
        onRendererReady: (ready) => {
          flush = ready;
        },
      }),
      {
        stdin: input,
        stdout: output,
        stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    mounts.push(() => {
      channel.ui.dispose();
      instance.unmount();
      input.destroy();
      output.destroy();
      stderr.destroy();
    });
    await vi.waitFor(() => expect(flush).toBeDefined());
    if (!flush) throw new Error('not mounted');
    const pending = flush(() => channel.flow.note('Saving preferences removes comments.'));
    input.push('\x1a');
    await vi.waitFor(() => expect(suspended).toBe(true));
    release();
    await vi.waitFor(() => expect(port.isSuspended()).toBe(false));
    output.columns = 80;
    output.emit('resize');
    await pending;
    await channel.flow.end();
  });
});
