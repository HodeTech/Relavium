import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createHomeController } from './home-controller.js';
import { HomeView } from './home-view.js';
import { RootApp } from './home-app.js';
import { settleFrames, waitFor } from './harness-util.js';
import { createNativePromptChannel, NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';

afterEach(cleanup);

/**
 * The keyless Home and a failed build, as the frame shows them at the 80x24 minimum (MVP-11 Step 2.4, ADR-0146 §5 and §6): the failure is
 * wrapped whole in the notice area (the one-row line cut the remedy off, observed), and the hint bar says what `Enter` does while there is
 * no key and that the typed message is kept.
 */

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const REMEDY =
  "no API key for provider 'anthropic' — open `/providers` to connect a key or review its source.";

/** The words of a frame, as a person reads them across rows: whitespace collapsed. */
const words = (frame: string): string => frame.replace(/\s+/gu, ' ').trim();

describe('a failed build at 80 columns', () => {
  it('shows the whole failure across rows, with the remedy readable, and gives the message back to the prompt', async () => {
    const controller = createHomeController({
      homeStore: { read: () => EMPTY },
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: () => Promise.reject(new Error(REMEDY)),
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const h = render(
      <RootApp
        controller={controller}
        nowMs={() => 0}
        color={false}
        getSize={() => ({ cols: 80, rows: 24 })}
        subscribeResize={() => () => {}}
      />,
    );
    for (const ch of 'hello there') controller.handleKey(ch, {});
    controller.handleKey('', { return: true });
    await waitFor(() => (h.lastFrame() ?? '').includes('Couldn’t start the chat'));
    await settleFrames();
    const frame = h.lastFrame() ?? '';
    // The whole message is on screen: nothing is cut at the edge, so the remedy (the part after the dash) is readable.
    expect(words(frame)).toContain(`Couldn’t start the chat: ${REMEDY}`);
    expect(frame, 'the remedy is not the part that is cut').toContain('review its source.');
    // Across rows: it wrapped, instead of being truncated with an ellipsis on one row.
    expect(
      frame.split('\n').filter((row) => row.includes('provider') || row.includes('source')).length,
    ).toBeGreaterThan(1);
    expect(frame).not.toContain('…');
    for (const row of frame.split('\n')) expect(row.length, row).toBeLessThanOrEqual(80);
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    // The message came back to the prompt.
    expect(frame).toContain('> hello there');
    expect(controller.getSnapshot().input.text).toBe('hello there');
  });
});

describe('the keyless hint bar', () => {
  const frameOf = (text: string, keyless: boolean): string => {
    const view = render(
      <HomeView
        snapshot={EMPTY}
        editor={{ text, cursor: text.length }}
        nowMs={0}
        cols={80}
        rows={24}
        color={false}
        keyless={keyless}
      />,
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    return frame;
  };

  it('keyless and idle: Enter connects a provider, / opens the commands, Ctrl+C twice exits', () => {
    const frame = frameOf('', true);
    expect(frame).toContain('No provider key yet · Enter connect · /providers');
    expect(frame).toContain('Enter connect a provider · [/] commands · [Ctrl+C] exit (twice)');
  });

  it('keyless with a draft: Enter connects a provider and says the message is kept', () => {
    const frame = frameOf('hello', true);
    expect(frame).toContain('Enter connect a provider · your message is kept');
    expect(frame, 'the keyed draft hint would promise a chat that cannot start').not.toContain(
      'Enter start the chat',
    );
  });

  it('with a key the hints are the ones they were', () => {
    expect(frameOf('hello', false)).toContain(
      'Enter start the chat · [Ctrl+J] newline · [Ctrl+C] exit (twice)',
    );
    expect(frameOf('', false)).toContain(
      '[/] for commands · type a message to start a chat · [Ctrl+C] exit (twice)',
    );
  });
});

/**
 * `Ctrl+C` at the first-run card (MVP-11 Step 2.4, D): ADR-0115 §1 says a confirmation card or a non-approval overlay CLOSES on `Ctrl+C` and
 * does not arm the exit, never confirming. The first-run card is such a card, so `Ctrl+C` skips it exactly as `Esc` does. (The sandboxed
 * observation of MVP-11 step 1 saw it ignored in tmux; in-process through the real `RootApp` it closes, and this pins that it keeps doing so.)
 */
describe.each([
  ['Ctrl+C', '\x03'],
  ['Esc', '\x1b'],
] as const)('%s at a first-run style select card', (_name, bytes) => {
  it('closes the card, the way the keymap says, and arms no exit', async () => {
    const channel = createNativePromptChannel();
    const onExit = vi.fn();
    const controller = createHomeController({
      homeStore: { read: () => EMPTY },
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: () => Promise.reject(new Error('unexpected chat')),
      onExit,
      onError: vi.fn(),
    });
    const h = render(
      <RootApp
        controller={controller}
        nativePrompt={channel.ui}
        nowMs={() => 0}
        color={false}
        getSize={() => ({ cols: 80, rows: 24 })}
        subscribeResize={() => () => {}}
      />,
    );
    channel.flow.begin();
    const answer = channel.flow.select({
      message: 'Which provider?',
      options: [{ value: 'anthropic', label: 'Anthropic' }],
    });
    await waitFor(() => (h.lastFrame() ?? '').includes('Which provider?'));
    await settleFrames();
    h.stdin.write(bytes);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
    await channel.flow.end();
    await settleFrames();
    expect(
      controller.getSnapshot().interruptArmed,
      'a card that closes does not arm the exit',
    ).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
    channel.ui.dispose();
  });
});
