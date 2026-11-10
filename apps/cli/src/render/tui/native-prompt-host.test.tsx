import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_CANCEL,
  NATIVE_PROMPT_INPUT_LIMIT,
} from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { bracketed, waitFor } from './harness-util.js';

afterEach(cleanup);
describe('native prompt host', () => {
  it.each([true, false])(
    'keeps pasted secrets out of frames and snapshots, color=%s',
    async (color) => {
      const { ui, flow } = createNativePromptChannel();
      flow.begin();
      const answer = flow.password({ message: 'API key' });
      const h = render(<NativePromptHost ui={ui} color={color} />);
      await waitFor(() => (h.lastFrame() ?? '').includes('API key'));
      h.stdin.write(bracketed('example-super-secret-4829'));
      await waitFor(() => ui.getSnapshot().display.length > 0);
      expect(JSON.stringify(ui.getSnapshot())).not.toContain('4829');
      expect(h.lastFrame()).not.toContain('secret');
      h.stdin.write('\rtrailing-secret');
      expect(await answer).toBe('example-super-secret-4829');
      expect(JSON.stringify(ui.getSnapshot())).not.toContain('secret');
      await flow.end();
      ui.dispose();
    },
  );
  it('rejects oversized paste instead of truncating a key', async () => {
    const { ui, flow } = createNativePromptChannel();
    flow.begin();
    const answer = flow.password({ message: 'Key' });
    const h = render(<NativePromptHost ui={ui} color={false} />);
    await waitFor(() => (h.lastFrame() ?? '').includes('Key'));
    h.stdin.write(bracketed('a'.repeat(NATIVE_PROMPT_INPUT_LIMIT + 1)));
    await waitFor(() => ui.getSnapshot().error !== '');
    expect(ui.getSnapshot().display).toBe('');
    h.stdin.write('\r');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ui.getSnapshot().kind).toBe('password');
    expect(ui.getSnapshot().error).not.toBe('');
    h.stdin.write('\x1b');
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
    await flow.end();
    ui.dispose();
  });
  it('accepts cancel while busy and clears the channel on disposal', async () => {
    const { ui, flow } = createNativePromptChannel();
    const signal = flow.begin();
    flow.busy('Checking');
    const h = render(<NativePromptHost ui={ui} color={false} />);
    await waitFor(() => (h.lastFrame() ?? '').includes('Checking'));
    h.stdin.write('\x03');
    await waitFor(() => signal.aborted);
    await flow.end();
    ui.dispose();
    expect(ui.getSnapshot().active).toBe(false);
  });
  it('does not transfer an Enter suffix to the next card', async () => {
    const { ui, flow } = createNativePromptChannel();
    flow.begin();
    const first = flow.password({ message: 'First key' });
    const h = render(<NativePromptHost ui={ui} color={false} />);
    await waitFor(() => (h.lastFrame() ?? '').includes('First key'));
    h.stdin.write(bracketed('first-key'));
    await waitFor(() => ui.getSnapshot().display !== '');
    h.stdin.write('\rsecret-suffix');
    expect(await first).toBe('first-key');
    const second = flow.text({ message: 'Next card' });
    await waitFor(() => (h.lastFrame() ?? '').includes('Next card'));
    expect(ui.getSnapshot().display).toBe('');
    h.stdin.write('\r');
    expect(await second).toBe('');
    await flow.end();
    ui.dispose();
  });
});
