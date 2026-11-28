import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_CANCEL,
  NATIVE_PROMPT_INPUT_LIMIT,
} from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { bracketed, settleFrames, waitFor } from './harness-util.js';
import { mountStandaloneChat, type ChatMount } from './surface-matrix/chat-host.js';
import { mountHome, type HomeMount } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

afterEach(cleanup);
describe('native prompt host', () => {
  it.each([true, false])(
    'keeps pasted secrets out of frames and snapshots, color=%s',
    async (color) => {
      const { ui, flow } = createNativePromptChannel();
      flow.begin();
      const answer = flow.password({ message: 'API key' });
      const h = render(<NativePromptHost ui={ui} color={color} />);
      Object.defineProperty(h.stdout, 'rows', { value: 24 });
      h.stdout.emit('resize');
      await waitFor(() => (h.lastFrame() ?? '').includes('API key'));
      await settleFrames();
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
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes('Key'));
    await settleFrames();
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
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    h.stdout.emit('resize');
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
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes('First key'));
    await settleFrames();
    h.stdin.write(bracketed('first-key'));
    await waitFor(() => ui.getSnapshot().display !== '');
    h.stdin.write('\rsecret-suffix');
    expect(await first).toBe('first-key');
    const second = flow.text({ message: 'Next card' });
    await waitFor(() => (h.lastFrame() ?? '').includes('Next card'));
    await settleFrames();
    expect(ui.getSnapshot().display).toBe('');
    h.stdin.write('\r');
    expect(await second).toBe('');
    await flow.end();
    ui.dispose();
  });
});

/**
 * A key's release is not a key (round 3, security L3). The CLI never turns on the kitty protocol's "report event types", but a terminal another
 * program left in it sends `ESC[13;1:3u` (the release of `Enter`) after the press that answered a card, and Ink 7 parses it as `Enter` with an
 * `eventType`: every reader of a host must drop it (`pressesOnly`), or it answers the NEXT card with its preset, or types a letter twice.
 */
const KITTY = {
  enterRelease: '\u001b[13;1:3u',
  letterRelease: '\u001b[97;1:3u',
} as const;

describe('a key release answers nothing', () => {
  it('on the native prompt host itself: the release of the Enter that answered one card does not answer the next with its preset', async () => {
    const { ui, flow } = createNativePromptChannel();
    flow.begin();
    const first = flow.select({
      message: 'First question',
      options: [
        { value: 'one', label: 'one' },
        { value: 'two', label: 'two' },
      ],
      escape: 'cancel',
    });
    const h = render(<NativePromptHost ui={ui} color={false} />);
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes('First question'));
    await settleFrames();
    h.stdin.write('\r');
    expect(await first).toBe('one');
    const second = flow.select({
      message: 'Second question',
      options: [
        { value: 'keep', label: 'keep' },
        { value: 'widen', label: 'widen' },
      ],
      initialValue: 'widen',
      escape: 'cancel',
    });
    await waitFor(() => (h.lastFrame() ?? '').includes('Second question'));
    await settleFrames();
    h.stdin.write(KITTY.enterRelease);
    await settleFrames();
    const pending = Symbol('pending');
    const early = await Promise.race([
      second,
      new Promise<symbol>((resolve) => setTimeout(() => resolve(pending), 100)),
    ]);
    expect(early).toBe(pending);
    // The card is still there and a press answers it.
    h.stdin.write('\r');
    expect(await second).toBe('widen');
    await flow.end();
    ui.dispose();
  });

  it('on the native prompt host itself: the release of a letter types nothing a second time', async () => {
    const { ui, flow } = createNativePromptChannel();
    flow.begin();
    const answer = flow.text({ message: 'Type a name', escape: 'cancel' });
    const h = render(<NativePromptHost ui={ui} color={false} />);
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes('Type a name'));
    await settleFrames();
    h.stdin.write('a');
    h.stdin.write(KITTY.letterRelease);
    await settleFrames();
    h.stdin.write('\r');
    expect(await answer).toBe('a');
    await flow.end();
    ui.dispose();
  });

  const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
  const HOSTS: readonly (readonly [string, () => ChatMount | HomeMount])[] = [
    ['the stand-alone chat', () => mountStandaloneChat(variant, { nativePrompt: true })],
    ['the Home', () => mountHome(variant, { nativePrompt: true })],
  ];

  it.each(HOSTS)(
    '%s: one answer, not two: the release of the Enter that answered a card leaves the next one pending, and a letter and its release type one letter',
    async (_name, mount) => {
      const m = mount();
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('the host has a native prompt channel');
        const visible = (): boolean => {
          try {
            channel.ui.assertVisible(channel.ui.getSnapshot());
            return true;
          } catch {
            return false;
          }
        };
        channel.flow.begin();
        const first = channel.flow.select({
          message: 'First question',
          options: [
            { value: 'one', label: 'one' },
            { value: 'two', label: 'two' },
          ],
          escape: 'cancel',
        });
        await m.until(() => m.frame().join('\n').includes('First question'));
        await m.until(visible, 200);
        await m.settle();
        m.key('\r');
        expect(await first).toBe('one');
        const second = channel.flow.select({
          message: 'Second question',
          options: [
            { value: 'keep', label: 'keep' },
            { value: 'widen', label: 'widen' },
          ],
          initialValue: 'widen',
          escape: 'cancel',
        });
        await m.until(() => m.frame().join('\n').includes('Second question'));
        await m.until(visible, 200);
        await m.settle();
        m.key(KITTY.enterRelease);
        await m.settle();
        await m.settle();
        const pending = Symbol('pending');
        const early = await Promise.race([
          second,
          new Promise<symbol>((resolve) => setTimeout(() => resolve(pending), 150)),
        ]);
        expect(early).toBe(pending);
        // A press answers it.
        m.key('\r');
        expect(await second).toBe('widen');
        // A text card: a letter and its release type ONE letter.
        const text = channel.flow.text({ message: 'Type a name', escape: 'cancel' });
        await m.until(() => m.frame().join('\n').includes('Type a name'));
        await m.until(visible, 200);
        await m.settle();
        m.key('a');
        await m.settle();
        m.key(KITTY.letterRelease);
        await m.settle();
        await m.settle();
        m.key('\r');
        expect(await text).toBe('a');
      } finally {
        m.unmount();
      }
    },
  );
});
