/**
 * The Home's question for a media park, as it is DRAWN
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, the 2026-11-23 amendment notes): the whole
 * sentence, including what a Yes costs, has to be on screen at 80×24 before the person answers, with the two answers beside it and no row
 * wider than the terminal. The words are `media-continue.test.ts`'s; this file proves they are not cut off by the prompt's own layout.
 */
import type { Key } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitFor } from '../render/tui/harness-util.js';
import { RootApp } from '../render/tui/home-app.js';
import { createHomeController } from '../render/tui/home-controller.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { mediaContinueQuestion, runMediaContinue } from './media-continue.js';

afterEach(cleanup);

const RUN = '0b8f3a52-9d41-4c6e-8a07-5e2d1c9b7f64';
const ESC: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: true,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

describe('the question at 80×24', () => {
  it('draws the whole sentence and both answers, and no row is wider than the terminal', async () => {
    const channel = createNativePromptChannel();
    const controller = createHomeController({
      startChat: () => {
        throw new Error('unexpected chat');
      },
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
      onExit: vi.fn(),
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
    const resume = vi.fn<() => Promise<never>>();
    const answer = runMediaContinue({ host: { resume }, flow: channel.flow }, RUN);
    await waitFor(() => (h.lastFrame() ?? '').includes('leaving the Home cancels it.'));

    const frame = h.lastFrame() ?? '';
    const lines = frame.split('\n');
    // The question wraps; read it back as the person reads it.
    const read = frame.replace(/\s+/gu, ' ');
    expect(read).toContain(mediaContinueQuestion(RUN));
    // The words themselves, not only the function that builds them: what a Yes costs is on screen before the answer.
    expect(read).toContain(
      'Continue it here? It runs in this Home until the jobs finish, and leaving the Home cancels it.',
    );
    expect(frame).toContain('Yes');
    expect(frame).toContain('No');
    expect(lines.length, 'the Home fits 24 rows').toBeLessThanOrEqual(24);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);

    channel.ui.input('', ESC);
    expect(await answer).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
    channel.ui.dispose();
  });
});
