import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createNativePromptChannel, NATIVE_PROMPT_INPUT_LIMIT } from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { bracketed, settleFrames } from './harness-util.js';
import type { NoticeFlush } from '../../engine/effect-retention.js';

const mounts: Array<() => void> = [];
afterEach(() => {
  for (const close of mounts.splice(0)) close();
});
describe('native rejected-paste recovery', () => {
  for (const prefix of ['', 'accepted-prefix']) {
    for (const rejected of ['x'.repeat(NATIVE_PROMPT_INPUT_LIMIT + 1), 'rejected\x00control']) {
      it.each([false, true])(
        `keeps rejection visible until an explicit edit (prefix=${prefix.length}, rejected=${rejected.length}, color=%s)`,
        async (color) => {
          const { ui, flow } = createNativePromptChannel();
          flow.begin();
          let submitted: string | symbol | undefined;
          const answer = flow.password({ message: 'API key' }).then((value) => {
            submitted = value;
          });
          let flushVisible: NoticeFlush | undefined;
          const input = new OwnedTtyInput();
          const output = new OwnedTtyOutput();
          const stderr = new OwnedTtyOutput();
          output.columns = 80;
          output.rows = 24;
          const instance = render(
            <NativePromptHost
              ui={ui}
              color={color}
              onRendererReady={(flush) => {
                flushVisible = flush;
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
          mounts.push(() => {
            ui.dispose();
            instance.unmount();
            input.destroy();
            output.destroy();
            stderr.destroy();
          });
          const text = (): string => output.frames.join('');
          await vi.waitFor(() => expect(flushVisible).toBeDefined());
          const paint = async (): Promise<void> => {
            if (flushVisible === undefined) throw new Error('Native renderer was not ready');
            await flushVisible();
          };
          await vi.waitFor(() => expect(text()).toContain('API key'));
          await paint();
          if (prefix) {
            input.push(bracketed(prefix));
            await vi.waitFor(() => expect(ui.getSnapshot().display).toHaveLength(prefix.length));
          }
          input.push(bracketed(rejected));
          await vi.waitFor(() => expect(ui.getSnapshot().error).not.toBe(''));
          await paint();
          const rejection = ui.getSnapshot().error;
          input.push(bracketed('new-unaccepted-key'));
          await settleFrames();
          expect(ui.getSnapshot().display).toBe('•'.repeat(prefix.length));
          expect(ui.getSnapshot().error).toBe(rejection);
          expect(rejection).toContain('Backspace');
          expect(text()).toContain('Backspace');
          input.push('\r');
          await settleFrames();
          expect(submitted).toBeUndefined();
          input.push('\x7f');
          await vi.waitFor(() => expect(ui.getSnapshot().error).toBe(''));
          await paint();
          input.push(bracketed('replacement-key'));
          const expected = prefix.slice(0, -1) + 'replacement-key';
          await vi.waitFor(() => expect(ui.getSnapshot().display).toHaveLength(expected.length));
          await paint();
          input.push('\r');
          await answer;
          expect(submitted).toBe(expected);
          expect(JSON.stringify(ui.getSnapshot())).not.toContain('replacement-key');
          await flow.end();
          ui.dispose();
        },
      );
    }
  }
});
